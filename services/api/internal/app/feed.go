package app

import (
	"errors"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// sessionUser is the signed-in member on a route that doesn't require one, or "".
func (a *App) sessionUser(c fiber.Ctx) (string, error) {
	if token(c) == "" {
		return "", nil
	}
	var id string
	e := a.DB.QueryRow(c.Context(), `SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.suspended_at IS NULL`, hashToken(token(c))).Scan(&id)
	if errors.Is(e, pgx.ErrNoRows) {
		return "", nil
	}
	return id, e
}

// The home feed, ranked here rather than from whatever page of recipes the app holds.
// Trending is this week's saves with the newest recipes as the fallback, and the hero is the
// most saved of those with a photo. A cook-tested recipe (cook_insights.go) ranks as if it had
// half as many saves again, and at least two more: people cooked it through, so it's a safer bet. The hero isn't repeated in trending or quick; those two
// can overlap, so the app skips in one shelf what it already shows in the other.
const feedSQL = `WITH me AS (SELECT s.user_id FROM sessions s JOIN users x ON x.id=s.user_id AND x.suspended_at IS NULL WHERE s.token_hash=$1 AND s.expires_at>now()),
hot AS (SELECT recipe_id,count(*) AS saves FROM saves WHERE created_at>now()-interval '7 days' GROUP BY recipe_id),
pool AS (SELECT r.id,r.image<>'' AS pictured,r.created_at,COALESCE(h.saves,0)+CASE WHEN t.cooks>=5 THEN greatest(2,COALESCE(h.saves,0)/2.0) ELSE 0 END AS saves` + recipeFrom + `LEFT JOIN hot h ON h.recipe_id=r.id
 LEFT JOIN recipe_cook_times t ON t.recipe_id=r.id WHERE r.published AND (h.recipe_id IS NOT NULL OR r.id IN (SELECT id FROM recipes WHERE published ORDER BY created_at DESC LIMIT 100))),
hero AS (SELECT id FROM (
 (SELECT id,saves,created_at FROM pool WHERE pictured ORDER BY saves DESC,created_at DESC,id LIMIT 1)
 UNION ALL (SELECT r.id,0,r.created_at` + recipeFrom + `WHERE r.published AND r.image<>'' ORDER BY r.created_at DESC,r.id LIMIT 1)) x
 ORDER BY saves DESC,created_at DESC,id LIMIT 1),
trending AS (SELECT id,row_number() OVER (ORDER BY saves DESC,created_at DESC,id) AS n FROM pool WHERE id NOT IN (SELECT id FROM hero) ORDER BY n LIMIT $2),
quick AS (SELECT r.id,row_number() OVER (ORDER BY r.created_at DESC,r.id) AS n` + recipeFrom + `WHERE r.published AND r.minutes<=30
 AND r.id NOT IN (SELECT id FROM hero) ORDER BY r.created_at DESC,r.id LIMIT $2),
following AS (SELECT r.id,row_number() OVER (ORDER BY r.created_at DESC,r.id) AS n` + recipeFrom + `WHERE r.published
 AND r.author_id IN (SELECT f.creator_id FROM follows f JOIN me ON me.user_id=f.user_id) ORDER BY r.created_at DESC,r.id LIMIT $2),
newest AS (SELECT r.id,row_number() OVER (ORDER BY r.created_at DESC,r.id) AS n` + recipeFrom + `WHERE r.published ORDER BY r.created_at DESC,r.id LIMIT $2)
SELECT jsonb_build_object(
 'hero',(SELECT ` + recipeJSON + ` FROM hero x JOIN recipes r ON r.id=x.id JOIN users u ON u.id=r.author_id),
 'trending',COALESCE((SELECT jsonb_agg(` + recipeJSON + ` ORDER BY x.n) FROM trending x JOIN recipes r ON r.id=x.id JOIN users u ON u.id=r.author_id),'[]'),
 'quick',COALESCE((SELECT jsonb_agg(` + recipeJSON + ` ORDER BY x.n) FROM quick x JOIN recipes r ON r.id=x.id JOIN users u ON u.id=r.author_id),'[]'),
 'following',COALESCE((SELECT jsonb_agg(` + recipeJSON + ` ORDER BY x.n) FROM following x JOIN recipes r ON r.id=x.id JOIN users u ON u.id=r.author_id),'[]'),
 'newest',COALESCE((SELECT jsonb_agg(` + recipeJSON + ` ORDER BY x.n) FROM newest x JOIN recipes r ON r.id=x.id JOIN users u ON u.id=r.author_id),'[]'))`

func (a *App) feed(c fiber.Ctx) error {
	limit, _ := pageParams(c, 12, 24)
	return a.queryOne(c, feedSQL, hashToken(token(c)), limit)
}
