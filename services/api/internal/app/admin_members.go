package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Member queries use $2 and $3 for ownerEmails() and the owner verification rule.
const memberLateral = ` CROSS JOIN LATERAL (SELECT
 (SELECT count(*) FROM recipes WHERE author_id=u.id) recipes,
 (SELECT count(*) FROM recipes WHERE author_id=u.id AND published) published,
 (SELECT count(*) FROM reports p JOIN recipes r ON r.id=p.recipe_id WHERE r.author_id=u.id AND p.status='open') reports,
 (SELECT COALESCE(sum(cost),0) FROM ai_spend WHERE user_id=u.id AND created_at>now()-interval '30 days') spend,
 (SELECT max(created_at) FROM sessions WHERE user_id=u.id) seen) m `

var memberJSON = `jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'handle',u.handle,'avatar',u.avatar,'createdAt',u.created_at,
 'plan',` + effectivePlanSQL + `,'planStatus',u.plan_status,'comped',(u.plan<>'free' AND u.plan_status='active' AND u.plan_interval=''),
 'emailVerified',u.email_verified,'hasPassword',NOT starts_with(u.password_hash,'!'),'sample',u.password_hash='!disabled',
 'identities',COALESCE((SELECT jsonb_agg(provider ORDER BY provider) FROM identities WHERE user_id=u.id),'[]'),
 'admin',` + adminSQL(2, 3) + `,'owner',` + ownerSQL(2, 3) + `,'ownerEmail',u.email=ANY($2::text[]),
 'suspendedAt',u.suspended_at,'suspendedReason',u.suspended_reason,
 'recipeCount',m.recipes,'publishedCount',m.published,'openReports',m.reports,'spend30d',round(m.spend::numeric,4),'lastSignInAt',m.seen)`

var memberFilters = map[string]string{
	"admins":     adminSQL(2, 3),
	"suspended":  `u.suspended_at IS NOT NULL`,
	"unverified": `NOT u.email_verified AND u.password_hash<>'!disabled'`,
	"paid":       effectivePlanSQL + `<>'free'`,
	"reported":   `m.reports>0`,
	"samples":    `u.password_hash='!disabled'`,
}
var memberOrders = map[string]string{
	"newest":  `u.created_at DESC`,
	"oldest":  `u.created_at`,
	"spend":   `m.spend DESC,u.created_at DESC`,
	"recipes": `m.recipes DESC,u.created_at DESC`,
	"active":  `m.seen DESC NULLS LAST,u.created_at DESC`,
}

func (a *App) adminUsers(c fiber.Ctx) error {
	filter, ok := memberFilters[c.Query("filter")]
	if !ok {
		filter = "true"
	}
	order, ok := memberOrders[c.Query("sort")]
	if !ok {
		order = memberOrders["newest"]
	}
	return a.adminList(c, `SELECT `+memberJSON+`,count(*) OVER() FROM users u`+memberLateral+`
 WHERE ($1='' OR u.email ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%' OR u.handle ILIKE '%'||$1||'%' OR u.id=$1) AND `+filter+`
 ORDER BY `+order, strings.TrimSpace(c.Query("q")), ownerEmails(), a.Config.Production)
}

func (a *App) adminUser(c fiber.Ctx) error {
	ctx, id := c.Context(), c.Params("id")
	b, e := a.jsonRow(ctx, `SELECT `+memberJSON+` || jsonb_build_object(
 'bio',u.bio,'preferences',u.preferences,'planInterval',u.plan_interval,'planRenewsAt',u.plan_renews_at,'planCancels',u.plan_cancels,
 'stripeCustomerId',u.stripe_customer_id,'stripeSubscriptionId',u.stripe_subscription_id,'appointedAdmin',u.admin,
 'activeSessions',(SELECT count(*) FROM sessions WHERE user_id=u.id AND expires_at>now()),
 'counts',jsonb_build_object(
   'reviews',(SELECT count(*) FROM reviews WHERE user_id=u.id),'saves',(SELECT count(*) FROM saves WHERE user_id=u.id),
   'cookbooks',(SELECT count(*) FROM collections WHERE user_id=u.id),'followers',(SELECT count(*) FROM follows WHERE creator_id=u.id),
   'following',(SELECT count(*) FROM follows WHERE user_id=u.id),'conversations',(SELECT count(*) FROM voice_projects WHERE user_id=u.id),
   'mealPlans',(SELECT count(*) FROM meal_plans WHERE user_id=u.id),'pantry',(SELECT count(*) FROM pantry WHERE user_id=u.id),
   'reportsFiled',(SELECT count(*) FROM reports WHERE user_id=u.id),'aiJobs',(SELECT count(*) FROM ai_jobs WHERE user_id=u.id)),
 'recipes',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'image',r.image,'published',r.published,'aiGenerated',r.ai_generated,'createdAt',r.created_at,
   'openReports',(SELECT count(*) FROM reports WHERE recipe_id=r.id AND status='open')) ORDER BY r.created_at DESC)
   FROM (SELECT * FROM recipes WHERE author_id=u.id ORDER BY created_at DESC LIMIT 50) r),'[]'),
 'reviews',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'rating',v.rating,'body',v.body,'createdAt',v.created_at,'recipe',jsonb_build_object('id',r.id,'title',r.title)) ORDER BY v.created_at DESC)
   FROM (SELECT * FROM reviews WHERE user_id=u.id ORDER BY created_at DESC LIMIT 20) v JOIN recipes r ON r.id=v.recipe_id),'[]'),
 'jobs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,'error',j.error,'cost',j.estimated_cost,'createdAt',j.created_at) ORDER BY j.created_at DESC)
   FROM (SELECT * FROM ai_jobs WHERE user_id=u.id ORDER BY created_at DESC LIMIT 20) j),'[]'),
 'reportsFiled',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'reason',p.reason,'status',p.status,'createdAt',p.created_at,'recipe',jsonb_build_object('id',r.id,'title',r.title)) ORDER BY p.created_at DESC)
   FROM (SELECT * FROM reports WHERE user_id=u.id ORDER BY created_at DESC LIMIT 20) p JOIN recipes r ON r.id=p.recipe_id),'[]'),
 'history',COALESCE((SELECT jsonb_agg(`+auditJSON+` ORDER BY x.created_at DESC,x.id DESC)
   FROM (SELECT * FROM admin_actions WHERE target_type='user' AND target_id=u.id ORDER BY created_at DESC,id DESC LIMIT 20) x),'[]'))
 FROM users u`+memberLateral+`WHERE u.id=$1`, id, ownerEmails(), a.Config.Production)
	if e != nil {
		return e
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil {
		return e
	}
	used, e := usageOf(ctx, a.DB, id)
	if e != nil {
		return e
	}
	out["usage"] = used
	// Without paid plans everyone is unlimited, bounded only by the daily budgets.
	out["limits"] = nil
	if plan, _ := out["plan"].(string); paidPlans() {
		p := planByID(plan)
		out["limits"] = fiber.Map{"assistant": p.Assistant, "voiceMinutes": p.VoiceMinutes, "images": p.Images, "videos": p.Videos, "narration": p.Narration, "spendCap": p.SpendCap}
	}
	return c.JSON(out)
}

type managed struct {
	ID, Email                         string
	Admin, Owner, OwnerEmail, Blocked bool
}

// manage loads the member an action targets and refuses what this admin may not do: owners
// are set only by ADMIN_EMAILS, only owners change other admins, and with self false an
// admin can't lock themselves out.
func (a *App) manage(c fiber.Ctx, self bool) (managed, error) {
	var m managed
	e := a.DB.QueryRow(c.Context(), `SELECT u.id,u.email,`+adminSQL(2, 3)+`,`+ownerSQL(2, 3)+`,u.email=ANY($2::text[]),u.suspended_at IS NOT NULL FROM users u WHERE u.id=$1`,
		c.Params("id"), ownerEmails(), a.Config.Production).Scan(&m.ID, &m.Email, &m.Admin, &m.Owner, &m.OwnerEmail, &m.Blocked)
	if errors.Is(e, pgx.ErrNoRows) {
		return m, fiber.NewError(404, "Member not found.")
	}
	if e != nil {
		return m, e
	}
	me := m.ID == userID(c)
	switch {
	case me && !self:
		return m, fiber.NewError(400, "You can't do that to your own account.")
	case m.Owner && !me:
		return m, fiber.NewError(403, "Owners are set by ADMIN_EMAILS and can't be changed from the console.")
	case m.Admin && !me && !isOwner(c):
		return m, fiber.NewError(403, "Only an owner can change another admin.")
	}
	return m, nil
}

// adminWrite runs fn in a transaction, then answers with the member's refreshed record.
func (a *App) adminWrite(c fiber.Ctx, fn func(ctx context.Context, tx pgx.Tx) error) error {
	ctx := c.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = fn(ctx, tx); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return a.adminUser(c)
}

func (a *App) adminEditUser(c fiber.Ctx) error {
	m, e := a.manage(c, true)
	if e != nil {
		return e
	}
	var in struct{ Name, Handle, Bio, Avatar *string }
	if e = decode(c, &in); e != nil {
		return e
	}
	changed := []string{}
	if in.Name != nil {
		if *in.Name = strings.TrimSpace(*in.Name); !validText(*in.Name, 2, 70) {
			return fiber.NewError(400, "Names are 2–70 characters.")
		}
		changed = append(changed, "name")
	}
	if in.Handle != nil {
		// Members' rules, except that admins may hand out reserved names (an official account).
		if *in.Handle = normalizeHandle(*in.Handle); !validHandle(*in.Handle) {
			return fiber.NewError(400, handleRules)
		}
		changed = append(changed, "handle")
	}
	if in.Bio != nil {
		if len(*in.Bio) > 1000 {
			return fiber.NewError(400, "Bios are up to 1,000 characters.")
		}
		changed = append(changed, "bio")
	}
	if in.Avatar != nil {
		if !validMedia(*in.Avatar) {
			return fiber.NewError(400, "Profile photos need an HTTPS URL.")
		}
		changed = append(changed, "photo")
	}
	if len(changed) == 0 {
		return a.adminUser(c)
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE users SET name=COALESCE($2,name),handle=COALESCE($3,handle),bio=COALESCE($4,bio),avatar=COALESCE($5,avatar) WHERE id=$1`, m.ID, in.Name, in.Handle, in.Bio, in.Avatar)
		var pe *pgconn.PgError
		if errors.As(e, &pe) && pe.Code == "23505" {
			return fiber.NewError(409, "That handle is already taken.")
		}
		if e != nil {
			return e
		}
		return audit(ctx, tx, c, "member.edit", "user", m.ID, "Edited "+m.Email+"'s "+strings.Join(changed, ", "), fiber.Map{"fields": changed})
	})
}

// endAccess signs a member out everywhere and ends their live voice. With a reason, it
// also cancels AI work that hasn't reached a provider, releasing its reservation.
func endAccess(ctx context.Context, tx pgx.Tx, id, reason string) error {
	if _, e := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id=$1`, id); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `UPDATE voice_sessions SET close_requested=true WHERE user_id=$1 AND status IN ('connecting','active')`, id); e != nil {
		return e
	}
	if reason == "" {
		return nil
	}
	if _, e := tx.Exec(ctx, `UPDATE ai_jobs SET status='failed',error=$2,estimated_cost=0,updated_at=now() WHERE user_id=$1 AND status='queued'`, id, reason); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `UPDATE voice_actions x SET status='failed',reply=$2,estimated_cost=0,updated_at=now() FROM voice_projects p WHERE p.id=x.project_id AND p.user_id=$1 AND x.status='queued'`, id, reason)
	return e
}

func (a *App) adminSuspend(c fiber.Ctx) error {
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	var in struct{ Reason string }
	if e = decode(c, &in); e != nil {
		return e
	}
	if in.Reason = strings.TrimSpace(in.Reason); !validText(in.Reason, 3, 500) {
		return fiber.NewError(400, "Note why (3–500 characters). Only admins see it.")
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		r, e := tx.Exec(ctx, `UPDATE users SET suspended_at=now(),suspended_reason=$2 WHERE id=$1 AND suspended_at IS NULL`, m.ID, in.Reason)
		if e != nil {
			return e
		}
		if r.RowsAffected() == 0 {
			return fiber.NewError(409, "This member is already suspended.")
		}
		if e = endAccess(ctx, tx, m.ID, "Cancelled: this account was suspended."); e != nil {
			return e
		}
		return audit(ctx, tx, c, "member.suspend", "user", m.ID, "Suspended "+m.Email, fiber.Map{"reason": in.Reason})
	})
}

func (a *App) adminUnsuspend(c fiber.Ctx) error {
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		var reason string
		e := tx.QueryRow(ctx, `UPDATE users u SET suspended_at=NULL,suspended_reason='' FROM users old WHERE u.id=$1 AND old.id=u.id AND u.suspended_at IS NOT NULL RETURNING old.suspended_reason`, m.ID).Scan(&reason)
		if errors.Is(e, pgx.ErrNoRows) {
			return fiber.NewError(409, "This member isn't suspended.")
		}
		if e != nil {
			return e
		}
		return audit(ctx, tx, c, "member.unsuspend", "user", m.ID, "Lifted "+m.Email+"'s suspension", fiber.Map{"previousReason": reason})
	})
}

func (a *App) adminSignOut(c fiber.Ctx) error {
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		if e := endAccess(ctx, tx, m.ID, ""); e != nil {
			return e
		}
		return audit(ctx, tx, c, "member.sign_out", "user", m.ID, "Signed "+m.Email+" out everywhere", nil)
	})
}

func (a *App) adminVerify(c fiber.Ctx) error {
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	// Verifying an owner's address would make whoever registered it an owner.
	if m.OwnerEmail {
		return fiber.NewError(403, "This address is in ADMIN_EMAILS. Its owner verifies it by resetting their password or connecting Google.")
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		r, e := tx.Exec(ctx, `UPDATE users SET email_verified=true WHERE id=$1 AND NOT email_verified`, m.ID)
		if e != nil {
			return e
		}
		if r.RowsAffected() == 0 {
			return fiber.NewError(409, "This email is already verified.")
		}
		return audit(ctx, tx, c, "member.verify", "user", m.ID, "Marked "+m.Email+" as verified", nil)
	})
}

func (a *App) adminSetRole(c fiber.Ctx) error {
	if !isOwner(c) {
		return fiber.NewError(403, "Only an owner can appoint or remove admins.")
	}
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	var in struct{ Admin bool }
	if e = decode(c, &in); e != nil {
		return e
	}
	if in.Admin && m.OwnerEmail {
		return fiber.NewError(403, "This address is in ADMIN_EMAILS; it becomes an owner once its email is verified.")
	}
	if in.Admin && m.Blocked {
		return fiber.NewError(409, "Lift the suspension before appointing this member.")
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		r, e := tx.Exec(ctx, `UPDATE users SET admin=$2 WHERE id=$1 AND admin<>$2`, m.ID, in.Admin)
		if e != nil {
			return e
		}
		if r.RowsAffected() == 0 {
			return fiber.NewError(409, "Nothing changed.")
		}
		if in.Admin {
			return audit(ctx, tx, c, "member.admin", "user", m.ID, "Made "+m.Email+" an admin", nil)
		}
		return audit(ctx, tx, c, "member.unadmin", "user", m.ID, "Removed "+m.Email+" as an admin", nil)
	})
}

// adminSetPlan grants a complimentary plan, outside Stripe. Members who pay keep the plan
// Stripe reports; change those in the Stripe dashboard.
func (a *App) adminSetPlan(c fiber.Ctx) error {
	m, e := a.manage(c, true)
	if e != nil {
		return e
	}
	var in struct{ Plan string }
	if e = decode(c, &in); e != nil {
		return e
	}
	if planByID(in.Plan).ID != in.Plan {
		return fiber.NewError(400, "Choose free, plus or pro.")
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		var interval, status, current string
		if e := tx.QueryRow(ctx, `SELECT plan_interval,plan_status,`+effectivePlanSQL+` FROM users u WHERE id=$1 FOR UPDATE`, m.ID).Scan(&interval, &status, &current); e != nil {
			return e
		}
		if interval != "" && (status == "active" || status == "trialing" || status == "past_due") {
			return fiber.NewError(409, "This member pays through Stripe. Change their subscription in the Stripe dashboard.")
		}
		if current == in.Plan {
			return fiber.NewError(409, "This member already has that plan.")
		}
		status = "active"
		if in.Plan == "free" {
			status = ""
		}
		if _, e := tx.Exec(ctx, `UPDATE users SET plan=$2,plan_status=$3,plan_interval='',plan_renews_at=NULL,plan_cancels=false WHERE id=$1`, m.ID, in.Plan, status); e != nil {
			return e
		}
		return audit(ctx, tx, c, "member.plan", "user", m.ID, "Changed "+m.Email+"'s plan from "+current+" to "+in.Plan+" (complimentary)", fiber.Map{"from": current, "to": in.Plan})
	})
}

func (a *App) adminDeleteUser(c fiber.Ctx) error {
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	var in struct{ Confirm string }
	if e = decode(c, &in); e != nil {
		return e
	}
	if !strings.EqualFold(strings.TrimSpace(in.Confirm), m.Email) {
		return fiber.NewError(400, "Type the member's email to confirm.")
	}
	ctx := c.Context()
	// As when members delete themselves: nobody keeps paying for an account that's gone.
	if e = a.cancelSubscription(ctx, m.ID); e != nil {
		return e
	}
	if e = a.revokeApple(ctx, m.ID); e != nil {
		slog.Warn("revoke Sign in with Apple", "error", e)
	}
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var name string
	var recipes int
	if e = tx.QueryRow(ctx, `SELECT name,(SELECT count(*) FROM recipes WHERE author_id=$1) FROM users WHERE id=$1`, m.ID).Scan(&name, &recipes); e != nil {
		return e
	}
	if e = audit(ctx, tx, c, "member.delete", "user", m.ID, "Deleted "+m.Email+"'s account", fiber.Map{"name": name, "email": m.Email, "recipes": recipes}); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM users WHERE id=$1`, m.ID); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}
