package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Your version of a recipe (docs/YOUR-VERSION.md). What a member changed in someone else's recipe
// when they cooked it ("I used half the chilli", "my oven needs 10 minutes more") is kept as one
// change per part of the recipe, named as fixes name parts (recipe_fixes.go), and the app opens
// the recipe their way next time. The recipe is never copied: changes apply over it as it is, so
// its author's fixes still arrive, and a change whose part changed since is the member's to keep
// or drop. Kitchen notes ("my oven runs hot") apply to every recipe. The sous-chef and hands-free
// answers hear both. Nobody else sees any of it.

const (
	// The most changes a member keeps for one recipe, and kitchen notes in all.
	maxRecipeEdits, maxKitchenNotes = 40, 30
)

// editKinds are the kinds of change a member keeps for themselves: everything a fix can be but a
// new step, so their version has the recipe's steps, one for one, and cooking mode's step events
// and the sous-chef's step numbers mean the same step in both.
var editKinds = map[string]bool{"time": true, "heat": true, "note": true, "amount": true, "swap": true}

func (a *App) yourVersionRoutes(v fiber.Router) {
	v.Get("/recipes/:id/my-version", a.requireAuth, a.myVersion)
	v.Put("/recipes/:id/my-version", a.requireAuth, perUser(120, time.Hour), a.keepEdit)
	v.Patch("/recipe-edits/:id", a.requireAuth, a.keepEditHere)
	v.Delete("/recipe-edits/:id", a.requireAuth, a.dropEdit)
	v.Get("/me/kitchen-notes", a.requireAuth, a.kitchenNotes)
	v.Post("/me/kitchen-notes", a.requireAuth, perUser(60, time.Hour), a.addKitchenNote)
	v.Delete("/me/kitchen-notes/:id", a.requireAuth, a.dropKitchenNote)
}

// recipeEdit is one change as the member's version shows it: place is where its part is in the
// recipe now (when it fits) or was.
type recipeEdit struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Part      string    `json:"part"`
	Place     int       `json:"place"`
	Before    fixPart   `json:"before"`
	After     fixPart   `json:"after"`
	Said      string    `json:"said"`
	Source    string    `json:"source"`
	Fits      bool      `json:"fits"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// visibleRecipe is a recipe the member may cook that isn't theirs: published, by an author in
// good standing. ok is false otherwise.
func visibleRecipe(ctx context.Context, q querier, id, member string) (r RecipeInput, ok bool, e error) {
	var author string
	r, author, ok, e = recipeForFix(ctx, q, id, false)
	return r, ok && author != member, e
}

// loadEdits reads member's changes to recipe r, in the recipe's order, the part's place now
// worked out for each (only, one id).
func loadEdits(ctx context.Context, db engagementDB, member, recipe string, r RecipeInput, only string) ([]recipeEdit, error) {
	rows, e := db.Query(ctx, `SELECT id,kind,part,target,place,before,after,said,source,updated_at FROM recipe_edits
 WHERE user_id=$1 AND recipe_id=$2 AND ($3='' OR id=$3) ORDER BY part DESC,place,id`, member, recipe, only)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []recipeEdit{}
	for rows.Next() {
		var x recipeEdit
		var target string
		var before, after []byte
		if e = rows.Scan(&x.ID, &x.Kind, &x.Part, &target, &x.Place, &before, &after, &x.Said, &x.Source, &x.UpdatedAt); e != nil {
			return nil, e
		}
		_ = json.Unmarshal(before, &x.Before)
		_ = json.Unmarshal(after, &x.After)
		if place, ok := findTarget(r, x.Part, target, x.Place); ok {
			x.Place, x.Fits = place, true
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// myVersion answers the member's changes to someone else's published recipe: {"edits"}.
func (a *App) myVersion(c fiber.Ctx) error {
	r, ok, e := visibleRecipe(c.Context(), a.DB, c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if !ok {
		return fiber.NewError(404, "Recipe not found.")
	}
	edits, e := loadEdits(c.Context(), a.DB, userID(c), c.Params("id"), r, "")
	if e != nil {
		return e
	}
	return c.JSON(fiber.Map{"edits": edits})
}

// keepEdit keeps a change to one part of someone else's published recipe in the member's version:
// {"kind", "step" | "ingredient", "change", "said", "source"}, as a fix is suggested (time, heat
// or note change a step; amount or swap an ingredient). A change to a part already changed
// replaces it. It answers the change, and the one it replaced as "replaced" (null for none).
func (a *App) keepEdit(c fiber.Ctx) error {
	var in struct {
		Kind       string  `json:"kind"`
		Step       int     `json:"step"`
		Ingredient int     `json:"ingredient"`
		Change     fixPart `json:"change"`
		Said       string  `json:"said"`
		Source     string  `json:"source"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if !editKinds[in.Kind] {
		return fiber.NewError(400, "Choose what kind of change this is.")
	}
	said := strings.Join(strings.Fields(in.Said), " ")
	if len([]rune(said)) > 500 {
		return fiber.NewError(400, "Say what you changed in up to 500 characters.")
	}
	if in.Source == "" {
		in.Source = "typed"
	}
	if in.Source != "typed" && in.Source != "cooking" && in.Source != "sous_chef" {
		return fiber.NewError(400, "Unknown source.")
	}
	ctx, me, recipe := c.Context(), userID(c), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// One writer at a time per member, so the count below holds.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('edits:'||$1,0))`, me); e != nil {
		return e
	}
	r, ok, e := visibleRecipe(ctx, tx, recipe, me)
	if e != nil {
		return e
	}
	if !ok {
		return fiber.NewError(404, "Recipe not found.")
	}
	f, e := partChange(r, in.Kind, in.Step, in.Ingredient, in.Change)
	if e != nil {
		return e
	}
	var replaced *recipeEdit
	var was recipeEdit
	var before, after []byte
	e = tx.QueryRow(ctx, `SELECT id,kind,part,place,before,after,said,source,updated_at FROM recipe_edits WHERE user_id=$1 AND recipe_id=$2 AND part=$3 AND target=$4`, me, recipe, f.part, f.target).
		Scan(&was.ID, &was.Kind, &was.Part, &was.Place, &before, &after, &was.Said, &was.Source, &was.UpdatedAt)
	switch {
	case e == nil:
		_ = json.Unmarshal(before, &was.Before)
		_ = json.Unmarshal(after, &was.After)
		was.Fits, replaced = true, &was
	case errors.Is(e, pgx.ErrNoRows):
		var n int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM recipe_edits WHERE user_id=$1 AND recipe_id=$2`, me, recipe).Scan(&n); e != nil {
			return e
		}
		if n >= maxRecipeEdits {
			return fiber.NewError(409, "Your version of this recipe has as many changes as it can keep. Drop one first.")
		}
	default:
		return e
	}
	id := uuid.NewString()
	if replaced != nil {
		id = replaced.ID
	}
	if _, e = tx.Exec(ctx, `INSERT INTO recipe_edits(id,user_id,recipe_id,kind,part,target,place,before,after,said,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
 ON CONFLICT (user_id,recipe_id,part,target) DO UPDATE SET kind=excluded.kind,place=excluded.place,before=excluded.before,after=excluded.after,said=excluded.said,source=excluded.source,updated_at=now()`,
		id, me, recipe, f.kind, f.part, f.target, f.place, jsonBytes(f.before), jsonBytes(f.after), said, in.Source); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	edits, e := loadEdits(ctx, a.DB, me, recipe, r, id)
	if e != nil || len(edits) == 0 {
		return errors.Join(e, fiber.NewError(404, "Recipe not found."))
	}
	return c.JSON(fiber.Map{"edit": edits[0], "replaced": replaced})
}

// keepEditHere keeps a change whose part changed since on the part at its place now ({"keep":
// true}), with the member's change as it is: what the part says now becomes its "before".
func (a *App) keepEditHere(c fiber.Ctx) error {
	var in struct{ Keep bool }
	if e := decode(c, &in); e != nil {
		return e
	}
	if !in.Keep {
		return fiber.NewError(400, "Keep the change, or drop it.")
	}
	ctx, me := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var recipe, part string
	var place int
	var raw []byte
	e = tx.QueryRow(ctx, `SELECT recipe_id,part,place,after FROM recipe_edits WHERE id=$1 AND user_id=$2 FOR UPDATE`, c.Params("id"), me).Scan(&recipe, &part, &place, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "This change could not be found.")
	}
	if e != nil {
		return e
	}
	r, ok, e := visibleRecipe(ctx, tx, recipe, me)
	if e != nil {
		return e
	}
	target, before, there := fixTarget(r, part, place)
	if !ok || !there {
		return fiber.NewError(409, "That part of the recipe is gone. Drop this change instead.")
	}
	_, e = tx.Exec(ctx, `UPDATE recipe_edits SET target=$2,before=$3,updated_at=now() WHERE id=$1`, c.Params("id"), target, jsonBytes(before))
	if pgCode(e) == "23505" {
		return fiber.NewError(409, "You already changed that part. Drop one of the two changes.")
	}
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	edits, e := loadEdits(ctx, a.DB, me, recipe, r, c.Params("id"))
	if e != nil || len(edits) == 0 {
		return errors.Join(e, fiber.NewError(404, "This change could not be found."))
	}
	return c.JSON(edits[0])
}

func (a *App) dropEdit(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `DELETE FROM recipe_edits WHERE id=$1 AND user_id=$2`, c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "This change could not be found.")
	}
	return c.SendStatus(204)
}

type kitchenNote struct {
	ID        string    `json:"id"`
	Note      string    `json:"note"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"createdAt"`
}

func (a *App) kitchenNotes(c fiber.Ctx) error {
	notes, e := notesOf(c.Context(), a.DB, userID(c))
	if e != nil {
		return e
	}
	return c.JSON(fiber.Map{"notes": notes})
}

func notesOf(ctx context.Context, db engagementDB, member string) ([]kitchenNote, error) {
	rows, e := db.Query(ctx, `SELECT id,note,source,created_at FROM kitchen_notes WHERE user_id=$1 ORDER BY created_at,id`, member)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []kitchenNote{}
	for rows.Next() {
		var n kitchenNote
		if e = rows.Scan(&n.ID, &n.Note, &n.Source, &n.CreatedAt); e != nil {
			return nil, e
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// addKitchenNote keeps a fact about the member's kitchen or taste, {"note", "source"}: 2 to 200
// characters, the same one once.
func (a *App) addKitchenNote(c fiber.Ctx) error {
	var in struct{ Note, Source string }
	if e := decode(c, &in); e != nil {
		return e
	}
	note := strings.Join(strings.Fields(in.Note), " ")
	if !validText(note, 2, 200) {
		return fiber.NewError(400, "Write a note of up to 200 characters.")
	}
	if in.Source == "" {
		in.Source = "typed"
	}
	if in.Source != "typed" && in.Source != "sous_chef" {
		return fiber.NewError(400, "Unknown source.")
	}
	var n kitchenNote
	e := a.DB.QueryRow(c.Context(), `WITH same AS (SELECT id,note,source,created_at FROM kitchen_notes WHERE user_id=$2 AND lower(note)=lower($3)),
 added AS (INSERT INTO kitchen_notes(id,user_id,note,source) SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM same)
   AND (SELECT count(*) FROM kitchen_notes WHERE user_id=$2)<$5 RETURNING id,note,source,created_at)
 SELECT * FROM same UNION ALL SELECT * FROM added`, uuid.NewString(), userID(c), note, in.Source, maxKitchenNotes).Scan(&n.ID, &n.Note, &n.Source, &n.CreatedAt)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(409, "You have as many kitchen notes as Savorly keeps. Remove one first.")
	}
	if e != nil {
		return e
	}
	return c.Status(201).JSON(n)
}

func (a *App) dropKitchenNote(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `DELETE FROM kitchen_notes WHERE id=$1 AND user_id=$2`, c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "This note could not be found.")
	}
	return c.SendStatus(204)
}

// yourVersionLine is what hands-free answers hear of the member's own version of recipe and of
// their kitchen (versionLine, notesLine): "" with neither.
func yourVersionLine(ctx context.Context, db engagementDB, member, recipe string, steps []Step, ingredients []Ingredient) string {
	return strings.TrimSpace(versionLine(ctx, db, member, recipe, steps, ingredients) + "\n" + notesLine(ctx, db, member))
}

// versionLine is the member's changes to recipe that still fit, as the sous-chef hears them, or
// "". A failure only leaves them out.
func versionLine(ctx context.Context, db engagementDB, member, recipe string, steps []Step, ingredients []Ingredient) string {
	edits, e := loadEdits(ctx, db, member, recipe, RecipeInput{Steps: steps, Ingredients: ingredients}, "")
	if e != nil {
		slog.Warn("load a member's version", "recipe", recipe, "error", e)
	}
	var parts []string
	for _, x := range edits {
		if !x.Fits {
			continue
		}
		line := suggestionSummary(x.Kind, x.Place, x.Before, x.After)
		if x.Said != "" {
			line += fmt.Sprintf(" (they said: “%s”)", clip(x.Said, 200))
		}
		parts = append(parts, line)
	}
	if len(parts) == 0 {
		return ""
	}
	return "The cook's own version of this recipe, which their screen shows: " + strings.Join(parts, "; ") + "."
}

// notesLine is the member's kitchen notes as the sous-chef hears them, or "".
func notesLine(ctx context.Context, db engagementDB, member string) string {
	notes, e := notesOf(ctx, db, member)
	if e != nil {
		slog.Warn("load kitchen notes", "error", e)
	}
	if len(notes) == 0 {
		return ""
	}
	said := make([]string, len(notes))
	for i, n := range notes {
		said[i] = "“" + clip(n.Note, 200) + "”"
	}
	return "What the cook told Savorly about their kitchen and taste: " + strings.Join(said, ", ") + "."
}
