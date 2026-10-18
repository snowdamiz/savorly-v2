package app

import (
	"context"
	"math"
	"os"
	"slices"
	"strconv"
	"time"

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
	// Questions asked hands-free in cooking mode ("Chef, …"); its commands are free.
	CookQuestions int `json:"cookQuestions"`
}

// The catalog's prices must match the Stripe prices configured for checkout. See
// docs/PRICING.md for the arithmetic; pricing_test.go fails if a change breaks it.
var plans = []Plan{
	{ID: "free", Assistant: 10, VoiceMinutes: 2, Images: 1, Videos: 0, Narration: 5, CookQuestions: 30, SpendCap: 0.50},
	{ID: "plus", MonthlyUSD: 9.99, YearlyUSD: 79.99, Assistant: 80, VoiceMinutes: 20, Images: 6, Videos: 0, Narration: 30, CookQuestions: 100, SpendCap: 3.80},
	{ID: "pro", MonthlyUSD: 19.99, YearlyUSD: 159.99, Assistant: 130, VoiceMinutes: 40, Images: 10, Videos: 1, Narration: 30, CookQuestions: 150, SpendCap: 7.69},
}

// paidPlans reports whether the plan catalog is live (PAID_PLANS=true): Free allowances
// apply, and Plus and Pro are listed and sold once Stripe is configured. Until then, during
// testing, every member gets unlimitedFree, bounded only by the daily AI budgets, and
// Stripe is unused even if its keys are set.
func paidPlans() bool { return os.Getenv("PAID_PLANS") == "true" }

var unlimitedFree = Plan{ID: "free", Assistant: math.MaxInt32, VoiceMinutes: math.MaxInt32, Images: math.MaxInt32, Videos: math.MaxInt32, Narration: math.MaxInt32, CookQuestions: math.MaxInt32, SpendCap: math.Inf(1)}

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

// A paid plan covers its member's household: members without a plan of their own use the best
// one in their household (Pro before Plus, then whoever joined first), and everyone on it shares
// its allowances and its SpendCap, so a subscription costs no more however many share it.
// memberPlanSQL is that plan for a users row (alias u), for what the app shows and budgets.
const memberPlanSQL = `CASE WHEN ` + effectivePlanSQL + `<>'free' THEN ` + effectivePlanSQL + ` ELSE COALESCE((SELECT x.plan FROM household_members me
 JOIN household_members o ON o.household_id=me.household_id AND o.user_id<>me.user_id JOIN users x ON x.id=o.user_id AND x.suspended_at IS NULL
 WHERE me.user_id=u.id AND x.plan<>'free' AND x.plan_status IN ('active','trialing','past_due') ORDER BY x.plan='pro' DESC,o.joined_at,o.user_id LIMIT 1),'free') END`

// planPool is the plan a member uses, who shares it (its allowances and SpendCap count all of
// them), and whose it is when it isn't the member's own ("" for their own, or for Free).
type planPool struct {
	Plan     Plan
	Members  []string
	SharedBy string
}

var planRank = map[string]int{"free": 0, "plus": 1, "pro": 2}

func poolOf(ctx context.Context, q querier, owner string) (planPool, error) {
	if !paidPlans() {
		return planPool{Plan: unlimitedFree, Members: []string{owner}}, nil
	}
	// The member and their household, in the order they joined, with each one's own plan.
	var ids, own []string
	e := q.QueryRow(ctx, `WITH home AS (SELECT household_id FROM household_members WHERE user_id=$1),
 kitchen AS (SELECT u.id,CASE WHEN u.suspended_at IS NULL THEN `+effectivePlanSQL+` ELSE 'free' END AS plan,COALESCE(m.joined_at,'-infinity') AS joined
  FROM users u LEFT JOIN household_members m ON m.user_id=u.id WHERE u.id=$1 OR m.household_id=(SELECT household_id FROM home))
 SELECT COALESCE(array_agg(id ORDER BY joined,id),'{}'),COALESCE(array_agg(plan ORDER BY joined,id),'{}') FROM kitchen`, owner).Scan(&ids, &own)
	if e != nil {
		return planPool{}, e
	}
	payer := ""
	for i, id := range ids {
		if own[i] != "free" && (payer == "" || planRank[own[i]] > planRank[own[slices.Index(ids, payer)]]) {
			payer = id
		}
	}
	mine := "free"
	if i := slices.Index(ids, owner); i >= 0 {
		mine = own[i]
	}
	switch {
	case mine != "free" && owner != payer:
		// A plan of their own, below the household's best: theirs alone.
		return planPool{Plan: planByID(mine), Members: []string{owner}}, nil
	case payer == "":
		return planPool{Plan: plans[0], Members: []string{owner}}, nil
	}
	pool := planPool{Plan: planByID(own[slices.Index(ids, payer)]), Members: []string{payer}}
	for i, id := range ids {
		if own[i] == "free" {
			pool.Members = append(pool.Members, id)
		}
	}
	if payer != owner {
		pool.SharedBy = payer
	}
	return pool, nil
}

func planOf(ctx context.Context, q querier, owner string) (Plan, error) {
	pool, e := poolOf(ctx, q, owner)
	return pool.Plan, e
}

type usage struct {
	Assistant    int     `json:"assistant"`
	VoiceSeconds int     `json:"voiceSeconds"`
	Images       int     `json:"images"`
	Videos       int     `json:"videos"`
	Narration    int     `json:"narration"`
	Spend        float64 `json:"-"`
	// Hands-free cooking questions: the ai_usage ledger's cook_question rows.
	CookQuestions int `json:"cookQuestions"`
}

// usageOf counts the last 30 days of everyone sharing the member's plan (poolOf). Jobs that
// never reserved a cost (refused up front), and sous-chef turns that failed before reaching the
// model, don't count; provider failures do, since they may still be billed.
func usageOf(ctx context.Context, q querier, owner string) (usage, error) {
	pool, e := poolOf(ctx, q, owner)
	if e != nil {
		return usage{}, e
	}
	return poolUsage(ctx, q, pool.Members)
}

func poolUsage(ctx context.Context, q querier, members []string) (usage, error) {
	var u usage
	e := q.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM voice_actions a JOIN voice_projects p ON p.id=a.project_id WHERE p.user_id=ANY($1) AND a.estimated_cost>0 AND a.created_at>now()-interval '30 days')
  +(SELECT count(*) FROM ai_jobs WHERE user_id=ANY($1) AND kind NOT IN ('image','video') AND estimated_cost>0 AND created_at>now()-interval '30 days'),
 (SELECT COALESCE(sum(CASE WHEN finalized THEN seconds ELSE reserved_seconds END),0)::int FROM voice_sessions WHERE user_id=ANY($1) AND reserved_seconds>0 AND created_at>now()-interval '30 days'),
 (SELECT count(*) FROM ai_jobs WHERE user_id=ANY($1) AND kind='image' AND estimated_cost>0 AND created_at>now()-interval '30 days'),
 (SELECT count(*) FROM ai_jobs WHERE user_id=ANY($1) AND kind='video' AND estimated_cost>0 AND created_at>now()-interval '30 days'),
 (SELECT count(*) FROM narration_usage WHERE user_id=ANY($1) AND created_at>now()-interval '30 days'),
 (SELECT COALESCE(sum(cost),0) FROM ai_spend WHERE user_id=ANY($1) AND created_at>now()-interval '30 days'),
 (SELECT count(*) FROM ai_usage WHERE user_id=ANY($1) AND kind='cook_question' AND created_at>now()-interval '30 days')`, members).
		Scan(&u.Assistant, &u.VoiceSeconds, &u.Images, &u.Videos, &u.Narration, &u.Spend, &u.CookQuestions)
	return u, e
}

// poolUsageFrees is when each allowance gets room back: its oldest use that poolUsage counts stops
// counting 30 days after it was made. Keys are usage's; an allowance with nothing counted is nil.
func poolUsageFrees(ctx context.Context, q querier, members []string) (map[string]*time.Time, error) {
	var assistant, voice, images, videos, narration, cookQuestions *time.Time
	e := q.QueryRow(ctx, `SELECT
 least((SELECT min(a.created_at) FROM voice_actions a JOIN voice_projects p ON p.id=a.project_id WHERE p.user_id=ANY($1) AND a.estimated_cost>0 AND a.created_at>now()-interval '30 days'),
  (SELECT min(created_at) FROM ai_jobs WHERE user_id=ANY($1) AND kind NOT IN ('image','video') AND estimated_cost>0 AND created_at>now()-interval '30 days'))+interval '30 days',
 (SELECT min(created_at) FROM voice_sessions WHERE user_id=ANY($1) AND reserved_seconds>0 AND created_at>now()-interval '30 days')+interval '30 days',
 (SELECT min(created_at) FROM ai_jobs WHERE user_id=ANY($1) AND kind='image' AND estimated_cost>0 AND created_at>now()-interval '30 days')+interval '30 days',
 (SELECT min(created_at) FROM ai_jobs WHERE user_id=ANY($1) AND kind='video' AND estimated_cost>0 AND created_at>now()-interval '30 days')+interval '30 days',
 (SELECT min(created_at) FROM narration_usage WHERE user_id=ANY($1) AND created_at>now()-interval '30 days')+interval '30 days',
 (SELECT min(created_at) FROM ai_usage WHERE user_id=ANY($1) AND kind='cook_question' AND created_at>now()-interval '30 days')+interval '30 days'`, members).
		Scan(&assistant, &voice, &images, &videos, &narration, &cookQuestions)
	return map[string]*time.Time{"assistant": assistant, "voiceSeconds": voice, "images": images, "videos": videos, "narration": narration, "cookQuestions": cookQuestions}, e
}

// allowance refuses one more unit of kind ("assistant", "image", "video", "narration", "cook_question")
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
	case "cook_question":
		used, limit = u.CookQuestions, p.CookQuestions
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
	// Hands-free questions in cooking mode (handsfree.go).
	"cook_question": {"Your plan doesn't include cooking questions.", "You've used your plan's cooking questions for the last 30 days."},
}

func envFloat(key string, fallback float64) float64 {
	v, e := strconv.ParseFloat(Env(key, ""), 64)
	if e != nil {
		return fallback
	}
	return v
}
