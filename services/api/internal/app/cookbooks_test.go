package app

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestSharedCookbooks(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"owner", "cook", "banned", "reader"} {
		testUser(t, db, id)
	}
	publishRecipe(t, db, "cook", "soup", nil)
	publishRecipe(t, db, "cook", "salad", func(r *RecipeInput) { r.Image = "https://images.example.com/salad.jpg" })
	publishRecipe(t, db, "banned", "stew", func(r *RecipeInput) { r.Image = "https://images.example.com/stew.jpg" })
	publishRecipe(t, db, "cook", "bread", nil)
	f := recipesApp(db, false)
	owner, reader := bearerFor(t, db, "owner"), bearerFor(t, db, "reader")
	book := jsonObject(t, mustCall(t, f, 200, "POST", "/v1/collections", owner, fiber.Map{"name": "Weeknights"}))["id"].(string)
	empty := jsonObject(t, mustCall(t, f, 200, "POST", "/v1/collections", owner, fiber.Map{"name": "Someday"}))["id"].(string)
	for _, id := range []string{"soup", "salad", "stew"} {
		mustCall(t, f, 200, "PUT", "/v1/recipes/"+id+"/save", owner, fiber.Map{"collectionId": book})
	}
	mustCall(t, f, 200, "PUT", "/v1/recipes/bread/save", owner, nil) // saved, but in no cookbook
	path := "/v1/cookbooks/" + book

	// Private until shared: only the owner opens it.
	mustCall(t, f, 404, "GET", path, "", nil)
	mustCall(t, f, 404, "GET", path, reader, nil)
	page := jsonObject(t, mustCall(t, f, 200, "GET", path, owner, nil))
	if page["public"] != false || page["recipeCount"] != float64(3) || len(page["recipes"].([]any)) != 3 {
		t.Fatalf("the owner's private cookbook: %v", page)
	}
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/creators/owner/cookbooks", "", nil)); len(got) != 0 {
		t.Fatalf("a private cookbook is listed: %v", got)
	}

	// Sharing, renaming and describing it.
	mustCall(t, f, 404, "PATCH", "/v1/collections/"+book, reader, fiber.Map{"public": true})
	for _, body := range []fiber.Map{{"name": " "}, {"name": strings.Repeat("a", 61)}, {"description": strings.Repeat("a", 301)}} {
		mustCall(t, f, 400, "PATCH", "/v1/collections/"+book, owner, body)
	}
	mustCall(t, f, 409, "PATCH", "/v1/collections/"+book, owner, fiber.Map{"name": "Someday"})
	got := jsonObject(t, mustCall(t, f, 200, "PATCH", "/v1/collections/"+book, owner, fiber.Map{"public": true, "description": "  Fast dinners.  "}))
	if got["id"] != book || got["name"] != "Weeknights" || got["public"] != true || got["description"] != "Fast dinners." {
		t.Fatalf("patched: %v", got)
	}
	if got := jsonObject(t, mustCall(t, f, 200, "PATCH", "/v1/collections/"+book, owner, fiber.Map{"name": "Weeknight dinners"})); got["public"] != true || got["description"] != "Fast dinners." {
		t.Fatalf("a rename changed the rest: %v", got)
	}
	mustCall(t, f, 200, "PATCH", "/v1/collections/"+empty, owner, fiber.Map{"public": true})
	library := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/library", owner, nil))
	books := map[string]map[string]any{}
	for _, c := range library["collections"].([]any) {
		books[c.(map[string]any)["id"].(string)] = c.(map[string]any)
	}
	if books[book]["public"] != true || books[book]["description"] != "Fast dinners." || books[empty]["description"] != "" {
		t.Fatalf("library cookbooks: %v", books)
	}

	// Anyone can open it now: newest saved first, a page at a time.
	page = jsonObject(t, mustCall(t, f, 200, "GET", path, "", nil))
	ownerJSON, _ := page["owner"].(map[string]any)
	if page["name"] != "Weeknight dinners" || page["public"] != true || ownerJSON["id"] != "owner" || ownerJSON["handle"] != "owner" || page["hasMore"] != false {
		t.Fatalf("shared cookbook: %v", page)
	}
	if ids := listedIDs(t, jsonBytes(page["recipes"])); !slices.Equal(ids, []string{"stew", "salad", "soup"}) {
		t.Fatalf("order: %v", ids)
	}
	first := jsonObject(t, mustCall(t, f, 200, "GET", path+"?limit=2", "", nil))
	rest := jsonObject(t, mustCall(t, f, 200, "GET", path+"?limit=2&offset=2", "", nil))
	if a, b := listedIDs(t, jsonBytes(first["recipes"])), listedIDs(t, jsonBytes(rest["recipes"])); !slices.Equal(append(a, b...), []string{"stew", "salad", "soup"}) || first["hasMore"] != true || rest["hasMore"] != false || rest["recipeCount"] != float64(3) {
		t.Fatalf("pages: %v %v", first, rest)
	}
	cookbooks := jsonList(t, mustCall(t, f, 200, "GET", "/v1/creators/owner/cookbooks", "", nil))
	if len(cookbooks) != 1 || cookbooks[0]["id"] != book || cookbooks[0]["recipeCount"] != float64(3) || cookbooks[0]["cover"] != "https://images.example.com/stew.jpg" || cookbooks[0]["description"] != "Fast dinners." {
		t.Fatalf("creator's cookbooks (the empty one stays out): %v", cookbooks)
	}

	// Only published recipes by cooks in good standing show.
	suspend(t, db, "banned", true)
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=false WHERE id='soup'`); e != nil {
		t.Fatal(e)
	}
	page = jsonObject(t, mustCall(t, f, 200, "GET", path, "", nil))
	if ids := listedIDs(t, jsonBytes(page["recipes"])); !slices.Equal(ids, []string{"salad"}) || page["recipeCount"] != float64(1) {
		t.Fatalf("hidden recipes show: %v", page)
	}
	if cookbooks := jsonList(t, mustCall(t, f, 200, "GET", "/v1/creators/owner/cookbooks", "", nil)); len(cookbooks) != 1 || cookbooks[0]["cover"] != "https://images.example.com/salad.jpg" || cookbooks[0]["recipeCount"] != float64(1) {
		t.Fatalf("cover and count follow what shows: %v", cookbooks)
	}

	// The sitemap lists shared cookbooks that show something.
	var sitemap struct {
		Cookbooks []struct{ ID, UpdatedAt string }
	}
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/sitemap", "", nil), &sitemap); e != nil || len(sitemap.Cookbooks) != 1 || sitemap.Cookbooks[0].ID != book || sitemap.Cookbooks[0].UpdatedAt == "" {
		t.Fatalf("sitemap cookbooks: %+v %v", sitemap, e)
	}

	// Back to private, and a suspended owner's cookbooks, leave public view.
	mustCall(t, f, 200, "PATCH", "/v1/collections/"+book, owner, fiber.Map{"public": false})
	mustCall(t, f, 404, "GET", path, "", nil)
	mustCall(t, f, 200, "PATCH", "/v1/collections/"+book, owner, fiber.Map{"public": true})
	suspend(t, db, "owner", true)
	mustCall(t, f, 404, "GET", path, "", nil)
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/creators/owner/cookbooks", "", nil)); len(got) != 0 {
		t.Fatalf("a suspended owner's cookbooks: %v", got)
	}
	mustCall(t, f, 404, "GET", "/v1/cookbooks/missing", "", nil)
}
