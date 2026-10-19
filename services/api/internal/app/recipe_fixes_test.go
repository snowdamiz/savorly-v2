package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
)

func suggestions(t *testing.T, f *fiber.App, recipe, tok string) (bool, []suggestion) {
	t.Helper()
	status, b := send(t, f, "GET", "/v1/recipes/"+recipe+"/suggestions", tok, nil)
	var out struct {
		CanSuggest  bool
		Suggestions []suggestion
	}
	if status != 200 || json.Unmarshal(b, &out) != nil {
		t.Fatalf("suggestions %d %s", status, b)
	}
	return out.CanSuggest, out.Suggestions
}

func recipeSteps(t *testing.T, db *pgxpool.Pool, recipe string) []Step {
	t.Helper()
	var steps []Step
	if e := db.QueryRow(context.Background(), `SELECT steps FROM recipes WHERE id=$1`, recipe).Scan(&steps); e != nil {
		t.Fatal(e)
	}
	return steps
}

func TestOnlyVerifiedCooksSuggestAndAgree(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	authorID, author := signedIn(t, db, "author@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", true)
	otherID, other := signedIn(t, db, "other@example.test", true)
	_, stranger := signedIn(t, db, "stranger@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	verifiedCook(t, db, cookID, recipe, time.Now(), 0)
	verifiedCook(t, db, otherID, recipe, time.Now(), 0)
	path := "/v1/recipes/" + recipe + "/suggestions"
	longer := map[string]any{"kind": "time", "step": 2, "change": map[string]any{"text": "Simmer the sauce for 12 minutes.", "seconds": 720}, "reason": "Took me 12 minutes, not 8."}

	expect(t, f, 401, "POST", path, "", longer)
	expect(t, f, 403, "POST", path, stranger, longer)
	expect(t, f, 403, "POST", path, author, longer)
	expect(t, f, 400, "POST", path, cook, map[string]any{"kind": "taste", "step": 2})
	expect(t, f, 400, "POST", path, cook, map[string]any{"kind": "time", "step": 9, "change": map[string]any{"seconds": 60}})
	expect(t, f, 400, "POST", path, cook, map[string]any{"kind": "time", "step": 2, "change": map[string]any{"seconds": 480}})
	expect(t, f, 400, "POST", path, cook, map[string]any{"kind": "heat", "step": 2, "change": map[string]any{"text": "Hot"}})

	out := expect(t, f, 201, "POST", path, cook, longer)
	if out["fits"] != true || out["mine"] != true || out["votes"] != 0.0 || out["part"] != "step" || out["place"] != 2.0 {
		t.Fatalf("suggestion %v", out)
	}
	if before, _ := out["before"].(map[string]any); before["seconds"] != 480.0 || before["text"] != "Simmer the sauce for 8 minutes." {
		t.Fatalf("before %v", out["before"])
	}
	// One waits per cook and part.
	expect(t, f, 409, "POST", path, cook, longer)
	id, _ := out["id"].(string)

	// Anyone sees it; only another verified cook may agree, once.
	can, list := suggestions(t, f, recipe, "")
	if can || len(list) != 1 || list[0].Mine || list[0].Author.ID != cookID || list[0].Reason != "Took me 12 minutes, not 8." {
		t.Fatalf("as a guest: %v %+v", can, list)
	}
	if can, _ = suggestions(t, f, recipe, other); !can {
		t.Fatal("a verified cook can't suggest")
	}
	if can, _ = suggestions(t, f, recipe, author); can {
		t.Fatal("the author is offered suggestions to their own recipe")
	}
	vote := "/v1/suggestions/" + id + "/vote"
	expect(t, f, 400, "PUT", vote, cook, nil)
	expect(t, f, 403, "PUT", vote, stranger, nil)
	expect(t, f, 403, "PUT", vote, author, nil)
	expect(t, f, 200, "PUT", vote, other, nil)
	if got := expect(t, f, 200, "PUT", vote, other, nil); got["votes"] != 1.0 || got["voted"] != true {
		t.Fatalf("voted %v", got)
	}
	if got := expect(t, f, 200, "DELETE", vote, other, nil); got["votes"] != 0.0 || got["voted"] != false {
		t.Fatalf("unvoted %v", got)
	}
	expect(t, f, 200, "PUT", vote, other, nil)

	// A suspended cook's suggestions leave the recipe.
	if _, e := db.Exec(context.Background(), `UPDATE users SET suspended_at=now() WHERE id=$1`, cookID); e != nil {
		t.Fatal(e)
	}
	if _, list = suggestions(t, f, recipe, ""); len(list) != 0 {
		t.Fatalf("a suspended cook's suggestion shows: %+v", list)
	}
	if _, e := db.Exec(context.Background(), `UPDATE users SET suspended_at=NULL WHERE id=$1`, cookID); e != nil {
		t.Fatal(e)
	}

	// The cook can take it back.
	expect(t, f, 404, "DELETE", "/v1/suggestions/"+id, other, nil)
	expect(t, f, 204, "DELETE", "/v1/suggestions/"+id, cook, nil)
	if _, list = suggestions(t, f, recipe, ""); len(list) != 0 {
		t.Fatalf("a withdrawn suggestion shows: %+v", list)
	}
	expect(t, f, 201, "POST", path, cook, longer)
}

func TestAuthorAcceptsDeclinesAndUndoesFixes(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	authorID, author := signedIn(t, db, "author@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", true)
	otherID, other := signedIn(t, db, "other@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	// The serving step has a photo, which every change keeps where it is.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{2,image}','"https://media.example/serve.jpg"') WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	verifiedCook(t, db, cookID, recipe, time.Now(), 0)
	verifiedCook(t, db, otherID, recipe, time.Now(), 0)
	path := "/v1/recipes/" + recipe + "/suggestions"
	longer := expect(t, f, 201, "POST", path, cook, map[string]any{"kind": "time", "step": 2, "change": map[string]any{"text": "Simmer the sauce for 12 minutes.", "seconds": 720}})
	missing := expect(t, f, 201, "POST", path, other, map[string]any{"kind": "missing_step", "step": 1, "change": map[string]any{"title": "Soften", "text": "Soften the onion in olive oil for 5 minutes.", "seconds": 300}})
	amount := expect(t, f, 201, "POST", path, other, map[string]any{"kind": "amount", "ingredient": 1, "change": map[string]any{"amount": 1.5, "unit": "kg"}})
	answer := func(s map[string]any, tok string, status int, body map[string]any) map[string]any {
		t.Helper()
		return expect(t, f, status, "PATCH", "/v1/suggestions/"+s["id"].(string), tok, body)
	}

	// Only the author answers.
	answer(longer, cook, 404, map[string]any{"action": "accept"})
	answer(longer, author, 400, map[string]any{"action": "maybe"})
	// Accepted as the author edited it: the step changes, and the cook is credited.
	version := answer(longer, author, 200, map[string]any{"action": "accept", "change": map[string]any{"text": "Simmer the sauce for 10 to 12 minutes, until thick.", "seconds": 660}})
	if by, _ := version["by"].(map[string]any); by["id"] != cookID || version["undoable"] != true || version["kind"] != "time" {
		t.Fatalf("version %v", version)
	}
	steps := recipeSteps(t, db, recipe)
	if steps[1].Text != "Simmer the sauce for 10 to 12 minutes, until thick." || steps[1].Seconds != 660 || steps[2].Image != "https://media.example/serve.jpg" {
		t.Fatalf("steps after the fix %+v", steps)
	}
	got := expect(t, f, 200, "GET", "/v1/recipes/"+recipe, "", nil)
	if got["improvedBy"] != 1.0 {
		t.Fatalf("improvedBy %v", got["improvedBy"])
	}
	if _, list := suggestions(t, f, recipe, ""); len(list) != 2 {
		t.Fatalf("an accepted suggestion still waits: %+v", list)
	}

	// A missing step goes in after the step it follows, and other steps keep their photos.
	answer(missing, author, 200, map[string]any{"action": "accept"})
	steps = recipeSteps(t, db, recipe)
	if len(steps) != 4 || steps[1].Title != "Soften" || steps[1].Seconds != 300 || steps[1].Image != "" || steps[3].Image != "https://media.example/serve.jpg" {
		t.Fatalf("steps after a new one %+v", steps)
	}
	history := expect(t, f, 200, "GET", "/v1/recipes/"+recipe+"/history", "", nil)
	versions, _ := history["versions"].([]any)
	if len(versions) != 2 || versions[0].(map[string]any)["undoable"] != false {
		t.Fatalf("history as a guest %v", history)
	}
	history = expect(t, f, 200, "GET", "/v1/recipes/"+recipe+"/history", author, nil)
	versions, _ = history["versions"].([]any)
	latest, earlier := versions[0].(map[string]any), versions[1].(map[string]any)
	if latest["undoable"] != true || earlier["undoable"] != false {
		t.Fatalf("only the latest change can be undone: %v", history)
	}

	// Undone: the recipe is as it was, and the suggestion no longer credited.
	expect(t, f, 404, "POST", "/v1/recipes/"+recipe+"/history/"+latest["id"].(string)+"/undo", cook, nil)
	expect(t, f, 409, "POST", "/v1/recipes/"+recipe+"/history/"+earlier["id"].(string)+"/undo", author, nil)
	expect(t, f, 204, "POST", "/v1/recipes/"+recipe+"/history/"+latest["id"].(string)+"/undo", author, nil)
	if steps = recipeSteps(t, db, recipe); len(steps) != 3 || steps[2].Image != "https://media.example/serve.jpg" {
		t.Fatalf("steps after undo %+v", steps)
	}
	if got = expect(t, f, 200, "GET", "/v1/recipes/"+recipe, "", nil); got["improvedBy"] != 1.0 {
		t.Fatalf("improvedBy after undo %v", got["improvedBy"])
	}
	expect(t, f, 404, "POST", "/v1/recipes/"+recipe+"/history/"+latest["id"].(string)+"/undo", author, nil)

	// An amount fix re-reads what the recipe contains; an edit in the editor ends the undo.
	answer(amount, author, 200, map[string]any{"action": "accept"})
	var ingredients []Ingredient
	if e := db.QueryRow(ctx, `SELECT ingredients FROM recipes WHERE id=$1`, recipe).Scan(&ingredients); e != nil || ingredients[0].Amount != 1.5 {
		t.Fatalf("ingredients %+v %v", ingredients, e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{0,text}','"Chop the onion finely."') WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	history = expect(t, f, 200, "GET", "/v1/recipes/"+recipe+"/history", author, nil)
	versions, _ = history["versions"].([]any)
	if versions[0].(map[string]any)["undoable"] != false {
		t.Fatalf("a change after the fix can still be undone: %v", history)
	}

	// A suggestion for a step that has changed since no longer fits, and can only be declined.
	stale := expect(t, f, 201, "POST", path, cook, map[string]any{"kind": "note", "step": 1, "change": map[string]any{"text": "Chop the onion finely. A food processor works too."}})
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{0,text}','"Dice the onion."') WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	if _, list := suggestions(t, f, recipe, ""); len(list) != 1 || list[0].Fits {
		t.Fatalf("a suggestion for a changed step %+v", list)
	}
	answer(stale, author, 409, map[string]any{"action": "accept"})
	answer(stale, author, 204, map[string]any{"action": "decline", "response": "I changed this step already."})
	if _, list := suggestions(t, f, recipe, ""); len(list) != 0 {
		t.Fatalf("a declined suggestion still waits %+v", list)
	}
	var status, response string
	if e := db.QueryRow(ctx, `SELECT status,response FROM recipe_suggestions WHERE id=$1`, stale["id"]).Scan(&status, &response); e != nil || status != "declined" || response != "I changed this step already." {
		t.Fatalf("declined %q %q %v", status, response, e)
	}
}

func TestUnansweredSuggestionsBecomeNotes(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	authorID, author := signedIn(t, db, "author@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	verifiedCook(t, db, cookID, recipe, time.Now(), 0)
	s := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/suggestions", cook, map[string]any{"kind": "swap", "ingredient": 1, "change": map[string]any{"name": "Tomatoes or passata"}, "reason": "Passata worked just as well."})
	if _, e := db.Exec(ctx, `UPDATE recipe_suggestions SET created_at=now()-interval '31 days'`); e != nil {
		t.Fatal(e)
	}
	if _, e := runJanitor(ctx, db); e != nil {
		t.Fatal(e)
	}
	_, list := suggestions(t, f, recipe, "")
	if len(list) != 1 || list[0].Status != "stale" || list[0].After.Name != "Tomatoes or passata" {
		t.Fatalf("an unanswered suggestion %+v", list)
	}
	// Still the author's to accept, and the cook still can't suggest another there.
	expect(t, f, 409, "POST", "/v1/recipes/"+recipe+"/suggestions", cook, map[string]any{"kind": "swap", "ingredient": 1, "change": map[string]any{"name": "Passata"}})
	expect(t, f, 200, "PATCH", "/v1/suggestions/"+s["id"].(string), author, map[string]any{"action": "accept"})
	var name string
	if e := db.QueryRow(ctx, `SELECT ingredients->0->>'name' FROM recipes WHERE id=$1`, recipe).Scan(&name); e != nil || name != "Tomatoes or passata" {
		t.Fatalf("ingredient %q %v", name, e)
	}
}

func TestSousChefSuggestsAFixOnlyAfterAYes(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", public, false); e != nil {
		t.Fatal(e)
	}
	tool := func(name string, args any) string { return a.agentTool(ctx, agentTurn(t, a, p), name, jsonBytes(args)) }
	fix := map[string]any{"recipe_id": "toast", "kind": "time", "step": 1, "change": map[string]any{"text": "Toast the bread for 4 minutes until golden, then serve.", "seconds": 240}, "reason": "It needed 4 minutes in my toaster."}
	if out := tool("suggest_fix", fix); !strings.Contains(out, "Cook this recipe through in cooking mode first") {
		t.Fatalf("suggested without cooking it: %s", out)
	}
	verifiedCook(t, a.DB, "cook", "toast", time.Now(), 0)
	// A new timer comes with the step's new text, or the step would still say its old time.
	timerOnly := map[string]any{"recipe_id": "toast", "kind": "time", "step": 1, "change": map[string]any{"text": "", "seconds": 240}}
	if out := tool("suggest_fix", timerOnly); !strings.Contains(out, "whole new text") {
		t.Fatalf("a timer without its text: %s", out)
	}
	out := tool("suggest_fix", fix)
	if !strings.Contains(out, "needsConfirmation") || !strings.Contains(out, "Lemon toast") || !strings.Contains(out, "4 min timer") {
		t.Fatalf("not proposed: %s", out)
	}
	var kept int
	if e := a.DB.QueryRow(ctx, `SELECT count(*) FROM recipe_suggestions`).Scan(&kept); e != nil || kept != 0 {
		t.Fatalf("kept before the yes: %d %v", kept, e)
	}
	asked(t, a, p, "Suggest a change to Lemon toast?")
	say(t, a, p, "Yes, send it.")
	if out = tool("confirm_action", nil); !strings.Contains(out, "\"fits\":true") {
		t.Fatalf("after the yes: %s", out)
	}
	var reason string
	if e := a.DB.QueryRow(ctx, `SELECT reason FROM recipe_suggestions WHERE user_id='cook'`).Scan(&reason); e != nil || reason != "It needed 4 minutes in my toaster." {
		t.Fatalf("kept %q %v", reason, e)
	}
}
