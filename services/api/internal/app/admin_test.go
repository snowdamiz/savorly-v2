package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

const testPassword = "a-long-admin-test-password"

func adminApp(db *pgxpool.Pool, production bool) *fiber.App {
	return NewWithContext(context.Background(), db, Config{Production: production, Origins: []string{"http://localhost:8081"}})
}

// signedIn creates a member who can sign in with testPassword and returns a session token.
func signedIn(t *testing.T, db *pgxpool.Pool, email string, verified bool) (string, string) {
	t.Helper()
	ctx, id, tok := context.Background(), uuid.NewString(), uuid.NewString()
	hash, _ := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.MinCost)
	if _, e := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle,email_verified) VALUES($1,$2,$3,'Test cook',$1,$4)`, id, email, string(hash), verified); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')`, hashToken(tok), id); e != nil {
		t.Fatal(e)
	}
	return id, tok
}

func send(t *testing.T, f *fiber.App, method, path, tok string, body any) (int, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(jsonBytes(body))
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// expect fails unless the request answers with status, and decodes an object reply.
func expect(t *testing.T, f *fiber.App, status int, method, path, tok string, body any) map[string]any {
	t.Helper()
	got, b := send(t, f, method, path, tok, body)
	if got != status {
		t.Fatalf("%s %s: want %d, got %d: %s", method, path, status, got, b)
	}
	out := map[string]any{}
	_ = json.Unmarshal(b, &out)
	return out
}

func testRecipe(t *testing.T, db *pgxpool.Pool, author, title string, published bool) string {
	t.Helper()
	id := uuid.NewString()
	_, e := db.Exec(context.Background(), `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published)
 VALUES($1,$2,$3,'A recipe for testing moderation.','Italian',20,2,'Easy','[{"name":"Lemon","amount":1,"unit":"","category":"Produce"}]','[{"title":"Cook","text":"Cook it well.","seconds":0}]',$4)`, id, author, title, published)
	if e != nil {
		t.Fatal(e)
	}
	return id
}

func publicRecipes(t *testing.T, f *fiber.App) string {
	t.Helper()
	_, b := send(t, f, "GET", "/v1/recipes", "", nil)
	return string(b)
}

func auditActions(t *testing.T, db *pgxpool.Pool) string {
	t.Helper()
	var actions string
	if e := db.QueryRow(context.Background(), `SELECT COALESCE(string_agg(action,',' ORDER BY id),'') FROM admin_actions`).Scan(&actions); e != nil {
		t.Fatal(e)
	}
	return actions
}

func items(out map[string]any) []any { v, _ := out["items"].([]any); return v }

func TestAdminAccessFollowsOwnersAndAppointments(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test, Second@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	ownerID, owner := signedIn(t, db, "owner@example.test", false)
	memberID, member := signedIn(t, db, "member@example.test", false)
	otherID, other := signedIn(t, db, "other@example.test", false)
	squatterID, _ := signedIn(t, db, "second@example.test", false)

	// Registering an owner's address proves nothing, so the console stays closed until it's verified.
	me := expect(t, f, 200, "GET", "/v1/me", owner, nil)
	if me["admin"] != false || me["adminPending"] != true {
		t.Fatalf("unverified owner: %v", me)
	}
	expect(t, f, 403, "GET", "/v1/admin/overview", owner, nil)
	expect(t, f, 401, "GET", "/v1/admin/overview", "", nil)
	// Local development has no email to verify with.
	expect(t, adminApp(db, false), 200, "GET", "/v1/admin/overview", owner, nil)

	if _, e := db.Exec(ctx, `UPDATE users SET email_verified=true WHERE id=$1`, ownerID); e != nil {
		t.Fatal(e)
	}
	if me = expect(t, f, 200, "GET", "/v1/me", owner, nil); me["admin"] != true || me["adminPending"] != false {
		t.Fatalf("verified owner: %v", me)
	}
	overview := expect(t, f, 200, "GET", "/v1/admin/overview", owner, nil)
	if stats, _ := overview["stats"].(map[string]any); stats["members"] == nil || len(overview["series"].([]any)) != 30 {
		t.Fatalf("overview: %v", overview)
	}
	expect(t, f, 403, "GET", "/v1/admin/overview", member, nil)

	// Only owners appoint admins; appointed admins can't act on owners or other admins.
	expect(t, f, 200, "PUT", "/v1/admin/users/"+memberID+"/admin", owner, fiber.Map{"admin": true})
	expect(t, f, 200, "PUT", "/v1/admin/users/"+otherID+"/admin", owner, fiber.Map{"admin": true})
	expect(t, f, 200, "GET", "/v1/admin/overview", member, nil)
	expect(t, f, 403, "PUT", "/v1/admin/users/"+squatterID+"/admin", member, fiber.Map{"admin": true})
	expect(t, f, 403, "POST", "/v1/admin/users/"+ownerID+"/suspend", member, fiber.Map{"reason": "Not allowed"})
	expect(t, f, 403, "POST", "/v1/admin/users/"+otherID+"/suspend", member, fiber.Map{"reason": "Not allowed"})
	expect(t, f, 400, "POST", "/v1/admin/users/"+ownerID+"/suspend", owner, fiber.Map{"reason": "Not myself"})

	// Nobody can verify or promote an account that merely registered an owner's address,
	// but it can be moderated like any other.
	expect(t, f, 403, "POST", "/v1/admin/users/"+squatterID+"/verify", owner, nil)
	expect(t, f, 403, "PUT", "/v1/admin/users/"+squatterID+"/admin", owner, fiber.Map{"admin": true})
	expect(t, f, 200, "POST", "/v1/admin/users/"+squatterID+"/suspend", owner, fiber.Map{"reason": "Registered an owner's address"})

	expect(t, f, 200, "PUT", "/v1/admin/users/"+otherID+"/admin", owner, fiber.Map{"admin": false})
	expect(t, f, 403, "GET", "/v1/admin/overview", other, nil)
	list := expect(t, f, 200, "GET", "/v1/admin/users?filter=admins", owner, nil)
	if list["total"] != float64(2) {
		t.Fatalf("admins: %v", list)
	}
	if got := auditActions(t, db); got != "member.admin,member.admin,member.suspend,member.unadmin" {
		t.Fatalf("audit: %s", got)
	}
}

func TestSuspensionEndsAccessAndHidesContent(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	authorID, author := signedIn(t, db, "author@example.test", false)
	recipe := testRecipe(t, db, authorID, "Suspicious soup", true)
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost) VALUES('queued-job',$1,'recipe','Make soup please','key-1',0.05)`, authorID); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(publicRecipes(t, f), "Suspicious soup") {
		t.Fatal("recipe should start public")
	}

	expect(t, f, 400, "POST", "/v1/admin/users/"+authorID+"/suspend", owner, fiber.Map{"reason": ""})
	out := expect(t, f, 200, "POST", "/v1/admin/users/"+authorID+"/suspend", owner, fiber.Map{"reason": "Spam recipes"})
	if out["suspendedAt"] == nil || out["suspendedReason"] != "Spam recipes" {
		t.Fatalf("suspended member: %v", out)
	}
	expect(t, f, 409, "POST", "/v1/admin/users/"+authorID+"/suspend", owner, fiber.Map{"reason": "Again"})

	// Signed out, can't sign back in, and gone from public view.
	expect(t, f, 401, "GET", "/v1/me", author, nil)
	if out = expect(t, f, 403, "POST", "/v1/auth/login", "", fiber.Map{"email": "author@example.test", "password": testPassword}); out["error"] != suspendedMessage {
		t.Fatalf("login: %v", out)
	}
	if strings.Contains(publicRecipes(t, f), "Suspicious soup") {
		t.Fatal("a suspended member's recipe is still listed")
	}
	expect(t, f, 404, "GET", "/v1/recipes/"+recipe, "", nil)
	expect(t, f, 404, "GET", "/v1/creators/"+authorID, "", nil)
	var status string
	var cost float64
	if e := db.QueryRow(ctx, `SELECT status,estimated_cost FROM ai_jobs WHERE id='queued-job'`).Scan(&status, &cost); e != nil || status != "failed" || cost != 0 {
		t.Fatalf("queued work should be cancelled and released: %s %v %v", status, cost, e)
	}
	// Admins still see everything.
	found := items(expect(t, f, 200, "GET", "/v1/admin/recipes?filter=suspended", owner, nil))
	if len(found) != 1 || found[0].(map[string]any)["id"] != recipe {
		t.Fatalf("admin recipes: %v", found)
	}

	expect(t, f, 200, "DELETE", "/v1/admin/users/"+authorID+"/suspend", owner, nil)
	expect(t, f, 200, "POST", "/v1/auth/login", "", fiber.Map{"email": "author@example.test", "password": testPassword})
	if !strings.Contains(publicRecipes(t, f), "Suspicious soup") {
		t.Fatal("lifting the suspension should restore the recipe")
	}
	if got := auditActions(t, db); got != "member.suspend,member.unsuspend" {
		t.Fatalf("audit: %s", got)
	}
}

func TestReportsQueueResolvesAndReopens(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	_, owner := signedIn(t, db, "owner@example.test", true)
	authorID, _ := signedIn(t, db, "author@example.test", false)
	_, reporter := signedIn(t, db, "reporter@example.test", false)
	recipe := testRecipe(t, db, authorID, "Reported risotto", true)
	draft := testRecipe(t, db, authorID, "Private draft", false)
	reports := func(status string) []any {
		return items(expect(t, f, 200, "GET", "/v1/admin/reports?status="+status, owner, nil))
	}

	expect(t, f, 200, "POST", "/v1/recipes/"+recipe+"/report", reporter, fiber.Map{"reason": "This copies another site"})
	open := reports("open")
	if len(open) != 1 || open[0].(map[string]any)["count"] != float64(1) {
		t.Fatalf("open reports: %v", open)
	}
	expect(t, f, 200, "POST", "/v1/admin/recipes/"+recipe+"/reports", owner, fiber.Map{"status": "dismissed", "note": "It's original"})
	expect(t, f, 409, "POST", "/v1/admin/recipes/"+recipe+"/reports", owner, fiber.Map{"status": "dismissed"})
	if len(reports("open")) != 0 || len(reports("dismissed")) != 1 {
		t.Fatal("dismissed reports should leave the queue")
	}
	// Reporting again reopens it.
	expect(t, f, 200, "POST", "/v1/recipes/"+recipe+"/report", reporter, fiber.Map{"reason": "Still copied, see the photo"})
	if len(reports("open")) != 1 {
		t.Fatal("a new report should reopen")
	}

	// Unpublishing resolves open reports; an admin can undo their own unpublish but not publish a draft.
	detail := expect(t, f, 200, "PUT", "/v1/admin/recipes/"+recipe+"/published", owner, fiber.Map{"published": false, "note": "Copied"})
	if detail["published"] != false || len(reports("open")) != 0 || len(reports("resolved")) != 1 {
		t.Fatalf("unpublish: %v", detail)
	}
	if strings.Contains(publicRecipes(t, f), "Reported risotto") {
		t.Fatal("unpublished recipe is still listed")
	}
	expect(t, f, 200, "PUT", "/v1/admin/recipes/"+recipe+"/published", owner, fiber.Map{"published": true})
	expect(t, f, 409, "PUT", "/v1/admin/recipes/"+draft+"/published", owner, fiber.Map{"published": true})

	expect(t, f, 204, "DELETE", "/v1/admin/recipes/"+recipe, owner, fiber.Map{"note": "Removed after review"})
	expect(t, f, 404, "GET", "/v1/admin/recipes/"+recipe, owner, nil)
	if got := auditActions(t, db); got != "reports.dismissed,recipe.unpublish,recipe.publish,recipe.delete" {
		t.Fatalf("audit: %s", got)
	}
	// The audit log outlives the recipe.
	log := items(expect(t, f, 200, "GET", "/v1/admin/audit?q=risotto", owner, nil))
	if len(log) != 4 {
		t.Fatalf("audit search: %v", log)
	}
}

func TestOperatorSettingsPauseAIAndSignups(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	t.Setenv("AI_DAILY_BUDGET_USD", "25")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	cookID, _ := signedIn(t, db, "cook@example.test", false)
	reserve := func() error {
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		return reserveGeneration(ctx, tx, cookID, 0.01)
	}
	if e := reserve(); e != nil {
		t.Fatalf("default budget should allow a small reservation: %v", e)
	}

	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiDailyBudgetUSD": -1})
	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"announcementTone": "party"})
	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"announcement": strings.Repeat("a", announcementLimit+1)})

	out := expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiPaused": true, "signupsPaused": true, "announcement": "Maintenance tonight at 10pm UTC.", "announcementTone": "warning"})
	if s, _ := out["settings"].(map[string]any); s["aiPaused"] != true || out["updatedBy"] != "owner@example.test" {
		t.Fatalf("settings: %v", out)
	}
	if e, ok := reserve().(*fiber.Error); !ok || e.Code != 503 || e.Message != aiPausedMessage {
		t.Fatalf("paused AI should refuse spend: %v", e)
	}
	if out = expect(t, f, 403, "POST", "/v1/auth/register", "", fiber.Map{"name": "New cook", "email": "new@example.test", "password": testPassword}); out["error"] != signupsPausedMessage {
		t.Fatalf("register: %v", out)
	}
	caps := expect(t, f, 200, "GET", "/v1/capabilities", "", nil)
	if a, _ := caps["announcement"].(map[string]any); a["text"] != "Maintenance tonight at 10pm UTC." || a["tone"] != "warning" {
		t.Fatalf("announcement: %v", caps["announcement"])
	}

	// A zero budget override is the same hard stop as the environment's.
	expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiDailyBudgetUSD": 0})
	if e, ok := reserve().(*fiber.Error); !ok || e.Code != 429 {
		t.Fatalf("zero budget should refuse spend: %v", e)
	}
	expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{})
	if e := reserve(); e != nil {
		t.Fatalf("defaults should allow spend again: %v", e)
	}
	expect(t, f, 200, "POST", "/v1/auth/register", "", fiber.Map{"name": "New cook", "email": "new@example.test", "password": testPassword})
	if caps = expect(t, f, 200, "GET", "/v1/capabilities", "", nil); caps["announcement"] != nil {
		t.Fatalf("cleared announcement: %v", caps["announcement"])
	}
	var summaries string
	if e := db.QueryRow(ctx, `SELECT string_agg(summary,' | ' ORDER BY id) FROM admin_actions`).Scan(&summaries); e != nil {
		t.Fatal(e)
	}
	for _, want := range []string{"Paused all AI features", "Paused new sign-ups", "Announcement: Maintenance", "Daily AI budget: the default → $0.00", "Resumed AI features", "Removed the announcement"} {
		if !strings.Contains(summaries, want) {
			t.Fatalf("audit summaries %q lack %q", summaries, want)
		}
	}
}

func TestAdminManagesPlansAccountsReviewsAndJobs(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	t.Setenv("PAID_PLANS", "true")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	ownerID, owner := signedIn(t, db, "owner@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", false)
	payingID, _ := signedIn(t, db, "paying@example.test", true)
	if _, e := db.Exec(ctx, `UPDATE users SET plan='plus',plan_status='active',plan_interval='monthly' WHERE id=$1`, payingID); e != nil {
		t.Fatal(e)
	}

	// Complimentary plans are granted here; Stripe owns paid ones.
	out := expect(t, f, 200, "PUT", "/v1/admin/users/"+cookID+"/plan", owner, fiber.Map{"plan": "pro"})
	if out["plan"] != "pro" || out["comped"] != true || out["limits"] == nil {
		t.Fatalf("comped plan: %v", out)
	}
	if me := expect(t, f, 200, "GET", "/v1/me", cook, nil); me["plan"] != "pro" {
		t.Fatalf("member plan: %v", me)
	}
	expect(t, f, 409, "PUT", "/v1/admin/users/"+payingID+"/plan", owner, fiber.Map{"plan": "free"})
	expect(t, f, 400, "PUT", "/v1/admin/users/"+cookID+"/plan", owner, fiber.Map{"plan": "gold"})

	expect(t, f, 400, "PATCH", "/v1/admin/users/"+cookID, owner, fiber.Map{"bio": "", "handle": "Clean Handle"})
	out = expect(t, f, 200, "PATCH", "/v1/admin/users/"+cookID, owner, fiber.Map{"bio": "", "handle": "clean-handle"})
	if out["handle"] != "clean-handle" || out["bio"] != "" {
		t.Fatalf("edited profile: %v", out)
	}
	expect(t, f, 200, "POST", "/v1/admin/users/"+cookID+"/verify", owner, nil)
	expect(t, f, 409, "POST", "/v1/admin/users/"+cookID+"/verify", owner, nil)

	// Reviews and queued jobs.
	recipe := testRecipe(t, db, payingID, "Plum cake", true)
	expect(t, f, 200, "PUT", "/v1/recipes/"+recipe+"/review", cook, fiber.Map{"rating": 1, "body": "Rude words here"})
	reviews := items(expect(t, f, 200, "GET", "/v1/admin/reviews?rating=1", owner, nil))
	if len(reviews) != 1 {
		t.Fatalf("reviews: %v", reviews)
	}
	expect(t, f, 204, "DELETE", "/v1/admin/reviews/"+reviews[0].(map[string]any)["id"].(string), owner, nil)
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost,status) VALUES('q',$1,'image','A cake photo','k1',0.08,'queued'),('done',$1,'image','A cake photo','k2',0.08,'completed')`, cookID); e != nil {
		t.Fatal(e)
	}
	if job := expect(t, f, 200, "POST", "/v1/admin/jobs/q/cancel", owner, nil); job["status"] != "failed" || job["cost"] != float64(0) || job["prompt"] != "A cake photo" {
		t.Fatalf("cancelled job: %v", job)
	}
	expect(t, f, 409, "POST", "/v1/admin/jobs/done/cancel", owner, nil)
	if jobs := items(expect(t, f, 200, "GET", "/v1/admin/jobs?status=failed", owner, nil)); len(jobs) != 1 {
		t.Fatalf("failed jobs: %v", jobs)
	}
	expect(t, f, 200, "GET", "/v1/admin/ai", owner, nil)

	// Deleting needs the member's email typed back, and never applies to yourself.
	expect(t, f, 400, "DELETE", "/v1/admin/users/"+cookID, owner, fiber.Map{"confirm": "someone@example.test"})
	expect(t, f, 400, "DELETE", "/v1/admin/users/"+ownerID, owner, fiber.Map{"confirm": "owner@example.test"})
	expect(t, f, 204, "DELETE", "/v1/admin/users/"+cookID, owner, fiber.Map{"confirm": "COOK@example.test"})
	expect(t, f, 404, "GET", "/v1/admin/users/"+cookID, owner, nil)
	expect(t, f, 401, "GET", "/v1/me", cook, nil)
	if got := auditActions(t, db); got != "member.plan,member.edit,member.verify,review.delete,job.cancel,member.delete" {
		t.Fatalf("audit: %s", got)
	}
}
