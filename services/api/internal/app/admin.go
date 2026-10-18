package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"savorly/api/internal/narration"
)

// The admin console (apps/mobile/src/screens/admin). Every write is recorded in
// admin_actions, and members are protected from admins who outrank them less: owners are
// set only by ADMIN_EMAILS, and only owners change other admins.
func (a *App) adminRoutes(v fiber.Router) {
	g := v.Group("/admin", a.requireAuth, a.requireAdmin)
	g.Get("/overview", a.adminOverview)
	g.Get("/users", a.adminUsers)
	g.Get("/users/:id", a.adminUser)
	g.Patch("/users/:id", a.adminEditUser)
	g.Post("/users/:id/suspend", a.adminSuspend)
	g.Delete("/users/:id/suspend", a.adminUnsuspend)
	g.Post("/users/:id/sign-out", a.adminSignOut)
	g.Post("/users/:id/verify", a.adminVerify)
	g.Post("/users/:id/setup", a.adminRestartSetup)
	g.Put("/users/:id/admin", a.adminSetRole)
	g.Put("/users/:id/plan", a.adminSetPlan)
	g.Delete("/users/:id", a.adminDeleteUser)
	g.Get("/recipes", a.adminRecipes)
	g.Get("/recipes/:id", a.adminRecipe)
	g.Put("/recipes/:id/published", a.adminPublish)
	g.Post("/recipes/:id/reports", a.adminResolveReports)
	g.Delete("/recipes/:id", a.adminDeleteRecipe)
	g.Get("/reports", a.adminReports)
	g.Get("/reviews", a.adminReviews)
	g.Delete("/reviews/:id", a.adminDeleteReview)
	g.Delete("/comments/:id", a.adminDeleteComment)
	g.Delete("/suggestions/:id", a.adminDeleteSuggestion)
	g.Get("/ai", a.adminAI)
	g.Get("/jobs", a.adminJobs)
	g.Get("/jobs/:id", a.adminJob)
	g.Post("/jobs/:id/cancel", a.adminCancelJob)
	g.Post("/voice/:id/end", a.adminEndVoice)
	g.Get("/turns", a.adminTurns)
	g.Get("/turns/:id", a.adminTurn)
	g.Get("/audit", a.adminAudit)
	g.Get("/insights", a.adminInsights)
	g.Get("/settings", a.adminSettings)
	g.Put("/settings", a.adminSaveSettings)
}

func (a *App) requireAdmin(c fiber.Ctx) error {
	var email string
	var admin, owner bool
	e := a.DB.QueryRow(c.Context(), `SELECT u.email,`+adminSQL(2, 3)+`,`+ownerSQL(2, 3)+` FROM users u WHERE u.id=$1`, userID(c), ownerEmails(), a.Config.Production).Scan(&email, &admin, &owner)
	if e != nil {
		return e
	}
	if !admin {
		return fiber.NewError(403, "The admin console is for Savorly admins.")
	}
	c.Locals("adminEmail", email)
	c.Locals("owner", owner)
	return c.Next()
}
func isOwner(c fiber.Ctx) bool { o, _ := c.Locals("owner").(bool); return o }

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func adminEmail(c fiber.Ctx) string { e, _ := c.Locals("adminEmail").(string); return e }

const auditInsert = `INSERT INTO admin_actions(admin_id,admin_email,action,target_type,target_id,summary,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`

func auditArgs(c fiber.Ctx, action, kind, target, summary string, detail fiber.Map) []any {
	if detail == nil {
		detail = fiber.Map{}
	}
	return []any{userID(c), adminEmail(c), action, kind, target, summary, jsonBytes(detail)}
}

// audit records one admin action. Summaries are written for people reading the log later.
func audit(ctx context.Context, db execer, c fiber.Ctx, action, kind, target, summary string, detail fiber.Map) error {
	_, e := db.Exec(ctx, auditInsert, auditArgs(c, action, kind, target, summary, detail)...)
	return e
}

// auditEntry records an action that leaves work outside the database (Stripe, Apple) to run
// after commit, and returns the entry so noteOutcome can add how that work went.
func auditEntry(ctx context.Context, q querier, c fiber.Ctx, action, kind, target, summary string, detail fiber.Map) (int64, error) {
	var id int64
	e := q.QueryRow(ctx, auditInsert+` RETURNING id`, auditArgs(c, action, kind, target, summary, detail)...).Scan(&id)
	return id, e
}

// noteOutcome adds how that work went to the entry's detail, replacing the followUp note the
// entry started with (followUp.pending). It's the only change ever made to an entry; if it
// fails, the entry keeps saying what to check.
func (a *App) noteOutcome(ctx context.Context, entry int64, outcome fiber.Map) {
	if _, e := a.DB.Exec(ctx, `UPDATE admin_actions SET detail=(detail-'followUp')||$2 WHERE id=$1`, entry, jsonBytes(outcome)); e != nil {
		slog.Error("record an admin follow-up", "entry", entry, "error", e)
	}
}

const auditJSON = `jsonb_build_object('id',x.id,'adminId',x.admin_id,'adminEmail',x.admin_email,'action',x.action,'targetType',x.target_type,'targetId',x.target_id,'summary',x.summary,'detail',x.detail,'createdAt',x.created_at)`

// jsonRow returns one JSON value, or 404.
func (a *App) jsonRow(ctx context.Context, sql string, args ...any) ([]byte, error) {
	var b []byte
	e := a.DB.QueryRow(ctx, sql, args...).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fiber.NewError(404, "This item could not be found.")
	}
	return b, e
}

// adminList pages a query whose columns are one JSON item and count(*) OVER(). Its ORDER BY
// ends on a unique column, so pages never repeat or skip rows that otherwise sort alike.
func (a *App) adminList(c fiber.Ctx, sql string, args ...any) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	if limit < 1 || limit > 500 {
		limit = 50
	}
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	if offset < 0 || offset > 100000 {
		offset = 0
	}
	n := len(args)
	rows, e := a.DB.Query(c.Context(), sql+fmt.Sprintf(" LIMIT $%d OFFSET $%d", n+1, n+2), append(args, limit, offset)...)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []json.RawMessage{}
	var total int64
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b, &total); e != nil {
			return e
		}
		items = append(items, b)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"items": items, "total": total, "offset": offset, "limit": limit})
}

func (a *App) adminOverview(c fiber.Ctx) error {
	ctx := c.Context()
	tx, e := a.DB.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Members exclude the sample cooks that SEED_DATA creates ('!disabled' passwords).
	var stats []byte
	e = tx.QueryRow(ctx, `SELECT jsonb_build_object(
 'members',(SELECT jsonb_build_object('total',count(*),'new24h',count(*) FILTER (WHERE created_at>now()-interval '24 hours'),
   'new7d',count(*) FILTER (WHERE created_at>now()-interval '7 days'),'new30d',count(*) FILTER (WHERE created_at>now()-interval '30 days'),
   'verified',count(*) FILTER (WHERE email_verified),'suspended',count(*) FILTER (WHERE suspended_at IS NOT NULL),
   'admins',count(*) FILTER (WHERE `+adminSQL(1, 2)+`),'withPassword',count(*) FILTER (WHERE NOT starts_with(password_hash,'!')),
   'active7d',count(*) FILTER (WHERE EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.created_at>now()-interval '7 days'))) FROM users u WHERE password_hash<>'!disabled'),
 'samples',(SELECT count(*) FROM users WHERE password_hash='!disabled'),
 'plans',(SELECT COALESCE(jsonb_object_agg(p,n),'{}') FROM (SELECT `+effectivePlanSQL+` p,count(*) n FROM users u WHERE password_hash<>'!disabled' GROUP BY 1) x),
 'comped',(SELECT count(*) FROM users WHERE plan<>'free' AND plan_status='active' AND plan_interval=''),
 'identities',(SELECT COALESCE(jsonb_object_agg(provider,n),'{}') FROM (SELECT provider,count(*) n FROM identities GROUP BY 1) x),
 'recipes',(SELECT jsonb_build_object('published',count(*) FILTER (WHERE published),'drafts',count(*) FILTER (WHERE NOT published),
   'aiGenerated',count(*) FILTER (WHERE ai_generated),'new7d',count(*) FILTER (WHERE created_at>now()-interval '7 days'),
   'withVideo',count(*) FILTER (WHERE video<>'')) FROM recipes),
 'community',jsonb_build_object('reviews',(SELECT count(*) FROM reviews),'reviews7d',(SELECT count(*) FROM reviews WHERE created_at>now()-interval '7 days'),
   'follows',(SELECT count(*) FROM follows),'saves',(SELECT count(*) FROM saves),'cookbooks',(SELECT count(*) FROM collections),
   'mealPlans',(SELECT count(*) FROM meal_plans)),
 'reports',(SELECT jsonb_build_object('open',count(*),'recipes',count(DISTINCT recipe_id)) FROM reports WHERE status='open'),
 'jobs',(SELECT jsonb_build_object('queued',count(*) FILTER (WHERE status='queued'),'running',count(*) FILTER (WHERE status='running'),
   'processing',count(*) FILTER (WHERE status='processing'),
   'failed24h',count(*) FILTER (WHERE status='failed' AND updated_at>now()-interval '24 hours'),
   'completed24h',count(*) FILTER (WHERE status='completed' AND updated_at>now()-interval '24 hours'),
   'oldestQueuedSeconds',COALESCE(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='queued'))::int,0)) FROM ai_jobs),
 'assistant',(SELECT jsonb_build_object('queued',count(*) FILTER (WHERE status='queued'),'running',count(*) FILTER (WHERE status='running'),
   'failed24h',count(*) FILTER (WHERE status='failed' AND updated_at>now()-interval '24 hours'),
   'turns24h',count(*) FILTER (WHERE created_at>now()-interval '24 hours')) FROM voice_actions),
 'conversations',jsonb_build_object('total',(SELECT count(*) FROM voice_projects WHERE deleted_at IS NULL),'active7d',(SELECT count(*) FROM voice_projects WHERE deleted_at IS NULL AND updated_at>now()-interval '7 days')),
 'voiceLive',(SELECT count(*) FROM voice_sessions WHERE status IN ('connecting','active')),
 'spend',(SELECT jsonb_build_object(
   'last24h',round(COALESCE(sum(s.cost) FILTER (WHERE s.created_at>now()-interval '24 hours'),0)::numeric,4),
   'free24h',round(COALESCE(sum(s.cost) FILTER (WHERE s.created_at>now()-interval '24 hours' AND (u.id IS NULL OR `+effectivePlanSQL+`='free')),0)::numeric,4),
   'last7d',round(COALESCE(sum(s.cost) FILTER (WHERE s.created_at>now()-interval '7 days'),0)::numeric,4),
   'last30d',round(COALESCE(sum(s.cost),0)::numeric,4)) FROM ai_spend s LEFT JOIN users u ON u.id=s.user_id WHERE s.created_at>now()-interval '30 days'),
 'spendBySource',jsonb_build_object(
   'media',(SELECT round(COALESCE(sum(estimated_cost),0),4) FROM ai_jobs WHERE kind IN ('image','video') AND created_at>now()-interval '30 days'),
   'tools',(SELECT round(COALESCE(sum(estimated_cost),0),4) FROM ai_jobs WHERE kind NOT IN ('image','video') AND created_at>now()-interval '30 days'),
   'assistant',(SELECT round(COALESCE(sum(estimated_cost),0),4) FROM voice_actions WHERE created_at>now()-interval '30 days'),
   'narration',(SELECT round(COALESCE(sum(estimated_cost),0)::numeric,4) FROM narration_usage WHERE created_at>now()-interval '30 days'),
   'voice',(SELECT round(COALESCE(sum((CASE WHEN status IN ('connecting','active') OR NOT finalized THEN reserved_seconds ELSE greatest(seconds,15) END)*0.05/60),0)::numeric,4) FROM voice_sessions WHERE reserved_seconds>0 AND created_at>now()-interval '30 days')),
 'migration',(SELECT max(version) FROM schema_migrations),
 'databaseBytes',pg_database_size(current_database()))`, ownerEmails(), a.Config.Production).Scan(&stats)
	if e != nil {
		return e
	}
	// Thirty UTC days, oldest first.
	var series []byte
	e = tx.QueryRow(ctx, `WITH since AS (SELECT ((now() AT TIME ZONE 'UTC')::date-29) AS day),
 days AS (SELECT d::date AS day FROM since,generate_series(since.day::timestamp,(now() AT TIME ZONE 'UTC')::date::timestamp,interval '1 day') d),
 s AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*) n FROM users,since WHERE created_at>=since.day::timestamp AT TIME ZONE 'UTC' AND password_hash<>'!disabled' GROUP BY 1),
 r AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*) n FROM recipes,since WHERE created_at>=since.day::timestamp AT TIME ZONE 'UTC' GROUP BY 1),
 j AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*) n FROM ai_jobs,since WHERE created_at>=since.day::timestamp AT TIME ZONE 'UTC' GROUP BY 1),
 m AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,sum(cost) n FROM ai_spend,since WHERE created_at>=since.day::timestamp AT TIME ZONE 'UTC' GROUP BY 1)
 SELECT COALESCE(jsonb_agg(jsonb_build_object('day',day,'signups',COALESCE(s.n,0),'recipes',COALESCE(r.n,0),'jobs',COALESCE(j.n,0),'spend',round(COALESCE(m.n,0)::numeric,4)) ORDER BY day),'[]')
 FROM days LEFT JOIN s USING(day) LEFT JOIN r USING(day) LEFT JOIN j USING(day) LEFT JOIN m USING(day)`).Scan(&series)
	if e != nil {
		return e
	}
	settings, e := loadSettings(ctx, tx)
	if e != nil {
		return e
	}
	freeHeadroom, paidHeadroom, e := memberBudgets(ctx, tx)
	if e != nil {
		return e
	}
	return c.JSON(fiber.Map{
		"stats": json.RawMessage(stats), "series": json.RawMessage(series),
		"budget": fiber.Map{
			"daily": settings.dailyBudget() + freeHeadroom + paidHeadroom, "freeDaily": settings.freeDailyBudget() + freeHeadroom,
			"baseDaily": settings.dailyBudget(), "baseFreeDaily": settings.freeDailyBudget(),
			"memberFreeShare": freeHeadroom, "memberPaidShare": paidHeadroom, "paused": settings.AIPaused,
		},
		"settings": settings,
		"system":   a.systemStatus(),
	})
}

// systemStatus says which integrations are configured, never their secrets.
func (a *App) systemStatus() fiber.Map {
	voice, voiceModel := false, ""
	if a.Live != nil {
		voice, voiceModel = a.Live.Enabled(), a.Live.ModelID()
	}
	return fiber.Map{
		"environment": Env("APP_ENV", "development"), "owners": ownerEmails(), "ownersMustVerify": a.Config.Production,
		"paidPlans": paidPlans(), "billing": billingEnabled(), "media": a.Media != nil && a.Media.S3 != nil,
		"email": emailEnabled(), "appleSignIn": len(oauthAudiences("apple")) > 0, "googleSignIn": len(oauthAudiences("google")) > 0,
		"textAI": a.AI.TextEnabled(), "videoAI": a.AI.VideoEnabled(), "voiceAI": voice, "narration": a.Narrator.Enabled(),
		"models": fiber.Map{"recipe": a.AI.RecipeModel, "agent": a.AI.AgentModel, "image": a.AI.ImageModel, "imageEdit": a.AI.ImageEditModel, "video": a.AI.VideoModel, "voice": voiceModel, "narration": narration.Model},
	}
}

const announcementLimit = 280

// budgetCap bounds a budget override at this many times the environment's budget. The budgets
// are the one hard stop on AI spend, so no console session can lift it far.
const budgetCap = 10

// envBudgets are the daily AI budgets the environment sets, which overrides replace.
func envBudgets() (daily, free float64) {
	return envFloat("AI_DAILY_BUDGET_USD", 25), envFloat("AI_FREE_DAILY_BUDGET_USD", 5)
}

const (
	settingsStale = "Another admin changed these settings after you opened them. Open them again, then make your change."
	budgetOwners  = "Only an owner can change the AI budgets."
	budgetRange   = "Budget overrides are between $0 and ten times the environment's budget."
)

func (a *App) adminSettings(c fiber.Ctx) error {
	ctx := c.Context()
	s, e := loadSettings(ctx, a.DB)
	if e != nil {
		return e
	}
	var at *time.Time
	var by *string
	e = a.DB.QueryRow(ctx, `SELECT updated_at,(SELECT email FROM users WHERE id=updated_by) FROM app_settings WHERE key='operator'`).Scan(&at, &by)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	daily, free := envBudgets()
	return c.JSON(fiber.Map{"settings": s, "updatedAt": at, "updatedBy": by,
		"defaults":         fiber.Map{"aiDailyBudgetUSD": daily, "aiFreeDailyBudgetUSD": free},
		"budgetLimits":     fiber.Map{"aiDailyBudgetUSD": budgetCap * daily, "aiFreeDailyBudgetUSD": budgetCap * free},
		"canChangeBudgets": isOwner(c)})
}

func (a *App) adminSaveSettings(c fiber.Ctx) error {
	var in struct {
		Settings
		// The updatedAt the admin's form was loaded with, null before the first save. Saving a
		// stale form would quietly undo another admin's change, so it answers 409 instead.
		// Clients that send nothing aren't checked.
		ExpectedUpdatedAt json.RawMessage
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	check := len(in.ExpectedUpdatedAt) > 0
	var expected *time.Time
	if check && string(in.ExpectedUpdatedAt) != "null" {
		expected = new(time.Time)
		if json.Unmarshal(in.ExpectedUpdatedAt, expected) != nil {
			return fiber.NewError(400, "Invalid JSON request.")
		}
	}
	for _, b := range []*float64{in.AIDailyBudgetUSD, in.AIFreeDailyBudgetUSD} {
		if b != nil && (math.IsNaN(*b) || *b < 0) {
			return fiber.NewError(400, budgetRange)
		}
	}
	in.Announcement = strings.TrimSpace(in.Announcement)
	if !validText(in.Announcement, 0, announcementLimit) {
		return fiber.NewError(400, fmt.Sprintf("Keep the announcement under %d characters.", announcementLimit))
	}
	if in.AnnouncementTone == "" {
		in.AnnouncementTone = "info"
	}
	if in.AnnouncementTone != "info" && in.AnnouncementTone != "warning" {
		return fiber.NewError(400, "Choose an info or warning announcement.")
	}
	ctx := c.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Saves queue on the row. Before the first save there's no row to lock, so the insert below
	// refuses to overwrite a concurrent first save instead.
	var at *time.Time
	if e = tx.QueryRow(ctx, `SELECT updated_at FROM app_settings WHERE key='operator' FOR UPDATE`).Scan(&at); e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	if check && !sameTime(at, expected) {
		return fiber.NewError(409, settingsStale)
	}
	old, e := loadSettings(ctx, tx)
	if e != nil {
		return e
	}
	daily, free := envBudgets()
	for _, b := range []struct {
		was, is *float64
		limit   float64
	}{{old.AIDailyBudgetUSD, in.AIDailyBudgetUSD, budgetCap * daily}, {old.AIFreeDailyBudgetUSD, in.AIFreeDailyBudgetUSD, budgetCap * free}} {
		// Unchanged budgets pass, so admins can save the rest of the form.
		if sameBudget(b.was, b.is) {
			continue
		}
		if !isOwner(c) {
			return fiber.NewError(403, budgetOwners)
		}
		if b.is != nil && *b.is > b.limit {
			return fiber.NewError(400, budgetRange)
		}
	}
	value := jsonBytes(in.Settings)
	if at == nil {
		r, e := tx.Exec(ctx, `INSERT INTO app_settings(key,value,updated_by) VALUES('operator',$1,$2) ON CONFLICT(key) DO NOTHING`, value, userID(c))
		if e != nil {
			return e
		}
		if r.RowsAffected() == 0 {
			return fiber.NewError(409, settingsStale)
		}
	} else if _, e = tx.Exec(ctx, `UPDATE app_settings SET value=$1,updated_by=$2,updated_at=now() WHERE key='operator'`, value, userID(c)); e != nil {
		return e
	}
	if changes := settingsChanges(old, in.Settings); len(changes) > 0 {
		if e = audit(ctx, tx, c, "settings.update", "settings", "operator", strings.Join(changes, "; "), fiber.Map{"before": old, "after": in.Settings}); e != nil {
			return e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return a.adminSettings(c)
}

// sameTime compares the stored updatedAt with the one a client echoes back exactly as it was
// given; both are nil before the first save.
func sameTime(stored, sent *time.Time) bool {
	if stored == nil || sent == nil {
		return stored == sent
	}
	return stored.Equal(*sent)
}

func sameBudget(a, b *float64) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func settingsChanges(old, new Settings) []string {
	out := []string{}
	toggle := func(was, is bool, on, off string) {
		if was != is {
			out = append(out, map[bool]string{true: on, false: off}[is])
		}
	}
	toggle(old.AIPaused, new.AIPaused, "Paused all AI features", "Resumed AI features")
	toggle(old.SignupsPaused, new.SignupsPaused, "Paused new sign-ups", "Reopened sign-ups")
	budget := func(name string, was, is *float64) {
		show := func(v *float64) string {
			if v == nil {
				return "the default"
			}
			return fmt.Sprintf("$%.2f", *v)
		}
		if show(was) != show(is) {
			out = append(out, fmt.Sprintf("%s: %s → %s", name, show(was), show(is)))
		}
	}
	budget("Daily AI budget", old.AIDailyBudgetUSD, new.AIDailyBudgetUSD)
	budget("Free members' daily AI budget", old.AIFreeDailyBudgetUSD, new.AIFreeDailyBudgetUSD)
	switch {
	case old.Announcement == new.Announcement && old.AnnouncementTone == new.AnnouncementTone:
	case new.Announcement == "":
		out = append(out, "Removed the announcement")
	default:
		out = append(out, "Announcement: "+truncate(new.Announcement, 80))
	}
	return out
}

func (a *App) adminAudit(c fiber.Ctx) error {
	return a.adminList(c, `SELECT `+auditJSON+`,count(*) OVER() FROM admin_actions x
 WHERE ($1='' OR x.summary ILIKE '%'||$1||'%' OR x.admin_email ILIKE '%'||$1||'%' OR x.action ILIKE $1||'%' OR x.target_id=$1)
 AND ($2='' OR x.target_type=$2) ORDER BY x.created_at DESC,x.id DESC`, strings.TrimSpace(c.Query("q")), c.Query("type"))
}
