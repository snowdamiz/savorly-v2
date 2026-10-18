package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func myEdits(t *testing.T, f *fiber.App, recipe, tok string) []recipeEdit {
	t.Helper()
	status, b := send(t, f, "GET", "/v1/recipes/"+recipe+"/my-version", tok, nil)
	var out struct{ Edits []recipeEdit }
	if status != 200 || json.Unmarshal(b, &out) != nil {
		t.Fatalf("my version %d %s", status, b)
	}
	return out.Edits
}

func TestYourVersionKeepsChangesOverTheRecipe(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	authorID, author := signedIn(t, db, "author@example.test", true)
	_, cook := signedIn(t, db, "cook@example.test", true)
	_, other := signedIn(t, db, "other@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	path := "/v1/recipes/" + recipe + "/my-version"

	expect(t, f, 401, "GET", path, "", nil)
	expect(t, f, 404, "GET", path, author, nil)
	if edits := myEdits(t, f, recipe, cook); len(edits) != 0 {
		t.Fatalf("edits before any %+v", edits)
	}
	// No cooking mode needed: it's the member's own version.
	longer := map[string]any{"kind": "time", "step": 2, "change": map[string]any{"text": "Simmer the sauce for 12 minutes.", "seconds": 720}, "said": "My oven needs 4 more minutes.", "source": "cooking"}
	out := expect(t, f, 200, "PUT", path, cook, longer)
	if edit, _ := out["edit"].(map[string]any); edit["fits"] != true || edit["place"] != 2.0 || edit["said"] != "My oven needs 4 more minutes." || out["replaced"] != nil {
		t.Fatalf("kept %v", out)
	}
	expect(t, f, 200, "PUT", path, cook, map[string]any{"kind": "amount", "ingredient": 1, "change": map[string]any{"amount": 0.5}, "said": "half the tomatoes"})
	// Another change to the same step replaces the first, and says what it replaced.
	out = expect(t, f, 200, "PUT", path, cook, map[string]any{"kind": "heat", "step": 2, "change": map[string]any{"text": "Simmer the sauce gently for 12 minutes."}})
	if replaced, _ := out["replaced"].(map[string]any); replaced["kind"] != "time" {
		t.Fatalf("replaced %v", out)
	}
	// A personal version keeps the recipe's steps one for one.
	expect(t, f, 400, "PUT", path, cook, map[string]any{"kind": "missing_step", "step": 1, "change": map[string]any{"text": "Soften the onion first."}})
	expect(t, f, 400, "PUT", path, cook, map[string]any{"kind": "time", "step": 2, "change": map[string]any{"seconds": 480}})

	edits := myEdits(t, f, recipe, cook)
	if len(edits) != 2 || edits[0].Part != "step" || edits[0].After.Text != "Simmer the sauce gently for 12 minutes." || edits[1].Part != "ingredient" || *edits[1].After.Amount != 0.5 {
		t.Fatalf("edits %+v", edits)
	}
	// Nobody else sees them, and the recipe itself is as its author wrote it.
	if theirs := myEdits(t, f, recipe, other); len(theirs) != 0 {
		t.Fatalf("another member sees them %+v", theirs)
	}
	if steps := recipeSteps(t, db, recipe); steps[1].Text != "Simmer the sauce for 8 minutes." {
		t.Fatalf("the recipe changed %+v", steps)
	}

	// The author changes the step: the member's change no longer fits until they keep it there.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{1,text}','"Simmer the sauce for 10 minutes, stirring."') WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	edits = myEdits(t, f, recipe, cook)
	if edits[0].Fits || !edits[1].Fits {
		t.Fatalf("after the author's change %+v", edits)
	}
	expect(t, f, 404, "PATCH", "/v1/recipe-edits/"+edits[0].ID, other, map[string]any{"keep": true})
	kept := expect(t, f, 200, "PATCH", "/v1/recipe-edits/"+edits[0].ID, cook, map[string]any{"keep": true})
	if before, _ := kept["before"].(map[string]any); kept["fits"] != true || before["text"] != "Simmer the sauce for 10 minutes, stirring." {
		t.Fatalf("kept here %v", kept)
	}
	expect(t, f, 404, "DELETE", "/v1/recipe-edits/"+edits[1].ID, other, nil)
	expect(t, f, 204, "DELETE", "/v1/recipe-edits/"+edits[1].ID, cook, nil)
	if edits = myEdits(t, f, recipe, cook); len(edits) != 1 {
		t.Fatalf("after dropping one %+v", edits)
	}
}

func TestKitchenNotesAreKeptOnce(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	_, cook := signedIn(t, db, "cook@example.test", true)
	expect(t, f, 400, "POST", "/v1/me/kitchen-notes", cook, map[string]any{"note": "x"})
	first := expect(t, f, 201, "POST", "/v1/me/kitchen-notes", cook, map[string]any{"note": " My oven  runs hot "})
	again := expect(t, f, 201, "POST", "/v1/me/kitchen-notes", cook, map[string]any{"note": "my oven runs hot"})
	if first["note"] != "My oven runs hot" || again["id"] != first["id"] {
		t.Fatalf("notes %v %v", first, again)
	}
	expect(t, f, 201, "POST", "/v1/me/kitchen-notes", cook, map[string]any{"note": "We like it mild"})
	list := expect(t, f, 200, "GET", "/v1/me/kitchen-notes", cook, nil)
	if notes, _ := list["notes"].([]any); len(notes) != 2 {
		t.Fatalf("notes %v", list)
	}
	expect(t, f, 204, "DELETE", "/v1/me/kitchen-notes/"+first["id"].(string), cook, nil)
	expect(t, f, 404, "DELETE", "/v1/me/kitchen-notes/"+first["id"].(string), cook, nil)
}

func TestHandsFreeAnswersKnowYourVersionAndKitchen(t *testing.T) {
	t.Setenv("PAID_PLANS", "")
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := cookKitchen(t)
	chef := &fakeChef{cost: 0.0003}
	f := cookServer(db, chef.server(t).URL)
	ctx := context.Background()
	if _, e := db.Exec(ctx, `INSERT INTO recipe_edits(id,user_id,recipe_id,kind,part,target,place,before,after,said) VALUES('e1','guest','pasta','time','step',$1,1,'{"text":"Boil the spaghetti in salted water.","seconds":540}','{"text":"Boil the spaghetti in salted water for 11 minutes.","seconds":660}','I like it softer')`,
		cookStepKey("Boil the spaghetti in salted water.")); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO kitchen_notes(id,user_id,note) VALUES('n1','guest','We like it mild')`); e != nil {
		t.Fatal(e)
	}
	if status, _ := askChef(t, f, "guest", "pasta", fiber.Map{"question": "how long now", "step": 1}); status != 200 {
		t.Fatal(status)
	}
	prompt := chef.lastPrompt()
	for _, part := range []string{"The cook's own version of this recipe", "Boil the spaghetti in salted water for 11 minutes.", "I like it softer", "“We like it mild”"} {
		if !strings.Contains(prompt, part) {
			t.Errorf("the answer didn't hear %q:\n%s", part, prompt)
		}
	}
	// The author's own recipe has no other version; another member hears none of it.
	if status, _ := askChef(t, f, "owner", "pasta", fiber.Map{"question": "how long now", "step": 1}); status != 200 {
		t.Fatal(status)
	}
	if prompt = chef.lastPrompt(); strings.Contains(prompt, "own version") || strings.Contains(prompt, "mild") {
		t.Fatalf("another member's version leaked:\n%s", prompt)
	}
}

func TestSousChefRemembersChangesAndNotesWithUndo(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", public, false); e != nil {
		t.Fatal(e)
	}
	run := agentTurn(t, a, p)
	out := a.agentTool(ctx, run, "remember_change", jsonBytes(map[string]any{"recipe_id": "toast", "kind": "time", "step": 1, "change": map[string]any{"text": "Toast the bread for 4 minutes until golden, then serve.", "seconds": 240}, "said": "my toaster is slow"}))
	if !strings.Contains(out, "kept") || len(run.effects) != 1 || run.effects[0].Kind != "remembered" || run.effects[0].Title != "Lemon toast" {
		t.Fatalf("remembered %s %+v", out, run.effects)
	}
	out = a.agentTool(ctx, run, "remember_kitchen_note", jsonBytes(map[string]any{"note": "My toaster is slow"}))
	if !strings.Contains(out, "My toaster is slow") || len(run.effects) != 2 || run.effects[1].Kind != "kitchen_note" {
		t.Fatalf("noted %s %+v", out, run.effects)
	}
	// What the sous-chef sees next: the member's version of the open recipe, and their notes.
	if status, b := studioReq(t, studioServer(a), "PUT", "/studio/"+p+"/context", "cook", "", map[string]any{"screen": "discover", "recipeId": "toast"}); status != 204 {
		t.Fatalf("context %d %s", status, b)
	}
	state, _ := a.studioState(ctx, p, 0)
	input, e := a.agentInput(ctx, state)
	if e != nil {
		t.Fatal(e)
	}
	in := input.(fiber.Map)
	if screen := in["screen"].(fiber.Map); !strings.Contains(screen["yourVersion"].(string), "4 min") {
		t.Fatalf("screen %v", screen)
	}
	if notes, _ := in["kitchenNotes"].([]string); len(notes) != 1 {
		t.Fatalf("notes %v", in["kitchenNotes"])
	}
	// Undo takes both back.
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	for _, f := range run.effects {
		if e = undoEffect(ctx, tx, "cook", f); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	var edits, notes int
	if e := a.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM recipe_edits),(SELECT count(*) FROM kitchen_notes)`).Scan(&edits, &notes); e != nil || edits != 0 || notes != 0 {
		t.Fatalf("after undo: %d edits, %d notes, %v", edits, notes, e)
	}
}
