package app

import (
	"context"
	"math"
	"os"
	"strconv"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// Plan is what a subscription buys. Allowances cover a rolling 30 days. SpendCap is the
// hard ceiling on what one member's AI use may cost in that window; pricing_test.go
// keeps it below the plan's revenue after payment fees.
type Plan struct {
	ID           string  `json:"id"`
	MonthlyUSD   float64 `json:"monthlyUSD"`
	YearlyUSD    float64 `json:"yearlyUSD"`
	Assistant    int     `json:"assistant"` // sous-chef turns and one-shot text tools
	VoiceMinutes int     `json:"voiceMinutes"`
	Images       int     `json:"images"`
	Videos       int     `json:"videos"`
	Narration    int     `json:"narration"` // natural-voice step read-alouds
	SpendCap     float64 `json:"-"`
}

// The catalog's prices must match the Stripe prices configured for checkout. See
// docs/PRICING.md for the arithmetic; pricing_test.go fails if a change breaks it.
var plans = []Plan{
	{ID: "free", Assistant: 10, VoiceMinutes: 2, Images: 1, Videos: 0, Narration: 5, SpendCap: 0.50},
	{ID: "plus", MonthlyUSD: 9.99, YearlyUSD: 79.99, Assistant: 80, VoiceMinutes: 20, Images: 6, Videos: 0, Narration: 30, SpendCap: 3.80},
	{ID: "pro", MonthlyUSD: 19.99, YearlyUSD: 159.99, Assistant: 130, VoiceMinutes: 40, Images: 10, Videos: 1, Narration: 30, SpendCap: 7.65},
}

// paidPlans reports whether the plan catalog is live (PAID_PLANS=true): Free allowances
// apply, and Plus and Pro are listed and sold once Stripe is configured. Until then, during
// testing, every member gets unlimitedFree, bounded only by the daily AI budgets, and
// Stripe is unused even if its keys are set.
func paidPlans() bool { return os.Getenv("PAID_PLANS") == "true" }

var unlimitedFree = Plan{ID: "free", Assistant: math.MaxInt32, VoiceMinutes: math.MaxInt32, Images: math.MaxInt32, Videos: math.MaxInt32, Narration: math.MaxInt32, SpendCap: math.Inf(1)}

// Conservative per-charge fees: Stripe cards 2.9% + $0.30, Billing 0.7% and Tax 0.5%, with
// room for Managed Payments (+3.5%), international cards and conversion, and ~1% refunds
// and disputes (stripe.com/pricing, October 2026).
const feeRate, feeFixed = 0.11, 0.30

// netMonthly is what one member pays us per month after fees.
func (p Plan) netMonthly(interval string) float64 {
	if interval == "yearly" {
		return (p.YearlyUSD*(1-feeRate) - feeFixed) / 12
	}
	return p.MonthlyUSD*(1-feeRate) - feeFixed
}

// freeShare of paying members' revenue funds free use, so free growth is paid for.
const freeShare = 0.15

// memberBudgets turns today's paying members into daily headroom: a share of their net
// revenue for free use, and their plans' spend ceilings for the hard daily circuit breaker.
// Complimentary plans (no billing interval) bring no revenue, so they add none; their use
// comes out of the base budgets.
func memberBudgets(ctx context.Context, tx pgx.Tx) (free, paid float64, e error) {
	rows, e := tx.Query(ctx, `SELECT plan,plan_interval,count(*) FROM users u WHERE `+effectivePlanSQL+`<>'free' AND u.plan_interval<>'' GROUP BY 1,2`)
	if e != nil {
		return 0, 0, e
	}
	defer rows.Close()
	for rows.Next() {
		var plan, interval string
		var n float64
		if e = rows.Scan(&plan, &interval, &n); e != nil {
			return 0, 0, e
		}
		p := planByID(plan)
		free += n * p.netMonthly(interval) * freeShare / 30
		paid += n * p.SpendCap / 30
	}
	return free, paid, rows.Err()
}

func planByID(id string) Plan {
	for _, p := range plans {
		if p.ID == id {
			return p
		}
	}
	return plans[0]
}

// effectivePlanSQL is the plan a users row (aliased u) currently grants. Stripe keeps
// retrying a past-due renewal for a while, so members keep access meanwhile.
const effectivePlanSQL = `CASE WHEN u.plan_status IN ('active','trialing','past_due') THEN u.plan ELSE 'free' END`

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func planOf(ctx context.Context, q querier, owner string) (Plan, error) {
	if !paidPlans() {
		return unlimitedFree, nil
	}
	var id string
	e := q.QueryRow(ctx, `SELECT `+effectivePlanSQL+` FROM users u WHERE u.id=$1`, owner).Scan(&id)
	return planByID(id), e
}

type usage struct {
	Assistant    int     `json:"assistant"`
	VoiceSeconds int     `json:"voiceSeconds"`
	Images       int     `json:"images"`
	Videos       int     `json:"videos"`
	Narration    int     `json:"narration"`
	Spend        float64 `json:"-"`
}

// usageOf counts the last 30 days. Jobs that never reserved a cost (refused up front), and
// sous-chef turns that failed before reaching the model, don't count; provider failures do,
// since they may still be billed.
func usageOf(ctx context.Context, q querier, owner string) (usage, error) {
	var u usage
	e := q.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM voice_actions a JOIN voice_projects p ON p.id=a.project_id WHERE p.user_id=$1 AND a.estimated_cost>0 AND a.created_at>now()-interval '30 days')
  +(SELECT count(*) FROM ai_jobs WHERE user_id=$1 AND kind NOT IN ('image','video') AND estimated_cost>0 AND created_at>now()-interval '30 days'),
 (SELECT COALESCE(sum(CASE WHEN finalized THEN seconds ELSE reserved_seconds END),0)::int FROM voice_sessions WHERE user_id=$1 AND reserved_seconds>0 AND created_at>now()-interval '30 days'),
 (SELECT count(*) FROM ai_jobs WHERE user_id=$1 AND kind='image' AND estimated_cost>0 AND created_at>now()-interval '30 days'),
 (SELECT count(*) FROM ai_jobs WHERE user_id=$1 AND kind='video' AND estimated_cost>0 AND created_at>now()-interval '30 days'),
 (SELECT count(*) FROM narration_usage WHERE user_id=$1 AND created_at>now()-interval '30 days'),
 (SELECT COALESCE(sum(cost),0) FROM ai_spend WHERE user_id=$1 AND created_at>now()-interval '30 days')`, owner).
		Scan(&u.Assistant, &u.VoiceSeconds, &u.Images, &u.Videos, &u.Narration, &u.Spend)
	return u, e
}

// allowance refuses one more unit of kind ("assistant", "image", "video", "narration")
// when the plan's 30-day allowance is used. The message stays neutral: whether the app
// may offer an upgrade depends on the storefront, which only the client knows.
func allowance(ctx context.Context, q querier, owner, kind string) error {
	if !paidPlans() {
		return nil
	}
	p, e := planOf(ctx, q, owner)
	if e != nil {
		return e
	}
	u, e := usageOf(ctx, q, owner)
	if e != nil {
		return e
	}
	used, limit := 0, 0
	switch kind {
	case "image":
		used, limit = u.Images, p.Images
	case "video":
		used, limit = u.Videos, p.Videos
	case "narration":
		used, limit = u.Narration, p.Narration
	default:
		kind = "assistant"
		used, limit = u.Assistant, p.Assistant
	}
	if used >= limit {
		refusal := allowanceRefusals[kind]
		if limit == 0 {
			return fiber.NewError(429, refusal.excluded)
		}
		return fiber.NewError(429, refusal.usedUp)
	}
	return nil
}

// Whole sentences, so the app can translate each one.
// l10n: shown to members
var allowanceRefusals = map[string]struct{ excluded, usedUp string }{
	"image":     {"Your plan doesn't include AI photo generation.", "You've used your plan's AI photos for the last 30 days."},
	"video":     {"Your plan doesn't include AI video generation.", "You've used your plan's AI videos for the last 30 days."},
	"narration": {"Your plan doesn't include natural-voice read-alouds.", "You've used your plan's natural-voice read-alouds for the last 30 days."},
	"assistant": {"Your plan doesn't include the sous-chef.", "You've used your plan's sous-chef messages for the last 30 days."},
}

func envFloat(key string, fallback float64) float64 {
	v, e := strconv.ParseFloat(Env(key, ""), 64)
	if e != nil {
		return fallback
	}
	return v
}
