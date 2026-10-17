package app

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/gofiber/fiber/v3"
)

// fakeTurnstile stands in for Cloudflare's siteverify endpoint.
type fakeTurnstile struct {
	mu       sync.Mutex
	status   int
	response string
	got      url.Values
}

func newFakeTurnstile(t *testing.T) *fakeTurnstile {
	t.Helper()
	ft := &fakeTurnstile{status: 200, response: `{"success":true}`}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		ft.mu.Lock()
		defer ft.mu.Unlock()
		ft.got = r.PostForm
		w.WriteHeader(ft.status)
		_, _ = w.Write([]byte(ft.response))
	}))
	t.Cleanup(server.Close)
	old := turnstileEndpoint
	turnstileEndpoint = server.URL
	t.Cleanup(func() { turnstileEndpoint = old })
	return ft
}

func (ft *fakeTurnstile) answer(status int, response string) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	ft.status, ft.response = status, response
}

func (ft *fakeTurnstile) received() url.Values {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return ft.got
}

func TestTurnstileChecksTokensAndFailsClosed(t *testing.T) {
	fake := newFakeTurnstile(t)
	f := fiber.New(fiber.Config{ErrorHandler: errorHandler, ProxyHeader: testIPHeader, TrustProxy: true, TrustProxyConfig: fiber.TrustProxyConfig{Proxies: []string{"0.0.0.0/0"}}})
	f.Post("/check", func(c fiber.Ctx) error {
		if e := verifyTurnstile(c, c.Query("token")); e != nil {
			return e
		}
		return c.SendStatus(204)
	})
	check := func(token string) reply {
		return do(t, f, call{method: "POST", path: "/check?token=" + url.QueryEscape(token), ip: "203.0.113.7"})
	}
	t.Setenv("TURNSTILE_SECRET_KEY", "")
	if r := check(""); r.status != 204 {
		t.Fatalf("off without a secret: %d", r.status)
	}

	t.Setenv("TURNSTILE_SECRET_KEY", "turnstile-secret")
	if r := check(""); r.status != 400 || r.message() != "Complete the security check to continue." {
		t.Fatalf("missing token: %d %s", r.status, r.body)
	}
	if r := check("token-from-the-widget"); r.status != 204 {
		t.Fatalf("valid token: %d %s", r.status, r.body)
	}
	if got := fake.received(); got.Get("secret") != "turnstile-secret" || got.Get("response") != "token-from-the-widget" || got.Get("remoteip") != "203.0.113.7" {
		t.Fatalf("siteverify got %v", got)
	}
	for name, c := range map[string]struct {
		status   int
		response string
		want     int
	}{
		"invalid token":       {200, `{"success":false,"error-codes":["invalid-input-response"]}`, 400},
		"expired or reused":   {200, `{"success":false,"error-codes":["timeout-or-duplicate"]}`, 400},
		"our secret is wrong": {200, `{"success":false,"error-codes":["invalid-input-secret"]}`, 503},
		"cloudflare trouble":  {200, `{"success":false,"error-codes":["internal-error"]}`, 503},
		"server error":        {500, `oops`, 503},
		"not json":            {200, `<html>`, 503},
	} {
		fake.answer(c.status, c.response)
		if r := check("token-from-the-widget"); r.status != c.want || r.message() == "" {
			t.Errorf("%s: %d %s", name, r.status, r.body)
		}
	}
	// Unreachable counts as a failure, not a pass.
	turnstileEndpoint = "http://127.0.0.1:1/siteverify"
	if r := check("token-from-the-widget"); r.status != 503 {
		t.Fatalf("unreachable: %d", r.status)
	}
}

func TestSignUpAndResetAskForTurnstileWhenConfigured(t *testing.T) {
	db := isolatedDB(t)
	fake := newFakeTurnstile(t)
	newMailbox(t)
	t.Setenv("TURNSTILE_SECRET_KEY", "turnstile-secret")
	t.Setenv("TURNSTILE_SITE_KEY", "turnstile-site-key")
	f := accountsApp(db, false)
	if caps := must(t, f, 200, call{method: "GET", path: "/v1/capabilities"}).object(t); caps["turnstileSiteKey"] != "turnstile-site-key" {
		t.Fatalf("capabilities: %v", caps["turnstileSiteKey"])
	}
	account := fiber.Map{"name": "Turn Stile", "email": "turnstile@example.test", "password": "a-long-enough-password"}
	if r := must(t, f, 400, call{method: "POST", path: "/v1/auth/register", body: account}); r.message() != "Complete the security check to continue." {
		t.Fatalf("register without a token: %s", r.body)
	}
	fake.answer(200, `{"success":false,"error-codes":["invalid-input-response"]}`)
	account["turnstileToken"] = "bad-token"
	must(t, f, 400, call{method: "POST", path: "/v1/auth/register", body: account})
	if n := count(t, db, `SELECT count(*) FROM users WHERE email='turnstile@example.test'`); n != 0 {
		t.Fatal("account created without passing the check")
	}
	fake.answer(200, `{"success":true}`)
	account["turnstileToken"] = "good-token"
	must(t, f, 200, call{method: "POST", path: "/v1/auth/register", body: account})

	must(t, f, 400, call{method: "POST", path: "/v1/auth/forgot", body: fiber.Map{"email": "turnstile@example.test"}})
	must(t, f, 200, call{method: "POST", path: "/v1/auth/forgot", body: fiber.Map{"email": "turnstile@example.test", "turnstileToken": "good-token"}})

	// The site key stays hidden while the server doesn't check tokens.
	t.Setenv("TURNSTILE_SECRET_KEY", "")
	if caps := must(t, f, 200, call{method: "GET", path: "/v1/capabilities"}).object(t); caps["turnstileSiteKey"] != "" {
		t.Fatalf("site key without a secret: %v", caps["turnstileSiteKey"])
	}
	must(t, f, 200, call{method: "POST", path: "/v1/auth/register", body: fiber.Map{"name": "No Check", "email": "nocheck@example.test", "password": "a-long-enough-password"}})
}
