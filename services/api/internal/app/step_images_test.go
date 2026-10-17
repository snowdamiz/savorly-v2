package app

import (
	"context"
	"testing"
)

// Apps that don't know step photos, and the sous-chef, send steps without an image; saving the
// recipe must not drop the photos a newer app added. An explicit "" still removes one.
func TestEditsKeepStepPhotosTheyDontMention(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	publishRecipe(t, db, "cook", "toast", func(r *RecipeInput) {
		r.Steps = []Step{
			{Title: "Slice", Text: "Slice the bread thickly.", Image: "https://media.example.com/slice.jpg"},
			{Title: "Toast", Text: "Toast until golden.", Image: "https://media.example.com/toast.jpg"},
		}
	})
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	save := func(steps []map[string]any) {
		t.Helper()
		r := validRecipe()
		body := map[string]any{"title": r.Title, "description": r.Description, "cuisine": r.Cuisine, "minutes": r.Minutes, "servings": r.Servings,
			"difficulty": r.Difficulty, "image": "", "video": "", "ingredients": r.Ingredients, "steps": steps, "tags": []string{}, "calories": 0, "published": true}
		if status, b := callAPI(t, f, "PUT", "/v1/recipes/toast", cook, body); status != 200 {
			t.Fatalf("save: %d %s", status, b)
		}
	}
	images := func() []string {
		t.Helper()
		var steps []Step
		if e := db.QueryRow(ctx, `SELECT steps FROM recipes WHERE id='toast'`).Scan(&steps); e != nil {
			t.Fatal(e)
		}
		out := []string{}
		for _, s := range steps {
			out = append(out, s.Image)
		}
		return out
	}
	// An older app: no image keys at all, and the steps swapped.
	save([]map[string]any{
		{"title": "Toast", "text": "Toast until golden.", "seconds": 0},
		{"title": "Slice", "text": "Slice the bread thickly.", "seconds": 0},
	})
	if got := images(); got[0] != "https://media.example.com/toast.jpg" || got[1] != "https://media.example.com/slice.jpg" {
		t.Fatalf("photos didn't follow their steps: %v", got)
	}
	// A newer app removes one photo and leaves the other alone.
	save([]map[string]any{
		{"title": "Toast", "text": "Toast until golden.", "seconds": 0, "image": ""},
		{"title": "Slice", "text": "Slice the bread thickly.", "seconds": 0},
	})
	if got := images(); got[0] != "" || got[1] != "https://media.example.com/slice.jpg" {
		t.Fatalf("explicit removal: %v", got)
	}
}

func TestKeepStepImagesMatchesTextThenPlaceAndTitle(t *testing.T) {
	saved := []Step{{Title: "Boil", Text: "Boil water.", Image: "a.jpg"}, {Title: "Drain", Text: "Drain well.", Image: "b.jpg"}}
	steps := []Step{
		{Title: "Boil", Text: "Bring salted water to a boil."}, // reworded: same place and title
		{Title: "Serve", Text: "Drain well."},                  // retitled: same text
		{Title: "Plate", Text: "Plate it.", Image: "c.jpg", imageSet: true},
	}
	keepStepMedia(steps, saved)
	if steps[0].Image != "a.jpg" || steps[1].Image != "b.jpg" || steps[2].Image != "c.jpg" {
		t.Fatalf("%+v", steps)
	}
}
