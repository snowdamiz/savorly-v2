package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"savorly/api/internal/narration"
)

// logSink collects the JSON lines slog writes while a test runs.
type logSink struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *logSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func captureLogs(t *testing.T) *logSink {
	t.Helper()
	sink := &logSink{}
	old, out, flags := slog.Default(), log.Writer(), log.Flags()
	slog.SetDefault(slog.New(slog.NewJSONHandler(sink, nil)))
	// SetDefault also redirects the log package, which restoring slog alone doesn't undo.
	t.Cleanup(func() { slog.SetDefault(old); log.SetOutput(out); log.SetFlags(flags) })
	return sink
}

// find returns the logged records with this message that have every given attribute.
func (s *logSink) find(msg string, attrs map[string]any) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for _, line := range strings.Split(s.buf.String(), "\n") {
		var rec map[string]any
		if json.Unmarshal([]byte(line), &rec) != nil || rec["msg"] != msg {
			continue
		}
		match := true
		for k, v := range attrs {
			if rec[k] != v {
				match = false
			}
		}
		if match {
			out = append(out, rec)
		}
	}
	return out
}

func (s *logSink) text() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func TestErrorsCarryTheRequestID(t *testing.T) {
	f := New(nil, Config{Origins: []string{testOrigin}})
	r := do(t, f, call{method: "GET", path: "/v1/no-such-thing"})
	body := r.object(t)
	if r.status != 404 || body["error"] == "" || body["requestId"] == nil || body["requestId"] != r.header.Get("X-Request-Id") {
		t.Fatalf("404: %d %v (header %q)", r.status, body, r.header.Get("X-Request-Id"))
	}
	for i := 0; i < 5; i++ {
		do(t, f, call{method: "POST", path: "/v1/auth/forgot", body: fiber.Map{}})
	}
	r = do(t, f, call{method: "POST", path: "/v1/auth/forgot", body: fiber.Map{}})
	if body = r.object(t); r.status != 429 || body["error"] == "" || body["requestId"] != r.header.Get("X-Request-Id") || body["requestId"] == "" {
		t.Fatalf("429: %d %v", r.status, body)
	}
}

func TestPanicsAreRecoveredWithAStackTrace(t *testing.T) {
	logs := captureLogs(t)
	f := New(nil, Config{Origins: []string{testOrigin}})
	f.Get("/v1/boom", func(c fiber.Ctx) error { panic("the oven caught fire") })
	r := do(t, f, call{method: "GET", path: "/v1/boom"})
	body := r.object(t)
	if r.status != 500 || body["error"] != "Something went wrong. Please try again." || body["requestId"] == nil {
		t.Fatalf("panic answered %d %v", r.status, body)
	}
	panics := logs.find("panic", map[string]any{"panic": "the oven caught fire", "requestId": body["requestId"]})
	if len(panics) != 1 || !strings.Contains(panics[0]["stack"].(string), "goroutine") {
		t.Fatalf("panic log: %v", panics)
	}
	if len(logs.find("request", map[string]any{"route": "/v1/boom", "status": float64(500), "requestId": body["requestId"]})) != 1 {
		t.Fatalf("no access line for the panic: %s", logs.text())
	}
}

func TestAccessLogNamesRoutesNotValues(t *testing.T) {
	logs := captureLogs(t)
	f := New(nil, Config{Origins: []string{testOrigin}})
	f.Get("/v1/things/:id", func(c fiber.Ctx) error { return c.JSON(fiber.Map{"id": c.Params("id")}) })
	r := must(t, f, 200, call{method: "GET", path: "/v1/things/private-id?q=secret-query"})
	lines := logs.find("request", map[string]any{"method": "GET", "route": "/v1/things/:id", "status": float64(200), "requestId": r.header.Get("X-Request-Id")})
	if len(lines) != 1 || lines[0]["bytes"] != float64(len(r.body)) || lines[0]["durationMs"] == nil || lines[0]["level"] != "INFO" {
		t.Fatalf("access line: %v", lines)
	}
	// Requests turned away before routing log the path, with export tokens masked.
	do(t, f, call{method: "POST", path: "/v1/export/0123456789abcdef"})
	if len(logs.find("request", map[string]any{"route": "/v1/export/:token", "status": float64(405)})) != 1 {
		t.Fatalf("unrouted export path: %s", logs.text())
	}
	for _, secret := range []string{"private-id", "secret-query", "0123456789abcdef"} {
		if strings.Contains(logs.text(), secret) {
			t.Errorf("%q logged", secret)
		}
	}
}

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	z, e := gzip.NewReader(bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	out, e := io.ReadAll(z)
	if e != nil {
		t.Fatal(e)
	}
	return out
}

func TestJSONResponsesAreCompressed(t *testing.T) {
	f := New(nil, Config{Origins: []string{testOrigin}})
	big := make([]fiber.Map, 400)
	for i := range big {
		big[i] = fiber.Map{"title": "Lemon ricotta pasta", "minutes": 20, "tags": []string{"quick", "vegetarian"}}
	}
	f.Get("/v1/big", func(c fiber.Ctx) error { return c.JSON(big) })
	r := must(t, f, 200, call{method: "GET", path: "/v1/big", header: map[string]string{"Accept-Encoding": "gzip"}})
	if r.header.Get("Content-Encoding") != "gzip" || !strings.Contains(r.header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("headers: %v", r.header)
	}
	var got []map[string]any
	if e := json.Unmarshal(gunzip(t, r.body), &got); e != nil || len(got) != 400 {
		t.Fatalf("decompressed: %d %v", len(got), e)
	}
	if r = must(t, f, 200, call{method: "GET", path: "/v1/big", header: map[string]string{"Accept-Encoding": "br"}}); r.header.Get("Content-Encoding") != "br" {
		t.Fatalf("brotli: %v", r.header)
	}
	if r = must(t, f, 200, call{method: "GET", path: "/v1/big"}); r.header.Get("Content-Encoding") != "" {
		t.Fatal("compressed for a client that didn't ask")
	}
	if r = must(t, f, 200, call{method: "GET", path: "/v1/capabilities", header: map[string]string{"Accept-Encoding": "gzip"}}); r.header.Get("Content-Encoding") != "gzip" {
		t.Fatal("capabilities not compressed")
	}
	probe := fiber.New()
	probe.Get("/*", func(c fiber.Ctx) error { return c.JSON(skipCompression(c)) })
	for _, c := range []struct {
		path, accept string
		skip         bool
	}{
		{"/v1/recipes/r1/steps/0/narration/abc", "", true},
		{"/v1/recipes/r1/steps/0/narration", "", false},
		{"/v1/recipes/r1", "application/json", false},
		{"/v1/recipe-studio/s1/events", "text/event-stream", true},
	} {
		if got := string(do(t, probe, call{method: "GET", path: c.path, header: map[string]string{"Accept": c.accept}}).body); got != fmt.Sprint(c.skip) {
			t.Errorf("%s (%s): skip=%s", c.path, c.accept, got)
		}
	}
}

func TestClientErrorReports(t *testing.T) {
	logs := captureLogs(t)
	f := New(nil, Config{Origins: []string{testOrigin}, ProxyHeader: testIPHeader})
	report := fiber.Map{"message": "Cannot read properties of undefined", "stack": strings.Repeat("at Recipe (bundle.js:1:2)\n", 500),
		"componentStack": "in RecipeDetail", "platform": "web", "appVersion": "1.4.0", "release": "2026.10.16",
		"url": "https://savorly.cooking/auth/apple?code=secret-code&page=profile#frag"}
	must(t, f, 204, call{method: "POST", path: "/v1/client-errors", origin: testOrigin, ip: "192.0.2.1", body: report})
	lines := logs.find("client error", map[string]any{"message": "Cannot read properties of undefined", "platform": "web", "appVersion": "1.4.0"})
	if len(lines) != 1 || lines[0]["level"] != "ERROR" || len([]rune(lines[0]["stack"].(string))) > 8001 || lines[0]["userId"] != nil {
		t.Fatalf("report log: %v", lines)
	}
	if u := lines[0]["url"].(string); strings.Contains(u, "secret-code") || strings.Contains(u, "frag") || !strings.Contains(u, "page=profile") {
		t.Fatalf("url logged as %q", u)
	}
	must(t, f, 400, call{method: "POST", path: "/v1/client-errors", ip: "192.0.2.2", body: fiber.Map{"platform": "ios"}})
	must(t, f, 413, call{method: "POST", path: "/v1/client-errors", ip: "192.0.2.2", body: fiber.Map{"message": strings.Repeat("x", 17<<10)}})
	for i := 0; i < 30; i++ {
		must(t, f, 204, call{method: "POST", path: "/v1/client-errors", ip: "192.0.2.3", body: fiber.Map{"message": "again"}})
	}
	must(t, f, 429, call{method: "POST", path: "/v1/client-errors", ip: "192.0.2.3", body: fiber.Map{"message": "again"}})
}

// The parts that need sessions and a database: who is logged, health checks, browser reports
// with cookies, and narration audio.
func TestObservabilityWithSessions(t *testing.T) {
	db := isolatedDB(t)
	logs := captureLogs(t)
	f := accountsApp(db, false)
	id := member(t, db, "observed@example.test")
	tok := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)

	must(t, f, 200, call{method: "GET", path: "/health"})
	must(t, f, 200, call{method: "GET", path: "/v1/me", bearer: tok})
	if len(logs.find("request", map[string]any{"route": "/health"})) != 0 {
		t.Fatal("health checks logged")
	}
	if len(logs.find("request", map[string]any{"route": "/v1/me", "userId": id})) != 1 {
		t.Fatalf("member not logged: %s", logs.text())
	}

	// Browsers send Origin with every POST, so cookie-carrying reports pass the Origin rule.
	must(t, f, 204, call{method: "POST", path: "/v1/client-errors", cookie: tok, origin: testOrigin, body: fiber.Map{"message": "from a signed-in browser"}})
	if lines := logs.find("client error", map[string]any{"message": "from a signed-in browser", "userId": id}); len(lines) != 1 {
		t.Fatalf("report without its member: %s", logs.text())
	}
	must(t, f, 403, call{method: "POST", path: "/v1/client-errors", cookie: tok, body: fiber.Map{"message": "no origin"}})
	must(t, f, 204, call{method: "POST", path: "/v1/client-errors", bearer: tok, body: fiber.Map{"message": "from the native app"}})

	// Narration audio is never compressed, even for a client that accepts it.
	recipe := testRecipe(t, db, id, "Narrated pasta", true)
	key := narrationKey(recipe, 0, "Cook it well.", narration.New().Voice)
	audio := bytes.Repeat([]byte("ID3 audio frame "), 512)
	if _, e := db.Exec(context.Background(), `INSERT INTO recipe_narrations(cache_key,recipe_id,audio) VALUES($1,$2,$3)`, key, recipe, audio); e != nil {
		t.Fatal(e)
	}
	r := must(t, f, 200, call{method: "GET", path: "/v1/recipes/" + recipe + "/steps/0/narration/" + key, bearer: tok, header: map[string]string{"Accept-Encoding": "gzip, br"}})
	if r.header.Get("Content-Encoding") != "" || !bytes.Equal(r.body, audio) || r.header.Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("narration: %v, %d bytes", r.header, len(r.body))
	}
}

func TestReportURLMasksCredentials(t *testing.T) {
	for raw, want := range map[string]string{
		"https://savorly.cooking/?page=recipe&recipe=abc":          "https://savorly.cooking/?page=recipe&recipe=abc",
		"https://savorly.cooking/auth/apple?code=c1&state=s1#x":    "https://savorly.cooking/auth/apple?code=redacted&state=redacted",
		"https://user:pass@savorly.cooking/?reset_token=t&page=me": "https://savorly.cooking/?page=me&reset_token=redacted",
		"%zz": "",
	} {
		if got := reportURL(raw); got != want {
			t.Errorf("reportURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestOwnersComeOnlyFromConfiguration(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "")
	if owners := ownerEmails(); len(owners) != 0 {
		t.Fatalf("owners without ADMIN_EMAILS: %v", owners)
	}
	t.Setenv("ADMIN_EMAILS", " Owner@Example.test, ,second@example.test")
	if owners := ownerEmails(); len(owners) != 2 || owners[0] != "owner@example.test" || owners[1] != "second@example.test" {
		t.Fatalf("owners: %v", owners)
	}
	// Production without owners is worth a warning at startup.
	t.Setenv("ADMIN_EMAILS", "")
	logs := captureLogs(t)
	warnMisconfiguration(Config{Production: false})
	if len(logs.find("ADMIN_EMAILS is empty, so no one can open the admin console", nil)) != 0 {
		t.Fatal("warned in development")
	}
	warnMisconfiguration(Config{Production: true})
	if len(logs.find("ADMIN_EMAILS is empty, so no one can open the admin console", nil)) != 1 {
		t.Fatalf("no warning: %s", logs.text())
	}
}

func TestLogFormatFollowsTheEnvironment(t *testing.T) {
	captureLogs(t) // restores the default logger afterwards
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	SetupLogging(Config{Production: true})
	if _, ok := slog.Default().Handler().(*slog.JSONHandler); !ok {
		t.Fatalf("production logs with %T", slog.Default().Handler())
	}
	SetupLogging(Config{})
	if _, ok := slog.Default().Handler().(*slog.TextHandler); !ok {
		t.Fatalf("development logs with %T", slog.Default().Handler())
	}
}
