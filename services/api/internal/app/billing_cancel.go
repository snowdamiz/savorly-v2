package app

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Members cancel their own plan, keep one they cancelled, and get a yearly plan's payment back in
// its first 14 days, in the app rather than Stripe's portal (docs/PRICING.md#cancelling-renewals-and-refunds).
// Each change goes to Stripe first and its answer is recorded at once, so the app shows it straight
// away; the billing webhook keeps converging on Stripe's state as before.

// cancellationRoutes registers cancelling, keeping and refunding a plan.
func (a *App) cancellationRoutes(v fiber.Router) {
	v.Post("/billing/cancel", a.requireAuth, perUser(30, time.Hour), a.cancelPlan)
	v.Post("/billing/resume", a.requireAuth, perUser(30, time.Hour), a.resumePlan)
	v.Post("/billing/refund", a.requireAuth, perUser(10, time.Hour), a.refundPlan)
}

// refundDays is how long after a yearly plan starts, or renews, its payment can be refunded in
// full from the app. Monthly plans aren't refunded: cancelling keeps them to the end of the month.
const refundDays = 14

// refundUntil is the last moment a yearly period that began at start can be refunded.
func refundUntil(start time.Time) time.Time { return start.AddDate(0, 0, refundDays) }

// refundable reports whether a plan's payment can be refunded at now: a paid-up yearly plan whose
// period began at most refundDays ago.
func refundable(status, interval string, start, now time.Time) bool {
	return status == "active" && interval == "yearly" && !start.IsZero() && !start.After(now) && !now.After(refundUntil(start))
}

// ownsSubscription reports whether a member's row holds a Stripe subscription of their own that
// still bills: not a complimentary plan (no interval), and not one that has ended.
func ownsSubscription(sub, status, interval string) bool {
	return sub != "" && interval != "" && (status == "active" || status == "trialing" || status == "past_due")
}

// l10n: shown to members
const (
	notYourPlan   = "Only the member who pays for this plan can change it."
	refundPending = "Your refund is already on its way."
	noPlanToEnd   = "You don't have a plan to cancel."
	noPlanToKeep  = "You don't have a plan to keep."
	noPlanRefund  = "You don't have a plan to refund."
	noAppRefund   = "This plan can't be refunded in the app. Please contact Savorly support."
	refundedYear  = "You've had a refund in the last 12 months, so this one needs Savorly support. Please contact us."
)

// memberSubscription is the member's own subscription, or the refusal to give: the plan is someone
// else's in their household, or there is none (none says so for the change asked for).
func (a *App) memberSubscription(ctx context.Context, me, none string) (string, error) {
	if !billingEnabled() {
		return "", fiber.NewError(404, none)
	}
	var sub, status, interval string
	if e := a.DB.QueryRow(ctx, `SELECT stripe_subscription_id,plan_status,plan_interval FROM users WHERE id=$1`, me).Scan(&sub, &status, &interval); e != nil {
		return "", e
	}
	if ownsSubscription(sub, status, interval) {
		return sub, nil
	}
	pool, e := poolOf(ctx, a.DB, me)
	if e != nil {
		return "", e
	}
	if pool.SharedBy != "" {
		return "", fiber.NewError(403, notYourPlan)
	}
	return "", fiber.NewError(404, none)
}

// cancelPlan ends the member's plan when the period they paid for ends: nothing more is charged,
// and they keep the plan until then. It answers GET /billing.
func (a *App) cancelPlan(c fiber.Ctx) error {
	return a.setCancelling(c, true, noPlanToEnd)
}

// resumePlan undoes cancelPlan: the plan renews as before. It answers GET /billing.
func (a *App) resumePlan(c fiber.Ctx) error {
	return a.setCancelling(c, false, noPlanToKeep)
}

// setCancelling sets the subscription's cancel_at_period_end and records Stripe's answer. Setting
// the same value again changes nothing, so a retried request is harmless.
func (a *App) setCancelling(c fiber.Ctx, cancel bool, none string) error {
	ctx := c.Context()
	sub, e := a.memberSubscription(ctx, userID(c), none)
	if e != nil {
		return e
	}
	path := "/subscriptions/" + url.PathEscape(sub)
	var s stripeSubscription
	if e = stripeCall(ctx, "POST", path, "", url.Values{"cancel_at_period_end": {strconv.FormatBool(cancel)}}, &s); e != nil {
		return e
	}
	// A plan set to end on a date (as the portal or the dashboard may) keeps it until it's cleared.
	if !cancel && s.CancelAt > 0 {
		s = stripeSubscription{}
		if e = stripeCall(ctx, "POST", path, "", url.Values{"cancel_at": {""}}, &s); e != nil {
			return e
		}
	}
	if e = recordSubscription(ctx, a.DB, s); e != nil {
		return e
	}
	return a.billing(c)
}

// planRefund is a refund the member asked for: the year's paid invoice and its payment, which
// older API versions name on the invoice and newer ones list as the invoice's payments.
type planRefund struct {
	invoice, intent, charge string
	start                   time.Time
}

// refundPlan gives back a yearly plan's payment in full in the first refundDays of its year and
// ends the plan at once, so the member is on Free. The app makes one refund per member in 12
// months; another goes through support, so buying and refunding a year again and again can't
// stand in for a plan. Money returned pays no creator: the member's verified cooks since the year
// began, in months the fund hasn't closed, stop counting toward it. A member's refunds run one at
// a time, and one that stopped halfway (Stripe didn't answer, say) is finished by the next request
// rather than started again. It answers GET /billing.
func (a *App) refundPlan(c fiber.Ctx) error {
	ctx, me := c.Context(), userID(c)
	sub, e := a.memberSubscription(ctx, me, noPlanRefund)
	if e != nil {
		return e
	}
	conn, e := a.DB.Acquire(ctx)
	if e != nil {
		return e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,7182345))`, me).Scan(&locked); e != nil {
		return e
	}
	if !locked {
		return fiber.NewError(409, refundPending)
	}
	defer func() {
		if _, e := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtextextended($1,7182345))`, me); e != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	var r planRefund
	e = conn.QueryRow(ctx, `SELECT invoice_id,payment_intent,charge,period_start FROM plan_refunds WHERE subscription_id=$1 AND completed_at IS NULL`, sub).
		Scan(&r.invoice, &r.intent, &r.charge, &r.start)
	resumed := e == nil
	if errors.Is(e, pgx.ErrNoRows) {
		r, e = claimRefund(ctx, conn, me, sub)
	}
	if e != nil {
		return e
	}
	refund, e := returnPayment(ctx, me, r, resumed)
	if e != nil {
		return e
	}
	ended, e := endSubscription(ctx, sub)
	if e != nil {
		return e
	}
	e = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if e := recordSubscription(ctx, tx, ended); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `UPDATE plan_refunds SET refund_id=$2,amount_cents=CASE WHEN $3>0 THEN $3 ELSE amount_cents END,completed_at=now() WHERE invoice_id=$1`,
			r.invoice, refund.ID, refund.Amount); e != nil {
			return e
		}
		// The fund's lock: a month can't close halfway through.
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7182320)`); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE cook_sessions k SET net_cents=0 WHERE k.user_id=$1 AND k.verified AND k.net_cents>0 AND k.finished_at>=$2
 AND NOT EXISTS(SELECT 1 FROM creator_fund_months m WHERE m.month=date_trunc('month',k.finished_at AT TIME ZONE 'UTC')::date)`, me, r.start)
		return e
	})
	if e != nil {
		return e
	}
	return a.billing(c)
}

// claimRefund checks with Stripe that the plan can be refunded and records the refund about to be
// made, before any money moves.
func claimRefund(ctx context.Context, conn *pgxpool.Conn, me, sub string) (planRefund, error) {
	s, e := fetchSubscription(ctx, sub)
	if e != nil {
		return planRefund{}, e
	}
	_, interval := s.plan()
	start, _ := s.period()
	r := planRefund{invoice: s.LatestInvoice, start: time.Unix(start, 0).UTC()}
	switch {
	case interval == "monthly":
		return r, fiber.NewError(409, "Monthly plans aren't refunded. If you cancel, you keep your plan until the month you paid for ends.")
	case start == 0 || s.Status != "active" || interval != "yearly" || r.invoice == "":
		return r, fiber.NewError(409, noAppRefund)
	case !refundable(s.Status, interval, r.start, time.Now()):
		return r, fiber.NewError(409, "Refunds are for the first 14 days of a yearly plan, and those have passed.")
	}
	var done, recent bool
	if e = conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plan_refunds WHERE invoice_id=$1),EXISTS(SELECT 1 FROM plan_refunds WHERE user_id=$2 AND created_at>now()-interval '1 year')`,
		r.invoice, me).Scan(&done, &recent); e != nil {
		return r, e
	}
	if done {
		return r, fiber.NewError(409, "This year's payment has already been refunded.")
	}
	if recent {
		return r, fiber.NewError(409, refundedYear)
	}
	var inv stripeInvoice
	if e = stripeCall(ctx, "GET", "/invoices/"+url.PathEscape(r.invoice), "", nil, &inv); e != nil {
		return r, e
	}
	if !inv.paid() {
		return r, fiber.NewError(409, "There's no payment to refund for this year.")
	}
	r.intent, r.charge = inv.PaymentIntent, inv.Charge
	if r.intent == "" && r.charge == "" {
		if r.intent, r.charge, e = invoicePayment(ctx, r.invoice); e != nil {
			return r, e
		}
	}
	if r.intent == "" && r.charge == "" {
		return r, fiber.NewError(409, noAppRefund)
	}
	tag, e := conn.Exec(ctx, `INSERT INTO plan_refunds(invoice_id,user_id,subscription_id,period_start,payment_intent,charge,amount_cents,currency)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, r.invoice, me, sub, r.start, r.intent, r.charge, inv.AmountPaid, inv.Currency)
	if e != nil {
		return r, e
	}
	if tag.RowsAffected() == 0 {
		return r, fiber.NewError(409, refundPending)
	}
	return r, nil
}

// stripeInvoice is what the API reads of an invoice.
type stripeInvoice struct {
	ID, Status, Currency string
	AmountPaid           int64 `json:"amount_paid"`
	// Before API version 2025-03-31.basil an invoice names its payment; since then its payments are
	// listed on their own (invoicePayment). The API pins no version, so it reads both.
	PaymentIntent string `json:"payment_intent"`
	Charge        string
}

// paid reports whether the invoice was paid with money that can be given back.
func (inv stripeInvoice) paid() bool { return inv.Status == "paid" && inv.AmountPaid > 0 }

// refundOffer is the refund GET /billing offers on a member's own subscription: until when, and
// how much comes back when Stripe says, or nil for none. A yearly plan in its first refundDays is
// offered one if its payment was made and the member had no refund in the last 12 months; a refund
// under way is offered until it's finished, so the member can finish it.
func refundOffer(ctx context.Context, q querier, me, sub, status, interval string, start *time.Time) (any, error) {
	var recent bool
	var open *int64
	var currency *string
	e := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plan_refunds WHERE user_id=$1 AND created_at>now()-interval '1 year'),r.amount_cents,r.currency
 FROM (SELECT 1) x LEFT JOIN plan_refunds r ON r.subscription_id=$2 AND r.completed_at IS NULL`, me, sub).Scan(&recent, &open, &currency)
	if e != nil {
		return nil, e
	}
	if start == nil || (open == nil && (recent || !refundable(status, interval, *start, time.Now()))) {
		return nil, nil
	}
	offer := fiber.Map{"until": refundUntil(*start)}
	if open != nil {
		offer["amountCents"], offer["currency"] = *open, *currency
		return offer, nil
	}
	// The payment itself, from Stripe: what was paid after any discount, tax included. If Stripe
	// doesn't answer in time, the offer stands without its amount.
	ask, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var s struct {
		LatestInvoice stripeInvoice `json:"latest_invoice"`
	}
	if stripeCall(ask, "GET", "/subscriptions/"+url.PathEscape(sub)+"?expand[]=latest_invoice", "", nil, &s) != nil {
		return offer, nil
	}
	if !s.LatestInvoice.paid() {
		return nil, nil
	}
	offer["amountCents"], offer["currency"] = s.LatestInvoice.AmountPaid, s.LatestInvoice.Currency
	return offer, nil
}

// invoicePayment is the payment intent or charge that paid an invoice, from its payments.
func invoicePayment(ctx context.Context, invoice string) (intent, charge string, e error) {
	var list struct {
		Data []struct {
			Status  string
			Payment struct {
				PaymentIntent string `json:"payment_intent"`
				Charge        string
			}
		}
	}
	if e = stripeCall(ctx, "GET", "/invoice_payments?limit=10&invoice="+url.QueryEscape(invoice), "", nil, &list); e != nil {
		return "", "", e
	}
	for _, p := range list.Data {
		if p.Status == "paid" {
			return p.Payment.PaymentIntent, p.Payment.Charge, nil
		}
	}
	return "", "", nil
}

type stripeRefund struct {
	ID, Status string
	Amount     int64
	Metadata   map[string]string
}

// returnPayment refunds the year's payment in full. The invoice keys the request, so a retry within
// Stripe's 24 hours makes no second refund; a refund resumed later looks for the one it made first.
func returnPayment(ctx context.Context, me string, r planRefund, resumed bool) (stripeRefund, error) {
	target, id := "payment_intent", r.intent
	if id == "" {
		target, id = "charge", r.charge
	}
	var out stripeRefund
	if resumed {
		var found struct{ Data []stripeRefund }
		if e := stripeCall(ctx, "GET", "/refunds?limit=20&"+target+"="+url.QueryEscape(id), "", nil, &found); e != nil {
			return out, e
		}
		for _, x := range found.Data {
			if x.Metadata["invoice"] == r.invoice && x.Status != "failed" && x.Status != "canceled" {
				return x, nil
			}
		}
	}
	form := url.Values{target: {id}, "reason": {"requested_by_customer"}, "metadata[user_id]": {me}, "metadata[invoice]": {r.invoice}}
	e := stripeCall(ctx, "POST", "/refunds", "plan-refund-"+r.invoice, form, &out)
	return out, e
}

// endSubscription cancels a subscription at once. Its payment was refunded in full, so nothing is
// prorated. One that had already ended is read back as it is.
func endSubscription(ctx context.Context, sub string) (stripeSubscription, error) {
	var s stripeSubscription
	if e := stripeCall(ctx, "DELETE", "/subscriptions/"+url.PathEscape(sub), "", nil, &s); e == nil {
		return s, nil
	}
	s, e := fetchSubscription(ctx, sub)
	if e == nil && s.Status != "canceled" && s.Status != "incomplete_expired" {
		e = fiber.NewError(502, "Billing is unavailable right now. Please try again.")
	}
	return s, e
}
