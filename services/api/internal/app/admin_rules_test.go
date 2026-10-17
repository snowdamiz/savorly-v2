package app

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// owned is one of each thing an admin moderates, all made by one member: a published recipe
// with an open report, a review of someone else's recipe, a queued AI job and a live voice
// session.
type owned struct{ recipe, review, job, voice string }

func ownedBy(t *testing.T, db *pgxpool.Pool, member, other string) owned {
	t.Helper()
	o := owned{recipe: testRecipe(t, db, member, "A recipe to moderate", true), review: uuid.NewString(), job: uuid.NewString(), voice: uuid.NewString()}
	theirs, project := testRecipe(t, db, other, "A recipe to review", true), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO reports(id,user_id,recipe_id,reason) VALUES($1,$2,$3,'This needs a closer look')`, []any{uuid.NewString(), other, o.recipe}},
		{`INSERT INTO reviews(id,user_id,recipe_id,rating,body) VALUES($1,$2,$3,1,'Not for me')`, []any{o.review, member, theirs}},
		{`INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost) VALUES($1,$2,'image','A photo',$1,0.08)`, []any{o.job, member}},
		{`INSERT INTO voice_projects(id,user_id) VALUES($1,$2)`, []any{project, member}},
		{`INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,expires_at) VALUES($1,$2,$3,'active',1800,now()+interval '30 minutes')`, []any{o.voice, project, member}},
	} {
		if _, e := db.Exec(context.Background(), q.sql, q.args...); e != nil {
			t.Fatal(e)
		}
	}
	return o
}

var (
	refused = [6]int{403, 403, 403, 403, 403, 403}
	allowed = [6]int{200, 200, 204, 200, 204, 204}
)

// moderate tries every content action in turn, wanting these statuses.
func moderate(t *testing.T, f *fiber.App, tok string, o owned, want [6]int) {
	t.Helper()
	for i, r := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/v1/admin/recipes/" + o.recipe + "/reports", fiber.Map{"status": "dismissed"}},
		{"PUT", "/v1/admin/recipes/" + o.recipe + "/published", fiber.Map{"published": false}},
		{"DELETE", "/v1/admin/reviews/" + o.review, nil},
		{"POST", "/v1/admin/jobs/" + o.job + "/cancel", nil},
		{"POST", "/v1/admin/voice/" + o.voice + "/end", nil},
		{"DELETE", "/v1/admin/recipes/" + o.recipe, fiber.Map{"note": "Removed"}},
	} {
		expect(t, f, want[i], r.method, r.path, tok, r.body)
	}
}

func untouched(t *testing.T, db *pgxpool.Pool, o owned) {
	t.Helper()
	var same bool
	e := db.QueryRow(context.Background(), `SELECT (SELECT published AND unpublished_by_admin_at IS NULL FROM recipes WHERE id=$1)
 AND EXISTS(SELECT 1 FROM reports WHERE recipe_id=$1 AND status='open') AND EXISTS(SELECT 1 FROM reviews WHERE id=$2)
 AND (SELECT status='queued' FROM ai_jobs WHERE id=$3) AND (SELECT NOT close_requested FROM voice_sessions WHERE id=$4)`, o.recipe, o.review, o.job, o.voice).Scan(&same)
	if e != nil || !same {
		t.Fatalf("a refused action changed something: %v", e)
	}
}

func makeAdmins(t *testing.T, db *pgxpool.Pool, ids ...string) {
	t.Helper()
	if _, e := db.Exec(context.Background(), `UPDATE users SET admin=true WHERE id=ANY($1)`, ids); e != nil {
		t.Fatal(e)
	}
}

func auditDetail(t *testing.T, db *pgxpool.Pool, action, target string) map[string]any {
	t.Helper()
	var b []byte
	if e := db.QueryRow(context.Background(), `SELECT detail FROM admin_actions WHERE action=$1 AND target_id=$2 ORDER BY id DESC LIMIT 1`, action, target).Scan(&b); e != nil {
		t.Fatal(e)
	}
	out := map[string]any{}
	if e := json.Unmarshal(b, &out); e != nil {
		t.Fatal(e)
	}
	return out
}

func TestAppointedAdminsDontModerateOwnersOrOtherAdmins(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test, second@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	ownerID, owner := signedIn(t, db, "owner@example.test", true)
	// The second owner hasn't verified their address: the console stays closed to them, but
	// they're an owner to act on all the same.
	pendingID, _ := signedIn(t, db, "second@example.test", false)
	adminID, admin := signedIn(t, db, "admin@example.test", false)
	peerID, _ := signedIn(t, db, "peer@example.test", false)
	cookID, _ := signedIn(t, db, "cook@example.test", false)
	makeAdmins(t, db, adminID, peerID)

	for _, member := range []string{ownerID, pendingID, peerID} {
		o := ownedBy(t, db, member, cookID)
		moderate(t, f, admin, o, refused)
		untouched(t, db, o)
		// Owners act on anything.
		moderate(t, f, owner, o, allowed)
	}
	moderate(t, f, admin, ownedBy(t, db, cookID, peerID), allowed)

	// Admins can take their own recipe down, but restoring it or closing its reports is for
	// someone else to decide.
	mine := ownedBy(t, db, adminID, cookID)
	expect(t, f, 403, "POST", "/v1/admin/recipes/"+mine.recipe+"/reports", admin, fiber.Map{"status": "dismissed"})
	expect(t, f, 200, "PUT", "/v1/admin/recipes/"+mine.recipe+"/published", admin, fiber.Map{"published": false})
	expect(t, f, 403, "PUT", "/v1/admin/recipes/"+mine.recipe+"/published", admin, fiber.Map{"published": true})
	expect(t, f, 200, "PUT", "/v1/admin/recipes/"+mine.recipe+"/published", owner, fiber.Map{"published": true})

	// The same goes for their accounts, an unverified owner's included.
	for _, member := range []struct{ id, email string }{{ownerID, "owner@example.test"}, {pendingID, "second@example.test"}, {peerID, "peer@example.test"}} {
		for _, r := range []struct {
			method, path string
			body         any
		}{
			{"PATCH", "", fiber.Map{"name": "Renamed"}},
			{"POST", "/suspend", fiber.Map{"reason": "Not allowed"}},
			{"DELETE", "/suspend", nil},
			{"POST", "/sign-out", nil},
			{"POST", "/verify", nil},
			{"POST", "/setup", nil},
			{"PUT", "/plan", fiber.Map{"plan": "pro"}},
			{"PUT", "/admin", fiber.Map{"admin": false}},
			{"DELETE", "", fiber.Map{"confirm": member.email}},
		} {
			expect(t, f, 403, r.method, "/v1/admin/users/"+member.id+r.path, admin, r.body)
		}
	}
	// Owners can still deal with an account squatting on an owner's address.
	expect(t, f, 200, "POST", "/v1/admin/users/"+pendingID+"/suspend", owner, fiber.Map{"reason": "Registered an owner's address"})

	var mineLogged int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM admin_actions WHERE admin_id=$1`, adminID).Scan(&mineLogged); e != nil || mineLogged != 7 {
		t.Fatalf("the admin's audited actions: %d %v", mineLogged, e)
	}
}

func recipeInput(title string, published bool) fiber.Map {
	return fiber.Map{"title": title, "description": "A recipe for testing moderation.", "cuisine": "Italian", "minutes": 20, "servings": 2, "difficulty": "Easy",
		"ingredients": []fiber.Map{{"name": "Lemon", "amount": 1, "category": "Produce"}}, "steps": []fiber.Map{{"title": "Cook", "text": "Cook it well."}}, "published": published}
}

func TestModerationHoldStaysWithTheRecipe(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	authorID, author := signedIn(t, db, "author@example.test", false)
	recipe := testRecipe(t, db, authorID, "Halloumi skewers", true)
	path := "/v1/admin/recipes/" + recipe

	held := expect(t, f, 200, "PUT", path+"/published", owner, fiber.Map{"published": false, "note": "Copied"})
	if held["unpublishedByAdminAt"] == nil || held["unpublishedBy"] != "owner@example.test" {
		t.Fatalf("held: %v", held)
	}
	// The author keeps editing the draft, but can't undo the unpublish in one tap.
	if out := expect(t, f, 403, "PUT", "/v1/recipes/"+recipe, author, recipeInput("Halloumi skewers, rewritten", true)); out["error"] != moderationHoldMessage {
		t.Fatalf("republished: %v", out)
	}
	if out := expect(t, f, 200, "PUT", "/v1/recipes/"+recipe, author, recipeInput("Halloumi skewers, rewritten", false)); out["title"] != "Halloumi skewers, rewritten" || out["published"] != false {
		t.Fatalf("draft edit: %v", out)
	}
	// Nor can any other write path.
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=true WHERE id=$1`, recipe); e == nil {
		t.Fatal("a held recipe was published")
	}

	// Restoring lifts the hold, and publishing is the author's again.
	if out := expect(t, f, 200, "PUT", path+"/published", owner, fiber.Map{"published": true}); out["published"] != true || out["unpublishedByAdminAt"] != nil || out["unpublishedBy"] != "" {
		t.Fatalf("restored: %v", out)
	}
	expect(t, f, 200, "PUT", "/v1/recipes/"+recipe, author, recipeInput("Halloumi skewers", false))
	expect(t, f, 409, "PUT", path+"/published", owner, fiber.Map{"published": true})
	expect(t, f, 200, "PUT", "/v1/recipes/"+recipe, author, recipeInput("Halloumi skewers", true))

	// Restore reads the row, not the audit log: a recipe whose last admin action is an unpublish
	// but which isn't held (one its author changed before holds existed) is the author's.
	expect(t, f, 200, "PUT", path+"/published", owner, fiber.Map{"published": false})
	if _, e := db.Exec(ctx, `UPDATE recipes SET unpublished_by_admin_at=NULL,unpublished_by='' WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	expect(t, f, 409, "PUT", path+"/published", owner, fiber.Map{"published": true})
	if got := auditActions(t, db); got != "recipe.unpublish,recipe.publish,recipe.unpublish" {
		t.Fatalf("audit: %s", got)
	}
}

func stripeEvent(t *testing.T, f *fiber.App, kind, subscription string) {
	t.Helper()
	body := jsonBytes(fiber.Map{"type": kind, "data": fiber.Map{"object": fiber.Map{"id": subscription}}})
	req := httptest.NewRequest("POST", "/v1/billing/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", signStripe(body, "whsec", time.Now()))
	res, e := f.Test(req, fiber.TestConfig{Timeout: 10 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("%s %s: %d", kind, subscription, res.StatusCode)
	}
}

func TestCompSurvivesLateWebhooks(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	stripe := newFakeStripe(t)
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", true)
	// Their subscription has ended, and Stripe keeps delivering events about it.
	if _, e := db.Exec(ctx, `UPDATE users SET plan='plus',plan_status='canceled',plan_interval='monthly',stripe_customer_id='cus_1',stripe_subscription_id='sub_old' WHERE id=$1`, cookID); e != nil {
		t.Fatal(e)
	}
	stripe.subscriptions["sub_old"] = subscription("sub_old", "canceled", "price_plus_m")
	plan := func() string {
		t.Helper()
		return expect(t, f, 200, "GET", "/v1/me", cook, nil)["plan"].(string)
	}

	out := expect(t, f, 200, "PUT", "/v1/admin/users/"+cookID+"/plan", owner, fiber.Map{"plan": "pro"})
	if out["comped"] != true || out["stripeSubscriptionId"] != "" || auditDetail(t, db, "member.plan", cookID)["endedSubscription"] != "sub_old" {
		t.Fatalf("comp: %v", out)
	}
	stripeEvent(t, f, "customer.subscription.updated", "sub_old")
	stripeEvent(t, f, "customer.subscription.deleted", "sub_old")
	if got := plan(); got != "pro" {
		t.Fatalf("a late webhook undid the comp: %s", got)
	}
	// A comp from before ids were cleared still carries one; events about it don't apply either.
	if _, e := db.Exec(ctx, `UPDATE users SET stripe_subscription_id='sub_old' WHERE id=$1`, cookID); e != nil {
		t.Fatal(e)
	}
	stripeEvent(t, f, "customer.subscription.updated", "sub_old")
	if got := plan(); got != "pro" {
		t.Fatalf("a webhook for the old subscription undid the comp: %s", got)
	}
	// A live subscription is the member paying, and replaces the comp.
	stripe.subscriptions["sub_new"] = subscription("sub_new", "active", "price_plus_m")
	stripeEvent(t, f, "customer.subscription.created", "sub_new")
	member := expect(t, f, 200, "GET", "/v1/admin/users/"+cookID, owner, nil)
	if member["plan"] != "plus" || member["comped"] != false || member["stripeSubscriptionId"] != "sub_new" || member["planInterval"] != "monthly" {
		t.Fatalf("paid plan: %v", member)
	}
}

func TestBudgetOverridesAreOwnersOnlyWithinACap(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	t.Setenv("AI_DAILY_BUDGET_USD", "25")
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "5")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	adminID, admin := signedIn(t, db, "admin@example.test", false)
	makeAdmins(t, db, adminID)

	got := expect(t, f, 200, "GET", "/v1/admin/settings", admin, nil)
	if limits, _ := got["budgetLimits"].(map[string]any); got["canChangeBudgets"] != false || limits["aiDailyBudgetUSD"] != float64(250) || limits["aiFreeDailyBudgetUSD"] != float64(50) {
		t.Fatalf("settings for an admin: %v", got)
	}
	if got = expect(t, f, 200, "GET", "/v1/admin/settings", owner, nil); got["canChangeBudgets"] != true {
		t.Fatalf("settings for an owner: %v", got)
	}
	if out := expect(t, f, 403, "PUT", "/v1/admin/settings", admin, fiber.Map{"aiDailyBudgetUSD": 30}); out["error"] != budgetOwners {
		t.Fatalf("admin raised the budget: %v", out)
	}
	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiDailyBudgetUSD": 100000})
	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiFreeDailyBudgetUSD": 50.01})
	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiFreeDailyBudgetUSD": -1})
	expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiDailyBudgetUSD": 250, "aiFreeDailyBudgetUSD": 50})

	// Admins save the rest of the form with the budgets as they found them, but can't clear one.
	expect(t, f, 200, "PUT", "/v1/admin/settings", admin, fiber.Map{"aiDailyBudgetUSD": 250, "aiFreeDailyBudgetUSD": 50, "aiPaused": true})
	expect(t, f, 403, "PUT", "/v1/admin/settings", admin, fiber.Map{"aiFreeDailyBudgetUSD": 50, "aiPaused": false})
	// An override from before the cap stays until an owner changes it.
	if _, e := db.Exec(ctx, `UPDATE app_settings SET value=jsonb_set(value,'{aiDailyBudgetUSD}','100000') WHERE key='operator'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f, 200, "PUT", "/v1/admin/settings", admin, fiber.Map{"aiDailyBudgetUSD": 100000, "aiFreeDailyBudgetUSD": 50, "aiPaused": false})
	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiDailyBudgetUSD": 99999, "aiFreeDailyBudgetUSD": 50})
	expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiFreeDailyBudgetUSD": 50})
}

func TestSettingsRefuseStaleSaves(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	adminID, admin := signedIn(t, db, "admin@example.test", false)
	makeAdmins(t, db, adminID)
	if got := expect(t, f, 200, "GET", "/v1/admin/settings", admin, nil); got["updatedAt"] != nil {
		t.Fatalf("fresh settings: %v", got)
	}

	// Both admins open the settings before anything is saved: the first save wins, and the
	// second is told instead of undoing it.
	first := expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiPaused": true, "expectedUpdatedAt": nil})
	if out := expect(t, f, 409, "PUT", "/v1/admin/settings", admin, fiber.Map{"announcement": "Hello", "expectedUpdatedAt": nil}); out["error"] != settingsStale {
		t.Fatalf("stale first save: %v", out)
	}
	// From the latest settings a save goes through, and makes older copies stale.
	expect(t, f, 200, "PUT", "/v1/admin/settings", admin, fiber.Map{"aiPaused": true, "announcement": "Hello", "expectedUpdatedAt": first["updatedAt"]})
	expect(t, f, 409, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiPaused": false, "expectedUpdatedAt": first["updatedAt"]})
	if s, e := loadSettings(ctx, db); e != nil || !s.AIPaused || s.Announcement != "Hello" {
		t.Fatalf("a stale save changed the settings: %+v %v", s, e)
	}
	expect(t, f, 400, "PUT", "/v1/admin/settings", owner, fiber.Map{"expectedUpdatedAt": "yesterday"})
	// Clients that don't send it aren't checked.
	expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiPaused": false})
	if got := auditActions(t, db); got != "settings.update,settings.update,settings.update" {
		t.Fatalf("audit: %s", got)
	}
}

func TestCompsAddNoHeadroomAndNobodyCompsThemselves(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	t.Setenv("PAID_PLANS", "true")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	ownerID, owner := signedIn(t, db, "owner@example.test", true)
	adminID, admin := signedIn(t, db, "admin@example.test", false)
	cookID, _ := signedIn(t, db, "cook@example.test", true)
	payingID, _ := signedIn(t, db, "paying@example.test", true)
	makeAdmins(t, db, adminID)
	headroom := func() (float64, float64) {
		t.Helper()
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		free, paid, e := memberBudgets(ctx, tx)
		if e != nil {
			t.Fatal(e)
		}
		return free, paid
	}

	expect(t, f, 200, "PUT", "/v1/admin/users/"+cookID+"/plan", owner, fiber.Map{"plan": "pro"})
	if free, paid := headroom(); free != 0 || paid != 0 {
		t.Fatalf("a comp added headroom: %v %v", free, paid)
	}
	if _, e := db.Exec(ctx, `UPDATE users SET plan='plus',plan_status='active',plan_interval='monthly' WHERE id=$1`, payingID); e != nil {
		t.Fatal(e)
	}
	if free, paid := headroom(); free <= 0 || paid != planByID("plus").SpendCap/30 {
		t.Fatalf("a paying member's headroom: %v %v", free, paid)
	}
	if budget, _ := expect(t, f, 200, "GET", "/v1/admin/overview", owner, nil)["budget"].(map[string]any); budget["memberPaidShare"] != planByID("plus").SpendCap/30 {
		t.Fatalf("overview budget: %v", budget)
	}
	// Nobody comps themselves, owners included.
	expect(t, f, 400, "PUT", "/v1/admin/users/"+ownerID+"/plan", owner, fiber.Map{"plan": "pro"})
	expect(t, f, 400, "PUT", "/v1/admin/users/"+adminID+"/plan", admin, fiber.Map{"plan": "pro"})
	expect(t, f, 200, "PUT", "/v1/admin/users/"+adminID+"/plan", owner, fiber.Map{"plan": "plus"})
}

// paying signs up a member who pays through Stripe.
func paying(t *testing.T, db *pgxpool.Pool, email, sub string) string {
	t.Helper()
	id, _ := signedIn(t, db, email, true)
	if _, e := db.Exec(context.Background(), `UPDATE users SET plan='plus',plan_status='active',plan_interval='monthly',stripe_customer_id=$2,stripe_subscription_id=$3 WHERE id=$1`, id, "cus_"+sub, sub); e != nil {
		t.Fatal(e)
	}
	return id
}

func TestAdminDeletionCommitsBeforeStripeAndApple(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	stripe := newFakeStripe(t)
	apple := newFakeProvider(t, "apple")
	oldApple := appleEndpoint
	appleEndpoint = apple.issuer + "/auth"
	t.Cleanup(func() { appleEndpoint = oldApple })
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	t.Setenv("APPLE_TEAM_ID", "TEAM")
	t.Setenv("APPLE_KEY_ID", "KEY")
	t.Setenv("APPLE_PRIVATE_KEY", string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})))
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	cookID := paying(t, db, "cook@example.test", "sub_1")
	if _, e := db.Exec(ctx, `INSERT INTO identities(provider,subject,user_id,refresh_token,client_id) VALUES('apple','apple-cook',$1,'cook-refresh','app.savorly.mobile')`, cookID); e != nil {
		t.Fatal(e)
	}

	// A deletion that fails leaves nothing done in Stripe or at Apple, and nothing in the log.
	if _, e := db.Exec(ctx, `CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
 CREATE TRIGGER refuse_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION refuse_delete()`); e != nil {
		t.Fatal(e)
	}
	expect(t, f, 500, "DELETE", "/v1/admin/users/"+cookID, owner, fiber.Map{"confirm": "cook@example.test"})
	if len(stripe.requests) != 0 || len(apple.revoke) != 0 || auditActions(t, db) != "" {
		t.Fatalf("a failed deletion left %v, %v and %q", stripe.requests, apple.revoke, auditActions(t, db))
	}
	if _, e := db.Exec(ctx, `DROP TRIGGER refuse_delete ON users`); e != nil {
		t.Fatal(e)
	}

	// Once the deletion is recorded, Stripe and Apple are told. If Stripe can't confirm, the
	// account is gone anyway and the entry says what to finish in the Stripe dashboard.
	stripe.fail = true
	expect(t, f, 204, "DELETE", "/v1/admin/users/"+cookID, owner, fiber.Map{"confirm": "cook@example.test"})
	expect(t, f, 404, "GET", "/v1/admin/users/"+cookID, owner, nil)
	if got := strings.Join(stripe.requests, ","); got != "DELETE /subscriptions/sub_1" || fmt.Sprint(apple.revoke) != "[cook-refresh]" {
		t.Fatalf("stripe requests %s, Apple revocations %v", got, apple.revoke)
	}
	d := auditDetail(t, db, "member.delete", cookID)
	if d["billing"] != "failed" || d["subscription"] != "sub_1" || d["apple"] != "revoked" || !strings.Contains(fmt.Sprint(d["followUp"]), "Cancel subscription sub_1 in the Stripe dashboard") {
		t.Fatalf("failed cancellation: %v", d)
	}
	stripe.fail = false
	otherID := paying(t, db, "other@example.test", "sub_2")
	expect(t, f, 204, "DELETE", "/v1/admin/users/"+otherID, owner, fiber.Map{"confirm": "other@example.test"})
	if d := auditDetail(t, db, "member.delete", otherID); d["billing"] != "cancelled" || d["followUp"] != nil || d["apple"] != nil || d["email"] != "other@example.test" {
		t.Fatalf("cancelled: %v", d)
	}
	if last := stripe.requests[len(stripe.requests)-1]; last != "DELETE /subscriptions/sub_2" {
		t.Fatalf("stripe requests: %v", stripe.requests)
	}
}

func TestSuspensionPausesBilling(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	stripe := newFakeStripe(t)
	f := adminApp(db, true)
	_, owner := signedIn(t, db, "owner@example.test", true)
	cookID := paying(t, db, "cook@example.test", "sub_1")
	path := "/v1/admin/users/" + cookID + "/suspend"

	expect(t, f, 200, "POST", path, owner, fiber.Map{"reason": "Spam recipes"})
	if form := stripe.forms["/subscriptions/sub_1"]; stripe.requests[0] != "POST /subscriptions/sub_1" || form.Get("pause_collection[behavior]") != "void" {
		t.Fatalf("pause: %v %v", stripe.requests, form)
	}
	if d := auditDetail(t, db, "member.suspend", cookID); d["billing"] != "paused" || d["followUp"] != nil || d["reason"] != "Spam recipes" {
		t.Fatalf("paused: %v", d)
	}
	expect(t, f, 200, "DELETE", path, owner, nil)
	if form := stripe.forms["/subscriptions/sub_1"]; len(stripe.requests) != 2 || !form.Has("pause_collection") || form.Get("pause_collection") != "" {
		t.Fatalf("resume: %v %v", stripe.requests, form)
	}
	if d := auditDetail(t, db, "member.unsuspend", cookID); d["billing"] != "resumed" {
		t.Fatalf("resumed: %v", d)
	}

	// When Stripe can't confirm, the suspension stands and the entry says what to finish.
	stripe.fail = true
	expect(t, f, 200, "POST", path, owner, fiber.Map{"reason": "Spam again"})
	if d := auditDetail(t, db, "member.suspend", cookID); d["billing"] != "failed" || !strings.Contains(fmt.Sprint(d["followUp"]), "Pause collection for subscription sub_1") {
		t.Fatalf("failed pause: %v", d)
	}
	stripe.fail = false
	t.Setenv("STRIPE_SECRET_KEY", "")
	expect(t, f, 200, "DELETE", path, owner, nil)
	if d := auditDetail(t, db, "member.unsuspend", cookID); d["billing"] != "skipped" || !strings.Contains(fmt.Sprint(d["followUp"]), "isn't configured") {
		t.Fatalf("unconfigured: %v", d)
	}

	// Members without a subscription that bills leave Stripe alone.
	before := len(stripe.requests)
	plainID, _ := signedIn(t, db, "plain@example.test", true)
	expect(t, f, 200, "POST", "/v1/admin/users/"+plainID+"/suspend", owner, fiber.Map{"reason": "Spam recipes"})
	if d := auditDetail(t, db, "member.suspend", plainID); len(stripe.requests) != before || d["billing"] != nil {
		t.Fatalf("no subscription: %v %v", stripe.requests, d)
	}
}

func TestMemberEditKeepsBeforeAndAfter(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	cookID, _ := signedIn(t, db, "cook@example.test", false)
	if _, e := db.Exec(ctx, `UPDATE users SET bio='Rude words here',handle='rude_handle' WHERE id=$1`, cookID); e != nil {
		t.Fatal(e)
	}
	path := "/v1/admin/users/" + cookID

	expect(t, f, 200, "PATCH", path, owner, fiber.Map{"name": "Test cook", "handle": "clean_handle", "bio": ""})
	d := auditDetail(t, db, "member.edit", cookID)
	before, _ := d["before"].(map[string]any)
	after, _ := d["after"].(map[string]any)
	if fmt.Sprint(d["fields"]) != "[handle bio]" || before["handle"] != "rude_handle" || before["bio"] != "Rude words here" || after["handle"] != "clean_handle" || after["bio"] != "" || before["name"] != nil {
		t.Fatalf("edit detail: %v", d)
	}
	// Saving what's already there isn't an edit.
	expect(t, f, 200, "PATCH", path, owner, fiber.Map{"name": "Test cook", "handle": "clean_handle"})
	if got := auditActions(t, db); got != "member.edit" {
		t.Fatalf("audit: %s", got)
	}
}

func TestAdminListsPageWithoutRepeats(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, true)
	_, owner := signedIn(t, db, "owner@example.test", true)
	// Sample cooks arrive together, so they sort alike; each page still shows new ones.
	if _, e := db.Exec(context.Background(), `INSERT INTO users(id,email,password_hash,name,handle) SELECT 'cook'||n,'cook'||n||'@example.test','!disabled','Sample cook','cook'||n FROM generate_series(1,7) n`); e != nil {
		t.Fatal(e)
	}
	for _, sort := range []string{"newest", "oldest", "recipes"} {
		seen := map[string]bool{}
		for offset := 0; offset < 8; offset += 3 {
			page := expect(t, f, 200, "GET", fmt.Sprintf("/v1/admin/users?sort=%s&limit=3&offset=%d", sort, offset), owner, nil)
			if page["total"] != float64(8) || page["limit"] != float64(3) || page["offset"] != float64(offset) {
				t.Fatalf("%s page at %d: %v", sort, offset, page)
			}
			for _, m := range items(page) {
				id := m.(map[string]any)["id"].(string)
				if seen[id] {
					t.Fatalf("%s: %s is on two pages", sort, id)
				}
				seen[id] = true
			}
		}
		if len(seen) != 8 {
			t.Fatalf("%s: pages showed %d of 8 members", sort, len(seen))
		}
	}
	// Out-of-range paging falls back to the defaults.
	for _, q := range []string{"limit=0", "limit=501", "limit=many", "offset=-1", "offset=100001"} {
		if page := expect(t, f, 200, "GET", "/v1/admin/users?"+q, owner, nil); page["limit"] != float64(50) || page["offset"] != float64(0) || len(items(page)) != 8 {
			t.Fatalf("%s: %v", q, page)
		}
	}
}

func TestAdminWritesIgnoreUnknownFields(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	t.Setenv("PAID_PLANS", "true")
	db := isolatedDB(t)
	f := adminApp(db, true)
	ctx := context.Background()
	ownerID, owner := signedIn(t, db, "owner@example.test", true)
	cookID, _ := signedIn(t, db, "cook@example.test", false)
	account := func() string {
		t.Helper()
		var row string
		if e := db.QueryRow(ctx, `SELECT concat_ws('|',email,password_hash,admin,email_verified,suspended_at,plan_status,plan_interval,stripe_customer_id,stripe_subscription_id,onboarded_at,created_at)
 FROM users WHERE id=$1`, cookID).Scan(&row); e != nil {
			t.Fatal(e)
		}
		return row
	}
	sneaky := fiber.Map{"id": ownerID, "email": "owner@example.test", "passwordHash": "x", "password_hash": "x", "admin": true, "owner": true, "emailVerified": true,
		"suspendedAt": "2020-01-01T00:00:00Z", "plan": "pro", "planStatus": "trialing", "planInterval": "yearly", "stripeCustomerId": "cus_x", "stripeSubscriptionId": "sub_x",
		"onboardedAt": "2020-01-01T00:00:00Z", "createdAt": "2020-01-01T00:00:00Z"}
	with := func(fields fiber.Map) fiber.Map {
		out := fiber.Map{}
		for k, v := range sneaky {
			out[k] = v
		}
		for k, v := range fields {
			out[k] = v
		}
		return out
	}

	was := account()
	if out := expect(t, f, 200, "PATCH", "/v1/admin/users/"+cookID, owner, with(fiber.Map{"name": "Renamed cook"})); out["name"] != "Renamed cook" || account() != was {
		t.Fatalf("edit changed more than the name: %v", out)
	}
	if out := expect(t, f, 200, "PUT", "/v1/admin/users/"+cookID+"/plan", owner, with(fiber.Map{"plan": "plus"})); out["plan"] != "plus" || out["planInterval"] != "" || out["planStatus"] != "active" || out["stripeSubscriptionId"] != "" || out["admin"] != false {
		t.Fatalf("plan: %v", out)
	}

	recipe := testRecipe(t, db, cookID, "Plain pasta", true)
	out := expect(t, f, 200, "PUT", "/v1/admin/recipes/"+recipe+"/published", owner, fiber.Map{"published": false, "title": "Hijacked", "authorId": ownerID, "unpublishedBy": "someone@example.test", "aiGenerated": true})
	if author, _ := out["author"].(map[string]any); out["title"] != "Plain pasta" || author["id"] != cookID || out["unpublishedBy"] != "owner@example.test" || out["aiGenerated"] != false {
		t.Fatalf("unpublish: %v", out)
	}

	expect(t, f, 200, "PUT", "/v1/admin/settings", owner, fiber.Map{"aiPaused": true, "updatedBy": cookID, "updatedAt": "2020-01-01T00:00:00Z", "budgets": 1e9})
	var value, by string
	if e := db.QueryRow(ctx, `SELECT value::text,updated_by FROM app_settings WHERE key='operator'`).Scan(&value, &by); e != nil || by != ownerID || strings.Contains(value, "budgets") || strings.Contains(value, "updated") {
		t.Fatalf("settings: %s by %s %v", value, by, e)
	}
}
