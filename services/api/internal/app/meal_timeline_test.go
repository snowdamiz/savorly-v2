package app

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Steps in minutes, as the meals below are written.
func hands(minutes int) mealStep { return mealStep{active: minutes * 60} }
func waits(minutes int) mealStep { return mealStep{active: 60, wait: (minutes - 1) * 60} }
func baked(minutes, heat int) mealStep {
	return mealStep{active: 60, wait: (minutes - 1) * 60, oven: heat}
}
func onHob(s mealStep) mealStep   { s.burners = 1; return s }
func preheated(heat int) mealStep { return mealStep{oven: heat} }

var (
	roastChicken  = []mealStep{preheated(220), hands(10), baked(75, 220), waits(15), hands(10)}
	roastPotatoes = []mealStep{hands(15), onHob(waits(10)), hands(3), baked(45, 220)}
	greenBeans    = []mealStep{hands(5), onHob(waits(5)), hands(2)}
)

// checkPlan fails unless plan has every step of every dish once, each dish's steps in their
// order (a preheat right before the oven step it's for), the cook's hands on one step at a time,
// and everything over by the meal.
func checkPlan(t *testing.T, dishes [][]mealStep, plan mealSchedule) {
	t.Helper()
	seen := map[[2]int]placedStep{}
	for _, p := range plan.steps {
		if _, twice := seen[[2]int{p.dish, p.step}]; twice {
			t.Fatalf("dish %d step %d placed twice", p.dish, p.step)
		}
		seen[[2]int{p.dish, p.step}] = p
		if p.end > 0 || p.start > p.end {
			t.Fatalf("dish %d step %d runs %d to %d", p.dish, p.step, p.start, p.end)
		}
	}
	for d, steps := range dishes {
		for i := range steps {
			if _, ok := seen[[2]int{d, i}]; !ok {
				t.Fatalf("dish %d step %d left out", d, i)
			}
		}
		last := -1 << 31
		for i := range steps {
			p := seen[[2]int{d, i}]
			if p.preheating {
				continue
			}
			if p.start < last {
				t.Fatalf("dish %d step %d starts at %d, before the step before it ends (%d)", d, i, p.start, last)
			}
			last = p.end
		}
	}
	for i, a := range plan.steps {
		for _, b := range plan.steps[i+1:] {
			if a.active > 0 && b.active > 0 && a.start < b.handsEnd() && b.start < a.handsEnd() {
				t.Fatalf("hands on two steps at once: %+v and %+v", a, b)
			}
		}
	}
}

func stepOf(plan mealSchedule, dish, step int) placedStep {
	for _, p := range plan.steps {
		if p.dish == dish && p.step == step {
			return p
		}
	}
	return placedStep{}
}

func kinds(plan mealSchedule) string {
	var out []string
	for _, w := range plan.warnings {
		out = append(out, w.kind)
	}
	return strings.Join(out, ",")
}

// dump shows a plan the way the app lists it, for failures.
func dump(plan mealSchedule) string {
	var b strings.Builder
	for _, p := range plan.steps {
		fmt.Fprintf(&b, "%4d..%4d dish %d step %d hands %d wait %d oven %d burners %d preheat %v\n", p.start/60, p.end/60, p.dish, p.step, p.active/60, p.wait/60, p.oven, p.burners, p.preheating)
	}
	for _, f := range plan.free {
		fmt.Fprintf(&b, "free %d..%d\n", f[0]/60, f[1]/60)
	}
	for _, w := range plan.warnings {
		fmt.Fprintf(&b, "warning %+v\n", w)
	}
	return b.String()
}

func TestRoastWithTwoSidesIsReadyTogether(t *testing.T) {
	dishes := [][]mealStep{roastChicken, roastPotatoes, greenBeans}
	plan := scheduleMeal(dishes, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, dishes, plan)
	if len(plan.warnings) != 0 {
		t.Fatalf("one oven at 220 °C and two burners fit:\n%s", dump(plan))
	}
	// The longest dish takes the last minutes: the chicken is carved as the meal starts, and the
	// sides finish just before, within a quarter of an hour.
	if carve := stepOf(plan, 0, 4); carve.end != 0 {
		t.Fatalf("the chicken isn't ready at the meal:\n%s", dump(plan))
	}
	for _, d := range []int{1, 2} {
		if last := stepOf(plan, d, len(dishes[d])-1); last.end < -standing {
			t.Fatalf("dish %d is ready %d minutes early:\n%s", d, -last.end/60, dump(plan))
		}
	}
	// The oven is heated for the roast, a quarter of an hour ahead, and the potatoes share it.
	roast, preheat := stepOf(plan, 0, 2), stepOf(plan, 0, 0)
	if !preheat.preheating || preheat.end != roast.start || preheat.start != roast.start-preheatSeconds {
		t.Fatalf("preheat %+v for roast %+v", preheat, roast)
	}
	if potatoes := stepOf(plan, 1, 3); potatoes.start >= roast.end || potatoes.end <= roast.start {
		t.Fatalf("the potatoes don't roast with the chicken:\n%s", dump(plan))
	}
	// Starting is the preheat; the long roast leaves free time.
	if plan.start != preheat.start || len(plan.free) == 0 {
		t.Fatalf("start %d, free %v:\n%s", plan.start, plan.free, dump(plan))
	}
}

func TestHolidayDinnerOfFourWarnsWhatOneOvenCantDo(t *testing.T) {
	turkey := []mealStep{preheated(180), hands(20), baked(180, 180), waits(30), hands(15)}
	potatoes := []mealStep{hands(20), onHob(waits(8)), hands(5), baked(50, 220)}
	stuffing := []mealStep{onHob(hands(10)), hands(10), baked(40, 190)}
	cranberries := []mealStep{onHob(waits(15)), waits(60)}
	dishes := [][]mealStep{turkey, potatoes, stuffing, cranberries}
	plan := scheduleMeal(dishes, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, dishes, plan)
	// The turkey comes out a little early so the potatoes roast at 220 °C while it rests, but the
	// stuffing's 190 °C clashes with them: one oven can't, and the plan says so rather than bake
	// the stuffing an hour early.
	turkeyOut, potatoesIn, stuffingIn := stepOf(plan, 0, 2), stepOf(plan, 1, 3), stepOf(plan, 2, 2)
	if turkeyOut.end > potatoesIn.start {
		t.Fatalf("the turkey and the potatoes share the oven at two heats:\n%s", dump(plan))
	}
	if len(plan.warnings) != 1 || plan.warnings[0].kind != "oven" || !slices.Equal(plan.warnings[0].dishes, []int{1, 2}) ||
		!slices.Equal(plan.warnings[0].heats, []int{220, 190}) || plan.warnings[0].at != stuffingIn.start {
		t.Fatalf("warnings:\n%s", dump(plan))
	}
	// The cranberry sauce, made ahead, cools while the turkey roasts; every dish is ready within
	// a quarter of an hour of the meal.
	for d := range dishes {
		if last := stepOf(plan, d, len(dishes[d])-1); last.end < -standing {
			t.Fatalf("dish %d is ready %d minutes early:\n%s", d, -last.end/60, dump(plan))
		}
	}
	// A second oven takes the potatoes at their own heat.
	plan = scheduleMeal(dishes, mealKitchen{Burners: 4, Ovens: 2})
	checkPlan(t, dishes, plan)
	if len(plan.warnings) != 0 {
		t.Fatalf("two ovens:\n%s", dump(plan))
	}
}

func TestWeeknightMainAndTwoSidesShareTheHob(t *testing.T) {
	salmon := []mealStep{hands(5), onHob(hands(8)), waits(3)}
	rice := []mealStep{hands(3), onHob(waits(18)), waits(5)}
	salad := []mealStep{hands(10), hands(2)}
	dishes := [][]mealStep{salmon, rice, salad}
	plan := scheduleMeal(dishes, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, dishes, plan)
	if len(plan.warnings) != 0 {
		t.Fatalf("warnings:\n%s", dump(plan))
	}
	// The rice, the longest, starts first and rests while the salmon cooks; nothing waits long.
	if first := plan.steps[0]; first.dish != 1 {
		t.Fatalf("the rice doesn't start first:\n%s", dump(plan))
	}
	if total := -plan.start / 60; total > 45 {
		t.Fatalf("dinner takes %d minutes:\n%s", total, dump(plan))
	}
}

func TestMoreBurnersThanTheKitchenHasIsAWarning(t *testing.T) {
	// Three long simmers that all end at the meal, on a two-burner hob.
	stew := []mealStep{hands(10), onHob(waits(90))}
	soup := []mealStep{hands(10), onHob(waits(60))}
	sauce := []mealStep{hands(5), onHob(waits(45))}
	dishes := [][]mealStep{stew, soup, sauce}
	plan := scheduleMeal(dishes, mealKitchen{Burners: 2, Ovens: 1})
	checkPlan(t, dishes, plan)
	if kinds(plan) != "burners" || plan.warnings[0].needed != 3 || plan.warnings[0].have != 2 {
		t.Fatalf("warnings:\n%s", dump(plan))
	}
	// Four burners hold them all.
	plan = scheduleMeal(dishes, mealKitchen{Burners: 4, Ovens: 1})
	if len(plan.warnings) != 0 {
		t.Fatalf("four burners:\n%s", dump(plan))
	}
	// A short clash moves a step a little earlier instead: two pans for the last 10 minutes.
	pasta := []mealStep{onHob(waits(10))}
	greens := []mealStep{hands(4), onHob(hands(6))}
	sauce = []mealStep{onHob(waits(12))}
	dishes = [][]mealStep{pasta, greens, sauce}
	plan = scheduleMeal(dishes, mealKitchen{Burners: 2, Ovens: 1})
	checkPlan(t, dishes, plan)
	if len(plan.warnings) != 0 {
		t.Fatalf("a short clash warned:\n%s", dump(plan))
	}
}

func TestTooManyHandsAtOnceIsAWarning(t *testing.T) {
	// Four dishes finished by hand in their last 10 minutes: one cook staggers them, and the
	// first done waits.
	finish := func() []mealStep { return []mealStep{waits(30), hands(10)} }
	dishes := [][]mealStep{finish(), finish(), finish(), finish()}
	plan := scheduleMeal(dishes, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, dishes, plan)
	if kinds(plan) != "hands,hands" {
		t.Fatalf("warnings:\n%s", dump(plan))
	}
	early := plan.warnings[0]
	if early.seconds != 30*60 || stepOf(plan, early.dishes[0], 1).end != -30*60 {
		t.Fatalf("the earliest dish waits %d minutes:\n%s", early.seconds/60, dump(plan))
	}
}

func TestAPreheatGoesAheadOfItsOvenStep(t *testing.T) {
	// "Preheat the oven" first, then twenty minutes of work, then the bake.
	tart := []mealStep{preheated(190), hands(10), hands(10), baked(30, 190), waits(10)}
	plan := scheduleMeal([][]mealStep{tart, greenBeans}, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, [][]mealStep{tart, greenBeans}, plan)
	bake, heat := stepOf(plan, 0, 3), stepOf(plan, 0, 0)
	if !heat.preheating || heat.end != bake.start || heat.start != bake.start-preheatSeconds || heat.start <= stepOf(plan, 0, 1).start {
		t.Fatalf("preheat:\n%s", dump(plan))
	}
	// A preheat with no oven step after it stays where the recipe has it, taking no time.
	odd := []mealStep{hands(5), preheated(200), hands(5)}
	plan = scheduleMeal([][]mealStep{odd, greenBeans}, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, [][]mealStep{odd, greenBeans}, plan)
	if p := stepOf(plan, 0, 1); p.preheating || p.start != p.end {
		t.Fatalf("lone preheat:\n%s", dump(plan))
	}
	// Heating the oven for another heat while a dish bakes is a clash too, unless the dish can come
	// out a little early: a cake that cools for 20 minutes can, one served warm can't.
	pizza := []mealStep{preheated(250), hands(10), baked(12, 250)}
	cake := []mealStep{baked(40, 160), waits(20)}
	plan = scheduleMeal([][]mealStep{cake, pizza}, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, [][]mealStep{cake, pizza}, plan)
	if len(plan.warnings) != 0 || stepOf(plan, 0, 0).end > stepOf(plan, 1, 0).start {
		t.Fatalf("the cake comes out before the oven heats:\n%s", dump(plan))
	}
	cake = []mealStep{baked(40, 160), waits(2)}
	plan = scheduleMeal([][]mealStep{cake, pizza}, mealKitchen{Burners: 4, Ovens: 1})
	checkPlan(t, [][]mealStep{cake, pizza}, plan)
	if kinds(plan) != "oven" || !slices.Equal(plan.warnings[0].heats, []int{250, 160}) {
		t.Fatalf("warm cake:\n%s", dump(plan))
	}
}

func TestEveryStepOfAnyMealIsPlaced(t *testing.T) {
	// Meals made of every kind of step, in every size of kitchen: whatever the kitchen can't do,
	// no step is ever left out, steps keep their order, and the cook does one thing at a time.
	kinds := []mealStep{hands(4), hands(12), waits(25), onHob(waits(15)), onHob(hands(7)), baked(35, 180), baked(50, 220), preheated(200), preheated(180), {}}
	seed := uint32(7)
	random := func(n int) int {
		seed = seed*1664525 + 1013904223
		return int(seed>>8) % n
	}
	for round := 0; round < 400; round++ {
		dishes := make([][]mealStep, 2+random(3))
		for d := range dishes {
			for range 1 + random(9) {
				dishes[d] = append(dishes[d], kinds[random(len(kinds))])
			}
		}
		plan := scheduleMeal(dishes, mealKitchen{Burners: 1 + random(4), Ovens: 1 + random(2)})
		checkPlan(t, dishes, plan)
	}
}

func TestCookTestedTimesReplaceTheWrittenOnes(t *testing.T) {
	// A bake cooks found takes 40 minutes, not 25: the extra is waiting.
	if s, tested := mealStepOf(StepTiming{Active: 60, Wait: 1440, Oven: 200}, 2400); !tested || s != (mealStep{active: 60, wait: 2340, oven: 200}) {
		t.Fatalf("bake: %+v %v", s, tested)
	}
	// Chopping that takes 9 minutes, not 5.
	if s, tested := mealStepOf(StepTiming{Active: 300}, 540); !tested || s != (mealStep{active: 540}) {
		t.Fatalf("chop: %+v %v", s, tested)
	}
	// A wait shorter than its hands-on part is all hands.
	if s, _ := mealStepOf(StepTiming{Active: 300, Wait: 600}, 200); s != (mealStep{active: 180}) {
		t.Fatalf("short: %+v", s)
	}
	// A preheat keeps the timeline's own time; untested steps round to whole minutes.
	if s, tested := mealStepOf(StepTiming{Oven: 200}, 900); tested || !s.preheat() {
		t.Fatalf("preheat: %+v %v", s, tested)
	}
	if s, tested := mealStepOf(StepTiming{Active: 20, Wait: 95}, 0); tested || s != (mealStep{active: 60, wait: 120}) {
		t.Fatalf("rounding: %+v %v", s, tested)
	}
}

func TestOvenHeatsWithinTenDegreesAreOne(t *testing.T) {
	if got := distinctHeats([]int{180, 190, 220, 185}); !slices.Equal(got, []int{220, 190}) {
		t.Fatalf("heats %v", got)
	}
	// 175 °C is too far from 190 °C, and 180 °C goes with 190 °C.
	if got := distinctHeats([]int{180, 190, 175}); !slices.Equal(got, []int{190, 175}) {
		t.Fatalf("heats %v", got)
	}
	if got := distinctHeats([]int{200}); !slices.Equal(got, []int{200}) {
		t.Fatalf("heats %v", got)
	}
}

// mealRecipesFor adds a roast chicken and green beans by author, published, and a private salad.
func mealRecipesFor(t *testing.T, db *pgxpool.Pool, author, cook string) {
	t.Helper()
	publishRecipe(t, db, author, "roast", func(r *RecipeInput) {
		r.Title, r.Minutes = "Roast chicken", 110
		r.Steps = []Step{
			{Title: "Heat", Text: "Preheat the oven to 220 °C."},
			{Title: "Season", Text: "Season the chicken all over.", Timing: &StepTiming{Active: 600}},
			{Title: "Roast", Text: "Roast for 75 minutes."},
			{Title: "Rest", Text: "Let it rest for 15 minutes."},
			{Title: "Carve", Text: "Carve and serve.", Timing: &StepTiming{Active: 600}},
		}
	})
	publishRecipe(t, db, author, "beans", func(r *RecipeInput) {
		r.Title, r.Minutes = "Green beans", 15
		r.Steps = []Step{{Title: "Trim", Text: "Trim the beans."}, {Title: "Boil", Text: "Boil for 5 minutes."}, {Title: "Toss", Text: "Toss with butter.", Timing: &StepTiming{Active: 120}}}
	})
	publishRecipe(t, db, cook, "salad", func(r *RecipeInput) {
		r.Title, r.Published = "Salad", false
		r.Steps = []Step{{Title: "Toss", Text: "Toss the leaves with the dressing.", Timing: &StepTiming{Active: 300}}}
	})
	publishRecipe(t, db, author, "secret", func(r *RecipeInput) { r.Published = false })
}

func TestMealTimelineAnswersOnePlanForTheDishes(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "author")
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	token := bearerFor(t, db, "cook")
	mealRecipesFor(t, db, "author", "cook")
	berlin, _ := time.LoadLocation("Europe/Berlin")
	eat := time.Now().In(berlin).Add(24 * time.Hour).Truncate(time.Minute)
	body := func(recipes ...string) map[string]any {
		return map[string]any{"recipes": recipes, "eatAt": eat.Format("2006-01-02T15:04"), "timeZone": "Europe/Berlin"}
	}
	mustCall(t, f, 401, "POST", "/v1/meals/timeline", "", body("roast", "beans"))
	for _, bad := range []map[string]any{
		body("roast"), body("roast", "beans", "salad", "roast"), body("roast", "beans", "salad", "x", "y"),
		{"recipes": []string{"roast", "beans"}, "eatAt": "tonight", "timeZone": "Europe/Berlin"},
		{"recipes": []string{"roast", "beans"}, "eatAt": time.Now().Add(-48 * time.Hour).Format(time.RFC3339)},
		{"recipes": []string{"roast", "beans"}, "eatAt": eat.Format("2006-01-02T15:04"), "timeZone": "Mars/Olympus"},
		{"recipes": []string{"roast", "beans"}, "eatAt": eat.Format(time.RFC3339), "kitchen": map[string]int{"burners": 0, "ovens": 1}},
	} {
		mustCall(t, f, 400, "POST", "/v1/meals/timeline", token, bad)
	}
	// Someone else's private recipe isn't theirs to cook.
	mustCall(t, f, 404, "POST", "/v1/meals/timeline", token, body("roast", "secret"))

	// Cooks found the beans boil for 15 minutes, not 5.
	if _, e := db.Exec(context.Background(), `INSERT INTO recipe_step_stats(recipe_id,step_key,sessions,median_seconds,p75_seconds,entered,gave_up,timer_starts) VALUES('beans',$1,5,900,960,5,0,0)`, cookStepKey("Boil for 5 minutes.")); e != nil {
		t.Fatal(e)
	}
	var plan timelineReply
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/meals/timeline", token, body("roast", "beans", "salad")), &plan); e != nil {
		t.Fatal(e)
	}
	// In the cook's time zone, everything over by the meal, every step there once, by dish.
	if !plan.EatAt.Equal(eat) || plan.EatAt.Format("-07:00") != eat.Format("-07:00") || len(plan.Steps) != 9 || len(plan.Dishes) != 3 || plan.Kitchen != (mealKitchen{4, 1}) {
		t.Fatalf("plan: %+v", plan)
	}
	seen := map[string]bool{}
	for _, s := range plan.Steps {
		key := s.RecipeID + ":" + fmt.Sprint(s.Step)
		if seen[key] || s.EndAt.After(plan.EatAt) || s.StartAt.Before(plan.StartAt) {
			t.Fatalf("step %+v", s)
		}
		seen[key] = true
	}
	first, last := plan.Steps[0], plan.Steps[len(plan.Steps)-1]
	if first.RecipeID != "roast" || first.Step != 1 || !first.Preheat || first.Oven != 220 || !last.EndAt.Equal(eat) || last.RecipeID != "roast" || last.Title != "Carve" {
		t.Fatalf("first %+v last %+v", first, last)
	}
	byStep := map[string]timelineStep{}
	for _, s := range plan.Steps {
		byStep[s.RecipeID+":"+fmt.Sprint(s.Step)] = s
	}
	// The cook-tested boil, the estimated roast and the cook's own carving, each marked.
	boil, roast, carve := byStep["beans:2"], byStep["roast:3"], byStep["roast:5"]
	if !boil.Tested || boil.Estimated || boil.EndAt.Sub(boil.StartAt) != 15*time.Minute || boil.Burners != 1 {
		t.Fatalf("boil %+v", boil)
	}
	if !roast.Estimated || roast.Tested || roast.Oven != 220 || roast.Wait != 74*60 || carve.Estimated {
		t.Fatalf("roast %+v carve %+v", roast, carve)
	}
	if !plan.Dishes[0].ReadyAt.Equal(eat) || !plan.Dishes[1].Tested || !plan.Dishes[0].Estimated || plan.Dishes[2].Estimated || len(plan.Free) == 0 || len(plan.Warnings) != 0 {
		t.Fatalf("dishes %+v free %v warnings %v", plan.Dishes, plan.Free, plan.Warnings)
	}
	// A kitchen with one burner and a roast at another heat: warnings, never a step left out.
	publishRecipe(t, db, "author", "cake", func(r *RecipeInput) {
		r.Steps = []Step{{Title: "Bake", Text: "Bake at 160 °C for 50 minutes."}, {Title: "Serve", Text: "Serve warm.", Timing: &StepTiming{Active: 60}}}
	})
	warned := body("roast", "cake", "beans")
	warned["kitchen"] = map[string]int{"burners": 1, "ovens": 1}
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/meals/timeline", token, warned), &plan); e != nil {
		t.Fatal(e)
	}
	if len(plan.Steps) != 10 || len(plan.Warnings) == 0 || plan.Warnings[0].Kind != "oven" || len(plan.Warnings[0].RecipeIDs) != 2 || plan.Warnings[0].Heats[0] != 220 {
		t.Fatalf("warnings %+v", plan.Warnings)
	}
}

func TestCookingAMealRecordsASessionForEachDish(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "author")
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	token := bearerFor(t, db, "cook")
	mealRecipesFor(t, db, "author", "cook")
	mustCall(t, f, 400, "POST", "/v1/meals/cook-sessions", token, map[string]any{"recipes": []string{"roast"}})
	mustCall(t, f, 404, "POST", "/v1/meals/cook-sessions", token, map[string]any{"recipes": []string{"roast", "secret"}})
	var meal struct {
		MealID   string `json:"mealId"`
		Sessions []struct {
			ID       string `json:"id"`
			RecipeID string `json:"recipeId"`
			MealID   string `json:"mealId"`
			Steps    int    `json:"steps"`
		} `json:"sessions"`
	}
	if e := json.Unmarshal(mustCall(t, f, 201, "POST", "/v1/meals/cook-sessions", token, map[string]any{"recipes": []string{"roast", "beans", "salad"}}), &meal); e != nil {
		t.Fatal(e)
	}
	// One session a dish, linked by the meal; the cook's own salad never counts, so it has none.
	if meal.MealID == "" || len(meal.Sessions) != 2 || meal.Sessions[0].RecipeID != "roast" || meal.Sessions[1].RecipeID != "beans" || meal.Sessions[0].MealID != meal.MealID || meal.Sessions[0].Steps != 5 {
		t.Fatalf("meal %+v", meal)
	}
	// Each dish finishes as cooking one recipe does, and each is a verified cook.
	for _, s := range meal.Sessions {
		startedAgo(t, db, s.ID, 60)
		var done struct{ Verified bool }
		if e := json.Unmarshal(mustCall(t, f, 200, "PATCH", "/v1/cook-sessions/"+s.ID, token, map[string]any{"step": s.Steps, "finished": true}), &done); e != nil || !done.Verified {
			t.Fatalf("%s: verified %v %v", s.RecipeID, done.Verified, e)
		}
	}
	var linked int
	if e := db.QueryRow(context.Background(), `SELECT count(*) FROM cook_sessions WHERE meal_id=$1 AND verified`, meal.MealID).Scan(&linked); e != nil || linked != 2 {
		t.Fatalf("linked %d %v", linked, e)
	}
}

func TestEatingTimeIsReadInTheCooksZone(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	// A local time is the cook's clock, in their zone; an RFC 3339 one keeps its own offset.
	eat, e := eatingTime("2026-10-17T19:30", "Europe/Berlin", now)
	if e != nil || eat.Format(time.RFC3339) != "2026-10-17T19:30:00+02:00" {
		t.Fatalf("%v %v", eat, e)
	}
	eat, e = eatingTime("2026-10-18T01:30:00Z", "America/New_York", now)
	if e != nil || eat.Format(time.RFC3339) != "2026-10-17T21:30:00-04:00" {
		t.Fatalf("%v %v", eat, e)
	}
	if eat, e = eatingTime("2026-10-17T19:30", "", now); e != nil || eat.Location() != time.UTC {
		t.Fatalf("no zone: %v %v", eat, e)
	}
	for _, bad := range [][2]string{{"2026-10-17T19:30", "Local"}, {"2026-10-17T19:30", "Nowhere/City"}, {"tonight", "UTC"}, {"2026-10-16T20:00", "UTC"}, {"2027-01-01T19:00", "UTC"}} {
		if _, e := eatingTime(bad[0], bad[1], now); e == nil {
			t.Fatalf("%v was accepted", bad)
		}
	}
}
