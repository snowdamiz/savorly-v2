package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestASousChefVersionCreditsItsOriginal(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	original := exampleVoiceRecipe()
	original.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", original, false); e != nil {
		t.Fatal(e)
	}
	if e := persistRecipe(ctx, a.DB, "other", "secret", exampleVoiceRecipe(), false); e != nil {
		t.Fatal(e)
	}
	vegan := exampleVoiceRecipe()
	vegan.Title = "Vegan lemon toast"
	results := ""
	from := "secret"
	studioAgent(t, a, func(r agentRound) any {
		if !r.answered() || (from == "secret" && strings.Contains(r.results(), "must be published")) {
			if r.answered() {
				results, from = r.results(), "toast"
			}
			return orderedCalls("save_recipe_draft", map[string]any{"recipe": vegan, "new_recipe": true, "derived_from": from})
		}
		return map[string]any{"content": "Saved your vegan version."}
	})
	studioTurn(t, ctx, a, p, "Make it vegan and keep it.")
	// Another cook's private recipe can't be credited; their published one is.
	if !strings.Contains(results, "The original recipe must be published or one of your own.") {
		t.Fatalf("a private original was accepted: %s", results)
	}
	var title, derived string
	if e := a.DB.QueryRow(ctx, `SELECT r.title,COALESCE(r.derived_from,'') FROM voice_projects p JOIN recipes r ON r.id=p.recipe_id WHERE p.id=$1`, p).Scan(&title, &derived); e != nil || title != "Vegan lemon toast" || derived != "toast" {
		t.Fatalf("draft %q derived from %q: %v", title, derived, e)
	}
}

func TestAPollReadsTheConversationAndItsNewEventsAtOnce(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	say(t, a, p, "Hello.")
	say(t, a, p, "Anyone there?")
	var first struct {
		ID     string
		Events []struct{ Seq int64 }
	}
	status, b := studioReq(t, f, "GET", "/studio/"+p+"?after=0", "cook", "", nil)
	if status != 200 || json.Unmarshal(b, &first) != nil || first.ID != p || len(first.Events) != 2 {
		t.Fatalf("%d %s", status, b)
	}
	var next struct{ Events []json.RawMessage }
	_, b = studioReq(t, f, "GET", "/studio/"+p+"?after="+jsonNumber(first.Events[1].Seq), "cook", "", nil)
	if json.Unmarshal(b, &next) != nil || next.Events == nil || len(next.Events) != 0 {
		t.Fatalf("nothing new: %s", b)
	}
	// Without after, a conversation reads as before.
	if _, b = studioReq(t, f, "GET", "/studio/"+p, "cook", "", nil); strings.Contains(string(b), `"events"`) {
		t.Fatalf("events without after: %s", b)
	}
	if status, _ := studioReq(t, f, "GET", "/studio/"+p+"?after=0", "other", "", nil); status != 404 {
		t.Fatalf("someone else read it: %d", status)
	}
}

func jsonNumber(n int64) string { return string(jsonBytes(n)) }
