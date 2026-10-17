package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
)

// Plans are sold on the web through Stripe Checkout, never through an app store's billing.
// The web app links to checkout; iOS does so only on the US storefront and Android not at
// all (docs/PRICING.md). Every platform unlocks whatever plan the account holds.

var stripeBase = "https://api.stripe.com/v1"
var stripeHTTP = &http.Client{Timeout: 20 * time.Second}

func billingEnabled() bool {
	return paidPlans() && os.Getenv("STRIPE_SECRET_KEY") != "" && os.Getenv("STRIPE_WEBHOOK_SECRET") != ""
}
func priceID(plan, interval string) string {
	return os.Getenv("STRIPE_PRICE_" + strings.ToUpper(plan) + "_" + strings.ToUpper(interval))
}
func planForPrice(price string) (string, string) {
	for _, p := range plans[1:] {
		for _, interval := range []string{"monthly", "yearly"} {
			if id := priceID(p.ID, interval); id != "" && id == price {
				return p.ID, interval
			}
		}
	}
	return "", ""
}

func stripeCall(ctx context.Context, method, path, idempotency string, form url.Values, out any) error {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, e := http.NewRequestWithContext(ctx, method, stripeBase+path, body)
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("STRIPE_SECRET_KEY"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	res, e := stripeHTTP.Do(req)
	if e != nil {
		slog.Warn("stripe request", "path", path, "error", e)
		return fiber.NewError(502, "Billing is unavailable right now. Please try again.")
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		slog.Warn("stripe request", "path", path, "status", res.StatusCode)
		return fiber.NewError(502, "Billing is unavailable right now. Please try again.")
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(b, out)
}

func appURL(c Config) string { return strings.TrimRight(Env("APP_URL", c.Origins[0]), "/") }

func (a *App) billing(c fiber.Ctx) error {
	// Prices stay private until the catalog is live.
	if !paidPlans() {
		return fiber.NewError(404, "Plans aren't available yet.")
	}
	owner := userID(c)
	var plan, status, interval string
	var renews *time.Time
	var cancels, customer bool
	e := a.DB.QueryRow(c.Context(), `SELECT `+effectivePlanSQL+`,plan_status,plan_interval,plan_renews_at,plan_cancels,stripe_customer_id IS NOT NULL FROM users u WHERE id=$1`, owner).Scan(&plan, &status, &interval, &renews, &cancels, &customer)
	if e != nil {
		return e
	}
	used, e := usageOf(c.Context(), a.DB, owner)
	if e != nil {
		return e
	}
	return c.JSON(fiber.Map{"plan": plan, "status": status, "interval": interval, "renewsAt": renews, "cancels": cancels, "usage": used, "plans": plans, "checkout": billingEnabled(), "manage": customer && billingEnabled()})
}

func (a *App) checkout(c fiber.Ctx) error {
	if !billingEnabled() {
		return fiber.NewError(503, "Plans aren't on sale yet.")
	}
	var in struct{ Plan, Interval string }
	if e := decode(c, &in); e != nil {
		return e
	}
	price := priceID(in.Plan, in.Interval)
	if in.Plan == "free" || price == "" {
		return fiber.NewError(400, "Choose a plan and billing period.")
	}
	ctx, owner := c.Context(), userID(c)
	var email, current string
	var customer *string
	if e := a.DB.QueryRow(ctx, `SELECT email,stripe_customer_id,`+effectivePlanSQL+` FROM users u WHERE id=$1`, owner).Scan(&email, &customer, &current); e != nil {
		return e
	}
	if current != "free" {
		return fiber.NewError(409, "You already have a plan. Change or cancel it from Manage plan.")
	}
	if customer == nil {
		var out struct{ ID string }
		if e := stripeCall(ctx, "POST", "/customers", "customer-"+owner, url.Values{"email": {email}, "metadata[user_id]": {owner}}, &out); e != nil {
			return e
		}
		if e := a.DB.QueryRow(ctx, `UPDATE users SET stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE id=$1 RETURNING stripe_customer_id`, owner, out.ID).Scan(&customer); e != nil {
			return e
		}
	}
	form := url.Values{
		"mode": {"subscription"}, "customer": {*customer}, "client_reference_id": {owner},
		"line_items[0][price]": {price}, "line_items[0][quantity]": {"1"},
		"subscription_data[metadata][user_id]": {owner}, "allow_promotion_codes": {"true"},
		"success_url": {appURL(a.Config) + "/?page=profile&plan=welcome"}, "cancel_url": {appURL(a.Config) + "/?page=profile"},
	}
	if os.Getenv("STRIPE_AUTOMATIC_TAX") == "true" {
		form.Set("automatic_tax[enabled]", "true")
		form.Set("customer_update[address]", "auto")
	}
	var session struct{ URL string }
	if e := stripeCall(ctx, "POST", "/checkout/sessions", "", form, &session); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"url": session.URL})
}

func (a *App) billingPortal(c fiber.Ctx) error {
	var customer *string
	if e := a.DB.QueryRow(c.Context(), `SELECT stripe_customer_id FROM users WHERE id=$1`, userID(c)).Scan(&customer); e != nil {
		return e
	}
	if customer == nil || !billingEnabled() {
		return fiber.NewError(404, "There's no subscription to manage yet.")
	}
	var session struct{ URL string }
	if e := stripeCall(c.Context(), "POST", "/billing_portal/sessions", "", url.Values{"customer": {*customer}, "return_url": {appURL(a.Config) + "/?page=profile"}}, &session); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"url": session.URL})
}

// stripeWebhook trusts only the event's signature and id: each subscription is re-read from
// Stripe, so retries and out-of-order deliveries all converge on Stripe's current state.
func (a *App) stripeWebhook(c fiber.Ctx) error {
	if !billingEnabled() {
		return fiber.NewError(404, "Billing isn't enabled.")
	}
	secret := os.Getenv("STRIPE_WEBHOOK_SECRET")
	if !validStripeSignature(c.Body(), c.Get("Stripe-Signature"), secret, time.Now()) {
		return fiber.NewError(400, "Invalid signature.")
	}
	var ev struct {
		Type string
		Data struct {
			Object struct {
				ID, Customer, Subscription string
				ClientReferenceID          string `json:"client_reference_id"`
			}
		}
	}
	if e := json.Unmarshal(c.Body(), &ev); e != nil {
		return fiber.NewError(400, "Invalid event.")
	}
	ctx, o := c.Context(), ev.Data.Object
	switch ev.Type {
	case "checkout.session.completed":
		if o.ClientReferenceID != "" && o.Customer != "" {
			if _, e := a.DB.Exec(ctx, `UPDATE users SET stripe_customer_id=$2 WHERE id=$1 AND stripe_customer_id IS NULL`, o.ClientReferenceID, o.Customer); e != nil {
				return e
			}
		}
		if o.Subscription != "" {
			return a.syncSubscription(ctx, o.Subscription)
		}
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed":
		return a.syncSubscription(ctx, o.ID)
	}
	return c.SendStatus(200)
}

func (a *App) syncSubscription(ctx context.Context, id string) error {
	var s struct {
		ID, Customer, Status string
		CancelAtPeriodEnd    bool  `json:"cancel_at_period_end"`
		CurrentPeriodEnd     int64 `json:"current_period_end"`
		Items                struct {
			Data []struct {
				CurrentPeriodEnd int64 `json:"current_period_end"`
				Price            struct{ ID string }
			}
		}
	}
	if e := stripeCall(ctx, "GET", "/subscriptions/"+url.PathEscape(id), "", nil, &s); e != nil {
		return e
	}
	plan, interval, end := "", "", s.CurrentPeriodEnd
	if len(s.Items.Data) > 0 {
		plan, interval = planForPrice(s.Items.Data[0].Price.ID)
		// Newer API versions report the period on the item instead of the subscription.
		if s.Items.Data[0].CurrentPeriodEnd > 0 {
			end = s.Items.Data[0].CurrentPeriodEnd
		}
	}
	if plan == "" {
		slog.Warn("subscription has an unknown price", "subscription", s.ID)
		plan = "free"
	}
	live := s.Status == "active" || s.Status == "trialing" || s.Status == "past_due"
	// A live subscription replaces whatever was recorded, a complimentary plan included. Any
	// other event applies only to the subscription on record, never to a member with none (a
	// comp forgets the ended subscription it replaces) or to a comp: a late or redelivered event
	// about an older subscription changes nothing.
	_, e := a.DB.Exec(ctx, `UPDATE users SET plan=$3,plan_status=$4,plan_interval=$5,plan_renews_at=to_timestamp(NULLIF($6,0)),plan_cancels=$7,stripe_subscription_id=$2
 WHERE stripe_customer_id=$1 AND ($8 OR (stripe_subscription_id=$2 AND NOT (plan<>'free' AND plan_status='active' AND plan_interval='')))`, s.Customer, s.ID, plan, s.Status, interval, end, s.CancelAtPeriodEnd, live)
	return e
}

// cancelSubscription ends a deleted account's subscription at once, so nobody keeps paying
// for an account that's gone. Deletion stops if Stripe can't confirm.
func (a *App) cancelSubscription(ctx context.Context, owner string) error {
	var sub, status string
	if e := a.DB.QueryRow(ctx, `SELECT stripe_subscription_id,plan_status FROM users WHERE id=$1`, owner).Scan(&sub, &status); e != nil {
		return e
	}
	if changeSubscription("cancel", sub, status) == nil {
		return nil
	}
	if os.Getenv("STRIPE_SECRET_KEY") == "" {
		return fiber.NewError(503, "Your subscription couldn't be cancelled right now, so your account wasn't deleted. Please try again later.")
	}
	return stripeCall(ctx, "DELETE", "/subscriptions/"+url.PathEscape(sub), "", nil, nil)
}

// subscriptionChange is what an admin's change to a member leaves to do in Stripe: cancel a
// deleted account's subscription, or pause collecting payment while the member is suspended
// and resume it after. Stripe can't share the database transaction, so the change runs once
// the admin's change has committed, best effort, and its audit entry records the outcome (see
// followUp in admin_members.go).
type subscriptionChange struct{ op, sub string }

// changeSubscription returns what op ("cancel", "pause" or "resume") changes in a member's
// subscription, or nil when Stripe has nothing to change: there's no subscription, or it no
// longer bills.
func changeSubscription(op, sub, status string) *subscriptionChange {
	billing := status == "active" || status == "trialing" || status == "past_due"
	ended := status == "canceled" || status == "incomplete_expired"
	if sub == "" || (op == "cancel" && ended) || (op != "cancel" && !billing) {
		return nil
	}
	return &subscriptionChange{op, sub}
}

var subscriptionDone = map[string]string{"cancel": "cancelled", "pause": "paused", "resume": "resumed"}
var subscriptionTodo = map[string]string{"cancel": "Cancel", "pause": "Pause collection for", "resume": "Resume collection for"}

// pending is the audit detail until Stripe answers, saying what to check if it never does.
func (s *subscriptionChange) pending() fiber.Map {
	return fiber.Map{"subscription": s.sub, "billing": "pending", "followUp": "Check in the Stripe dashboard that subscription " + s.sub + " was " + subscriptionDone[s.op] + "."}
}

// apply asks Stripe for the change and returns the outcome for the audit entry, with what to
// finish in the Stripe dashboard if it didn't happen.
func (s *subscriptionChange) apply(ctx context.Context) fiber.Map {
	todo := subscriptionTodo[s.op] + " subscription " + s.sub + " in the Stripe dashboard"
	if os.Getenv("STRIPE_SECRET_KEY") == "" {
		return fiber.Map{"billing": "skipped", "followUp": todo + ": Stripe isn't configured on this server."}
	}
	var e error
	if s.op == "cancel" {
		e = stripeCall(ctx, "DELETE", "/subscriptions/"+url.PathEscape(s.sub), "", nil, nil)
	} else {
		// Invoices that fall due while collection is paused are voided; the plan is untouched.
		form := url.Values{"pause_collection": {""}}
		if s.op == "pause" {
			form = url.Values{"pause_collection[behavior]": {"void"}}
		}
		e = stripeCall(ctx, "POST", "/subscriptions/"+url.PathEscape(s.sub), "", form, nil)
	}
	if e != nil {
		slog.Warn("admin change in Stripe", "change", s.op, "subscription", s.sub, "error", e)
		return fiber.Map{"billing": "failed", "followUp": todo + ": Stripe didn't confirm it."}
	}
	return fiber.Map{"billing": subscriptionDone[s.op]}
}

// validStripeSignature checks Stripe's v1 scheme: HMAC-SHA256 of "timestamp.payload",
// within five minutes, against any listed signature (stripe.com/docs/webhooks/signatures).
func validStripeSignature(payload []byte, header, secret string, now time.Time) bool {
	var stamp string
	var signatures []string
	for _, part := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch k {
		case "t":
			stamp = v
		case "v1":
			signatures = append(signatures, v)
		}
	}
	t, e := strconv.ParseInt(stamp, 10, 64)
	if e != nil || now.Sub(time.Unix(t, 0)).Abs() > 5*time.Minute {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(stamp + "."))
	mac.Write(payload)
	want := hex.EncodeToString(mac.Sum(nil))
	for _, s := range signatures {
		if hmac.Equal([]byte(s), []byte(want)) {
			return true
		}
	}
	return false
}
