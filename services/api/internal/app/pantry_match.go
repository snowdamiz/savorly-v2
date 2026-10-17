package app

import (
	"context"
	"slices"

	"github.com/gofiber/fiber/v3"
)

// Cooking from the pantry: which recipes the member's pantry goes furthest toward, by what each
// ingredient is (food.go) rather than by spelling, so "Cheddar" covers "grated cheese" and
// "Zitronen" covers "lemon juice". Staples (water, salt, pepper, oil, ice) count as in every
// kitchen. Recipes with what the member avoids aren't suggested.

// foodRoutes registers what the ingredient index answers beyond recipe JSON.
func (a *App) foodRoutes(v fiber.Router) {
	v.Get("/kitchen/pantry-recipes", a.requireAuth, a.pantryRecipes)
}

// stapleKeys is staples as an array for SQL.
func stapleKeys() []string {
	out := make([]string, 0, len(staples))
	for k := range staples {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// pantryCoverOf is every key the member's pantry covers; expiring is those of items that expire
// within days days (of the server's date: a day either way changes little here).
func pantryCoverOf(ctx context.Context, db recipeWriter, user string, days int) (cover, expiring []string, err error) {
	err = db.QueryRow(ctx, `SELECT COALESCE(array_agg(DISTINCT k),'{}'),COALESCE(array_agg(DISTINCT k) FILTER (WHERE p.expires_on<=current_date+$2::int),'{}')
 FROM pantry p, unnest(p.food_keys) k WHERE p.user_id=$1`, user, days).Scan(&cover, &expiring)
	return cover, expiring, err
}

// pantryMatchSQL ranks the recipes ($1's own and published ones) that use something in the
// pantry ($2) for at least half of what they need: fewest missing first, then those that use
// what is about to expire ($3), then those that use the most. Staples ($4) are neither needed
// nor counted; recipes with an avoided group ($5) or term ($6) are left out.
const pantryMatchSQL = `WITH scored AS (
 SELECT r.id,
  (SELECT count(*) FROM unnest(r.ingredient_keys) k WHERE k<>'' AND NOT k=ANY($4)) AS needed,
  (SELECT count(*) FROM unnest(r.ingredient_keys) k WHERE k=ANY($2) AND NOT k=ANY($4)) AS have,
  (SELECT count(*) FROM unnest(r.ingredient_keys) k WHERE k=ANY($3)) AS expiring
 FROM recipes r JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL
 WHERE (r.published OR r.author_id=$1) AND r.ingredient_keys && $2 AND NOT r.allergens && $5 AND NOT r.food_terms && $6
), ranked AS (
 SELECT id,have,needed,expiring FROM scored WHERE have>0 AND have*2>=needed
 ORDER BY needed-have,expiring DESC,have DESC,id LIMIT $7
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('recipe',` + recipeJSON + `,
 'have',(SELECT COALESCE(jsonb_agg(i.v->>'name' ORDER BY i.n),'[]') FROM jsonb_array_elements(r.ingredients) WITH ORDINALITY i(v,n) WHERE r.ingredient_keys[i.n::int]=ANY($2) AND NOT r.ingredient_keys[i.n::int]=ANY($4)),
 'missing',(SELECT COALESCE(jsonb_agg(i.v->>'name' ORDER BY i.n),'[]') FROM jsonb_array_elements(r.ingredients) WITH ORDINALITY i(v,n) WHERE r.ingredient_keys[i.n::int]<>'' AND NOT r.ingredient_keys[i.n::int]=ANY($2) AND NOT r.ingredient_keys[i.n::int]=ANY($4)),
 'expiring',(SELECT COALESCE(jsonb_agg(i.v->>'name' ORDER BY i.n),'[]') FROM jsonb_array_elements(r.ingredients) WITH ORDINALITY i(v,n) WHERE r.ingredient_keys[i.n::int]=ANY($3)))
 ORDER BY x.needed-x.have,x.expiring DESC,x.have DESC,x.id),'[]')
 FROM ranked x JOIN recipes r ON r.id=x.id JOIN users u ON u.id=r.author_id`

// pantryRecipes is GET /kitchen/pantry-recipes?limit=: {matches:[{recipe,have,missing,expiring}]},
// where have, missing and expiring are the recipe's own ingredient names.
func (a *App) pantryRecipes(c fiber.Ctx) error {
	limit, _ := pageParams(c, 12, 24)
	ctx, me := c.Context(), userID(c)
	cover, expiring, e := pantryCoverOf(ctx, a.DB, me, 3)
	if e != nil {
		return e
	}
	if len(cover) == 0 {
		return c.JSON(fiber.Map{"matches": []any{}})
	}
	groups, terms, e := avoidOf(ctx, a.DB, me)
	if e != nil {
		return e
	}
	var b []byte
	if e = a.DB.QueryRow(ctx, pantryMatchSQL, me, cover, expiring, stapleKeys(), groups, terms, limit).Scan(&b); e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(append(append([]byte(`{"matches":`), b...), '}'))
}

// withoutPantry drops the lines the pantry (or any kitchen) already has, saying which.
// languages holds each line's recipe language.
func withoutPantry(lines []groceryLine, languages []string, cover []string) (kept []groceryLine, skipped []string) {
	skipped = []string{}
	for i, l := range lines {
		key := indexIngredient(l.Name, languages[i]).Key
		if staples[key] || (key != "" && slices.Contains(cover, key)) {
			skipped = append(skipped, l.Name)
			continue
		}
		kept = append(kept, l)
	}
	return kept, skipped
}
