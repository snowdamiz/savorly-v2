package app

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/gofiber/fiber/v3"
)

// What /kitchen shows a member of their plans and pantry, as "day meal: title (by)" and
// "name (by)" lines, sorted.
type sharedKitchen struct {
	Plans []struct {
		ID, Day, Meal string
		Recipe        struct {
			ID, Title   string
			Ingredients []Ingredient
			Teaser      bool
		}
		PlannedBy *struct{ ID, Name string }
	}
	Pantry []struct {
		ID, Name string
		AddedBy  *struct{ ID, Name string }
	}
	PantryCover []string
}

func kitchenOf(t *testing.T, f *fiber.App, tok string) sharedKitchen {
	t.Helper()
	var k sharedKitchen
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/kitchen", tok, nil), &k); e != nil {
		t.Fatal(e)
	}
	return k
}

func (k sharedKitchen) planLines() []string {
	out := []string{}
	for _, p := range k.Plans {
		line := p.Day[:10] + " " + p.Meal + ": " + p.Recipe.Title
		if p.PlannedBy != nil {
			line += " (" + p.PlannedBy.Name + ")"
		}
		if p.Recipe.Teaser {
			line += " [private]"
		}
		out = append(out, line)
	}
	slices.Sort(out)
	return out
}

func (k sharedKitchen) pantryLines() []string {
	out := []string{}
	for _, p := range k.Pantry {
		line := p.Name
		if p.AddedBy != nil {
			line += " (" + p.AddedBy.Name + ")"
		}
		out = append(out, line)
	}
	slices.Sort(out)
	return out
}

func TestHouseholdsShareThePlanAndPantry(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	namedUser(t, db, "eve", "Eve")
	testUser(t, db, "cook")
	publishRecipe(t, db, "cook", "soup", func(r *RecipeInput) { r.Title = "Soup" })
	publishRecipe(t, db, "cook", "salad", func(r *RecipeInput) { r.Title = "Salad" })
	publishRecipe(t, db, "ben", "secret", func(r *RecipeInput) {
		r.Title = "Ben's secret stew"
		r.Published = false
		r.Ingredients = []Ingredient{{Name: "Smoked paprika", Amount: 1, Unit: "tsp"}}
	})
	f := recipesApp(db, false)
	ana, ben, eve := bearerFor(t, db, "ana"), bearerFor(t, db, "ben"), bearerFor(t, db, "eve")
	plan := func(tok, recipe, day, meal string) {
		t.Helper()
		mustCall(t, f, 200, "POST", "/v1/planner", tok, fiber.Map{"recipeId": recipe, "day": day, "meal": meal, "servings": 2})
	}
	stock := func(tok, name string) {
		t.Helper()
		mustCall(t, f, 201, "POST", "/v1/pantry", tok, fiber.Map{"name": name})
	}
	// Each starts with a kitchen of their own.
	plan(ana, "soup", "2026-11-02", "Dinner")
	plan(ana, "salad", "2026-11-03", "Lunch")
	stock(ana, "Eggs")
	stock(ana, "Rice")
	plan(ben, "salad", "2026-11-02", "Dinner")
	plan(ben, "secret", "2026-11-04", "Dinner")
	stock(ben, "Rice")
	stock(ben, "Cheddar")
	if got := kitchenOf(t, f, ana).planLines(); !slices.Equal(got, []string{"2026-11-02 Dinner: Soup", "2026-11-03 Lunch: Salad"}) {
		t.Fatalf("Ana's own plan: %v", got)
	}

	// Ana starts a household and Ben joins: his plans and pantry move in, except where the
	// household already has that day's meal or an item of that name.
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	want := []string{"2026-11-02 Dinner: Soup (Ana)", "2026-11-03 Lunch: Salad (Ana)", "2026-11-04 Dinner: Ben's secret stew (Ben)"}
	if got := kitchenOf(t, f, ben).planLines(); !slices.Equal(got, want) {
		t.Fatalf("Ben sees %v", got)
	}
	// Ana sees Ben's private recipe only as a teaser: its title, never how it's made.
	k := kitchenOf(t, f, ana)
	want[2] += " [private]"
	if got := k.planLines(); !slices.Equal(got, want) {
		t.Fatalf("Ana sees %v", got)
	}
	for _, p := range k.Plans {
		if p.Recipe.ID == "secret" && len(p.Recipe.Ingredients) != 0 {
			t.Fatalf("the teaser shows ingredients: %+v", p.Recipe)
		}
	}
	if got := k.pantryLines(); !slices.Equal(got, []string{"cheddar (Ben)", "eggs (Ana)", "rice (Ana)"}) {
		t.Fatalf("shared pantry: %v", got)
	}
	if !slices.Contains(k.PantryCover, "cheese") || !slices.Contains(k.PantryCover, "egg") {
		t.Fatalf("pantry cover %v", k.PantryCover)
	}

	// Either member plans over a slot, stocks and removes things; Eve, outside, can't touch them.
	plan(ben, "salad", "2026-11-02", "Dinner")
	stock(ben, "Eggs")
	var eggs, salad string
	for _, p := range kitchenOf(t, f, ana).Pantry {
		if p.Name == "eggs" {
			eggs = p.ID
		}
	}
	for _, p := range kitchenOf(t, f, ana).Plans {
		if p.Day[:10] == "2026-11-02" {
			salad = p.ID
		}
	}
	mustCall(t, f, 404, "DELETE", "/v1/pantry/"+eggs, eve, nil)
	mustCall(t, f, 404, "DELETE", "/v1/planner/"+salad, eve, nil)
	mustCall(t, f, 204, "DELETE", "/v1/pantry/"+eggs, ana, nil)
	if got := kitchenOf(t, f, ana).planLines(); got[0] != "2026-11-02 Dinner: Salad (Ben)" {
		t.Fatalf("Ben planned over Ana's slot: %v", got)
	}
	// Shopping the week takes every member's meals, the private one's ingredients included,
	// and leaves off what the shared pantry has.
	var shopped struct {
		Added   int
		Skipped []string
	}
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/planner/groceries", ana, fiber.Map{"from": "2026-11-02", "to": "2026-11-08", "skipPantry": true}), &shopped); e != nil {
		t.Fatal(e)
	}
	names := []string{}
	for _, g := range groceriesOf(t, f, ben) {
		names = append(names, g.Name)
	}
	if !slices.Contains(names, "Smoked paprika") || !slices.Contains(names, "Pasta") {
		t.Fatalf("week groceries %v (%+v)", names, shopped)
	}

	// Ben leaves with nothing; Ana, the last one out, keeps the kitchen.
	mustCall(t, f, 204, "DELETE", "/v1/household/members/ben", ben, nil)
	if k := kitchenOf(t, f, ben); len(k.Plans)+len(k.Pantry) != 0 {
		t.Fatalf("Ben left with %v %v", k.planLines(), k.pantryLines())
	}
	mustCall(t, f, 204, "DELETE", "/v1/household/members/ana", ana, nil)
	k = kitchenOf(t, f, ana)
	if got := k.pantryLines(); !slices.Equal(got, []string{"cheddar", "rice"}) {
		t.Fatalf("Ana keeps the pantry: %v", got)
	}
	if len(k.Plans) != 3 {
		t.Fatalf("Ana keeps the plan: %v", k.planLines())
	}
	var households int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM households`).Scan(&households); e != nil || households != 0 {
		t.Fatalf("households left: %d %v", households, e)
	}
}

func TestHouseholdPantryRemindersReachEveryMember(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	hour := pantryHour
	t.Cleanup(func() { pantryHour = hour })
	pantryHour = 0
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	registerDevice(t, db, "ana")
	registerDevice(t, db, "ben")
	f := recipesApp(db, false)
	ana, ben := bearerFor(t, db, "ana"), bearerFor(t, db, "ben")
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	var today string
	if e := db.QueryRow(ctx, `SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD')`).Scan(&today); e != nil {
		t.Fatal(e)
	}
	mustCall(t, f, 201, "POST", "/v1/pantry", ben, fiber.Map{"name": "Milk", "expiresOn": today})
	expo := newFakeExpo(t)
	n := expo.notifier(db)
	if got, e := n.pantryPass(ctx); e != nil || got != 2 {
		t.Fatalf("reminded %d (%v), want both members", got, e)
	}
	drain(t, n)
	for _, who := range []string{"ana", "ben"} {
		if m := expo.sent()[deviceToken(who)]; len(m) != 1 || m[0].Body != "Use soon: milk" {
			t.Fatalf("%s got %v", who, m)
		}
	}
}

func TestHousematesShareTheirDietsWhenTheyChoose(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	testUser(t, db, "cook")
	publishRecipe(t, db, "cook", "satay", func(r *RecipeInput) {
		r.Ingredients = []Ingredient{{Name: "Peanut butter"}, {Name: "Lime"}}
	})
	publishRecipe(t, db, "cook", "salad", func(r *RecipeInput) { r.Ingredients = []Ingredient{{Name: "Lettuce"}} })
	f := recipesApp(db, false)
	ana, ben := bearerFor(t, db, "ana"), bearerFor(t, db, "ben")
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	mustCall(t, f, 200, "PATCH", "/v1/me", ben, fiber.Map{"name": "Ben", "preferences": fiber.Map{"diets": []string{}, "allergies": []string{"Peanuts"}}})
	fits := func() int {
		t.Helper()
		var list []json.RawMessage
		if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recipes?fits=me", ana, nil), &list); e != nil {
			t.Fatal(e)
		}
		return len(list)
	}
	housemates := func() []any {
		t.Helper()
		return jsonObject(t, mustCall(t, f, 200, "GET", "/v1/me", ana, nil))["householdAvoid"].([]any)
	}
	// Private until Ben shares them.
	if n, h := fits(), housemates(); n != 2 || len(h) != 0 {
		t.Fatalf("before sharing: %d recipes fit, housemates %v", n, h)
	}
	mustCall(t, f, 200, "PATCH", "/v1/me/preferences", ben, fiber.Map{"shareDiet": true})
	h := housemates()
	if n := fits(); n != 1 || len(h) != 1 {
		t.Fatalf("after sharing: %d recipes fit, housemates %v", n, h)
	}
	if who := h[0].(map[string]any); who["name"] != "Ben" || who["avoid"].(map[string]any)["groups"].(map[string]any)["peanut"] == nil {
		t.Fatalf("housemate %v", who)
	}
	// Ben's own list isn't Ana's to see once he leaves.
	mustCall(t, f, 204, "DELETE", "/v1/household/members/ben", ben, nil)
	if n, h := fits(), housemates(); n != 2 || len(h) != 0 {
		t.Fatalf("after leaving: %d recipes fit, housemates %v", n, h)
	}
	_ = ctx
}
