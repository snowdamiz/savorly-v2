package app

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// A step's clip is held to the recipe video's rules: an HTTPS address (HTTP only on localhost)
// without credentials, refused with the same message; in production our storage or MEDIA_HOSTS,
// while a clip the recipe already has stays valid wherever it moves. Like the rest of a step, it
// is trimmed first.
func TestStepClipsFollowTheRecipeVideoRules(t *testing.T) {
	for video, ok := range map[string]bool{
		"":                                     true,
		" https://media.example.com/a.mp4 ":    true,
		"http://localhost:8333/media/a.mp4":    true,
		"javascript:alert(1)":                  false,
		"http://cook.example/a.mp4":            false,
		"https://user:pw@cook.example/a.mp4":   false,
		"/uploads/cook/a.mp4":                  false,
		"https:///no-host.mp4":                 false,
		"https://cook.example/a.mp4#t=1,2,3,4": true,
	} {
		step, recipe := validRecipe(), validRecipe()
		step.Steps[0].Video, recipe.Video = video, strings.TrimSpace(video)
		e, want := step.Validate(), recipe.Validate()
		if (e == nil) != ok || (want == nil) != ok {
			t.Errorf("clip %q: step %v, recipe video %v", video, e, want)
		} else if e != nil && e.Error() != want.Error() {
			t.Errorf("clip %q: step says %q, recipe video %q", video, e, want)
		} else if ok && step.Steps[0].Video != strings.TrimSpace(video) {
			t.Errorf("clip %q kept as %q", video, step.Steps[0].Video)
		}
	}

	t.Setenv("S3_PUBLIC_URL", "https://media.example.com")
	t.Setenv("MEDIA_HOSTS", "images.unsplash.com")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	f := recipesApp(db, true)
	cook := bearerFor(t, db, "cook")
	withClips := func(urls ...string) RecipeInput {
		r := validRecipe()
		r.Steps = nil
		for _, u := range urls {
			r.Steps = append(r.Steps, Step{Title: "Next", Text: "Do the next thing.", Video: u})
		}
		return r
	}
	saved := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes", cook, withClips("https://media.example.com/cook/fold.mp4", "", "https://images.unsplash.com/v.mp4")))
	steps := saved["steps"].([]any)
	if steps[0].(map[string]any)["video"] != "https://media.example.com/cook/fold.mp4" || steps[2].(map[string]any)["video"] != "https://images.unsplash.com/v.mp4" {
		t.Fatalf("step clips: %v", steps)
	}
	// Steps without a clip have no video key, as steps without a photo have no image key.
	if _, has := steps[1].(map[string]any)["video"]; has {
		t.Fatalf("a step without a clip: %v", steps[1])
	}
	// Someone else's server is refused just as it is for the recipe's own video.
	video := validRecipe()
	video.Video = "https://tracker.example.net/clip.mp4"
	clip := jsonObject(t, mustCall(t, f, 400, "POST", "/v1/recipes", cook, withClips("https://tracker.example.net/clip.mp4")))
	if own := jsonObject(t, mustCall(t, f, 400, "POST", "/v1/recipes", cook, video)); clip["error"] != own["error"] {
		t.Fatalf("a step clip is refused with %q, the recipe video with %q", clip["error"], own["error"])
	}
	mustCall(t, f, 400, "POST", "/v1/recipes", cook, withClips("javascript:alert(1)"))
	// A clip the recipe already has stays valid, wherever it moves.
	id := saved["id"].(string)
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{1,video}','"https://legacy.example.net/step.mp4"') WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, cook, withClips("", "https://legacy.example.net/step.mp4"))
	mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, cook, withClips("https://legacy.example.net/step.mp4", ""))
	mustCall(t, f, 400, "PUT", "/v1/recipes/"+id, cook, withClips("https://legacy.example.net/other.mp4"))
}

// Apps that don't know step clips, and the sous-chef, send steps without a video; saving the
// recipe must not drop the clips a newer app added. An explicit "" still removes one, and a
// step's photo and clip are kept or changed each on its own.
func TestEditsKeepStepClipsTheyDontMention(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	const slicePhoto, sliceClip, toastClip = "https://media.example.com/slice.jpg", "https://media.example.com/slice.mp4", "https://media.example.com/toast.mp4"
	publishRecipe(t, db, "cook", "toast", func(r *RecipeInput) {
		r.Steps = []Step{
			{Title: "Slice", Text: "Slice the bread thickly.", Image: slicePhoto, Video: sliceClip},
			{Title: "Toast", Text: "Toast until golden.", Video: toastClip},
		}
	})
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	save := func(steps ...map[string]any) map[string]any {
		t.Helper()
		r := validRecipe()
		body := map[string]any{"title": r.Title, "description": r.Description, "cuisine": r.Cuisine, "minutes": r.Minutes, "servings": r.Servings,
			"difficulty": r.Difficulty, "image": "", "video": "", "ingredients": r.Ingredients, "steps": steps, "tags": []string{}, "calories": 0, "published": true}
		return jsonObject(t, mustCall(t, f, 200, "PUT", "/v1/recipes/toast", cook, body))
	}
	media := func() [][2]string {
		t.Helper()
		var steps []Step
		if e := db.QueryRow(ctx, `SELECT steps FROM recipes WHERE id='toast'`).Scan(&steps); e != nil {
			t.Fatal(e)
		}
		out := [][2]string{}
		for _, s := range steps {
			out = append(out, [2]string{s.Image, s.Video})
		}
		return out
	}
	toast := map[string]any{"title": "Toast", "text": "Toast until golden.", "seconds": 0}
	slice := map[string]any{"title": "Slice", "text": "Slice the bread thickly.", "seconds": 0}
	with := func(step map[string]any, key, value string) map[string]any {
		out := map[string]any{key: value}
		for k, v := range step {
			out[k] = v
		}
		return out
	}

	// An older app: no image or video keys at all, and the steps swapped.
	save(toast, slice)
	if got := media(); !slices.Equal(got, [][2]string{{"", toastClip}, {slicePhoto, sliceClip}}) {
		t.Fatalf("clips didn't follow their steps: %v", got)
	}
	// An app that knows step photos but not clips removes a photo; the step keeps its clip.
	save(toast, with(slice, "image", ""))
	if got := media(); !slices.Equal(got, [][2]string{{"", toastClip}, {"", sliceClip}}) {
		t.Fatalf("removing a photo: %v", got)
	}
	// A newer app removes one clip and replaces the other.
	got := save(with(toast, "video", ""), with(slice, "video", "https://media.example.com/fold.mp4"))
	if media := media(); !slices.Equal(media, [][2]string{{"", ""}, {"", "https://media.example.com/fold.mp4"}}) {
		t.Fatalf("explicit removal and replacement: %v", media)
	}
	if _, has := got["steps"].([]any)[0].(map[string]any)["video"]; has {
		t.Fatalf("a removed clip is still in the answer: %v", got["steps"])
	}
}

func TestKeepStepMediaFollowsEachKindOnItsOwn(t *testing.T) {
	saved := []Step{{Title: "Boil", Text: "Boil water.", Image: "a.jpg", Video: "a.mp4"}, {Title: "Drain", Text: "Drain well.", Video: "b.mp4"}}
	steps := []Step{
		{Title: "Boil", Text: "Bring salted water to a boil.", imageSet: true}, // the photo was removed
		{Title: "Serve", Text: "Drain well."},                                  // retitled: same text
		{Title: "Plate", Text: "Plate it.", Video: "c.mp4", videoSet: true},
	}
	keepStepMedia(steps, saved)
	want := [][2]string{{"", "a.mp4"}, {"", "b.mp4"}, {"", "c.mp4"}}
	for i, s := range steps {
		if got := [2]string{s.Image, s.Video}; got != want[i] {
			t.Errorf("step %d: %v, want %v", i+1, got, want[i])
		}
	}
	// A step that names an empty clip has none, whatever the saved one had.
	steps = []Step{{Title: "Boil", Text: "Boil water.", videoSet: true}}
	if keepStepMedia(steps, saved); steps[0].Image != "a.jpg" || steps[0].Video != "" {
		t.Fatalf("%+v", steps[0])
	}
}

// The sous-chef's tools never name step media: an edit, or a revised draft, keeps the clips (and
// photos) of the steps it leaves in place, as an older app's edit does.
func TestSousChefEditsKeepStepClips(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	mine := exampleVoiceRecipe()
	mine.AIGenerated = false
	mine.Steps = []Step{
		{Title: "Toast", Text: "Toast the bread until golden.", Image: "https://media.example/toast.jpg", Video: "https://media.example/toast.mp4"},
		{Title: "Spread", Text: "Spread the ricotta over the toast.", Video: "https://media.example/spread.mp4"},
	}
	if e := persistRecipe(ctx, a.DB, "cook", "mine", mine, false); e != nil {
		t.Fatal(e)
	}
	media := func(id string) [][2]string {
		t.Helper()
		r, e := a.ownRecipe(ctx, "cook", id)
		if e != nil {
			t.Fatal(e)
		}
		out := [][2]string{}
		for _, s := range r.Steps {
			out = append(out, [2]string{s.Image, s.Video})
		}
		return out
	}
	// edit_recipe rewrites the second step under the same title and adds a third.
	out := a.agentTool(ctx, agentTurn(t, a, p), "edit_recipe", jsonBytes(map[string]any{"recipe_id": "mine", "changes": map[string]any{"steps": []map[string]any{
		{"title": "Toast", "text": "Toast the bread until golden.", "seconds": 0},
		{"title": "Spread", "text": "Spread the ricotta, then grate lemon zest over it.", "seconds": 0},
		{"title": "Serve", "text": "Serve straight away.", "seconds": 0},
	}}}))
	if !strings.Contains(out, "Saved") {
		t.Fatalf("edit_recipe: %s", out)
	}
	if got := media("mine"); !slices.Equal(got, [][2]string{{"https://media.example/toast.jpg", "https://media.example/toast.mp4"}, {"", "https://media.example/spread.mp4"}, {"", ""}}) {
		t.Fatalf("after edit_recipe: %v", got)
	}
	// Steps sent back as they are, without their media, aren't counted as rewritten.
	out = a.agentTool(ctx, agentTurn(t, a, p), "edit_recipe", jsonBytes(map[string]any{"recipe_id": "mine", "changes": map[string]any{"servings": 4, "steps": []map[string]any{
		{"title": "Toast", "text": "Toast the bread until golden.", "seconds": 0},
		{"title": "Spread", "text": "Spread the ricotta, then grate lemon zest over it.", "seconds": 0},
		{"title": "Serve", "text": "Serve straight away.", "seconds": 0},
	}}}))
	if !strings.Contains(out, "servings 2 → 4") || strings.Contains(out, "rewrites") {
		t.Fatalf("edit_recipe summary: %s", out)
	}
	if got := media("mine"); !slices.Equal(got, [][2]string{{"https://media.example/toast.jpg", "https://media.example/toast.mp4"}, {"", "https://media.example/spread.mp4"}, {"", ""}}) {
		t.Fatalf("after the second edit_recipe: %v", got)
	}

	// A draft made in the studio, given a clip in the editor, then revised by the sous-chef.
	state, e := a.studioState(ctx, p, 0)
	if e != nil {
		t.Fatal(e)
	}
	draft := exampleVoiceRecipe()
	if _, e = a.applyDraftAction(ctx, state, "build", &draft, false); e != nil {
		t.Fatal(e)
	}
	if state, e = a.studioState(ctx, p, 0); e != nil {
		t.Fatal(e)
	}
	if _, e = a.DB.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{0,video}','"https://media.example/draft.mp4"') WHERE id=$1`, state.RecipeID); e != nil {
		t.Fatal(e)
	}
	draft.Title = "Lemon toast for two"
	if _, e = a.applyDraftAction(ctx, state, "build", &draft, false); e != nil {
		t.Fatal(e)
	}
	if got := media(state.RecipeID); !slices.Equal(got, [][2]string{{"", "https://media.example/draft.mp4"}}) {
		t.Fatalf("after a revised draft: %v", got)
	}
}

// The janitor keeps a step's clip while a recipe shows it, and deletes it once none does.
func TestStepClipsLeaveStorageOnceUnused(t *testing.T) {
	m := newMediaFixture(t)
	testUser(t, m.db, "cook")
	fold, bake := m.upload("uploads/cook"), m.upload("uploads/cook")
	publishRecipe(t, m.db, "cook", "bread", func(r *RecipeInput) {
		r.Steps = []Step{{Title: "Fold", Text: "Fold the dough twice.", Video: fold}, {Title: "Bake", Text: "Bake until golden.", Video: bake}}
	})
	// Due for a check while a step still shows it, a clip stays and leaves the queue.
	m.exec(`INSERT INTO media_deletions(url,queued_at) VALUES($1,now())`, bake)
	if n := m.pass(); n != 0 || !m.stored(bake) || len(m.queued()) != 0 {
		t.Fatalf("deleted %d clips in use; queued %v", n, m.queued())
	}
	// Removing a clip from its step releases it.
	m.exec(`UPDATE recipes SET steps=jsonb_set(steps,'{0}',(steps->0)-'video') WHERE id='bread'`)
	if got := m.queued(); !slices.Equal(got, []string{fold}) {
		t.Fatalf("after removing a clip: %v", got)
	}
	if n := m.pass(); n != 1 || m.stored(fold) || !m.stored(bake) {
		t.Fatalf("deleted %d", n)
	}
	// So does deleting the recipe.
	m.exec(`DELETE FROM recipes WHERE id='bread'`)
	if n := m.pass(); n != 1 || m.stored(bake) {
		t.Fatalf("after deleting the recipe: %d deleted", n)
	}
}
