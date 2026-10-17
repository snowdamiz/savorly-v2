package app

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"testing"
)

func TestGroceriesMergeByNameAndUnit(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "shopper")
	publishRecipe(t, db, "cook", "cake", func(r *RecipeInput) {
		r.Servings = 3
		r.Ingredients = []Ingredient{{Name: "Flour", Amount: 1, Unit: "cup", Category: "Pantry"}, {Name: "Sugar", Amount: 0.5, Unit: "cup"},
			{Name: "Salt", Unit: "pinch"}, {Name: "Eggs", Amount: 2}, {Name: "flour ", Amount: 2, Unit: "cups"}}
	})
	f := recipesApp(db, false)
	shopper := bearerFor(t, db, "shopper")
	add := func(servings int) map[string]int {
		t.Helper()
		status, b := callAPI(t, f, "POST", "/v1/recipes/cake/groceries", shopper, map[string]int{"servings": servings})
		var out map[string]int
		if status != 200 || json.Unmarshal(b, &out) != nil {
			t.Fatalf("%d %s", status, b)
		}
		return out
	}
	expect := func(want ...string) {
		t.Helper()
		rows, e := db.Query(ctx, `SELECT name||': '||quantity||' | '||category||CASE WHEN checked THEN ' (checked)' ELSE '' END FROM groceries WHERE user_id='shopper'`)
		if e != nil {
			t.Fatal(e)
		}
		defer rows.Close()
		got := []string{}
		for rows.Next() {
			var line string
			if e = rows.Scan(&line); e != nil {
				t.Fatal(e)
			}
			got = append(got, line)
		}
		slices.Sort(got)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Fatalf("grocery list:\n%q\nwant\n%q", got, want)
		}
	}
	// The recipe's two flour lines merge; a third of a cup reads as a fraction.
	if out := add(1); out["added"] != 4 || out["merged"] != 1 {
		t.Fatalf("first add: %v", out)
	}
	expect("Flour: 1 cup | Pantry", "Sugar: 0.17 cup | Other", "Salt: pinch | Other", "Eggs: 0.67 | Other")
	// Adding it again tops lines up instead of repeating them.
	if out := add(2); out["added"] != 0 || out["merged"] != 5 {
		t.Fatalf("second add: %v", out)
	}
	expect("Flour: 3 cup | Pantry", "Sugar: ½ cup | Other", "Salt: pinch | Other", "Eggs: 2 | Other")
	// Checked lines are done, so new flour starts a line; hand-written amounts stay apart.
	if _, e := db.Exec(ctx, `UPDATE groceries SET checked=true WHERE name='Flour'; UPDATE groceries SET quantity='a few' WHERE name='Eggs'`); e != nil {
		t.Fatal(e)
	}
	if out := add(3); out["added"] != 2 || out["merged"] != 3 {
		t.Fatalf("third add: %v", out)
	}
	expect("Flour: 3 cup | Pantry (checked)", "Flour: 3 cup | Pantry", "Sugar: 1 cup | Other", "Salt: pinch | Other", "Eggs: a few | Other", "Eggs: 2 | Other")
}

func TestPlannerGroceriesAndKitchenWindow(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "planner")
	publishRecipe(t, db, "cook", "soup", func(r *RecipeInput) {
		r.Servings = 2
		r.Ingredients = []Ingredient{{Name: "Onion", Amount: 1}, {Name: "Stock", Amount: 0.5, Unit: "l"}}
	})
	publishRecipe(t, db, "cook", "salad", func(r *RecipeInput) {
		r.Servings = 4
		r.Ingredients = []Ingredient{{Name: "Onion", Amount: 2}, {Name: "Olive oil", Amount: 2, Unit: "tbsp"}}
	})
	f := recipesApp(db, false)
	planner := bearerFor(t, db, "planner")
	for _, p := range []map[string]any{
		{"recipeId": "soup", "day": "2026-10-19", "meal": "Lunch", "servings": 4},
		{"recipeId": "salad", "day": "2026-10-20", "meal": "Dinner", "servings": 2},
		{"recipeId": "soup", "day": "2026-11-30", "meal": "Dinner", "servings": 2},
	} {
		if status, b := callAPI(t, f, "POST", "/v1/planner", planner, p); status != 200 {
			t.Fatalf("plan: %d %s", status, b)
		}
	}
	status, b := callAPI(t, f, "POST", "/v1/planner/groceries", planner, map[string]string{"from": "2026-10-19", "to": "2026-10-25"})
	var out map[string]int
	if status != 200 || json.Unmarshal(b, &out) != nil || out["added"] != 3 || out["merged"] != 1 {
		t.Fatalf("week groceries: %d %s", status, b)
	}
	quantities := map[string]string{}
	rows, err := db.Query(ctx, `SELECT name,quantity FROM groceries WHERE user_id='planner'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name, quantity string
		if err = rows.Scan(&name, &quantity); err != nil {
			t.Fatal(err)
		}
		quantities[name] = quantity
	}
	rows.Close()
	// Soup for four doubles it; salad for two halves it; the onions add up.
	if want := map[string]string{"Onion": "3", "Stock": "1 l", "Olive oil": "1 tbsp"}; !maps.Equal(quantities, want) {
		t.Fatalf("scaled groceries: %v", quantities)
	}
	for _, bad := range []map[string]string{{"from": "2026-10-19", "to": "2026-12-25"}, {"from": "2026-10-25", "to": "2026-10-19"}, {"from": "soon", "to": "2026-10-19"}} {
		if status, _ := callAPI(t, f, "POST", "/v1/planner/groceries", planner, bad); status != 400 {
			t.Errorf("%v: %d", bad, status)
		}
	}
	kitchen := func(query string) int {
		t.Helper()
		status, b := callAPI(t, f, "GET", "/v1/kitchen"+query, planner, nil)
		var k struct{ Plans, Groceries []any }
		if status != 200 || json.Unmarshal(b, &k) != nil || len(k.Groceries) != 3 {
			t.Fatalf("kitchen%s: %d %s", query, status, b)
		}
		return len(k.Plans)
	}
	if n := kitchen(""); n != 3 {
		t.Fatalf("every plan without a window: %d", n)
	}
	if n := kitchen("?from=2026-10-19&to=2026-10-25"); n != 2 {
		t.Fatalf("one week: %d", n)
	}
	if n := kitchen("?from=2026-11-01&to=2026-12-31"); n != 1 {
		t.Fatalf("two months: %d", n)
	}
	for _, q := range []string{"?from=2026-10-01", "?from=2026-01-01&to=2026-12-31", "?from=x&to=y"} {
		if status, _ := callAPI(t, f, "GET", "/v1/kitchen"+q, planner, nil); status != 400 {
			t.Errorf("kitchen%s: %d", q, status)
		}
	}
}

func TestLibraryPages(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "reader")
	for i := range 5 {
		publishRecipe(t, db, "cook", fmt.Sprintf("saved-%d", i), nil)
	}
	publishRecipe(t, db, "reader", "mine", nil)
	publishRecipe(t, db, "reader", "my-draft", func(r *RecipeInput) { r.Published = false })
	f := recipesApp(db, false)
	reader := bearerFor(t, db, "reader")
	status, b := callAPI(t, f, "POST", "/v1/collections", reader, map[string]string{"name": "Soups"})
	var book struct{ ID string }
	if status != 200 || json.Unmarshal(b, &book) != nil {
		t.Fatalf("cookbook: %d %s", status, b)
	}
	for i := range 5 {
		body := map[string]any{}
		if i < 2 {
			body["collectionId"] = book.ID
		}
		if status, b := callAPI(t, f, "PUT", fmt.Sprintf("/v1/recipes/saved-%d/save", i), reader, body); status != 200 {
			t.Fatalf("save: %d %s", status, b)
		}
		// Saved in order, a second apart.
		if _, e := db.Exec(ctx, `UPDATE saves SET created_at=now()-make_interval(secs=>10-$1::int) WHERE recipe_id=$2`, i, fmt.Sprintf("saved-%d", i)); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET created_at=now()-interval '1 hour' WHERE author_id='reader'`); e != nil {
		t.Fatal(e)
	}
	type page struct {
		Recipes                       []struct{ ID string }
		HasMore                       bool
		SavedIds, FollowingIds, Saves []any
		Collections                   []any
		OwnIds                        []string
		PublishedCount                int
	}
	get := func(path string) page {
		t.Helper()
		status, b := callAPI(t, f, "GET", path, reader, nil)
		var p page
		if status != 200 || json.Unmarshal(b, &p) != nil {
			t.Fatalf("%s: %d %s", path, status, b)
		}
		return p
	}
	ids := func(p page) []string {
		out := []string{}
		for _, r := range p.Recipes {
			out = append(out, r.ID)
		}
		return out
	}
	// Older apps get everything, unchanged.
	if all := get("/v1/library"); len(all.Recipes) != 7 || len(all.SavedIds) != 5 || all.HasMore || all.PublishedCount != 1 {
		t.Fatalf("whole library: %d recipes, %d published", len(all.Recipes), all.PublishedCount)
	}
	// A page keeps the ids and counts whole: the reader wrote two recipes and published one.
	first := get("/v1/library?limit=3")
	if !slices.Equal(ids(first), []string{"saved-4", "saved-3", "saved-2"}) || !first.HasMore || len(first.SavedIds) != 5 || len(first.Saves) != 5 || len(first.Collections) != 1 || first.PublishedCount != 1 {
		t.Fatalf("first page: %v more=%v saved=%d published=%d", ids(first), first.HasMore, len(first.SavedIds), first.PublishedCount)
	}
	if own := slices.Sorted(slices.Values(first.OwnIds)); !slices.Equal(own, []string{"mine", "my-draft"}) {
		t.Fatalf("own ids: %v", first.OwnIds)
	}
	next := get("/v1/library/recipes?offset=3&limit=3")
	if !slices.Equal(ids(next), []string{"saved-1", "saved-0", "my-draft"}) || !next.HasMore {
		t.Fatalf("second page: %v more=%v", ids(next), next.HasMore)
	}
	last := get("/v1/library/recipes?offset=6&limit=3")
	if !slices.Equal(ids(last), []string{"mine"}) || last.HasMore {
		t.Fatalf("last page: %v more=%v", ids(last), last.HasMore)
	}
	if got := ids(get("/v1/library/recipes?collection=" + book.ID)); !slices.Equal(got, []string{"saved-1", "saved-0"}) {
		t.Fatalf("cookbook: %v", got)
	}
	if got := ids(get("/v1/library/recipes?scope=mine")); len(got) != 2 || slices.Contains(got, "saved-0") {
		t.Fatalf("mine: %v", got)
	}
	if got := ids(get("/v1/library/recipes?scope=saved&limit=2")); !slices.Equal(got, []string{"saved-4", "saved-3"}) {
		t.Fatalf("saved: %v", got)
	}
	if status, _ := callAPI(t, f, "GET", "/v1/library/recipes", "", nil); status != 401 {
		t.Fatalf("guest library: %d", status)
	}
	if status, _ := callAPI(t, f, "GET", "/v1/library/recipes?scope=everyone", reader, nil); status != 400 {
		t.Fatalf("unknown scope: %d", status)
	}
}

func TestMembersPlanAndShopTheirOwnPrivateRecipes(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "other")
	publishRecipe(t, db, "cook", "my-draft", func(r *RecipeInput) {
		r.Published = false
		r.Servings = 2
		r.Ingredients = []Ingredient{{Name: "Leeks", Amount: 2}}
	})
	f := recipesApp(db, false)
	cook, other := bearerFor(t, db, "cook"), bearerFor(t, db, "other")
	plan := map[string]any{"recipeId": "my-draft", "day": "2026-10-19", "meal": "Dinner", "servings": 4}
	if status, b := callAPI(t, f, "POST", "/v1/planner", cook, plan); status != 200 {
		t.Fatalf("plan own draft: %d %s", status, b)
	}
	if status, b := callAPI(t, f, "POST", "/v1/recipes/my-draft/groceries", cook, map[string]int{"servings": 4}); status != 200 {
		t.Fatalf("shop own draft: %d %s", status, b)
	}
	var quantity string
	if e := db.QueryRow(ctx, `SELECT quantity FROM groceries WHERE user_id='cook' AND name='Leeks'`).Scan(&quantity); e != nil || quantity != "4" {
		t.Fatalf("scaled groceries: %q %v", quantity, e)
	}
	// Someone else's private recipe stays out of reach.
	if status, _ := callAPI(t, f, "POST", "/v1/planner", other, plan); status != 404 {
		t.Fatalf("planned another cook's draft: %d", status)
	}
	if status, _ := callAPI(t, f, "POST", "/v1/recipes/my-draft/groceries", other, map[string]int{"servings": 2}); status != 404 {
		t.Fatalf("shopped another cook's draft: %d", status)
	}
}
