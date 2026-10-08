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
// spend without ever blocking members inside their plan.
// ponytail: sums 30 days of spend per reservation under one lock; keep a per-user rollup when volume grows.
func reserveGeneration(ctx context.Context, tx pgx.Tx, owner string, estimate float64) error {
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7182302)`); e != nil {
		return e
	}
	p, e := planOf(ctx, tx, owner)
	if e != nil {
		return e
	}
	var mine, free, total float64
	e = tx.QueryRow(ctx, `SELECT
 COALESCE(sum(s.cost) FILTER (WHERE s.user_id=$1),0),
 COALESCE(sum(s.cost) FILTER (WHERE s.created_at>now()-interval '24 hours' AND (u.id IS NULL OR `+effectivePlanSQL+`='free')),0),
 COALESCE(sum(s.cost) FILTER (WHERE s.created_at>now()-interval '24 hours'),0)
 FROM ai_spend s LEFT JOIN users u ON u.id=s.user_id WHERE s.created_at>now()-interval '30 days'`, owner).Scan(&mine, &free, &total)
	if e != nil {
		return e
	}
	if mine+estimate > p.SpendCap {
		return fiber.NewError(429, "You've used this month's AI allowance on your plan. Your conversation and drafts are saved.")
	}
	freeHeadroom, paidHeadroom, e := memberBudgets(ctx, tx)
	if e != nil {
		return e
	}
	if p.ID == "free" && free+estimate > envFloat("AI_FREE_DAILY_BUDGET_USD", 5)+freeHeadroom {
		return fiber.NewError(429, "Free AI use is at capacity today. Your conversation and draft are saved; try again tomorrow.")
	}
	if budget := envFloat("AI_DAILY_BUDGET_USD", 25); budget <= 0 || total+estimate > budget+freeHeadroom+paidHeadroom {
		return fiber.NewError(429, "Today's AI budget is reached. Your conversation and draft are saved; try again tomorrow.")
	}
	return nil
}
