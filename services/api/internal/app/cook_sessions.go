package app

import (
	"context"
	"errors"
	"log/slog"
	"math"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Cooking mode records a session for a signed-in member: when it started, the furthest step
// reached, and when it finished. A finished session that plausibly happened is a verified cook.
// Verified cooks give recipes their real cook time and decide where the creator fund's money goes
// (creator_fund.go, docs/CREATOR-FUND.md). Guests record nothing, and "I cooked this" posts stay
// social: they never count as a cook here.

const (
	// A verified cook lasted at least a third of the recipe's stated time, and never has to last
	// less than 3 or more than 20 minutes: tapping through the steps doesn't count, while a cook who
	// prepared ahead, or a long braise left in the oven, still does.
	minCookMinutes, maxCookMinutes = 3, 20
	// The latest verified cooks a recipe's cook time is the median of. recipeJSON shows it once a
	// recipe has 3 verified cooks.
	cookTimeSample = 500
)

const cookSessionJSON = `jsonb_build_object('id',k.id,'recipeId',k.recipe_id,'steps',k.steps,'stepReached',k.step_reached,
 'startedAt',k.started_at,'finishedAt',k.finished_at,'verified',k.verified)`

// startCookSession begins a session on a recipe the member can cook: a published one, or their
// own (which never counts).
func (a *App) startCookSession(c fiber.Ctx) error {
	var b []byte
	e := a.DB.QueryRow(c.Context(), `WITH k AS (INSERT INTO cook_sessions(id,user_id,recipe_id,steps)
 SELECT $1,$2,r.id,jsonb_array_length(r.steps) FROM recipes r JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL
 WHERE r.id=$3 AND (r.published OR r.author_id=$2) AND jsonb_array_length(r.steps)>0 RETURNING *)
SELECT `+cookSessionJSON+` FROM k`, uuid.NewString(), userID(c), c.Params("id")).Scan(&b)
	// A recipe deleted meanwhile fails the reference instead.
	if errors.Is(e, pgx.ErrNoRows) || pgCode(e) == "23503" {
		return fiber.NewError(404, "Recipe not found.")
	}
	if e != nil {
		return e
	}
	return c.Status(201).Type("json").Send(b)
}

// updateCookSession records the furthest step reached ({ "step" }, 1-based) and, with
// "finished": true, ends the session. A finished session doesn't change: asking again answers it
// as it is, so an app retrying a lost answer gets the same one.
func (a *App) updateCookSession(c fiber.Ctx) error {
	var in struct {
		Step     int
		Finished bool
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Step < 0 || in.Step > 1000 {
		return fiber.NewError(400, "Choose a step of this recipe.")
	}
	ctx, id, me := c.Context(), c.Params("id"), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// One member's sessions finish one at a time, so two finished at once can't both be the day's
	// verified cook of a recipe.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,7182322))`, me); e != nil {
		return e
	}
	var recipe string
	var finished, expired bool
	e = tx.QueryRow(ctx, `SELECT recipe_id,finished_at IS NOT NULL,started_at<now()-interval '24 hours' FROM cook_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, me).Scan(&recipe, &finished, &expired)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "This item could not be found.")
	}
	if e != nil {
		return e
	}
	if finished {
		return sendCookSession(c, tx, id)
	}
	// A session left open for a day is over; it never counts.
	if expired {
		return fiber.NewError(409, "This cooking session has ended. Start cooking again to count it.")
	}
	if _, e = tx.Exec(ctx, `UPDATE cook_sessions SET step_reached=LEAST(GREATEST(step_reached,$2),steps),updated_at=now() WHERE id=$1`, id, in.Step); e != nil {
		return e
	}
	verified := false
	if in.Finished {
		if verified, e = finishCookSession(ctx, tx, id, me); e != nil {
			return e
		}
	}
	var b []byte
	if e = tx.QueryRow(ctx, `SELECT `+cookSessionJSON+` FROM cook_sessions k WHERE k.id=$1`, id).Scan(&b); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	// After the commit, so the median includes this cook. A failure only leaves the cook time a
	// little behind until the next cook.
	if verified {
		if e := refreshCookTime(ctx, a.DB, recipe); e != nil {
			slog.Warn("refresh a recipe's cook time", "recipe", recipe, "error", e)
		}
	}
	return c.Type("json").Send(b)
}

func sendCookSession(c fiber.Ctx, q querier, id string) error {
	var b []byte
	if e := q.QueryRow(c.Context(), `SELECT `+cookSessionJSON+` FROM cook_sessions k WHERE k.id=$1`, id).Scan(&b); e != nil {
		return e
	}
	return c.Type("json").Send(b)
}

// finishSQL ends session $1 and makes it a verified cook when it plausibly happened: the member
// reached the last step, the recipe is someone else's and still public, at least the minimum time
// passed (a third of the recipe's stated minutes, between $3 and $4), and it's the member's first
// verified cook of the recipe this UTC day. $2 is what the member's plan brings the fund.
const finishSQL = `UPDATE cook_sessions k SET finished_at=now(),updated_at=now(),verified=v.ok,
 verified_day=CASE WHEN v.ok THEN (now() AT TIME ZONE 'UTC')::date END,net_cents=CASE WHEN v.ok THEN $2 ELSE 0 END
 FROM (SELECT s.id,COALESCE(s.step_reached>=s.steps AND r.author_id<>s.user_id AND r.published AND ra.suspended_at IS NULL
   AND now()-s.started_at>=make_interval(mins=>least($4::int,greatest($3::int,r.minutes/3)))
   AND NOT EXISTS(SELECT 1 FROM cook_sessions o WHERE o.user_id=s.user_id AND o.recipe_id=s.recipe_id AND o.verified
     AND o.verified_day=(now() AT TIME ZONE 'UTC')::date),false) AS ok
   FROM cook_sessions s JOIN recipes r ON r.id=s.recipe_id LEFT JOIN users ra ON ra.id=r.author_id WHERE s.id=$1) v
 WHERE k.id=v.id RETURNING k.verified`

// finishCookSession ends a session inside the caller's transaction, which holds the member's
// lock, and reports whether it became a verified cook.
func finishCookSession(ctx context.Context, tx pgx.Tx, id, member string) (bool, error) {
	net, e := memberNetCents(ctx, tx, member)
	if e != nil {
		return false, e
	}
	var verified bool
	e = tx.QueryRow(ctx, finishSQL, id, net, minCookMinutes, maxCookMinutes).Scan(&verified)
	return verified, e
}

// memberNetCents is what the member's subscription brings in a month after fees, in cents, at
// the moment: the plan's net as docs/PRICING.md computes it, a twelfth of a yearly one. Only a
// paid-up subscription counts; Free, complimentary (no billing interval), trialing and past-due
// plans bring nothing in.
func memberNetCents(ctx context.Context, q querier, member string) (int, error) {
	if !paidPlans() {
		return 0, nil
	}
	var plan, status, interval string
	if e := q.QueryRow(ctx, `SELECT plan,plan_status,plan_interval FROM users WHERE id=$1`, member).Scan(&plan, &status, &interval); e != nil {
		return 0, e
	}
	return planNetCents(plan, status, interval), nil
}

func planNetCents(plan, status, interval string) int {
	p := planByID(plan)
	if status != "active" || interval == "" || p.ID == "free" {
		return 0
	}
	return int(math.Round(p.netMonthly(interval) * 100))
}

// refreshCookTime recomputes a recipe's cook time: the median length of its latest verified
// cooks, in whole minutes, and how many verified cooks it has in all.
func refreshCookTime(ctx context.Context, db execer, recipe string) error {
	_, e := db.Exec(ctx, `INSERT INTO recipe_cook_times(recipe_id,cooks,minutes)
 SELECT $1,(SELECT count(*) FROM cook_sessions WHERE recipe_id=$1 AND verified),
  greatest(1,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.finished_at-s.started_at))/60))::int
 FROM (SELECT started_at,finished_at FROM cook_sessions WHERE recipe_id=$1 AND verified ORDER BY finished_at DESC LIMIT $2) s
 HAVING count(*)>0
 ON CONFLICT (recipe_id) DO UPDATE SET cooks=excluded.cooks,minutes=excluded.minutes,updated_at=now()`, recipe, cookTimeSample)
	return e
}
