package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestInstacartLines(t *testing.T) {
	for _, c := range []struct {
		name, quantity, display string
		measure                 []instacartMeasure
	}{
		{"Flour", "2 cups", "Flour (2 cups)", []instacartMeasure{{2, "cup"}}},
		{"Butter", "1½ tbsp", "Butter (1½ tbsp)", []instacartMeasure{{1.5, "tablespoon"}}},
		{"Eggs", "3", "Eggs (3)", []instacartMeasure{{3, "each"}}},
		{"Rice", "0,5 kg", "Rice (0,5 kg)", []instacartMeasure{{0.5, "kilogram"}}},
		// A unit Instacart doesn't count in, or no amount: one of the product.
		{"Garlic", "2 cloves", "Garlic (2 cloves)", nil},
		{"Salt", "pinch", "", nil},
		{"Basil", "", "", nil},
	} {
		got := instacartLine(c.name, c.quantity)
		if got.Name != c.name || got.DisplayText != c.display || len(got.Measurements) != len(c.measure) {
			t.Errorf("%s %q: %+v", c.name, c.quantity, got)
			continue
		}
		for i := range c.measure {
			if got.Measurements[i] != c.measure[i] {
				t.Errorf("%s %q: measurement %+v, want %+v", c.name, c.quantity, got.Measurements[i], c.measure[i])
			}
		}
	}
}

// fakeInstacart answers products_link like Instacart and keeps what it was sent.
type fakeInstacart struct {
	mu     sync.Mutex
	pages  []instacartPage
	status int
}

func newFakeInstacart(t *testing.T) *fakeInstacart {
	t.Helper()
	f := &fakeInstacart{status: 200}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/idp/v1/products/products_link" || r.Header.Get("Authorization") != "Bearer test-instacart-key" {
			http.Error(w, "unexpected", 400)
			return
		}
		var page instacartPage
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &page)
		f.mu.Lock()
		f.pages = append(f.pages, page)
		status := f.status
		f.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"products_link_url":"https://customers.instacart.com/store/shopping_lists/123"}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("INSTACART_API_KEY", "test-instacart-key")
	t.Setenv("INSTACART_API_URL", server.URL)
	return f
}

func TestOrderingTheListAndARecipe(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	publishRecipe(t, db, "cook", "omelette", func(r *RecipeInput) {
		r.Title = "Omelette"
		r.Image = "https://images.example.com/omelette.jpg"
		r.Servings = 2
		r.Ingredients = []Ingredient{{Name: "Eggs", Amount: 4}, {Name: "Grated cheese", Amount: 40, Unit: "g"}, {Name: "Salt"}}
	})
	f := recipesApp(db, false)
	ana, ben := bearerFor(t, db, "ana"), bearerFor(t, db, "ben")

	// Not configured: no route to order with, and the capability says so.
	mustCall(t, f, 404, "POST", "/v1/groceries/checkout", ana, nil)
	if got := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/capabilities", "", nil))["groceryCheckout"]; got != "" {
		t.Fatalf("capability without a key: %v", got)
	}
	fake := newFakeInstacart(t)
	f = recipesApp(db, false)
	if got := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/capabilities", "", nil))["groceryCheckout"]; got != "instacart" {
		t.Fatalf("capability with a key: %v", got)
	}

	// The list: what's left to buy, for the whole household.
	mustCall(t, f, 400, "POST", "/v1/groceries/checkout", ana, nil)
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	mustCall(t, f, 201, "POST", "/v1/groceries", ana, fiber.Map{"name": "Milk", "quantity": "1 l"})
	mustCall(t, f, 201, "POST", "/v1/groceries", ben, fiber.Map{"name": "Bread"})
	mustCall(t, f, 201, "POST", "/v1/groceries", ben, fiber.Map{"name": "Tea"})
	tea := findGrocery(t, groceriesOf(t, f, ana), "Tea").ID
	mustCall(t, f, 204, "PATCH", "/v1/groceries/"+tea, ana, fiber.Map{"checked": true})
	out := jsonObject(t, mustCall(t, f, 200, "POST", "/v1/groceries/checkout", ben, nil))
	if out["url"] != "https://customers.instacart.com/store/shopping_lists/123" || out["items"] != float64(2) {
		t.Fatalf("checkout answer %v", out)
	}
	list := fake.pages[0]
	if list.LinkType != "shopping_list" || len(list.LineItems) != 2 || list.Landing == nil || list.Landing.LinkbackURL == "" {
		t.Fatalf("list page %+v", list)
	}
	names := map[string]bool{}
	for _, item := range list.LineItems {
		names[item.Name] = true
	}
	if !names["Milk"] || !names["Bread"] || names["Tea"] {
		t.Fatalf("list lines %+v", list.LineItems)
	}

	// A recipe, scaled, without what the pantry has, with its photo and a way back.
	mustCall(t, f, 201, "POST", "/v1/pantry", ana, fiber.Map{"name": "Cheddar"})
	mustCall(t, f, 200, "POST", "/v1/recipes/omelette/checkout", ana, fiber.Map{"servings": 4, "skipPantry": true})
	page := fake.pages[1]
	if page.LinkType != "recipe" || page.Title != "Omelette" || page.ImageURL == "" || !page.Landing.PantryItems || len(page.LineItems) != 1 {
		t.Fatalf("recipe page %+v", page)
	}
	if eggs := page.LineItems[0]; eggs.Name != "Eggs" || len(eggs.Measurements) != 1 || eggs.Measurements[0] != (instacartMeasure{8, "each"}) {
		t.Fatalf("eggs %+v", eggs)
	}
	mustCall(t, f, 404, "POST", "/v1/recipes/missing/checkout", ana, fiber.Map{"servings": 2})

	// Instacart failing is a sentence the app can show.
	fake.status = 500
	body := mustCall(t, f, 502, "POST", "/v1/groceries/checkout", ana, nil)
	if msg := jsonObject(t, body)["error"]; msg != "We couldn't reach Instacart. Try again in a moment, or share the list instead." {
		t.Fatalf("failure %v", msg)
	}
}
