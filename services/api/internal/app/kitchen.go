package app

import (
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

func (a *App) library(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT jsonb_build_object(
 'savedIds',COALESCE((SELECT jsonb_agg(recipe_id) FROM saves WHERE user_id=$1),'[]'),
 'saves',COALESCE((SELECT jsonb_agg(jsonb_build_object('recipeId',recipe_id,'collectionId',collection_id)) FROM saves WHERE user_id=$1),'[]'),
 'collections',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name)) FROM collections WHERE user_id=$1),'[]'),
 'followingIds',COALESCE((SELECT jsonb_agg(creator_id) FROM follows WHERE user_id=$1),'[]'),
 'recipes',COALESCE((SELECT jsonb_agg(`+recipeJSON+`)`+recipeFrom+`WHERE (r.published AND r.id IN(SELECT recipe_id FROM saves WHERE user_id=$1)) OR r.author_id=$1),'[]'))`, userID(c))
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
func (a *App) kitchen(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT jsonb_build_object(
 'plans',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'recipeId',p.recipe_id,'day',p.day,'meal',p.meal,'servings',p.servings,'recipe',`+recipeJSON+`)) FROM meal_plans p JOIN recipes r ON r.id=p.recipe_id JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL WHERE p.user_id=$1),'[]'),
 'groceries',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'quantity',quantity,'category',category,'checked',checked) ORDER BY created_at) FROM groceries WHERE user_id=$1),'[]'),
 'pantry',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'quantity',quantity,'expiresOn',expires_on)) FROM pantry WHERE user_id=$1),'[]'))`, userID(c))
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
	r, e := a.DB.Exec(c.Context(), `INSERT INTO meal_plans(id,user_id,recipe_id,day,meal,servings) SELECT $1,$2,id,$4,$5,$6 FROM recipes WHERE id=$3 AND published ON CONFLICT(user_id,day,meal) DO UPDATE SET recipe_id=excluded.recipe_id,servings=excluded.servings`, uuid.NewString(), userID(c), in.RecipeID, in.Day, in.Meal, in.Servings)
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
	_, e := a.DB.Exec(c.Context(), `INSERT INTO groceries(id,user_id,name,quantity,category) VALUES($1,$2,$3,$4,$5)`, uuid.NewString(), userID(c), strings.TrimSpace(in.Name), in.Quantity, in.Category)
	if e != nil {
		return e
	}
	return c.Status(201).JSON(fiber.Map{"ok": true})
}
func (a *App) checkGrocery(c fiber.Ctx) error {
	var in struct{ Checked bool }
	if e := decode(c, &in); e != nil {
		return e
	}
	r, e := a.DB.Exec(c.Context(), `UPDATE groceries SET checked=$3 WHERE id=$1 AND user_id=$2`, c.Params("id"), userID(c), in.Checked)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Item not found.")
	}
	return c.SendStatus(204)
}
func (a *App) deleteGrocery(c fiber.Ctx) error { return a.deleteOwned(c, "groceries", "user_id") }
func (a *App) recipeGroceries(c fiber.Ctx) error {
	var in struct{ Servings int }
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Servings < 1 || in.Servings > 100 {
		return fiber.NewError(400, "Choose 1–100 servings.")
	}
	var ingredients []Ingredient
	var servings int
	if e := a.DB.QueryRow(c.Context(), `SELECT ingredients,servings FROM recipes WHERE id=$1 AND published`, c.Params("id")).Scan(&ingredients, &servings); e != nil {
		return fiber.NewError(404, "Recipe not found.")
	}
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	for _, i := range ingredients {
		_, e = tx.Exec(c.Context(), `INSERT INTO groceries(id,user_id,name,quantity,category) VALUES($1,$2,$3,$4,$5)`, uuid.NewString(), userID(c), i.Name, fmt.Sprintf("%g %s", i.Amount*float64(in.Servings)/float64(servings), i.Unit), i.Category)
		if e != nil {
			return e
		}
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"added": len(ingredients)})
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
	_, e := a.DB.Exec(c.Context(), `INSERT INTO pantry(id,user_id,name,quantity,expires_on) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,name) DO UPDATE SET quantity=excluded.quantity,expires_on=excluded.expires_on`, uuid.NewString(), userID(c), strings.ToLower(strings.TrimSpace(in.Name)), in.Quantity, in.ExpiresOn)
	if e != nil {
		return e
	}
	return c.Status(201).JSON(fiber.Map{"ok": true})
}
func (a *App) deletePantry(c fiber.Ctx) error { return a.deleteOwned(c, "pantry", "user_id") }
