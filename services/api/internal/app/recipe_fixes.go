package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Recipe fixes from cooks (docs/RECIPE-FIXES.md). A member who cooked a recipe through in cooking
// mode (a verified cook) can suggest a change to one part of it: a step's time, heat or a note on
// it, a step that's missing, an amount, or a swap that worked. Other verified cooks can say "same
// for me", and the recipe's author accepts (as it is, or edited), or declines with a reason.
// Accepting saves the recipe as the editor does, which re-reads its allergens and equipment, and
// keeps a version the author can undo while nothing else changed since. Accepted fixes credit
// their cooks on the recipe ("Improved by 3 cooks") and in its history.

// fixKinds is each kind of fix and the part of a recipe it changes.
var fixKinds = map[string]string{"time": "step", "heat": "step", "note": "step", "missing_step": "new_step", "amount": "ingredient", "swap": "ingredient"}

func (a *App) recipeFixRoutes(v fiber.Router) {
	v.Get("/recipes/:id/suggestions", a.recipeSuggestions)
	v.Post("/recipes/:id/suggestions", a.requireAuth, perUser(20, time.Hour), a.suggestFix)
	v.Get("/recipes/:id/history", a.recipeHistory)
	v.Post("/recipes/:id/history/:version/undo", a.requireAuth, a.undoFix)
	v.Patch("/suggestions/:id", a.requireAuth, a.answerSuggestion)
	v.Delete("/suggestions/:id", a.requireAuth, a.withdrawSuggestion)
	v.Put("/suggestions/:id/vote", a.requireAuth, perUser(120, time.Hour), a.voteSuggestion)
	v.Delete("/suggestions/:id/vote", a.requireAuth, a.unvoteSuggestion)
}

// fixPart is a part of a recipe as a suggestion shows it: a step's title, text and timer, or an
// ingredient's name, amount and unit.
type fixPart struct {
	Title   string   `json:"title,omitempty"`
	Text    string   `json:"text,omitempty"`
	Seconds *int     `json:"seconds,omitempty"`
	Name    string   `json:"name,omitempty"`
	Amount  *float64 `json:"amount,omitempty"`
	Unit    *string  `json:"unit,omitempty"`
}

// ingredientKey names an ingredient by its name, as a suggestion's target.
func ingredientKey(name string) string {
	return strings.ToLower(strings.Join(strings.Fields(name), " "))
}

func stepPart(s Step) fixPart {
	seconds := s.Seconds
	return fixPart{Title: s.Title, Text: s.Text, Seconds: &seconds}
}

func ingredientPart(i Ingredient) fixPart {
	amount, unit := i.Amount, i.Unit
	return fixPart{Name: i.Name, Amount: &amount, Unit: &unit}
}

// fixTarget names the part of recipe r a suggestion of kind changes, at 1-based place (a
// missing step: the step it follows, 0 for the start): its target, and the part as it is now
// (nothing for a missing step). ok is false when there's no such part.
func fixTarget(r RecipeInput, part string, place int) (target string, before fixPart, ok bool) {
	switch part {
	case "step":
		if place < 1 || place > len(r.Steps) {
			return "", before, false
		}
		return cookStepKey(r.Steps[place-1].Text), stepPart(r.Steps[place-1]), true
	case "new_step":
		if place < 0 || place > len(r.Steps) {
			return "", before, false
		}
		if place == 0 {
			return "start", before, true
		}
		return cookStepKey(r.Steps[place-1].Text), before, true
	case "ingredient":
		if place < 1 || place > len(r.Ingredients) {
			return "", before, false
		}
		return ingredientKey(r.Ingredients[place-1].Name), ingredientPart(r.Ingredients[place-1]), true
	}
	return "", before, false
}

// findTarget is where target is in r now, the way fixTarget names it, preferring place when it
// still matches: a step or ingredient's 1-based place, or the place a missing step goes after.
func findTarget(r RecipeInput, part, target string, place int) (int, bool) {
	matches := func(i int) bool {
		switch part {
		case "ingredient":
			return ingredientKey(r.Ingredients[i-1].Name) == target
		default:
			return cookStepKey(r.Steps[i-1].Text) == target
		}
	}
	if part == "new_step" && target == "start" {
		return 0, true
	}
	n := len(r.Steps)
	if part == "ingredient" {
		n = len(r.Ingredients)
	}
	if place >= 1 && place <= n && matches(place) {
		return place, true
	}
	for i := 1; i <= n; i++ {
		if matches(i) {
			return i, true
		}
	}
	return 0, false
}

// applyFix changes r's part at place (as findTarget gives it) to after, keeping a step's photo
// and clip. A missing step goes after place.
func applyFix(r *RecipeInput, part string, place int, after fixPart) {
	switch part {
	case "step":
		s := &r.Steps[place-1]
		s.Title, s.Text = after.Title, after.Text
		if after.Seconds != nil {
			s.Seconds = *after.Seconds
		}
	case "new_step":
		step := Step{Title: after.Title, Text: after.Text}
		if after.Seconds != nil {
			step.Seconds = *after.Seconds
		}
		r.Steps = append(r.Steps[:place], append([]Step{step}, r.Steps[place:]...)...)
	case "ingredient":
		i := &r.Ingredients[place-1]
		i.Name = after.Name
		if after.Amount != nil {
			i.Amount = *after.Amount
		}
		if after.Unit != nil {
			i.Unit = *after.Unit
		}
	}
}

// fixAfter is the part as a change would have it: what the change sends over the part as it is
// (a missing step starts empty), trimmed. A time is given in whole seconds and kept to a day.
func fixAfter(before fixPart, change fixPart) fixPart {
	after := before
	if t := strings.TrimSpace(change.Title); t != "" {
		after.Title = t
	}
	if t := strings.TrimSpace(change.Text); t != "" {
		after.Text = t
	}
	if change.Seconds != nil {
		seconds := min(max(*change.Seconds, 0), 86400)
		after.Seconds = &seconds
	}
	if t := strings.TrimSpace(change.Name); t != "" {
		after.Name = t
	}
	if change.Amount != nil {
		amount := math.Round(*change.Amount*1000) / 1000
		after.Amount = &amount
	}
	if change.Unit != nil {
		unit := strings.TrimSpace(*change.Unit)
		after.Unit = &unit
	}
	return after
}

// recipeForFix is the recipe as its editor would save it, read with q (in a transaction, locked
// when lock): ok is false when it isn't a published recipe by an author in good standing.
func recipeForFix(ctx context.Context, q querier, id string, lock bool) (r RecipeInput, author string, ok bool, e error) {
	var b []byte
	query := `SELECT ` + recipeJSON + `,r.author_id` + recipeFrom + `WHERE r.id=$1 AND r.published`
	if lock {
		query += ` FOR UPDATE OF r`
	}
	e = q.QueryRow(ctx, query, id).Scan(&b, &author)
	if errors.Is(e, pgx.ErrNoRows) {
		return r, "", false, nil
	}
	if e == nil {
		e = json.Unmarshal(b, &r)
	}
	return r, author, e == nil, e
}

// verifiedCookSQL is whether member $2 cooked recipe $1 through in cooking mode.
const verifiedCookSQL = `EXISTS(SELECT 1 FROM cook_sessions WHERE recipe_id=$1 AND user_id=$2 AND verified)`

// preparedFix is a suggestion checked and ready to keep: the part it changes and its target,
// where that part is, and the part as it is and as the cook would have it.
type preparedFix struct {
	kind, part, target string
	place              int
	before, after      fixPart
}

// prepareFix checks what member me suggests for someone else's published recipe: kind is time,
// heat or note (step's title, text and seconds), missing_step (a new step after step, 0 for the
// start), amount or swap (ingredient's name, amount and unit). It must come from a verified cook
// of the recipe, change something, and leave a recipe the editor would save.
func prepareFix(ctx context.Context, q querier, recipe, me, kind string, step, ingredient int, change fixPart) (preparedFix, error) {
	f := preparedFix{kind: kind}
	if _, known := fixKinds[kind]; !known {
		return f, fiber.NewError(400, "Choose what kind of change this is.")
	}
	r, author, ok, e := recipeForFix(ctx, q, recipe, false)
	if e != nil {
		return f, e
	}
	if !ok {
		return f, fiber.NewError(404, "Recipe not found.")
	}
	if author == me {
		return f, fiber.NewError(403, "This is your recipe: change it in the editor.")
	}
	var cooked bool
	if e = q.QueryRow(ctx, `SELECT `+verifiedCookSQL, recipe, me).Scan(&cooked); e != nil {
		return f, e
	}
	if !cooked {
		return f, fiber.NewError(403, "Cook this recipe through in cooking mode first, then suggest a change.")
	}
	return partChange(r, kind, step, ingredient, change)
}

// partChange is changing kind at step or ingredient of r (a missing step goes after step): the
// part, its target and place, and the part as it is and would be. It must change something and
// leave a recipe the editor would save.
func partChange(r RecipeInput, kind string, step, ingredient int, change fixPart) (preparedFix, error) {
	f := preparedFix{kind: kind, part: fixKinds[kind], place: step}
	if f.part == "ingredient" {
		f.place = ingredient
	}
	var ok bool
	f.target, f.before, ok = fixTarget(r, f.part, f.place)
	if !ok {
		return f, fiber.NewError(400, "Choose a step or ingredient the recipe has.")
	}
	f.after = fixAfter(f.before, change)
	if f.part == "new_step" && f.after.Title == "" {
		f.after.Title = f.after.Text
		if t := []rune(f.after.Title); len(t) > 60 {
			f.after.Title = strings.TrimSpace(string(t[:60]))
		}
	}
	if string(jsonBytes(f.after)) == string(jsonBytes(f.before)) {
		return f, fiber.NewError(400, "Change something first.")
	}
	next := r
	next.Steps, next.Ingredients = append([]Step(nil), r.Steps...), append([]Ingredient(nil), r.Ingredients...)
	applyFix(&next, f.part, f.place, f.after)
	return f, next.Validate()
}

// suggestFix keeps a verified cook's suggestion for one part of someone else's published recipe
// (prepareFix): {"kind", "step" | "ingredient", "change": {...}, "reason"}. One waits per cook
// and part.
func (a *App) suggestFix(c fiber.Ctx) error {
	var in struct {
		Kind       string  `json:"kind"`
		Step       int     `json:"step"`
		Ingredient int     `json:"ingredient"`
		Change     fixPart `json:"change"`
		Reason     string  `json:"reason"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	reason := strings.Join(strings.Fields(in.Reason), " ")
	if len([]rune(reason)) > 500 {
		return fiber.NewError(400, "Say what happened in up to 500 characters.")
	}
	ctx, me, recipe := c.Context(), userID(c), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	f, e := prepareFix(ctx, tx, recipe, me, in.Kind, in.Step, in.Ingredient, in.Change)
	if e != nil {
		return e
	}
	id := uuid.NewString()
	_, e = tx.Exec(ctx, `INSERT INTO recipe_suggestions(id,recipe_id,user_id,kind,part,target,place,before,after,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		id, recipe, me, f.kind, f.part, f.target, f.place, jsonBytes(f.before), jsonBytes(f.after), reason)
	if pgCode(e) == "23505" {
		return fiber.NewError(409, "You already suggested a change here. Withdraw it to suggest another.")
	}
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	list, e := a.loadSuggestions(ctx, recipe, me, id)
	if e != nil {
		return e
	}
	if len(list) == 0 {
		return fiber.NewError(404, "Recipe not found.")
	}
	return c.Status(201).JSON(list[0])
}

// suggestion is one suggestion as the recipe shows it. place is where its part is in the recipe
// now (fits), or was when it was made; votes are the other cooks who said "same for me".
type suggestion struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Part      string    `json:"part"`
	Place     int       `json:"place"`
	Before    fixPart   `json:"before"`
	After     fixPart   `json:"after"`
	Reason    string    `json:"reason"`
	Status    string    `json:"status"`
	Fits      bool      `json:"fits"`
	Votes     int       `json:"votes"`
	Voted     bool      `json:"voted"`
	Mine      bool      `json:"mine"`
	CreatedAt time.Time `json:"createdAt"`
	Author    creator   `json:"author"`
}

// creator is a member as a byline shows them.
type creator struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Handle string `json:"handle"`
	Avatar string `json:"avatar"`
}

// loadSuggestions reads a published recipe's waiting suggestions (open and stale) by cooks in
// good standing, the most agreed first, as viewer sees them; only, one id.
func (a *App) loadSuggestions(ctx context.Context, recipe, viewer, only string) ([]suggestion, error) {
	var b []byte
	e := a.DB.QueryRow(ctx, `SELECT `+recipeJSON+recipeFrom+`WHERE r.id=$1 AND r.published`, recipe).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var r RecipeInput
	if e = json.Unmarshal(b, &r); e != nil {
		return nil, e
	}
	rows, e := a.DB.Query(ctx, `SELECT s.id,s.kind,s.part,s.target,s.place,s.before,s.after,s.reason,s.status,s.created_at,s.user_id=$2,
 (SELECT count(*) FROM recipe_suggestion_votes v JOIN users vu ON vu.id=v.user_id AND vu.suspended_at IS NULL WHERE v.suggestion_id=s.id)::int,
 EXISTS(SELECT 1 FROM recipe_suggestion_votes v WHERE v.suggestion_id=s.id AND v.user_id=$2),u.id,u.name,u.handle,u.avatar
 FROM recipe_suggestions s JOIN users u ON u.id=s.user_id AND u.suspended_at IS NULL
 WHERE s.recipe_id=$1 AND s.status IN ('open','stale') AND ($3='' OR s.id=$3)
 ORDER BY s.status='stale',4 DESC,s.created_at DESC,s.id LIMIT 100`, recipe, viewer, only)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []suggestion{}
	for rows.Next() {
		var s suggestion
		var target string
		var before, after []byte
		if e = rows.Scan(&s.ID, &s.Kind, &s.Part, &target, &s.Place, &before, &after, &s.Reason, &s.Status, &s.CreatedAt, &s.Mine, &s.Votes, &s.Voted,
			&s.Author.ID, &s.Author.Name, &s.Author.Handle, &s.Author.Avatar); e != nil {
			return nil, e
		}
		_ = json.Unmarshal(before, &s.Before)
		_ = json.Unmarshal(after, &s.After)
		if place, ok := findTarget(r, s.Part, target, s.Place); ok {
			s.Place, s.Fits = place, true
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// recipeSuggestions answers a published recipe's waiting suggestions, and whether the viewer may
// suggest one and say "same for me" (a verified cook who isn't its author).
func (a *App) recipeSuggestions(c fiber.Ctx) error {
	viewer, e := a.sessionUser(c)
	if e != nil {
		return e
	}
	list, e := a.loadSuggestions(c.Context(), c.Params("id"), viewer, "")
	if e != nil {
		return e
	}
	if list == nil {
		return fiber.NewError(404, "Recipe not found.")
	}
	var can bool
	if viewer != "" {
		if e = a.DB.QueryRow(c.Context(), `SELECT `+verifiedCookSQL+` AND NOT EXISTS(SELECT 1 FROM recipes WHERE id=$1 AND author_id=$2)`, c.Params("id"), viewer).Scan(&can); e != nil {
			return e
		}
	}
	return c.JSON(fiber.Map{"canSuggest": can, "suggestions": list})
}

// voteSuggestion is "same for me" from another verified cook of the recipe; unvoteSuggestion
// takes it back. Both answer the suggestion.
func (a *App) voteSuggestion(c fiber.Ctx) error {
	ctx, me := c.Context(), userID(c)
	var recipe, by string
	e := a.DB.QueryRow(ctx, `SELECT s.recipe_id,s.user_id FROM recipe_suggestions s JOIN recipes r ON r.id=s.recipe_id AND r.published WHERE s.id=$1 AND s.status IN ('open','stale')`, c.Params("id")).Scan(&recipe, &by)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Suggestion not found.")
	}
	if e != nil {
		return e
	}
	if by == me {
		return fiber.NewError(400, "This is your own suggestion.")
	}
	var cooked bool
	if e = a.DB.QueryRow(ctx, `SELECT `+verifiedCookSQL+` AND NOT EXISTS(SELECT 1 FROM recipes WHERE id=$1 AND author_id=$2)`, recipe, me).Scan(&cooked); e != nil {
		return e
	}
	if !cooked {
		return fiber.NewError(403, "Cook this recipe through in cooking mode first, then say whether it was the same for you.")
	}
	if _, e = a.DB.Exec(ctx, `INSERT INTO recipe_suggestion_votes(suggestion_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, c.Params("id"), me); e != nil {
		return e
	}
	return a.oneSuggestion(c, recipe)
}

func (a *App) unvoteSuggestion(c fiber.Ctx) error {
	var recipe string
	e := a.DB.QueryRow(c.Context(), `WITH gone AS (DELETE FROM recipe_suggestion_votes WHERE suggestion_id=$1 AND user_id=$2)
 SELECT recipe_id FROM recipe_suggestions WHERE id=$1`, c.Params("id"), userID(c)).Scan(&recipe)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Suggestion not found.")
	}
	if e != nil {
		return e
	}
	return a.oneSuggestion(c, recipe)
}

func (a *App) oneSuggestion(c fiber.Ctx, recipe string) error {
	list, e := a.loadSuggestions(c.Context(), recipe, userID(c), c.Params("id"))
	if e != nil {
		return e
	}
	if len(list) == 0 {
		return fiber.NewError(404, "Suggestion not found.")
	}
	return c.JSON(list[0])
}

// withdrawSuggestion lets a cook take back a suggestion still waiting.
func (a *App) withdrawSuggestion(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `UPDATE recipe_suggestions SET status='withdrawn',decided_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('open','stale')`, c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Suggestion not found.")
	}
	return c.SendStatus(204)
}

// answerSuggestion is the recipe author's answer: {"action": "accept"}, with "change" when they
// edited the suggestion first, or {"action": "decline", "response"}. Accepting saves the recipe
// and answers its version; declining answers 204.
func (a *App) answerSuggestion(c fiber.Ctx) error {
	var in struct {
		Action   string   `json:"action"`
		Change   *fixPart `json:"change"`
		Response string   `json:"response"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Action != "accept" && in.Action != "decline" {
		return fiber.NewError(400, "Accept or decline the suggestion.")
	}
	response := strings.Join(strings.Fields(in.Response), " ")
	if len([]rune(response)) > 500 {
		return fiber.NewError(400, "Say why in up to 500 characters.")
	}
	ctx, me := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var recipe, part, target string
	var place int
	var raw []byte
	e = tx.QueryRow(ctx, `SELECT s.recipe_id,s.part,s.target,s.place,s.after FROM recipe_suggestions s JOIN recipes r ON r.id=s.recipe_id
 WHERE s.id=$1 AND r.author_id=$2 AND s.status IN ('open','stale') FOR UPDATE OF s`, c.Params("id"), me).Scan(&recipe, &part, &target, &place, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Suggestion not found.")
	}
	if e != nil {
		return e
	}
	if in.Action == "decline" {
		if _, e = tx.Exec(ctx, `UPDATE recipe_suggestions SET status='declined',response=$2,decided_at=now() WHERE id=$1`, c.Params("id"), response); e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		return c.SendStatus(204)
	}
	r, _, ok, e := recipeForFix(ctx, tx, recipe, true)
	if e != nil {
		return e
	}
	if !ok {
		return fiber.NewError(409, "Publish the recipe again to accept suggestions to it.")
	}
	at, ok := findTarget(r, part, target, place)
	if !ok {
		return fiber.NewError(409, "That part of the recipe has changed since, so this suggestion no longer fits.")
	}
	var after fixPart
	if e = json.Unmarshal(raw, &after); e != nil {
		return e
	}
	if in.Change != nil {
		after = fixAfter(after, *in.Change)
	}
	applyFix(&r, part, at, after)
	if e = r.Validate(); e != nil {
		return e
	}
	version, e := saveFix(ctx, tx, me, recipe, r, c.Params("id"))
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE recipe_suggestions SET status='accepted',after=$2,decided_at=now() WHERE id=$1`, c.Params("id"), jsonBytes(after)); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return a.oneVersion(c, recipe, version)
}

// fixContentSQL is what a version keeps of recipe $1: its ingredients and steps.
const fixContentSQL = `SELECT jsonb_build_object('ingredients',ingredients,'steps',steps) FROM recipes WHERE id=$1`

// saveFixed saves owner's recipe as a fix or its undo left it, in tx. Every step carries its own
// photo and clip, so none is matched to another step's (keepStepMedia), even after a new one.
func saveFixed(ctx context.Context, tx pgx.Tx, owner, recipe string, r RecipeInput) error {
	for i := range r.Steps {
		r.Steps[i].imageSet, r.Steps[i].videoSet = true, true
	}
	return saveOwnRecipe(ctx, tx, owner, recipe, r)
}

// saveFix saves owner's recipe as suggestion changed it, in tx, and keeps what the recipe was
// and became as its next version, which it answers.
func saveFix(ctx context.Context, tx pgx.Tx, owner, recipe string, r RecipeInput, suggestion string) (string, error) {
	var before, after []byte
	if e := tx.QueryRow(ctx, fixContentSQL, recipe).Scan(&before); e != nil {
		return "", e
	}
	if e := saveFixed(ctx, tx, owner, recipe, r); e != nil {
		return "", e
	}
	if e := tx.QueryRow(ctx, fixContentSQL, recipe).Scan(&after); e != nil {
		return "", e
	}
	id := uuid.NewString()
	_, e := tx.Exec(ctx, `INSERT INTO recipe_versions(id,recipe_id,number,suggestion_id,before,after)
 SELECT $1,$2,COALESCE(max(number),0)+1,$3,$4,$5 FROM recipe_versions WHERE recipe_id=$2`, id, recipe, suggestion, before, after)
	return id, e
}

// undoFix takes back an accepted fix: the recipe gets back its ingredients and steps from before
// it, as long as nothing changed them since. The suggestion is then undone.
func (a *App) undoFix(c fiber.Ctx) error {
	ctx, me, recipe := c.Context(), userID(c), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var b, before []byte
	var current bool
	var suggestion *string
	e = tx.QueryRow(ctx, `SELECT `+recipeJSON+`,v.before,v.after=jsonb_build_object('ingredients',r.ingredients,'steps',r.steps),v.suggestion_id
 FROM recipes r JOIN users u ON u.id=r.author_id JOIN recipe_versions v ON v.recipe_id=r.id
 WHERE r.id=$1 AND r.author_id=$2 AND v.id=$3 AND v.undone_at IS NULL FOR UPDATE OF r,v`, recipe, me, c.Params("version")).Scan(&b, &before, &current, &suggestion)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "This change could not be found.")
	}
	if e != nil {
		return e
	}
	if !current {
		return fiber.NewError(409, "The recipe has changed since, so this can't be undone. Edit it instead.")
	}
	var r RecipeInput
	var was struct {
		Ingredients []Ingredient `json:"ingredients"`
		Steps       []Step       `json:"steps"`
	}
	if e = errors.Join(json.Unmarshal(b, &r), json.Unmarshal(before, &was)); e != nil {
		return e
	}
	r.Ingredients, r.Steps = was.Ingredients, was.Steps
	if e = r.Validate(); e != nil {
		return e
	}
	if e = saveFixed(ctx, tx, me, recipe, r); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE recipe_versions SET undone_at=now() WHERE id=$1`, c.Params("version")); e != nil {
		return e
	}
	if suggestion != nil {
		if _, e = tx.Exec(ctx, `UPDATE recipe_suggestions SET status='undone',decided_at=now() WHERE id=$1`, *suggestion); e != nil {
			return e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// fixVersion is one accepted fix in a recipe's history: what it changed, whose it was, and
// whether its author can still undo it.
type fixVersion struct {
	ID         string    `json:"id"`
	Number     int       `json:"number"`
	Kind       string    `json:"kind"`
	Part       string    `json:"part"`
	Before     fixPart   `json:"before"`
	After      fixPart   `json:"after"`
	CreatedAt  time.Time `json:"createdAt"`
	By         *creator  `json:"by"`
	Undoable   bool      `json:"undoable"`
	Suggestion string    `json:"suggestionId"`
}

const versionSQL = `SELECT v.id,v.number,COALESCE(s.kind,''),COALESCE(s.part,''),COALESCE(s.before,'{}'),COALESCE(s.after,'{}'),v.created_at,
 u.id,u.name,u.handle,u.avatar,r.author_id=$2 AND v.after=jsonb_build_object('ingredients',r.ingredients,'steps',r.steps),COALESCE(s.id,'')
 FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id LEFT JOIN recipe_suggestions s ON s.id=v.suggestion_id
 LEFT JOIN users u ON u.id=s.user_id AND u.suspended_at IS NULL
 WHERE v.recipe_id=$1 AND v.undone_at IS NULL`

func scanVersions(rows pgx.Rows) ([]fixVersion, error) {
	defer rows.Close()
	out := []fixVersion{}
	for rows.Next() {
		var v fixVersion
		var before, after []byte
		var id, name, handle, avatar *string
		if e := rows.Scan(&v.ID, &v.Number, &v.Kind, &v.Part, &before, &after, &v.CreatedAt, &id, &name, &handle, &avatar, &v.Undoable, &v.Suggestion); e != nil {
			return nil, e
		}
		_ = json.Unmarshal(before, &v.Before)
		_ = json.Unmarshal(after, &v.After)
		if id != nil {
			v.By = &creator{ID: *id, Name: *name, Handle: *handle, Avatar: *avatar}
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// recipeHistory answers a published recipe's accepted fixes, newest first, and the cooks they
// came from (improvedBy, as the recipe counts them). Its author also learns which they can undo.
func (a *App) recipeHistory(c fiber.Ctx) error {
	viewer, e := a.sessionUser(c)
	if e != nil {
		return e
	}
	var visible bool
	if e = a.DB.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1`+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=$2))`, c.Params("id"), viewer).Scan(&visible); e != nil {
		return e
	}
	if !visible {
		return fiber.NewError(404, "Recipe not found.")
	}
	rows, e := a.DB.Query(c.Context(), versionSQL+` ORDER BY v.number DESC LIMIT 100`, c.Params("id"), viewer)
	if e != nil {
		return e
	}
	list, e := scanVersions(rows)
	if e != nil {
		return e
	}
	return c.JSON(fiber.Map{"versions": list})
}

func (a *App) oneVersion(c fiber.Ctx, recipe, version string) error {
	rows, e := a.DB.Query(c.Context(), versionSQL+` AND v.id=$3`, recipe, userID(c), version)
	if e != nil {
		return e
	}
	list, e := scanVersions(rows)
	if e != nil {
		return e
	}
	if len(list) == 0 {
		return fiber.NewError(404, "This change could not be found.")
	}
	return c.JSON(list[0])
}

// suggestionSummary is a suggestion in a sentence, for the sous-chef's confirmations.
func suggestionSummary(kind string, place int, before, after fixPart) string {
	switch fixKinds[kind] {
	case "new_step":
		if place == 0 {
			return fmt.Sprintf("add a first step “%s”", clip(after.Text, 200))
		}
		return fmt.Sprintf("add a step after step %d: “%s”", place, clip(after.Text, 200))
	case "ingredient":
		amount := func(p fixPart) string {
			if p.Amount == nil || *p.Amount == 0 {
				return p.Name
			}
			return strings.TrimSpace(fmt.Sprintf("%g %s %s", *p.Amount, deref(p.Unit), p.Name))
		}
		return fmt.Sprintf("change “%s” to “%s”", amount(before), amount(after))
	}
	line := fmt.Sprintf("change step %d to “%s”", place, clip(after.Text, 200))
	if after.Seconds != nil && before.Seconds != nil && *after.Seconds != *before.Seconds {
		line += fmt.Sprintf(" with a %s timer", duration(*after.Seconds))
	}
	return line
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// adminDeleteSuggestion removes a suggestion, under the same rank rule as comments.
func (a *App) adminDeleteSuggestion(c fiber.Ctx) error {
	ctx, id := c.Context(), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var after []byte
	var title, recipe string
	var by maker
	e = tx.QueryRow(ctx, `SELECT s.after,r.title,r.id,`+makerSQL+`
 FROM recipe_suggestions s JOIN users u ON u.id=s.user_id JOIN recipes r ON r.id=s.recipe_id WHERE s.id=$1 FOR UPDATE OF s`,
		id, ownerEmails()).Scan(append([]any{&after, &title, &recipe}, by.fields()...)...)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Suggestion not found.")
	}
	if e != nil {
		return e
	}
	if e = mayModerate(c, by, true); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM recipe_suggestions WHERE id=$1`, id); e != nil {
		return e
	}
	if e = audit(ctx, tx, c, "suggestion.delete", "suggestion", id, fmt.Sprintf("Deleted %s's suggestion on “%s”", by.Email, title), fiber.Map{"after": json.RawMessage(after), "recipeId": recipe}); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}
