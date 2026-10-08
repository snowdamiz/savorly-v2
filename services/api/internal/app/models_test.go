package app

import (
	"net"
	"strings"
	"testing"
)

func validRecipe() RecipeInput {
	return RecipeInput{Title: "Lemon pasta", Description: "A bright bowl of pasta with fresh lemon.", Cuisine: "Italian", Minutes: 20, Servings: 2, Difficulty: "Easy", Ingredients: []Ingredient{{Name: "Pasta", Amount: 200, Unit: "g"}}, Steps: []Step{{Title: "Cook", Text: "Cook pasta according to package."}}}
}
func TestRecipeValidation(t *testing.T) {
	tests := []struct {
		name   string
		modify func(*RecipeInput)
		valid  bool
	}{
		{"valid", func(r *RecipeInput) {}, true},
		{"blank title", func(r *RecipeInput) { r.Title = "  " }, false},
		{"bad serving", func(r *RecipeInput) { r.Servings = 0 }, false},
		{"missing ingredients", func(r *RecipeInput) { r.Ingredients = nil }, false},
		{"bad amount", func(r *RecipeInput) { r.Ingredients[0].Amount = -1 }, false},
		{"script media", func(r *RecipeInput) { r.Image = "javascript:alert(1)" }, false},
		{"https media", func(r *RecipeInput) { r.Image = "https://images.example.com/recipe.jpg" }, true},
		{"credentials in media", func(r *RecipeInput) { r.Image = "https://user:secret@example.com/recipe.jpg" }, false},
		{"local development media", func(r *RecipeInput) { r.Image = "http://localhost:8333/savorly-media/1.jpg" }, true},
		{"unbounded timer", func(r *RecipeInput) { r.Steps[0].Seconds = 90000 }, false},
		{"oversized tag", func(r *RecipeInput) { r.Tags = []string{strings.Repeat("a", 41)} }, false},
		{"gallery photos", func(r *RecipeInput) { r.Photos = []string{"https://images.example.com/2.jpg"} }, true},
		{"script gallery photo", func(r *RecipeInput) { r.Photos = []string{"javascript:alert(1)"} }, false},
		{"blank gallery photo", func(r *RecipeInput) { r.Photos = []string{""} }, false},
		{"oversized gallery", func(r *RecipeInput) { r.Photos = make([]string, 9) }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := validRecipe()
			tt.modify(&r)
			if e := r.Validate(); (e == nil) != tt.valid {
				t.Fatalf("valid=%v error=%v", tt.valid, e)
			}
		})
	}
}
func TestMediaRejectsActiveContent(t *testing.T) {
	for _, v := range []string{"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "<!doctype html><script>alert(1)</script>", "not an image"} {
		_, ext := mediaType([]byte(v))
		if ext != "" {
			t.Fatal("accepted active or invalid media")
		}
	}
}
func TestSessionTokensAreHashed(t *testing.T) {
	a := hashToken("first-session")
	if len(a) != 64 || a == "first-session" || a == hashToken("other-session") {
		t.Fatal("invalid session hashing")
	}
}

func TestMediaImportBlocksNonpublicAddresses(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "fc00::1", "192.0.2.1"} {
		if publicIP(net.ParseIP(s)) {
			t.Errorf("accepted %s", s)
		}
	}
	if !publicIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("rejected public IP")
	}
}
