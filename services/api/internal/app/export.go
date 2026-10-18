package app

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// exportSQL is everything an account owns, as one JSON document ($1 is the member). Version 2 added
// comments, cooked recipes, cookbook sharing, recipe sources, the household, signed-in and
// notification devices (never their tokens) and the usage events kept for 90 days; cooking
// sessions and creator earnings, payouts and payout account (never its Stripe id) came after, as
// new keys, then each session's step events, the questions asked while cooking, the assistants
// linked to the account (never their tokens), their own versions of recipes and kitchen notes,
// the fixes suggested to recipes, bulk imports with any permission a creator gave to import their
// own site, and family recordings with their transcripts (each with the address of its audio).
// json, not jsonb, keeps keys in the order written. The password hash, provider tokens and
// billing IDs stay out; studio conversations keep only their text. export_files.go writes it as
// files too.
const exportSQL = `SELECT json_build_object(
 'format','savorly-export','version',2,'exportedAt',now(),
 'profile',json_build_object('id',u.id,'name',u.name,'email',u.email,'emailVerified',u.email_verified,'handle',u.handle,'bio',u.bio,'avatar',u.avatar,
   'hasPassword',NOT starts_with(u.password_hash,'!'),'createdAt',u.created_at,'onboardedAt',u.onboarded_at),
 'preferences',u.preferences,
 'plan',json_build_object('plan',u.plan,'status',u.plan_status,'interval',u.plan_interval,'renewsAt',u.plan_renews_at,'cancelsAtPeriodEnd',u.plan_cancels),
 'connectedProviders',COALESCE((SELECT json_agg(json_build_object('provider',provider,'email',email,'connectedAt',created_at) ORDER BY created_at) FROM identities WHERE user_id=u.id),'[]'),
 'recipes',COALESCE((SELECT json_agg(json_build_object('id',r.id,'title',r.title,'description',r.description,'cuisine',r.cuisine,'minutes',r.minutes,
   'servings',r.servings,'difficulty',r.difficulty,'calories',r.calories,'tags',r.tags,'ingredients',r.ingredients,'steps',r.steps,'equipment',r.equipment,'image',r.image,
   'photos',r.photos,'video',r.video,'language',r.language,'sourceUrl',r.source_url,'derivedFrom',r.derived_from,
   'aiGenerated',r.ai_generated,'published',r.published,'createdAt',r.created_at,'updatedAt',r.updated_at) ORDER BY r.created_at)
   FROM recipes r WHERE r.author_id=u.id),'[]'),
 'reviews',COALESCE((SELECT json_agg(json_build_object('recipeId',v.recipe_id,'recipeTitle',r.title,'rating',v.rating,'body',v.body,'createdAt',v.created_at,'updatedAt',v.updated_at) ORDER BY v.created_at)
   FROM reviews v JOIN recipes r ON r.id=v.recipe_id WHERE v.user_id=u.id),'[]'),
 'reviewReplies',COALESCE((SELECT json_agg(json_build_object('recipeId',v.recipe_id,'recipeTitle',r.title,'reply',v.reply,'repliedAt',v.replied_at) ORDER BY v.replied_at)
   FROM reviews v JOIN recipes r ON r.id=v.recipe_id WHERE r.author_id=u.id AND v.reply<>''),'[]'),
 'comments',COALESCE((SELECT json_agg(json_build_object('id',m.id,'recipeId',m.recipe_id,'recipeTitle',r.title,'replyTo',m.parent_id,'body',m.body,'createdAt',m.created_at,'updatedAt',m.updated_at) ORDER BY m.created_at)
   FROM comments m JOIN recipes r ON r.id=m.recipe_id WHERE m.user_id=u.id),'[]'),
 'cooked',COALESCE((SELECT json_agg(json_build_object('recipeId',k.recipe_id,'recipeTitle',r.title,'photo',k.photo,'note',k.note,'createdAt',k.created_at) ORDER BY k.created_at)
   FROM cooks k JOIN recipes r ON r.id=k.recipe_id WHERE k.user_id=u.id),'[]'),
 'cookbooks',COALESCE((SELECT json_agg(json_build_object('id',id,'name',name,'description',description,'public',public,'household',household,'createdAt',created_at) ORDER BY created_at) FROM collections WHERE user_id=u.id),'[]'),
 'saves',COALESCE((SELECT json_agg(json_build_object('recipeId',s.recipe_id,'recipeTitle',r.title,'cookbookId',s.collection_id,'savedAt',s.created_at) ORDER BY s.created_at)
   FROM saves s JOIN recipes r ON r.id=s.recipe_id WHERE s.user_id=u.id),'[]'),
 'following',COALESCE((SELECT json_agg(json_build_object('id',c.id,'name',c.name,'handle',c.handle) ORDER BY c.name) FROM follows f JOIN users c ON c.id=f.creator_id WHERE f.user_id=u.id),'[]'),
 'mealPlans',COALESCE((SELECT json_agg(json_build_object('id',p.id,'day',p.day,'meal',p.meal,'servings',p.servings,'recipeId',p.recipe_id,'recipeTitle',r.title) ORDER BY p.day,p.meal)
   FROM meal_plans p JOIN recipes r ON r.id=p.recipe_id WHERE p.user_id=u.id),'[]'),
 'groceries',COALESCE((SELECT json_agg(json_build_object('id',id,'name',name,'quantity',quantity,'category',category,'checked',checked,'createdAt',created_at) ORDER BY created_at)
   FROM groceries WHERE user_id=u.id),'[]'),
 'pantry',COALESCE((SELECT json_agg(json_build_object('id',id,'name',name,'quantity',quantity,'expiresOn',expires_on) ORDER BY name) FROM pantry WHERE user_id=u.id),'[]'),
 'studioConversations',COALESCE((SELECT json_agg(json_build_object('id',p.id,'createdAt',p.created_at,'updatedAt',p.updated_at,
   'messages',COALESCE((SELECT json_agg(json_build_object('role',e.role,'text',e.content,'createdAt',e.created_at) ORDER BY e.seq) FROM voice_events e WHERE e.project_id=p.id),'[]')) ORDER BY p.created_at)
   FROM voice_projects p WHERE p.user_id=u.id AND p.deleted_at IS NULL),'[]'),
 'aiJobs',COALESCE((SELECT json_agg(json_build_object('kind',kind,'prompt',prompt,'status',status,'createdAt',created_at) ORDER BY created_at) FROM ai_jobs WHERE user_id=u.id),'[]'),
 'household',(SELECT json_build_object('name',h.name,'role',m.role,'joinedAt',m.joined_at) FROM household_members m JOIN households h ON h.id=m.household_id WHERE m.user_id=u.id),
 'devices',COALESCE((SELECT json_agg(json_build_object('signedInAt',created_at,'lastUsedAt',last_used_at,'expiresAt',expires_at,'userAgent',user_agent) ORDER BY created_at) FROM sessions WHERE user_id=u.id),'[]'),
 'notificationDevices',COALESCE((SELECT json_agg(json_build_object('platform',platform,'registeredAt',created_at,'lastSeenAt',last_seen_at) ORDER BY created_at) FROM push_tokens WHERE user_id=u.id),'[]'),
 'usageEvents',COALESCE((SELECT json_agg(json_build_object('name',name,'details',props,'at',created_at) ORDER BY created_at) FROM events WHERE user_id=u.id),'[]'),
 'cookSessions',COALESCE((SELECT json_agg(json_build_object('recipeId',k.recipe_id,'recipeTitle',r.title,'startedAt',k.started_at,'finishedAt',k.finished_at,
   'stepReached',k.step_reached,'steps',k.steps,'verifiedCook',k.verified,
   'stepEvents',COALESCE((SELECT json_agg(json_build_object('kind',e.kind,'step',e.step,'atMs',e.at_ms) ORDER BY e.seq) FROM cook_step_events e WHERE e.session_id=k.id),'[]'))
   ORDER BY k.started_at) FROM cook_sessions k JOIN recipes r ON r.id=k.recipe_id WHERE k.user_id=u.id),'[]'),
 'cookQuestions',COALESCE((SELECT json_agg(json_build_object('recipeId',q.recipe_id,'recipeTitle',r.title,'step',q.step,'question',q.question,'askedAt',q.created_at) ORDER BY q.created_at)
   FROM cook_questions q JOIN recipes r ON r.id=q.recipe_id WHERE q.user_id=u.id),'[]'),
 'connectedApps',COALESCE((SELECT json_agg(json_build_object('app',c.name,'scopes',g.scopes,'linkedAt',g.created_at,'lastUsedAt',g.last_used_at) ORDER BY g.created_at)
   FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.user_id=u.id),'[]'),
 'recipeEdits',COALESCE((SELECT json_agg(json_build_object('recipeId',x.recipe_id,'recipeTitle',r.title,'kind',x.kind,'before',x.before,'after',x.after,'said',x.said,
   'updatedAt',x.updated_at) ORDER BY x.recipe_id,x.place) FROM recipe_edits x JOIN recipes r ON r.id=x.recipe_id WHERE x.user_id=u.id),'[]'),
 'kitchenNotes',COALESCE((SELECT json_agg(json_build_object('note',n.note,'createdAt',n.created_at) ORDER BY n.created_at) FROM kitchen_notes n WHERE n.user_id=u.id),'[]'),
 'recipeSuggestions',COALESCE((SELECT json_agg(json_build_object('recipeId',x.recipe_id,'recipeTitle',r.title,'kind',x.kind,'before',x.before,'after',x.after,'reason',x.reason,
   'status',x.status,'response',x.response,'createdAt',x.created_at,'decidedAt',x.decided_at) ORDER BY x.created_at) FROM recipe_suggestions x JOIN recipes r ON r.id=x.recipe_id WHERE x.user_id=u.id),'[]'),
 'creatorEarnings',COALESCE((SELECT json_agg(json_build_object('month',e.month,'amountCents',e.amount_cents,'cooks',e.cooks,'status',e.status,'paidAt',e.paid_at) ORDER BY e.month)
   FROM creator_earnings e WHERE e.creator_id=u.id),'[]'),
 'creatorPayouts',COALESCE((SELECT json_agg(json_build_object('amountCents',p.amount_cents,'status',p.status,'createdAt',p.created_at) ORDER BY p.created_at)
   FROM creator_payouts p WHERE p.creator_id=u.id),'[]'),
 'payoutAccount',(SELECT json_build_object('country',a.country,'payoutsEnabled',a.payouts_enabled,'connectedAt',a.created_at) FROM creator_accounts a WHERE a.user_id=u.id AND a.stripe_account_id IS NOT NULL),
 'imports',COALESCE((SELECT json_agg(json_build_object('purpose',b.purpose,'site',b.site,'createdAt',b.created_at,'finishedAt',b.finished_at,
   'permission',CASE WHEN b.permission_at IS NOT NULL THEN json_build_object('statement',b.permission_statement,'agreedAt',b.permission_at) END,
   'links',COALESCE((SELECT json_agg(json_build_object('url',i.url,'status',i.status,'recipeId',i.recipe_id) ORDER BY i.position) FROM import_items i WHERE i.batch_id=b.id AND i.url<>''),'[]'),
   'texts',COALESCE((SELECT json_agg(json_build_object('text',i.pasted,'status',i.status,'recipeId',i.recipe_id) ORDER BY i.position) FROM import_items i WHERE i.batch_id=b.id AND i.pasted<>''),'[]')) ORDER BY b.created_at)
   FROM import_batches b WHERE b.user_id=u.id),'[]'),
 'recordings',COALESCE((SELECT json_agg(json_build_object('id',x.id,'speaker',x.speaker,'url',x.url,'type',x.mime,'bytes',x.bytes,'durationMs',x.duration_ms,
   'language',x.language,'transcript',x.transcript,'recipeId',x.recipe_id,'recipeTitle',r.title,'consentedAt',x.consent_at,'createdAt',x.created_at) ORDER BY x.created_at,x.id)
   FROM recordings x LEFT JOIN recipes r ON r.id=x.recipe_id WHERE x.user_id=u.id),'[]')
) FROM users u WHERE u.id=$1`

// sendExport answers with the member's export as a download.
func (a *App) sendExport(c fiber.Ctx, owner string) error {
	var b []byte
	e := a.DB.QueryRow(c.Context(), exportSQL, owner).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "This item could not be found.")
	}
	if e != nil {
		return e
	}
	exportHeaders(c)
	return c.Send(b)
}

func exportHeaders(c fiber.Ctx) {
	c.Set("Content-Type", "application/json")
	c.Set("Content-Disposition", `attachment; filename="savorly-export-`+time.Now().UTC().Format("2006-01-02")+`.json"`)
	c.Set("Cache-Control", "no-store")
}

func (a *App) exportMe(c fiber.Ctx) error { return a.sendExport(c, userID(c)) }

// exportLink lets a native app hand the download to the browser, which can't carry its bearer
// token: a single-use link, valid for ten minutes. A new link replaces the member's earlier one.
// An optional {"format":"files"} makes it a link to the export as files (export_files.go).
func (a *App) exportLink(c fiber.Ctx) error {
	var in struct{ Format string }
	if len(c.Body()) > 0 {
		if e := decode(c, &in); e != nil {
			return e
		}
	}
	switch in.Format {
	case "":
		in.Format = "json"
	case "json", "files":
	default:
		return fiber.NewError(400, "Choose the JSON file or the files.")
	}
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return e
	}
	tok, owner := hex.EncodeToString(b), userID(c)
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	if _, e = tx.Exec(c.Context(), `DELETE FROM export_tokens WHERE user_id=$1 OR expires_at<now()`, owner); e != nil {
		return e
	}
	var expires time.Time
	if e = tx.QueryRow(c.Context(), `INSERT INTO export_tokens(token_hash,user_id,expires_at,format) VALUES($1,$2,now()+interval '10 minutes',$3) RETURNING expires_at`, hashToken(tok), owner, in.Format).Scan(&expires); e != nil {
		return e
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	// Relative to the API's base URL: behind the Worker, the API can't see its public prefix.
	return c.JSON(fiber.Map{"url": "/v1/export/" + tok, "expiresAt": expires})
}

// exportByToken serves a link from exportLink once, as JSON or as files.
func (a *App) exportByToken(c fiber.Ctx) error {
	hash := hashToken(c.Params("token"))
	var owner, format string
	e := a.DB.QueryRow(c.Context(), `SELECT user_id,format FROM export_tokens WHERE token_hash=$1 AND expires_at>now()`, hash).Scan(&owner, &format)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, expiredExportLink)
	}
	if e != nil {
		return e
	}
	if c.Method() == fiber.MethodHead {
		// Download managers probe before fetching; a probe mustn't spend the link.
		if format == "files" {
			exportFilesHeaders(c)
		} else {
			exportHeaders(c)
		}
		return nil
	}
	release := func() {}
	if format == "files" {
		// While the member's files are already downloading, the link stays unspent.
		if release, e = exportFilesSlot(owner); e != nil {
			return e
		}
	}
	// Spending the link is what serves it, so two requests can't both use it.
	if e = a.DB.QueryRow(c.Context(), `DELETE FROM export_tokens WHERE token_hash=$1 AND expires_at>now() RETURNING user_id`, hash).Scan(&owner); e != nil {
		release()
		if errors.Is(e, pgx.ErrNoRows) {
			return fiber.NewError(404, expiredExportLink)
		}
		return e
	}
	if format == "files" {
		return a.sendExportFiles(c, owner, release)
	}
	return a.sendExport(c, owner)
}

const expiredExportLink = "This download link has expired or was already used. Create a new one in My kitchen."
