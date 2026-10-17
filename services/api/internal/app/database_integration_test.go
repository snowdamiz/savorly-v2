package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"savorly/api/internal/ai"
	"savorly/api/internal/database"
)

var (
	extensionsOnce sync.Once
	extensionsErr  error
)

// These tests never enqueue work into the application's public schema or contact a provider.
func isolatedDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set TEST_DATABASE_URL for isolated-schema database tests")
	}
	ctx := context.Background()
	admin, e := pgxpool.New(ctx, raw)
	if e != nil {
		t.Fatal(e)
	}
	// Extensions are database-wide: install them once in public, which every test schema
	// sees through its search_path, rather than in a schema that is dropped afterwards.
	extensionsOnce.Do(func() {
		extensionsErr = pgx.BeginFunc(ctx, admin, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7182309)`)
			if e == nil {
				_, e = tx.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public`)
			}
			if e == nil {
				_, e = tx.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public`)
			}
			return e
		})
	})
	if extensionsErr != nil {
		admin.Close()
		t.Fatal(extensionsErr)
	}
	schema := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+schema); e != nil {
		admin.Close()
		t.Fatal(e)
	}
	parsed, e := url.Parse(raw)
	if e != nil {
		t.Fatal(e)
	}
	q := parsed.Query()
	q.Set("search_path", schema+",public")
	parsed.RawQuery = q.Encode()
	db, e := database.Open(ctx, parsed.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		db.Close()
		_, e := admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
		if e != nil {
			t.Error(e)
		}
		admin.Close()
	})
	return db
}
func testUser(t *testing.T, db *pgxpool.Pool, id string) {
	t.Helper()
	_, e := db.Exec(context.Background(), `INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'!disabled','Test cook',$1)`, id, id+"@example.test")
	if e != nil {
		t.Fatal(e)
	}
}
func jobServer(db *pgxpool.Pool) *fiber.App {
	a := &App{DB: db, AI: ai.New()}
	a.AI.OpenRouterKey = "test-only-never-sent"
	f := fiber.New()
	f.Post("/jobs", func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return a.createJob(c) })
	return f
}
func jobRequest(f *fiber.App, user, key, prompt string) (int, map[string]any, error) {
	return jobOf(f, user, key, "image", prompt)
}
func jobOf(f *fiber.App, user, key, kind, prompt string) (int, map[string]any, error) {
	req := httptest.NewRequest("POST", "/jobs", bytes.NewReader(jsonBytes(fiber.Map{"kind": kind, "prompt": prompt})))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Test-User", user)
	req.Header.Set("Idempotency-Key", key)
	res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if e != nil {
		return 0, nil, e
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out, nil
}
func TestJobIdempotencyAndConcurrentUserLimit(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	testUser(t, db, "cook")
	free := plans[0]
	t.Cleanup(func() { plans[0] = free })
	plans[0].Images, plans[0].SpendCap = 2, 100
	f := jobServer(db)
	status, first, e := jobRequest(f, "cook", "same-request-key", "Make a lovely lemon pasta")
	if e != nil || status != 202 {
		t.Fatalf("submit: %d %v", status, e)
	}
	status, again, e := jobRequest(f, "cook", "same-request-key", "Make a lovely lemon pasta")
	if e != nil || status != 200 || first["id"] != again["id"] {
		t.Fatalf("idempotent retry: %d %v", status, e)
	}
	status, _, _ = jobRequest(f, "cook", "same-request-key", "A different dinner request")
	if status != 409 {
		t.Fatalf("mismatched retry: %d", status)
	}
	var wg sync.WaitGroup
	results := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			status, _, e := jobRequest(f, "cook", fmt.Sprintf("concurrent-key-%d", i), "Make a nice dinner recipe")
			if e != nil {
				results <- 0
			} else {
				results <- status
			}
		}(i)
	}
	wg.Wait()
	close(results)
	accepted := 0
	for status := range results {
		if status == 202 {
			accepted++
		} else if status != 429 {
			t.Errorf("unexpected status %d", status)
		}
	}
	if accepted != 1 {
		t.Fatalf("accepted %d concurrent requests; expected one remaining slot", accepted)
	}
	var count int
	if e = db.QueryRow(context.Background(), `SELECT count(*) FROM ai_jobs`).Scan(&count); e != nil || count != 2 {
		t.Fatalf("job count %d: %v", count, e)
	}
}
func TestGlobalGenerationBudgetAcrossAccounts(t *testing.T) {
	// One photo reserves $0.05.
	t.Setenv("AI_DAILY_BUDGET_USD", "0.05")
	db := isolatedDB(t)
	testUser(t, db, "one")
	testUser(t, db, "two")
	f := jobServer(db)
	status, _, e := jobRequest(f, "one", "first-budget-key", "Create a recipe for lunch")
	if e != nil || status != 202 {
		t.Fatalf("first job: %d %v", status, e)
	}
	status, _, e = jobRequest(f, "two", "second-budget-key", "Create a recipe for dinner")
	if e != nil || status != 429 {
		t.Fatalf("budget bypass: %d %v", status, e)
	}
}
func TestPasswordResetAttemptLimitAndSessionRevocation(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "recovery")
	ctx := context.Background()
	email := "recovery@example.test"
	code := "01234567"
	seed := func() {
		_, e := db.Exec(ctx, `INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES('recovery',$1,now()+interval '15 minutes') ON CONFLICT(user_id) DO UPDATE SET attempts=0,expires_at=excluded.expires_at`, hashToken(email+":"+code))
		if e != nil {
			t.Fatal(e)
		}
	}
	seed()
	a := &App{DB: db}
	f := fiber.New()
	f.Post("/reset", a.resetPassword)
	reset := func(code string) int {
		req := httptest.NewRequest("POST", "/reset", bytes.NewReader(jsonBytes(fiber.Map{"email": email, "code": code, "password": "a-new-long-password"})))
		req.Header.Set("Content-Type", "application/json")
		res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for i := 0; i < 5; i++ {
		if status := reset("99999999"); status != 400 {
			t.Fatalf("wrong code: %d", status)
		}
	}
	if status := reset(code); status != 400 {
		t.Fatalf("attempt limit bypass: %d", status)
	}
	seed()
	if _, e := db.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('test-session','recovery',now()+interval '1 day')`); e != nil {
		t.Fatal(e)
	}
	if status := reset(code); status != 200 {
		t.Fatalf("valid reset: %d", status)
	}
	var hash string
	var sessions int
	if e := db.QueryRow(ctx, `SELECT password_hash FROM users WHERE id='recovery'`).Scan(&hash); e != nil {
		t.Fatal(e)
	}
	if e := bcrypt.CompareHashAndPassword([]byte(hash), []byte("a-new-long-password")); e != nil {
		t.Fatal(e)
	}
	if e := db.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id='recovery'`).Scan(&sessions); e != nil || sessions != 0 {
		t.Fatalf("sessions not revoked: %d %v", sessions, e)
	}
	if status := reset(code); status != 400 {
		t.Fatalf("reset code reused: %d", status)
	}
}
func TestRecipeGalleryKeptByWritersThatOmitIt(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	photos := func() string {
		var s string
		if e := db.QueryRow(ctx, `SELECT photos::text FROM recipes WHERE id='r1'`).Scan(&s); e != nil {
			t.Fatal(e)
		}
		return s
	}
	r := validRecipe()
	r.Photos = []string{"https://images.example.com/2.jpg"}
	if e := persistRecipe(ctx, db, "cook", "r1", r, false); e != nil {
		t.Fatal(e)
	}
	// The studio rebuilds recipes without knowing about the gallery.
	r.Photos = nil
	if e := persistRecipe(ctx, db, "cook", "r1", r, true); e != nil {
		t.Fatal(e)
	}
	if got := photos(); got != `["https://images.example.com/2.jpg"]` {
		t.Fatalf("gallery lost on update without photos: %s", got)
	}
	r.Photos = []string{}
	if e := persistRecipe(ctx, db, "cook", "r1", r, true); e != nil {
		t.Fatal(e)
	}
	if got := photos(); got != `[]` {
		t.Fatalf("explicit empty gallery not saved: %s", got)
	}
}

// Questions, twists, swaps, nutrition, meal plans and new recipes are the sous-chef's
// conversation now; only photos and clips are made as jobs.
func TestJobsMakeOnlyPhotosAndClips(t *testing.T) {
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	testUser(t, db, "cook")
	f := jobServer(db)
	for _, kind := range []string{"recipe", "adapt", "substitute", "nutrition", "plan", "assistant"} {
		if status, _, e := jobOf(f, "cook", "key-"+kind, kind, "Make a lovely lemon pasta"); e != nil || status != 400 {
			t.Errorf("%s job: %d %v", kind, status, e)
		}
	}
	if status, _, e := jobOf(f, "cook", "key-image", "image", "Steam rising from a bowl of soup"); e != nil || status != 202 {
		t.Fatalf("image job: %d %v", status, e)
	}
}
