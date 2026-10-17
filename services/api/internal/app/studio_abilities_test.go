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
		{`INSERT INTO pantry(id,user_id,name,quantity,expires_on) VALUES('p1','cook','spinach','1 bag',$1),('p2','cook','rice','1 kg',$2)`, []any{day(2), day(30)}},
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
	case glance(input["allowances"]) != `{"photosLeft":10,"plan":"pro","sousChefTurnsLeft":128,"videosLeft":1,"voiceMinutesLeft":40}`:
		t.Errorf("allowances %s", glance(input["allowances"]))
	case glance(kitchen["planned"]) != `[{"day":"`+day(1)+`","meal":"Dinner","recipe":"Lemon toast","recipeId":"toast","servings":2}]`:
		t.Errorf("planned %s", glance(kitchen["planned"]))
	case glance(kitchen["toBuy"]) != `["Milk"]` || kitchen["toBuyCount"] != 1.0 || kitchen["pantryCount"] != 2.0:
		t.Errorf("groceries and pantry %s", glance(kitchen))
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
