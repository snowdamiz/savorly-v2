package app

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

const reportJSON = `jsonb_build_object('id',p.id,'reason',p.reason,'status',p.status,'createdAt',p.created_at,'resolution',p.resolution,'resolvedAt',p.resolved_at,
 'resolvedBy',(SELECT email FROM users WHERE id=p.resolved_by),'reporter',jsonb_build_object('id',x.id,'name',x.name,'email',x.email,'avatar',x.avatar))`

const recipeStats = ` CROSS JOIN LATERAL (SELECT
 (SELECT COALESCE(round(avg(rating),1),0) FROM reviews WHERE recipe_id=r.id) rating,
 (SELECT count(*) FROM reviews WHERE recipe_id=r.id) reviews,
 (SELECT count(*) FROM saves WHERE recipe_id=r.id) saves,
 (SELECT count(*) FROM reports WHERE recipe_id=r.id AND status='open') open,
 (SELECT count(*) FROM reports WHERE recipe_id=r.id) reports) m `

var recipeFilters = map[string]string{
	"published": `r.published`,
	"drafts":    `NOT r.published`,
	"ai":        `r.ai_generated`,
	"reported":  `m.open>0`,
	"suspended": `u.suspended_at IS NOT NULL`,
}
var recipeOrders = map[string]string{
	"newest":  `r.created_at DESC`,
	"updated": `r.updated_at DESC`,
	"reports": `m.open DESC,m.reports DESC,r.created_at DESC`,
	"saves":   `m.saves DESC,r.created_at DESC`,
	"rating":  `m.rating DESC,m.reviews DESC,r.created_at DESC`,
}

func (a *App) adminRecipes(c fiber.Ctx) error {
	filter, ok := recipeFilters[c.Query("filter")]
	if !ok {
		filter = "true"
	}
	order, ok := recipeOrders[c.Query("sort")]
	if !ok {
		order = recipeOrders["newest"]
	}
	return a.adminList(c, `SELECT jsonb_build_object('id',r.id,'title',r.title,'image',r.image,'cuisine',r.cuisine,'published',r.published,'aiGenerated',r.ai_generated,
 'video',r.video<>'','createdAt',r.created_at,'updatedAt',r.updated_at,
 'author',jsonb_build_object('id',u.id,'name',u.name,'handle',u.handle,'email',u.email,'avatar',u.avatar,'suspended',u.suspended_at IS NOT NULL),
 'rating',m.rating,'reviewCount',m.reviews,'saveCount',m.saves,'openReports',m.open,'reportCount',m.reports),count(*) OVER()
 FROM recipes r JOIN users u ON u.id=r.author_id`+recipeStats+`
 WHERE ($1='' OR r.title ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%' OR r.cuisine ILIKE $1 OR r.id=$1 OR r.author_id=$1) AND `+filter+`
 ORDER BY `+order, strings.TrimSpace(c.Query("q")))
}

func (a *App) adminRecipe(c fiber.Ctx) error {
	b, e := a.jsonRow(c.Context(), `SELECT `+recipeJSON+` || jsonb_build_object('updatedAt',r.updated_at,
 'authorEmail',u.email,'authorSuspended',u.suspended_at IS NOT NULL,
 'conversations',(SELECT count(*) FROM voice_projects WHERE recipe_id=r.id),
 'reports',COALESCE((SELECT jsonb_agg(`+reportJSON+` ORDER BY p.created_at DESC) FROM reports p JOIN users x ON x.id=p.user_id WHERE p.recipe_id=r.id),'[]'),
 'history',COALESCE((SELECT jsonb_agg(`+auditJSON+` ORDER BY x.created_at DESC,x.id DESC) FROM admin_actions x WHERE x.target_type='recipe' AND x.target_id=r.id),'[]'))
 FROM recipes r JOIN users u ON u.id=r.author_id WHERE r.id=$1`, c.Params("id"))
	if e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}

// recipeWrite runs fn on a recipe in a transaction and answers with the refreshed recipe.
func (a *App) recipeWrite(c fiber.Ctx, fn func(ctx context.Context, tx pgx.Tx, title, author string) error) error {
	ctx, id := c.Context(), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var title, author string
	e = tx.QueryRow(ctx, `SELECT r.title,u.email FROM recipes r JOIN users u ON u.id=r.author_id WHERE r.id=$1 FOR UPDATE OF r`, id).Scan(&title, &author)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Recipe not found.")
	}
	if e != nil {
		return e
	}
	if e = fn(ctx, tx, title, author); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return a.adminRecipe(c)
}

func resolveReports(ctx context.Context, tx pgx.Tx, c fiber.Ctx, recipe, status, note string) (int64, error) {
	r, e := tx.Exec(ctx, `UPDATE reports SET status=$2,resolution=$3,resolved_by=$4,resolved_at=now() WHERE recipe_id=$1 AND status='open'`, recipe, status, note, userID(c))
	return r.RowsAffected(), e
}

func moderationNote(c fiber.Ctx) (string, error) {
	var in struct{ Note string }
	if len(c.Body()) > 0 {
		if e := decode(c, &in); e != nil {
			return "", e
		}
	}
	if in.Note = strings.TrimSpace(in.Note); len(in.Note) > 1000 {
		return "", fiber.NewError(400, "Keep the note under 1,000 characters.")
	}
	return in.Note, nil
}

// adminPublish takes a recipe out of public view, resolving its open reports. Publishing
// again is only for undoing an admin's unpublish; drafts are the author's to publish.
func (a *App) adminPublish(c fiber.Ctx) error {
	var in struct {
		Published bool
		Note      string
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Note = strings.TrimSpace(in.Note); len(in.Note) > 1000 {
		return fiber.NewError(400, "Keep the note under 1,000 characters.")
	}
	return a.recipeWrite(c, func(ctx context.Context, tx pgx.Tx, title, author string) error {
		id := c.Params("id")
		if in.Published {
			var last string
			_ = tx.QueryRow(ctx, `SELECT action FROM admin_actions WHERE target_type='recipe' AND target_id=$1 ORDER BY id DESC LIMIT 1`, id).Scan(&last)
			if last != "recipe.unpublish" {
				return fiber.NewError(409, "Only the author can publish a draft. Admins can restore recipes an admin unpublished.")
			}
		}
		// Same bookkeeping as an author's edit, so the sous-chef doesn't act on a stale draft.
		if _, e := tx.Exec(ctx, `SELECT id FROM voice_projects WHERE recipe_id=$1 FOR UPDATE`, id); e != nil {
			return e
		}
		r, e := tx.Exec(ctx, `UPDATE recipes SET published=$2,updated_at=now() WHERE id=$1 AND published<>$2`, id, in.Published)
		if e != nil {
			return e
		}
		if r.RowsAffected() == 0 {
			return fiber.NewError(409, "Nothing changed.")
		}
		if _, e = tx.Exec(ctx, `UPDATE voice_projects SET revision=revision+1,confirmed_revision=-1,auto_media=false,status=CASE WHEN $2 THEN 'published' ELSE 'draft' END,updated_at=now() WHERE recipe_id=$1`, id, in.Published); e != nil {
			return e
		}
		if in.Published {
			return audit(ctx, tx, c, "recipe.publish", "recipe", id, fmt.Sprintf("Restored “%s” by %s", title, author), fiber.Map{"note": in.Note})
		}
		n, e := resolveReports(ctx, tx, c, id, "resolved", in.Note)
		if e != nil {
			return e
		}
		return audit(ctx, tx, c, "recipe.unpublish", "recipe", id, fmt.Sprintf("Unpublished “%s” by %s", title, author), fiber.Map{"note": in.Note, "reportsResolved": n})
	})
}

func (a *App) adminResolveReports(c fiber.Ctx) error {
	var in struct{ Status, Note string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Status != "resolved" && in.Status != "dismissed" {
		return fiber.NewError(400, "Resolve or dismiss the reports.")
	}
	if in.Note = strings.TrimSpace(in.Note); len(in.Note) > 1000 {
		return fiber.NewError(400, "Keep the note under 1,000 characters.")
	}
	return a.recipeWrite(c, func(ctx context.Context, tx pgx.Tx, title, author string) error {
		n, e := resolveReports(ctx, tx, c, c.Params("id"), in.Status, in.Note)
		if e != nil {
			return e
		}
		if n == 0 {
			return fiber.NewError(409, "There are no open reports on this recipe.")
		}
		verb := map[string]string{"resolved": "Resolved", "dismissed": "Dismissed"}[in.Status]
		return audit(ctx, tx, c, "reports."+in.Status, "recipe", c.Params("id"), fmt.Sprintf("%s %d report%s on “%s” by %s", verb, n, plural(n), title, author), fiber.Map{"note": in.Note, "count": n})
	})
}

func plural(n int64) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func (a *App) adminDeleteRecipe(c fiber.Ctx) error {
	note, e := moderationNote(c)
	if e != nil {
		return e
	}
	ctx, id := c.Context(), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var title, author string
	var open int
	e = tx.QueryRow(ctx, `SELECT r.title,u.email,(SELECT count(*) FROM reports WHERE recipe_id=r.id AND status='open') FROM recipes r JOIN users u ON u.id=r.author_id WHERE r.id=$1 FOR UPDATE OF r`, id).Scan(&title, &author, &open)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Recipe not found.")
	}
	if e != nil {
		return e
	}
	if e = audit(ctx, tx, c, "recipe.delete", "recipe", id, fmt.Sprintf("Deleted “%s” by %s", title, author), fiber.Map{"note": note, "title": title, "author": author, "openReports": open}); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM recipes WHERE id=$1`, id); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// adminReports groups reports by recipe, most-reported first.
func (a *App) adminReports(c fiber.Ctx) error {
	status := c.Query("status", "open")
	if status != "open" && status != "resolved" && status != "dismissed" {
		return fiber.NewError(400, "Choose open, resolved or dismissed reports.")
	}
	return a.adminList(c, `SELECT jsonb_build_object(
 'recipe',jsonb_build_object('id',r.id,'title',r.title,'image',r.image,'published',r.published,'createdAt',r.created_at),
 'author',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'avatar',u.avatar,'suspended',u.suspended_at IS NOT NULL),
 'count',count(*),'latestAt',max(p.created_at),'reports',jsonb_agg(`+reportJSON+` ORDER BY p.created_at DESC)),count(*) OVER()
 FROM reports p JOIN recipes r ON r.id=p.recipe_id JOIN users u ON u.id=r.author_id JOIN users x ON x.id=p.user_id
 WHERE p.status=$1 GROUP BY r.id,u.id ORDER BY count(*) DESC,max(p.created_at) DESC`, status)
}

func (a *App) adminReviews(c fiber.Ctx) error {
	rating, _ := strconv.Atoi(c.Query("rating", "0"))
	return a.adminList(c, `SELECT jsonb_build_object('id',v.id,'rating',v.rating,'body',v.body,'createdAt',v.created_at,
 'author',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'avatar',u.avatar,'suspended',u.suspended_at IS NOT NULL),
 'recipe',jsonb_build_object('id',r.id,'title',r.title,'image',r.image,'published',r.published)),count(*) OVER()
 FROM reviews v JOIN users u ON u.id=v.user_id JOIN recipes r ON r.id=v.recipe_id
 WHERE ($1='' OR v.body ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%' OR r.title ILIKE '%'||$1||'%') AND ($2=0 OR v.rating=$2)
 ORDER BY v.created_at DESC`, strings.TrimSpace(c.Query("q")), rating)
}

func (a *App) adminDeleteReview(c fiber.Ctx) error {
	ctx, id := c.Context(), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var body, author, title, recipe string
	var rating int
	e = tx.QueryRow(ctx, `DELETE FROM reviews v USING users u,recipes r WHERE v.id=$1 AND u.id=v.user_id AND r.id=v.recipe_id RETURNING v.body,v.rating,u.email,r.title,r.id`, id).Scan(&body, &rating, &author, &title, &recipe)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Review not found.")
	}
	if e != nil {
		return e
	}
	if e = audit(ctx, tx, c, "review.delete", "review", id, fmt.Sprintf("Deleted %s's %d-star review of “%s”", author, rating, title), fiber.Map{"body": truncate(body, 300), "rating": rating, "recipeId": recipe}); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// adminAI is the last 30 days of AI use: what's live now, where the money goes, and who spends it.
func (a *App) adminAI(c fiber.Ctx) error {
	b, e := a.jsonRow(c.Context(), `SELECT jsonb_build_object(
 'voice',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'status',s.status,'createdAt',s.created_at,'heartbeatAt',s.heartbeat_at,
   'reservedSeconds',s.reserved_seconds,'seconds',round(s.seconds::numeric),'closeRequested',s.close_requested,
   'user',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'avatar',u.avatar)) ORDER BY s.created_at DESC)
   FROM voice_sessions s JOIN users u ON u.id=s.user_id WHERE s.status IN ('connecting','active')),'[]'),
 'spenders',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'avatar',u.avatar,'plan',`+effectivePlanSQL+`,'spend',round(x.spend::numeric,4)) ORDER BY x.spend DESC)
   FROM (SELECT user_id,sum(cost) spend FROM ai_spend WHERE created_at>now()-interval '30 days' AND user_id IS NOT NULL GROUP BY user_id ORDER BY 2 DESC LIMIT 10) x JOIN users u ON u.id=x.user_id),'[]'),
 'kinds',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'jobs',n,'failed',f,'spend',round(cost,4)) ORDER BY cost DESC)
   FROM (SELECT kind,count(*) n,count(*) FILTER (WHERE status='failed') f,COALESCE(sum(estimated_cost),0) cost FROM ai_jobs WHERE created_at>now()-interval '30 days' GROUP BY kind) k),'[]'),
 'assistant',(SELECT jsonb_build_object('turns',count(*),'failed',count(*) FILTER (WHERE status='failed'),'spend',round(COALESCE(sum(estimated_cost),0),4))
   FROM voice_actions WHERE created_at>now()-interval '30 days'),
 'narration',(SELECT jsonb_build_object('clips',count(*),'spend',round(COALESCE(sum(estimated_cost),0)::numeric,4)) FROM narration_usage WHERE created_at>now()-interval '30 days'),
 'voiceTotals',(SELECT jsonb_build_object('sessions',count(*),'minutes',round((COALESCE(sum(CASE WHEN finalized THEN seconds ELSE reserved_seconds END),0)/60)::numeric,1))
   FROM voice_sessions WHERE reserved_seconds>0 AND created_at>now()-interval '30 days'))`)
	if e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}

const jobRowJSON = `'id',j.id,'kind',j.kind,'status',j.status,'error',j.error,'cost',j.estimated_cost,'providerId',j.provider_id,
 'createdAt',j.created_at,'updatedAt',j.updated_at,'user',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'avatar',u.avatar)`

func (a *App) adminJobs(c fiber.Ctx) error {
	return a.adminList(c, `SELECT jsonb_build_object(`+jobRowJSON+`),count(*) OVER() FROM ai_jobs j JOIN users u ON u.id=j.user_id
 WHERE ($1='' OR j.status=$1) AND ($2='' OR j.kind=$2) AND ($3='' OR u.email ILIKE '%'||$3||'%' OR j.id=$3 OR j.user_id=$3)
 ORDER BY j.created_at DESC`, c.Query("status"), c.Query("kind"), strings.TrimSpace(c.Query("q")))
}

// adminJob includes the prompt and result, for debugging a generation a member reports.
func (a *App) adminJob(c fiber.Ctx) error {
	b, e := a.jsonRow(c.Context(), `SELECT jsonb_build_object(`+jobRowJSON+`,'prompt',left(j.prompt,4000),'result',j.result)
 FROM ai_jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1`, c.Params("id"))
	if e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}

func (a *App) adminCancelJob(c fiber.Ctx) error {
	ctx, id := c.Context(), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var status, kind, email string
	e = tx.QueryRow(ctx, `SELECT j.status,j.kind,u.email FROM ai_jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1 FOR UPDATE OF j`, id).Scan(&status, &kind, &email)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Job not found.")
	}
	if e != nil {
		return e
	}
	switch status {
	case "queued":
		// Never sent, so nothing was spent.
		_, e = tx.Exec(ctx, `UPDATE ai_jobs SET status='failed',error='Cancelled by an admin.',estimated_cost=0,updated_at=now() WHERE id=$1`, id)
	case "processing":
		// The provider already has it, so the reservation stays.
		_, e = tx.Exec(ctx, `UPDATE ai_jobs SET status='failed',error='Cancelled by an admin. The provider may still finish and bill this task.',updated_at=now() WHERE id=$1`, id)
	case "running":
		return fiber.NewError(409, "This job is with the provider now. It finishes or times out within 10 minutes.")
	default:
		return fiber.NewError(409, "This job has already finished.")
	}
	if e != nil {
		return e
	}
	if e = audit(ctx, tx, c, "job.cancel", "job", id, fmt.Sprintf("Cancelled %s's %s job", email, kind), fiber.Map{"status": status}); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return a.adminJob(c)
}

func (a *App) adminEndVoice(c fiber.Ctx) error {
	ctx, id := c.Context(), c.Params("id")
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var email string
	e = tx.QueryRow(ctx, `UPDATE voice_sessions s SET close_requested=true FROM users u WHERE s.id=$1 AND u.id=s.user_id AND s.status IN ('connecting','active') RETURNING u.email`, id).Scan(&email)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "That voice session has already ended.")
	}
	if e != nil {
		return e
	}
	if e = audit(ctx, tx, c, "voice.end", "voice", id, "Ended "+email+"'s live voice session", nil); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}
