package app

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// updateCollection renames, shares or describes one of the member's cookbooks. Fields it
// doesn't send stay as they are.
func (a *App) updateCollection(c fiber.Ctx) error {
	var in struct {
		Name        *string
		Public      *bool
		Description *string
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if !validText(name, 1, 60) {
			return fiber.NewError(400, "Give your cookbook a name (up to 60 characters).")
		}
		in.Name = &name
	}
	if in.Description != nil {
		description := strings.TrimSpace(*in.Description)
		if utf8.RuneCountInString(description) > 300 {
			return fiber.NewError(400, "Keep the description to 300 characters or fewer.")
		}
		in.Description = &description
	}
	var b []byte
	e := a.DB.QueryRow(c.Context(), `UPDATE collections SET name=COALESCE($3,name),public=COALESCE($4,public),description=COALESCE($5,description)
 WHERE id=$1 AND user_id=$2 RETURNING jsonb_build_object('id',id,'name',name,'public',public,'description',description)`,
		c.Params("id"), userID(c), in.Name, in.Public, in.Description).Scan(&b)
	switch {
	case errors.Is(e, pgx.ErrNoRows):
		return fiber.NewError(404, "Cookbook not found.")
	case pgCode(e) == "23505":
		return fiber.NewError(409, "You already have a cookbook with that name.")
	case e != nil:
		return e
	}
	return c.Type("json").Send(b)
}

// cookbookRecipes is what cookbook b shows: the published recipes its owner saved in it, by
// cooks in good standing.
const cookbookRecipes = `SELECT s.recipe_id,s.created_at,r.image FROM saves s JOIN recipes r ON r.id=s.recipe_id AND r.published
 JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL WHERE s.collection_id=b.id AND s.user_id=b.user_id`

// cookbookSQL is cookbook $1's page for viewer $2, its recipes newest saved first ($3 of them
// from $4): anyone may open a shared cookbook, and its owner their own.
const cookbookSQL = `WITH b AS (SELECT k.id,k.user_id,k.name,k.description,k.public FROM collections k JOIN users o ON o.id=k.user_id AND o.suspended_at IS NULL
 WHERE k.id=$1 AND (k.public OR k.user_id=$2)),
listed AS (SELECT x.* FROM b CROSS JOIN LATERAL (` + cookbookRecipes + `) x),
page AS (SELECT ` + recipeJSON + ` AS j,row_number() OVER (ORDER BY l.created_at DESC,r.id DESC)-$4 AS n FROM listed l JOIN recipes r ON r.id=l.recipe_id JOIN users u ON u.id=r.author_id
 ORDER BY l.created_at DESC,r.id DESC LIMIT $3::int+1 OFFSET $4)
SELECT jsonb_build_object('id',b.id,'name',b.name,'description',b.description,'public',b.public,
 'owner',(SELECT ` + creatorJSON + ` FROM users u WHERE u.id=b.user_id),
 'recipeCount',(SELECT count(*) FROM listed),
 'recipes',COALESCE((SELECT jsonb_agg(j ORDER BY n) FROM page WHERE n<=$3),'[]'),
 'hasMore',(SELECT count(*) FROM page)>$3) FROM b`

// cookbook pages its recipes with ?limit (up to 100) and ?offset.
func (a *App) cookbook(c fiber.Ctx) error {
	viewer, e := a.sessionUser(c)
	if e != nil {
		return e
	}
	limit, offset := pageParams(c, 60, 100)
	var b []byte
	e = a.DB.QueryRow(c.Context(), cookbookSQL, c.Params("id"), viewer, limit, offset).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Cookbook not found.")
	}
	if e != nil {
		return e
	}
	return c.Type("json").Send(b)
}

// creatorCookbooksSQL lists cook $1's shared cookbooks that show any recipes, most recently
// added to first, each with the photo of its newest pictured recipe as its cover.
const creatorCookbooksSQL = `SELECT jsonb_build_object('id',b.id,'name',b.name,'description',b.description,'recipeCount',x.n,'cover',COALESCE(x.cover,''))
 FROM collections b JOIN users o ON o.id=b.user_id AND o.suspended_at IS NULL
 CROSS JOIN LATERAL (SELECT count(*) AS n,max(l.created_at) AS last,(array_agg(l.image ORDER BY l.created_at DESC,l.recipe_id DESC) FILTER (WHERE l.image<>''))[1] AS cover
   FROM (` + cookbookRecipes + `) l) x
 WHERE b.user_id=$1 AND b.public AND x.n>0 ORDER BY x.last DESC,b.id LIMIT $2 OFFSET $3`

func (a *App) creatorCookbooks(c fiber.Ctx) error {
	limit, offset := pageParams(c, 50, 100)
	return a.queryMany(c, creatorCookbooksSQL, c.Params("id"), limit, offset)
}
