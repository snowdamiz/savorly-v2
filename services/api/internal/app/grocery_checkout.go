package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
)

// Grocery checkout hands the member's grocery list, or a recipe's ingredients, to Instacart: its
// page matches each line to products at a store the member picks, and the order happens there,
// so Savorly never sees it or any payment. It needs an Instacart Developer Platform key
// (INSTACART_API_KEY); commissions, when the partner account has an affiliate set up, come
// through Instacart's own link. Without a key the routes answer 404, the capability is off, and
// the app offers to share the list as text, which works with any store's app.

// instacartTimeout bounds one call to Instacart.
const instacartTimeout = 15 * time.Second

// instacartLines is the most lines one page carries; a list longer than that is cut, in order.
const instacartLines = 200

const checkoutUnavailable = "Ordering groceries isn't available right now. You can share the list instead."

type instacartClient struct {
	url, key string
	http     *http.Client
}

// instacart is the configured client, or nil. INSTACART_API_URL points elsewhere for Instacart's
// development host (https://connect.dev.instacart.tools) and for tests.
func instacart() *instacartClient {
	key := strings.TrimSpace(os.Getenv("INSTACART_API_KEY"))
	if key == "" {
		return nil
	}
	return &instacartClient{url: strings.TrimRight(Env("INSTACART_API_URL", "https://connect.instacart.com"), "/"), key: key, http: &http.Client{Timeout: instacartTimeout}}
}

func groceryCheckoutProvider() string {
	if instacart() != nil {
		return "instacart"
	}
	return ""
}

// instacartPage is the body of Instacart's "create shopping list page" request.
type instacartPage struct {
	Title        string            `json:"title"`
	ImageURL     string            `json:"image_url,omitempty"`
	LinkType     string            `json:"link_type"`
	Instructions []string          `json:"instructions,omitempty"`
	LineItems    []instacartItem   `json:"line_items"`
	Landing      *instacartLanding `json:"landing_page_configuration,omitempty"`
}

type instacartItem struct {
	Name         string             `json:"name"`
	DisplayText  string             `json:"display_text,omitempty"`
	Measurements []instacartMeasure `json:"line_item_measurements,omitempty"`
}

type instacartMeasure struct {
	Quantity float64 `json:"quantity"`
	Unit     string  `json:"unit"`
}

type instacartLanding struct {
	LinkbackURL string `json:"partner_linkback_url,omitempty"`
	PantryItems bool   `json:"enable_pantry_items,omitempty"`
}

// instacartUnits are the units Instacart matches quantities in, by the units the grocery list
// writes (normalizeUnit). Other units (a clove, a pinch, a sprig) send no measurement, and the
// page offers one of the product, which is what a shopper buys for them.
var instacartUnits = map[string]string{
	"cup": "cup", "tbsp": "tablespoon", "tsp": "teaspoon", "g": "gram", "kg": "kilogram",
	"ml": "milliliter", "l": "liter", "oz": "ounce", "lb": "pound", "can": "can",
	"bunch": "bunch", "piece": "each", "each": "each", "head": "head", "package": "package",
	"packet": "packet", "pint": "pint", "quart": "quart", "gallon": "gallon",
}

// instacartLine is one grocery line as Instacart reads it: the name to search for, and a
// measurement when the quantity is one it understands; a bare count ("3" eggs) is that many each.
func instacartLine(name, quantity string) instacartItem {
	item := instacartItem{Name: strings.TrimSpace(name)}
	amount, unit, counted := parseQuantity(quantity)
	if !counted || amount <= 0 {
		return item
	}
	if strings.TrimSpace(unit) == "" {
		item.Measurements = []instacartMeasure{{Quantity: amount, Unit: "each"}}
	} else if u, ok := instacartUnits[normalizeUnit(unit)]; ok {
		item.Measurements = []instacartMeasure{{Quantity: amount, Unit: u}}
	}
	if quantity = strings.TrimSpace(quantity); quantity != "" {
		item.DisplayText = item.Name + " (" + quantity + ")"
	}
	return item
}

// link asks Instacart for a page for the items and answers its address.
func (c *instacartClient) link(ctx context.Context, page instacartPage) (string, error) {
	body, e := json.Marshal(page)
	if e != nil {
		return "", e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", c.url+"/idp/v1/products/products_link", bytes.NewReader(body))
	if e != nil {
		return "", e
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, e := c.http.Do(req)
	if e != nil {
		return "", fmt.Errorf("instacart: %w", e)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("instacart returned HTTP %d", res.StatusCode)
	}
	var out struct {
		URL string `json:"products_link_url"`
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&out); e != nil {
		return "", fmt.Errorf("instacart answer: %w", e)
	}
	if !strings.HasPrefix(out.URL, "https://") {
		return "", fmt.Errorf("instacart returned no link")
	}
	return out.URL, nil
}

// groceryCheckoutRoutes registers ordering the list and a recipe through Instacart.
func (a *App) groceryCheckoutRoutes(v fiber.Router) {
	v.Post("/groceries/checkout", a.requireAuth, perUser(20, time.Hour), a.checkoutGroceries)
	v.Post("/recipes/:id/checkout", a.requireAuth, perUser(20, time.Hour), a.checkoutRecipe)
}

// checkoutGroceries is POST /groceries/checkout: the unchecked lines of the member's list (their
// household's, in one) as an Instacart page, answering { url, items }.
func (a *App) checkoutGroceries(c fiber.Ctx) error {
	client := instacart()
	if client == nil {
		return fiber.NewError(404, checkoutUnavailable)
	}
	rows, e := a.DB.Query(c.Context(), `SELECT g.name,g.quantity FROM groceries g WHERE NOT g.checked AND `+groceryScope(1)+` ORDER BY g.category,g.created_at,g.id LIMIT `+fmt.Sprint(instacartLines), userID(c))
	if e != nil {
		return e
	}
	var items []instacartItem
	for rows.Next() {
		var name, quantity string
		if e = rows.Scan(&name, &quantity); e != nil {
			rows.Close()
			return e
		}
		items = append(items, instacartLine(name, quantity))
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	if len(items) == 0 {
		return fiber.NewError(400, "Your grocery list has nothing left to buy.")
	}
	return a.sendCheckout(c, client, instacartPage{
		Title: "Savorly grocery list", LinkType: "shopping_list", LineItems: items,
		Landing: &instacartLanding{LinkbackURL: appURL(a.Config) + "/?page=planner"},
	})
}

// checkoutRecipe is POST /recipes/:id/checkout { servings, skipPantry }: a recipe's ingredients,
// scaled, as an Instacart recipe page, leaving off what the pantry has when asked.
func (a *App) checkoutRecipe(c fiber.Ctx) error {
	client := instacart()
	if client == nil {
		return fiber.NewError(404, checkoutUnavailable)
	}
	var in groceryRequest
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Servings < 1 || in.Servings > 100 {
		return fiber.NewError(400, "Choose 1–100 servings.")
	}
	var title, image, language string
	var ingredients []Ingredient
	var servings int
	if e := a.DB.QueryRow(c.Context(), `SELECT r.title,r.image,r.language,r.ingredients,r.servings`+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=$2)`, c.Params("id"), userID(c)).Scan(&title, &image, &language, &ingredients, &servings); e != nil {
		return fiber.NewError(404, "Recipe not found.")
	}
	lines := scaledLines(ingredients, in.Servings, servings)
	if in.SkipPantry {
		cover, _, e := pantryCoverOf(c.Context(), a.DB, userID(c), 0)
		if e != nil {
			return e
		}
		languages := make([]string, len(lines))
		for i := range languages {
			languages[i] = language
		}
		lines, _ = withoutPantry(lines, languages, cover)
	}
	if len(lines) == 0 {
		return fiber.NewError(400, "You already have everything this recipe needs.")
	}
	items := make([]instacartItem, 0, len(lines))
	for _, l := range lines {
		items = append(items, instacartLine(l.Name, formatQuantity(l.Amount, l.Unit)))
	}
	page := instacartPage{
		Title: title, LinkType: "recipe", LineItems: items,
		Landing: &instacartLanding{LinkbackURL: appURL(a.Config) + "/recipes/" + c.Params("id"), PantryItems: true},
	}
	// Instacart shows the photo only at 500×500; a recipe without one goes without.
	if strings.HasPrefix(image, "https://") {
		page.ImageURL = image
	}
	return a.sendCheckout(c, client, page)
}

// sendCheckout asks Instacart for the page and answers its address.
func (a *App) sendCheckout(c fiber.Ctx, client *instacartClient, page instacartPage) error {
	ctx, cancel := context.WithTimeout(c.Context(), instacartTimeout)
	defer cancel()
	url, e := client.link(ctx, page)
	if e != nil {
		return fiber.NewError(502, "We couldn't reach Instacart. Try again in a moment, or share the list instead.")
	}
	track := map[string]any{"provider": "instacart", "type": page.LinkType, "items": len(page.LineItems)}
	_, _ = a.DB.Exec(c.Context(), `INSERT INTO events(user_id,name,props) VALUES($1,'grocery_checkout',$2)`, userID(c), jsonBytes(track))
	return c.JSON(fiber.Map{"url": url, "provider": "instacart", "items": len(page.LineItems)})
}
