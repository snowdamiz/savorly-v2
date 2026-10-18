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
	"github.com/jackc/pgx/v5"
	"savorly/api/internal/ai"
)

// Hands-free cooking listens on the device: the app recognizes speech itself, and its commands
// (next step, start the timer, read the ingredients…) never reach the server. Only a question
// that starts with the wake word ("Chef, …") comes here, as text, so a whole cook can stay
// hands-free without a live voice call's per-minute cost.

// handsFreeRoutes are cooking mode's hands-free questions.
func (a *App) handsFreeRoutes(v fiber.Router) {
	// Each question is a paid model call; a cook asks a handful.
	v.Post("/recipes/:id/ask", a.requireAuth, perUser(20, time.Minute), a.askCook)
}

// askCook answers a question about the recipe the cook has open, from the recipe and their step,
// in one to three short sentences the app reads aloud. It has no tools and changes nothing.
func (a *App) askCook(c fiber.Ctx) error {
	if !a.AI.TextEnabled() {
		return fiber.NewError(503, "Cooking questions aren't set up on this server.")
	}
	var in struct {
		Question string `json:"question"`
		// Step is the 1-based step on screen, or 0.
		Step     int    `json:"step"`
		Language string `json:"language"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	question := strings.Join(strings.Fields(in.Question), " ")
	if !validText(question, 2, 300) {
		return fiber.NewError(400, "Ask a question of up to 300 characters.")
	}
	if in.Step < 0 || in.Step > 100 {
		return fiber.NewError(400, "Invalid cooking step.")
	}
	language := sceneLanguages[in.Language]
	if language == "" {
		language = sceneLanguages["en"]
	}
	ctx, owner := c.Context(), strings.Clone(userID(c))
	recipe, e := a.cookRecipe(ctx, c.Params("id"), owner)
	if e != nil {
		return e
	}
	q := ai.CookQuestion{Recipe: recipe.text(), Step: cookStep(recipe, in.Step), Insight: recipe.insight(in.Step), Question: question, Language: language,
		Yours: yourVersionLine(ctx, a.DB, owner, recipe.id, recipe.steps, recipe.ingredients)}
	usage, e := a.reserveCookQuestion(ctx, owner, q.Estimate())
	if e != nil {
		return e
	}
	// What cooks ask at a step, grouped with others' each night, becomes the recipe's questions.
	recordCookQuestion(ctx, a.DB, owner, recipe.id, in.Step, question, "hands_free")
	call, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	answer, cost, e := a.AI.CookAnswer(call, q)
	// Settled on its own deadline, so a slow answer still records what it cost. A failed call
	// keeps its reservation: the provider may have billed it.
	settle, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if se := settleUsage(settle, a.DB, usage, cost); se != nil {
		slog.Warn("settle cooking question", "error", se)
	}
	if e != nil {
		slog.Warn("cooking question failed", "recipe", recipe.id, "error", e)
		return fiber.NewError(502, "The chef couldn't answer just now. Please try again.")
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(fiber.Map{"answer": answer})
}

// cookRecipe is the recipe a question is about, as the member may see it: published by a cook
// who isn't suspended, or their own.
func (a *App) cookRecipe(ctx context.Context, id, owner string) (*sceneRecipe, error) {
	r := &sceneRecipe{id: id}
	var ingredients, steps []byte
	e := a.DB.QueryRow(ctx, `SELECT r.title,u.name,r.author_id=$2,r.servings,r.minutes,r.ingredients,r.steps,r.equipment,r.equipment_detected`+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=$2)`, id, owner).
		Scan(&r.title, &r.author, &r.mine, &r.servings, &r.minutes, &ingredients, &steps, &r.equipment, &r.detected)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fiber.NewError(404, "Recipe not found.")
	}
	if e != nil {
		return nil, e
	}
	_ = json.Unmarshal(ingredients, &r.ingredients)
	_ = json.Unmarshal(steps, &r.steps)
	r.insights = stepInsightsFor(ctx, a.DB, id, r.steps)
	return r, nil
}

// cookStep is where the cook is, for the model, or "" when the app named no step of this recipe.
func cookStep(r *sceneRecipe, step int) string {
	if step < 1 || step > len(r.steps) {
		return ""
	}
	return fmt.Sprintf("on step %d of %d: %s", step, len(r.steps), stepText(r.steps[step-1], 600))
}

// reserveCookQuestion checks the member's cooking-question allowance and AI budgets and records
// the question's reservation in the ai_usage ledger, all under the member's lock so concurrent
// questions can't pass the allowance together. It returns the ledger row to settle.
func (a *App) reserveCookQuestion(ctx context.Context, owner string, estimate float64) (int64, error) {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return 0, e
	}
	if e = allowance(ctx, tx, owner, "cook_question"); e != nil {
		return 0, e
	}
	if e = reserveGeneration(ctx, tx, owner, estimate); e != nil {
		return 0, e
	}
	id, e := recordUsage(ctx, tx, owner, "cook_question", estimate)
	if e != nil {
		return 0, e
	}
	return id, tx.Commit(ctx)
}
