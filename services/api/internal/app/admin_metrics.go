package app

import (
	"context"
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// The admin console's Cooking section (docs/ADMIN.md): how we'll know the cooking flywheel works,
// and the creator fund's weekly report, computed when the console asks from what's already
// recorded. Members exclude the sample cooks SEED_DATA creates, as on the Overview.

// payingSQL is a users row (alias u) whose plan brings revenue now: the members the fund takes a
// share from (planNetCents).
const payingSQL = `(u.plan<>'free' AND u.plan_status='active' AND u.plan_interval<>'')`

// adminCooking answers the Cooking panel:
//   - cooksPerActive: verified cooks in 30 days, and members active in them (a session used or
//     an event recorded, events.go);
//   - finishRate: cooking-mode sessions started in the 30 days before the last one, and how many
//     were finished at the last step (a session lasts at most a day, so all of these are over;
//     the janitor keeps unfinished ones 35 days for this);
//   - payingCooked: paying members, and those with a verified cook this UTC month;
//   - creatorsOver25: creators who earned more than $25 in the last closed month;
//   - retention: members who first started paying 90 to 120 days ago, and those still paying 90
//     days after they started (paid_spans, 038);
//   - aiCost: paying members' AI spend in 30 days with their household members' who use their
//     plan, by plan, against the plan's SpendCap;
//   - cookTested: published recipes that are cook-tested (cook_insights.go), and those with a
//     verified cook or more but not yet 5;
//   - fixes: cooks' suggestions in 90 days and how many their authors accepted (recipe_fixes.go),
//     withdrawn ones left out.
func (a *App) adminCooking(c fiber.Ctx) error {
	ctx := c.Context()
	tx, e := a.DB.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	month := monthStart(time.Now())
	var b []byte
	e = tx.QueryRow(ctx, `SELECT jsonb_build_object(
 'cooksPerActive',jsonb_build_object(
   'cooks',(SELECT count(*) FROM cook_sessions WHERE verified AND finished_at>now()-interval '30 days'),
   'active',(SELECT count(*) FROM (SELECT user_id FROM sessions WHERE last_used_at>now()-interval '30 days'
     UNION SELECT user_id FROM events WHERE created_at>now()-interval '30 days' AND user_id IS NOT NULL) x
     JOIN users u ON u.id=x.user_id AND u.password_hash<>'!disabled')),
 'finishRate',(SELECT jsonb_build_object('started',count(*),'finished',count(*) FILTER (WHERE finished_at IS NOT NULL AND step_reached>=steps)) FROM cook_sessions
   WHERE started_at>=now()-interval '31 days' AND started_at<now()-interval '1 day'),
 'payingCooked',(SELECT jsonb_build_object('month',to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD'),'paying',count(*),
   'cooked',count(*) FILTER (WHERE EXISTS(SELECT 1 FROM cook_sessions k WHERE k.user_id=u.id AND k.verified AND k.finished_at>=$1::timestamptz)))
   FROM users u WHERE `+payingSQL+` AND u.password_hash<>'!disabled'),
 'creatorsOver25',(SELECT jsonb_build_object('month',m.month,'creators',(SELECT count(*) FROM creator_earnings e WHERE e.month=m.month AND e.amount_cents>2500))
   FROM (SELECT max(month) AS month FROM creator_fund_months) m),
 'retention',(WITH firsts AS (SELECT user_id,min(started_at) AS started FROM paid_spans GROUP BY user_id HAVING bool_and(started_at IS NOT NULL))
   SELECT jsonb_build_object('cohort',count(*),'retained',count(*) FILTER (WHERE EXISTS(SELECT 1 FROM paid_spans p WHERE p.user_id=f.user_id
     AND p.started_at<=f.started+interval '90 days' AND (p.ended_at IS NULL OR p.ended_at>f.started+interval '90 days'))),
     'recordedSince',(SELECT min(started_at) FROM paid_spans))
   FROM firsts f WHERE f.started>=now()-interval '120 days' AND f.started<now()-interval '90 days'),
 'cookTested',(SELECT jsonb_build_object('recipes',count(*) FILTER (WHERE t.cooks>=$2),'early',count(*) FILTER (WHERE t.cooks BETWEEN 1 AND $2-1))
   FROM recipe_cook_times t JOIN recipes r ON r.id=t.recipe_id AND r.published),
 'fixes',(SELECT jsonb_build_object('suggested',count(*),'accepted',count(*) FILTER (WHERE status='accepted'))
   FROM recipe_suggestions WHERE created_at>now()-interval '90 days' AND status<>'withdrawn'))`, month, cookTestedCooks).Scan(&b)
	if e != nil {
		return e
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil {
		return e
	}
	if out["aiCost"], e = aiCostOfPaying(ctx, tx); e != nil {
		return e
	}
	return c.JSON(out)
}

// aiCostOfPaying is paying members' AI spend in the last 30 days, counting the household members
// who use their plan (members without a paid plan of their own), and that spend as a share of
// their plans' SpendCap, averaged over the members. A household with two payers counts its other
// members' use for each, which overstates it a little.
func aiCostOfPaying(ctx context.Context, tx pgx.Tx) (fiber.Map, error) {
	rows, e := tx.Query(ctx, `WITH paying AS (SELECT u.id,u.plan FROM users u WHERE `+payingSQL+` AND u.password_hash<>'!disabled'),
 covered AS (SELECT p.id AS payer,p.id AS member FROM paying p
  UNION SELECT p.id,o.user_id FROM paying p JOIN household_members me ON me.user_id=p.id
   JOIN household_members o ON o.household_id=me.household_id AND o.user_id<>p.id JOIN users u ON u.id=o.user_id WHERE `+effectivePlanSQL+`='free'),
 spent AS (SELECT user_id,sum(cost) AS cost FROM ai_spend WHERE created_at>now()-interval '30 days' AND user_id IN (SELECT member FROM covered) GROUP BY user_id)
 SELECT p.plan,count(*)::int,COALESCE(sum(x.cost),0)::float8 FROM paying p
 LEFT JOIN (SELECT c.payer,sum(s.cost) AS cost FROM covered c JOIN spent s ON s.user_id=c.member GROUP BY c.payer) x ON x.payer=p.id GROUP BY p.plan ORDER BY p.plan`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	members, spend, share := 0, 0.0, 0.0
	for rows.Next() {
		var plan string
		var n int
		var cost float64
		if e = rows.Scan(&plan, &n, &cost); e != nil {
			return nil, e
		}
		members, spend = members+n, spend+cost
		if limit := planByID(plan).SpendCap; limit > 0 {
			share += cost / limit
		}
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	out := fiber.Map{"members": members, "spend": spend, "perMember": nil, "shareOfCap": nil}
	if members > 0 {
		out["perMember"], out["shareOfCap"] = spend/float64(members), share/float64(members)
	}
	return out, nil
}

// adminFundWeeks answers the weekly report (fundWeekReport), computed when the console asks.
func (a *App) adminFundWeeks(c fiber.Ctx) error {
	ctx := c.Context()
	current := cookAlongWeek(time.Now())
	share := fundShareBP()
	weeks, e := fundWeekReport(ctx, a.DB, current, share)
	if e != nil {
		return e
	}
	ids := []string{}
	for _, w := range weeks {
		for _, t := range w.top {
			ids = append(ids, t.creator)
		}
		for _, f := range w.creators {
			ids = append(ids, f.creator)
		}
	}
	who, e := namesOf(ctx, a.DB, ids)
	if e != nil {
		return e
	}
	out := []fiber.Map{}
	for _, w := range weeks {
		tops, flagged := []fiber.Map{}, []fiber.Map{}
		for _, t := range w.top {
			tops = append(tops, fiber.Map{"id": t.creator, "name": who[t.creator].name, "email": who[t.creator].email, "cooks": t.cooks})
		}
		for _, f := range w.creators {
			flagged = append(flagged, fiber.Map{"id": f.creator, "name": who[f.creator].name, "email": who[f.creator].email})
		}
		out = append(out, fiber.Map{"week": w.start.Format(time.DateOnly), "current": w.start.Equal(current), "cooks": w.cooks, "payingMembers": w.paying,
			"poolCents": w.pool, "top": tops, "flaggedMembers": len(w.members), "flaggedCreators": flagged})
	}
	return c.JSON(fiber.Map{"weeks": out, "threshold": paidCooksThreshold, "sharePercent": float64(share) / 100})
}
