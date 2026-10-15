package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

type fakeEmail struct {
	path, auth string
	sent       map[string]any
	status     int
	response   string
}

func newFakeEmail(t *testing.T) *fakeEmail {
	t.Helper()
	f := &fakeEmail{status: 200, response: `{"success":true,"errors":[],"result":{"delivered":["x"],"queued":[],"permanent_bounces":[],"suppressed_recipients":[]}}`}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.path, f.auth = r.URL.Path, r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&f.sent)
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.response))
	}))
	t.Cleanup(server.Close)
	old := cloudflareAPI
	cloudflareAPI = server.URL
	t.Cleanup(func() { cloudflareAPI = old })
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "acct-1")
	t.Setenv("CLOUDFLARE_EMAIL_API_TOKEN", "email-token")
	t.Setenv("EMAIL_FROM", "noreply@savorly.test")
	return f
}

func TestSendEmailThroughCloudflare(t *testing.T) {
	fake := newFakeEmail(t)
	if !emailEnabled() {
		t.Fatal("email disabled with every setting")
	}
	for _, key := range []string{"CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_EMAIL_API_TOKEN", "EMAIL_FROM"} {
		value := os.Getenv(key)
		t.Setenv(key, "")
		if emailEnabled() {
			t.Fatalf("email enabled without %s", key)
		}
		t.Setenv(key, value)
	}
	ctx := context.Background()
	if e := sendEmail(ctx, "cook@example.test", "Hello", "Body"); e != nil {
		t.Fatal(e)
	}
	if fake.path != "/accounts/acct-1/email/sending/send" || fake.auth != "Bearer email-token" {
		t.Fatalf("request %s %q", fake.path, fake.auth)
	}
	if fake.sent["from"] != "noreply@savorly.test" || fake.sent["subject"] != "Hello" || fake.sent["text"] != "Body" {
		t.Fatalf("body %v", fake.sent)
	}
	if to, _ := fake.sent["to"].([]any); len(to) != 1 || to[0] != "cook@example.test" {
		t.Fatalf("recipients %v", fake.sent["to"])
	}
	for name, response := range map[string]struct {
		status int
		body   string
	}{
		"rejected":   {403, `{"success":false,"errors":[{"code":10000,"message":"Authentication error for cook@example.test"}]}`},
		"bounced":    {200, `{"success":true,"result":{"permanent_bounces":["cook@example.test"]}}`},
		"suppressed": {200, `{"success":true,"result":{"suppressed_recipients":["cook@example.test"]}}`},
	} {
		fake.status, fake.response = response.status, response.body
		e := sendEmail(ctx, "cook@example.test", "Hello", "Body")
		if e == nil {
			t.Fatalf("%s: no error", name)
		}
		if strings.Contains(e.Error(), "cook@example.test") {
			t.Fatalf("%s: error exposes the recipient: %v", name, e)
		}
	}
}

func TestPasswordRecoveryEmailsAWorkingCode(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "recovery")
	if _, e := db.Exec(context.Background(), `UPDATE users SET password_hash='set' WHERE id='recovery'`); e != nil {
		t.Fatal(e)
	}
	fake := newFakeEmail(t)
	a := &App{DB: db}
	f := fiber.New()
	f.Post("/forgot", a.forgotPassword)
	f.Post("/reset", a.resetPassword)
	post := func(path string, body fiber.Map) int {
		req := httptest.NewRequest("POST", path, bytes.NewReader(jsonBytes(body)))
		req.Header.Set("Content-Type", "application/json")
		res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if status := post("/forgot", fiber.Map{"email": "Recovery@Example.test "}); status != 200 {
		t.Fatalf("forgot: %d", status)
	}
	text, _ := fake.sent["text"].(string)
	code := regexp.MustCompile(`\b\d{8}\b`).FindString(text)
	if to, _ := fake.sent["to"].([]any); code == "" || len(to) != 1 || to[0] != "recovery@example.test" {
		t.Fatalf("recovery email to %v: %q", fake.sent["to"], text)
	}
	if status := post("/reset", fiber.Map{"email": "recovery@example.test", "code": code, "password": "a-new-long-password"}); status != 200 {
		t.Fatalf("reset with the emailed code: %d", status)
	}
	// Failed delivery answers exactly like success, so the endpoint never reveals accounts.
	fake.status, fake.response = 500, `{"success":false}`
	if status := post("/forgot", fiber.Map{"email": "recovery@example.test"}); status != 200 {
		t.Fatalf("failed delivery: %d", status)
	}
}
