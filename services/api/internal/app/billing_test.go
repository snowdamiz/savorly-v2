package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"golang.org/x/crypto/bcrypt"
)

func signStripe(payload []byte, secret string, at time.Time) string {
	stamp := fmt.Sprint(at.Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(stamp + "." + string(payload)))
	return "t=" + stamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestStripeSignature(t *testing.T) {
	body, now := []byte(`{"id":"evt_1"}`), time.Now()
	if !validStripeSignature(body, signStripe(body, "whsec", now), "whsec", now) {
		t.Fatal("valid signature rejected")
	}
	for name, header := range map[string]string{
		"wrong secret": signStripe(body, "other", now),
		"stale":        signStripe(body, "whsec", now.Add(-10*time.Minute)),
		"missing":      "",
		"tampered":     signStripe([]byte(`{"id":"evt_2"}`), "whsec", now),
	} {
		if validStripeSignature(body, header, "whsec", now) {
			t.Errorf("%s signature accepted", name)
		}
	}
}

// fakeStripe records requests and serves the subscriptions a test puts in it.
type fakeStripe struct {
	sync.Mutex
	requests      []string
	forms         map[string]url.Values
	subscriptions map[string]map[string]any
	fail          bool
}

func newFakeStripe(t *testing.T) *fakeStripe {
	f := &fakeStripe{forms: map[string]url.Values{}, subscriptions: map[string]map[string]any{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.Lock()
		defer f.Unlock()
		_ = r.ParseForm()
		f.requests = append(f.requests, r.Method+" "+r.URL.Path)
		f.forms[r.URL.Path] = r.PostForm
		if r.Header.Get("Authorization") != "Bearer sk_test" || f.fail {
			w.WriteHeader(500)
			return
		}
		switch {
		case r.URL.Path == "/customers":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "cus_1"})
		case r.URL.Path == "/checkout/sessions":
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://checkout.stripe.test/s"})
		case r.URL.Path == "/billing_portal/sessions":
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://billing.stripe.test/p"})
		case strings.HasPrefix(r.URL.Path, "/subscriptions/"):
			_ = json.NewEncoder(w).Encode(f.subscriptions[strings.TrimPrefix(r.URL.Path, "/subscriptions/")])
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	old := stripeBase
	stripeBase = server.URL
	t.Cleanup(func() { stripeBase = old })
	t.Setenv("STRIPE_SECRET_KEY", "sk_test")
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec")
	t.Setenv("STRIPE_PRICE_PLUS_MONTHLY", "price_plus_m")
	t.Setenv("STRIPE_PRICE_PRO_YEARLY", "price_pro_y")
	return f
}
func subscription(id, status, price string) map[string]any {
	return map[string]any{"id": id, "customer": "cus_1", "status": status, "cancel_at_period_end": false,
		"items": map[string]any{"data": []any{map[string]any{"current_period_end": time.Now().Add(720 * time.Hour).Unix(), "price": map[string]any{"id": price}}}}}
}

func TestBillingCheckoutWebhookAndPlans(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	stripe := newFakeStripe(t)
	a := &App{DB: db, Config: Config{Origins: []string{"https://savorly.test"}}}
	f := fiber.New()
	f.Use(func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return c.Next() })
	f.Get("/billing", a.billing)
	f.Post("/billing/checkout", a.checkout)
	f.Post("/billing/webhook", a.stripeWebhook)
	ctx := context.Background()
	request := func(method, path string, body []byte, header map[string]string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Test-User", "cook")
		for k, v := range header {
			req.Header.Set(k, v)
		}
		res, e := f.Test(req, fiber.TestConfig{Timeout: 10 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	webhook := func(event map[string]any) int {
		body := jsonBytes(event)
		status, _ := request("POST", "/billing/webhook", body, map[string]string{"Stripe-Signature": signStripe(body, "whsec", time.Now())})
		return status
	}

	if status, _ := request("POST", "/billing/checkout", jsonBytes(map[string]string{"plan": "pro", "interval": "monthly"}), nil); status != 400 {
		t.Fatalf("unconfigured price accepted: %d", status)
	}
	status, out := request("POST", "/billing/checkout", jsonBytes(map[string]string{"plan": "plus", "interval": "monthly"}), nil)
	if status != 200 || out["url"] != "https://checkout.stripe.test/s" {
		t.Fatalf("checkout %d %v", status, out)
	}
	form := stripe.forms["/checkout/sessions"]
	if form.Get("customer") != "cus_1" || form.Get("line_items[0][price]") != "price_plus_m" || form.Get("client_reference_id") != "cook" || !strings.HasPrefix(form.Get("success_url"), "https://savorly.test/") {
		t.Fatalf("checkout session form: %v", form)
	}

	if err := allowance(ctx, db, "cook", "video"); err == nil || !strings.Contains(err.Error(), "doesn't include") {
		t.Fatalf("free plan allowed video: %v", err)
	}
	stripe.subscriptions["sub_old"] = subscription("sub_old", "canceled", "price_plus_m")
	stripe.subscriptions["sub_new"] = subscription("sub_new", "active", "price_pro_y")
	if status := webhook(map[string]any{"type": "checkout.session.completed", "data": map[string]any{"object": map[string]any{"customer": "cus_1", "subscription": "sub_new", "client_reference_id": "cook"}}}); status != 200 {
		t.Fatalf("webhook %d", status)
	}
	// A late event about an older, cancelled subscription mustn't undo the live one.
	webhook(map[string]any{"type": "customer.subscription.deleted", "data": map[string]any{"object": map[string]any{"id": "sub_old"}}})
	_, out = request("GET", "/billing", nil, nil)
	if out["plan"] != "pro" || out["interval"] != "yearly" || out["manage"] != true {
		t.Fatalf("billing after webhook: %v", out)
	}
	if err := allowance(ctx, db, "cook", "video"); err != nil {
		t.Fatalf("pro plan refused video: %v", err)
	}
	if status, _ := request("POST", "/billing/checkout", jsonBytes(map[string]string{"plan": "plus", "interval": "monthly"}), nil); status != 409 {
		t.Fatalf("second subscription allowed: %d", status)
	}
	body := jsonBytes(map[string]any{"type": "customer.subscription.updated", "data": map[string]any{"object": map[string]any{"id": "sub_new"}}})
	if status, _ := request("POST", "/billing/webhook", body, map[string]string{"Stripe-Signature": signStripe(body, "forged", time.Now())}); status != 400 {
		t.Fatal("forged webhook accepted")
	}

	// Past due keeps access while Stripe retries; a cancelled subscription returns to free.
	stripe.subscriptions["sub_new"] = subscription("sub_new", "past_due", "price_pro_y")
	webhook(map[string]any{"type": "customer.subscription.updated", "data": map[string]any{"object": map[string]any{"id": "sub_new"}}})
	if p, _ := planOf(ctx, db, "cook"); p.ID != "pro" {
		t.Fatalf("past due lost access: %s", p.ID)
	}
	tx, _ := db.Begin(ctx)
	free, paid, e := memberBudgets(ctx, tx)
	tx.Rollback(ctx)
	if e != nil || free <= 0 || paid != planByID("pro").SpendCap/30 {
		t.Fatalf("member budgets %v %v %v", free, paid, e)
	}
	stripe.subscriptions["sub_new"] = subscription("sub_new", "canceled", "price_pro_y")
	webhook(map[string]any{"type": "customer.subscription.deleted", "data": map[string]any{"object": map[string]any{"id": "sub_new"}}})
	if p, _ := planOf(ctx, db, "cook"); p.ID != "free" {
		t.Fatalf("cancelled plan kept: %s", p.ID)
	}
}

func TestDeletingAnAccountCancelsItsSubscriptionFirst(t *testing.T) {
	db := isolatedDB(t)
	stripe := newFakeStripe(t)
	hash, _ := bcrypt.GenerateFromPassword([]byte("a-long-password"), 4)
	ctx := context.Background()
	if _, e := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle,plan,plan_status,stripe_customer_id,stripe_subscription_id) VALUES('cook','cook@example.test',$1,'Cook','cook','plus','active','cus_1','sub_1')`, string(hash)); e != nil {
		t.Fatal(e)
	}
	a := &App{DB: db}
	f := fiber.New()
	f.Delete("/me", func(c fiber.Ctx) error { c.Locals("userID", "cook"); return a.deleteMe(c) })
	remove := func() int {
		res, e := f.Test(httptest.NewRequest("DELETE", "/me", bytes.NewReader(jsonBytes(map[string]string{"password": "a-long-password"}))), fiber.TestConfig{Timeout: 10 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		return res.StatusCode
	}
	stripe.fail = true
	if status := remove(); status != 502 {
		t.Fatalf("deleted although the subscription wasn't cancelled: %d", status)
	}
	stripe.fail = false
	if status := remove(); status != 204 {
		t.Fatalf("delete %d", status)
	}
	if last := stripe.requests[len(stripe.requests)-1]; last != "DELETE /subscriptions/sub_1" {
		t.Fatalf("subscription not cancelled: %v", stripe.requests)
	}
}
