package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
)

// jsonList reads a JSON list of objects.
func jsonList(t *testing.T, b []byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	if e := json.Unmarshal(b, &out); e != nil {
		t.Fatalf("not a list: %s", b)
	}
	return out
}

// jsonObject reads a JSON object.
func jsonObject(t *testing.T, b []byte) map[string]any {
	t.Helper()
	out := map[string]any{}
	if e := json.Unmarshal(b, &out); e != nil {
		t.Fatalf("not an object: %s", b)
	}
	return out
}

// mustCall calls the API and fails unless it answers status, returning the body.
func mustCall(t *testing.T, f *fiber.App, status int, method, path, token string, body any) []byte {
	t.Helper()
	got, b := callAPI(t, f, method, path, token, body)
	if got != status {
		t.Fatalf("%s %s: %d, want %d: %s", method, path, got, status, b)
	}
	return b
}

func suspend(t *testing.T, db *pgxpool.Pool, id string, suspended bool) {
	t.Helper()
	if _, e := db.Exec(context.Background(), `UPDATE users SET suspended_at=CASE WHEN $2 THEN now() END WHERE id=$1`, id, suspended); e != nil {
		t.Fatal(e)
	}
}

func recipeField(t *testing.T, f *fiber.App, id, token, field string) any {
	t.Helper()
	return jsonObject(t, mustCall(t, f, 200, "GET", "/v1/recipes/"+id, token, nil))[field]
}

func TestCommentsThreadOneLevelDeep(t *testing.T) {
	db := isolatedDB(t)
	for _, id := range []string{"chef", "fan", "troll", "chatty"} {
		testUser(t, db, id)
	}
	publishRecipe(t, db, "chef", "soup", nil)
	publishRecipe(t, db, "fan", "stew", nil)
	publishRecipe(t, db, "chef", "draft", func(r *RecipeInput) { r.Published = false })
	f := recipesApp(db, false)
	chef, fan, troll := bearerFor(t, db, "chef"), bearerFor(t, db, "fan"), bearerFor(t, db, "troll")

	for _, body := range []any{fiber.Map{"body": "   "}, fiber.Map{"body": strings.Repeat("a", 1001)}, fiber.Map{}} {
		mustCall(t, f, 400, "POST", "/v1/recipes/soup/comments", fan, body)
	}
	mustCall(t, f, 404, "POST", "/v1/recipes/draft/comments", fan, fiber.Map{"body": "Can't see this one"})
	mustCall(t, f, 404, "POST", "/v1/recipes/missing/comments", fan, fiber.Map{"body": "Nothing here"})

	first := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes/soup/comments", fan, fiber.Map{"body": "  Lovely soup!  "}))
	author, _ := first["author"].(map[string]any)
	if first["body"] != "Lovely soup!" || first["parentId"] != nil || first["canDelete"] != true || author["id"] != "fan" || author["handle"] != "fan" || first["createdAt"] == nil {
		t.Fatalf("comment: %v", first)
	}
	reply := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes/soup/comments", chef, fiber.Map{"body": "Thank you!", "parentId": first["id"]}))
	// Answering a reply answers the comment it replies to.
	deeper := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes/soup/comments", troll, fiber.Map{"body": "Meh.", "parentId": reply["id"]}))
	if reply["parentId"] != first["id"] || deeper["parentId"] != first["id"] {
		t.Fatalf("replies: %v %v", reply, deeper)
	}
	other := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes/stew/comments", chef, fiber.Map{"body": "Nice stew"}))
	mustCall(t, f, 404, "POST", "/v1/recipes/soup/comments", fan, fiber.Map{"body": "Wrong thread", "parentId": other["id"]})
	mustCall(t, f, 404, "POST", "/v1/recipes/soup/comments", fan, fiber.Map{"body": "No such comment", "parentId": "missing"})

	list := func(token, query string) []map[string]any {
		t.Helper()
		return jsonList(t, mustCall(t, f, 200, "GET", "/v1/recipes/soup/comments"+query, token, nil))
	}
	deletable := func(token string) string {
		t.Helper()
		var out []string
		for _, c := range list(token, "") {
			if c["canDelete"] == true {
				out = append(out, c["body"].(string))
			}
		}
		return strings.Join(out, "|")
	}
	if got := list("", ""); len(got) != 3 || got[0]["id"] != first["id"] || got[1]["id"] != reply["id"] || got[2]["id"] != deeper["id"] {
		t.Fatalf("oldest first: %v", got)
	}
	for token, want := range map[string]string{"": "", fan: "Lovely soup!", troll: "Meh.", chef: "Lovely soup!|Thank you!|Meh."} {
		if got := deletable(token); got != want {
			t.Errorf("deletable for %q: %q, want %q", token, got, want)
		}
	}
	if got := list("", "?limit=1&offset=1"); len(got) != 1 || got[0]["id"] != reply["id"] {
		t.Errorf("page: %v", got)
	}
	if n := recipeField(t, f, "soup", "", "commentCount"); n != float64(3) {
		t.Errorf("commentCount: %v", n)
	}

	// Suspended members' comments leave the thread, with the replies to them.
	suspend(t, db, "troll", true)
	if got := list("", ""); len(got) != 2 {
		t.Errorf("a suspended member's reply shows: %v", got)
	}
	suspend(t, db, "fan", true)
	if got := list("", ""); len(got) != 0 {
		t.Errorf("replies to a suspended member's comment show: %v", got)
	}
	suspend(t, db, "fan", false)
	suspend(t, db, "troll", false)

	// The comment's author or the recipe's can delete it, with its replies; nobody else.
	mustCall(t, f, 404, "DELETE", "/v1/comments/"+first["id"].(string), troll, nil)
	mustCall(t, f, 204, "DELETE", "/v1/comments/"+deeper["id"].(string), troll, nil)
	mustCall(t, f, 204, "DELETE", "/v1/comments/"+first["id"].(string), chef, nil)
	mustCall(t, f, 404, "DELETE", "/v1/comments/"+first["id"].(string), chef, nil)
	if got := list("", ""); len(got) != 0 || count(t, db, `SELECT count(*) FROM comments WHERE recipe_id='soup'`) != 0 {
		t.Fatalf("replies outlived their comment: %v", got)
	}
	mustCall(t, f, 204, "DELETE", "/v1/comments/"+other["id"].(string), chef, nil)

	// A draft's comments are its author's to read.
	if _, e := db.Exec(context.Background(), `INSERT INTO comments(id,recipe_id,user_id,body) VALUES('old','draft','fan','From when it was published')`); e != nil {
		t.Fatal(e)
	}
	if got := list("", ""); len(got) != 0 {
		t.Fatal(got)
	}
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/recipes/draft/comments", "", nil)); len(got) != 0 {
		t.Errorf("a guest reads a draft's comments: %v", got)
	}
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/recipes/draft/comments", chef, nil)); len(got) != 1 || got[0]["canDelete"] != true {
		t.Errorf("the author's draft comments: %v", got)
	}

	// 30 comments an hour.
	chatty := bearerFor(t, db, "chatty")
	for range 30 {
		mustCall(t, f, 201, "POST", "/v1/recipes/stew/comments", chatty, fiber.Map{"body": "Again!"})
	}
	mustCall(t, f, 429, "POST", "/v1/recipes/stew/comments", chatty, fiber.Map{"body": "Again!"})
}

func TestCookedThisOncePerCook(t *testing.T) {
	t.Setenv("S3_PUBLIC_URL", "https://media.example.com")
	t.Setenv("MEDIA_HOSTS", "")
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"chef", "fan", "friend"} {
		testUser(t, db, id)
	}
	publishRecipe(t, db, "chef", "soup", nil)
	publishRecipe(t, db, "chef", "draft", func(r *RecipeInput) { r.Published = false })
	f := recipesApp(db, true)
	fan, friend := bearerFor(t, db, "fan"), bearerFor(t, db, "friend")
	cooked := func(token string, body any) map[string]any {
		t.Helper()
		return jsonObject(t, mustCall(t, f, 200, "POST", "/v1/recipes/soup/cooked", token, body))
	}
	stored := func() (photo, note string) {
		t.Helper()
		if e := db.QueryRow(ctx, `SELECT photo,note FROM cooks WHERE user_id='fan' AND recipe_id='soup'`).Scan(&photo, &note); e != nil {
			t.Fatal(e)
		}
		return
	}

	if got := cooked(fan, nil); got["cooked"] != true || got["cookedCount"] != float64(1) {
		t.Fatalf("first cook: %v", got)
	}
	photo := "https://media.example.com/uploads/fan/plate.jpg"
	if got := cooked(fan, fiber.Map{"photo": photo, "note": "  Added chili.  "}); got["cookedCount"] != float64(1) {
		t.Fatalf("cooking again counts once: %v", got)
	}
	if p, n := stored(); p != photo || n != "Added chili." {
		t.Fatalf("stored: %q %q", p, n)
	}
	// What a later cook doesn't send stays; "" clears it.
	cooked(fan, fiber.Map{})
	cooked(fan, fiber.Map{"note": ""})
	if p, n := stored(); p != photo || n != "" {
		t.Fatalf("partial update: %q %q", p, n)
	}
	for _, body := range []fiber.Map{{"photo": "javascript:alert(1)"}, {"photo": "https://tracker.example.net/pixel.gif"}, {"note": strings.Repeat("a", 501)}} {
		mustCall(t, f, 400, "POST", "/v1/recipes/soup/cooked", fan, body)
	}
	// A photo already there stays valid, like a recipe's own media.
	if _, e := db.Exec(ctx, `UPDATE cooks SET photo='https://legacy.example.net/plate.jpg' WHERE user_id='fan'`); e != nil {
		t.Fatal(e)
	}
	cooked(fan, fiber.Map{"photo": "https://legacy.example.net/plate.jpg", "note": "Still good"})
	mustCall(t, f, 400, "POST", "/v1/recipes/soup/cooked", friend, fiber.Map{"photo": "https://legacy.example.net/plate.jpg"})
	mustCall(t, f, 404, "POST", "/v1/recipes/draft/cooked", fan, nil)
	mustCall(t, f, 404, "POST", "/v1/recipes/missing/cooked", fan, nil)

	if got := cooked(friend, fiber.Map{"photo": "https://media.example.com/friend/soup.jpg"}); got["cookedCount"] != float64(2) {
		t.Fatalf("second cook: %v", got)
	}
	list := jsonList(t, mustCall(t, f, 200, "GET", "/v1/recipes/soup/cooks", "", nil))
	if len(list) != 2 || list[0]["photo"] != "https://media.example.com/friend/soup.jpg" || list[1]["note"] != "Still good" || list[0]["author"].(map[string]any)["handle"] != "friend" {
		t.Fatalf("newest first: %v", list)
	}
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/recipes/soup/cooks?limit=1", "", nil)); len(got) != 1 {
		t.Errorf("limit: %v", got)
	}
	if n := recipeField(t, f, "soup", "", "cookedCount"); n != float64(2) {
		t.Errorf("cookedCount: %v", n)
	}
	library := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/library", fan, nil))
	if ids, _ := library["cookedIds"].([]any); len(ids) != 1 || ids[0] != "soup" {
		t.Errorf("cookedIds: %v", library["cookedIds"])
	}
	suspend(t, db, "friend", true)
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/recipes/soup/cooks", "", nil)); len(got) != 1 {
		t.Errorf("a suspended cook shows: %v", got)
	}
	mustCall(t, f, 204, "DELETE", "/v1/recipes/soup/cooked", fan, nil)
	mustCall(t, f, 204, "DELETE", "/v1/recipes/soup/cooked", fan, nil)
	if library := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/library", fan, nil)); len(library["cookedIds"].([]any)) != 0 {
		t.Errorf("uncooked: %v", library["cookedIds"])
	}
	// Unpublished, a recipe's cooks are out of view too.
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=false WHERE id='soup'`); e != nil {
		t.Fatal(e)
	}
	suspend(t, db, "friend", false)
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/recipes/soup/cooks", "", nil)); len(got) != 0 {
		t.Errorf("a draft's cooks show: %v", got)
	}
}
