package app

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// socialRoutes registers imports, variations, comments, "I cooked this" and shared cookbooks.
func (a *App) socialRoutes(v fiber.Router) {
	v.Post("/recipes/import", a.requireAuth, perUser(20, time.Hour), a.importRecipe)
	v.Get("/recipes/:id/variations", a.variations)
	v.Get("/recipes/:id/comments", a.comments)
	v.Post("/recipes/:id/comments", a.requireAuth, perUser(30, time.Hour), a.addComment)
	v.Delete("/comments/:id", a.requireAuth, a.deleteComment)
	v.Get("/recipes/:id/cooks", a.cooks)
	v.Post("/recipes/:id/cooked", a.requireAuth, a.cooked)
	v.Delete("/recipes/:id/cooked", a.requireAuth, a.uncooked)
	v.Patch("/collections/:id", a.requireAuth, a.updateCollection)
	v.Get("/cookbooks/:id", a.cookbook)
	v.Get("/creators/:id/cookbooks", a.creatorCookbooks)
}

// commentJSON is comment m by u on recipe r. The viewer ($2, "" for a guest) can delete their
// own comments and any on their recipes.
const commentJSON = `jsonb_build_object('id',m.id,'body',m.body,'parentId',m.parent_id,'createdAt',m.created_at,'updatedAt',m.updated_at,
 'author',jsonb_build_object('id',u.id,'name',u.name,'handle',u.handle,'avatar',u.avatar),'canDelete',$2<>'' AND (m.user_id=$2 OR r.author_id=$2))`

// commentsSQL lists recipe $1's comments for viewer $2, oldest first, replies among them
// (parentId), on a recipe the viewer can see. Suspended members' comments, and the replies to
// them, stay hidden.
const commentsSQL = `SELECT ` + commentJSON + ` FROM comments m JOIN users u ON u.id=m.user_id AND u.suspended_at IS NULL
 JOIN recipes r ON r.id=m.recipe_id JOIN users ra ON ra.id=r.author_id AND ra.suspended_at IS NULL
 WHERE m.recipe_id=$1 AND (r.published OR r.author_id=$2)
 AND (m.parent_id IS NULL OR EXISTS(SELECT 1 FROM comments p JOIN users pu ON pu.id=p.user_id AND pu.suspended_at IS NULL WHERE p.id=m.parent_id))
 ORDER BY m.created_at,m.id LIMIT $3 OFFSET $4`

func (a *App) comments(c fiber.Ctx) error {
	viewer, e := a.sessionUser(c)
	if e != nil {
		return e
	}
	limit, offset := pageParams(c, 50, 50)
	return a.queryMany(c, commentsSQL, c.Params("id"), viewer, limit, offset)
}

// addComment comments on a published recipe, or replies to a comment on it. Replies stay one
// level deep: answering a reply answers the comment it replies to.
func (a *App) addComment(c fiber.Ctx) error {
	var in struct {
		Body     string
		ParentID string `json:"parentId"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	body := strings.TrimSpace(in.Body)
	if !validText(body, 1, 1000) {
		return fiber.NewError(400, "Write a comment of up to 1,000 characters.")
	}
	ctx, recipe := c.Context(), c.Params("id")
	var parent *string
	if id := strings.TrimSpace(in.ParentID); id != "" {
		var root string
		e := a.DB.QueryRow(ctx, `SELECT COALESCE(m.parent_id,m.id) FROM comments m JOIN users u ON u.id=m.user_id AND u.suspended_at IS NULL WHERE m.id=$1 AND m.recipe_id=$2`, id, recipe).Scan(&root)
		if errors.Is(e, pgx.ErrNoRows) {
			return fiber.NewError(404, "Comment not found.")
		}
		if e != nil {
			return e
		}
		parent = &root
	}
	var b []byte
	e := a.DB.QueryRow(ctx, `WITH m AS (INSERT INTO comments(id,recipe_id,user_id,parent_id,body)
 SELECT $1,r.id,$2,$4,$5 FROM recipes r JOIN users ra ON ra.id=r.author_id AND ra.suspended_at IS NULL WHERE r.id=$3 AND r.published RETURNING *)
SELECT `+commentJSON+` FROM m JOIN users u ON u.id=m.user_id JOIN recipes r ON r.id=m.recipe_id`, uuid.NewString(), userID(c), recipe, parent, body).Scan(&b)
	// A recipe or comment deleted meanwhile fails the reference instead.
	if errors.Is(e, pgx.ErrNoRows) || pgCode(e) == "23503" {
		return fiber.NewError(404, "Recipe not found.")
	}
	if e != nil {
		return e
	}
	return c.Status(201).Type("json").Send(b)
}

// deleteComment removes the member's own comment, or one on their recipe, with its replies.
func (a *App) deleteComment(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `DELETE FROM comments m USING recipes r WHERE m.id=$1 AND r.id=m.recipe_id AND (m.user_id=$2 OR r.author_id=$2)`, c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Comment not found.")
	}
	return c.SendStatus(204)
}

// cooksSQL lists who cooked published recipe $1, most recent first.
const cooksSQL = `SELECT jsonb_build_object('id',k.id,'photo',k.photo,'note',k.note,'createdAt',k.created_at,
 'author',jsonb_build_object('id',u.id,'name',u.name,'handle',u.handle,'avatar',u.avatar))
 FROM cooks k JOIN users u ON u.id=k.user_id AND u.suspended_at IS NULL
 JOIN recipes r ON r.id=k.recipe_id AND r.published JOIN users ra ON ra.id=r.author_id AND ra.suspended_at IS NULL
 WHERE k.recipe_id=$1 ORDER BY k.created_at DESC,k.id LIMIT $2 OFFSET $3`

func (a *App) cooks(c fiber.Ctx) error {
	limit, offset := pageParams(c, 30, 30)
	return a.queryMany(c, cooksSQL, c.Params("id"), limit, offset)
}

// cooked records that the member cooked a published recipe, once per member and recipe:
// cooking it again moves it up the list and keeps the photo or note it doesn't send.
func (a *App) cooked(c fiber.Ctx) error {
	var in struct{ Photo, Note *string }
	if len(c.Body()) > 0 {
		if e := decode(c, &in); e != nil {
			return e
		}
	}
	ctx, recipe, me := c.Context(), c.Params("id"), userID(c)
	if in.Note != nil {
		note := strings.TrimSpace(*in.Note)
		if utf8.RuneCountInString(note) > 500 {
			return fiber.NewError(400, "Keep your note to 500 characters or fewer.")
		}
		in.Note = &note
	}
	if in.Photo != nil {
		photo := strings.TrimSpace(*in.Photo)
		if !validMedia(photo) {
			return fiber.NewError(400, "Media must use an HTTPS URL.")
		}
		if !a.allowedMedia(photo) {
			// Like a recipe's media, the photo already here stays valid.
			var stored string
			e := a.DB.QueryRow(ctx, `SELECT photo FROM cooks WHERE user_id=$1 AND recipe_id=$2`, me, recipe).Scan(&stored)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			if stored != photo {
				return fiber.NewError(400, "Add photos and videos by uploading them to Savorly.")
			}
		}
		in.Photo = &photo
	}
	r, e := a.DB.Exec(ctx, `INSERT INTO cooks(id,user_id,recipe_id,photo,note)
 SELECT $1,$2,r.id,COALESCE($4,''),COALESCE($5,'') FROM recipes r JOIN users ra ON ra.id=r.author_id AND ra.suspended_at IS NULL WHERE r.id=$3 AND r.published
 ON CONFLICT (user_id,recipe_id) DO UPDATE SET photo=COALESCE($4,cooks.photo),note=COALESCE($5,cooks.note),created_at=now()`, uuid.NewString(), me, recipe, in.Photo, in.Note)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Recipe not found.")
	}
	var n int
	if e = a.DB.QueryRow(ctx, `SELECT count(*) FROM cooks WHERE recipe_id=$1`, recipe).Scan(&n); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"cooked": true, "cookedCount": n})
}

func (a *App) uncooked(c fiber.Ctx) error {
	if _, e := a.DB.Exec(c.Context(), `DELETE FROM cooks WHERE user_id=$1 AND recipe_id=$2`, userID(c), c.Params("id")); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// pgCode is a database error's SQLSTATE, or "".
func pgCode(e error) string {
	var pe *pgconn.PgError
	if errors.As(e, &pe) {
		return pe.Code
	}
	return ""
}
