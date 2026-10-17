package app

import (
	"context"
	"testing"
)

func TestMediaHostsInProduction(t *testing.T) {
	t.Setenv("MEDIA_HOSTS", "images.unsplash.com, Cdn.Example.org")
	store := &MediaStore{BaseURL: "https://media.savorly.cooking"}
	dev := &App{Media: store}
	prod := &App{Config: Config{Production: true}, Media: store}
	for url, want := range map[string]bool{
		"": true,
		"https://media.savorly.cooking/cook/a.jpg":         true,
		"https://media.savorly.cooking/uploads/cook/a.jpg": true,
		"https://media.savorly.cooking.evil.example/a.jpg": false,
		"https://media.savorly.cooking/cook/../../x.jpg":   false,
		"https://images.unsplash.com/photo-1?w=1200":       true,
		"https://cdn.example.org/a.png":                    true,
		"https://images.unsplash.com:8443/a.jpg":           false,
		"http://images.unsplash.com/a.jpg":                 false,
		"https://tracker.example.net/pixel.gif":            false,
		"https://lh3.googleusercontent.com/a/x=s512-c":     false,
		"https://user:pass@images.unsplash.com/a.jpg":      false,
		"javascript:alert(1)":                              false,
	} {
		if got := prod.allowedMedia(url); got != want {
			t.Errorf("production %q: %v", url, got)
		}
		if got := dev.allowedMedia(url); got != validMedia(url) {
			t.Errorf("development %q: %v", url, got)
		}
	}
	if !prod.validAvatar("https://lh3.googleusercontent.com/a/x=s512-c") || prod.validAvatar("https://tracker.example.net/me.jpg") || !prod.validAvatar("https://media.savorly.cooking/cook/me.jpg") {
		t.Fatal("avatar hosts")
	}
	// Without a media store the public URL still comes from the environment.
	t.Setenv("S3_PUBLIC_URL", "https://media.savorly.cooking/")
	if !(&App{Config: Config{Production: true}}).allowedMedia("https://media.savorly.cooking/cook/a.jpg") {
		t.Fatal("S3_PUBLIC_URL without a store")
	}
}

func TestProductionRecipesKeepTheirOwnOutsideMedia(t *testing.T) {
	t.Setenv("S3_PUBLIC_URL", "https://media.example.com")
	t.Setenv("MEDIA_HOSTS", "images.unsplash.com")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "other")
	publishRecipe(t, db, "cook", "legacy", func(r *RecipeInput) {
		r.Image, r.Photos, r.Video = "https://legacy.example.net/cover.jpg", []string{"https://legacy.example.net/2.jpg"}, "https://legacy.example.net/clip.mp4"
	})
	f := recipesApp(db, true)
	cook := bearerFor(t, db, "cook")
	write := func(method, path string, change func(*RecipeInput)) int {
		t.Helper()
		r := validRecipe()
		r.Image, r.Photos, r.Video, r.Published = "https://legacy.example.net/cover.jpg", []string{"https://legacy.example.net/2.jpg"}, "https://legacy.example.net/clip.mp4", true
		change(&r)
		status, b := callAPI(t, f, method, path, cook, r)
		if status >= 500 {
			t.Fatalf("%s %s: %d %s", method, path, status, b)
		}
		return status
	}
	for _, tc := range []struct {
		name, method, path string
		change             func(*RecipeInput)
		status             int
	}{
		{"unchanged", "PUT", "/v1/recipes/legacy", func(r *RecipeInput) {}, 200},
		{"cover and photo swapped", "PUT", "/v1/recipes/legacy", func(r *RecipeInput) { r.Image, r.Photos = r.Photos[0], []string{r.Image} }, 200},
		{"our storage", "PUT", "/v1/recipes/legacy", func(r *RecipeInput) { r.Image = "https://media.example.com/cook/new.jpg" }, 200},
		{"a listed host", "PUT", "/v1/recipes/legacy", func(r *RecipeInput) { r.Photos = []string{"https://images.unsplash.com/p.jpg"} }, 200},
		{"a new outside cover", "PUT", "/v1/recipes/legacy", func(r *RecipeInput) { r.Image = "https://tracker.example.net/pixel.gif" }, 400},
		{"a new outside video", "PUT", "/v1/recipes/legacy", func(r *RecipeInput) { r.Video = "https://legacy.example.net/other.mp4" }, 400},
		{"a new recipe with outside media", "POST", "/v1/recipes", func(r *RecipeInput) {}, 400},
		{"a new recipe with ours", "POST", "/v1/recipes", func(r *RecipeInput) { r.Image, r.Photos, r.Video = "https://media.example.com/cook/a.jpg", nil, "" }, 201},
	} {
		// Each case starts from the recipe's original outside media.
		if _, err := db.Exec(ctx, `UPDATE recipes SET image='https://legacy.example.net/cover.jpg',photos='["https://legacy.example.net/2.jpg"]',video='https://legacy.example.net/clip.mp4' WHERE id='legacy'`); err != nil {
			t.Fatal(err)
		}
		if got := write(tc.method, tc.path, tc.change); got != tc.status {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.status)
		}
	}
	// Another cook can't borrow a recipe's outside media by naming its id.
	other := bearerFor(t, db, "other")
	r := validRecipe()
	r.Image = "https://legacy.example.net/cover.jpg"
	if status, _ := callAPI(t, f, "PUT", "/v1/recipes/legacy", other, r); status != 400 {
		t.Fatalf("other cook: %d", status)
	}
}

// Profile photos follow the same rule in production: a new one must be Savorly's (or Google's),
// while a photo the cook already has keeps working when they edit the rest of their profile.
func TestProductionProfilePhotosKeepTheirOwnOutsidePhoto(t *testing.T) {
	t.Setenv("S3_PUBLIC_URL", "https://media.example.com")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	if _, e := db.Exec(ctx, `UPDATE users SET avatar='https://legacy.example.net/me.jpg' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	f := recipesApp(db, true)
	cook := bearerFor(t, db, "cook")
	profile := func(avatar string) int {
		t.Helper()
		status, b := callAPI(t, f, "PATCH", "/v1/me", cook, map[string]any{"name": "Test cook", "bio": "", "avatar": avatar, "preferences": map[string]any{"diets": []string{}, "allergies": []string{}}})
		if status >= 500 {
			t.Fatalf("PATCH /me: %d %s", status, b)
		}
		return status
	}
	for _, tc := range []struct {
		avatar string
		status int
	}{
		{"https://legacy.example.net/me.jpg", 200},
		{"https://tracker.example.net/pixel.gif", 400},
		{"https://media.example.com/cook/me.jpg", 200},
		{"https://lh3.googleusercontent.com/a/x=s512-c", 200},
		{"", 200},
	} {
		if got := profile(tc.avatar); got != tc.status {
			t.Errorf("avatar %q: %d, want %d", tc.avatar, got, tc.status)
		}
	}
}
