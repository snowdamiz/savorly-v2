package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// The MCP server's tools (mcp.go). Each runs one of the sous-chef's tool calls (agent.go) or the
// route it would call, as the linked member or as a guest, and answers in a few lines of text
// for the assistant's model plus the same as structured content for the card and the client.
// None of them cooks: a recipe's method stays in Savorly, behind its cookUrl.

// assistantTool is one tool: how tools/list describes it, the scope it needs ("" for one anyone
// can call), whether the recipe card shows its result, and what it does.
type assistantTool struct {
	name, title, description          string
	input, output                     map[string]any
	scope                             string
	card                              bool
	readOnly, destructive, idempotent bool
	invoking, invoked                 string
	run                               func(*assistantCall) toolResult
}

func integerField(description string, min, max int) props {
	return props{"type": "integer", "minimum": min, "maximum": max, "description": description}
}
func textList(description string) props {
	return props{"type": "array", "items": props{"type": "string"}, "description": description}
}
func nullableField(kind, description string) props {
	return props{"type": []string{kind, "null"}, "description": description}
}
func dateField(description string) props {
	return props{"type": "string", "format": "date", "description": description}
}

// recipeSchema is a recipe as the tools answer it; detail adds what show_recipe says about it.
func recipeSchema(detail bool) map[string]any {
	p := props{
		"id": field("string", ""), "title": field("string", ""),
		"url":           field("string", "The recipe's page in Savorly"),
		"cookUrl":       field("string", "Opens the recipe in Savorly's cooking mode, where it's cooked step by step"),
		"image":         field("string", "Cover photo URL, or empty"),
		"minutes":       field("integer", "The time its cook gives"),
		"servings":      field("integer", ""),
		"cuisine":       field("string", ""),
		"difficulty":    field("string", ""),
		"rating":        field("number", "Average review out of 5; 0 without reviews"),
		"reviewCount":   field("integer", ""),
		"author":        field("string", "The cook who wrote it"),
		"tags":          textList(""),
		"allergens":     textList("Allergen and diet groups its ingredients belong to"),
		"cookTested":    field("boolean", "Cooked in Savorly by at least 5 people"),
		"verifiedCooks": field("integer", "How many people cooked it in Savorly's cooking mode"),
		"cookedMinutes": nullableField("integer", "How long they usually took, once 3 agree"),
		"cookbook":      nullableField("string", "For a saved recipe, the cookbook it's in"),
	}
	if detail {
		p["description"] = field("string", "")
		p["ingredients"] = props{"type": "array", "items": object([]string{"name"}, props{"name": field("string", ""), "amount": field("number", "0 when unmeasured"), "unit": field("string", "")})}
		p["equipment"] = textList("Pots, pans and tools it needs")
		p["stepCount"] = field("integer", "How many steps its method has, in Savorly")
		p["calories"] = field("integer", "Per serving; 0 when not given")
	}
	return object([]string{"id", "title", "url", "cookUrl", "minutes", "cookTested"}, p)
}

var recipeRefSchema = object([]string{"id", "title", "url", "cookUrl"}, props{"id": field("string", ""), "title": field("string", ""), "url": field("string", ""), "cookUrl": field("string", "")})

func recipeIDInput(description string) map[string]any {
	return object([]string{"recipe_id"}, props{"recipe_id": field("string", description)})
}

var assistantTools = []assistantTool{
	{name: "search_recipes", title: "Search Savorly recipes", card: true, readOnly: true, idempotent: true,
		description: "Search Savorly's published recipes by words or ingredients, cuisine, tag and time. Returns up to 8, shown as cards, each with its time, rating, allergen and diet groups, and whether it's cook-tested: cooked in Savorly by at least 5 people, with how long they usually took. With a linked account, leaves out what the member's diets and allergies avoid unless include_avoided.",
		input: object(nil, props{
			"query":           field("string", "Words or ingredients, e.g. chicken thighs lemon"),
			"cuisine":         field("string", "Exact cuisine, e.g. Italian"),
			"tag":             field("string", "Exact tag, e.g. Vegetarian"),
			"max_minutes":     integerField("At most this many minutes, as the recipe's cook gives it", 1, 1440),
			"sort":            choice("Newest first unless asked", "Newest", "Quickest", "Top rated"),
			"cook_tested":     field("boolean", "Only cook-tested recipes"),
			"include_avoided": field("boolean", "Also recipes with what the member's diets and allergies leave out; only when they ask for one by name"),
		}),
		output:   object([]string{"recipes"}, props{"recipes": props{"type": "array", "items": recipeSchema(false)}}),
		invoking: "Searching Savorly…", invoked: "Found Savorly recipes", run: (*assistantCall).searchRecipes},
	{name: "show_recipe", title: "Show a Savorly recipe", card: true, readOnly: true, idempotent: true,
		description: "One Savorly recipe as a card: description, ingredients for its servings, equipment, time, rating and cook-tested line. The method isn't included: it's cooked in Savorly, step by step and hands-free, so give the person its cookUrl.",
		input:       recipeIDInput("From search_recipes or list_saved_recipes"),
		output:      object([]string{"recipe"}, props{"recipe": recipeSchema(true)}),
		invoking:    "Opening the recipe…", invoked: "Showed the recipe", run: (*assistantCall).showRecipe},
	{name: "save_recipe", title: "Save a recipe", scope: "cookbooks", idempotent: true,
		description: "Save a published recipe to the member's Savorly cookbooks; a saved one stays in its cookbook. Needs their linked account.",
		input:       recipeIDInput(""),
		output:      object([]string{"saved", "recipe"}, props{"saved": field("boolean", ""), "recipe": recipeRefSchema}),
		invoking:    "Saving…", invoked: "Saved", run: func(x *assistantCall) toolResult { return x.saveRecipe(false) }},
	{name: "unsave_recipe", title: "Unsave a recipe", scope: "cookbooks", destructive: true, idempotent: true,
		description: "Take a recipe out of the member's saved recipes and the cookbook it's in. Needs their linked account.",
		input:       recipeIDInput(""),
		output:      object([]string{"saved", "recipe"}, props{"saved": field("boolean", ""), "recipe": recipeRefSchema}),
		invoking:    "Unsaving…", invoked: "Unsaved", run: func(x *assistantCall) toolResult { return x.saveRecipe(true) }},
	{name: "list_saved_recipes", title: "Saved recipes", scope: "cookbooks", readOnly: true, idempotent: true,
		description: "The recipes the member saved in Savorly, newest first (up to 50), with the cookbook each is in. Needs their linked account.",
		input:       none,
		output:      object([]string{"recipes", "total"}, props{"recipes": props{"type": "array", "items": recipeSchema(false)}, "total": field("integer", "How many they saved")}),
		invoking:    "Reading saved recipes…", invoked: "Read saved recipes", run: (*assistantCall).listSaved},
	{name: "plan_meal", title: "Plan a meal", scope: "planner", destructive: true, idempotent: true,
		description: "Put a published recipe, or one of the member's own, on their Savorly meal plan for a day and meal, replacing whatever is planned then. Shared with their household if they have one. Needs their linked account.",
		input: object([]string{"recipe_id", "day", "meal"}, props{
			"recipe_id": field("string", ""),
			"day":       dateField("YYYY-MM-DD"),
			"meal":      choice("", "Breakfast", "Lunch", "Dinner"),
			"servings":  integerField("Leave out for the recipe's own", 1, 100),
		}),
		output: object([]string{"day", "meal", "servings", "recipe", "replaced"}, props{
			"day": field("string", ""), "meal": field("string", ""), "servings": field("integer", ""), "recipe": recipeRefSchema,
			"replaced": props{"type": []string{"object", "null"}, "properties": recipeRefSchema["properties"], "description": "What was planned there before"},
		}),
		invoking: "Planning…", invoked: "Planned", run: (*assistantCall).planMeal},
	{name: "get_meal_plan", title: "Meal plan", scope: "planner", readOnly: true, idempotent: true,
		description: "The member's Savorly meal plan from one day to another, both included, up to 62 days; by default today and the next 6 days. Shared with their household if they have one. Needs their linked account.",
		input:       object(nil, props{"from": dateField("YYYY-MM-DD"), "to": dateField("YYYY-MM-DD")}),
		output: object([]string{"from", "to", "meals"}, props{"from": field("string", ""), "to": field("string", ""), "meals": props{"type": "array", "items": object([]string{"id", "day", "meal", "servings", "recipe"}, props{
			"id": field("string", ""), "day": field("string", ""), "meal": field("string", ""), "servings": field("integer", ""), "recipe": recipeRefSchema,
		})}}),
		invoking: "Reading the meal plan…", invoked: "Read the meal plan", run: (*assistantCall).mealPlan},
	{name: "add_groceries", title: "Add to the grocery list", scope: "groceries",
		description: "Add items to the member's Savorly grocery list, shared with their household if they have one. Needs their linked account.",
		input: object([]string{"items"}, props{"items": props{"type": "array", "minItems": 1, "maxItems": 40, "items": object([]string{"name"}, props{
			"name": field("string", ""), "quantity": field("string", "e.g. 2 cups"), "category": field("string", "e.g. Produce"),
		})}}),
		output:   object([]string{"added"}, props{"added": field("integer", "")}),
		invoking: "Adding to the list…", invoked: "Added to the list", run: (*assistantCall).addGroceries},
	{name: "add_recipe_groceries", title: "Add a recipe's ingredients", scope: "groceries",
		description: "Add a recipe's ingredients to the member's Savorly grocery list, scaled to servings and merged with lines already there. Leaves off what their pantry has and kitchen basics (salt, pepper, oil, water) and says which, unless include_pantry. Needs their linked account.",
		input: object([]string{"recipe_id"}, props{
			"recipe_id":      field("string", ""),
			"servings":       integerField("Leave out for the recipe's own", 1, 100),
			"include_pantry": field("boolean", "Add what the pantry has too"),
		}),
		output:   object([]string{"added", "merged", "skipped"}, props{"added": field("integer", "New lines"), "merged": field("integer", "Lines already there that it added to"), "skipped": textList("Left off: in the pantry, or kitchen basics")}),
		invoking: "Adding the ingredients…", invoked: "Added the ingredients", run: (*assistantCall).addRecipeGroceries},
	{name: "get_grocery_list", title: "Grocery list", scope: "groceries", readOnly: true, idempotent: true,
		description: "The member's Savorly grocery list: what's still to buy and what's checked off. Needs their linked account.",
		input:       none,
		output: object([]string{"items"}, props{"items": props{"type": "array", "items": object([]string{"id", "name", "quantity", "category", "checked"}, props{
			"id": field("string", ""), "name": field("string", ""), "quantity": field("string", ""), "category": field("string", ""), "checked": field("boolean", ""),
		})}}),
		invoking: "Reading the grocery list…", invoked: "Read the grocery list", run: (*assistantCall).groceryList},
}

// assistantToolNamed is each tool by name, and assistantToolList the tools as tools/list
// answers them, in a fixed order. Built at start-up, like the sous-chef's.
var (
	assistantToolNamed = map[string]assistantTool{}
	assistantToolList  []fiber.Map
)

func init() {
	for _, t := range assistantTools {
		assistantToolNamed[t.name] = t
		assistantToolList = append(assistantToolList, t.definition())
	}
}

// definition is the tool as tools/list describes it. securitySchemes says which tools need an
// account, for ChatGPT, which also reads it from _meta; ui.resourceUri (and ChatGPT's own name
// for it) shows the result as the recipe card.
func (t assistantTool) definition() fiber.Map {
	schemes := []fiber.Map{{"type": "noauth"}}
	if t.scope != "" {
		schemes = []fiber.Map{{"type": "oauth2", "scopes": []string{t.scope}}}
	}
	meta := fiber.Map{"securitySchemes": schemes, "openai/toolInvocation/invoking": t.invoking, "openai/toolInvocation/invoked": t.invoked}
	if t.card {
		meta["ui"] = fiber.Map{"resourceUri": mcpCardURI}
		meta["openai/outputTemplate"] = mcpCardURI
	}
	return fiber.Map{"name": t.name, "title": t.title, "description": t.description, "inputSchema": t.input, "outputSchema": t.output,
		"annotations":     fiber.Map{"title": t.title, "readOnlyHint": t.readOnly, "destructiveHint": t.destructive, "idempotentHint": t.idempotent, "openWorldHint": false},
		"securitySchemes": schemes, "_meta": meta}
}

// toolResult is a tool's answer: text for the model, the same as structured content, or an
// error; meta is for the client only.
type toolResult struct {
	text       string
	structured any
	failed     bool
	meta       fiber.Map
}

func (r toolResult) wire() fiber.Map {
	out := fiber.Map{"content": []fiber.Map{{"type": "text", "text": r.text}}, "isError": r.failed}
	if r.structured != nil {
		out["structuredContent"] = r.structured
	}
	if r.meta != nil {
		out["_meta"] = r.meta
	}
	return out
}

// refusal is a sous-chef tool's or route's error as a tool error, when out is one.
func refusal(out string) (toolResult, bool) {
	var e struct{ Error string }
	if json.Unmarshal([]byte(out), &e) == nil && e.Error != "" {
		return toolResult{failed: true, text: e.Error}, true
	}
	return toolResult{}, false
}

// assistantCall is one tool call: who it's for, its arguments as the sous-chef's tools read
// them, and the sous-chef's tool call (turn) acting as the member, or as a guest.
type assistantCall struct {
	a      *App
	ctx    context.Context
	caller assistantCaller
	in     toolArgs
	opts   struct {
		CookTested bool `json:"cook_tested"`
	}
	turn *toolTurn
}

// callTool runs a tool. One that needs an account the request hasn't linked, which only
// ChatGPT's requests reach (mcp), answers with the challenge ChatGPT shows as a sign-in.
func (a *App) callTool(c fiber.Ctx, caller assistantCaller, tool assistantTool, p rpcParams) fiber.Map {
	if tool.scope != "" && (caller.user == "" || !slices.Contains(caller.scopes, tool.scope)) {
		challenge := a.bearerChallenge(c, "insufficient_scope", "Link your Savorly account to use this tool.", withScope(caller.scopes, tool.scope))
		if caller.user == "" {
			challenge = a.bearerChallenge(c, "insufficient_scope", "Link your Savorly account to use this tool.", oauthScopes)
		}
		return toolResult{failed: true, text: "This needs the person's Savorly account. Ask them to link it, then try again.", meta: fiber.Map{"mcp/www_authenticate": []string{challenge}}}.wire()
	}
	args := p.Arguments
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}
	x := &assistantCall{a: a, ctx: c.Context(), caller: caller}
	if json.Unmarshal(withoutBlanks(args), &x.in) != nil || json.Unmarshal(args, &x.opts) != nil {
		return toolResult{failed: true, text: "Arguments must be a JSON object matching the tool's input schema."}.wire()
	}
	x.turn = &toolTurn{a: a, ctx: x.ctx, run: &agentRun{state: studioState{Owner: caller.user}}, name: tool.name, raw: args, owner: caller.user, in: &x.in}
	return tool.run(x).wire()
}

// assistantRecipe is a recipe as the routes answer it (recipeJSON), as far as the tools use it.
type assistantRecipe struct {
	ID, Title, Description, Cuisine, Difficulty, Image string
	Minutes, Servings, Calories, ReviewCount           int
	VerifiedCooks                                      int
	CookedMinutes                                      *int
	Rating                                             float64
	Tags, Allergens, Equipment                         []string
	Ingredients                                        json.RawMessage
	Steps                                              []json.RawMessage
	Author                                             struct{ Name string }
}

// recipeLink is a recipe's page on the site; with ?cook=1 the app opens it in cooking mode.
func (a *App) recipeLink(id string) string {
	return appURL(a.Config) + "/recipes/" + url.PathEscape(id)
}

func (a *App) recipeRef(id, title string) fiber.Map {
	link := a.recipeLink(id)
	return fiber.Map{"id": id, "title": title, "url": link, "cookUrl": link + "?cook=1"}
}

func (a *App) recipeSummary(r assistantRecipe) fiber.Map {
	out := a.recipeRef(r.ID, r.Title)
	for k, v := range map[string]any{"image": r.Image, "minutes": r.Minutes, "servings": r.Servings, "cuisine": r.Cuisine, "difficulty": r.Difficulty,
		"rating": r.Rating, "reviewCount": r.ReviewCount, "author": r.Author.Name, "tags": orEmpty(r.Tags), "allergens": orEmpty(r.Allergens),
		"cookTested": r.VerifiedCooks >= cookTestedCooks, "verifiedCooks": r.VerifiedCooks, "cookedMinutes": r.CookedMinutes} {
		out[k] = v
	}
	return out
}

func orEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

// cookTestedLine is what cooking it in Savorly showed, in words, or "".
func cookTestedLine(r assistantRecipe) string {
	switch {
	case r.VerifiedCooks >= cookTestedCooks && r.CookedMinutes != nil:
		return fmt.Sprintf("cook-tested: %d people cooked it in Savorly and usually took %d min", r.VerifiedCooks, *r.CookedMinutes)
	case r.VerifiedCooks >= cookTestedCooks:
		return fmt.Sprintf("cook-tested: %d people cooked it in Savorly", r.VerifiedCooks)
	case r.CookedMinutes != nil:
		return fmt.Sprintf("the %d people who cooked it in Savorly usually took %d min", r.VerifiedCooks, *r.CookedMinutes)
	}
	return ""
}

// recipeLine is a recipe in one line of text, with its id and link.
func (a *App) recipeLine(r assistantRecipe) string {
	facts := []string{fmt.Sprintf("%d min", r.Minutes)}
	if r.Cuisine != "" {
		facts = append(facts, r.Cuisine)
	}
	if r.Author.Name != "" {
		facts = append(facts, "by "+r.Author.Name)
	}
	if r.ReviewCount > 0 {
		facts = append(facts, fmt.Sprintf("rated %.1f from %d review%s", r.Rating, r.ReviewCount, plural(int64(r.ReviewCount))))
	}
	line := r.Title + " (" + strings.Join(facts, ", ") + ")"
	if t := cookTestedLine(r); t != "" {
		line += "; " + t
	}
	if len(r.Allergens) > 0 {
		line += "; contains " + strings.Join(r.Allergens, ", ")
	}
	return line + ". id " + r.ID + ", " + a.recipeLink(r.ID)
}

// call runs a sous-chef route for the tool; its error comes back as the tool's.
func (x *assistantCall) call(method, path string) ([]byte, *toolResult) {
	status, b := x.turn.call(method, path, nil)
	if status >= 300 {
		r, _ := refusal(x.turn.result(status, b))
		return nil, &r
	}
	return b, nil
}

func (x *assistantCall) searchRecipes() toolResult {
	q := url.Values{"q": {x.in.Query}, "category": {x.in.Cuisine}, "tag": {x.in.Tag}, "sort": {x.in.Sort}, "limit": {"8"}}
	if x.in.MaxMinutes > 0 {
		q.Set("maxMinutes", strconv.Itoa(x.in.MaxMinutes))
	}
	// Search keeps only cook-tested recipes when asked; the check below holds where it can't yet.
	if x.opts.CookTested {
		q.Set("cookTested", "true")
	}
	// Like the sous-chef: what fits the member's diets and allergies, unless they asked otherwise.
	if x.caller.user != "" && !x.in.IncludeAvoided {
		q.Set("fits", "me")
	}
	b, failure := x.call("GET", "/recipes?"+q.Encode())
	if failure != nil {
		return *failure
	}
	var found []assistantRecipe
	if json.Unmarshal(b, &found) != nil {
		return toolResult{failed: true, text: "Search failed."}
	}
	shown, lines := []fiber.Map{}, []string{}
	for _, r := range found {
		if x.opts.CookTested && r.VerifiedCooks < cookTestedCooks {
			continue
		}
		shown = append(shown, x.a.recipeSummary(r))
		lines = append(lines, fmt.Sprintf("%d. %s", len(lines)+1, x.a.recipeLine(r)))
	}
	text := "No Savorly recipes match. Try fewer words, or leave out a filter."
	if len(lines) > 0 {
		text = fmt.Sprintf("%d Savorly recipe%s:\n%s\nEach link is the recipe's page in Savorly; its cookUrl opens it in cooking mode.", len(lines), plural(int64(len(lines))), strings.Join(lines, "\n"))
	}
	return toolResult{text: text, structured: fiber.Map{"recipes": shown}}
}

// quantityText is an ingredient's quantity as a cook writes it: no trailing zeros, two decimals at most.
func quantityText(n float64) string {
	return strconv.FormatFloat(math.Round(n*100)/100, 'f', -1, 64)
}

func (x *assistantCall) showRecipe() toolResult {
	var b []byte
	// What the sous-chef's get_recipe reads: a published recipe, or one of the member's own.
	e := x.a.DB.QueryRow(x.ctx, `SELECT `+recipeJSON+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=$2)`, strings.TrimSpace(x.in.RecipeID), x.caller.user).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return toolResult{failed: true, text: "Recipe not found."}
	}
	var r assistantRecipe
	var ingredients []Ingredient
	if e == nil {
		e = json.Unmarshal(b, &r)
	}
	if e == nil {
		e = json.Unmarshal(r.Ingredients, &ingredients)
	}
	if e != nil {
		return toolResult{failed: true, text: "That recipe didn't load. Please try again."}
	}
	detail := x.a.recipeSummary(r)
	listed, lines := []fiber.Map{}, []string{}
	for _, i := range ingredients {
		listed = append(listed, fiber.Map{"name": i.Name, "amount": math.Round(i.Amount*100) / 100, "unit": i.Unit})
		quantity := ""
		if i.Amount > 0 {
			quantity = strings.TrimSpace(quantityText(i.Amount) + " " + i.Unit)
		}
		lines = append(lines, "- "+strings.TrimSpace(quantity+" "+i.Name))
	}
	detail["description"], detail["ingredients"], detail["equipment"] = r.Description, listed, orEmpty(r.Equipment)
	detail["stepCount"], detail["calories"] = len(r.Steps), r.Calories
	text := []string{x.a.recipeLine(r), r.Description, fmt.Sprintf("Ingredients for %d serving%s:\n%s", r.Servings, plural(int64(r.Servings)), strings.Join(lines, "\n"))}
	if len(r.Equipment) > 0 {
		text = append(text, "Equipment: "+strings.Join(r.Equipment, ", "))
	}
	text = append(text, fmt.Sprintf("Its %d step%s are cooked in Savorly, hands-free, with timers: %s", len(r.Steps), plural(int64(len(r.Steps))), detail["cookUrl"]))
	return toolResult{text: strings.Join(text, "\n\n"), structured: fiber.Map{"recipe": detail}}
}

func (x *assistantCall) saveRecipe(unsave bool) toolResult {
	x.in.RecipeID = strings.TrimSpace(x.in.RecipeID)
	title := x.a.recipeTitle(x.ctx, x.in.RecipeID)
	if title == "" {
		return toolResult{failed: true, text: "Recipe not found."}
	}
	// A saved recipe stays in its cookbook.
	x.in.Unsave, x.in.CookbookID = unsave, nil
	if r, failed := refusal(x.turn.saveRecipe()); failed {
		return r
	}
	text := fmt.Sprintf("Saved “%s” in the member's Savorly cookbooks.", title)
	if unsave {
		text = fmt.Sprintf("“%s” is no longer in the member's saved recipes.", title)
	}
	return toolResult{text: text, structured: fiber.Map{"saved": !unsave, "recipe": x.a.recipeRef(x.in.RecipeID, title)}}
}

func (x *assistantCall) listSaved() toolResult {
	out := x.turn.getCookbooks()
	if r, failed := refusal(out); failed {
		return r
	}
	var library struct {
		Saves []struct {
			RecipeID     string  `json:"recipeId"`
			CollectionID *string `json:"collectionId"`
		}
		Collections []struct{ ID, Name string }
		Recipes     []assistantRecipe
	}
	if json.Unmarshal([]byte(out), &library) != nil {
		return toolResult{failed: true, text: "The saved recipes didn't load. Please try again."}
	}
	// Newest saves first: the order the app's Saved shelf has.
	var order []string
	if e := x.a.DB.QueryRow(x.ctx, `SELECT COALESCE(array_agg(recipe_id ORDER BY created_at DESC,recipe_id),'{}') FROM saves WHERE user_id=$1`, x.caller.user).Scan(&order); e != nil {
		return toolResult{failed: true, text: "The saved recipes didn't load. Please try again."}
	}
	cookbooks, in := map[string]string{}, map[string]string{}
	for _, c := range library.Collections {
		cookbooks[c.ID] = c.Name
	}
	for _, s := range library.Saves {
		if s.CollectionID != nil {
			in[s.RecipeID] = cookbooks[*s.CollectionID]
		}
	}
	byID := map[string]assistantRecipe{}
	for _, r := range library.Recipes {
		byID[r.ID] = r
	}
	shown, lines, total := []fiber.Map{}, []string{}, 0
	for _, id := range order {
		r, ok := byID[id]
		if !ok {
			continue
		}
		total++
		if len(shown) == 50 {
			continue
		}
		summary := x.a.recipeSummary(r)
		summary["cookbook"] = nil
		line := x.a.recipeLine(r)
		if name := in[id]; name != "" {
			summary["cookbook"] = name
			line += " In the cookbook “" + name + "”."
		}
		shown = append(shown, summary)
		lines = append(lines, fmt.Sprintf("%d. %s", len(lines)+1, line))
	}
	text := "The member hasn't saved any recipes yet."
	if total > 0 {
		text = fmt.Sprintf("%d saved recipe%s, newest first:\n%s", total, plural(int64(total)), strings.Join(lines, "\n"))
		if total > len(shown) {
			text += fmt.Sprintf("\nAnd %d more, in Savorly.", total-len(shown))
		}
	}
	return toolResult{text: text, structured: fiber.Map{"recipes": shown, "total": total}}
}

// planDay is a plan day in words, with the date as given.
func planDay(day string) string {
	t, e := time.Parse("2006-01-02", day)
	if e != nil {
		return day
	}
	return t.Format("Monday 2 January") + " (" + day + ")"
}

func (x *assistantCall) planMeal() toolResult {
	x.in.RecipeID, x.in.Day = strings.TrimSpace(x.in.RecipeID), strings.TrimSpace(x.in.Day)
	previous := x.a.planSlot(x.ctx, x.caller.user, x.in.Day, x.in.Meal)
	if r, failed := refusal(x.turn.planMeal()); failed {
		return r
	}
	servings, title := x.turn.servings(), x.a.recipeTitle(x.ctx, x.in.RecipeID)
	ref := x.a.recipeRef(x.in.RecipeID, title)
	out := fiber.Map{"day": x.in.Day, "meal": x.in.Meal, "servings": servings, "recipe": ref, "replaced": nil}
	text := fmt.Sprintf("Planned “%s” for %s on %s, %d serving%s.", title, strings.ToLower(x.in.Meal), planDay(x.in.Day), servings, plural(int64(servings)))
	if previous != nil && previous.Recipe != x.in.RecipeID {
		was := x.a.recipeTitle(x.ctx, previous.Recipe)
		out["replaced"] = x.a.recipeRef(previous.Recipe, was)
		text += fmt.Sprintf(" It replaces “%s”.", was)
	}
	return toolResult{text: text + " To cook it in Savorly: " + ref["cookUrl"].(string), structured: out}
}

// plannedMeal is a meal plan entry as GET /kitchen answers it.
type plannedMeal struct {
	ID, Day, Meal string
	Servings      int
	Recipe        assistantRecipe
}

var planMealOrder = map[string]int{"Breakfast": 0, "Lunch": 1, "Dinner": 2}

func (x *assistantCall) mealPlan() toolResult {
	from, to := strings.TrimSpace(x.in.From), strings.TrimSpace(x.in.To)
	// The member's own time zone isn't known here; the server's day is close enough for a default.
	switch start, e := time.Parse("2006-01-02", from); {
	case from == "" && to == "":
		today := time.Now().UTC()
		from, to = today.Format("2006-01-02"), today.AddDate(0, 0, 6).Format("2006-01-02")
	case to == "" && e == nil:
		to = start.AddDate(0, 0, 6).Format("2006-01-02")
	case from == "":
		if end, e := time.Parse("2006-01-02", to); e == nil {
			from = end.AddDate(0, 0, -6).Format("2006-01-02")
		}
	}
	b, failure := x.call("GET", "/kitchen?"+url.Values{"from": {from}, "to": {to}}.Encode())
	if failure != nil {
		return *failure
	}
	var kitchen struct{ Plans []plannedMeal }
	if json.Unmarshal(b, &kitchen) != nil {
		return toolResult{failed: true, text: "The meal plan didn't load. Please try again."}
	}
	slices.SortFunc(kitchen.Plans, func(p, q plannedMeal) int {
		if c := strings.Compare(p.Day, q.Day); c != 0 {
			return c
		}
		return planMealOrder[p.Meal] - planMealOrder[q.Meal]
	})
	meals, lines := []fiber.Map{}, []string{}
	for _, p := range kitchen.Plans {
		ref := x.a.recipeRef(p.Recipe.ID, p.Recipe.Title)
		meals = append(meals, fiber.Map{"id": p.ID, "day": p.Day, "meal": p.Meal, "servings": p.Servings, "recipe": ref})
		lines = append(lines, fmt.Sprintf("- %s, %s: %s, %d serving%s (recipe id %s)", planDay(p.Day), strings.ToLower(p.Meal), p.Recipe.Title, p.Servings, plural(int64(p.Servings)), p.Recipe.ID))
	}
	text := fmt.Sprintf("Nothing is planned from %s to %s.", from, to)
	if len(lines) > 0 {
		text = fmt.Sprintf("The meal plan from %s to %s:\n%s", from, to, strings.Join(lines, "\n"))
	}
	return toolResult{text: text, structured: fiber.Map{"from": from, "to": to, "meals": meals}}
}

func (x *assistantCall) addGroceries() toolResult {
	out := x.turn.addGroceries()
	if r, failed := refusal(out); failed {
		return r
	}
	var added struct{ Added int }
	_ = json.Unmarshal([]byte(out), &added)
	return toolResult{text: fmt.Sprintf("Added %d item%s to the member's Savorly grocery list.", added.Added, plural(int64(added.Added))), structured: fiber.Map{"added": added.Added}}
}

func (x *assistantCall) addRecipeGroceries() toolResult {
	x.in.RecipeID = strings.TrimSpace(x.in.RecipeID)
	out := x.turn.addRecipeGroceries()
	if r, failed := refusal(out); failed {
		return r
	}
	var shopped struct {
		Added, Merged int
		Skipped       []string
	}
	_ = json.Unmarshal([]byte(out), &shopped)
	servings := x.turn.servings()
	text := fmt.Sprintf("Put the ingredients of “%s” for %d serving%s on the grocery list: %d new line%s", x.a.recipeTitle(x.ctx, x.in.RecipeID), servings, plural(int64(servings)), shopped.Added, plural(int64(shopped.Added)))
	if shopped.Merged > 0 {
		text += fmt.Sprintf(", %d added to lines already there", shopped.Merged)
	}
	text += "."
	if len(shopped.Skipped) > 0 {
		text += " Left off, as the pantry has them or every kitchen does: " + strings.Join(shopped.Skipped, ", ") + "."
	}
	return toolResult{text: text, structured: fiber.Map{"added": shopped.Added, "merged": shopped.Merged, "skipped": orEmpty(shopped.Skipped)}}
}

func (x *assistantCall) groceryList() toolResult {
	b, failure := x.call("GET", "/kitchen")
	if failure != nil {
		return *failure
	}
	var kitchen struct {
		Groceries []struct {
			ID, Name, Quantity, Category string
			Checked                      bool
		}
	}
	if json.Unmarshal(b, &kitchen) != nil {
		return toolResult{failed: true, text: "The grocery list didn't load. Please try again."}
	}
	items, buy, got := []fiber.Map{}, []string{}, []string{}
	for _, g := range kitchen.Groceries {
		items = append(items, fiber.Map{"id": g.ID, "name": g.Name, "quantity": g.Quantity, "category": g.Category, "checked": g.Checked})
		line := g.Name
		if g.Quantity != "" {
			line += " (" + g.Quantity + ")"
		}
		if g.Checked {
			got = append(got, line)
		} else {
			buy = append(buy, line)
		}
	}
	text := "The grocery list is empty."
	if len(items) > 0 {
		text = fmt.Sprintf("To buy (%d): %s.", len(buy), listOrNone(buy))
		if len(got) > 0 {
			text += fmt.Sprintf(" Checked off (%d): %s.", len(got), strings.Join(got, ", "))
		}
	}
	return toolResult{text: text, structured: fiber.Map{"items": items}}
}
