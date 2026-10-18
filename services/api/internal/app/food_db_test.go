package app

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestRecipesCarryTheirAllergens(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	publishRecipe(t, db, "cook", "satay", func(r *RecipeInput) {
		r.Ingredients = []Ingredient{{Name: "Chicken thighs", Amount: 500, Unit: "g"}, {Name: "Peanut butter", Amount: 3, Unit: "tbsp"}, {Name: "Soy sauce", Amount: 2, Unit: "tbsp"}, {Name: "Lime"}}
	})
	f := recipesApp(db, false)
	var r struct {
		Allergens      []string          `json:"allergens"`
		IngredientFood []ingredientFacts `json:"ingredientFood"`
	}
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recipes/satay", "", nil), &r); e != nil {
		t.Fatal(e)
	}
	if !slices.Equal(r.Allergens, []string{"peanut", "gluten", "soy", "poultry"}) {
		t.Fatalf("allergens %v", r.Allergens)
	}
	if len(r.IngredientFood) != 4 || r.IngredientFood[1].Key != "peanut butter" || !slices.Equal(r.IngredientFood[1].Allergens, []string{"peanut"}) || len(r.IngredientFood[3].Allergens) != 0 {
		t.Fatalf("ingredient facts %+v", r.IngredientFood)
	}
	// An edit indexes again in the same save.
	mustCall(t, f, 200, "PUT", "/v1/recipes/satay", bearerFor(t, db, "cook"), func() RecipeInput {
		in := validRecipe()
		in.Published = true
		in.Ingredients = []Ingredient{{Name: "Tofu", Amount: 400, Unit: "g"}}
		return in
	}())
	var allergens []string
	if e := db.QueryRow(ctx, `SELECT allergens FROM recipes WHERE id='satay'`).Scan(&allergens); e != nil || !slices.Equal(allergens, []string{"soy"}) {
		t.Fatalf("after the edit: %v %v", allergens, e)
	}
}

func TestIndexFoodsCatchesUp(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "member")
	publishRecipe(t, db, "cook", "soup", nil)
	// A write that doesn't index (another server version, a hand edit), a row indexed under an
	// older lexicon, a pantry item and a member's preferences from before the index existed.
	_, e := db.Exec(ctx, `UPDATE recipes SET ingredients='[{"name":"Shrimp","amount":200,"unit":"g","category":""}]' WHERE id='soup';
 INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps) VALUES('old','cook','Old toast','Toast from before the index.','French',5,1,'Easy','[{"name":"Butter","amount":1,"unit":"tbsp","category":""}]','[{"title":"Toast","text":"Toast the bread."}]');
 INSERT INTO pantry(id,user_id,name) VALUES('p1','member','cheddar');
 UPDATE users SET preferences='{"diets":["Vegan"],"allergies":["sesame"]}' WHERE id='member'`)
	if e != nil {
		t.Fatal(e)
	}
	n, e := indexFoods(ctx, db)
	if e != nil {
		t.Fatal(e)
	}
	if n != 4 {
		t.Fatalf("indexed %d, want 2 recipes, a pantry item and a member", n)
	}
	var soup, old, keys, groups []string
	if e = db.QueryRow(ctx, `SELECT (SELECT allergens FROM recipes WHERE id='soup'),(SELECT allergens FROM recipes WHERE id='old'),(SELECT food_keys FROM pantry WHERE id='p1'),(SELECT groups FROM food_avoid WHERE user_id='member')`).Scan(&soup, &old, &keys, &groups); e != nil {
		t.Fatal(e)
	}
	if !slices.Equal(soup, []string{"shellfish"}) || !slices.Equal(old, []string{"milk"}) || !slices.Equal(keys, []string{"cheddar", "cheese"}) || !slices.Contains(groups, "sesame") || !slices.Contains(groups, "honey") {
		t.Fatalf("soup %v, old %v, pantry %v, member %v", soup, old, keys, groups)
	}
	if n, e = indexFoods(ctx, db); e != nil || n != 0 {
		t.Fatalf("second pass indexed %d: %v", n, e)
	}
}

func TestAvoidListsFollowTheProfile(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "member")
	publishRecipe(t, db, "cook", "pad-thai", func(r *RecipeInput) {
		r.Title = "Pad thai"
		r.Ingredients = []Ingredient{{Name: "Rice noodles"}, {Name: "Shrimp"}, {Name: "Peanuts"}, {Name: "Cilantro"}}
	})
	publishRecipe(t, db, "cook", "salad", func(r *RecipeInput) {
		r.Title = "Green salad"
		r.Ingredients = []Ingredient{{Name: "Lettuce"}, {Name: "Coriander leaves"}}
	})
	publishRecipe(t, db, "cook", "toast", func(r *RecipeInput) {
		r.Title = "Butter toast"
		r.Ingredients = []Ingredient{{Name: "Bread"}, {Name: "Butter"}}
	})
	f := recipesApp(db, false)
	member := bearerFor(t, db, "member")
	profile := func(diets, allergies []string) map[string]any {
		t.Helper()
		b := mustCall(t, f, 200, "PATCH", "/v1/me", member, fiber.Map{"name": "Member", "preferences": fiber.Map{"diets": diets, "allergies": allergies}})
		return jsonObject(t, b)["avoid"].(map[string]any)
	}
	avoid := profile([]string{}, []string{"Peanuts"})
	if groups := avoid["groups"].(map[string]any); len(groups) != 1 || groups["peanut"] == nil {
		t.Fatalf("avoid %v", avoid)
	}
	ids := func(token, query string) []string {
		t.Helper()
		var list []struct{ ID string }
		if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recipes?"+query, token, nil), &list); e != nil {
			t.Fatal(e)
		}
		out := []string{}
		for _, r := range list {
			out = append(out, r.ID)
		}
		slices.Sort(out)
		return out
	}
	if got := ids(member, "fits=me"); !slices.Equal(got, []string{"salad", "toast"}) {
		t.Fatalf("fits peanuts: %v", got)
	}
	// Cilantro by any name, and a vegan diet.
	profile([]string{"Vegan"}, []string{"cilantro"})
	if got := ids(member, "fits=me"); len(got) != 0 {
		t.Fatalf("fits vegan without cilantro: %v", got)
	}
	// Guests and members without the filter see everything; clearing the profile clears it.
	if got := ids("", "fits=me"); len(got) != 3 {
		t.Fatalf("guest: %v", got)
	}
	profile([]string{}, []string{})
	if got := ids(member, "fits=me"); len(got) != 3 {
		t.Fatalf("after clearing: %v", got)
	}
	var rows int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM food_avoid WHERE user_id='member'`).Scan(&rows); e != nil || rows != 0 {
		t.Fatalf("avoid rows %d %v", rows, e)
	}
	// The sous-chef searches the same way, unless asked for a recipe regardless.
	a := &App{DB: db}
	profile([]string{}, []string{"shrimp"})
	turn := &toolTurn{a: a, ctx: ctx, run: &agentRun{}, owner: "member", in: &toolArgs{Query: "pad thai"}}
	var found struct{ Recipes []map[string]any }
	_ = json.Unmarshal([]byte(turn.searchRecipes()), &found)
	if len(found.Recipes) != 0 {
		t.Fatalf("the sous-chef suggested %v", found.Recipes)
	}
	turn.in.IncludeAvoided = true
	_ = json.Unmarshal([]byte(turn.searchRecipes()), &found)
	if len(found.Recipes) != 1 || found.Recipes[0]["allergens"] == nil || found.Recipes[0]["ingredientFood"] != nil {
		t.Fatalf("asked by name: %v", found.Recipes)
	}
}

func TestCookingFromThePantry(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, u := range []string{"cook", "member", "other", "banned"} {
		testUser(t, db, u)
	}
	publishRecipe(t, db, "cook", "omelette", func(r *RecipeInput) {
		r.Ingredients = []Ingredient{{Name: "Eggs", Amount: 3}, {Name: "Grated cheese", Amount: 30, Unit: "g"}, {Name: "Salt"}, {Name: "Butter", Amount: 1, Unit: "tbsp"}}
	})
	publishRecipe(t, db, "cook", "spinach-eggs", func(r *RecipeInput) {
		r.Ingredients = []Ingredient{{Name: "Eggs", Amount: 2}, {Name: "Baby spinach", Amount: 100, Unit: "g"}, {Name: "Garlic", Amount: 1, Unit: "clove"}, {Name: "Olive oil"}}
	})
	publishRecipe(t, db, "cook", "curry", func(r *RecipeInput) {
		r.Ingredients = []Ingredient{{Name: "Chickpeas"}, {Name: "Coconut milk"}, {Name: "Onion"}, {Name: "Garlic"}, {Name: "Ginger"}, {Name: "Spinach"}}
	})
	publishRecipe(t, db, "member", "my-draft", func(r *RecipeInput) {
		r.Published = false
		r.Ingredients = []Ingredient{{Name: "Spinach"}, {Name: "Cheddar"}}
	})
	publishRecipe(t, db, "other", "their-draft", func(r *RecipeInput) {
		r.Published = false
		r.Ingredients = []Ingredient{{Name: "Eggs"}}
	})
	publishRecipe(t, db, "banned", "hidden", func(r *RecipeInput) { r.Ingredients = []Ingredient{{Name: "Eggs"}} })
	suspend(t, db, "banned", true)
	f := recipesApp(db, false)
	member := bearerFor(t, db, "member")
	for _, item := range []fiber.Map{{"name": "Eggs"}, {"name": "Cheddar"}, {"name": "Spinach", "expiresOn": "2000-01-01"}, {"name": "Zwiebeln"}} {
		mustCall(t, f, 201, "POST", "/v1/pantry", member, item)
	}
	var kitchen struct{ PantryCover []string }
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/kitchen", member, nil), &kitchen); e != nil {
		t.Fatal(e)
	}
	if !slices.Equal(kitchen.PantryCover, []string{"cheddar", "cheese", "egg", "onion", "spinach"}) {
		t.Fatalf("pantry cover %v", kitchen.PantryCover)
	}
	type match struct {
		Recipe                  struct{ ID string }
		Have, Missing, Expiring []string
	}
	matches := func() []match {
		t.Helper()
		var out struct{ Matches []match }
		if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/kitchen/pantry-recipes", member, nil), &out); e != nil {
			t.Fatal(e)
		}
		return out.Matches
	}
	got := matches()
	order := []string{}
	for _, m := range got {
		order = append(order, m.Recipe.ID)
	}
	// Nothing missing first (the member's own draft, which uses expiring spinach, then the
	// omelette, salt being a staple); the curry needs too much to suggest; others' drafts and
	// suspended cooks' recipes never show.
	if !slices.Equal(order, []string{"my-draft", "omelette", "spinach-eggs"}) {
		t.Fatalf("order %v", order)
	}
	if !slices.Equal(got[1].Have, []string{"Eggs", "Grated cheese"}) || !slices.Equal(got[1].Missing, []string{"Butter"}) {
		t.Fatalf("omelette %+v", got[1])
	}
	if !slices.Equal(got[2].Missing, []string{"Garlic", "Olive oil"}) || !slices.Equal(got[2].Expiring, []string{"Baby spinach"}) {
		t.Fatalf("spinach eggs %+v", got[2])
	}
	// What the member avoids isn't suggested.
	mustCall(t, f, 200, "PATCH", "/v1/me", member, fiber.Map{"name": "Member", "preferences": fiber.Map{"diets": []string{"Dairy free"}, "allergies": []string{}}})
	if got = matches(); len(got) != 1 || got[0].Recipe.ID != "spinach-eggs" {
		t.Fatalf("dairy free: %+v", got)
	}
	// An empty pantry suggests nothing, without a query.
	other := bearerFor(t, db, "other")
	if b := mustCall(t, f, 200, "GET", "/v1/kitchen/pantry-recipes", other, nil); string(b) != `{"matches":[]}` {
		t.Fatalf("empty pantry: %s", b)
	}
	_ = ctx
}

func TestShoppingSkipsThePantry(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "member")
	publishRecipe(t, db, "cook", "omelette", func(r *RecipeInput) {
		r.Ingredients = []Ingredient{{Name: "Eggs", Amount: 3}, {Name: "Grated cheese", Amount: 30, Unit: "g"}, {Name: "Salt"}, {Name: "Chives", Amount: 1, Unit: "tbsp"}}
	})
	f := recipesApp(db, false)
	member := bearerFor(t, db, "member")
	mustCall(t, f, 201, "POST", "/v1/pantry", member, fiber.Map{"name": "Parmesan"})
	var out struct {
		Added, Merged int
		Skipped       []string
	}
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/recipes/omelette/groceries", member, fiber.Map{"servings": 2, "skipPantry": true}), &out); e != nil {
		t.Fatal(e)
	}
	if out.Added != 2 || !slices.Equal(out.Skipped, []string{"Grated cheese", "Salt"}) {
		t.Fatalf("skipping the pantry: %+v", out)
	}
	var names []string
	if e := db.QueryRow(ctx, `SELECT array_agg(name ORDER BY name) FROM groceries WHERE user_id='member'`).Scan(&names); e != nil || !slices.Equal(names, []string{"Chives", "Eggs"}) {
		t.Fatalf("list %v %v", names, e)
	}
	// Older apps send no flag and get every line, as before, and no skipped list.
	out.Skipped = nil
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/recipes/omelette/groceries", member, fiber.Map{"servings": 2}), &out); e != nil {
		t.Fatal(e)
	}
	if out.Added != 2 || out.Merged != 2 || out.Skipped != nil {
		t.Fatalf("without the flag: %+v", out)
	}
}
