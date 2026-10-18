package app

import (
	"context"
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCookingMetrics(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	_, member := signedIn(t, db, "member@example.test", true)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	// Real members (sample cooks from SEED_DATA never count), two of them paying.
	for _, id := range []string{"creator", "m1", "m2", "m3", "home", "r1", "r2", "r3", "r4", "r5", "a", "b", "c"} {
		testUser(t, db, id)
		exec(`UPDATE users SET password_hash='!google' WHERE id=$1`, id)
	}
	testUser(t, db, "sample")
	exec(`UPDATE users SET plan='plus',plan_status='active',plan_interval='monthly' WHERE id IN ('m1','m2')`)
	recipe, other := testRecipe(t, db, "creator", "Soup", true), testRecipe(t, db, "creator", "Stew", true)

	// Active in 30 days: m1 by a session, m2 by an event, the sample cook doesn't count; the two
	// signed-in admins above count too. Three verified cooks in that time.
	exec(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('m1-session','m1',now()+interval '1 day'),('sample-session','sample',now()+interval '1 day')`)
	exec(`INSERT INTO events(name,user_id) VALUES('recipe_open','m2'),('recipe_open',NULL)`)
	now := time.Now().Add(-time.Minute)
	verifiedCook(t, db, "m1", recipe, now, 859)
	verifiedCook(t, db, "m1", other, now, 859)
	verifiedCook(t, db, "m3", recipe, now, 0)
	exec(`INSERT INTO cook_sessions(id,user_id,recipe_id,steps,step_reached,started_at,finished_at,verified,verified_day)
 VALUES('old','m3',$1,1,1,now()-interval '40 days',now()-interval '40 days',true,(now()-interval '40 days')::date)`, recipe)
	// Finish rate over sessions started 1 to 31 days ago: two finished at the last step, one
	// finished early, one left open.
	for i, s := range []struct{ reached, finished string }{{"3", "now()-interval '5 days'"}, {"3", "now()-interval '5 days'"}, {"2", "now()-interval '5 days'"}, {"2", "NULL"}} {
		exec(`INSERT INTO cook_sessions(id,user_id,recipe_id,steps,step_reached,started_at,finished_at) VALUES($1,'m3',$2,3,`+s.reached+`,now()-interval '5 days',`+s.finished+`)`, "rate"+string(rune('a'+i)), recipe)
	}
	// Creators over $25: the last closed month's earnings, not an earlier month's.
	august, september := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	earning(t, db, "a", august, 3000)
	earning(t, db, "a", september, 2600)
	earning(t, db, "b", september, 2500)
	earning(t, db, "c", september, 100)
	// Month-3 retention: r1 still pays, r2 stopped before 90 days, r3 came back before 90 days
	// and still pays; r4 started too long ago and r5 was paying before spans were recorded.
	exec(`INSERT INTO paid_spans(user_id,started_at,ended_at) VALUES
 ('r1',now()-interval '100 days',NULL),
 ('r2',now()-interval '95 days',now()-interval '30 days'),
 ('r3',now()-interval '110 days',now()-interval '100 days'),('r3',now()-interval '60 days',NULL),
 ('r4',now()-interval '200 days',NULL),
 ('r5',NULL,NULL)`)
	// AI spend: m1 and the household member on m1's plan, m2, and m3 on Free, who isn't counted.
	exec(`INSERT INTO households(id,name) VALUES('h','Home')`)
	exec(`INSERT INTO household_members(user_id,household_id,role) VALUES('m1','h','owner'),('home','h','member')`)
	exec(`INSERT INTO ai_usage(user_id,kind,estimated_cost) VALUES('m1','question',0.40),('home','question',0.20),('m2','question',0.10),('m3','question',0.30)`)
	exec(`INSERT INTO ai_usage(user_id,kind,estimated_cost,created_at) VALUES('m2','question',5,now()-interval '40 days')`)

	expect(t, f, 403, "GET", "/v1/admin/cooking", member, nil)
	var got struct {
		CooksPerActive struct{ Cooks, Active int }
		FinishRate     struct{ Started, Finished int }
		PayingCooked   struct {
			Month          string
			Paying, Cooked int
		}
		CreatorsOver25 struct {
			Month    string
			Creators int
		}
		Retention struct {
			Cohort, Retained int
			RecordedSince    *time.Time
		}
		AICost struct {
			Members                      int
			Spend, PerMember, ShareOfCap float64
		}
	}
	status, b := send(t, f, "GET", "/v1/admin/cooking", owner, nil)
	if status != 200 || json.Unmarshal(b, &got) != nil {
		t.Fatalf("cooking: %d %s", status, b)
	}
	// The owner and member signed in above have sessions too.
	if got.CooksPerActive.Cooks != 3 || got.CooksPerActive.Active != 4 {
		t.Errorf("cooks per active member: %+v", got.CooksPerActive)
	}
	if got.FinishRate.Started != 4 || got.FinishRate.Finished != 2 {
		t.Errorf("finish rate: %+v", got.FinishRate)
	}
	if got.PayingCooked.Paying != 2 || got.PayingCooked.Cooked != 1 || got.PayingCooked.Month != monthStart(time.Now()).Format(time.DateOnly) {
		t.Errorf("paying members who cooked: %+v", got.PayingCooked)
	}
	if got.CreatorsOver25.Month != "2026-09-01" || got.CreatorsOver25.Creators != 1 {
		t.Errorf("creators over $25: %+v", got.CreatorsOver25)
	}
	if r := got.Retention; r.Cohort != 3 || r.Retained != 2 || r.RecordedSince == nil || time.Since(*r.RecordedSince) < 199*24*time.Hour {
		t.Errorf("retention: %+v", r)
	}
	share := (0.60/3.80 + 0.10/3.80) / 2
	if a := got.AICost; a.Members != 2 || math.Abs(a.Spend-0.70) > 1e-9 || math.Abs(a.PerMember-0.35) > 1e-9 || math.Abs(a.ShareOfCap-share) > 1e-9 {
		t.Errorf("AI cost: %+v, want share %v", a, share)
	}
}

func TestPaidSpansFollowThePlan(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	id := uuid.NewString()
	if _, e := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle,plan,plan_status,plan_interval) VALUES($1,$1||'@example.test','!','Cook',$1,'plus','active','monthly')`, id); e != nil {
		t.Fatal(e)
	}
	spans := func() string {
		t.Helper()
		var s string
		if e := db.QueryRow(ctx, `SELECT COALESCE(string_agg(CASE WHEN ended_at IS NULL THEN 'open' ELSE 'closed' END,',' ORDER BY id),'') FROM paid_spans WHERE user_id=$1`, id).Scan(&s); e != nil {
			t.Fatal(e)
		}
		return s
	}
	if got := spans(); got != "open" {
		t.Fatalf("joined paying: %s", got)
	}
	for _, step := range []struct{ sql, want string }{
		{`UPDATE users SET plan_status='past_due' WHERE id=$1`, "open"},   // Stripe is still retrying
		{`UPDATE users SET plan='pro' WHERE id=$1`, "open"},               // a change of plan isn't a new span
		{`UPDATE users SET plan_status='canceled' WHERE id=$1`, "closed"}, // stopped paying
		{`UPDATE users SET name='Ana' WHERE id=$1`, "closed"},
		{`UPDATE users SET plan='plus',plan_status='active',plan_interval='' WHERE id=$1`, "closed"}, // a complimentary plan brings nothing
		{`UPDATE users SET plan_interval='yearly' WHERE id=$1`, "closed,open"},
	} {
		if _, e := db.Exec(ctx, step.sql, id); e != nil {
			t.Fatal(e)
		}
		if got := spans(); got != step.want {
			t.Fatalf("%s: %s, want %s", step.sql, got, step.want)
		}
	}
}
