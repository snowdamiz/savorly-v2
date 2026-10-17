package app

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

const libraryIDs = `
 'savedIds',COALESCE((SELECT jsonb_agg(recipe_id) FROM saves WHERE user_id=$1),'[]'),
 'saves',COALESCE((SELECT jsonb_agg(jsonb_build_object('recipeId',recipe_id,'collectionId',collection_id)) FROM saves WHERE user_id=$1),'[]'),
 'collections',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'public',public,'description',description)) FROM collections WHERE user_id=$1),'[]'),
 'followingIds',COALESCE((SELECT jsonb_agg(creator_id) FROM follows WHERE user_id=$1),'[]'),
 'cookedIds',COALESCE((SELECT jsonb_agg(recipe_id) FROM cooks WHERE user_id=$1),'[]'),
 'ownIds',COALESCE((SELECT jsonb_agg(id ORDER BY created_at DESC,id DESC) FROM recipes WHERE author_id=$1),'[]'),
 'publishedCount',(SELECT count(*) FROM recipes WHERE author_id=$1 AND published)`

// library answers every saved and authored recipe, as older apps expect. With ?limit=N it
// answers the newest N and hasMore; the ids (saved, own, followed, cooked), saves, cookbooks and
// the count of the member's published recipes stay complete either way.
func (a *App) library(c fiber.Ctx) error {
	if c.Query("limit") == "" {
		return a.queryOne(c, `SELECT jsonb_build_object(`+libraryIDs+`,
 'recipes',COALESCE((SELECT jsonb_agg(`+recipeJSON+`)`+recipeFrom+`WHERE (r.published AND r.id IN(SELECT recipe_id FROM saves WHERE user_id=$1)) OR r.author_id=$1),'[]'))`, userID(c))
	}
	limit, _ := pageParams(c, 24, 100)
	page, _ := libraryPage("", "", limit, 0)
	return a.queryOne(c, `WITH page AS (`+page+`)
SELECT jsonb_build_object(`+libraryIDs+`,
 'recipes',COALESCE((SELECT jsonb_agg(j ORDER BY n) FROM page WHERE n<=$2),'[]'),'hasMore',(SELECT count(*) FROM page)>$2)`, userID(c), limit)
}

// libraryPage selects one page plus one more row (to tell whether there are more) of the
// member's ($1) recipes: saved ones, in a cookbook ($3) if given, and their own unless scope
// or a cookbook says otherwise. Newest first, by when they saved or wrote each.
func libraryPage(scope, collection string, limit, offset int) (string, bool) {
	var parts []string
	if scope != "mine" {
		saved := `SELECT s.recipe_id AS id,s.created_at AS at FROM saves s JOIN recipes p ON p.id=s.recipe_id AND p.published WHERE s.user_id=$1`
		if collection != "" {
			saved += ` AND s.collection_id=$3`
		}
		parts = append(parts, saved)
	}
	if scope != "saved" && collection == "" {
		parts = append(parts, `SELECT id,created_at AS at FROM recipes WHERE author_id=$1`)
	}
	if len(parts) == 0 {
		return "", false
	}
	return `SELECT ` + recipeJSON + ` AS j,row_number() OVER (ORDER BY l.at DESC,r.id DESC)-` + strconv.Itoa(offset) + ` AS n FROM (SELECT id,max(at) AS at FROM (` + strings.Join(parts, " UNION ALL ") + `) x GROUP BY id) l
 JOIN recipes r ON r.id=l.id JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL ORDER BY l.at DESC,r.id DESC LIMIT ` + strconv.Itoa(limit+1) + ` OFFSET ` + strconv.Itoa(offset), true
}

// libraryRecipes pages through the library: ?offset, ?limit (up to 100), ?collection=<cookbook
// id> for one cookbook, or ?scope=saved|mine for one side of it.
func (a *App) libraryRecipes(c fiber.Ctx) error {
	limit, offset := pageParams(c, 24, 100)
	scope, collection := c.Query("scope"), c.Query("collection")
	if scope != "" && scope != "saved" && scope != "mine" {
		return fiber.NewError(400, "Choose Saved or My recipes.")
	}
	page, ok := libraryPage(scope, collection, limit, offset)
	if !ok {
		return c.JSON(fiber.Map{"recipes": []any{}, "hasMore": false})
	}
	args := []any{userID(c), limit}
	if collection != "" {
		args = append(args, collection)
	}
	return a.queryOne(c, `WITH page AS (`+page+`)
SELECT jsonb_build_object('recipes',COALESCE((SELECT jsonb_agg(j ORDER BY n) FROM page WHERE n<=$2),'[]'),'hasMore',(SELECT count(*) FROM page)>$2)`, args...)
}
func (a *App) save(c fiber.Ctx) error {
	var in struct {
		CollectionID *string `json:"collectionId"`
	}
	if len(c.Body()) > 0 {
		if e := decode(c, &in); e != nil {
			return e
		}
	}
	if in.CollectionID != nil {
		var ok bool
		if e := a.DB.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM collections WHERE id=$1 AND user_id=$2)`, *in.CollectionID, userID(c)).Scan(&ok); e != nil {
			return e
		}
		if !ok {
			return fiber.NewError(404, "Cookbook not found.")
		}
	}
	r, e := a.DB.Exec(c.Context(), `INSERT INTO saves(user_id,recipe_id,collection_id) SELECT $1,id,$3 FROM recipes WHERE id=$2 AND published ON CONFLICT(user_id,recipe_id) DO UPDATE SET collection_id=excluded.collection_id`, userID(c), c.Params("id"), in.CollectionID)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Recipe not found.")
	}
	return c.JSON(fiber.Map{"saved": true})
}
func (a *App) unsave(c fiber.Ctx) error {
	_, e := a.DB.Exec(c.Context(), `DELETE FROM saves WHERE user_id=$1 AND recipe_id=$2`, userID(c), c.Params("id"))
	if e != nil {
		return e
	}
	return c.SendStatus(204)
}
func (a *App) createCollection(c fiber.Ctx) error {
	var in struct{ Name string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Name, 1, 60) {
		return fiber.NewError(400, "Give your cookbook a name (up to 60 characters).")
	}
	return a.queryOne(c, `INSERT INTO collections(id,user_id,name) VALUES($1,$2,$3) ON CONFLICT(user_id,name) DO UPDATE SET name=excluded.name RETURNING jsonb_build_object('id',id,'name',name)`, uuid.NewString(), userID(c), strings.TrimSpace(in.Name))
}
func (a *App) deleteCollection(c fiber.Ctx) error { return a.deleteOwned(c, "collections", "user_id") }

// kitchen answers every meal plan, as older apps expect; ?from=&to= (YYYY-MM-DD, up to 62
// days) windows the plans to the weeks on screen. Groceries and pantry are always complete;
// the groceries are the household's list for a member of one (household.go), with addedBy.
func (a *App) kitchen(c fiber.Ctx) error {
	args, window := []any{userID(c)}, ""
	if c.Query("from") != "" || c.Query("to") != "" {
		from, to, e := dayRange(c.Query("from"), c.Query("to"))
		if e != nil {
			return e
		}
		args, window = append(args, from, to), ` AND p.day BETWEEN $2 AND $3`
	}
	return a.queryOne(c, `SELECT jsonb_build_object(
 'plans',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'recipeId',p.recipe_id,'day',p.day,'meal',p.meal,'servings',p.servings,'recipe',`+recipeJSON+`)) FROM meal_plans p JOIN recipes r ON r.id=p.recipe_id JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL WHERE p.user_id=$1`+window+`),'[]'),
 'groceries',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'quantity',g.quantity,'category',g.category,'checked',g.checked,
   'addedBy',CASE WHEN g.household_id IS NOT NULL THEN (SELECT jsonb_build_object('id',x.id,'name',x.name) FROM users x WHERE x.id=g.user_id) END) ORDER BY g.created_at,g.id)
   FROM groceries g WHERE `+groceryScope(1)+`),'[]'),
 'pantry',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'quantity',quantity,'expiresOn',expires_on)) FROM pantry WHERE user_id=$1),'[]'),
 'pantryCover',COALESCE((SELECT jsonb_agg(DISTINCT k ORDER BY k) FROM pantry, unnest(food_keys) k WHERE user_id=$1),'[]'))`, args...)
}

// dayRange reads an inclusive range of at most 62 days.
func dayRange(from, to string) (string, string, error) {
	start, e := time.Parse("2006-01-02", from)
	end, f := time.Parse("2006-01-02", to)
	if e != nil || f != nil {
		return "", "", fiber.NewError(400, "Choose a valid date.")
	}
	if end.Before(start) || end.Sub(start) >= 62*24*time.Hour {
		return "", "", fiber.NewError(400, "Choose a date range of up to 62 days.")
	}
	return from, to, nil
}
func (a *App) plan(c fiber.Ctx) error {
	var in struct {
		RecipeID  string `json:"recipeId"`
		Day, Meal string
		Servings  int
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if _, e := time.Parse("2006-01-02", in.Day); e != nil {
		return fiber.NewError(400, "Choose a valid date.")
	}
	if (in.Meal != "Breakfast" && in.Meal != "Lunch" && in.Meal != "Dinner") || in.Servings < 1 || in.Servings > 100 {
		return fiber.NewError(400, "Choose a meal and 1–100 servings.")
	}
	// A published recipe, or one of the member's own: plans are theirs alone, never shown to others.
	r, e := a.DB.Exec(c.Context(), `INSERT INTO meal_plans(id,user_id,recipe_id,day,meal,servings) SELECT $1,$2,id,$4,$5,$6 FROM recipes WHERE id=$3 AND (published OR author_id=$2) ON CONFLICT(user_id,day,meal) DO UPDATE SET recipe_id=excluded.recipe_id,servings=excluded.servings`, uuid.NewString(), userID(c), in.RecipeID, in.Day, in.Meal, in.Servings)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Recipe not found.")
	}
	return c.JSON(fiber.Map{"ok": true})
}
func (a *App) deletePlan(c fiber.Ctx) error { return a.deleteOwned(c, "meal_plans", "user_id") }
func (a *App) addGrocery(c fiber.Ctx) error {
	var in struct{ Name, Quantity, Category string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Name, 1, 120) || len(in.Quantity) > 50 || len(in.Category) > 50 {
		return fiber.NewError(400, "Check the grocery name and quantity.")
	}
	if in.Category == "" {
		in.Category = "Other"
	}
	// The member's lock keeps the line from landing on a list they are moving off (household.go).
	ctx := c.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = lockList(ctx, tx, userID(c)); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO groceries(id,user_id,household_id,name,quantity,category) VALUES($1,$2,(SELECT household_id FROM household_members WHERE user_id=$2),$3,$4,$5)`, uuid.NewString(), userID(c), strings.TrimSpace(in.Name), in.Quantity, in.Category)
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.Status(201).JSON(fiber.Map{"ok": true})
}
func (a *App) checkGrocery(c fiber.Ctx) error {
	var in struct{ Checked bool }
	if e := decode(c, &in); e != nil {
		return e
	}
	r, e := a.DB.Exec(c.Context(), `UPDATE groceries g SET checked=$3 WHERE g.id=$1 AND `+groceryScope(2), c.Params("id"), userID(c), in.Checked)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Item not found.")
	}
	return c.SendStatus(204)
}
func (a *App) deleteGrocery(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `DELETE FROM groceries g WHERE g.id=$1 AND `+groceryScope(2), c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Item not found.")
	}
	return c.SendStatus(204)
}

// groceryRequest is what putting a recipe or a planned range on the list takes. skipPantry
// leaves off what the pantry already has, and the staples every kitchen has; older apps don't
// send it and get every line.
type groceryRequest struct {
	Servings   int
	From, To   string
	SkipPantry bool `json:"skipPantry"`
}

// shop puts lines on the member's list, first leaving off what the pantry has when asked.
func (a *App) shop(c fiber.Ctx, in groceryRequest, lines []groceryLine, languages []string) error {
	var skipped []string
	if in.SkipPantry {
		cover, _, e := pantryCoverOf(c.Context(), a.DB, userID(c), 0)
		if e != nil {
			return e
		}
		lines, skipped = withoutPantry(lines, languages, cover)
	}
	added, merged, e := a.addGroceries(c.Context(), userID(c), lines)
	if e != nil {
		return e
	}
	out := fiber.Map{"added": added, "merged": merged}
	if in.SkipPantry {
		out["skipped"] = skipped
	}
	return c.JSON(out)
}

func (a *App) recipeGroceries(c fiber.Ctx) error {
	var in groceryRequest
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Servings < 1 || in.Servings > 100 {
		return fiber.NewError(400, "Choose 1–100 servings.")
	}
	var ingredients []Ingredient
	var servings int
	var language string
	// Like planning: a published recipe or one of the member's own. Only the ingredients reach
	// the list, so a household sees what to buy, not the private recipe.
	if e := a.DB.QueryRow(c.Context(), `SELECT ingredients,servings,language FROM recipes WHERE id=$1 AND (published OR author_id=$2)`, c.Params("id"), userID(c)).Scan(&ingredients, &servings, &language); e != nil {
		return fiber.NewError(404, "Recipe not found.")
	}
	lines := scaledLines(ingredients, in.Servings, servings)
	return a.shop(c, in, lines, slices.Repeat([]string{language}, len(lines)))
}

func scaledLines(ingredients []Ingredient, servings, recipeServings int) []groceryLine {
	lines := make([]groceryLine, 0, len(ingredients))
	for _, i := range ingredients {
		lines = append(lines, groceryLine{Name: i.Name, Unit: i.Unit, Category: i.Category, Amount: i.Amount * float64(servings) / float64(max(recipeServings, 1))})
	}
	return lines
}

// planGroceries puts every planned meal from..to on the grocery list, scaled to each plan's
// servings and merged like single recipes.
func (a *App) planGroceries(c fiber.Ctx) error {
	var in groceryRequest
	if e := decode(c, &in); e != nil {
		return e
	}
	from, to, e := dayRange(in.From, in.To)
	if e != nil {
		return e
	}
	rows, e := a.DB.Query(c.Context(), `SELECT r.ingredients,r.servings,p.servings,r.language FROM meal_plans p JOIN recipes r ON r.id=p.recipe_id JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL
 WHERE p.user_id=$1 AND p.day BETWEEN $2 AND $3 AND (r.published OR r.author_id=$1) ORDER BY p.day,array_position(ARRAY['Breakfast','Lunch','Dinner'],p.meal)`, userID(c), from, to)
	if e != nil {
		return e
	}
	var lines []groceryLine
	var languages []string
	for rows.Next() {
		var ingredients []Ingredient
		var recipeServings, servings int
		var language string
		if e = rows.Scan(&ingredients, &recipeServings, &servings, &language); e != nil {
			rows.Close()
			return e
		}
		scaled := scaledLines(ingredients, servings, recipeServings)
		lines = append(lines, scaled...)
		languages = append(languages, slices.Repeat([]string{language}, len(scaled))...)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	return a.shop(c, in, lines, languages)
}
func (a *App) addPantry(c fiber.Ctx) error {
	var in struct {
		Name, Quantity string
		ExpiresOn      *string `json:"expiresOn"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Name, 1, 100) || len(in.Quantity) > 50 {
		return fiber.NewError(400, "Check the ingredient and quantity.")
	}
	if in.ExpiresOn != nil {
		if _, e := time.Parse("2006-01-02", *in.ExpiresOn); e != nil {
			return fiber.NewError(400, "Use a valid expiry date.")
		}
	}
	name := strings.ToLower(strings.TrimSpace(in.Name))
	keys := pantryCovers(name, memberLanguage(c.Context(), a.DB, userID(c)))
	_, e := a.DB.Exec(c.Context(), `INSERT INTO pantry(id,user_id,name,quantity,expires_on,food_keys,food_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,name) DO UPDATE SET quantity=excluded.quantity,expires_on=excluded.expires_on,food_keys=excluded.food_keys,food_version=excluded.food_version`, uuid.NewString(), userID(c), name, in.Quantity, in.ExpiresOn, keys, foodVersion)
	if e != nil {
		return e
	}
	return c.Status(201).JSON(fiber.Map{"ok": true})
}
func (a *App) deletePantry(c fiber.Ctx) error { return a.deleteOwned(c, "pantry", "user_id") }
