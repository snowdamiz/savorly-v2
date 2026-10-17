package app

import (
	"context"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// All generation paths share a global reservation lock. Reservations are conservative,
// including failed or ambiguous provider submissions; provider billing is authoritative.
// Three ceilings apply: the member's plan SpendCap over 30 days; a shared daily budget for
// free members, funded by a base amount plus a share of paying members' revenue; and a
// hard daily circuit breaker that grows with paying members' ceilings, so it stops runaway
// spend without ever blocking members inside their plan. The admin console can pause all AI
// spend or override the two daily base budgets (Settings).
// TODO: sums 30 days of spend per reservation under one lock; keep a per-user rollup when volume grows.
func reserveGeneration(ctx context.Context, tx pgx.Tx, owner string, estimate float64) error {
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7182302)`); e != nil {
		return e
	}
	settings, e := loadSettings(ctx, tx)
	if e != nil {
		return e
	}
	if settings.AIPaused {
		return fiber.NewError(503, aiPausedMessage)
	}
	pool, e := poolOf(ctx, tx, owner)
	if e != nil {
		return e
	}
	p := pool.Plan
	// A plan shared with a household has one ceiling for everyone on it.
	var mine, free, total float64
	e = tx.QueryRow(ctx, budgetSumsSQL, pool.Members).Scan(&mine, &free, &total)
	if e != nil {
		return e
	}
	if mine+estimate > p.SpendCap {
		return fiber.NewError(429, "You've used your plan's AI allowance for the last 30 days. Your conversation and drafts are saved.")
	}
	freeHeadroom, paidHeadroom, e := memberBudgets(ctx, tx)
	if e != nil {
		return e
	}
	if p.ID == "free" && free+estimate > settings.freeDailyBudget()+freeHeadroom {
		return fiber.NewError(429, "Free AI use is at capacity today. Your conversation and draft are saved; try again tomorrow.")
	}
	if budget := settings.dailyBudget(); budget <= 0 || total+estimate > budget+freeHeadroom+paidHeadroom {
		return fiber.NewError(429, "Today's AI budget is reached. Your conversation and draft are saved; try again tomorrow.")
	}
	return nil
}

// reserveShared is reserveGeneration for a call no member pays for, such as a recipe's
// translation, which every later reader shares: it takes the same lock and counts against the
// shared free daily budget and the daily circuit breaker, like a free member's call. Record it
// with recordUsage(…, "", …) in the same transaction.
func reserveShared(ctx context.Context, tx pgx.Tx, estimate float64) error {
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7182302)`); e != nil {
		return e
	}
	settings, e := loadSettings(ctx, tx)
	if e != nil {
		return e
	}
	if settings.AIPaused {
		return fiber.NewError(503, aiPausedMessage)
	}
	var free, total float64
	if e = tx.QueryRow(ctx, budgetSumsSQL, []string{}).Scan(new(float64), &free, &total); e != nil {
		return e
	}
	freeHeadroom, paidHeadroom, e := memberBudgets(ctx, tx)
	if e != nil {
		return e
	}
	if free+estimate > settings.freeDailyBudget()+freeHeadroom {
		return fiber.NewError(429, "Free AI use is at capacity today. Try again tomorrow.")
	}
	if budget := settings.dailyBudget(); budget <= 0 || total+estimate > budget+freeHeadroom+paidHeadroom {
		return fiber.NewError(429, "Today's AI budget is reached. Try again tomorrow.")
	}
	return nil
}

// budgetSumsSQL is the last 30 days of spend of the members sharing a plan ($1), and everyone's,
// and free members', last 24 hours, each read through an index on the spend sources'
// created_at. Members using a household's plan aren't free.
const budgetSumsSQL = `SELECT
 (SELECT COALESCE(sum(cost),0) FROM ai_spend WHERE user_id=ANY($1::text[]) AND created_at>now()-interval '30 days'),
 COALESCE(sum(s.cost) FILTER (WHERE u.id IS NULL OR ` + memberPlanSQL + `='free'),0),
 COALESCE(sum(s.cost),0)
 FROM ai_spend s LEFT JOIN users u ON u.id=s.user_id WHERE s.created_at>now()-interval '24 hours'`
