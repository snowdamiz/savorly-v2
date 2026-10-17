package app

import (
	"context"

	"github.com/gofiber/fiber/v3"
)

// linkableRecipe is the original a recipe write ($1, by $2) may link as derivedFrom ($20): a
// published recipe of a cook in good standing, or one of the writer's own, never the recipe
// itself. Anything else, and "", leaves no link. persistRecipe applies it to every writer,
// the sous-chef's drafts included; checkDerivedFrom tells an app's request why first.
const linkableRecipe = `(SELECT d.id FROM recipes d JOIN users du ON du.id=d.author_id
 WHERE d.id=NULLIF($20,'') AND d.id<>$1 AND (d.author_id=$2 OR (d.published AND du.suspended_at IS NULL)))`

// checkDerivedFrom refuses an original the writer can't link. The original a recipe already
// links stays valid, so a variation of a recipe unpublished since can still be edited.
func checkDerivedFrom(ctx context.Context, q querier, owner, id string, ref RecipeRef) error {
	if !ref.Set || ref.ID == "" {
		return nil
	}
	if ref.ID == id {
		return fiber.NewError(400, "A recipe can’t be a variation of itself.")
	}
	var ok bool
	e := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recipes WHERE id=$3 AND author_id=$2 AND derived_from=$1)
 OR EXISTS(SELECT 1 FROM recipes d JOIN users du ON du.id=d.author_id WHERE d.id=$1 AND (d.author_id=$2 OR (d.published AND du.suspended_at IS NULL)))`, ref.ID, owner, id).Scan(&ok)
	if e != nil {
		return e
	}
	if !ok {
		return fiber.NewError(400, "The original recipe must be published or one of your own.")
	}
	return nil
}

// variationsSQL lists the published recipes that adapt recipe $1, newest first.
const variationsSQL = `SELECT ` + recipeJSON + recipeFrom + `WHERE r.derived_from=$1 AND r.published ORDER BY r.created_at DESC,r.id DESC LIMIT 20`

func (a *App) variations(c fiber.Ctx) error {
	return a.queryMany(c, variationsSQL, c.Params("id"))
}
