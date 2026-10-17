package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgconn"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// A single projection keeps discovery, detail, and cookbook responses consistent. Counts are
// index lookups, like the reviews and saves ones. derivedFrom names the original only while
// it's public, so a variation never shows the title of a draft, its own author's included.
const recipeJSON = `jsonb_build_object(
 'id',r.id,'title',r.title,'description',r.description,'cuisine',r.cuisine,
 'minutes',r.minutes,'servings',r.servings,'difficulty',r.difficulty,'image',r.image,'photos',r.photos,'video',r.video,
 'ingredients',r.ingredients,'steps',r.steps,'tags',r.tags,'calories',r.calories,'aiGenerated',r.ai_generated,
 'published',r.published,'createdAt',r.created_at,'language',r.language,'sourceUrl',r.source_url,
 'allergens',r.allergens,'ingredientFood',r.ingredient_food,
 'derivedFrom',(SELECT jsonb_build_object('id',d.id,'title',d.title,'author',jsonb_build_object('id',du.id,'name',du.name,'handle',du.handle))
   FROM recipes d JOIN users du ON du.id=d.author_id AND du.suspended_at IS NULL WHERE d.id=r.derived_from AND d.published),
 'rating',COALESCE((SELECT round(avg(rating),1) FROM reviews WHERE recipe_id=r.id),0),
 'reviewCount',(SELECT count(*) FROM reviews WHERE recipe_id=r.id),
 'saveCount',(SELECT count(*) FROM saves WHERE recipe_id=r.id),
 'variationCount',(SELECT count(*) FROM recipes v WHERE v.derived_from=r.id AND v.published),
 'commentCount',(SELECT count(*) FROM comments WHERE recipe_id=r.id),
 'cookedCount',(SELECT count(*) FROM cooks WHERE recipe_id=r.id),
 'author',jsonb_build_object('id',u.id,'name',u.name,'handle',u.handle,'avatar',u.avatar,'bio',u.bio))`

// Suspended members' recipes leave every public and sous-chef view; admin views join directly.
const recipeFrom = ` FROM recipes r JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL `

func (a *App) queryOne(c fiber.Ctx, sql string, args ...any) error {
	var b []byte
	e := a.DB.QueryRow(c.Context(), sql, args...).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "This item could not be found.")
	}
	if e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}
func (a *App) queryMany(c fiber.Ctx, sql string, args ...any) error {
	rows, e := a.DB.Query(c.Context(), sql, args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			return e
		}
		out = append(out, json.RawMessage(b))
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return c.JSON(out)
}
func (a *App) listRecipes(c fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "60"))
	if limit < 1 || limit > 60 {
		limit = 60
	}
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	if offset < 0 || offset > 10000 {
		offset = 0
	}
	maxMinutes, _ := strconv.Atoi(c.Query("maxMinutes"))
	q := recipeQuery{Text: strings.TrimSpace(c.Query("q")), Cuisine: c.Query("category"), Author: c.Query("author"), Tag: c.Query("tag"), Sort: c.Query("sort"), MaxMinutes: maxMinutes, Limit: limit, Offset: offset}
	if c.Query("following") == "true" {
		// The kitchen-activity sheet: newest from the cooks this member follows.
		var e error
		if q.Follower, e = a.sessionUser(c); e != nil {
			return e
		}
		if q.Follower == "" {
			return fiber.NewError(401, "Sign in to your kitchen to continue.")
		}
	}
	if c.Query("fits") == "me" {
		// Only what fits the member's diets and allergies; a guest's list is everything.
		me, e := a.viewer(c)
		if e != nil {
			return e
		}
		if q.AvoidGroups, q.AvoidTerms, e = avoidOf(c.Context(), a.DB, me); e != nil {
			return e
		}
	}
	sql, args, ok := q.build()
	if !ok {
		return c.JSON([]json.RawMessage{})
	}
	return a.queryMany(c, sql, args...)
}
func (a *App) getRecipe(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT `+recipeJSON+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=(SELECT user_id FROM sessions WHERE token_hash=$2 AND expires_at>now()))`, c.Params("id"), hashToken(token(c)))
}
func (a *App) createRecipe(c fiber.Ctx) error { return a.writeRecipe(c, false) }
func (a *App) updateRecipe(c fiber.Ctx) error { return a.writeRecipe(c, true) }
func (a *App) writeRecipe(c fiber.Ctx, update bool) error {
	var r RecipeInput
	if e := decode(c, &r); e != nil {
		return e
	}
	if e := r.Validate(); e != nil {
		return e
	}
	id := uuid.NewString()
	if update {
		id = c.Params("id")
	} else {
		c.Status(201)
	}
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	if e = a.checkRecipeMedia(c.Context(), tx, userID(c), id, r, update); e != nil {
		return e
	}
	if e = checkDerivedFrom(c.Context(), tx, userID(c), id, r.DerivedFrom); e != nil {
		return e
	}
	if update {
		// Lock linked conversations before modifying the recipe, matching the media worker.
		if _, e = tx.Exec(c.Context(), `SELECT id FROM voice_projects WHERE recipe_id=$1 FOR UPDATE`, id); e != nil {
			return e
		}
	}
	if e = moderationHold(c.Context(), tx, id, userID(c), r.Published); e != nil {
		return e
	}
	if e = persistRecipe(c.Context(), tx, userID(c), id, r, update); e != nil {
		return e
	}
	if update {
		if _, e = tx.Exec(c.Context(), `UPDATE voice_projects SET revision=revision+1,confirmed_revision=-1,auto_media=false,status=CASE WHEN $2 THEN 'published' ELSE 'draft' END,updated_at=now() WHERE recipe_id=$1`, id, r.Published); e != nil {
			return e
		}
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	return a.queryOne(c, `SELECT `+recipeJSON+recipeFrom+`WHERE r.id=$1`, id)
}

type recipeWriter interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func persistRecipe(ctx context.Context, db recipeWriter, owner, id string, r RecipeInput, update bool) error {
	if r.Tags == nil {
		r.Tags = []string{}
	}
	// Writers that don't know about the gallery (the studio) send no photos and keep it intact.
	var photos any
	if r.Photos != nil {
		photos = jsonBytes(r.Photos)
	}
	if update {
		var saved []Step
		e := db.QueryRow(ctx, `SELECT steps FROM recipes WHERE id=$1 AND author_id=$2`, id, owner).Scan(&saved)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		keepStepMedia(r.Steps, saved)
	}
	// Older clients send neither a source nor an original (nil): a saved recipe keeps its own.
	var source, derived any
	if r.SourceURL != nil {
		source = *r.SourceURL
	}
	if r.DerivedFrom.Set {
		derived = r.DerivedFrom.ID
	}
	args := []any{id, owner, r.Title, r.Description, r.Cuisine, r.Minutes, r.Servings, r.Difficulty, r.Image, r.Video, jsonBytes(r.Ingredients), jsonBytes(r.Steps), r.Tags, r.Calories, r.AIGenerated, r.Published, photos, r.Language, source, derived}
	query := `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,image,video,ingredients,steps,tags,calories,ai_generated,published,photos,language,source_url,derived_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17::jsonb,'[]'),$18,COALESCE($19,''),` + linkableRecipe + `)`
	if update {
		// Older clients don't send a language; theirs is kept.
		query = `UPDATE recipes SET title=$3,description=$4,cuisine=$5,minutes=$6,servings=$7,difficulty=$8,image=$9,video=$10,ingredients=$11,steps=$12,tags=$13,calories=$14,ai_generated=$15,published=$16,photos=COALESCE($17::jsonb,photos),language=COALESCE(NULLIF($18,''),language),
 source_url=COALESCE($19,source_url),derived_from=CASE WHEN $20::text IS NULL OR $20=derived_from THEN derived_from ELSE ` + linkableRecipe + ` END,updated_at=now() WHERE id=$1 AND author_id=$2`
	}
	result, e := db.Exec(ctx, query, args...)
	if e == nil && result.RowsAffected() == 0 {
		return fiber.NewError(404, "Recipe not found or you are not its author.")
	}
	if e != nil {
		return e
	}
	// In the same transaction, so the saved recipe is never shown without its allergens.
	return indexRecipeFood(ctx, db, id)
}

func (a *App) deleteRecipe(c fiber.Ctx) error { return a.deleteOwned(c, "recipes", "author_id") }

// Identifiers passed to this helper are compile-time constants, never request input.
func (a *App) deleteOwned(c fiber.Ctx, table, column string) error {
	r, e := a.DB.Exec(c.Context(), fmt.Sprintf("DELETE FROM %s WHERE id=$1 AND %s=$2", table, column), c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Item not found.")
	}
	return c.SendStatus(204)
}

const creatorJSON = `jsonb_build_object('id',u.id,'name',u.name,'handle',u.handle,'bio',u.bio,'avatar',u.avatar,'recipeCount',(SELECT count(*) FROM recipes WHERE author_id=u.id AND published),'followerCount',(SELECT count(*) FROM follows WHERE creator_id=u.id))`

func (a *App) creators(c fiber.Ctx) error {
	limit, offset := pageParams(c, 40, 100)
	return a.queryMany(c, `SELECT `+creatorJSON+` FROM users u WHERE u.suspended_at IS NULL AND EXISTS(SELECT 1 FROM recipes WHERE author_id=u.id AND published) ORDER BY (SELECT count(*) FROM follows WHERE creator_id=u.id) DESC,u.created_at,u.id LIMIT $1 OFFSET $2`, limit, offset)
}

// pageParams reads limit (1..max, else def) and offset (0..10000, else 0).
func pageParams(c fiber.Ctx, def, max int) (int, int) {
	limit, e := strconv.Atoi(c.Query("limit"))
	if e != nil || limit < 1 || limit > max {
		limit = def
	}
	offset, e := strconv.Atoi(c.Query("offset"))
	if e != nil || offset < 0 || offset > 10000 {
		offset = 0
	}
	return limit, offset
}
func (a *App) creator(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT `+creatorJSON+` FROM users u WHERE id=$1 AND u.suspended_at IS NULL`, c.Params("id"))
}
func (a *App) follow(c fiber.Ctx) error {
	if userID(c) == c.Params("id") {
		return fiber.NewError(400, "You cannot follow yourself.")
	}
	r, e := a.DB.Exec(c.Context(), `INSERT INTO follows(user_id,creator_id) SELECT $1,id FROM users WHERE id=$2 ON CONFLICT(user_id,creator_id) DO UPDATE SET creator_id=excluded.creator_id`, userID(c), c.Params("id"))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Cook not found.")
	}
	return c.JSON(fiber.Map{"following": true})
}
func (a *App) unfollow(c fiber.Ctx) error {
	_, e := a.DB.Exec(c.Context(), `DELETE FROM follows WHERE user_id=$1 AND creator_id=$2`, userID(c), c.Params("id"))
	if e != nil {
		return e
	}
	return c.SendStatus(204)
}
func (a *App) reviews(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT jsonb_build_object('id',v.id,'rating',v.rating,'body',v.body,'createdAt',v.created_at,'updatedAt',v.updated_at,'author',jsonb_build_object('id',u.id,'name',u.name,'avatar',u.avatar),
 'reply',CASE WHEN v.reply<>'' THEN jsonb_build_object('body',v.reply,'repliedAt',v.replied_at) END) FROM reviews v JOIN users u ON u.id=v.user_id AND u.suspended_at IS NULL JOIN recipes r ON r.id=v.recipe_id WHERE v.recipe_id=$1 AND r.published ORDER BY v.created_at DESC LIMIT 100`, c.Params("id"))
}
func (a *App) review(c fiber.Ctx) error {
	var in struct {
		Rating int
		Body   string
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Rating < 1 || in.Rating > 5 || !validText(in.Body, 3, 2000) {
		return fiber.NewError(400, "Choose a rating and write at least 3 characters.")
	}
	r, e := a.DB.Exec(c.Context(), `INSERT INTO reviews(id,user_id,recipe_id,rating,body) SELECT $1,$2,id,$4,$5 FROM recipes WHERE id=$3 AND published AND author_id<>$2 ON CONFLICT(user_id,recipe_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,updated_at=now()`, uuid.NewString(), userID(c), c.Params("id"), in.Rating, strings.TrimSpace(in.Body))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(400, "You can only review other cooks' published recipes.")
	}
	return c.JSON(fiber.Map{"ok": true})
}
func (a *App) deleteReview(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `DELETE FROM reviews WHERE recipe_id=$1 AND user_id=$2`, c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Review not found.")
	}
	return c.SendStatus(204)
}

// reviewReply lets a recipe's author answer a review of it; sending again changes the answer.
func (a *App) reviewReply(c fiber.Ctx) error {
	var in struct{ Body string }
	if e := decode(c, &in); e != nil {
		return e
	}
	body := strings.TrimSpace(in.Body)
	if !validText(body, 2, 1000) {
		return fiber.NewError(400, "Write a reply of up to 1,000 characters.")
	}
	var replied time.Time
	e := a.DB.QueryRow(c.Context(), `UPDATE reviews v SET reply=$4,replied_at=now() FROM recipes r
 WHERE v.id=$2 AND v.recipe_id=$1 AND r.id=v.recipe_id AND r.author_id=$3 RETURNING v.replied_at`, c.Params("id"), c.Params("review"), userID(c), body).Scan(&replied)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Review not found.")
	}
	if e != nil {
		return e
	}
	return c.JSON(fiber.Map{"reply": fiber.Map{"body": body, "repliedAt": replied}})
}

// deleteReviewReply removes the recipe author's answer to a review.
func (a *App) deleteReviewReply(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `UPDATE reviews v SET reply='',replied_at=NULL FROM recipes r
 WHERE v.id=$2 AND v.recipe_id=$1 AND r.id=v.recipe_id AND r.author_id=$3 AND v.reply<>''`, c.Params("id"), c.Params("review"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Review not found.")
	}
	return c.SendStatus(204)
}

func (a *App) report(c fiber.Ctx) error {
	var in struct{ Reason string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Reason, 5, 1000) {
		return fiber.NewError(400, "Tell us what needs a closer look (5–1000 characters).")
	}
	r, e := a.DB.Exec(c.Context(), `INSERT INTO reports(id,user_id,recipe_id,reason) SELECT $1,$2,id,$4 FROM recipes WHERE id=$3 AND published ON CONFLICT(user_id,recipe_id) DO UPDATE SET reason=excluded.reason,status='open',created_at=now(),resolution='',resolved_by=NULL,resolved_at=NULL`, uuid.NewString(), userID(c), c.Params("id"), in.Reason)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Recipe not found.")
	}
	return c.JSON(fiber.Map{"ok": true})
}

// recipeRoutes registers the feed, sitemap, library, planner, review and upload routes added
// after the original set in NewWithContext.
func (a *App) recipeRoutes(v fiber.Router) {
	v.Get("/feed", a.feed)
	v.Get("/sitemap", a.sitemap)
	v.Delete("/recipes/:id/review", a.requireAuth, a.deleteReview)
	v.Put("/recipes/:id/reviews/:review/reply", a.requireAuth, a.reviewReply)
	v.Delete("/recipes/:id/reviews/:review/reply", a.requireAuth, a.deleteReviewReply)
	v.Get("/library/recipes", a.requireAuth, a.libraryRecipes)
	v.Post("/planner/groceries", a.requireAuth, a.planGroceries)
	v.Post("/media/uploads", a.requireAuth, uploadLimit(), a.createUpload)
	v.Post("/media/uploads/complete", a.requireAuth, a.completeUpload)
}
