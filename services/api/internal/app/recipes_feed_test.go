package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

func TestFeedSectionsAndFollowing(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"cook", "friend", "reader", "fan"} {
		testUser(t, db, id)
	}
	// Newest last: ids say when each was made.
	for i, r := range []struct {
		id, owner, image string
		minutes          int
	}{
		{"old-favourite", "cook", "https://images.example.com/a.jpg", 90},
		{"quick-salad", "cook", "", 10},
		{"friends-stew", "friend", "", 120},
		{"plain-new", "cook", "", 45},
		{"friends-toast", "friend", "https://images.example.com/b.jpg", 5},
	} {
		publishRecipe(t, db, r.owner, r.id, func(x *RecipeInput) { x.Image, x.Minutes = r.image, r.minutes })
		if _, e := db.Exec(ctx, `UPDATE recipes SET created_at=now()-make_interval(hours=>10-$1::int) WHERE id=$2`, i, r.id); e != nil {
			t.Fatal(e)
		}
	}
	publishRecipe(t, db, "cook", "draft", func(x *RecipeInput) { x.Published, x.Image = false, "https://images.example.com/c.jpg" })
	// This week the old favourite is the most saved; an old save of the stew doesn't count.
	if _, e := db.Exec(ctx, `INSERT INTO saves(user_id,recipe_id) VALUES('reader','old-favourite'),('fan','old-favourite'),('reader','quick-salad');
 INSERT INTO saves(user_id,recipe_id,created_at) VALUES('fan','friends-stew',now()-interval '30 days');
 INSERT INTO follows(user_id,creator_id) VALUES('reader','friend')`); e != nil {
		t.Fatal(e)
	}
	f := recipesApp(db, false)
	type feed struct {
		Hero                               *struct{ ID string }
		Trending, Quick, Following, Newest []struct{ ID string }
	}
	get := func(token, query string) feed {
		t.Helper()
		status, b := callAPI(t, f, "GET", "/v1/feed"+query, token, nil)
		var out feed
		if status != 200 || json.Unmarshal(b, &out) != nil {
			t.Fatalf("feed: %d %s", status, b)
		}
		return out
	}
	ids := func(list []struct{ ID string }) []string {
		out := []string{}
		for _, r := range list {
			out = append(out, r.ID)
		}
		return out
	}
	guest := get("", "")
	if guest.Hero == nil || guest.Hero.ID != "old-favourite" {
		t.Fatalf("hero: %+v", guest.Hero)
	}
	if got := ids(guest.Trending); !slices.Equal(got, []string{"quick-salad", "friends-toast", "plain-new", "friends-stew"}) {
		t.Fatalf("trending: %v", got)
	}
	if got := ids(guest.Newest); !slices.Equal(got, []string{"friends-toast", "plain-new", "friends-stew", "quick-salad", "old-favourite"}) {
		t.Fatalf("newest: %v", got)
	}
	// Quick is 30 minutes or less, newest first; the hero isn't repeated.
	if got := ids(guest.Quick); !slices.Equal(got, []string{"friends-toast", "quick-salad"}) || len(guest.Following) != 0 {
		t.Fatalf("quick %v, a guest's following %v", got, ids(guest.Following))
	}
	reader := bearerFor(t, db, "reader")
	if got := ids(get(reader, "").Following); !slices.Equal(got, []string{"friends-toast", "friends-stew"}) {
		t.Fatalf("following: %v", got)
	}
	small := get("", "?limit=1")
	if !slices.Equal(ids(small.Trending), []string{"quick-salad"}) || !slices.Equal(ids(small.Quick), []string{"friends-toast"}) || len(small.Newest) != 1 {
		t.Fatalf("limit 1: %v %v %v", ids(small.Trending), ids(small.Quick), ids(small.Newest))
	}
	// The activity sheet's list: signed in only.
	if status, _ := callAPI(t, f, "GET", "/v1/recipes?following=true", "", nil); status != 401 {
		t.Fatalf("guest following: %d", status)
	}
	status, b := callAPI(t, f, "GET", "/v1/recipes?following=true", reader, nil)
	if got := listedIDs(t, b); status != 200 || !slices.Equal(got, []string{"friends-toast", "friends-stew"}) {
		t.Fatalf("following list: %d %v", status, got)
	}
	// The most saved recipe can't lead without a photo; the next pictured one does.
	if _, e := db.Exec(ctx, `UPDATE recipes SET image='' WHERE id='old-favourite'`); e != nil {
		t.Fatal(e)
	}
	if hero := get("", "").Hero; hero == nil || hero.ID != "friends-toast" {
		t.Fatalf("hero without the favourite's photo: %+v", hero)
	}
}

func TestTopRatedUsesBayesianAverage(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	for _, id := range []string{"one-review", "loved", "unrated", "so-so"} {
		publishRecipe(t, db, "cook", id, nil)
	}
	// A hundred reviews averaging 4.8, one five-star review, and a site-wide mean near 4.2.
	_, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle) SELECT 'r'||n,'r'||n||'@example.test','!','Reader','r'||n FROM generate_series(1,100) n;
 INSERT INTO reviews(id,user_id,recipe_id,rating,body) VALUES('only','r1','one-review',5,'Perfect.');
 INSERT INTO reviews(id,user_id,recipe_id,rating,body) SELECT 'l'||n,'r'||n,'loved',CASE WHEN n%5=0 THEN 4 ELSE 5 END,'Lovely.' FROM generate_series(1,100) n;
 INSERT INTO reviews(id,user_id,recipe_id,rating,body) SELECT 's'||n,'r'||n,'so-so',3,'Fine.' FROM generate_series(1,50) n`)
	if err != nil {
		t.Fatal(err)
	}
	f := recipesApp(db, false)
	status, b := callAPI(t, f, "GET", "/v1/recipes?sort=Top%20rated", "", nil)
	if got := listedIDs(t, b); status != 200 || !slices.Equal(got, []string{"loved", "one-review", "unrated", "so-so"}) {
		t.Fatalf("top rated: %d %v", status, got)
	}
	var list []struct {
		ID          string
		Rating      float64
		ReviewCount int
	}
	_ = json.Unmarshal(b, &list)
	if list[0].Rating != 4.8 || list[0].ReviewCount != 100 || list[1].Rating != 5 || list[1].ReviewCount != 1 || list[2].Rating != 0 {
		t.Fatalf("cards must still show the plain average: %+v", list)
	}
	// Search results sorted by rating still list matches before near misses.
	status, b = callAPI(t, f, "GET", "/v1/recipes?sort=Top%20rated&q=lemon", "", nil)
	if got := listedIDs(t, b); status != 200 || len(got) != 4 || got[0] != "loved" {
		t.Fatalf("top rated search: %d %v", status, got)
	}
}

func TestReviewsEditInPlaceAndDelete(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "first")
	testUser(t, db, "second")
	publishRecipe(t, db, "cook", "soup", nil)
	f := recipesApp(db, false)
	first, second := bearerFor(t, db, "first"), bearerFor(t, db, "second")
	review := func(token, body string) {
		t.Helper()
		if status, b := callAPI(t, f, "PUT", "/v1/recipes/soup/review", token, map[string]any{"rating": 4, "body": body}); status != 200 {
			t.Fatalf("review: %d %s", status, b)
		}
	}
	review(first, "Warming and simple.")
	if _, e := db.Exec(ctx, `UPDATE reviews SET created_at=now()-interval '2 days',updated_at=now()-interval '2 days' WHERE user_id='first'`); e != nil {
		t.Fatal(e)
	}
	review(second, "Needed more salt.")
	review(first, "Warming and simple; even better the next day.")
	type entry struct {
		Body                 string
		CreatedAt, UpdatedAt time.Time
	}
	reviews := func() []entry {
		t.Helper()
		status, b := callAPI(t, f, "GET", "/v1/recipes/soup/reviews", "", nil)
		var out []entry
		if status != 200 || json.Unmarshal(b, &out) != nil {
			t.Fatalf("reviews: %d %s", status, b)
		}
		return out
	}
	list := reviews()
	if len(list) != 2 || list[0].Body != "Needed more salt." || !list[1].UpdatedAt.After(list[1].CreatedAt.Add(24*time.Hour)) {
		t.Fatalf("an edit moved the review or kept its old time: %+v", list)
	}
	if status, _ := callAPI(t, f, "DELETE", "/v1/recipes/soup/review", first, nil); status != 204 {
		t.Fatalf("delete: %d", status)
	}
	if status, _ := callAPI(t, f, "DELETE", "/v1/recipes/soup/review", first, nil); status != 404 {
		t.Fatalf("delete twice: %d", status)
	}
	if status, _ := callAPI(t, f, "DELETE", "/v1/recipes/soup/review", "", nil); status != 401 {
		t.Fatalf("guest delete: %d", status)
	}
	if list = reviews(); len(list) != 1 || list[0].Body != "Needed more salt." {
		t.Fatalf("someone else's review went too: %+v", list)
	}
}

func TestCreatorsPagesAndSitemap(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for i := range 5 {
		id := fmt.Sprintf("cook-%d", i)
		testUser(t, db, id)
		publishRecipe(t, db, id, "recipe-"+id, nil)
	}
	testUser(t, db, "suspended")
	publishRecipe(t, db, "suspended", "hidden", nil)
	publishRecipe(t, db, "cook-0", "draft", func(r *RecipeInput) { r.Published = false })
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id='suspended'`); e != nil {
		t.Fatal(e)
	}
	f := recipesApp(db, false)
	page := func(query string) []string {
		t.Helper()
		status, b := callAPI(t, f, "GET", "/v1/creators"+query, "", nil)
		if status != 200 {
			t.Fatalf("creators%s: %d", query, status)
		}
		return listedIDs(t, b)
	}
	all := page("")
	if len(all) != 5 {
		t.Fatalf("creators: %v", all)
	}
	if a, b := page("?limit=2"), page("?limit=2&offset=2"); !slices.Equal(append(a, b...), all[:4]) {
		t.Fatalf("pages %v %v of %v", a, b, all)
	}
	if got := page("?limit=0"); len(got) != 5 {
		t.Fatalf("invalid limit: %v", got)
	}
	res, err := f.Test(httptest.NewRequest("GET", "/v1/sitemap", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var sitemap struct {
		Recipes  []struct{ ID, UpdatedAt string }
		Creators []struct{ ID, Handle, UpdatedAt string }
	}
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "public, max-age=3600" || json.NewDecoder(res.Body).Decode(&sitemap) != nil {
		t.Fatalf("sitemap: %d %v", res.StatusCode, res.Header)
	}
	if len(sitemap.Recipes) != 5 || len(sitemap.Creators) != 5 || sitemap.Creators[0].Handle == "" || sitemap.Recipes[0].UpdatedAt == "" {
		t.Fatalf("sitemap: %+v", sitemap)
	}
	for _, r := range sitemap.Recipes {
		if r.ID == "hidden" || r.ID == "draft" {
			t.Fatalf("sitemap lists %s", r.ID)
		}
	}
}

func TestRecipeLanguageAndCuisineOnWrite(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	r := validRecipe()
	r.Cuisine, r.Language, r.Published = "italian", "it", true
	status, b := callAPI(t, f, "POST", "/v1/recipes", cook, r)
	var saved struct{ ID, Cuisine, Language string }
	if status != 201 || json.Unmarshal(b, &saved) != nil || saved.Cuisine != "Italian" || saved.Language != "it" {
		t.Fatalf("create: %d %s", status, b)
	}
	// An older app sends no language; the saved one stays.
	var old map[string]any
	_ = json.Unmarshal(jsonBytes(validRecipe()), &old)
	delete(old, "language")
	old["published"] = true
	status, b = callAPI(t, f, "PUT", "/v1/recipes/"+saved.ID, cook, old)
	if status != 200 || json.Unmarshal(b, &saved) != nil || saved.Language != "it" {
		t.Fatalf("update without language: %d %s", status, b)
	}
	r.Language = "Klingon"
	if status, _ := callAPI(t, f, "PUT", "/v1/recipes/"+saved.ID, cook, r); status != 400 {
		t.Fatalf("unknown language: %d", status)
	}
	// Rows written before cuisines were normalized still reach their shelf.
	if _, e := db.Exec(ctx, `UPDATE recipes SET cuisine='ITALIAN' WHERE id=$1`, saved.ID); e != nil {
		t.Fatal(e)
	}
	status, b = callAPI(t, f, "GET", "/v1/recipes?category=Italian", "", nil)
	if got := listedIDs(t, b); status != 200 || !slices.Equal(got, []string{saved.ID}) {
		t.Fatalf("category ignores case: %d %v", status, got)
	}
}

func TestUpdatedAtFollowsEveryWrite(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	_, err := db.Exec(ctx, `INSERT INTO collections(id,user_id,name) VALUES('c','cook','Soups');
 INSERT INTO groceries(id,user_id,name) VALUES('g','cook','Salt');
 INSERT INTO pantry(id,user_id,name) VALUES('p','cook','rice')`)
	if err != nil {
		t.Fatal(err)
	}
	for table, write := range map[string]string{
		"users":       `UPDATE users SET bio='Soups, mostly.'`,
		"collections": `UPDATE collections SET name='Winter soups'`,
		"groceries":   `UPDATE groceries SET checked=true`,
		"pantry":      `UPDATE pantry SET quantity='1 kg'`,
	} {
		// Stamp the past with the trigger off; any later write moves it to now.
		if _, err = db.Exec(ctx, `ALTER TABLE `+table+` DISABLE TRIGGER USER; UPDATE `+table+` SET updated_at='2020-01-01'; ALTER TABLE `+table+` ENABLE TRIGGER USER`); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(ctx, write); err != nil {
			t.Fatal(err)
		}
		var updated time.Time
		if err = db.QueryRow(ctx, `SELECT updated_at FROM `+table).Scan(&updated); err != nil || time.Since(updated) > time.Minute {
			t.Errorf("%s: a write left updated_at at %v (%v)", table, updated, err)
		}
	}
}
