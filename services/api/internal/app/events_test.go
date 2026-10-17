package app

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestEventsKeepOnlyWhatTheyDescribe(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	post := func(tok string, body any, want int) {
		t.Helper()
		if status, b := callAPI(t, f, "POST", "/v1/events", tok, body); status != want {
			t.Fatalf("events %v: want %d, got %d: %s", body, want, status, b)
		}
	}
	at := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	post("", map[string]any{"session": "launch-1", "events": []map[string]any{
		{"name": "search", "props": map[string]any{"query": "  Lemon   PASTA ", "results": 3}, "at": at},
		{"name": "search", "props": map[string]any{"query": strings.Repeat("é", 100), "results": 0}},
		{"name": "recipe_open", "props": map[string]any{"recipeId": "tart", "from": "search", "extra": "dropped"}},
		{"name": "onboarding_step", "props": map[string]any{"step": 2}},
		{"name": "onboarding_done", "props": map[string]any{"skipped": true}, "at": "2020-01-01T00:00:00Z"},
		{"name": "studio_start", "props": map[string]any{"mode": "voice"}, "at": "yesterday"},
		// Dropped: unknown, missing or malformed properties.
		{"name": "page_view", "props": map[string]any{"path": "/"}},
		{"name": "search", "props": map[string]any{"query": "   ", "results": 1}},
		{"name": "search", "props": map[string]any{"query": "soup"}},
		{"name": "search", "props": map[string]any{"query": "soup", "results": 1.5}},
		{"name": "cook_start", "props": map[string]any{"recipeId": "has spaces"}},
		{"name": "studio_start", "props": map[string]any{"mode": "talk to me about my email alex@example.com"}},
		{"name": "share"},
		{"name": "import", "props": []string{"structured"}},
	}}, 204)
	post(cook, map[string]any{"session": "launch-2", "events": []map[string]any{{"name": "share", "props": map[string]any{"recipeId": "tart"}}}}, 204)
	post("", map[string]any{"session": "launch-3", "events": []map[string]any{}}, 204)
	for _, bad := range []any{
		map[string]any{"events": []map[string]any{{"name": "share", "props": map[string]any{"recipeId": "tart"}}}},
		map[string]any{"session": "has spaces", "events": []map[string]any{}},
		map[string]any{"session": strings.Repeat("a", 65), "events": []map[string]any{}},
		map[string]any{"session": "launch", "events": make([]map[string]any, 51)},
		map[string]any{"session": "launch", "events": "share"},
	} {
		post("", bad, 400)
	}
	rows, e := db.Query(ctx, `SELECT name,props::text,COALESCE(user_id,''),session,extract(epoch FROM now()-created_at)::int FROM events ORDER BY id`)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	got := []string{}
	ages := map[string]int{}
	for rows.Next() {
		var name, props, user, session string
		var age int
		if e = rows.Scan(&name, &props, &user, &session, &age); e != nil {
			t.Fatal(e)
		}
		got = append(got, name+" "+props+" "+user+" "+session)
		ages[name] = age
	}
	want := []string{
		`search {"query": "lemon pasta", "results": 3}  launch-1`,
		`search {"query": "` + strings.Repeat("é", 80) + `", "results": 0}  launch-1`,
		`recipe_open {"from": "search", "recipeId": "tart"}  launch-1`,
		`onboarding_step {"step": "2"}  launch-1`,
		`onboarding_done {"skipped": true}  launch-1`,
		`studio_start {"mode": "voice"}  launch-1`,
		`share {"recipeId": "tart"} cook launch-2`,
	}
	if !slices.Equal(got, want) {
		t.Fatalf("stored:\n%q\nwant\n%q", got, want)
	}
	// A recent client time is kept; one too old, or unreadable, is now.
	if ages["recipe_open"] > 60 || ages["onboarding_done"] > 60 || ages["studio_start"] > 60 {
		t.Fatalf("ages %v", ages)
	}
	var first int
	if e := db.QueryRow(ctx, `SELECT extract(epoch FROM now()-created_at)::int FROM events ORDER BY id LIMIT 1`).Scan(&first); e != nil || first < 7100 || first > 7300 {
		t.Fatalf("client time not kept: %d %v", first, e)
	}
	// Nothing about where an event came from is stored.
	var columns []string
	if e := db.QueryRow(ctx, `SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='events' AND table_schema=current_schema()`).Scan(&columns); e != nil {
		t.Fatal(e)
	}
	if !slices.Equal(columns, []string{"id", "name", "props", "user_id", "session", "created_at"}) {
		t.Fatalf("event columns %v", columns)
	}
	// Events leave after 90 days, or with their account.
	if _, e := db.Exec(ctx, `UPDATE events SET created_at=now()-interval '91 days' WHERE name='search'`); e != nil {
		t.Fatal(e)
	}
	counts, e := runJanitor(ctx, db)
	if e != nil || counts["events"] != 2 {
		t.Fatalf("janitor: %v %v", counts, e)
	}
	if _, e := db.Exec(ctx, `DELETE FROM users WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	if n := count(t, db, `SELECT count(*) FROM events`); n != 4 {
		t.Fatalf("%d events left", n)
	}
}

func TestAdminInsights(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	ctx := context.Background()
	f := adminApp(db, false)
	owner, ownerTok := signedIn(t, db, "owner@example.test", true)
	_, memberTok := signedIn(t, db, "member@example.test", true)
	if status, _ := send(t, f, "GET", "/v1/admin/insights", memberTok, nil); status != 403 {
		t.Fatalf("member: %d", status)
	}
	event := func(name, props, user, session string, daysAgo int) {
		t.Helper()
		if _, e := db.Exec(ctx, `INSERT INTO events(name,props,user_id,session,created_at) VALUES($1,$2::jsonb,NULLIF($3,''),$4,now()-$5*interval '1 day')`, name, props, user, session, daysAgo); e != nil {
			t.Fatal(e)
		}
	}
	for range 3 {
		event("search", `{"query":"lemon pasta","results":4}`, "", "s1", 1)
	}
	event("search", `{"query":"natto","results":0}`, "", "s2", 2)
	event("search", `{"query":"natto","results":0}`, "", "s3", 2)
	event("search", `{"query":"okra","results":0}`, "", "s3", 3)
	event("search", `{"query":"borscht","results":2}`, "", "s4", 20)
	// Setup steps count people: a step seen twice by one member counts once.
	event("onboarding_step", `{"step":"photo"}`, owner, "s5", 1)
	event("onboarding_step", `{"step":"photo"}`, owner, "s6", 1)
	event("onboarding_step", `{"step":"photo"}`, "", "s7", 1)
	event("onboarding_step", `{"step":"tastes"}`, owner, "s5", 1)
	event("onboarding_done", `{"skipped":false}`, owner, "s5", 1)
	event("onboarding_done", `{"skipped":true}`, "", "s7", 1)
	event("share", `{"recipeId":"tart"}`, "", "s8", 40)
	type counted struct {
		Query, Step, Name string
		Count             int
	}
	var out struct {
		Days                                                int
		TopSearches, ZeroResultSearches, Onboarding, Events []counted
	}
	insights := func(query string) {
		t.Helper()
		status, b := send(t, f, "GET", "/v1/admin/insights"+query, ownerTok, nil)
		out.TopSearches, out.ZeroResultSearches, out.Onboarding, out.Events = nil, nil, nil, nil
		if status != 200 || json.Unmarshal(b, &out) != nil {
			t.Fatalf("insights%s: %d %s", query, status, b)
		}
	}
	show := func(list []counted) string {
		parts := []string{}
		for _, c := range list {
			parts = append(parts, c.Query+c.Step+c.Name+"="+strings.Repeat("|", c.Count))
		}
		return strings.Join(parts, " ")
	}
	insights("")
	if out.Days != 7 || show(out.TopSearches) != "lemon pasta=||| natto=|| okra=|" || show(out.ZeroResultSearches) != "natto=|| okra=|" {
		t.Fatalf("searches: %d %s / %s", out.Days, show(out.TopSearches), show(out.ZeroResultSearches))
	}
	if got := show(out.Onboarding); got != "photo=|| tastes=| done=| skipped=|" {
		t.Fatalf("onboarding: %s", got)
	}
	if got := show(out.Events); got != "search=|||||| onboarding_step=|||| onboarding_done=||" {
		t.Fatalf("events: %s", got)
	}
	insights("?days=30")
	if out.Days != 30 || show(out.TopSearches) != "lemon pasta=||| natto=|| borscht=| okra=|" || !strings.Contains(show(out.Events), "search=|||||||") {
		t.Fatalf("30 days: %s / %s", show(out.TopSearches), show(out.Events))
	}
	if status, _ := send(t, f, "GET", "/v1/admin/insights?days=90", ownerTok, nil); status != 400 {
		t.Fatalf("90 days: %d", status)
	}
	if _, e := db.Exec(ctx, `DELETE FROM events`); e != nil {
		t.Fatal(e)
	}
	status, b := send(t, f, "GET", "/v1/admin/insights", ownerTok, nil)
	if status != 200 || string(b) != `{"days": 7, "events": [], "onboarding": [], "topSearches": [], "zeroResultSearches": []}` {
		t.Fatalf("empty: %d %s", status, b)
	}
}
