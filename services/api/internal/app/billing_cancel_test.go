package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fakeBilling is Stripe as members' own billing changes use it: subscriptions read (with their
// latest invoice expanded, if asked), changed and cancelled, invoices and their payments (on the
// invoice, as older API versions name them, or listed, as newer ones do), refunds (made once per
// idempotency key, listed by payment) and invoice previews. fail makes the next requests to a
// "METHOD path" fail.
type fakeBilling struct {
	sync.Mutex
	requests      []string
	forms         map[string]url.Values
	keys          map[string]string
	subscriptions map[string]map[string]any
	invoices      map[string]map[string]any
	payments      map[string][]any
	refunds       []map[string]any
	fail          map[string]int
	preview       map[string]any
}

func newFakeBilling(t *testing.T) *fakeBilling {
	f := &fakeBilling{forms: map[string]url.Values{}, keys: map[string]string{}, subscriptions: map[string]map[string]any{},
		invoices: map[string]map[string]any{}, payments: map[string][]any{}, fail: map[string]int{},
		preview: map[string]any{"amount_due": 17279, "currency": "usd"}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.Lock()
		defer f.Unlock()
		_ = r.ParseForm()
		call := r.Method + " " + r.URL.Path
		f.requests = append(f.requests, call)
		f.forms[call], f.keys[call] = r.PostForm, r.Header.Get("Idempotency-Key")
		reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		if r.Header.Get("Authorization") != "Bearer sk_test" {
			w.WriteHeader(401)
			return
		}
		if f.fail[call] > 0 {
			f.fail[call]--
			w.WriteHeader(500)
			return
		}
		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		switch {
		case strings.HasPrefix(r.URL.Path, "/subscriptions/"):
			s := f.subscriptions[id]
			if s == nil {
				w.WriteHeader(404)
				return
			}
			switch r.Method {
			case "GET":
				if r.URL.Query().Get("expand[]") == "latest_invoice" {
					expanded := map[string]any{}
					for k, v := range s {
						expanded[k] = v
					}
					expanded["latest_invoice"] = f.invoices[s["latest_invoice"].(string)]
					reply(expanded)
					return
				}
			case "POST":
				if v, ok := r.PostForm["cancel_at_period_end"]; ok {
					s["cancel_at_period_end"] = v[0] == "true"
				}
				if v, ok := r.PostForm["cancel_at"]; ok && v[0] == "" {
					delete(s, "cancel_at")
				}
			case "DELETE":
				if s["status"] == "canceled" {
					w.WriteHeader(400)
					return
				}
				s["status"] = "canceled"
			}
			reply(s)
		case r.URL.Path == "/invoices/create_preview":
			reply(f.preview)
		case strings.HasPrefix(r.URL.Path, "/invoices/"):
			reply(f.invoices[id])
		case r.URL.Path == "/invoice_payments":
			reply(map[string]any{"data": f.payments[r.URL.Query().Get("invoice")]})
		case r.Method == "POST" && r.URL.Path == "/refunds":
			key := r.Header.Get("Idempotency-Key")
			for _, x := range f.refunds {
				if x["key"] == key {
					reply(x)
					return
				}
			}
			amount := 0.0
			for _, inv := range f.invoices {
				if inv["id"] == r.PostForm.Get("metadata[invoice]") {
					amount, _ = inv["amount_paid"].(float64)
				}
			}
			x := map[string]any{"id": fmt.Sprint("re_", len(f.refunds)+1), "status": "succeeded", "amount": amount, "key": key,
				"payment_intent": r.PostForm.Get("payment_intent"), "charge": r.PostForm.Get("charge"),
				"metadata": map[string]string{"invoice": r.PostForm.Get("metadata[invoice]"), "user_id": r.PostForm.Get("metadata[user_id]")}}
			f.refunds = append(f.refunds, x)
			reply(x)
		case r.Method == "GET" && r.URL.Path == "/refunds":
			found := []any{}
			for _, x := range f.refunds {
				if (x["payment_intent"] != "" && x["payment_intent"] == r.URL.Query().Get("payment_intent")) || (x["charge"] != "" && x["charge"] == r.URL.Query().Get("charge")) {
					found = append(found, x)
				}
			}
			reply(map[string]any{"data": found})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	old := stripeBase
	stripeBase = server.URL
	t.Cleanup(func() { stripeBase = old })
	t.Setenv("PAID_PLANS", "true")
	t.Setenv("STRIPE_SECRET_KEY", "sk_test")
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec")
	t.Setenv("STRIPE_PRICE_PLUS_MONTHLY", "price_plus_m")
	t.Setenv("STRIPE_PRICE_PLUS_YEARLY", "price_plus_y")
	t.Setenv("STRIPE_PRICE_PRO_YEARLY", "price_pro_y")
	return f
}

func (f *fakeBilling) count(call string) int {
	f.Lock()
	defer f.Unlock()
	n := 0
	for _, r := range f.requests {
		if r == call {
			n++
		}
	}
	return n
}

// subscribe gives member a Stripe subscription to plan, billed each interval, whose current
// period began at started and was paid by the payment intent pi_<member>, and records it on their
// row as the webhook would.
func (f *fakeBilling) subscribe(t *testing.T, db *pgxpool.Pool, member, plan, interval string, started time.Time) {
	t.Helper()
	price := map[string]string{"plus/monthly": "price_plus_m", "plus/yearly": "price_plus_y", "pro/yearly": "price_pro_y"}[plan+"/"+interval]
	end, paid := started.AddDate(1, 0, 0), planByID(plan).YearlyUSD
	if interval == "monthly" {
		end, paid = started.AddDate(0, 1, 0), planByID(plan).MonthlyUSD
	}
	sub, invoice := "sub_"+member, "in_"+member
	f.Lock()
	f.subscriptions[sub] = map[string]any{"id": sub, "customer": "cus_" + member, "status": "active", "cancel_at_period_end": false, "latest_invoice": invoice,
		"items": map[string]any{"data": []any{map[string]any{"current_period_start": started.Unix(), "current_period_end": end.Unix(), "price": map[string]any{"id": price}}}}}
	f.invoices[invoice] = map[string]any{"id": invoice, "status": "paid", "amount_paid": math.Round(paid * 100), "currency": "usd", "payment_intent": "pi_" + member}
	f.Unlock()
	if _, e := db.Exec(context.Background(), `UPDATE users SET stripe_customer_id=$2 WHERE id=$1`, member, "cus_"+member); e != nil {
		t.Fatal(e)
	}
	if e := (&App{DB: db}).syncSubscription(context.Background(), sub); e != nil {
		t.Fatal(e)
	}
}

func timeField(t *testing.T, v any) time.Time {
	t.Helper()
	s, _ := v.(string)
	at, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		t.Fatalf("not a time: %v", v)
	}
	return at
}

func TestRefundWindow(t *testing.T) {
	start := time.Date(2026, 10, 1, 9, 30, 0, 0, time.UTC)
	if until := refundUntil(start); !until.Equal(time.Date(2026, 10, 15, 9, 30, 0, 0, time.UTC)) {
		t.Fatalf("refund until %v", until)
	}
	for _, c := range []struct {
		status, interval string
		now              time.Time
		want             bool
	}{
		{"active", "yearly", start, true},
		{"active", "yearly", start.AddDate(0, 0, 14), true},                   // the 14th day, to the minute
		{"active", "yearly", start.AddDate(0, 0, 14).Add(time.Second), false}, // then it's over
		{"active", "yearly", start.AddDate(0, 0, 15), false},
		{"active", "yearly", start.Add(-time.Hour), false}, // a period that hasn't begun
		{"active", "monthly", start.Add(time.Hour), false},
		{"trialing", "yearly", start.Add(time.Hour), false}, // nothing paid yet
		{"past_due", "yearly", start.Add(time.Hour), false},
		{"active", "", start.Add(time.Hour), false}, // complimentary
	} {
		if got := refundable(c.status, c.interval, start, c.now); got != c.want {
			t.Errorf("%s %s at %v: %v", c.status, c.interval, c.now.Sub(start), got)
		}
	}
	if refundable("active", "yearly", time.Time{}, start) {
		t.Error("a period without a start is refundable")
	}
}

func TestCancelAndKeepAPlanInTheApp(t *testing.T) {
	db := isolatedDB(t)
	stripe := newFakeBilling(t)
	f := recipesApp(db, false)
	for id, name := range map[string]string{"ana": "Ana", "ben": "Ben", "cal": "Cal", "kit": "Kit"} {
		namedUser(t, db, id, name)
	}
	ana, ben, cal, kit := bearerFor(t, db, "ana"), bearerFor(t, db, "ben"), bearerFor(t, db, "cal"), bearerFor(t, db, "kit")
	started := time.Now().AddDate(0, -2, 0).Truncate(time.Second)
	stripe.subscribe(t, db, "ana", "pro", "yearly", started)

	b := expect(t, f, 200, "GET", "/v1/billing", ana, nil)
	if b["plan"] != "pro" || b["cancelable"] != true || b["cancels"] != false || b["refund"] != nil {
		t.Fatalf("billing: %v", b)
	}
	// Cancelling: Stripe ends the plan when the paid year does, and the answer shows it at once.
	out := expect(t, f, 200, "POST", "/v1/billing/cancel", ana, nil)
	if out["cancels"] != true || out["plan"] != "pro" || !timeField(t, out["renewsAt"]).Equal(started.AddDate(1, 0, 0)) {
		t.Fatalf("after cancelling: %v", out)
	}
	if got := stripe.forms["POST /subscriptions/sub_ana"].Get("cancel_at_period_end"); got != "true" {
		t.Fatalf("cancel_at_period_end=%q", got)
	}
	// Asking twice changes nothing, and the webhook that follows agrees.
	if out = expect(t, f, 200, "POST", "/v1/billing/cancel", ana, nil); out["cancels"] != true {
		t.Fatalf("cancelling again: %v", out)
	}
	if e := (&App{DB: db}).syncSubscription(context.Background(), "sub_ana"); e != nil {
		t.Fatal(e)
	}
	if out = expect(t, f, 200, "GET", "/v1/billing", ana, nil); out["cancels"] != true || out["cancelable"] != true {
		t.Fatalf("after the webhook: %v", out)
	}
	// Keeping it undoes that.
	if out = expect(t, f, 200, "POST", "/v1/billing/resume", ana, nil); out["cancels"] != false {
		t.Fatalf("after keeping: %v", out)
	}
	if got := stripe.forms["POST /subscriptions/sub_ana"].Get("cancel_at_period_end"); got != "false" {
		t.Fatalf("cancel_at_period_end=%q", got)
	}
	// A plan set by the portal to end on a date reads as ending then.
	stripe.Lock()
	stripe.subscriptions["sub_ana"]["cancel_at"] = started.AddDate(0, 6, 0).Unix()
	stripe.Unlock()
	if e := (&App{DB: db}).syncSubscription(context.Background(), "sub_ana"); e != nil {
		t.Fatal(e)
	}
	if out = expect(t, f, 200, "GET", "/v1/billing", ana, nil); out["cancels"] != true || !timeField(t, out["renewsAt"]).Equal(started.AddDate(0, 6, 0)) {
		t.Fatalf("ending on a date: %v", out)
	}
	// Keeping it clears that date too, and the plan renews when the paid year ends.
	if out = expect(t, f, 200, "POST", "/v1/billing/resume", ana, nil); out["cancels"] != false || !timeField(t, out["renewsAt"]).Equal(started.AddDate(1, 0, 0)) {
		t.Fatalf("keeping a plan set to end on a date: %v", out)
	}
	if form := stripe.forms["POST /subscriptions/sub_ana"]; !form.Has("cancel_at") || form.Get("cancel_at") != "" {
		t.Fatalf("the date wasn't cleared: %v", form)
	}

	// Ben uses Ana's plan through their household: he sees whose it is, and can't change it.
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	b = expect(t, f, 200, "GET", "/v1/billing", ben, nil)
	if shared, _ := b["sharedBy"].(map[string]any); b["plan"] != "pro" || shared["name"] != "Ana" || b["cancelable"] != false || b["refund"] != nil {
		t.Fatalf("Ben's billing: %v", b)
	}
	for _, path := range []string{"/v1/billing/cancel", "/v1/billing/resume", "/v1/billing/refund"} {
		if got := expect(t, f, 403, "POST", path, ben, nil); got["error"] != notYourPlan {
			t.Fatalf("%s for Ben: %v", path, got)
		}
	}
	// Cal has no plan; Kit's is complimentary, with nothing at Stripe to cancel.
	if got := expect(t, f, 404, "POST", "/v1/billing/cancel", cal, nil); got["error"] != "You don't have a plan to cancel." {
		t.Fatalf("no plan: %v", got)
	}
	if _, e := db.Exec(context.Background(), `UPDATE users SET plan='plus',plan_status='active',plan_interval='' WHERE id='kit'`); e != nil {
		t.Fatal(e)
	}
	if b = expect(t, f, 200, "GET", "/v1/billing", kit, nil); b["plan"] != "plus" || b["cancelable"] != false {
		t.Fatalf("complimentary: %v", b)
	}
	expect(t, f, 404, "POST", "/v1/billing/cancel", kit, nil)
	// Without Stripe there's nothing to cancel through.
	t.Setenv("STRIPE_SECRET_KEY", "")
	if b = expect(t, f, 200, "GET", "/v1/billing", ana, nil); b["cancelable"] != false {
		t.Fatalf("billing off: %v", b)
	}
	expect(t, f, 404, "POST", "/v1/billing/cancel", ana, nil)
	if n := stripe.count("POST /subscriptions/sub_ana"); n != 5 {
		t.Fatalf("%d changes sent to Stripe", n)
	}
}

func TestRefundEligibility(t *testing.T) {
	db := isolatedDB(t)
	stripe := newFakeBilling(t)
	f := recipesApp(db, false)
	now := time.Now().Truncate(time.Second)
	tokens := map[string]string{}
	for _, id := range []string{"day14", "day15", "monthly", "again", "twice", "unpaid", "slow", "payer", "mate"} {
		namedUser(t, db, id, strings.ToUpper(id[:1])+id[1:])
		tokens[id] = bearerFor(t, db, id)
	}
	stripe.subscribe(t, db, "day14", "plus", "yearly", now.AddDate(0, 0, -14).Add(time.Minute))
	stripe.subscribe(t, db, "day15", "plus", "yearly", now.AddDate(0, 0, -15))
	stripe.subscribe(t, db, "monthly", "plus", "monthly", now.AddDate(0, 0, -3))
	stripe.subscribe(t, db, "again", "plus", "yearly", now.AddDate(0, 0, -2))
	stripe.subscribe(t, db, "twice", "plus", "yearly", now.AddDate(0, 0, -3))
	stripe.subscribe(t, db, "unpaid", "plus", "yearly", now.AddDate(0, 0, -1))
	stripe.subscribe(t, db, "slow", "pro", "yearly", now.AddDate(0, 0, -1))
	stripe.subscribe(t, db, "payer", "pro", "yearly", now.AddDate(0, 0, -1))
	mustCall(t, f, 201, "POST", "/v1/household", tokens["payer"], fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", tokens["mate"], fiber.Map{"code": inviteCode(t, f, tokens["payer"])})
	// "again" already had this year refunded, though Stripe still bills (its cancellation was lost);
	// "twice" had an earlier year refunded three months ago, and bought another since.
	if _, e := db.Exec(context.Background(), `INSERT INTO plan_refunds(invoice_id,user_id,subscription_id,period_start,payment_intent,amount_cents,currency,refund_id,created_at,completed_at) VALUES
 ('in_again','again','sub_again',now(),'pi_again',7999,'usd','re_old',now(),now()),
 ('in_before','twice','sub_before',now()-interval '100 days','pi_before',7999,'usd','re_before',now()-interval '95 days',now()-interval '95 days')`); e != nil {
		t.Fatal(e)
	}
	stripe.Lock()
	stripe.invoices["in_unpaid"]["status"] = "open"
	stripe.Unlock()

	// The 14th day still offers the refund, until its last minute, with what was paid; the 15th doesn't.
	b := expect(t, f, 200, "GET", "/v1/billing", tokens["day14"], nil)
	refund, _ := b["refund"].(map[string]any)
	if refund == nil || !timeField(t, refund["until"]).Equal(now.Add(time.Minute)) || refund["amountCents"] != 7999.0 || refund["currency"] != "usd" {
		t.Fatalf("day 14: %v", b)
	}
	for member, want := range map[string]string{
		"day15":   "Refunds are for the first 14 days of a yearly plan, and those have passed.",
		"monthly": "Monthly plans aren't refunded. If you cancel, you keep your plan until the month you paid for ends.",
		"again":   "This year's payment has already been refunded.",
		"twice":   refundedYear,
		"unpaid":  "There's no payment to refund for this year.",
	} {
		if b := expect(t, f, 200, "GET", "/v1/billing", tokens[member], nil); b["refund"] != nil || b["cancelable"] != true {
			t.Errorf("%s is offered a refund: %v", member, b)
		}
		if got := expect(t, f, 409, "POST", "/v1/billing/refund", tokens[member], nil); got["error"] != want {
			t.Errorf("%s: %v", member, got)
		}
	}
	// When Stripe can't say what was paid, the offer stands without its amount.
	stripe.Lock()
	stripe.fail["GET /subscriptions/sub_slow"] = 1
	stripe.Unlock()
	b = expect(t, f, 200, "GET", "/v1/billing", tokens["slow"], nil)
	if refund, _ = b["refund"].(map[string]any); refund == nil || refund["until"] == nil || refund["amountCents"] != nil {
		t.Fatalf("Stripe unavailable: %v", b)
	}
	// A household member on someone else's plan is offered nothing and refused.
	if b := expect(t, f, 200, "GET", "/v1/billing", tokens["mate"], nil); b["refund"] != nil || b["cancelable"] != false {
		t.Fatalf("household member: %v", b)
	}
	expect(t, f, 403, "POST", "/v1/billing/refund", tokens["mate"], nil)
	if n := stripe.count("POST /refunds"); n != 0 {
		t.Fatalf("%d refunds made", n)
	}
	// The payer can, the household moving to Free with them.
	if b := expect(t, f, 200, "POST", "/v1/billing/refund", tokens["payer"], nil); b["plan"] != "free" {
		t.Fatalf("payer after the refund: %v", b)
	}
	if b := expect(t, f, 200, "GET", "/v1/billing", tokens["mate"], nil); b["plan"] != "free" || b["sharedBy"] != nil {
		t.Fatalf("household after the refund: %v", b)
	}
	// Day 14 is refunded too; the API answers what the app shows, offering nothing more.
	b = expect(t, f, 200, "POST", "/v1/billing/refund", tokens["day14"], nil)
	if b["plan"] != "free" || b["refund"] != nil || b["cancelable"] != false {
		t.Fatalf("day 14 after the refund: %v", b)
	}
}

func TestRefundsReturnThePaymentOnceAndLeaveTheFund(t *testing.T) {
	db := isolatedDB(t)
	stripe := newFakeBilling(t)
	f := recipesApp(db, false)
	ctx := context.Background()
	for _, id := range []string{"dee", "rae", "sam", "lee", "creator"} {
		testUser(t, db, id)
	}
	dee, rae, sam, lee := bearerFor(t, db, "dee"), bearerFor(t, db, "rae"), bearerFor(t, db, "sam"), bearerFor(t, db, "lee")
	now := time.Now().Truncate(time.Second)
	started := now.AddDate(0, 0, -10)
	stripe.subscribe(t, db, "dee", "pro", "yearly", started)
	// Dee's verified cooks: one from before the refunded year began, two since.
	recipes := []string{testRecipe(t, db, "creator", "A", true), testRecipe(t, db, "creator", "B", true), testRecipe(t, db, "creator", "C", true)}
	verifiedCook(t, db, "dee", recipes[0], started.Add(-time.Hour), 1184)
	verifiedCook(t, db, "dee", recipes[1], started.Add(time.Hour), 1184)
	verifiedCook(t, db, "dee", recipes[2], now.Add(-time.Minute), 1184)

	b := expect(t, f, 200, "POST", "/v1/billing/refund", dee, nil)
	if b["plan"] != "free" || b["refund"] != nil || b["cancelable"] != false {
		t.Fatalf("after the refund: %v", b)
	}
	form := stripe.forms["POST /refunds"]
	if form.Get("payment_intent") != "pi_dee" || form.Get("reason") != "requested_by_customer" || form.Get("metadata[invoice]") != "in_dee" || stripe.keys["POST /refunds"] != "plan-refund-in_dee" {
		t.Fatalf("refund request %v, key %q", form, stripe.keys["POST /refunds"])
	}
	if stripe.count("DELETE /subscriptions/sub_dee") != 1 {
		t.Fatalf("subscription not ended: %v", stripe.requests)
	}
	var status, refundID string
	var amount int
	if e := db.QueryRow(ctx, `SELECT u.plan_status,r.refund_id,r.amount_cents FROM users u JOIN plan_refunds r ON r.user_id=u.id AND r.completed_at IS NOT NULL WHERE u.id='dee'`).Scan(&status, &refundID, &amount); e != nil ||
		status != "canceled" || refundID != "re_1" || amount != 15999 {
		t.Fatalf("recorded: %s %s %d %v", status, refundID, amount, e)
	}
	nets := func(member string) string {
		t.Helper()
		var s string
		if e := db.QueryRow(ctx, `SELECT string_agg(net_cents::text,',' ORDER BY finished_at) FROM cook_sessions WHERE user_id=$1`, member).Scan(&s); e != nil {
			t.Fatal(e)
		}
		return s
	}
	if got := nets("dee"); got != "1184,0,0" {
		t.Fatalf("Dee's cooks count %s toward the fund", got)
	}
	// Asking again finds no plan to refund, and nothing more reaches Stripe.
	expect(t, f, 404, "POST", "/v1/billing/refund", dee, nil)
	if n := stripe.count("POST /refunds"); n != 1 {
		t.Fatalf("%d refunds", n)
	}
	// Admins see it on the member.
	makeAdmins(t, db, "creator")
	member := expect(t, f, 200, "GET", "/v1/admin/users/dee", bearerFor(t, db, "creator"), nil)
	if refunds, _ := member["planRefunds"].([]any); len(refunds) != 1 || refunds[0].(map[string]any)["amountCents"] != 15999.0 || refunds[0].(map[string]any)["completedAt"] == nil {
		t.Fatalf("admin's view: %v", member["planRefunds"])
	}

	// A month the fund has closed keeps what it counted.
	stripe.subscribe(t, db, "lee", "plus", "yearly", started)
	verifiedCook(t, db, "lee", recipes[0], started.Add(time.Hour), 591)
	if _, e := db.Exec(ctx, `INSERT INTO creator_fund_months(month,share_bp) VALUES($1,2000)`, monthStart(started.Add(time.Hour))); e != nil {
		t.Fatal(e)
	}
	expect(t, f, 200, "POST", "/v1/billing/refund", lee, nil)
	if got := nets("lee"); got != "591" {
		t.Fatalf("a closed month changed: %s", got)
	}

	// Newer API versions list an invoice's payments: Rae paid by a charge named only there. Stripe
	// refunds it, then fails to end the subscription: the refund stays open, and asking again
	// finishes it without refunding twice.
	stripe.subscribe(t, db, "rae", "plus", "yearly", started)
	stripe.Lock()
	delete(stripe.invoices["in_rae"], "payment_intent")
	stripe.payments["in_rae"] = []any{map[string]any{"status": "open", "payment": map[string]any{"type": "payment_intent", "payment_intent": "pi_failed"}},
		map[string]any{"status": "paid", "payment": map[string]any{"type": "charge", "charge": "ch_rae"}}}
	stripe.fail["DELETE /subscriptions/sub_rae"] = 1
	stripe.Unlock()
	expect(t, f, 502, "POST", "/v1/billing/refund", rae, nil)
	if got := stripe.forms["POST /refunds"].Get("charge"); got != "ch_rae" {
		t.Fatalf("refunded %q", got)
	}
	if b := expect(t, f, 200, "GET", "/v1/billing", rae, nil); b["plan"] != "plus" || b["refund"].(map[string]any)["amountCents"] != 7999.0 {
		t.Fatalf("an unfinished refund: %v", b)
	}
	// A day on, Stripe has forgotten the idempotency key: the refund is found, not made again.
	stripe.Lock()
	for _, x := range stripe.refunds {
		x["key"] = ""
	}
	stripe.Unlock()
	if b := expect(t, f, 200, "POST", "/v1/billing/refund", rae, nil); b["plan"] != "free" {
		t.Fatalf("finishing the refund: %v", b)
	}
	if n := stripe.count("POST /refunds"); n != 3 {
		t.Fatalf("%d refund requests, want Dee's, Lee's and one of Rae's", n)
	}

	// Two requests at once make one refund.
	stripe.subscribe(t, db, "sam", "plus", "yearly", started)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _ := callAPI(t, f, "POST", "/v1/billing/refund", sam, nil)
			statuses <- status
		}()
	}
	wg.Wait()
	close(statuses)
	ok := 0
	for s := range statuses {
		switch s {
		case 200:
			ok++
		case 404, 409: // the other found the plan gone, or the refund on its way
		default:
			t.Errorf("concurrent refund answered %d", s)
		}
	}
	made := 0
	stripe.Lock()
	for _, x := range stripe.refunds {
		if x["payment_intent"] == "pi_sam" {
			made++
		}
	}
	stripe.Unlock()
	if ok != 1 || made != 1 {
		t.Fatalf("%d succeeded, %d refunds made", ok, made)
	}
}

// fakeMailbox counts the emails sent through Cloudflare, safely across goroutines.
type fakeMailbox struct {
	sync.Mutex
	sent []map[string]any
}

func newFakeMailbox(t *testing.T) *fakeMailbox {
	m := &fakeMailbox{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		m.Lock()
		m.sent = append(m.sent, body)
		m.Unlock()
		_, _ = w.Write([]byte(`{"success":true,"errors":[],"result":{"delivered":["x"],"permanent_bounces":[],"suppressed_recipients":[]}}`))
	}))
	t.Cleanup(server.Close)
	old := cloudflareAPI
	cloudflareAPI = server.URL
	t.Cleanup(func() { cloudflareAPI = old })
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "acct-1")
	t.Setenv("CLOUDFLARE_EMAIL_API_TOKEN", "email-token")
	t.Setenv("EMAIL_FROM", "noreply@savorly.test")
	return m
}

func (m *fakeMailbox) letters() []map[string]any {
	m.Lock()
	defer m.Unlock()
	return append([]map[string]any(nil), m.sent...)
}

func TestRenewalRemindersOncePerRenewal(t *testing.T) {
	db := isolatedDB(t)
	stripe := newFakeBilling(t)
	mail := newFakeMailbox(t)
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)
	for _, id := range []string{"due", "quiet", "later", "leaving", "stale", "monthly", "held"} {
		testUser(t, db, id)
	}
	// Due renews in three days, Quiet in four; Later in ten; Leaving cancelled; Stale cancelled at
	// Stripe, but its webhook hasn't arrived; Monthly isn't yearly; Held is suspended, its payments
	// paused.
	stripe.subscribe(t, db, "due", "pro", "yearly", now.AddDate(-1, 0, 3))
	stripe.subscribe(t, db, "quiet", "pro", "yearly", now.AddDate(-1, 0, 4))
	stripe.subscribe(t, db, "later", "plus", "yearly", now.AddDate(-1, 0, 10))
	stripe.subscribe(t, db, "leaving", "plus", "yearly", now.AddDate(-1, 0, 2))
	stripe.subscribe(t, db, "stale", "plus", "yearly", now.AddDate(-1, 0, 2))
	stripe.subscribe(t, db, "monthly", "plus", "monthly", now.AddDate(0, 0, -27))
	stripe.subscribe(t, db, "held", "plus", "yearly", now.AddDate(-1, 0, 2))
	stripe.Lock()
	stripe.subscriptions["sub_leaving"]["cancel_at_period_end"] = true
	stripe.Unlock()
	if e := (&App{DB: db}).syncSubscription(ctx, "sub_leaving"); e != nil {
		t.Fatal(e)
	}
	stripe.Lock()
	stripe.subscriptions["sub_stale"]["cancel_at_period_end"] = true
	stripe.Unlock()
	suspend(t, db, "held", true)
	registerDevice(t, db, "due")
	setPreferences(t, db, "due", `{"language":"de","notifications":{"follows":false,"pantry":false,"reviews":false,"comments":false}}`)
	// Quiet turned renewal reminders off on their phones; the email goes all the same.
	registerDevice(t, db, "quiet")
	setPreferences(t, db, "quiet", `{"notifications":{"renewals":false}}`)

	// Two replicas at once: one reminder each, one email each and one notice.
	var wg sync.WaitGroup
	counts := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n, e := remindRenewals(ctx, db)
			if e != nil {
				t.Error(e)
			}
			counts <- n
		}()
	}
	wg.Wait()
	close(counts)
	total := 0
	for n := range counts {
		total += n
	}
	letters := mail.letters()
	if total != 2 || len(letters) != 2 {
		t.Fatalf("%d reminded, %d emails", total, len(letters))
	}
	renews := now.AddDate(0, 0, 3)
	day := renews.UTC().Format("2 January 2006")
	if to, _ := letters[0]["to"].([]any); len(to) != 1 || to[0] != "due@example.test" || letters[0]["subject"] != "Your Savorly Pro plan renews on "+day {
		t.Fatalf("email %v", letters[0])
	}
	text, _ := letters[0]["text"].(string)
	for _, want := range []string{"renews on " + day, "$172.79 will be charged", "tap Cancel plan under Your plan", "two taps", "full refund"} {
		if !strings.Contains(text, want) {
			t.Errorf("the email doesn't say %q: %s", want, text)
		}
	}
	// The stale cancellation was read from Stripe and recorded; nobody else was reminded.
	var cancels bool
	if e := db.QueryRow(ctx, `SELECT plan_cancels FROM users WHERE id='stale'`).Scan(&cancels); e != nil || !cancels {
		t.Fatalf("stale cancellation: %v %v", cancels, e)
	}
	var reminded string
	if e := db.QueryRow(ctx, `SELECT string_agg(user_id||':'||amount_cents||currency||':'||(emailed_at IS NOT NULL),',' ORDER BY renews_at) FROM renewal_reminders`).Scan(&reminded); e != nil || reminded != "due:17279usd:true,quiet:17279usd:true" {
		t.Fatalf("reminders %q %v", reminded, e)
	}

	// The phone hears it in the member's language, though every other switch is off; Quiet's doesn't.
	expo := newFakeExpo(t)
	drain(t, expo.notifier(db))
	m := expo.sent()[deviceToken("due")]
	if len(m) != 1 || m[0].Title != "Dein Pro-Abo verlängert sich am "+renews.UTC().Format("02.01.2006") || !strings.HasPrefix(m[0].Body, "172,79 $ für ein weiteres Jahr.") || payload(m[0])["type"] != "plan" {
		t.Fatalf("push %v", m)
	}
	if m := expo.sent()[deviceToken("quiet")]; len(m) != 0 {
		t.Fatalf("Quiet's phone was told: %v", m)
	}

	// Later runs, a restart included, remind nobody again.
	if n, e := remindRenewals(ctx, db); n != 0 || e != nil {
		t.Fatalf("again: %d %v", n, e)
	}
	// The next year's renewal is reminded in its own week, at the catalog's price if Stripe can't
	// preview it.
	next := renews.AddDate(1, 0, 0)
	stripe.Lock()
	item := stripe.subscriptions["sub_due"]["items"].(map[string]any)["data"].([]any)[0].(map[string]any)
	item["current_period_start"], item["current_period_end"] = renews.Unix(), next.Unix()
	stripe.fail["POST /invoices/create_preview"] = 1
	stripe.Unlock()
	if e := (&App{DB: db}).syncSubscription(ctx, "sub_due"); e != nil {
		t.Fatal(e)
	}
	if n, _ := remindRenewals(ctx, db); n != 0 {
		t.Fatal("reminded a year early")
	}
	if _, e := db.Exec(ctx, `UPDATE users SET plan_renews_at=now()+interval '6 days' WHERE id='due'`); e != nil {
		t.Fatal(e)
	}
	stripe.Lock()
	item["current_period_end"] = now.AddDate(0, 0, 6).Unix()
	stripe.Unlock()
	if n, e := remindRenewals(ctx, db); n != 1 || e != nil {
		t.Fatalf("next renewal: %d %v", n, e)
	}
	if text, _ := mail.letters()[2]["text"].(string); !strings.Contains(text, "$159.99 will be charged") {
		t.Fatalf("catalog price: %s", text)
	}
}

func TestRenewalTextsAndMoney(t *testing.T) {
	for _, c := range []struct {
		cents          int64
		currency, lang string
		want           string
	}{
		{7999, "usd", "en", "$79.99"}, {7999, "usd", "ja", "$79.99"}, {7999, "usd", "de", "79,99 $"},
		{7999, "usd", "pt", "US$ 79,99"}, {105, "usd", "fr", "1,05 $"}, {7999, "eur", "en", "79.99 EUR"}, {0, "usd", "en", "$0.00"},
	} {
		if got := formatMoney(c.cents, c.currency, c.lang); got != c.want {
			t.Errorf("%d %s %s: %q, want %q", c.cents, c.currency, c.lang, got, c.want)
		}
	}
	detail := jsonBytes(renewal{Plan: "plus", RenewsAt: time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC), AmountCents: 7999, Currency: "usd"})
	for language := range recipeLanguages {
		title, body := renewalNoticeText(language, detail)
		if strings.Contains(title+body, "{") || !strings.Contains(title, "Plus") || !strings.Contains(title, "2") || !strings.Contains(body, "79") {
			t.Errorf("%s: %q %q", language, title, body)
		}
	}
	if title, body := renewalNoticeText("xx", detail); title != "Your Plus plan renews on 2 November 2026" || !strings.HasPrefix(body, "$79.99 for another year.") {
		t.Errorf("unknown language: %q %q", title, body)
	}
}

func TestUsageSaysWhenAllowancesFreeUp(t *testing.T) {
	db := isolatedDB(t)
	newFakeBilling(t)
	f := recipesApp(db, false)
	ctx := context.Background()
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	ana, ben := bearerFor(t, db, "ana"), bearerFor(t, db, "ben")
	// Ana's oldest sous-chef use counted is 12 days old; Ben's photo, 29 days.
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost,created_at) VALUES
 ('j1','ana','recipe','Soup','k1',0.02,now()-interval '12 days'),('j2','ana','recipe','Stew','k2',0.02,now()-interval '2 days'),
 ('j3','ana','recipe','Old','k3',0.02,now()-interval '40 days'),('j4','ben','image','Cake','k4',0.05,now()-interval '29 days')`); e != nil {
		t.Fatal(e)
	}
	b := expect(t, f, 200, "GET", "/v1/billing", ana, nil)
	frees, _ := b["usageFreesAt"].(map[string]any)
	used, _ := b["usage"].(map[string]any)
	if used["assistant"] != 2.0 || frees["images"] != nil || frees["voiceSeconds"] != nil {
		t.Fatalf("usage %v, frees %v", used, frees)
	}
	if d := time.Until(timeField(t, frees["assistant"])); d < 18*24*time.Hour-time.Minute || d > 18*24*time.Hour+time.Minute {
		t.Fatalf("assistant frees up in %v", d)
	}
	// On a household's shared plan, it's when anyone's use frees up.
	if _, e := db.Exec(ctx, `UPDATE users SET plan='plus',plan_status='active',plan_interval='' WHERE id='ana'`); e != nil {
		t.Fatal(e)
	}
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	b = expect(t, f, 200, "GET", "/v1/billing", ben, nil)
	frees, _ = b["usageFreesAt"].(map[string]any)
	if used, _ = b["usage"].(map[string]any); used["images"] != 1.0 || used["assistant"] != 2.0 {
		t.Fatalf("pooled usage %v", used)
	}
	if d := time.Until(timeField(t, frees["images"])); d < 24*time.Hour-time.Minute || d > 24*time.Hour+time.Minute {
		t.Fatalf("the shared photo frees up in %v", d)
	}
}

// The basics stay free: with paid plans on, a Free member whose AI allowances are used up still
// saves recipes, keeps cookbooks, shops, plans meals, keeps a pantry and shares a household.
func TestBasicsStayFreeWithPaidPlans(t *testing.T) {
	db := isolatedDB(t)
	t.Setenv("PAID_PLANS", "true")
	f := recipesApp(db, false)
	ctx := context.Background()
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	testUser(t, db, "cook")
	publishRecipe(t, db, "cook", "soup", func(r *RecipeInput) { r.Title = "Soup" })
	ana, ben := bearerFor(t, db, "ana"), bearerFor(t, db, "ben")
	free := planByID("free")
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost) SELECT 'job'||g,'ana','recipe','Soup','key'||g,0.02 FROM generate_series(1,$1) g`, free.Assistant); e != nil {
		t.Fatal(e)
	}
	if e := allowance(ctx, db, "ana", "assistant"); e == nil {
		t.Fatal("the sous-chef allowance isn't used up")
	}
	if b := expect(t, f, 200, "GET", "/v1/billing", ana, nil); b["plan"] != "free" {
		t.Fatalf("plan %v", b["plan"])
	}

	book := jsonObject(t, mustCall(t, f, 200, "POST", "/v1/collections", ana, fiber.Map{"name": "Weeknights"}))["id"].(string)
	mustCall(t, f, 200, "PUT", "/v1/recipes/soup/save", ana, fiber.Map{"collectionId": book})
	mustCall(t, f, 200, "PATCH", "/v1/collections/"+book, ana, fiber.Map{"public": true})
	mustCall(t, f, 200, "POST", "/v1/planner", ana, fiber.Map{"recipeId": "soup", "day": "2026-11-02", "meal": "Dinner", "servings": 2})
	mustCall(t, f, 200, "POST", "/v1/planner/groceries", ana, fiber.Map{"from": "2026-11-02", "to": "2026-11-08"})
	mustCall(t, f, 200, "POST", "/v1/recipes/soup/groceries", ana, fiber.Map{"servings": 4})
	mustCall(t, f, 201, "POST", "/v1/groceries", ana, fiber.Map{"name": "Bread", "quantity": "1"})
	list := groceriesOf(t, f, ana)
	if len(list) < 2 {
		t.Fatalf("grocery list %+v", list)
	}
	mustCall(t, f, 204, "PATCH", "/v1/groceries/"+list[0].ID, ana, fiber.Map{"checked": true})
	mustCall(t, f, 201, "POST", "/v1/pantry", ana, fiber.Map{"name": "Rice"})
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	mustCall(t, f, 201, "POST", "/v1/pantry", ben, fiber.Map{"name": "Eggs"})
	k := kitchenOf(t, f, ben)
	if len(k.Plans) != 1 || len(k.Pantry) != 2 {
		t.Fatalf("Ben's shared kitchen: %+v", k)
	}
	library := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/library", ana, nil))
	if saved, _ := library["savedIds"].([]any); len(saved) != 1 {
		t.Fatalf("library %v", library)
	}
}
