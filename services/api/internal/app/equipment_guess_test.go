package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"savorly/api/internal/ai"
)

func TestEquipmentGuessAddsWhatTheMethodNames(t *testing.T) {
	steps := []Step{
		{Title: "Pesto", Text: "Blend the basil with oil."},
		{Title: "Pasta", Text: "Cook the linguine in salted boiling water, then drain in a colander."},
		{Title: "Toss", Text: "Toss in the pot with the pesto."},
	}
	got := mergeEquipmentGuess(steps, "en", []ai.EquipmentGuess{{Key: "pot", Steps: []int{2}}, {Key: "blender", Steps: []int{1}}})
	want := []equipmentUse{{Key: "blender", Steps: []int{1}}, {Key: "pot", Steps: []int{2, 3}}, {Key: "colander", Steps: []int{2}}}
	if len(got) != len(want) {
		t.Fatalf("merged %+v", got)
	}
	for i := range want {
		if got[i].Key != want[i].Key || !slices.Equal(got[i].Steps, want[i].Steps) {
			t.Fatalf("merged %+v, want %+v", got, want)
		}
	}
	if line := equipmentGuessLine(got); line != "blender (step 1); pot (steps 2, 3); colander (step 2)" {
		t.Fatalf("line %q", line)
	}
}

// equipmentModel stands in for OpenRouter's guesses: every recipe uses a pot at its last step and
// a blender at its first, and a spork, which isn't equipment the request offers.
type equipmentModel struct {
	calls  atomic.Int32
	keys   atomic.Value
	server *httptest.Server
}

func newEquipmentModel(t *testing.T) *equipmentModel {
	t.Helper()
	m := &equipmentModel{}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.calls.Add(1)
		var body struct{ Messages []struct{ Content string } }
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil || len(body.Messages) != 2 {
			t.Errorf("guess request: %v", e)
			return
		}
		var input struct {
			Steps     []ai.EquipmentStep
			Equipment []string
		}
		if e := json.Unmarshal([]byte(body.Messages[1].Content), &input); e != nil {
			t.Error(e)
		}
		m.keys.Store(input.Equipment)
		out := []ai.EquipmentGuess{{Key: "pot", Steps: []int{len(input.Steps)}}, {Key: "blender", Steps: []int{1}}, {Key: "spork", Steps: []int{1}}}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(jsonBytes(map[string]any{"equipment": out}))}}}, "usage": map[string]float64{"cost": 0.0004}})
	}))
	t.Cleanup(m.server.Close)
	return m
}

// guessOf is recipe id's equipmentGuess as readers get it.
func guessOf(t *testing.T, a *App, id string) []equipmentUse {
	t.Helper()
	var b []byte
	if e := a.DB.QueryRow(context.Background(), `SELECT `+recipeJSON+recipeFrom+`WHERE r.id=$1`, id).Scan(&b); e != nil {
		t.Fatal(e)
	}
	var r struct{ EquipmentGuess []equipmentUse }
	if e := json.Unmarshal(b, &r); e != nil || r.EquipmentGuess == nil {
		t.Fatalf("%v: %s", e, b)
	}
	return r.EquipmentGuess
}

func TestTheModelGuessesEquipmentOnceWithinTheDaysCap(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	testUser(t, db, "fan")
	model := newEquipmentModel(t)
	a := &App{DB: db, AI: ai.New(), Context: context.Background()}
	a.AI.OpenRouterURL, a.AI.OpenRouterKey = model.server.URL, "test-only-never-sent"
	ctx := context.Background()
	pesto := func(r *RecipeInput) {
		r.Steps = []Step{{Title: "Pesto", Text: "Blend the basil with oil."}, {Title: "Pasta", Text: "Cook the linguine in salted boiling water, then drain in a colander."}}
	}
	publishRecipe(t, db, "cook", "loved", pesto)
	publishRecipe(t, db, "cook", "quiet", pesto)
	publishRecipe(t, db, "cook", "listed", func(r *RecipeInput) { pesto(r); r.Equipment = []string{"Large pot"} })
	publishRecipe(t, db, "cook", "draft", func(r *RecipeInput) { pesto(r); r.Published = false })
	if _, e := db.Exec(ctx, `INSERT INTO saves(user_id,recipe_id) VALUES('fan','loved')`); e != nil {
		t.Fatal(e)
	}
	// Nothing is shown before the model is asked.
	if guess := guessOf(t, a, "loved"); len(guess) != 0 {
		t.Fatalf("a guess before asking: %+v", guess)
	}
	// One a day: the most saved published recipe without a list goes first.
	t.Setenv("EQUIPMENT_GUESS_RECIPES", "1")
	if n, e := a.guessEquipment(ctx); e != nil || n != 1 || model.calls.Load() != 1 {
		t.Fatalf("first pass: %d %v, %d calls", n, e, model.calls.Load())
	}
	if keys, _ := model.keys.Load().([]string); !slices.Equal(keys, equipmentKeys) {
		t.Fatalf("offered %q", keys)
	}
	// The model's guess, with the colander the method names, in the order the method uses them.
	guess := guessOf(t, a, "loved")
	if equipmentGuessLine(guess) != "blender (step 1); pot (step 2); colander (step 2)" {
		t.Fatalf("guess %+v", guess)
	}
	// Paid from the shared budget, nobody's own.
	var kind string
	var member *string
	if e := db.QueryRow(ctx, `SELECT kind,user_id FROM ai_usage`).Scan(&kind, &member); e != nil || kind != "equipment_guess" || member != nil {
		t.Fatalf("usage %q %v %v", kind, member, e)
	}
	if n, _ := a.guessEquipment(ctx); n != 0 || model.calls.Load() != 1 {
		t.Fatalf("past the cap: %d, %d calls", n, model.calls.Load())
	}
	// With room, the next recipe; never one asked about already, one with a list, or a draft.
	t.Setenv("EQUIPMENT_GUESS_RECIPES", "10")
	if n, e := a.guessEquipment(ctx); e != nil || n != 1 || model.calls.Load() != 2 {
		t.Fatalf("second pass: %d %v, %d calls", n, e, model.calls.Load())
	}
	if n, _ := a.guessEquipment(ctx); n != 0 || model.calls.Load() != 2 {
		t.Fatalf("asked twice: %d, %d calls", n, model.calls.Load())
	}
	if len(guessOf(t, a, "listed")) != 0 || len(guessOf(t, a, "draft")) != 0 {
		t.Fatal("a recipe with a list, or a draft, was guessed about")
	}
	// Editing the method hides the guess about the old steps until the model is asked again.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=steps||'[{"title":"Serve","text":"Toss and serve."}]' WHERE id='loved'`); e != nil {
		t.Fatal(e)
	}
	if guess := guessOf(t, a, "loved"); len(guess) != 0 {
		t.Fatalf("a guess about other steps: %+v", guess)
	}
	if n, _ := a.guessEquipment(ctx); n != 1 || model.calls.Load() != 3 {
		t.Fatalf("the edit wasn't asked about: %d, %d calls", n, model.calls.Load())
	}
	if line := equipmentGuessLine(guessOf(t, a, "loved")); line != "blender (step 1); colander (step 2); pot (step 3)" {
		t.Fatalf("after the edit: %s", line)
	}
	// A list of the cook's own replaces the guess.
	if _, e := db.Exec(ctx, `UPDATE recipes SET equipment='{Mortar}' WHERE id='loved'`); e != nil {
		t.Fatal(e)
	}
	if guess := guessOf(t, a, "loved"); len(guess) != 0 {
		t.Fatalf("a guess beside the cook's list: %+v", guess)
	}
	// Cooking questions and the live sous-chef read the guess with its steps.
	r := &sceneRecipe{guess: []equipmentUse{{Key: "pot", Steps: []int{2}}}}
	if line := r.equipmentLine(); !strings.Contains(line, "likely uses, guessed from it") || !strings.Contains(line, "pot (step 2)") {
		t.Fatalf("scene line %q", line)
	}
}
