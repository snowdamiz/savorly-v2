package app

import (
	"encoding/json"
	"testing"
)

// A recipe's author answers a review: the answer shows on the review, can be changed or
// removed by them alone, and the reviewer hears about it once, in their language.
func TestRecipeAuthorsReplyToReviews(t *testing.T) {
	db := isolatedDB(t)
	namedUser(t, db, "chef", "Ana")
	namedUser(t, db, "critic", "Ben")
	namedUser(t, db, "fan", "Cleo")
	registerDevice(t, db, "critic")
	setPreferences(t, db, "critic", `{"language":"fr"}`)
	publishRecipe(t, db, "chef", "tart", func(r *RecipeInput) { r.Title = "Lemon tart" })
	f := recipesApp(db, false)
	chef, critic, fan := bearerFor(t, db, "chef"), bearerFor(t, db, "critic"), bearerFor(t, db, "fan")
	if status, b := callAPI(t, f, "PUT", "/v1/recipes/tart/review", critic, map[string]any{"rating": 4, "body": "Lovely, a bit sweet."}); status != 200 {
		t.Fatalf("review: %d %s", status, b)
	}
	var review string
	if e := db.QueryRow(t.Context(), `SELECT id FROM reviews WHERE recipe_id='tart'`).Scan(&review); e != nil {
		t.Fatal(e)
	}
	path := "/v1/recipes/tart/reviews/" + review + "/reply"
	reply := func() map[string]any {
		t.Helper()
		_, b := callAPI(t, f, "GET", "/v1/recipes/tart/reviews", "", nil)
		var list []struct{ Reply map[string]any }
		if e := json.Unmarshal(b, &list); e != nil || len(list) != 1 {
			t.Fatalf("reviews: %s", b)
		}
		return list[0].Reply
	}
	for _, tc := range []struct {
		token string
		body  any
		want  int
	}{
		{fan, map[string]any{"body": "Not my recipe."}, 404},
		{critic, map[string]any{"body": "Replying to myself."}, 404},
		{chef, map[string]any{"body": "x"}, 400},
		{chef, map[string]any{"body": "Thank you! Try less sugar next time."}, 200},
		{chef, map[string]any{"body": "Thank you! Try 50 g less sugar next time."}, 200},
	} {
		if status, b := callAPI(t, f, "PUT", path, tc.token, tc.body); status != tc.want {
			t.Fatalf("%v: %d %s", tc.body, status, b)
		}
	}
	if got := reply(); got["body"] != "Thank you! Try 50 g less sugar next time." || got["repliedAt"] == nil {
		t.Fatalf("reply: %v", got)
	}
	// The first answer is announced once, however often it is edited.
	expo := newFakeExpo(t)
	drain(t, expo.notifier(db))
	sent := expo.sent()[deviceToken("critic")]
	if len(sent) != 1 || sent[0].Title != "Ana a répondu à votre avis" || sent[0].Body != "« Thank you! Try less sugar next time. »" || payload(sent[0])["recipeId"] != "tart" {
		t.Fatalf("notices: %+v", sent)
	}
	if status, _ := callAPI(t, f, "DELETE", path, fan, nil); status != 404 {
		t.Fatalf("someone else removed the reply: %d", status)
	}
	if status, _ := callAPI(t, f, "DELETE", path, chef, nil); status != 204 || reply() != nil {
		t.Fatalf("remove: %d %v", status, reply())
	}
	if status, _ := callAPI(t, f, "DELETE", path, chef, nil); status != 404 {
		t.Fatalf("removing nothing: %d", status)
	}
}
