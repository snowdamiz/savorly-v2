package app

import (
	"slices"
	"strings"
	"testing"
)

func TestFoodLexiconLoadsCleanly(t *testing.T) {
	for _, p := range foodLexiconProblems {
		t.Error(p)
	}
	if len(foodEntries) < 200 || len(foodAliases) < 1500 || len(avoidAliases) < 100 {
		t.Fatalf("lexicon looks short: %d entries, %d aliases, %d allergy words", len(foodEntries), len(foodAliases), len(avoidAliases))
	}
	for _, d := range dietGroups {
		for _, g := range d {
			if !slices.Contains(foodGroups, g) {
				t.Errorf("diet group %q is not a food group", g)
			}
		}
	}
	for k := range staples {
		if foodEntries[k] == nil {
			t.Errorf("staple %q is not a key", k)
		}
	}
}

func TestIndexIngredient(t *testing.T) {
	for _, c := range []struct {
		name, language, key string
		allergens           []string
	}{
		// Plain names, with the amounts, notes and state words cooks write.
		{"2 large eggs, beaten", "en", "egg", []string{"egg"}},
		{"Unsalted butter (softened)", "en", "butter", []string{"milk"}},
		{"Freshly grated Parmesan", "en", "parmesan", []string{"milk"}},
		{"1 cup all-purpose flour", "en", "flour", []string{"gluten"}},
		{"Extra-virgin olive oil", "en", "olive oil", []string{}},
		{"3 garlic cloves, minced", "en", "garlic", []string{}},
		{"Cherry tomatoes", "en", "cherry tomato", []string{}},
		{"Shrimp, peeled and deveined", "en", "shrimp", []string{"shellfish"}},
		// Compounds that would read wrong word by word.
		{"Peanut butter", "en", "peanut butter", []string{"peanut"}},
		{"Butternut squash", "en", "pumpkin", []string{}},
		{"Eggplant", "en", "eggplant", []string{}},
		{"Ground nutmeg", "en", "nutmeg", []string{}},
		{"Coconut milk", "en", "coconut milk", []string{}},
		{"Almond milk", "en", "almond milk", []string{"treenut"}},
		{"Soy sauce", "en", "soy sauce", []string{"gluten", "soy"}},
		{"Low-sodium chicken broth", "en", "chicken stock", []string{"poultry"}},
		{"Vegetable stock", "en", "vegetable stock", []string{"celery"}},
		{"Oyster mushrooms", "en", "mushroom", []string{}},
		{"Oyster sauce", "en", "oyster sauce", []string{"mollusc"}},
		{"Basil pesto", "en", "pesto", []string{"milk", "treenut"}},
		{"Red wine vinegar", "en", "wine vinegar", []string{"sulphite"}},
		{"Dry white wine", "en", "wine", []string{"sulphite", "alcohol"}},
		{"Mayonnaise", "en", "mayonnaise", []string{"egg"}},
		{"Thai red curry paste", "en", "curry paste", []string{"shellfish"}},
		// What a name says it is without.
		{"Gluten-free flour", "en", "flour", []string{}},
		{"Dairy-free milk", "en", "milk", []string{}},
		{"Vegan butter", "en", "butter", []string{}},
		{"Non-alcoholic beer", "en", "beer", []string{"gluten"}},
		{"Mantequilla sin sal", "es", "butter", []string{"milk"}},
		{"Glutenfreies Mehl", "de", "flour", []string{}},
		// The other eight languages.
		{"200 g de farine", "fr", "flour", []string{"gluten"}},
		{"Crème fraîche", "fr", "cream", []string{"milk"}},
		{"Noix de muscade", "fr", "nutmeg", []string{}},
		{"Noix de cajou", "fr", "cashew", []string{"treenut"}},
		{"Huile d'olive", "fr", "olive oil", []string{}},
		{"Lait de coco", "fr", "coconut milk", []string{}},
		{"Lardons fumés", "fr", "bacon", []string{"pork"}},
		{"Vollmilch", "de", "milk", []string{"milk"}},
		{"Mandelblättchen", "de", "almond", []string{"treenut"}},
		{"Rinderhackfleisch", "de", "beef", []string{"meat"}},
		{"Hähnchenbrustfilet", "de", "chicken", []string{"poultry"}},
		{"Eierlikör", "de", "liqueur", []string{"egg", "alcohol"}},
		{"Kokosmilch", "de", "coconut milk", []string{}},
		{"Aceite de oliva", "es", "olive oil", []string{}},
		{"Leche de coco", "es", "coconut milk", []string{}},
		{"Pechuga de pollo", "es", "chicken", []string{"poultry"}},
		{"Nuez moscada", "es", "nutmeg", []string{}},
		{"Harina de trigo", "es", "flour", []string{"gluten"}},
		{"Gamberetti sgusciati", "it", "shrimp", []string{"shellfish"}},
		{"Burro di arachidi", "it", "peanut butter", []string{"peanut"}},
		{"Spaghetti", "it", "pasta", []string{"gluten"}},
		{"Leite de coco", "pt", "coconut milk", []string{}},
		{"Peito de frango", "pt", "chicken", []string{"poultry"}},
		{"Сливочное масло", "ru", "butter", []string{"milk"}},
		{"Мускатный орех", "ru", "nutmeg", []string{}},
		{"Куриное филе", "ru", "chicken", []string{"poultry"}},
		{"3 яйца", "ru", "egg", []string{"egg"}},
		{"Соевый соус", "ru", "soy sauce", []string{"gluten", "soy"}},
		{"鸡蛋2个", "zh", "egg", []string{"egg"}},
		{"酱油", "zh", "soy sauce", []string{"gluten", "soy"}},
		{"肉桂粉", "zh", "cinnamon", []string{}},
		{"椰奶", "zh", "coconut milk", []string{}},
		{"牛油果", "zh", "avocado", []string{}},
		{"花生酱", "zh", "peanut butter", []string{"peanut"}},
		{"鶏むね肉", "ja", "chicken", []string{"poultry"}},
		{"ピーナッツバター", "ja", "peanut butter", []string{"peanut"}},
		{"ココナッツミルク", "ja", "coconut milk", []string{}},
		{"ラム酒", "ja", "rum", []string{"alcohol"}},
		{"薄力粉", "ja", "flour", []string{"gluten"}},
		// Unknown names keep their own words.
		{"Gochujang", "en", "gochujang", []string{}},
	} {
		got := indexIngredient(c.name, c.language)
		if got.Key != c.key {
			t.Errorf("%q: key %q, want %q", c.name, got.Key, c.key)
		}
		want := slices.Clone(c.allergens)
		slices.Sort(want)
		have := slices.Clone(got.Allergens)
		slices.Sort(have)
		if !slices.Equal(have, want) {
			t.Errorf("%q: allergens %v, want %v", c.name, got.Allergens, c.allergens)
		}
	}
}

func TestIndexIngredientTerms(t *testing.T) {
	f := indexIngredient("Fresh cilantro leaves", "en")
	for _, want := range []string{"cilantro", "cilantro leave", "leave"} {
		if !slices.Contains(f.Terms, want) {
			t.Errorf("terms %v lack %q", f.Terms, want)
		}
	}
	// What a thing is made from is avoided with it, whatever the language says.
	f = indexIngredient("Bouillon de poulet", "fr")
	if !slices.Contains(f.Terms, "chicken") || !slices.Contains(f.Terms, "stock") {
		t.Errorf("chicken stock terms %v lack chicken and stock", f.Terms)
	}
	r := indexRecipe([]Ingredient{{Name: "Spaghetti"}, {Name: "Eggs"}, {Name: "Pecorino"}, {Name: "Guanciale"}, {Name: "Black pepper"}}, "it")
	if !slices.Equal(r.Keys, []string{"pasta", "egg", "pecorino", "pancetta", "pepper"}) {
		t.Errorf("carbonara keys %v", r.Keys)
	}
	if !slices.Equal(r.Allergens, []string{"milk", "egg", "gluten", "pork"}) {
		t.Errorf("carbonara allergens %v", r.Allergens)
	}
	if len(r.Ingredients) != 5 {
		t.Fatalf("facts for %d ingredients, want 5", len(r.Ingredients))
	}
}

func TestPantryCovers(t *testing.T) {
	for _, c := range []struct {
		pantry, recipe string
		covered        bool
	}{
		{"Cheddar", "Grated cheese", true},
		{"Cheese", "Cheddar", false},
		{"Eggs", "1 egg yolk", false},
		{"Red onions", "Onion, diced", true},
		{"Onion", "Red onion", false},
		{"Chicken stock", "Stock", true},
		{"Stock", "Chicken stock", false},
		{"Tomatoes", "Tomates", true},
		{"Zitronen", "Lemon juice", true},
		{"Gochujang", "gochujang", true},
		{"Milk", "Coconut milk", false},
	} {
		key := indexIngredient(c.recipe, "").Key
		if got := slices.Contains(pantryCovers(c.pantry, ""), key); got != c.covered {
			t.Errorf("pantry %q covers recipe %q (%s): %v, want %v", c.pantry, c.recipe, key, got, c.covered)
		}
	}
}

func TestAvoidFor(t *testing.T) {
	v := avoidFor([]string{"Vegetarian", "Gluten free", "High protein"}, []string{"Peanuts", "shellfish", "Cilantro", "kiwi", "Allergic to sesame", "花生过敏", "lactose intolerance", "Nuts"})
	for _, g := range []string{"meat", "pork", "poultry", "fish", "shellfish", "mollusc", "gelatin", "gluten", "peanut", "sesame", "milk", "treenut"} {
		if len(v.Groups[g]) == 0 {
			t.Errorf("groups %v lack %q", v.groupList(), g)
		}
	}
	if !slices.Equal(v.Groups["peanut"], []string{"Peanuts", "花生过敏", "Nuts"}) {
		t.Errorf("peanut comes from %v", v.Groups["peanut"])
	}
	if !slices.Equal(v.termList(), []string{"cilantro", "kiwi"}) {
		t.Errorf("terms %v, want cilantro and kiwi", v.termList())
	}
	if len(v.Groups["egg"]) != 0 || len(v.Groups["honey"]) != 0 {
		t.Errorf("a vegetarian isn't avoiding eggs or honey: %v", v.Groups)
	}
	if got := avoidFor([]string{"vegan"}, nil); len(got.Groups["honey"]) == 0 || len(got.Groups["milk"]) == 0 {
		t.Errorf("vegan groups %v", got.groupList())
	}
	// Someone avoiding cilantro avoids coriander and 香菜 too, which share its key.
	f := indexIngredient("香菜", "zh")
	if !slices.Contains(f.Terms, "cilantro") {
		t.Errorf("香菜 terms %v lack cilantro", f.Terms)
	}
	if empty := avoidFor(nil, []string{" ", ""}); len(empty.Groups)+len(empty.Terms) != 0 {
		t.Errorf("blank allergies avoid %v", empty)
	}
}

func TestFoldFood(t *testing.T) {
	for in, want := range map[string]string{"Crème Fraîche": "creme fraiche", "Ёлка": "елка", "Weißwein": "weisswein", "œuf": "oeuf", "ガーリック": "ガーリック", "Jalapeño": "jalapeno"} {
		if got := foldFood(in); got != want {
			t.Errorf("foldFood(%q) = %q, want %q", in, got, want)
		}
	}
	if got := strings.Join(cleanFoodName("2 tbsp. finely chopped fresh parsley (or cilantro)").words, " "); got != "parsley" {
		t.Errorf("cleaned to %q", got)
	}
}
