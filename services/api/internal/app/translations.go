package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"savorly/api/internal/ai"
)

// Recipes in the reader's language (030_recipe_translations.sql). A recipe's title, description,
// ingredient names and steps are translated by AI once per language and kept for everyone who
// reads it in that language. Amounts, units, tags and cuisine stay as written: the app converts and
// names units itself, and tags and cuisines drive filters. A translation is kept under a digest of
// the text it was made from, so an edited recipe is translated again instead of being shown with
// the text of another version. Every later reader shares a translation, so no member pays for it:
// it counts against the shared free budget (reserveShared). Only signed-in members start one, a
// limited number an hour, so crawlers can't spend that budget; guests read what members started.

func (a *App) translationRoutes(v fiber.Router) {
	v.Get("/recipes/:id/translation", a.recipeTranslation)
}

const (
	// translationsPerHour bounds the new translations a member starts; ones already made are free.
	translationsPerHour = 30
	// activeTranslations bounds the translations one API process runs at once, as each holds a
	// database connection for its lock while the model writes (translate).
	activeTranslations = 4
	// translationTimeout covers the model's answer for the longest recipe.
	translationTimeout = 90 * time.Second
	// translationVersion is part of every source digest: changing it, for a better prompt or model,
	// has each recipe translated afresh when it is next read.
	translationVersion = "1"
)

// translationEstimate reserves a cent a recipe plus $1 per million characters. GPT-6 Luna's fast
// tier reads and rewrites a typical 3,000-character recipe for about half a cent (docs/PRICING.md);
// the reservation is lowered to the provider's reported cost once it answers.
func translationEstimate(text ai.RecipeText) float64 {
	return .01 + float64(text.Runes())*.000001
}

// recipeSource is a recipe's own text and language, which a translation is made from.
type recipeSource struct {
	language string
	text     ai.RecipeText
}

// hash is the digest a translation of s is kept under.
func (s recipeSource) hash() string {
	return hashToken(translationVersion + "\x00" + s.language + "\x00" + string(jsonBytes(s.text)))
}

// loadRecipeSource reads a recipe viewer ("" for a guest) may see: published, or their own, by a
// cook in good standing, as GET /recipes/:id shows it. A missing one is pgx.ErrNoRows.
func loadRecipeSource(ctx context.Context, q querier, id, viewer string) (recipeSource, error) {
	var s recipeSource
	var ingredients []Ingredient
	var steps []Step
	e := q.QueryRow(ctx, `SELECT r.title,r.description,r.ingredients,r.steps,r.language,r.equipment`+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=$2)`, id, viewer).
		Scan(&s.text.Title, &s.text.Description, &ingredients, &steps, &s.language, &s.text.Equipment)
	if e != nil {
		return s, e
	}
	s.text.Ingredients = make([]ai.IngredientText, len(ingredients))
	for i, in := range ingredients {
		s.text.Ingredients[i].Name = in.Name
	}
	s.text.Steps = make([]ai.StepText, len(steps))
	for i, st := range steps {
		s.text.Steps[i] = ai.StepText{Title: st.Title, Text: st.Text}
	}
	return s, nil
}

// translationReply is GET /recipes/:id/translation's answer: the recipe's text in language, its
// ingredients and steps in the recipe's order, and when it was translated (null when the recipe is
// written in that language already).
type translationReply struct {
	Language       string `json:"language"`
	SourceLanguage string `json:"sourceLanguage"`
	ai.RecipeText
	TranslatedAt *time.Time `json:"translatedAt"`
}

// cachedTranslation is the translation of a recipe's current text (hash), written in source, into
// language, if one was made. Reading one keeps it from the janitor; a day's precision saves a write
// on most reads.
func cachedTranslation(ctx context.Context, db recipeWriter, id, source, hash, language string) (translationReply, bool, error) {
	reply := translationReply{Language: language, SourceLanguage: source}
	var content []byte
	var at time.Time
	var stale bool
	e := db.QueryRow(ctx, `SELECT content,created_at,last_used_at<now()-interval '1 day' FROM recipe_translations WHERE recipe_id=$1 AND language=$2 AND source_hash=$3`, id, language, hash).Scan(&content, &at, &stale)
	if errors.Is(e, pgx.ErrNoRows) {
		return reply, false, nil
	}
	if e == nil {
		e = json.Unmarshal(content, &reply.RecipeText)
	}
	if e != nil {
		return reply, false, e
	}
	reply.TranslatedAt = &at
	if stale {
		if _, e = db.Exec(ctx, `UPDATE recipe_translations SET last_used_at=now() WHERE recipe_id=$1 AND language=$2`, id, language); e != nil {
			slog.Warn("touch recipe translation", "error", e)
		}
	}
	return reply, true, nil
}

// recipeTranslation answers GET /recipes/:id/translation?language=xx.
func (a *App) recipeTranslation(c fiber.Ctx) error {
	target, ok := recipeLanguage(c.Query("language"))
	if !ok || target == "" {
		return fiber.NewError(400, "Choose a supported language.")
	}
	target = strings.Clone(target)
	viewer, e := a.sessionUser(c)
	if e != nil {
		return e
	}
	id := strings.Clone(c.Params("id"))
	source, e := loadRecipeSource(c.Context(), a.DB, id, viewer)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Recipe not found.")
	}
	if e != nil {
		return e
	}
	if source.language == target {
		// Written in the reader's language already: nothing to translate.
		return c.JSON(translationReply{Language: target, SourceLanguage: target, RecipeText: source.text})
	}
	hash := source.hash()
	reply, found, e := cachedTranslation(c.Context(), a.DB, id, source.language, hash, target)
	if e != nil {
		return e
	}
	if found {
		return c.JSON(reply)
	}
	if !a.AI.TextEnabled() {
		return fiber.NewError(503, "Recipe translation isn’t set up on this server.")
	}
	if viewer == "" {
		return fiber.NewError(401, "Sign in to translate this recipe.")
	}
	if !a.translations.members.hit(viewer, translationsPerHour, time.Hour) {
		return fiber.NewError(429, "You’ve translated a lot of recipes in the last hour. Please try again later.")
	}
	parent := a.Context
	if parent == nil {
		parent = context.Background()
	}
	reply, e = a.translations.join(c.Context(), parent, id+"\x00"+target+"\x00"+hash, func(ctx context.Context) (translationReply, error) {
		return a.translate(ctx, id, target, hash, source)
	})
	if e != nil {
		return e
	}
	return c.JSON(reply)
}

// translate translates source into target and keeps it, unless another API replica made it while
// this one waited for the lock. The spend is committed before the model is asked, so the shared
// budget's lock isn't held while it writes.
func (a *App) translate(ctx context.Context, id, target, hash string, source recipeSource) (translationReply, error) {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return translationReply{}, e
	}
	defer tx.Rollback(context.Background())
	// One translation of a recipe into a language at a time across replicas: a reader who asks
	// while another replica translates it waits here, then reads what that one made.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2,7182320))`, target, id); e != nil {
		return translationReply{}, e
	}
	if reply, found, e := cachedTranslation(ctx, tx, id, source.language, hash, target); e != nil || found {
		return reply, e
	}
	usage, e := a.reserveTranslation(ctx, translationEstimate(source.text))
	if e != nil {
		return translationReply{}, e
	}
	text, cost, e := a.AI.TranslateRecipe(ctx, source.text, source.language, target)
	var spent error
	if errors.Is(e, ai.ErrNotSent) {
		spent = releaseUsage(context.Background(), a.DB, usage)
	} else {
		spent = settleUsage(context.Background(), a.DB, usage, cost)
	}
	if spent != nil {
		slog.Warn("settle recipe translation", "error", spent)
	}
	if e != nil {
		slog.Warn("recipe translation failed", "recipe", id, "language", target, "error", e)
		return translationReply{}, fiber.NewError(502, "We couldn’t translate this recipe. Please try again.")
	}
	reply := translationReply{Language: target, SourceLanguage: source.language, RecipeText: text}
	var at time.Time
	// A translation of the recipe's earlier text is replaced.
	e = tx.QueryRow(ctx, `INSERT INTO recipe_translations(recipe_id,language,source_hash,content) VALUES($1,$2,$3,$4)
 ON CONFLICT (recipe_id,language) DO UPDATE SET source_hash=excluded.source_hash,content=excluded.content,created_at=now(),last_used_at=now() RETURNING created_at`, id, target, hash, jsonBytes(text)).Scan(&at)
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		return translationReply{}, e
	}
	reply.TranslatedAt = &at
	return reply, nil
}

// reserveTranslation commits a translation's reservation against the shared budget.
func (a *App) reserveTranslation(ctx context.Context, estimate float64) (int64, error) {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback(context.Background())
	if e = reserveShared(ctx, tx, estimate); e != nil {
		return 0, e
	}
	usage, e := recordUsage(ctx, tx, "", "translation", estimate)
	if e == nil {
		e = tx.Commit(ctx)
	}
	return usage, e
}

// translatedStep is the text of a step of the recipe's translation into language: what a reader
// cooking the translated recipe hears read aloud. It is the recipe's own step when the recipe is
// written in that language. A translation of another version of the recipe isn't one of it, and
// neither is a translation never made: either way the app reads the step with the device's voice.
func translatedStep(ctx context.Context, q querier, id string, step int, viewer, language string) (string, error) {
	source, e := loadRecipeSource(ctx, q, id, viewer)
	if errors.Is(e, pgx.ErrNoRows) || (e == nil && step >= len(source.text.Steps)) {
		return "", fiber.NewError(404, "Cooking step not found.")
	}
	if e != nil {
		return "", e
	}
	if language == source.language {
		return source.text.Steps[step].Text, nil
	}
	var text string
	e = q.QueryRow(ctx, `SELECT COALESCE(content->'steps'->($4::int)->>'text','') FROM recipe_translations WHERE recipe_id=$1 AND language=$2 AND source_hash=$3`, id, language, source.hash(), step).Scan(&text)
	if errors.Is(e, pgx.ErrNoRows) {
		return "", fiber.NewError(409, "This recipe has changed. Refresh it before reading aloud.")
	}
	return text, e
}

// translationWork is what one API process shares between translation requests: the translation in
// flight for each recipe, language and text, which every reader asking for it at once waits on,
// and how many translations each member started this hour.
type translationWork struct {
	mu      sync.Mutex
	flights map[string]*translationFlight
	active  int
	members attemptCounter
}

type translationFlight struct {
	done  chan struct{}
	reply translationReply
	err   error
}

// join waits for the translation under key, starting run when none is in flight. run gets a
// context of its own, from parent, so a reader who stops waiting doesn't cut short a translation
// that may already be paid for and that others may be waiting on. A failure is kept for half a
// minute, so asking again at once doesn't pay for another attempt.
func (w *translationWork) join(ctx, parent context.Context, key string, run func(context.Context) (translationReply, error)) (translationReply, error) {
	w.mu.Lock()
	f := w.flights[key]
	if f == nil {
		if w.active >= activeTranslations {
			w.mu.Unlock()
			return translationReply{}, fiber.NewError(503, "Translation is busy. Please try again in a moment.")
		}
		if w.flights == nil {
			w.flights = map[string]*translationFlight{}
		}
		f = &translationFlight{done: make(chan struct{})}
		w.flights[key] = f
		w.active++
		go w.fly(parent, key, f, run)
	}
	w.mu.Unlock()
	select {
	case <-f.done:
		return f.reply, f.err
	case <-ctx.Done():
		return translationReply{}, ctx.Err()
	}
}

func (w *translationWork) fly(parent context.Context, key string, f *translationFlight, run func(context.Context) (translationReply, error)) {
	ctx, cancel := context.WithTimeout(parent, translationTimeout)
	defer cancel()
	f.reply, f.err = run(ctx)
	close(f.done)
	w.mu.Lock()
	w.active--
	if f.err == nil {
		// Made and kept: later readers find it in the database.
		delete(w.flights, key)
	}
	w.mu.Unlock()
	if f.err != nil {
		time.AfterFunc(30*time.Second, func() {
			w.mu.Lock()
			if w.flights[key] == f {
				delete(w.flights, key)
			}
			w.mu.Unlock()
		})
	}
}
