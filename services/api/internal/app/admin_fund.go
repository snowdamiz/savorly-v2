package app

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// The creator fund in the admin console (creator_fund.go): the monthly summary, a member's
// earnings and payouts, and holding a creator's payouts, which is audited like every other
// console change.

// adminFund is the fund at a glance: this month so far by the same rule that closes it, the
// leading creators, every closed month with what's been paid of it, payouts and accounts.
func (a *App) adminFund(c fiber.Ctx) error {
	ctx := c.Context()
	from := monthStart(time.Now())
	rows, e := fundCooks(ctx, a.DB, from, from.AddDate(0, 1, 0), "")
	if e != nil {
		return e
	}
	shares, pool, members, cooks := splitFund(rows, fundShareBP())
	ids := make([]string, 0, len(shares))
	for id := range shares {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(x, y string) int {
		if shares[x].cents != shares[y].cents {
			return shares[y].cents - shares[x].cents
		}
		return strings.Compare(x, y)
	})
	ids = ids[:min(len(ids), 10)]
	leaders := []fiber.Map{}
	if len(ids) > 0 {
		names, e := a.DB.Query(ctx, `SELECT id,name,email FROM users WHERE id=ANY($1)`, ids)
		if e != nil {
			return e
		}
		who := map[string][2]string{}
		for names.Next() {
			var id, name, email string
			if e = names.Scan(&id, &name, &email); e != nil {
				names.Close()
				return e
			}
			who[id] = [2]string{name, email}
		}
		names.Close()
		if e = names.Err(); e != nil {
			return e
		}
		for _, id := range ids {
			leaders = append(leaders, fiber.Map{"id": id, "name": who[id][0], "email": who[id][1], "estimateCents": shares[id].cents, "cooks": shares[id].cooks})
		}
	}
	var b []byte
	e = a.DB.QueryRow(ctx, `SELECT jsonb_build_object(
 'months',COALESCE((SELECT jsonb_agg(jsonb_build_object('month',m.month,'computedAt',m.computed_at,'sharePercent',m.share_bp/100.0,
   'poolCents',m.pool_cents,'members',m.members,'cooks',m.cooks,'creators',m.creators,
   'paidCents',(SELECT COALESCE(sum(amount_cents),0) FROM creator_earnings e WHERE e.month=m.month AND e.status='paid')) ORDER BY m.month DESC)
   FROM (SELECT * FROM creator_fund_months ORDER BY month DESC LIMIT 24) m),'[]'),
 'unpaidCents',(SELECT COALESCE(sum(amount_cents),0) FROM creator_earnings WHERE status='pending'),
 'paidCents',(SELECT COALESCE(sum(amount_cents),0) FROM creator_earnings WHERE status='paid'),
 'payouts',(SELECT jsonb_build_object('sending',count(*) FILTER (WHERE status='sending'),
   'failed7d',count(*) FILTER (WHERE status='failed' AND created_at>now()-interval '7 days'),
   'paid30dCents',COALESCE(sum(amount_cents) FILTER (WHERE status='paid' AND updated_at>now()-interval '30 days'),0)) FROM creator_payouts),
 'accounts',(SELECT jsonb_build_object('connected',count(*) FILTER (WHERE stripe_account_id IS NOT NULL),
   'enabled',count(*) FILTER (WHERE payouts_enabled),'held',count(*) FILTER (WHERE held_at IS NOT NULL)) FROM creator_accounts))`).Scan(&b)
	if e != nil {
		return e
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil {
		return e
	}
	out["enabled"] = creatorFundEnabled()
	out["sharePercent"] = float64(fundShareBP()) / 100
	out["minimumCents"] = payoutMinimumCents
	out["current"] = fiber.Map{"month": from.Format(time.DateOnly), "poolCents": pool, "members": members, "cooks": cooks, "creators": len(shares), "leaders": leaders}
	return c.JSON(out)
}

// adminMemberEarnings is one member's side of the fund: their payout account (with its Stripe
// id, for finding it in the dashboard), any hold, this month's cooks both ways and estimate,
// earnings by month and payouts.
func (a *App) adminMemberEarnings(c fiber.Ctx) error {
	ctx, id := c.Context(), c.Params("id")
	from := monthStart(time.Now())
	to := from.AddDate(0, 1, 0)
	rows, e := fundCooks(ctx, a.DB, from, to, id)
	if e != nil {
		return e
	}
	shares, _, _, _ := splitFund(rows, fundShareBP())
	estimate := 0
	if s := shares[id]; s != nil {
		estimate = s.cents
	}
	b, e := a.jsonRow(ctx, `SELECT jsonb_build_object(
 'account',(SELECT jsonb_build_object('stripeAccountId',a.stripe_account_id,'country',a.country,'payoutsEnabled',a.payouts_enabled,
   'detailsSubmitted',a.details_submitted,'connectedAt',a.created_at,'heldAt',a.held_at,'heldReason',a.held_reason,
   'heldBy',(SELECT email FROM users WHERE id=a.held_by)) FROM creator_accounts a WHERE a.user_id=u.id),
 'cooks',(SELECT count(*) FROM cook_sessions k JOIN recipes r ON r.id=k.recipe_id WHERE r.author_id=u.id AND k.verified AND k.user_id<>u.id AND k.finished_at>=$2 AND k.finished_at<$3),
 'cooked',(SELECT count(*) FROM cook_sessions k WHERE k.user_id=u.id AND k.verified AND k.finished_at>=$2 AND k.finished_at<$3),
 'balanceCents',(SELECT COALESCE(sum(amount_cents),0) FROM creator_earnings WHERE creator_id=u.id AND status='pending'),
 'paidCents',(SELECT COALESCE(sum(amount_cents),0) FROM creator_earnings WHERE creator_id=u.id AND status='paid'),
 'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('month',e.month,'amountCents',e.amount_cents,'cooks',e.cooks,'status',e.status,'paidAt',e.paid_at,'payoutId',e.payout_id) ORDER BY e.month DESC)
   FROM (SELECT * FROM creator_earnings WHERE creator_id=u.id ORDER BY month DESC LIMIT 24) e),'[]'),
 'payouts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'amountCents',p.amount_cents,'status',p.status,'transferId',p.transfer_id,'error',p.error,'createdAt',p.created_at) ORDER BY p.created_at DESC)
   FROM (SELECT * FROM creator_payouts WHERE creator_id=u.id ORDER BY created_at DESC LIMIT 20) p),'[]'))
 FROM users u WHERE u.id=$1`, id, from, to)
	if e != nil {
		return e
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil {
		return e
	}
	out["month"] = from.Format(time.DateOnly)
	out["estimateCents"] = estimate
	return c.JSON(out)
}

// adminHoldPayouts holds a creator's payouts ({ "held": true, "reason" }) or releases them. Held
// earnings keep accruing; only the transfers wait. The rank rule applies as for suspensions.
func (a *App) adminHoldPayouts(c fiber.Ctx) error {
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	var in struct {
		Held   bool
		Reason string
	}
	if e = decode(c, &in); e != nil {
		return e
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Held && !validText(in.Reason, 3, 500) {
		return fiber.NewError(400, "Note why (3–500 characters). Only admins see it.")
	}
	ctx := c.Context()
	e = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if in.Held {
			return holdPayouts(ctx, tx, c, m, in.Reason)
		}
		var reason string
		e := tx.QueryRow(ctx, `UPDATE creator_accounts n SET held_at=NULL,held_reason='',held_by=NULL,updated_at=now() FROM creator_accounts o
 WHERE n.user_id=$1 AND o.user_id=n.user_id AND n.held_at IS NOT NULL RETURNING o.held_reason`, m.ID).Scan(&reason)
		if errors.Is(e, pgx.ErrNoRows) {
			return fiber.NewError(409, "This member's payouts aren't on hold.")
		}
		if e != nil {
			return e
		}
		return audit(ctx, tx, c, "member.payouts_release", "user", m.ID, "Released "+m.Email+"'s creator payouts", fiber.Map{"previousReason": reason})
	})
	if e != nil {
		return e
	}
	return a.adminMemberEarnings(c)
}

func holdPayouts(ctx context.Context, tx pgx.Tx, c fiber.Ctx, m managed, reason string) error {
	tag, e := tx.Exec(ctx, `INSERT INTO creator_accounts(user_id,held_at,held_reason,held_by) VALUES($1,now(),$2,$3)
 ON CONFLICT (user_id) DO UPDATE SET held_at=now(),held_reason=$2,held_by=$3,updated_at=now() WHERE creator_accounts.held_at IS NULL`, m.ID, reason, userID(c))
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return fiber.NewError(409, "This member's payouts are already on hold.")
	}
	return audit(ctx, tx, c, "member.payouts_hold", "user", m.ID, "Held "+m.Email+"'s creator payouts", fiber.Map{"reason": reason})
}
