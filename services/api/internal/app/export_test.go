package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestExportHoldsEverythingTheAccountOwns(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	ctx := context.Background()
	id := member(t, db, "exporter@example.test")
	other := member(t, db, "other@example.test")
	tok := deviceSession(t, db, id, phoneUA, 20*24*time.Hour)
	published := testRecipe(t, db, id, "My published pasta", true)
	testRecipe(t, db, id, "My secret draft", false)
	theirs := testRecipe(t, db, other, "Their lovely soup", true)
	testRecipe(t, db, other, "Their own draft", false)
	for _, sql := range []string{
		`INSERT INTO identities(provider,subject,user_id,email,refresh_token) VALUES('apple','apple-subject-123','` + id + `','relay@example.test','apple-refresh-secret')`,
		`INSERT INTO collections(id,user_id,name) VALUES('cb1','` + id + `','Weeknights')`,
		`INSERT INTO saves(user_id,recipe_id,collection_id) VALUES('` + id + `','` + theirs + `','cb1')`,
		`INSERT INTO reviews(id,user_id,recipe_id,rating,body) VALUES('rv1','` + id + `','` + theirs + `',5,'Lovely and bright.')`,
		`INSERT INTO reviews(id,user_id,recipe_id,rating,body) VALUES('rv2','` + other + `','` + published + `',4,'A review by someone else.')`,
		`INSERT INTO follows(user_id,creator_id) VALUES('` + id + `','` + other + `')`,
		`INSERT INTO meal_plans(id,user_id,recipe_id,day,meal,servings) VALUES('mp1','` + id + `','` + theirs + `','2026-10-20','Dinner',2)`,
		`INSERT INTO groceries(id,user_id,name,quantity) VALUES('g1','` + id + `','Lemons','3')`,
		`INSERT INTO pantry(id,user_id,name,quantity,expires_on) VALUES('p1','` + id + `','Ricotta','250 g','2026-10-25')`,
		`INSERT INTO voice_projects(id,user_id) VALUES('vp1','` + id + `')`,
		`INSERT INTO voice_projects(id,user_id,deleted_at) VALUES('vp-gone','` + id + `',now())`,
		`INSERT INTO comments(id,recipe_id,user_id,body) VALUES('c1','` + theirs + `','` + id + `','Lovely with extra lemon.')`,
		`INSERT INTO comments(id,recipe_id,user_id,body) VALUES('c2','` + published + `','` + other + `','A comment by someone else.')`,
		`INSERT INTO cooks(id,user_id,recipe_id,note) VALUES('k1','` + id + `','` + theirs + `','Made it twice.')`,
		`INSERT INTO households(id,name) VALUES('h1','The Smiths')`,
		`INSERT INTO household_members(user_id,household_id,role) VALUES('` + id + `','h1','owner')`,
		`INSERT INTO push_tokens(token,user_id,platform) VALUES('ExponentPushToken[secret-device]','` + id + `','ios')`,
		`INSERT INTO events(name,props,user_id,session) VALUES('search','{"query":"lemon","results":3}','` + id + `','s1')`,
		`INSERT INTO ai_jobs(id,user_id,kind,prompt,status,request_key,result) VALUES('j1','` + id + `','recipe','A bright lemon pasta','completed','k1','{"secret":"model output"}')`,
	} {
		if _, e := db.Exec(ctx, sql); e != nil {
			t.Fatalf("%s: %v", sql, e)
		}
	}
	if _, e := db.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,reserved_seconds,expires_at) VALUES('vs1','vp1',$1,0,now())`, id); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content,images) VALUES('vp1','vs1','e1','user','What can I cook with lemons?','["https://img.example.test/private.jpg"]')`); e != nil {
		t.Fatal(e)
	}

	r := must(t, f, 200, call{method: "GET", path: "/v1/me/export", bearer: tok})
	if d := r.header.Get("Content-Disposition"); !strings.HasPrefix(d, `attachment; filename="savorly-export-`) || r.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("headers: %v", r.header)
	}
	var doc struct {
		Format              string
		Profile             map[string]any
		Preferences         map[string]any
		Plan                map[string]any
		ConnectedProviders  []map[string]any
		Recipes             []map[string]any
		Reviews             []map[string]any
		Cookbooks           []map[string]any
		Comments            []map[string]any
		Cooked              []map[string]any
		Household           map[string]any
		Devices             []map[string]any
		NotificationDevices []map[string]any
		UsageEvents         []map[string]any
		Saves               []map[string]any
		Following           []map[string]any
		MealPlans           []map[string]any
		Groceries           []map[string]any
		Pantry              []map[string]any
		StudioConversations []struct {
			Messages []map[string]any
		}
		AIJobs []map[string]any `json:"aiJobs"`
	}
	if e := json.Unmarshal(r.body, &doc); e != nil {
		t.Fatal(e)
	}
	titles := map[string]bool{}
	for _, recipe := range doc.Recipes {
		titles[recipe["title"].(string)] = true
	}
	switch {
	case doc.Format != "savorly-export" || doc.Profile["email"] != "exporter@example.test" || doc.Profile["hasPassword"] != true || doc.Preferences == nil || doc.Plan["plan"] != "free":
		t.Fatalf("profile: %s %v %v %v", doc.Format, doc.Profile, doc.Preferences, doc.Plan)
	case len(doc.ConnectedProviders) != 1 || doc.ConnectedProviders[0]["provider"] != "apple":
		t.Fatalf("providers: %v", doc.ConnectedProviders)
	case len(doc.Recipes) != 2 || !titles["My published pasta"] || !titles["My secret draft"]:
		t.Fatalf("recipes: %v", titles)
	case len(doc.Reviews) != 1 || doc.Reviews[0]["body"] != "Lovely and bright." || doc.Reviews[0]["recipeTitle"] != "Their lovely soup":
		t.Fatalf("reviews: %v", doc.Reviews)
	case len(doc.Cookbooks) != 1 || len(doc.Saves) != 1 || doc.Saves[0]["cookbookId"] != "cb1":
		t.Fatalf("cookbooks %v saves %v", doc.Cookbooks, doc.Saves)
	case len(doc.Comments) != 1 || doc.Comments[0]["body"] != "Lovely with extra lemon." || len(doc.Cooked) != 1 || doc.Cooked[0]["note"] != "Made it twice.":
		t.Fatalf("comments %v cooked %v", doc.Comments, doc.Cooked)
	case doc.Household["name"] != "The Smiths" || doc.Household["role"] != "owner" || len(doc.Devices) != 1 || len(doc.NotificationDevices) != 1 || doc.NotificationDevices[0]["platform"] != "ios" || len(doc.UsageEvents) != 1:
		t.Fatalf("household %v devices %v notification devices %v events %v", doc.Household, doc.Devices, doc.NotificationDevices, doc.UsageEvents)
	case doc.Cookbooks[0]["public"] != false:
		t.Fatalf("cookbook sharing: %v", doc.Cookbooks)
	case len(doc.Following) != 1 || doc.Following[0]["id"] != other:
		t.Fatalf("following: %v", doc.Following)
	case len(doc.MealPlans) != 1 || len(doc.Groceries) != 1 || len(doc.Pantry) != 1 || doc.Pantry[0]["expiresOn"] != "2026-10-25":
		t.Fatalf("kitchen: %v %v %v", doc.MealPlans, doc.Groceries, doc.Pantry)
	case len(doc.StudioConversations) != 1 || len(doc.StudioConversations[0].Messages) != 1 || doc.StudioConversations[0].Messages[0]["text"] != "What can I cook with lemons?":
		t.Fatalf("studio: %v", doc.StudioConversations)
	case len(doc.AIJobs) != 1 || doc.AIJobs[0]["prompt"] != "A bright lemon pasta" || doc.AIJobs[0]["kind"] != "recipe" || doc.AIJobs[0]["status"] != "completed":
		t.Fatalf("jobs: %v", doc.AIJobs)
	}
	var hash string
	if e := db.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1`, id).Scan(&hash); e != nil {
		t.Fatal(e)
	}
	for _, secret := range []string{hash, "apple-refresh-secret", "Their own draft", "A review by someone else.", "A comment by someone else.", "vp-gone", "secret-device", "private.jpg", "model output", "apple-subject-123"} {
		if strings.Contains(string(r.body), secret) {
			t.Errorf("export contains %q", secret)
		}
	}

	// Native apps hand a single-use link to the browser, which carries no credentials.
	link := must(t, f, 200, call{method: "POST", path: "/v1/me/export-link", bearer: tok}).object(t)
	url, _ := link["url"].(string)
	if !strings.HasPrefix(url, "/v1/export/") || link["expiresAt"] == nil {
		t.Fatalf("link: %v", link)
	}
	must(t, f, 200, call{method: "HEAD", path: url})
	if got := must(t, f, 200, call{method: "GET", path: url}); !strings.Contains(string(got.body), "My secret draft") || got.header.Get("Content-Disposition") == "" {
		t.Fatalf("download: %s", got.body)
	}
	if r := must(t, f, 404, call{method: "GET", path: url}); r.message() == "" {
		t.Fatal("no message for a spent link")
	}
	// A new link replaces the last, and links expire.
	first := must(t, f, 200, call{method: "POST", path: "/v1/me/export-link", bearer: tok}).object(t)["url"].(string)
	second := must(t, f, 200, call{method: "POST", path: "/v1/me/export-link", bearer: tok}).object(t)["url"].(string)
	must(t, f, 404, call{method: "GET", path: first})
	if _, e := db.Exec(ctx, `UPDATE export_tokens SET expires_at=now()-interval '1 second'`); e != nil {
		t.Fatal(e)
	}
	must(t, f, 404, call{method: "GET", path: second})
	must(t, f, 404, call{method: "GET", path: "/v1/export/not-a-token"})
	must(t, f, 401, call{method: "POST", path: "/v1/me/export-link"})
}
