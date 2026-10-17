package app

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestDerivedFromAndSourceInput(t *testing.T) {
	for in, want := range map[string]RecipeRef{
		`{}`:                      {},
		`{"derivedFrom":null}`:    {},
		`{"derivedFrom":"abc"}`:   {ID: "abc", Set: true},
		`{"derivedFrom":" abc "}`: {ID: "abc", Set: true},
		`{"derivedFrom":""}`:      {Set: true},
		// What recipe JSON carries, sent back as it came by apps that edit a recipe they loaded.
		`{"derivedFrom":{"id":"abc","title":"Soup","author":{"id":"chef"}}}`: {},
	} {
		var r RecipeInput
		if e := json.Unmarshal([]byte(in), &r); e != nil || r.DerivedFrom != want {
			t.Errorf("%s: %+v %v", in, r.DerivedFrom, e)
		}
	}
	for _, in := range []string{`{"derivedFrom":5}`, `{"derivedFrom":["abc"]}`, `{"derivedFrom":true}`} {
		var r RecipeInput
		if json.Unmarshal([]byte(in), &r) == nil {
			t.Errorf("accepted %s", in)
		}
	}
	// Writers that never set them (the studio, older tests) send neither field.
	if b := string(jsonBytes(validRecipe())); strings.Contains(b, "derivedFrom") || strings.Contains(b, "sourceUrl") || strings.Contains(b, `"seconds":0,"image"`) {
		t.Errorf("unset fields marshalled: %s", b)
	}
	source := "https://cook.example/soup"
	r := validRecipe()
	r.DerivedFrom, r.SourceURL = RecipeRef{ID: "abc", Set: true}, &source
	r.Steps[0].Image = "https://media.example.com/step.jpg"
	var back RecipeInput
	if e := json.Unmarshal(jsonBytes(r), &back); e != nil || back.DerivedFrom != r.DerivedFrom || *back.SourceURL != source || back.Steps[0].Image != r.Steps[0].Image {
		t.Errorf("round trip: %+v %v", back, e)
	}

	for _, s := range []string{"", "https://cook.example/a?b=1", "http://cook.example/a", " https://cook.example/a "} {
		r := validRecipe()
		r.SourceURL = &s
		if e := r.Validate(); e != nil || *r.SourceURL != strings.TrimSpace(s) {
			t.Errorf("source %q: %v", s, e)
		}
	}
	for _, s := range []string{"ftp://cook.example/a", "javascript:alert(1)", "https://user:pw@cook.example/", "https://", "cook.example/a", "https://cook.example/" + strings.Repeat("a", 480)} {
		r := validRecipe()
		r.SourceURL = &s
		if r.Validate() == nil {
			t.Errorf("accepted source %q", s)
		}
	}
	for image, ok := range map[string]bool{"": true, " https://media.example.com/a.jpg ": true, "javascript:alert(1)": false, "http://cook.example/a.jpg": false} {
		r := validRecipe()
		r.Steps[0].Image = image
		if e := r.Validate(); (e == nil) != ok || (ok && r.Steps[0].Image != strings.TrimSpace(image)) {
			t.Errorf("step image %q: %v", image, e)
		}
	}
}

func TestVariationsCreditTheirOriginal(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"chef", "cook", "other"} {
		testUser(t, db, id)
	}
	publishRecipe(t, db, "chef", "original", nil)
	publishRecipe(t, db, "chef", "chef-draft", func(r *RecipeInput) { r.Published = false })
	publishRecipe(t, db, "cook", "cook-draft", func(r *RecipeInput) { r.Published = false })
	f := recipesApp(db, false)
	cook, chef, other := bearerFor(t, db, "cook"), bearerFor(t, db, "chef"), bearerFor(t, db, "other")
	input := func(change map[string]any) map[string]any {
		var r map[string]any
		_ = json.Unmarshal(jsonBytes(validRecipe()), &r)
		r["published"] = true
		for k, v := range change {
			r[k] = v
		}
		return r
	}
	stored := func(id string) (derived *string, source string) {
		t.Helper()
		if e := db.QueryRow(ctx, `SELECT derived_from,source_url FROM recipes WHERE id=$1`, id).Scan(&derived, &source); e != nil {
			t.Fatal(e)
		}
		return
	}

	saved := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes", cook, input(map[string]any{"derivedFrom": "original", "sourceUrl": "https://cook.example/soup"})))
	id := saved["id"].(string)
	link, _ := saved["derivedFrom"].(map[string]any)
	author, _ := link["author"].(map[string]any)
	if link["id"] != "original" || link["title"] != "Lemon pasta" || author["id"] != "chef" || author["handle"] != "chef" || author["name"] != "Test cook" || saved["sourceUrl"] != "https://cook.example/soup" || saved["variationCount"] != float64(0) {
		t.Fatalf("variation: %v", saved)
	}
	for _, original := range []string{"chef-draft", "missing"} {
		mustCall(t, f, 400, "POST", "/v1/recipes", cook, input(map[string]any{"derivedFrom": original}))
	}
	mustCall(t, f, 400, "POST", "/v1/recipes", cook, input(map[string]any{"sourceUrl": "javascript:alert(1)"}))
	// A cook's own draft can be the original, but recipe JSON names only public originals.
	fromDraft := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes", cook, input(map[string]any{"derivedFrom": "cook-draft"})))
	if d, _ := stored(fromDraft["id"].(string)); fromDraft["derivedFrom"] != nil || d == nil || *d != "cook-draft" {
		t.Fatalf("from a draft: %v %v", fromDraft["derivedFrom"], d)
	}
	mustCall(t, f, 201, "POST", "/v1/recipes", other, input(map[string]any{"derivedFrom": "original", "published": false}))
	if n := recipeField(t, f, "original", "", "variationCount"); n != float64(1) {
		t.Fatalf("variationCount counts published variations: %v", n)
	}
	if ids := listedIDs(t, mustCall(t, f, 200, "GET", "/v1/recipes/original/variations", "", nil)); !slices.Equal(ids, []string{id}) {
		t.Fatalf("variations: %v", ids)
	}

	put := func(token string, body any) map[string]any {
		t.Helper()
		return jsonObject(t, mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, token, body))
	}
	mustCall(t, f, 400, "PUT", "/v1/recipes/"+id, cook, input(map[string]any{"derivedFrom": id}))
	// Apps that don't know the fields keep both, and so do apps that send a recipe back as it came.
	put(cook, input(nil))
	put(cook, jsonObject(t, mustCall(t, f, 200, "GET", "/v1/recipes/"+id, cook, nil)))
	if d, s := stored(id); d == nil || *d != "original" || s != "https://cook.example/soup" {
		t.Fatalf("kept: %v %q", d, s)
	}
	if got := put(cook, input(map[string]any{"derivedFrom": "", "sourceUrl": ""})); got["derivedFrom"] != nil || got["sourceUrl"] != "" {
		t.Fatalf("cleared: %v", got)
	}
	put(cook, input(map[string]any{"derivedFrom": "original"}))

	// The link a recipe has stays valid after its original goes private; a new one can't be made.
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=false WHERE id='original'`); e != nil {
		t.Fatal(e)
	}
	if got := put(cook, input(map[string]any{"derivedFrom": "original", "title": "Lemon pasta, my way"})); got["derivedFrom"] != nil || got["title"] != "Lemon pasta, my way" {
		t.Fatalf("edit after the original went private: %v", got)
	}
	mustCall(t, f, 400, "POST", "/v1/recipes", other, input(map[string]any{"derivedFrom": "original"}))
	// Published again, as a variation of its author's draft, which stays unnamed.
	if got := jsonObject(t, mustCall(t, f, 200, "PUT", "/v1/recipes/original", chef, input(map[string]any{"derivedFrom": "chef-draft"}))); got["derivedFrom"] != nil {
		t.Fatalf("a private original shows: %v", got["derivedFrom"])
	}
	suspend(t, db, "cook", true)
	if ids := listedIDs(t, mustCall(t, f, 200, "GET", "/v1/recipes/original/variations", "", nil)); len(ids) != 0 {
		t.Fatalf("a suspended cook's variation is listed: %v", ids)
	}
	suspend(t, db, "cook", false)

	// Writers other than the API (the sous-chef) can't make a link the API would refuse.
	r := validRecipe()
	r.DerivedFrom = RecipeRef{ID: "chef-draft", Set: true}
	if e := persistRecipe(ctx, db, "cook", "studio-draft", r, false); e != nil {
		t.Fatal(e)
	}
	if d, _ := stored("studio-draft"); d != nil {
		t.Fatalf("persisted a link to someone's draft: %v", *d)
	}

	// Deleting the original keeps its variations, without the link.
	mustCall(t, f, 204, "DELETE", "/v1/recipes/original", chef, nil)
	if d, s := stored(id); d != nil || s != "" {
		t.Fatalf("after the original was deleted: %v %q", d, s)
	}
}

func TestStepPhotosFollowMediaRules(t *testing.T) {
	t.Setenv("S3_PUBLIC_URL", "https://media.example.com")
	t.Setenv("MEDIA_HOSTS", "images.unsplash.com")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	f := recipesApp(db, true)
	cook := bearerFor(t, db, "cook")
	withPhotos := func(urls ...string) RecipeInput {
		r := validRecipe()
		r.Steps = nil
		for _, u := range urls {
			r.Steps = append(r.Steps, Step{Title: "Next", Text: "Do the next thing.", Image: u})
		}
		return r
	}
	saved := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes", cook, withPhotos("https://media.example.com/cook/step.jpg", "", "https://images.unsplash.com/p.jpg")))
	steps := saved["steps"].([]any)
	if steps[0].(map[string]any)["image"] != "https://media.example.com/cook/step.jpg" || steps[1].(map[string]any)["image"] != nil {
		t.Fatalf("step photos: %v", steps)
	}
	mustCall(t, f, 400, "POST", "/v1/recipes", cook, withPhotos("https://tracker.example.net/pixel.gif"))
	mustCall(t, f, 400, "POST", "/v1/recipes", cook, withPhotos("javascript:alert(1)"))
	// A step photo the recipe already has stays valid, wherever it moves.
	id := saved["id"].(string)
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{1,image}','"https://legacy.example.net/step.jpg"') WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, cook, withPhotos("", "https://legacy.example.net/step.jpg"))
	mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, cook, withPhotos("https://legacy.example.net/step.jpg", ""))
	mustCall(t, f, 400, "PUT", "/v1/recipes/"+id, cook, withPhotos("https://legacy.example.net/other.jpg"))
}
