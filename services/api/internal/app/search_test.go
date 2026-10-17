package app

import (
	"context"
	"fmt"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestSearchWords(t *testing.T) {
	for q, want := range map[string][]string{
		"creme brulee":        {"creme", "brulee"},
		"  Zitrone!  ":        {"Zitrone"},
		"chef's kiss-curl":    {"chef", "s", "kiss", "curl"},
		"лимон, мёд":          {"лимон", "мёд"},
		"番茄炒蛋":                {"番茄炒蛋"},
		"'); DROP TABLE x;--": {"DROP", "TABLE", "x"},
		"!!!":                 nil,
	} {
		if got := searchWords(q); !reflect.DeepEqual(got, want) && !(len(got) == 0 && len(want) == 0) {
			t.Errorf("%q: %q, want %q", q, got, want)
		}
	}
}

func TestRecipeSearchMultilingualAndTypos(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "hidden")
	recipe := func(id, title, description, cuisine string, minutes int, ingredients ...string) {
		publishRecipe(t, db, "cook", id, func(r *RecipeInput) {
			r.Title, r.Description, r.Cuisine, r.Minutes = title, description, cuisine, minutes
			r.Ingredients = nil
			for _, name := range ingredients {
				r.Ingredients = append(r.Ingredients, Ingredient{Name: name, Amount: 1, Unit: "g"})
			}
		})
	}
	recipe("pasta", "Lemon Ricotta Pasta", "Bright, creamy and ready in twenty minutes.", "Italian", 20, "Spaghetti", "Ricotta", "Lemon")
	recipe("kuchen", "Zitronenkuchen mit Mohn", "Saftiger Kuchen mit Glasur.", "German", 70, "Mehl", "Zitronen")
	recipe("pirog", "Лимонный пирог", "Нежный пирог к чаю.", "Russian", 60, "Мука", "Сахар")
	recipe("brulee", "Crème brûlée", "Vanilla custard under a crackling sugar crust.", "French", 45, "Cream", "Sugar")
	recipe("carbonara", "Weeknight carbonara", "Silky eggs and cheese coat every strand.", "italian", 25, "Spaghetti", "Pancetta", "Eggs")
	recipe("cooler", "Sparkling cooler", "Fizzy water with a squeeze of lemon and mint.", "American", 5, "Water", "Mint")
	publishRecipe(t, db, "cook", "draft", func(r *RecipeInput) { r.Title, r.Published = "Lemon draft pasta", false })
	publishRecipe(t, db, "hidden", "suspended", func(r *RecipeInput) { r.Title = "Lemon pasta from a suspended cook" })
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id='hidden'; UPDATE recipes SET tags='{Vegetarian}' WHERE id='pasta'`); e != nil {
		t.Fatal(e)
	}
	f := recipesApp(db, false)
	search := func(query string) []string {
		t.Helper()
		status, b := callAPI(t, f, "GET", "/v1/recipes?"+query, "", nil)
		if status != 200 {
			t.Fatalf("%s: %d %s", query, status, b)
		}
		return listedIDs(t, b)
	}
	q := func(text string) string { return "q=" + url.QueryEscape(text) }
	for _, tc := range []struct {
		query, first string
		includes     []string
	}{
		{q("ricota"), "pasta", nil},                // a typo in the title
		{q("Zitrone"), "kuchen", nil},              // a German word, as a prefix
		{q("лимон"), "pirog", nil},                 // Cyrillic, as a prefix
		{q("creme brulee"), "brulee", nil},         // without accents
		{q("CRÈME BRÛLÉE"), "brulee", nil},         // with them, in capitals
		{q("pancetta"), "carbonara", nil},          // an ingredient
		{q("panceta"), "carbonara", nil},           // a misspelt ingredient
		{q("lemons"), "pasta", []string{"cooler"}}, // stemmed; the title outranks the description
		{q("spag"), "", []string{"pasta", "carbonara"}},
		{"category=italian", "", []string{"pasta", "carbonara"}},
		{"category=ITALIAN&tag=Vegetarian", "pasta", nil},
		{q("lemon") + "&sort=Quickest", "cooler", []string{"pasta"}},
		{q("pasta") + "&maxMinutes=20", "pasta", nil},
		{q("lemon") + "&author=cook", "pasta", nil},
	} {
		ids := search(tc.query)
		if len(ids) == 0 || (tc.first != "" && ids[0] != tc.first) {
			t.Errorf("%s: %v, want %s first", tc.query, ids, tc.first)
		}
		for _, id := range tc.includes {
			if !slices.Contains(ids, id) {
				t.Errorf("%s: %v, missing %s", tc.query, ids, id)
			}
		}
		if slices.Contains(ids, "draft") || slices.Contains(ids, "suspended") {
			t.Errorf("%s: drafts and suspended cooks leaked: %v", tc.query, ids)
		}
	}
	if ids := search(q("Zitrone")); len(ids) != 1 {
		t.Errorf("Zitrone: %v", ids)
	}
	if ids := search(q("pasta") + "&maxMinutes=20"); !slices.Equal(ids, []string{"pasta"}) {
		t.Errorf("pasta under 20 minutes: %v", ids)
	}
	if ids := search(q("!!!")); len(ids) != 0 {
		t.Errorf("punctuation searched: %v", ids)
	}
	if ids := search(q("the")); len(ids) != 0 {
		t.Errorf("a stop word alone matched: %v", ids)
	}
	if ids := search(""); len(ids) != 6 || ids[0] != "cooler" {
		t.Errorf("newest first without a query: %v", ids)
	}
}

func TestRecipeSearchUsesIndexes(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	_, err := db.Exec(ctx, `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,tags,published)
 SELECT 'r'||n,'cook',
  (ARRAY['Lemon','Garlic','Tomato','Basil','Chicken','Beef','Pork','Tofu','Mushroom','Pepper'])[1+n%10]||' '||
  (ARRAY['pasta','soup','salad','stew','curry','tacos','risotto','pie','bowl','bread'])[1+(n/10)%10]||' '||md5(n::text),
  'A dish with plenty of flavour and texture, number '||n||'.',
  (ARRAY['Italian','French','Mexican','Indian','Thai','Greek','Spanish','Korean','Japanese','American'])[1+(n/7)%10],
  30+n%90,2,'Easy',
  jsonb_build_array(jsonb_build_object('name',(ARRAY['Onion','Carrot','Celery','Butter','Flour','Sugar','Salt','Olive oil','Rice','Cream'])[1+n%10],'amount',1,'unit','g','category','Pantry')),
  '[{"title":"Cook","text":"Cook it well."}]',
  ARRAY[(ARRAY['Vegetarian','Vegan','Breakfast','Dessert','Comfort food','Baking'])[1+n%6]],
  n%20<>0
 FROM generate_series(1,20000) n;
 UPDATE recipes SET tags='{Rare tag}',cuisine='Peruvian',minutes=5 WHERE id IN ('r21','r42','r63');
 ANALYZE recipes;`)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	// pgx prepares statements, so a cached generic plan must use the indexes too.
	if _, err := conn.Exec(ctx, "SET plan_cache_mode=force_generic_plan"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		query   recipeQuery
		indexes []string
	}{
		{"search", recipeQuery{Text: "ricota", Limit: 24}, []string{"recipes_search_idx", "recipes_title_trgm_idx", "recipes_ingredients_trgm_idx"}},
		{"tag", recipeQuery{Tag: "Rare tag", Limit: 24}, []string{"recipes_tags_idx"}},
		{"cuisine", recipeQuery{Cuisine: "peruvian", Limit: 24}, []string{"recipes_cuisine_idx"}},
		{"minutes", recipeQuery{MaxMinutes: 10, Limit: 24}, []string{"recipes_minutes_idx"}},
	} {
		sql, args, _ := tc.query.build()
		found, plan := planIndexes(t, conn, sql, args...)
		if _, err := conn.Exec(ctx, "PREPARE recipes_list AS "+sql); err != nil {
			t.Fatal(err)
		}
		generic, genericPlan := planIndexes(t, conn, "EXECUTE recipes_list("+sqlLiterals(args)+")")
		if _, err := conn.Exec(ctx, "DEALLOCATE recipes_list"); err != nil {
			t.Fatal(err)
		}
		for _, index := range tc.indexes {
			if !found[index] || !generic[index] {
				t.Errorf("%s doesn't use %s:\n%s\ngeneric:\n%s", tc.name, index, plan, genericPlan)
			}
		}
		t.Logf("%s:\n%s\ngeneric:\n%s", tc.name, plan, genericPlan)
	}
	if _, err := conn.Exec(ctx, "RESET plan_cache_mode"); err != nil {
		t.Fatal(err)
	}
}

// sqlLiterals writes test arguments as SQL for EXECUTE.
func sqlLiterals(args []any) string {
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	out := []string{}
	for _, a := range args {
		switch v := a.(type) {
		case string:
			out = append(out, quote(v))
		case []string:
			items := []string{}
			for _, s := range v {
				items = append(items, quote(s))
			}
			out = append(out, "ARRAY["+strings.Join(items, ",")+"]::text[]")
		default:
			out = append(out, fmt.Sprint(v))
		}
	}
	return strings.Join(out, ",")
}
