package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"savorly/api/internal/ai"
)

func TestTimingLexiconLoadsCleanly(t *testing.T) {
	if len(timingLexiconProblems) > 0 {
		t.Fatalf("timing lexicon: %v", timingLexiconProblems)
	}
}

func TestStepTimingIsReadInNineLanguages(t *testing.T) {
	baking := func(minutes, heat int) StepTiming {
		return StepTiming{Active: 60, Wait: minutes*60 - 60, Oven: heat, Estimated: true}
	}
	waiting := func(minutes int) StepTiming { return StepTiming{Active: 60, Wait: minutes*60 - 60, Estimated: true} }
	simmering := func(minutes int) StepTiming {
		return StepTiming{Active: 60, Wait: minutes*60 - 60, Burners: 1, Estimated: true}
	}
	frying := func(minutes int) StepTiming { return StepTiming{Active: minutes * 60, Burners: 1, Estimated: true} }
	preheat := func(heat int) StepTiming { return StepTiming{Oven: heat, Estimated: true} }
	cases := []struct {
		language, text string
		want           StepTiming
	}{
		{"en", "Bake at 200 °C for 25 minutes.", baking(25, 200)},
		{"en", "Bake at 350 degrees for 1 1/2 hours.", baking(90, 175)},
		{"en", "Roast for an hour and a half, until the thickest part reaches 74 °C.", baking(90, 220)},
		{"en", "Preheat the oven to 400°F.", preheat(205)},
		{"en", "Let it rest 10 minutes before slicing.", waiting(10)},
		{"en", "Remove from the oven and let cool for 10 minutes.", waiting(10)},
		{"en", "Simmer for 20-25 minutes, stirring occasionally.", simmering(25)},
		{"en", "Cook, stirring constantly, for 10 minutes over medium heat.", frying(10)},
		{"en", "Sear the steaks 3 minutes per side in a hot skillet.", frying(6)},
		{"en", "Boil the potatoes for fifteen minutes.", simmering(15)},
		{"en", "Marinate overnight in the fridge.", waiting(8 * 60)},
		{"en", "Bake in a gas mark 6 oven for half an hour.", baking(30, 200)},
		{"fr", "Enfourner 25 min à 200 °C.", baking(25, 200)},
		{"fr", "Préchauffez le four à 180 °C (th. 6).", preheat(180)},
		{"fr", "Laissez reposer 1h30 au frais.", waiting(90)},
		{"fr", "Faites revenir les oignons 5 minutes à feu moyen.", frying(5)},
		{"de", "Den Backofen auf 200 Grad vorheizen.", preheat(200)},
		{"de", "Die Kartoffeln 20 Minuten kochen.", simmering(20)},
		{"de", "Eine halbe Stunde ruhen lassen.", waiting(30)},
		{"es", "Hornear a 180 °C durante 30-35 minutos.", baking(35, 180)},
		{"es", "Dejar reposar media hora.", waiting(30)},
		{"it", "Cuocere in forno a 180 gradi per un'ora.", baking(60, 180)},
		{"it", "Lasciate lievitare per due ore.", waiting(120)},
		{"pt", "Asse em forno preaquecido a 200 °C por 40 minutos.", baking(40, 200)},
		{"pt", "Deixe descansar por uma hora e meia.", waiting(90)},
		{"ru", "Запекайте в духовке при 180 градусах 40 минут.", baking(40, 180)},
		{"ru", "Разогрейте духовку до 200 градусов.", preheat(200)},
		{"ru", "Варите полчаса на медленном огне.", simmering(30)},
		{"ru", "Обжарьте лук 5 минут.", frying(5)},
		{"zh", "放入烤箱，200度烤二十五分钟。", baking(25, 200)},
		{"zh", "小火炖一个半小时。", simmering(90)},
		{"zh", "烤箱预热至180℃。", preheat(180)},
		{"ja", "オーブンを200度に予熱する。", preheat(200)},
		{"ja", "200℃のオーブンで25分焼く。", baking(25, 200)},
		{"ja", "弱火で1時間半煮込む。", simmering(90)},
		{"ja", "冷蔵庫で30分休ませる。", waiting(30)},
	}
	for _, c := range cases {
		// The roast's heat is the recipe's: the step itself names only the meat's.
		steps := []Step{{Title: "Heat", Text: "Preheat the oven to 220 °C."}, {Title: "Cook", Text: c.text}}
		got := readTimings(steps, c.language, 60)[1]
		if got.StepTiming != c.want || got.Source != fromText {
			t.Errorf("%s %q: %+v, want %+v", c.language, c.text, got, c.want)
		}
	}
	// "Baking powder" and "an oven-safe dish" bake nothing; a step that gives no time gets its
	// share of the recipe's, as a guess.
	steps := []Step{{Title: "Mix", Text: "Mix the flour, baking powder and salt."}, {Title: "Pour", Text: "Pour into an oven-safe dish."}, {Title: "Bake", Text: "Bake for 30 minutes.", Seconds: 1800}}
	got := readTimings(steps, "en", 50)
	if got[0] != (timingEstimate{StepTiming{Active: 600, Estimated: true}, fromGuess}) || got[1].Oven != 0 || got[2].StepTiming != baking(30, defaultOvenHeat) {
		t.Fatalf("readings: %+v", got)
	}
	// Guesses stay within reason whatever the recipe says.
	if got := readTimings(steps[:1], "en", 1)[0]; got.Active != minGuessSeconds {
		t.Fatalf("short recipe: %+v", got)
	}
	if got := readTimings(steps[:1], "en", 600)[0]; got.Active != maxGuessSeconds {
		t.Fatalf("long recipe: %+v", got)
	}
}

func TestStepTimingIsKeptLikeStepPhotos(t *testing.T) {
	saved := []Step{
		{Title: "Bake", Text: "Bake for 25 minutes.", Timing: &StepTiming{Active: 120, Wait: 1380, Oven: 200}},
		{Title: "Rest", Text: "Rest for 10 minutes.", Timing: &StepTiming{Wait: 600}},
		{Title: "Serve", Text: "Serve warm.", Timing: &StepTiming{Active: 60}},
	}
	var steps []Step
	// An older app sends the steps back without timing; one step's text changed, one was cleared.
	if e := json.Unmarshal([]byte(`[{"title":"Bake","text":"Bake for 25 minutes."},{"title":"Rest","text":"Rest for 15 minutes."},{"title":"Serve","text":"Serve warm.","timing":null}]`), &steps); e != nil {
		t.Fatal(e)
	}
	keepStepTiming(steps, saved)
	if steps[0].Timing == nil || *steps[0].Timing != *saved[0].Timing || steps[1].Timing != nil || steps[2].Timing != nil {
		t.Fatalf("kept %+v %+v %+v", steps[0].Timing, steps[1].Timing, steps[2].Timing)
	}
	// What the app sends, it keeps.
	if e := json.Unmarshal([]byte(`[{"title":"Bake","text":"Bake for 25 minutes.","timing":{"active":60,"wait":1440,"oven":190}}]`), &steps); e != nil {
		t.Fatal(e)
	}
	keepStepTiming(steps, saved)
	if *steps[0].Timing != (StepTiming{Active: 60, Wait: 1440, Oven: 190}) {
		t.Fatalf("sent %+v", steps[0].Timing)
	}
	// Timing out of bounds is refused.
	for _, bad := range []StepTiming{{Active: -1}, {Wait: 90000}, {Oven: 20}, {Oven: 400}, {Burners: 7}} {
		r := validRecipe()
		r.Steps[0].Timing = &bad
		if e := r.Validate(); e == nil {
			t.Fatalf("%+v was accepted", bad)
		}
	}
	r := validRecipe()
	r.Steps[0].Timing = &StepTiming{Active: 300, Wait: 0, Oven: 0, Burners: 2}
	if e := r.Validate(); e != nil {
		t.Fatal(e)
	}
}

func TestImportsAndModelsFillTimingAsEstimates(t *testing.T) {
	// An import gets what its steps' words say, and leaves the rest to the server.
	r := validRecipe()
	r.Minutes = 40
	r.Steps = []Step{{Title: "Chop", Text: "Chop the onions."}, {Title: "Bake", Text: "Bake at 190 °C for 30 minutes."}}
	importTiming(&r)
	if r.Steps[0].Timing != nil || r.Steps[1].Timing == nil || *r.Steps[1].Timing != (StepTiming{Active: 60, Wait: 1740, Oven: 190, Estimated: true}) {
		t.Fatalf("imported %+v %+v", r.Steps[0].Timing, r.Steps[1].Timing)
	}
	// A model's timing is held to what a step may have and marked as its estimate, unless it's
	// what the cook already gave the same step.
	saved := []Step{{Text: "Simmer 20 minutes.", Timing: &StepTiming{Active: 60, Wait: 1140, Burners: 1}}}
	steps := []Step{
		{Text: "Simmer 20 minutes.", Timing: &StepTiming{Active: 60, Wait: 1140, Burners: 1}},
		{Text: "Bake 20 minutes.", Timing: &StepTiming{Active: -5, Wait: 99999, Oven: 900, Burners: 9}},
	}
	fitTiming(steps, saved)
	if steps[0].Timing.Estimated || *steps[1].Timing != (StepTiming{Active: 0, Wait: maxStepSeconds, Oven: 0, Burners: maxStepBurners, Estimated: true}) {
		t.Fatalf("model %+v %+v", steps[0].Timing, steps[1].Timing)
	}
}

// stepTimingOf is a recipe's step_timing as the server keeps it.
func stepTimingOf(t *testing.T, a *App, id string) (map[string]timingEstimate, bool) {
	t.Helper()
	saved := map[string]timingEstimate{}
	var guessed bool
	if e := a.DB.QueryRow(context.Background(), `SELECT step_timing,timing_guessed FROM recipes WHERE id=$1`, id).Scan(&saved, &guessed); e != nil {
		t.Fatal(e)
	}
	return saved, guessed
}

func TestStepTimingIsEstimatedWhenRecipesAreSaved(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	a := &App{DB: db, AI: ai.New()}
	ctx := context.Background()
	publishRecipe(t, db, "cook", "stew", func(r *RecipeInput) {
		r.Minutes = 60
		r.Steps = []Step{
			{Title: "Chop", Text: "Chop the vegetables."},
			{Title: "Simmer", Text: "Simmer for 40 minutes."},
			{Title: "Season", Text: "Season to taste.", Timing: &StepTiming{Active: 120}},
		}
	})
	saved, guessed := stepTimingOf(t, a, "stew")
	chop, simmer := saved[cookStepKey("Chop the vegetables.")], saved[cookStepKey("Simmer for 40 minutes.")]
	// Read in the same save: the simmer from its words, the chopping as what's left of the hour,
	// and nothing for the step its cook timed.
	if len(saved) != 2 || !guessed || simmer.Source != fromText || simmer.Wait != 2340 || chop.Source != fromGuess || chop.Active != 1080 {
		t.Fatalf("estimates %+v", saved)
	}
	// The timeline takes the cook's timing, then the estimate, each marked as what it is.
	var steps []Step
	var language string
	var minutes int
	if e := db.QueryRow(ctx, `SELECT steps,language,minutes FROM recipes WHERE id='stew'`).Scan(&steps, &language, &minutes); e != nil {
		t.Fatal(e)
	}
	timings := stepTimings(steps, language, minutes, saved)
	if !timings[0].Estimated || !timings[1].Estimated || timings[2] != (StepTiming{Active: 120}) {
		t.Fatalf("timings %+v", timings)
	}
	// A write that changes the steps without reading them (the seed, an older server) is caught
	// up by the pass, as is a recipe read under another version of the lexicon.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{0,text}','"Bake for 30 minutes."') WHERE id='stew'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET timing_version=0 WHERE id<>'stew'`); e != nil {
		t.Fatal(e)
	}
	if n, e := indexTiming(ctx, db); e != nil || n != 1 {
		t.Fatalf("pass: %d %v", n, e)
	}
	saved, guessed = stepTimingOf(t, a, "stew")
	if bake := saved[cookStepKey("Bake for 30 minutes.")]; guessed || bake.Oven != defaultOvenHeat || bake.Wait != 1740 {
		t.Fatalf("after the pass %+v %v", saved, guessed)
	}
	if n, e := indexTiming(ctx, db); e != nil || n != 0 {
		t.Fatalf("a second pass: %d %v", n, e)
	}
}

func TestRecipeWritesKeepTheirStepTiming(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	token := bearerFor(t, db, "cook")
	in := validRecipe()
	in.Steps = []Step{{Title: "Bake", Text: "Bake until golden.", Timing: &StepTiming{Active: 60, Wait: 1500, Oven: 200}}, {Title: "Serve", Text: "Serve it warm."}}
	var created struct {
		ID    string `json:"id"`
		Steps []Step `json:"steps"`
	}
	if e := json.Unmarshal(mustCall(t, f, 201, "POST", "/v1/recipes", token, in), &created); e != nil {
		t.Fatal(e)
	}
	if created.Steps[0].Timing == nil || *created.Steps[0].Timing != (StepTiming{Active: 60, Wait: 1500, Oven: 200}) || created.Steps[1].Timing != nil {
		t.Fatalf("created %+v", created.Steps)
	}
	// An older app's edit, without timing, keeps it; refused timing says so.
	older := map[string]any{}
	_ = json.Unmarshal(jsonBytes(validRecipe()), &older)
	older["steps"] = []map[string]any{{"title": "Bake", "text": "Bake until golden.", "seconds": 0}, {"title": "Serve", "text": "Serve it warm.", "seconds": 0}}
	var updated struct{ Steps []Step }
	if e := json.Unmarshal(mustCall(t, f, 200, "PUT", "/v1/recipes/"+created.ID, token, older), &updated); e != nil {
		t.Fatal(e)
	}
	if updated.Steps[0].Timing == nil || updated.Steps[0].Timing.Wait != 1500 {
		t.Fatalf("an older app's edit dropped the timing: %+v", updated.Steps)
	}
	older["steps"] = []map[string]any{{"title": "Bake", "text": "Bake until golden.", "seconds": 0, "timing": map[string]any{"oven": 900}}}
	mustCall(t, f, 400, "PUT", "/v1/recipes/"+created.ID, token, older)
}

// timingModel stands in for OpenRouter's estimates: every asked step takes 7 minutes of hands
// and 3 of waiting.
type timingModel struct {
	calls  atomic.Int32
	server *httptest.Server
}

func newTimingModel(t *testing.T) *timingModel {
	t.Helper()
	m := &timingModel{}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.calls.Add(1)
		var body struct{ Messages []struct{ Content string } }
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil || len(body.Messages) != 2 {
			t.Errorf("estimate request: %v", e)
			return
		}
		var input struct{ Steps []ai.TimingStep }
		if e := json.Unmarshal([]byte(body.Messages[1].Content), &input); e != nil {
			t.Error(e)
		}
		out := []ai.TimingEstimate{{Step: 99, Active: 1}}
		for _, s := range input.Steps {
			if s.Estimate {
				out = append(out, ai.TimingEstimate{Step: s.Step, Active: 7, Wait: 3})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(jsonBytes(map[string]any{"steps": out}))}}}, "usage": map[string]float64{"cost": 0.0004}})
	}))
	t.Cleanup(m.server.Close)
	return m
}

func TestTheModelEstimatesGuessesOnceWithinTheDaysCap(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	testUser(t, db, "fan")
	model := newTimingModel(t)
	a := &App{DB: db, AI: ai.New(), Context: context.Background()}
	a.AI.OpenRouterURL, a.AI.OpenRouterKey = model.server.URL, "test-only-never-sent"
	ctx := context.Background()
	vague := func(r *RecipeInput) {
		r.Steps = []Step{{Title: "Fry", Text: "Fry the onions until golden."}, {Title: "Simmer", Text: "Simmer for 20 minutes."}}
	}
	publishRecipe(t, db, "cook", "loved", vague)
	publishRecipe(t, db, "cook", "quiet", vague)
	publishRecipe(t, db, "cook", "clear", func(r *RecipeInput) { r.Steps = []Step{{Title: "Simmer", Text: "Simmer for 20 minutes."}} })
	publishRecipe(t, db, "cook", "draft", func(r *RecipeInput) { vague(r); r.Published = false })
	if _, e := db.Exec(ctx, `INSERT INTO saves(user_id,recipe_id) VALUES('fan','loved')`); e != nil {
		t.Fatal(e)
	}
	// One a day: the most saved published recipe with a guess goes first.
	t.Setenv("STEP_TIMING_RECIPES", "1")
	if n, e := a.estimateTimings(ctx); e != nil || n != 1 || model.calls.Load() != 1 {
		t.Fatalf("first pass: %d %v, %d calls", n, e, model.calls.Load())
	}
	saved, guessed := stepTimingOf(t, a, "loved")
	fry := saved[cookStepKey("Fry the onions until golden.")]
	if guessed || fry.Source != fromModel || fry.Active != 420 || fry.Wait != 180 || !fry.Estimated || saved[cookStepKey("Simmer for 20 minutes.")].Source != fromText {
		t.Fatalf("estimates %+v", saved)
	}
	// Paid from the shared budget, nobody's own.
	var kind string
	var member *string
	if e := db.QueryRow(ctx, `SELECT kind,user_id FROM ai_usage`).Scan(&kind, &member); e != nil || kind != "step_timing" || member != nil {
		t.Fatalf("usage %q %v %v", kind, member, e)
	}
	if n, _ := a.estimateTimings(ctx); n != 0 || model.calls.Load() != 1 {
		t.Fatalf("past the cap: %d, %d calls", n, model.calls.Load())
	}
	// With room, the next recipe; never one asked about already, one without guesses or a draft.
	t.Setenv("STEP_TIMING_RECIPES", "10")
	if n, e := a.estimateTimings(ctx); e != nil || n != 1 || model.calls.Load() != 2 {
		t.Fatalf("second pass: %d %v, %d calls", n, e, model.calls.Load())
	}
	if _, guessed := stepTimingOf(t, a, "draft"); !guessed {
		t.Fatal("a draft was estimated")
	}
	if n, _ := a.estimateTimings(ctx); n != 0 || model.calls.Load() != 2 {
		t.Fatalf("asked twice: %d, %d calls", n, model.calls.Load())
	}
	// Editing a step asks about the new one only, and the model's answer for the other stands.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{1,text}','"Stir in the cream until it thickens."') WHERE id='loved'`); e != nil {
		t.Fatal(e)
	}
	if _, e := indexTiming(ctx, db); e != nil {
		t.Fatal(e)
	}
	if saved, _ := stepTimingOf(t, a, "loved"); saved[cookStepKey("Fry the onions until golden.")].Source != fromModel || saved[cookStepKey("Stir in the cream until it thickens.")].Source != fromGuess {
		t.Fatalf("after the edit %+v", saved)
	}
	if n, _ := a.estimateTimings(ctx); n != 1 || model.calls.Load() != 3 {
		t.Fatalf("the edit wasn't asked about: %d, %d calls", n, model.calls.Load())
	}
}
