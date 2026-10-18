package app

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"os"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v3"
	"savorly/api/internal/ai"
)

// The cheap model's estimates of steps whose words give no time (step_timing.go): once per
// version of a published recipe, the most saved first, at most stepTimingRecipes a day. Every
// later cook shares an estimate, so no member pays for it: like a translation it counts against
// the shared free budget (reserveShared), as ai_usage kind step_timing. Without an OpenRouter key,
// or once the day's cap or budget is spent, guesses stay guesses, and the timeline still works.

// stepTimingRecipes is how many recipes the model may estimate in a day at most
// (STEP_TIMING_RECIPES): a cap on what estimates can cost.
func stepTimingRecipes() int {
	if n, e := strconv.Atoi(os.Getenv("STEP_TIMING_RECIPES")); e == nil && n >= 0 {
		return n
	}
	return 200
}

// estimateTimings has the model estimate the guesses of published recipes not yet asked about,
// within what's left of the day's cap, under a lock so replicas don't ask twice. It stops when the
// shared budget says no, and reports how many recipes it asked about.
func (a *App) estimateTimings(ctx context.Context) (int, error) {
	conn, e := a.DB.Acquire(ctx)
	if e != nil {
		return 0, e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(7182341)`).Scan(&locked); e != nil || !locked {
		return 0, e
	}
	defer func() {
		if _, e := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(7182341)`); e != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	var used int
	if e = conn.QueryRow(ctx, `SELECT count(*) FROM ai_usage WHERE kind='step_timing' AND created_at>now()-interval '24 hours'`).Scan(&used); e != nil {
		return 0, e
	}
	left := stepTimingRecipes() - used
	if left <= 0 {
		return 0, nil
	}
	ids, e := collectIDs(ctx, conn, `SELECT r.id FROM recipes r JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL
 WHERE r.published AND r.timing_guessed AND r.timing_asked<>r.timing_source AND r.timing_indexed=r.timing_source
 ORDER BY (SELECT count(*) FROM saves s WHERE s.recipe_id=r.id) DESC,r.id LIMIT $1`, left)
	if e != nil {
		return 0, e
	}
	asked := 0
	for _, id := range ids {
		if ctx.Err() != nil {
			return asked, ctx.Err()
		}
		sent, e := a.estimateRecipeTiming(ctx, id)
		if sent {
			asked++
		}
		var budget *fiber.Error
		if errors.As(e, &budget) {
			// The day's budget is spent, or AI is paused: the rest wait for another pass.
			return asked, nil
		}
		if e != nil {
			slog.Warn("estimate a recipe's step timing", "recipe", id, "error", e)
		}
	}
	return asked, nil
}

// estimateRecipeTiming asks the model about one recipe's guessed steps and keeps what it answers
// as their estimates. A recipe changed meanwhile keeps nothing, and is asked about again once
// read. It reports whether the model was asked (and so paid for).
func (a *App) estimateRecipeTiming(ctx context.Context, id string) (bool, error) {
	var title, source string
	var minutes int
	var steps []Step
	saved := map[string]timingEstimate{}
	e := a.DB.QueryRow(ctx, `SELECT title,minutes,steps,step_timing,timing_source FROM recipes WHERE id=$1`, id).Scan(&title, &minutes, &steps, &saved, &source)
	if e != nil {
		return false, e
	}
	request := ai.TimingRecipe{Title: title, Minutes: minutes}
	keys := map[int]string{}
	for i, st := range steps {
		key := cookStepKey(st.Text)
		guess := st.Timing == nil && saved[key].Source == fromGuess
		if guess {
			keys[i+1] = key
		}
		request.Steps = append(request.Steps, ai.TimingStep{Step: i + 1, Text: stepText(st, 600), Estimate: guess})
	}
	asked := func() error {
		_, e := a.DB.Exec(ctx, `UPDATE recipes SET timing_asked=$2 WHERE id=$1`, id, source)
		return e
	}
	if len(keys) == 0 {
		return false, asked()
	}
	usage, e := a.reserveTiming(ctx, request.Estimate())
	if e != nil {
		return false, e
	}
	call, cancel := context.WithTimeout(ctx, 60*time.Second)
	estimates, cost, e := a.AI.EstimateTiming(call, request)
	cancel()
	var spent error
	if errors.Is(e, ai.ErrNotSent) {
		spent = releaseUsage(context.Background(), a.DB, usage)
	} else {
		spent = settleUsage(context.Background(), a.DB, usage, cost)
	}
	if spent != nil {
		slog.Warn("settle step timing", "error", spent)
	}
	if errors.Is(e, ai.ErrNotSent) {
		return false, e
	}
	if e != nil {
		// Paid for, so this version isn't sent again.
		return true, errors.Join(e, asked())
	}
	for _, est := range estimates {
		key := keys[est.Step]
		saved[key] = timingEstimate{StepTiming: StepTiming{
			Active: int(math.Round(est.Active * 60)), Wait: int(math.Round(est.Wait * 60)), Oven: est.Oven, Burners: est.Burners, Estimated: true,
		}, Source: fromModel}
	}
	guessed := false
	for _, key := range keys {
		guessed = guessed || saved[key].Source == fromGuess
	}
	_, e = a.DB.Exec(ctx, `UPDATE recipes SET step_timing=$2,timing_guessed=$3,timing_asked=$4 WHERE id=$1 AND timing_source=$4`, id, jsonBytes(saved), guessed, source)
	return true, e
}

// reserveTiming commits an estimate's reservation against the shared budget, like a
// translation's: no member pays for it.
func (a *App) reserveTiming(ctx context.Context, estimate float64) (int64, error) {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback(context.Background())
	if e = reserveShared(ctx, tx, estimate); e != nil {
		return 0, e
	}
	usage, e := recordUsage(ctx, tx, "", "step_timing", estimate)
	if e == nil {
		e = tx.Commit(ctx)
	}
	return usage, e
}
