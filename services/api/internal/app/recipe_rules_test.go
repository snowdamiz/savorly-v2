package app

import (
	"math"
	"reflect"
	"testing"
)

func TestNormalizeCuisine(t *testing.T) {
	for in, want := range map[string]string{
		"italian": "Italian", " ITALIAN ": "Italian", "middle   eastern": "Middle Eastern", "Other": "Other",
		"tex-mex": "Tex-Mex", "  new england ": "New England", "SOUTHERN": "Southern", "crème": "Crème",
	} {
		if got := normalizeCuisine(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestRecipeValidationTidiesInput(t *testing.T) {
	r := validRecipe()
	r.Cuisine = " italian "
	r.Tags = []string{" Vegan ", "", "vegan", "Quick & easy", "  "}
	r.Ingredients = []Ingredient{{Name: "  Pasta ", Amount: 200, Unit: " g ", Category: " Pantry "}}
	r.Steps = []Step{{Title: " Cook ", Text: "  Cook the pasta until tender.  "}}
	r.Language = " pt-BR "
	if e := r.Validate(); e != nil {
		t.Fatal(e)
	}
	if r.Cuisine != "Italian" || !reflect.DeepEqual(r.Tags, []string{"Vegan", "Quick & easy"}) || r.Language != "pt" {
		t.Fatalf("cuisine %q tags %q language %q", r.Cuisine, r.Tags, r.Language)
	}
	if i := r.Ingredients[0]; i.Name != "Pasta" || i.Unit != "g" || i.Category != "Pantry" {
		t.Fatalf("ingredient not trimmed: %+v", i)
	}
	if s := r.Steps[0]; s.Title != "Cook" || s.Text != "Cook the pasta until tender." {
		t.Fatalf("step not trimmed: %+v", s)
	}
	for _, bad := range []func(*RecipeInput){
		func(r *RecipeInput) { r.Language = "klingon" },
		func(r *RecipeInput) { r.Cuisine = "  x " },
		func(r *RecipeInput) { r.Steps[0].Title = "   " },
		func(r *RecipeInput) { r.Ingredients[0].Name = " " },
	} {
		r := validRecipe()
		bad(&r)
		if r.Validate() == nil {
			t.Errorf("accepted %+v", r)
		}
	}
	r = validRecipe()
	if e := r.Validate(); e != nil || r.Language != "" || r.Tags != nil {
		t.Fatalf("an older client's recipe changed: %v %q %v", e, r.Language, r.Tags)
	}
}

func TestGroceryQuantities(t *testing.T) {
	for _, tc := range []struct {
		amount float64
		unit   string
		want   string
	}{
		{1. / 3, "cup", "⅓ cup"}, {0.3333333333333333, "g", "0.33 g"}, {1.5, "tbsp", "1½ tbsp"},
		{2.6666666, "cups", "2⅔ cups"}, {0.25, "tsp", "¼ tsp"}, {0.125, "tsp", "0.12 tsp"},
		{1500, "g", "1500 g"}, {1e7, "g", "10000000 g"}, {3, "", "3"}, {0, "pinch", "pinch"},
		{0, "", ""}, {0.001, "g", "0.01 g"}, {2.999, "cup", "3 cup"}, {0.75, "g", "0.75 g"},
	} {
		if got := formatQuantity(tc.amount, tc.unit); got != tc.want {
			t.Errorf("%v %q: %q, want %q", tc.amount, tc.unit, got, tc.want)
		}
	}
	for _, tc := range []struct {
		in     string
		amount float64
		unit   string
		ok     bool
	}{
		{"1½ cup", 1.5, "cup", true}, {"1 ½ cups", 1.5, "cups", true}, {"⅓ cup", 1. / 3, "cup", true},
		{"1/2 tsp", 0.5, "tsp", true}, {"1 1/2 tbsp", 1.5, "tbsp", true}, {"0,5 kg", 0.5, "kg", true},
		{"2", 2, "", true}, {"1.5kg", 1.5, "kg", true}, {"pinch", 0, "pinch", false},
		{"", 0, "", false}, {"2-3 cloves", 0, "2-3 cloves", false}, {"1/0 cup", 0, "1/0 cup", false},
	} {
		amount, unit, ok := parseQuantity(tc.in)
		if ok != tc.ok || unit != tc.unit || math.Abs(amount-tc.amount) > 1e-9 {
			t.Errorf("%q: %v %q %v", tc.in, amount, unit, ok)
		}
	}
	if normalizeUnit("Tablespoons") != "tbsp" || normalizeUnit("T") != "tbsp" || normalizeUnit("t") != "tsp" || normalizeUnit("Cups") != "cup" {
		t.Fatal("unit aliases")
	}
}

func TestRecipeLanguageCodes(t *testing.T) {
	for in, want := range map[string]string{"": "", "EN": "en", "zh-Hans": "zh", "ja_JP": "ja", " fr ": "fr"} {
		if got, ok := recipeLanguage(in); !ok || got != want {
			t.Errorf("%q: %q %v", in, got, ok)
		}
	}
	for _, in := range []string{"english", "xx", "-en", "nl"} {
		if _, ok := recipeLanguage(in); ok {
			t.Errorf("accepted %q", in)
		}
	}
}
