package app

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCookAlongWeekStartsOnMonday(t *testing.T) {
	for at, want := range map[string]string{
		"2026-10-12T00:00:00Z":      "2026-10-12", // a Monday
		"2026-10-17T15:04:05Z":      "2026-10-12", // Saturday
		"2026-10-18T23:59:59Z":      "2026-10-12", // the week's last second
		"2026-10-19T01:00:00+03:00": "2026-10-12", // still Sunday in UTC
		"2027-01-01T08:00:00Z":      "2026-12-28", // across a year
	} {
		parsed, e := time.Parse(time.RFC3339, at)
		if e != nil {
			t.Fatal(e)
		}
		if got := cookAlongWeek(parsed).Format(time.DateOnly); got != want {
			t.Errorf("%s: week of %s, want %s", at, got, want)
		}
	}
}

// founder makes a member a founding creator, marked at the given time.
func founder(t *testing.T, db *pgxpool.Pool, id string, at time.Time) {
	t.Helper()
	if _, e := db.Exec(context.Background(), `UPDATE users SET founding_creator_at=$2 WHERE id=$1`, id, at); e != nil {
		t.Fatal(e)
	}
}

// save adds saves of a recipe by that many sample members.
func save(t *testing.T, db *pgxpool.Pool, recipe string, n int) {
	t.Helper()
	for i := range n {
		id := recipe + "-fan-" + string(rune('a'+i))
		testUser(t, db, id)
		if _, e := db.Exec(context.Background(), `INSERT INTO saves(user_id,recipe_id) VALUES($1,$2)`, id, recipe); e != nil {
			t.Fatal(e)
		}
	}
}

type cookAlongList struct {
	Week, AnnouncedWeek string
	Next                *string
	Weeks               []struct {
		Week, ScheduledBy string
		Automatic         bool
		Cooks, Started    int
		Recipe            *struct {
			ID, Title string
			Author    struct {
				ID       string
				Founding bool
			}
		}
	}
	Rotation []struct {
		ID       string
		LastWeek *string
		Recipes  []struct {
			ID        string
			SaveCount int
		}
	}
}

func TestCookAlongScheduling(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	ownerID, owner := signedIn(t, db, "owner@example.test", true)
	adminID, admin := signedIn(t, db, "admin@example.test", true)
	_, cook := signedIn(t, db, "cook@example.test", true)
	if _, e := db.Exec(ctx, `UPDATE users SET admin=true WHERE id=$1`, adminID); e != nil {
		t.Fatal(e)
	}
	for _, id := range []string{"maya", "tom", "gone", "plain", "banned"} {
		testUser(t, db, id)
	}
	founder(t, db, "maya", time.Now().Add(-48*time.Hour))
	founder(t, db, "tom", time.Now().Add(-24*time.Hour))
	founder(t, db, "gone", time.Now().Add(-72*time.Hour))
	mayaSoup, mayaTart, mayaDraft := testRecipe(t, db, "maya", "Soup", true), testRecipe(t, db, "maya", "Tart", true), testRecipe(t, db, "maya", "Draft", false)
	tomStew := testRecipe(t, db, "tom", "Stew", true)
	plain := testRecipe(t, db, "plain", "Plain", true)
	banned := testRecipe(t, db, "banned", "Banned", true)
	adminOwn, ownerOwn := testRecipe(t, db, adminID, "Mine", true), testRecipe(t, db, ownerID, "Owner's", true)
	save(t, db, mayaTart, 2)
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id IN ('gone','banned')`); e != nil {
		t.Fatal(e)
	}
	list := func(tok string) cookAlongList {
		t.Helper()
		_, b := send(t, f, "GET", "/v1/admin/cook-alongs", tok, nil)
		var out cookAlongList
		if e := json.Unmarshal(b, &out); e != nil {
			t.Fatalf("%v: %s", e, b)
		}
		return out
	}
	week := cookAlongWeek(time.Now())
	path := func(w time.Time) string { return "/v1/admin/cook-alongs/" + w.Format(time.DateOnly) }

	// Founding creators take turns: never featured first, by when they were marked; a suspended one
	// isn't offered. Each comes with their most saved public recipes.
	got := list(owner)
	if got.Week != week.Format(time.DateOnly) || len(got.Weeks) != 0 || got.Next == nil || *got.Next != "maya" || len(got.Rotation) != 2 || got.Rotation[1].ID != "tom" {
		t.Fatalf("before any slot: %+v", got)
	}
	if r := got.Rotation[0].Recipes; len(r) != 2 || r[0].ID != mayaTart || r[0].SaveCount != 2 || r[1].ID != mayaSoup {
		t.Fatalf("maya's recipes: %+v", r)
	}
	expect(t, f, 403, "GET", "/v1/admin/cook-alongs", cook, nil)
	expect(t, f, 403, "PUT", path(week), cook, map[string]any{"recipeId": mayaSoup})

	// One recipe a week: scheduling the week again replaces it, and both are audited.
	expect(t, f, 200, "PUT", path(week), owner, map[string]any{"recipeId": mayaTart})
	got = list(owner)
	if len(got.Weeks) != 1 || got.Weeks[0].Recipe == nil || got.Weeks[0].Recipe.ID != mayaTart || !got.Weeks[0].Recipe.Author.Founding || got.Weeks[0].ScheduledBy != "owner@example.test" {
		t.Fatalf("scheduled: %+v", got.Weeks)
	}
	if got.Next == nil || *got.Next != "tom" || got.Rotation[1].LastWeek == nil || *got.Rotation[1].LastWeek != week.Format(time.DateOnly) {
		t.Fatalf("after maya's slot: %+v", got)
	}
	if got := expect(t, f, 409, "PUT", path(week), owner, map[string]any{"recipeId": mayaTart}); got["error"] != "This recipe is already that week's cook-along." {
		t.Fatalf("same recipe again: %v", got)
	}
	expect(t, f, 200, "PUT", path(week), admin, map[string]any{"recipeId": tomStew})
	if n := count(t, db, `SELECT count(*) FROM cook_alongs`); n != 1 {
		t.Fatalf("%d cook-alongs for one week", n)
	}
	var detail map[string]any
	if e := db.QueryRow(ctx, `SELECT detail FROM admin_actions WHERE action='cookalong.schedule' AND target_id=$1`, tomStew).Scan(&detail); e != nil || detail["previousRecipeId"] != mayaTart || detail["week"] != week.Format(time.DateOnly) {
		t.Fatalf("audit detail %v %v", detail, e)
	}
	// Maya keeps her turn's date though Tom's recipe replaced hers: whose turn it was is the
	// scheduled weeks, so she goes first again.
	if got := list(owner); *got.Next != "maya" {
		t.Fatalf("after the replacement: next is %s", *got.Next)
	}
	expect(t, f, 200, "PUT", path(week.AddDate(0, 0, 7)), owner, map[string]any{"recipeId": plain})

	// What can't be the cook-along, and who can't schedule it.
	for _, c := range []struct {
		path, tok, recipe string
		status            int
		error             string
	}{
		{"/v1/admin/cook-alongs/" + week.AddDate(0, 0, 1).Format(time.DateOnly), owner, mayaSoup, 400, "Name the week by its Monday, as YYYY-MM-DD."},
		{"/v1/admin/cook-alongs/next-week", owner, mayaSoup, 400, "Name the week by its Monday, as YYYY-MM-DD."},
		{path(week.AddDate(0, 0, -7)), owner, mayaSoup, 400, "That week is over. Choose this week or a later one."},
		{path(week.AddDate(0, 0, 7*60)), owner, mayaSoup, 400, "Schedule a cook-along up to a year ahead."},
		{path(week), owner, "", 400, "Choose a recipe."},
		{path(week), owner, "missing", 404, "Recipe not found."},
		{path(week), owner, mayaDraft, 409, "Only a public recipe can be the cook-along."},
		{path(week), owner, banned, 409, "This recipe's author is suspended, so it can't be the cook-along."},
		{path(week), admin, adminOwn, 403, "Another admin has to decide this for your own recipe."},
		{path(week), admin, ownerOwn, 403, "Only an owner can moderate an owner's or another admin's content."},
	} {
		if got := expect(t, f, c.status, "PUT", c.path, c.tok, map[string]any{"recipeId": c.recipe}); got["error"] != c.error {
			t.Errorf("%s %s: %v", c.path, c.recipe, got)
		}
	}
	// An owner decides an owner's own recipe.
	expect(t, f, 200, "PUT", path(week.AddDate(0, 0, 14)), owner, map[string]any{"recipeId": ownerOwn})

	expect(t, f, 200, "DELETE", path(week.AddDate(0, 0, 14)), owner, nil)
	expect(t, f, 404, "DELETE", path(week.AddDate(0, 0, 14)), owner, nil)
	expect(t, f, 400, "DELETE", path(week.AddDate(0, 0, -7)), owner, nil)
	if got := auditActions(t, db); got != "cookalong.schedule,cookalong.schedule,cookalong.schedule,cookalong.schedule,cookalong.unschedule" {
		t.Fatalf("audit: %s", got)
	}
	var summary string
	if e := db.QueryRow(ctx, `SELECT summary FROM admin_actions WHERE action='cookalong.unschedule'`).Scan(&summary); e != nil || summary != "Removed “Owner's” as the cook-along for the week of "+week.AddDate(0, 0, 14).Format("2 January 2006") {
		t.Fatalf("summary %q %v", summary, e)
	}
	// A deleted recipe leaves its week empty, and its creator's turn still counts.
	if _, e := db.Exec(ctx, `DELETE FROM recipes WHERE id=$1`, tomStew); e != nil {
		t.Fatal(e)
	}
	got = list(owner)
	if got.Weeks[0].Recipe != nil || got.Rotation[0].ID != "maya" || got.Rotation[1].LastWeek == nil {
		t.Fatalf("after deleting the recipe: %+v", got)
	}
}

func TestCookAlongOnHome(t *testing.T) {
	db := isolatedDB(t)
	f := recipesApp(db, false)
	ctx := context.Background()
	for _, id := range []string{"maya", "a", "b", "c", "d"} {
		namedUser(t, db, id, strings.ToUpper(id))
	}
	founder(t, db, "maya", time.Now())
	recipe := testRecipe(t, db, "maya", "Shakshuka", true)
	type home struct {
		CookAlong *struct {
			Week           string
			Cooks, Started int
			Recipe         struct {
				ID, Title string
				Author    struct{ Founding bool }
			}
		}
		Trending []struct{ ID string }
	}
	feed := func() home {
		t.Helper()
		status, b := callAPI(t, f, "GET", "/v1/feed", "", nil)
		var out home
		if status != 200 || json.Unmarshal(b, &out) != nil {
			t.Fatalf("feed: %d %s", status, b)
		}
		return out
	}
	if got := feed(); got.CookAlong != nil || len(got.Trending) != 1 {
		t.Fatalf("no cook-along yet: %+v", got)
	}
	week := cookAlongWeek(time.Now())
	if _, e := db.Exec(ctx, `INSERT INTO cook_alongs(week,recipe_id,creator_id) VALUES($1,$2,'maya'),($3,$2,'maya')`, week, recipe, week.AddDate(0, 0, -7)); e != nil {
		t.Fatal(e)
	}
	// This week: two verified cooks; a and b finished, c only started (twice), d cooked it last
	// week. Started counts members, so b's second session doesn't add one.
	during := week.Add(time.Since(week) / 2)
	verifiedCook(t, db, "a", recipe, during, 0)
	verifiedCook(t, db, "b", recipe, during, 859)
	verifiedCook(t, db, "d", recipe, week.Add(-time.Hour), 0)
	if _, e := db.Exec(ctx, `INSERT INTO cook_sessions(id,user_id,recipe_id,steps,started_at) VALUES('c1','c',$1,1,$2),('c2','c',$1,1,$2),('b2','b',$1,1,$2)`, recipe, during); e != nil {
		t.Fatal(e)
	}
	got := feed()
	if got.CookAlong == nil || got.CookAlong.Week != week.Format(time.DateOnly) || got.CookAlong.Recipe.ID != recipe || !got.CookAlong.Recipe.Author.Founding ||
		got.CookAlong.Cooks != 2 || got.CookAlong.Started != 3 {
		t.Fatalf("cook-along: %+v", got.CookAlong)
	}
	// Only while the recipe is public and its author in good standing.
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id='maya'`); e != nil {
		t.Fatal(e)
	}
	if got := feed(); got.CookAlong != nil {
		t.Fatalf("suspended author: %+v", got.CookAlong)
	}
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=NULL WHERE id='maya'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=false WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	if got := feed(); got.CookAlong != nil {
		t.Fatalf("unpublished recipe: %+v", got.CookAlong)
	}
}

func TestCookAlongIsAnnouncedOnce(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	hour := cookAlongHour
	t.Cleanup(func() { cookAlongHour = hour })
	namedUser(t, db, "chef", "Ana")
	for _, u := range []string{"fan_en", "fan_fr", "fan_ja", "quiet", "banned", "offline"} {
		namedUser(t, db, u, "Fan")
		if u != "offline" {
			registerDevice(t, db, u)
		}
	}
	registerDevice(t, db, "chef")
	setPreferences(t, db, "fan_fr", `{"language":"fr"}`)
	setPreferences(t, db, "fan_ja", `{"language":"ja"}`)
	setPreferences(t, db, "quiet", `{"notifications":{"cookAlong":false}}`)
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id='banned'`); e != nil {
		t.Fatal(e)
	}
	publishRecipe(t, db, "chef", "tart", func(r *RecipeInput) { r.Title = "Lemon tart" })
	publishRecipe(t, db, "chef", "pie", func(r *RecipeInput) { r.Title = "Apple pie" })
	expo := newFakeExpo(t)
	n := expo.notifier(db)
	drain(t, n) // the recipes' own announcements to followers: there are none
	pass := func(want bool) {
		t.Helper()
		got, e := n.cookAlongPass(ctx)
		if e != nil || got != want {
			t.Fatalf("cook-along pass: %v %v, want %v", got, e, want)
		}
		drain(t, n)
	}
	// Nothing scheduled: nothing to say, and the week isn't claimed.
	cookAlongHour = 0
	pass(false)
	week := cookAlongWeek(time.Now())
	if _, e := db.Exec(ctx, `INSERT INTO cook_alongs(week,recipe_id,creator_id) VALUES($1,'tart','chef')`, week); e != nil {
		t.Fatal(e)
	}
	// Not before the hour on the week's Monday.
	cookAlongHour = 24 * 7
	pass(false)
	cookAlongHour = 0
	pass(true)
	sent := expo.sent()
	want := map[string][2]string{
		deviceToken("fan_en"): {"This week’s cook-along", "Lemon tart by Ana. Cook it with everyone this week."},
		deviceToken("fan_fr"): {"La recette à cuisiner ensemble cette semaine", "Lemon tart de Ana. Cuisinez-la avec tout le monde cette semaine."},
		deviceToken("fan_ja"): {"今週のみんなで作るレシピ", "Anaさんの「Lemon tart」。今週はみんなで一緒に作りましょう。"},
	}
	if len(sent) != len(want) {
		t.Fatalf("sent to %d devices: %v", len(sent), sent)
	}
	for token, text := range want {
		m := sent[token]
		if len(m) != 1 || m[0].Title != text[0] || m[0].Body != text[1] || !maps.Equal(payload(m[0]), map[string]string{"type": "recipe", "recipeId": "tart"}) {
			t.Errorf("%s: %+v", token, m)
		}
	}
	// Once a week: another pass, or another recipe for the same week, says nothing more.
	pass(false)
	if _, e := db.Exec(ctx, `UPDATE cook_alongs SET recipe_id='pie' WHERE week=$1`, week); e != nil {
		t.Fatal(e)
	}
	pass(false)
	if got := len(expo.requestSizes()); got != 1 {
		t.Fatalf("%d requests to Expo", got)
	}
	if n := count(t, db, `SELECT count(*) FROM notification_outbox WHERE kind='cookalong' AND ref_id=$1`, week.Format(time.DateOnly)); n != 1 {
		t.Fatalf("%d cook-along notices", n)
	}
}

func TestCookAlongNoticeInEveryLanguage(t *testing.T) {
	v := noticeVars{Name: "Ana", Title: "Lemon tart"}
	for language := range recipeLanguages {
		title, body := notice("cookalong", language, v)
		if title == "" || !strings.Contains(body, "Ana") || !strings.Contains(body, "Lemon tart") || strings.Contains(title+body, "{") {
			t.Errorf("%s: %q %q", language, title, body)
		}
	}
}

func TestCookAlongRotationFillsOpenWeeks(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	hour := cookAlongHour
	t.Cleanup(func() { cookAlongHour = hour })
	cookAlongHour = 24 * 7 // nothing is announced here
	_, owner := signedIn(t, db, "owner@example.test", true)
	for _, id := range []string{"maya", "tom", "ines", "plain"} {
		testUser(t, db, id)
	}
	n := newFakeExpo(t).notifier(db)
	week := cookAlongWeek(time.Now())
	type slot struct {
		recipe, creator string
		automatic       bool
	}
	this := func() *slot {
		t.Helper()
		var s slot
		var recipe *string
		e := db.QueryRow(ctx, `SELECT recipe_id,COALESCE(creator_id,''),automatic FROM cook_alongs WHERE week=$1`, week).Scan(&recipe, &s.creator, &s.automatic)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e != nil {
			t.Fatal(e)
		}
		if recipe != nil {
			s.recipe = *recipe
		}
		return &s
	}
	pass := func() *slot {
		t.Helper()
		if _, e := n.cookAlongPass(ctx); e != nil {
			t.Fatal(e)
		}
		return this()
	}
	// No founding creators, or none with a public recipe: the week stays open.
	plain := testRecipe(t, db, "plain", "Plain", true)
	founder(t, db, "ines", time.Now().Add(-96*time.Hour))
	testRecipe(t, db, "ines", "Draft", false)
	if got := pass(); got != nil {
		t.Fatalf("no one to feature: %+v", got)
	}
	// The first founding creator in line, with their most saved recipe.
	founder(t, db, "maya", time.Now().Add(-48*time.Hour))
	founder(t, db, "tom", time.Now().Add(-24*time.Hour))
	soup, tart := testRecipe(t, db, "maya", "Soup", true), testRecipe(t, db, "maya", "Tart", true)
	stew := testRecipe(t, db, "tom", "Stew", true)
	save(t, db, tart, 3)
	save(t, db, soup, 1)
	if got := pass(); got == nil || *got != (slot{tart, "maya", true}) {
		t.Fatalf("filled: %+v", got)
	}
	var home struct {
		CookAlong *struct{ Recipe struct{ ID string } }
	}
	if status, b := callAPI(t, f, "GET", "/v1/feed", "", nil); status != 200 || json.Unmarshal(b, &home) != nil || home.CookAlong == nil || home.CookAlong.Recipe.ID != tart {
		t.Fatalf("home: %d %s", status, b)
	}
	// Once filled, later passes leave it.
	if got := pass(); got == nil || got.recipe != tart {
		t.Fatalf("second pass: %+v", got)
	}
	// A week whose recipe stops being public goes back to the rotation: Maya had her turn, so Tom.
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=false WHERE id=$1`, tart); e != nil {
		t.Fatal(e)
	}
	if got := pass(); got == nil || *got != (slot{stew, "tom", true}) {
		t.Fatalf("after unpublishing: %+v", got)
	}
	// The console names whose turn is next and what the rotation would pick: Ines has no public
	// recipe, so Maya, with the recipe she hasn't been featured with yet.
	_, b := send(t, f, "GET", "/v1/admin/cook-alongs", owner, nil)
	var list cookAlongList
	if e := json.Unmarshal(b, &list); e != nil {
		t.Fatal(e)
	}
	if list.Next == nil || *list.Next != "maya" || len(list.Rotation) != 3 || list.Rotation[0].ID != "ines" || list.Rotation[1].ID != "maya" ||
		len(list.Rotation[1].Recipes) != 1 || list.Rotation[1].Recipes[0].ID != soup {
		t.Fatalf("rotation: %s", b)
	}
	if len(list.Weeks) != 1 || !list.Weeks[0].Automatic || list.Weeks[0].ScheduledBy != "" {
		t.Fatalf("weeks: %+v", list.Weeks)
	}
	// An admin's pick replaces the rotation's, and the rotation leaves it, even the same recipe
	// confirmed.
	expect(t, f, 200, "PUT", "/v1/admin/cook-alongs/"+week.Format(time.DateOnly), owner, map[string]any{"recipeId": stew})
	if got := pass(); got == nil || *got != (slot{stew, "tom", false}) {
		t.Fatalf("confirmed: %+v", got)
	}
	expect(t, f, 200, "PUT", "/v1/admin/cook-alongs/"+week.Format(time.DateOnly), owner, map[string]any{"recipeId": plain})
	if got := pass(); got == nil || *got != (slot{plain, "plain", false}) {
		t.Fatalf("an admin's pick: %+v", got)
	}
	// Clearing the week hands it back: Maya's turn, now with the soup.
	expect(t, f, 200, "DELETE", "/v1/admin/cook-alongs/"+week.Format(time.DateOnly), owner, nil)
	if got := pass(); got == nil || *got != (slot{soup, "maya", true}) {
		t.Fatalf("cleared: %+v", got)
	}
	// Suspended founding creators are skipped, and a week scheduled ahead counts as a turn taken.
	if _, e := db.Exec(ctx, `DELETE FROM cook_alongs; UPDATE users SET suspended_at=now() WHERE id='maya'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=true WHERE author_id='ines'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO cook_alongs(week,recipe_id,creator_id) SELECT $1,id,'ines' FROM recipes WHERE author_id='ines'`, week.AddDate(0, 0, 7)); e != nil {
		t.Fatal(e)
	}
	if got := pass(); got == nil || *got != (slot{stew, "tom", true}) {
		t.Fatalf("with ines scheduled ahead: %+v", got)
	}
}

func TestFoundingCreatorsAreMarkedByAdmins(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	adminID, admin := signedIn(t, db, "admin@example.test", true)
	otherID, _ := signedIn(t, db, "other-admin@example.test", true)
	creatorID, creator := signedIn(t, db, "creator@example.test", true)
	if _, e := db.Exec(ctx, `UPDATE users SET admin=true WHERE id IN ($1,$2)`, adminID, otherID); e != nil {
		t.Fatal(e)
	}
	recipe := testRecipe(t, db, creatorID, "Shakshuka", true)
	path := "/v1/admin/users/" + creatorID + "/founding"
	founding := func() (me, author, profile bool) {
		t.Helper()
		var out struct {
			Founding bool
			Author   struct{ Founding bool }
		}
		for _, x := range []struct {
			path string
			into *bool
			read func() bool
		}{
			{"/v1/me", &me, func() bool { return out.Founding }},
			{"/v1/recipes/" + recipe, &author, func() bool { return out.Author.Founding }},
			{"/v1/creators/" + creatorID, &profile, func() bool { return out.Founding }},
		} {
			out.Founding, out.Author.Founding = false, false
			if status, b := send(t, f, "GET", x.path, creator, nil); status != 200 || json.Unmarshal(b, &out) != nil {
				t.Fatalf("%s: %d %s", x.path, status, b)
			}
			*x.into = x.read()
		}
		return
	}
	if me, author, profile := founding(); me || author || profile {
		t.Fatal("marked before an admin did it")
	}
	expect(t, f, 403, "PUT", path, creator, map[string]any{"founding": true})
	record := expect(t, f, 200, "PUT", path, admin, map[string]any{"founding": true})
	if record["foundingCreatorAt"] == nil {
		t.Fatalf("record: %v", record)
	}
	if me, author, profile := founding(); !me || !author || !profile {
		t.Fatalf("marked: me %v, author line %v, profile %v", me, author, profile)
	}
	if got := expect(t, f, 409, "PUT", path, owner, map[string]any{"founding": true}); got["error"] != "This member is already a founding creator." {
		t.Fatalf("again: %v", got)
	}
	// The console finds them, and the rank rule applies: no one marks themselves, and only an
	// owner marks an admin.
	list := expect(t, f, 200, "GET", "/v1/admin/users?filter=founding", owner, nil)
	if got := items(list); len(got) != 1 || got[0].(map[string]any)["id"] != creatorID {
		t.Fatalf("founding filter: %v", list)
	}
	expect(t, f, 400, "PUT", "/v1/admin/users/"+adminID+"/founding", admin, map[string]any{"founding": true})
	expect(t, f, 403, "PUT", "/v1/admin/users/"+otherID+"/founding", admin, map[string]any{"founding": true})
	expect(t, f, 200, "PUT", "/v1/admin/users/"+otherID+"/founding", owner, map[string]any{"founding": true})
	expect(t, f, 200, "PUT", path, admin, map[string]any{"founding": false})
	if got := expect(t, f, 409, "PUT", path, admin, map[string]any{"founding": false}); got["error"] != "This member isn't a founding creator." {
		t.Fatalf("removed again: %v", got)
	}
	if me, author, profile := founding(); me || author || profile {
		t.Fatal("still marked after removing it")
	}
	if got := auditActions(t, db); got != "member.founding,member.founding,member.unfounding" {
		t.Fatalf("audit: %s", got)
	}
}
