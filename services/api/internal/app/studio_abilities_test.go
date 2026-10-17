package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTheSousChefKnowsTheUsersWeek(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	ctx := context.Background()
	for id, title := range map[string]string{"toast": "Lemon toast", "soup": "Leek soup"} {
		r := exampleVoiceRecipe()
		r.Title, r.Published = title, true
		if e := persistRecipe(ctx, a.DB, "other", id, r, false); e != nil {
			t.Fatal(e)
		}
	}
	day := func(n int) string { return time.Now().UTC().AddDate(0, 0, n).Format("2006-01-02") }
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE users SET preferences=preferences||'{"units":"imperial"}' WHERE id='cook'`, nil},
		{`INSERT INTO meal_plans(id,user_id,recipe_id,day,meal,servings) VALUES('m1','cook','toast',$1,'Dinner',2),('m2','cook','soup',$2,'Lunch',4)`, []any{day(1), day(9)}},
		{`INSERT INTO groceries(id,user_id,name,checked) VALUES('g1','cook','Milk',false),('g2','cook','Eggs',true)`, nil},
		{`INSERT INTO pantry(id,user_id,name,quantity,expires_on) VALUES('p1','cook','spinach','1 bag',$1),('p2','cook','rice','1 kg',$2),('p3','cook','salt','',NULL)`, []any{day(2), day(30)}},
	} {
		if _, e := a.DB.Exec(ctx, q.sql, q.args...); e != nil {
			t.Fatal(e)
		}
	}
	if status, _ := studioReq(t, studioServer(a), "PUT", "/studio/"+p+"/context", "cook", "", map[string]any{"language": "de"}); status != 204 {
		t.Fatal(status)
	}
	var input map[string]any
	studioAgent(t, a, func(r agentRound) any {
		input = r.input()
		if r.said() == "Ideas for lunch?" && !r.answered() {
			return orderedCalls("show_recipes", map[string]any{"recipe_ids": []string{"soup", "toast"}})
		}
		return map[string]any{"content": "Here you go."}
	})
	studioTurn(t, ctx, a, p, "Ideas for lunch?")
	studioTurn(t, ctx, a, p, "What's on this week?")
	glance := func(v any) string { return string(jsonBytes(v)) }
	kitchen, _ := input["kitchen"].(map[string]any)
	switch {
	case input["units"] != "imperial" || input["appLanguage"] != "de":
		t.Errorf("units %v, language %v", input["units"], input["appLanguage"])
	case glance(input["allowances"]) != `{"photosLeft":10,"photosPerMonth":10,"plan":"pro","sousChefTurnsLeft":128,"videosLeft":1,"videosPerMonth":1,"voiceMinutesLeft":40}`:
		t.Errorf("allowances %s", glance(input["allowances"]))
	case glance(kitchen["planned"]) != `[{"day":"`+day(1)+`","meal":"Dinner","recipe":"Lemon toast","recipeId":"toast","servings":2}]`:
		t.Errorf("planned %s", glance(kitchen["planned"]))
	case glance(kitchen["toBuy"]) != `["Milk"]` || kitchen["toBuyCount"] != 1.0 || kitchen["pantryCount"] != 3.0:
		t.Errorf("groceries and pantry %s", glance(kitchen))
	case glance(kitchen["pantry"]) != `["spinach (1 bag, expires `+day(2)+`)","rice (1 kg, expires `+day(30)+`)","salt"]`:
		t.Errorf("pantry %s", glance(kitchen["pantry"]))
	case glance(kitchen["expiringSoon"]) != `["spinach (`+day(2)+`)"]`:
		t.Errorf("expiring %s", glance(kitchen["expiringSoon"]))
	case glance(input["shownRecipes"]) != `[{"id":"soup","title":"Leek soup"},{"id":"toast","title":"Lemon toast"}]`:
		t.Errorf("shown %s", glance(input["shownRecipes"]))
	}
}

func TestTheSousChefMarksCookedAndShopsThePlannedWeek(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	toast := exampleVoiceRecipe()
	toast.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", toast, false); e != nil {
		t.Fatal(e)
	}
	calls := map[string]any{}
	studioAgent(t, a, func(r agentRound) any {
		if call, ok := calls[r.said()]; ok && !r.answered() {
			return call
		}
		return map[string]any{"content": "Done."}
	})
	turn := func(text string, call map[string]any) (int64, []receipt) {
		t.Helper()
		calls[text] = call
		studioTurn(t, ctx, a, p, text)
		seq, effects, _, _ := lastReply(t, f, p)
		return seq, effects
	}
	note := func() (n string) {
		_ = a.DB.QueryRow(ctx, `SELECT note FROM cooks WHERE user_id='cook' AND recipe_id='toast'`).Scan(&n)
		return n
	}
	seq, effects := turn("I made the toast!", orderedCalls("mark_cooked", map[string]any{"recipe_id": "toast", "note": "Crunchy."}))
	if len(effects) != 1 || effects[0].Kind != "cooked" || effects[0].Title != "Lemon toast" || !effects[0].Undoable || note() != "Crunchy." {
		t.Fatalf("cooked receipt: %+v, note %q", effects, note())
	}
	if status := undo(t, f, p, "cook", seq, 0); status != 200 || note() != "" {
		t.Fatalf("undo cooked: %d, note %q", status, note())
	}
	// Cooking it again, then undoing that, keeps what was recorded the first time.
	if _, e := a.DB.Exec(ctx, `INSERT INTO cooks(id,user_id,recipe_id,note) VALUES('k1','cook','toast','First time.')`); e != nil {
		t.Fatal(e)
	}
	seq, _ = turn("Made it again.", orderedCalls("mark_cooked", map[string]any{"recipe_id": "toast", "note": "Even better."}))
	if undo(t, f, p, "cook", seq, 0); note() != "First time." {
		t.Fatalf("the first cook's note: %q", note())
	}

	// The week's plan goes on the grocery list in one step, and comes off it with Undo.
	today := time.Now().UTC().Format("2006-01-02")
	if _, e := a.DB.Exec(ctx, `INSERT INTO meal_plans(id,user_id,recipe_id,day,meal,servings) VALUES('m1','cook','toast',$1,'Dinner',4)`, today); e != nil {
		t.Fatal(e)
	}
	seq, effects = turn("Shop for this week's meals.", orderedCalls("add_plan_groceries", map[string]any{"from": today, "to": time.Now().UTC().AddDate(0, 0, 6).Format("2006-01-02")}))
	var bread string
	_ = a.DB.QueryRow(ctx, `SELECT quantity FROM groceries WHERE user_id='cook' AND name='Bread'`).Scan(&bread)
	if len(effects) != 1 || effects[0].Kind != "groceries" || effects[0].Count != 1 || bread != "4 slices" {
		t.Fatalf("plan groceries: %+v, bread %q", effects, bread)
	}
	if status := undo(t, f, p, "cook", seq, 0); status != 200 {
		t.Fatal(status)
	}
	var left int
	if _ = a.DB.QueryRow(ctx, `SELECT count(*) FROM groceries WHERE user_id='cook'`).Scan(&left); left != 0 {
		t.Fatalf("%d groceries left after undo", left)
	}
}

func TestTheSousChefImportsAPageTheUserShared(t *testing.T) {
	page := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(recipePage(fullRecipeLD))
	}))
	defer page.Close()
	old := pageClient
	pageClient = page.Client()
	t.Cleanup(func() { pageClient = old })
	a, p := studioFixture(t)
	ctx := context.Background()
	link := page.URL + "/lemon-pasta"
	var imported map[string]any
	var refused string
	studioAgent(t, a, func(r agentRound) any {
		results := r.results()
		switch {
		case !r.answered():
			return orderedCalls("import_recipe", map[string]any{"url": link})
		case imported == nil:
			_ = json.Unmarshal([]byte(strings.TrimSpace(results)), &imported)
			// A credit for a page the user never shared is refused.
			return orderedCalls("save_recipe_draft", map[string]any{"recipe": imported["recipe"], "new_recipe": true, "source_url": "https://elsewhere.example/pasta"})
		case refused == "":
			refused = results
			return orderedCalls("save_recipe_draft", map[string]any{"recipe": imported["recipe"], "new_recipe": true, "source_url": imported["sourceUrl"]})
		}
		return map[string]any{"content": "Saved it as a draft."}
	})
	studioTurn(t, ctx, a, p, "Can you save this one for me? "+link)
	recipe, _ := imported["recipe"].(map[string]any)
	if recipe["title"] != "Lemon & ricotta pasta" || strings.Contains(string(jsonBytes(imported)), "cook.example/images") || strings.Contains(string(jsonBytes(imported)), "step1.jpg") {
		t.Fatalf("imported page: %s", jsonBytes(imported))
	}
	if !strings.Contains(refused, "only for a page the user shared") {
		t.Fatalf("an unshared source was accepted: %s", refused)
	}
	var title, source string
	if e := a.DB.QueryRow(ctx, `SELECT r.title,r.source_url FROM voice_projects p JOIN recipes r ON r.id=p.recipe_id WHERE p.id=$1`, p).Scan(&title, &source); e != nil || title != "Lemon & ricotta pasta" || source != imported["sourceUrl"] {
		t.Fatalf("draft %q credits %q (want %v): %v", title, source, imported["sourceUrl"], e)
	}
}

// Planning and shopping a recipe use its own servings unless the member said otherwise.
func TestPlansAndGroceriesDefaultToTheRecipesServings(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	toast := exampleVoiceRecipe()
	toast.Published, toast.Servings = true, 3
	if e := persistRecipe(ctx, a.DB, "other", "toast", toast, false); e != nil {
		t.Fatal(e)
	}
	run := agentTurn(t, a, p)
	tool := func(name string, args map[string]any) string { return a.agentTool(ctx, run, name, jsonBytes(args)) }
	if out := tool("plan_meal", map[string]any{"recipe_id": "toast", "day": "2026-10-20", "meal": "Dinner", "servings": 0}); !strings.Contains(out, `"ok":true`) {
		t.Fatalf("plan without servings: %s", out)
	}
	var servings int
	var bread string
	if e := a.DB.QueryRow(ctx, `SELECT servings FROM meal_plans WHERE user_id='cook'`).Scan(&servings); e != nil || servings != 3 {
		t.Fatalf("planned %d servings: %v", servings, e)
	}
	if out := tool("add_recipe_groceries", map[string]any{"recipe_id": "toast"}); strings.Contains(out, "error") {
		t.Fatalf("groceries without servings: %s", out)
	}
	if e := a.DB.QueryRow(ctx, `SELECT quantity FROM groceries WHERE user_id='cook' AND name='Bread'`).Scan(&bread); e != nil || bread != "2 slices" {
		t.Fatalf("groceries scaled to %q: %v", bread, e)
	}
	if out := tool("plan_meal", map[string]any{"recipe_id": "missing", "day": "2026-10-21", "meal": "Lunch"}); !strings.Contains(out, "Recipe not found.") {
		t.Fatalf("an unknown recipe: %s", out)
	}
}

// GPT-6 Luna fills in every argument, sending empty values for the ones it doesn't mean to
// set; the tools change only what was given.
func TestToolsKeepWhatTheModelLeavesEmpty(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	soup := exampleVoiceRecipe()
	soup.Title, soup.Tags, soup.Calories = "Leek soup", []string{"soup", "winter"}, 0
	toast := exampleVoiceRecipe()
	toast.Published = true
	if e := persistRecipe(ctx, a.DB, "cook", "soup", soup, false); e != nil {
		t.Fatal(e)
	}
	if e := persistRecipe(ctx, a.DB, "other", "toast", toast, false); e != nil {
		t.Fatal(e)
	}
	if _, e := a.DB.Exec(ctx, `INSERT INTO pantry(id,user_id,name,quantity) VALUES('p1','cook','milk','1 l'); INSERT INTO collections(id,user_id,name) VALUES('c1','cook','Weeknight')`); e != nil {
		t.Fatal(e)
	}
	tool := func(name string, args map[string]any) string {
		return a.agentTool(ctx, agentTurn(t, a, p), name, jsonBytes(args))
	}
	// A recipe change sent with the rest of the recipe left empty saves only the change.
	out := tool("edit_recipe", map[string]any{"recipe_id": "soup", "changes": map[string]any{"calories": 80, "cuisine": "", "description": "", "tags": []string{}, "minutes": 0, "title": "Leek soup"}})
	var cuisine, tags string
	var calories int
	_ = a.DB.QueryRow(ctx, `SELECT cuisine,tags::text,calories FROM recipes WHERE id='soup'`).Scan(&cuisine, &tags, &calories)
	if !strings.Contains(out, "Saved") || calories != 80 || cuisine != "Italian" || tags != "{soup,winter}" {
		t.Fatalf("edit: %s → %s %s %d", out, cuisine, tags, calories)
	}
	// Saving with an empty cookbook saves it, and saving again keeps the cookbook it's in.
	if out = tool("save_recipe", map[string]any{"recipe_id": "toast", "cookbook_id": "", "unsave": false}); strings.Contains(out, "error") {
		t.Fatalf("save: %s", out)
	}
	if _, e := a.DB.Exec(ctx, `UPDATE saves SET collection_id='c1' WHERE user_id='cook'`); e != nil {
		t.Fatal(e)
	}
	tool("save_recipe", map[string]any{"recipe_id": "toast", "cookbook_id": ""})
	var collection *string
	if e := a.DB.QueryRow(ctx, `SELECT collection_id FROM saves WHERE user_id='cook' AND recipe_id='toast'`).Scan(&collection); e != nil || collection == nil || *collection != "c1" {
		t.Fatalf("the save left its cookbook: %v %v", collection, e)
	}
	// A pantry change keeps the quantity or expiry it doesn't give.
	pantry := func() (quantity string, expires *string) {
		_ = a.DB.QueryRow(ctx, `SELECT quantity,to_char(expires_on,'YYYY-MM-DD') FROM pantry WHERE user_id='cook' AND name='milk'`).Scan(&quantity, &expires)
		return
	}
	tool("set_pantry_item", map[string]any{"name": "Milk", "quantity": "", "expires_on": "2026-10-23"})
	if q, x := pantry(); q != "1 l" || x == nil || *x != "2026-10-23" {
		t.Fatalf("an expiry change: %q %v", q, x)
	}
	tool("set_pantry_item", map[string]any{"name": "milk", "quantity": "2 l", "expires_on": ""})
	if q, x := pantry(); q != "2 l" || x == nil || *x != "2026-10-23" {
		t.Fatalf("a quantity change: %q %v", q, x)
	}
	// The profile tool compares what it's sent with the profile: an empty bio clears it, but
	// the name is never blanked.
	if _, e := a.DB.Exec(ctx, `UPDATE users SET bio='Home cook.' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	if out = tool("update_profile", map[string]any{"name": "", "bio": "", "diets": nil}); !strings.Contains(out, "Change your bio.") {
		t.Fatalf("profile: %s", out)
	}
	// A draft left without a cuisine goes on the Other shelf rather than failing.
	draft := exampleVoiceRecipe()
	draft.Title, draft.Cuisine = "Lemon toast for two", ""
	if out = tool("save_recipe_draft", map[string]any{"recipe": draft, "new_recipe": true}); strings.Contains(out, "error") {
		t.Fatalf("draft: %s", out)
	}
	if e := a.DB.QueryRow(ctx, `SELECT cuisine FROM recipes WHERE title='Lemon toast for two'`).Scan(&cuisine); e != nil || cuisine != "Other" {
		t.Fatalf("draft cuisine %q: %v", cuisine, e)
	}
}
