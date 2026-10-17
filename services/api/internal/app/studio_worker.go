package app

import (
	"context"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"log/slog"
	"savorly/api/internal/ai"
	"slices"
	"sync"
	"time"
)

// queueStudioAssets starts media for the current revision. redo picks which existing
// jobs are replaced: "missing" (none), "failed", or "all" (an explicit regeneration).
func (a *App) queueStudioAssets(ctx context.Context, state studioState, redo string, kinds ...string) error {
	if len(kinds) == 0 {
		kinds = []string{"image", "video"}
	}
	if state.Recipe == nil {
		return fiber.NewError(400, "Make the recipe before generating media.")
	}
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, state.Owner); e != nil {
		return e
	}
	var revision int
	if e = tx.QueryRow(ctx, `SELECT revision FROM voice_projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, state.ID).Scan(&revision); e != nil {
		return e
	}
	if revision != state.Revision {
		return nil
	}
	plan, e := planOf(ctx, tx, state.Owner)
	if e != nil {
		return e
	}
	queued := false
	for _, kind := range kinds {
		// Automatic media skips what the plan doesn't include, or the server can't make, rather
		// than showing a failure. Explicit regeneration still explains why.
		if redo == "missing" && ((kind == "video" && (plan.Videos == 0 || !a.AI.VideoEnabled())) || (kind == "image" && plan.Images == 0)) {
			continue
		}
		var status string
		e = tx.QueryRow(ctx, `SELECT j.status FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=$1 AND v.revision=$2 AND v.kind=$3`, state.ID, revision, kind).Scan(&status)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		// Even an explicit regeneration leaves one that's still being made alone.
		if e == nil && (redo == "missing" || (redo == "failed" && status != "failed") || (redo == "all" && inFlight(status))) {
			continue
		}
		estimate := ai.GenerationEstimate(kind)
		message := a.mediaUnavailable(kind)
		if message == "" {
			e = allowance(ctx, tx, state.Owner, kind)
			if e == nil {
				e = reserveGeneration(ctx, tx, state.Owner, estimate)
			}
			if e != nil {
				var fe *fiber.Error
				if !errors.As(e, &fe) {
					return e
				}
				message = fe.Message
			}
		}
		jobStatus := "queued"
		if message != "" {
			jobStatus = "failed"
			estimate = 0
		} else {
			queued = true
		}
		r := *state.Recipe
		r.Image = ""
		r.Video = ""
		prompt := fmt.Sprintf("Illustrate this exact recipe. Do not add ingredients or imply the generated scene is actual footage of its author. Recipe: %s", jsonBytes(r))
		id := uuid.NewString()
		key := "studio-" + id
		_, e = tx.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, state.Owner, kind, truncate(prompt, 12000), key, estimate, jobStatus, message)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO voice_assets(project_id,revision,kind,job_id) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,revision,kind) DO UPDATE SET job_id=excluded.job_id,applied=false`, state.ID, revision, kind, id)
		if e != nil {
			return e
		}
	}
	_, e = tx.Exec(ctx, `UPDATE voice_projects SET status=CASE WHEN status='published' THEN status ELSE 'generating' END,updated_at=now() WHERE id=$1`, state.ID)
	if e != nil {
		return e
	}
	if queued {
		if e = announce(ctx, tx, "jobs"); e != nil {
			return e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	if queued {
		a.wake("jobs")
	}
	return nil
}

func inFlight(status string) bool {
	return status == "queued" || status == "running" || status == "processing"
}

// mediaUnavailable says why this server can't make kind at all, or "".
func (a *App) mediaUnavailable(kind string) string {
	message := ""
	if kind == "video" {
		if !a.AI.VideoEnabled() {
			message = "Video generation needs a reAPI connection. The recipe is saved."
		}
	} else if !a.AI.TextEnabled() {
		message = "Image generation needs an OpenRouter connection."
	}
	if a.Media == nil || a.Media.S3 == nil {
		message = "Connect R2 or local SeaweedFS to generate recipe media."
	}
	return message
}

// mediaToOrder drops the kinds the conversation's draft is already getting, when recipe is
// that draft.
func (a *App) mediaToOrder(ctx context.Context, state studioState, recipe string, kinds []string) ([]string, error) {
	if recipe != state.RecipeID {
		return kinds, nil
	}
	var busy []string
	e := a.DB.QueryRow(ctx, `SELECT COALESCE(array_agg(v.kind),'{}') FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=$1 AND v.revision=$2 AND j.status IN ('queued','running','processing')`, state.ID, state.Revision).Scan(&busy)
	if e != nil {
		return nil, e
	}
	order := []string{}
	for _, kind := range kinds {
		if !slices.Contains(busy, kind) {
			order = append(order, kind)
		}
	}
	return order, nil
}

// mediaAllowed checks the plan, budgets and providers for kinds without reserving anything,
// so a refusal leaves the conversation as it was. queueStudioAssets reserves for real.
func (a *App) mediaAllowed(ctx context.Context, owner string, kinds []string) error {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return e
	}
	estimate := 0.0
	for _, kind := range kinds {
		if message := a.mediaUnavailable(kind); message != "" {
			return fiber.NewError(503, message)
		}
		if e = allowance(ctx, tx, owner, kind); e != nil {
			return e
		}
		estimate += ai.GenerationEstimate(kind)
	}
	return reserveGeneration(ctx, tx, owner, estimate)
}

// Compare revisions in the same locked transaction as the write. Old generations
// cannot overwrite a corrected draft, even when a provider finishes out of order.
func (a *App) syncStudioAssets(ctx context.Context) error {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, `SELECT p.id,p.recipe_id,v.kind,j.result->>'url',v.revision FROM voice_assets v JOIN voice_projects p ON p.id=v.project_id AND p.revision=v.revision JOIN ai_jobs j ON j.id=v.job_id WHERE NOT v.applied AND j.status='completed' AND p.recipe_id IS NOT NULL FOR UPDATE OF p,v SKIP LOCKED LIMIT 20`)
	if e != nil {
		return e
	}
	type asset struct {
		project, recipe, kind, url string
		revision                   int
	}
	list := []asset{}
	for rows.Next() {
		var x asset
		if e = rows.Scan(&x.project, &x.recipe, &x.kind, &x.url, &x.revision); e != nil {
			rows.Close()
			return e
		}
		list = append(list, x)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, x := range list {
		if x.url == "" || !validMedia(x.url) {
			continue
		}
		column := "image"
		if x.kind == "video" {
			column = "video"
		}
		if _, e = tx.Exec(ctx, `UPDATE recipes SET `+column+`=$2,ai_generated=true,updated_at=now() WHERE id=$1`, x.recipe, x.url); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE voice_assets SET applied=true WHERE project_id=$1 AND revision=$2 AND kind=$3`, x.project, x.revision, x.kind); e != nil {
			return e
		}
	}
	_, e = tx.Exec(ctx, `UPDATE voice_projects p SET status=CASE WHEN EXISTS(SELECT 1 FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=p.id AND v.revision=p.revision AND j.status='failed') THEN 'needs_attention' ELSE 'ready' END,updated_at=now() WHERE p.status='generating' AND EXISTS(SELECT 1 FROM voice_assets WHERE project_id=p.id AND revision=p.revision) AND NOT EXISTS(SELECT 1 FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=p.id AND v.revision=p.revision AND j.status IN ('queued','running','processing'))`)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}

// studioSlots bounds the turns one replica runs at once. A conversation still runs one turn
// at a time: the claim skips conversations with one running, and the voice_action_one_running
// index holds across replicas.
const studioSlots = 8

// runStudioWorker returns once the turns it started have settled. Stopping cancels them, and
// each still records its outcome.
func (a *App) runStudioWorker(ctx context.Context) {
	var wg sync.WaitGroup
	defer wg.Wait()
	purged := time.Time{}
	wg.Go(func() {
		every(ctx, sweepEvery, func() {
			a.studioSweeps(ctx)
			if time.Since(purged) >= time.Hour {
				purged = time.Now()
				if e := a.purgeDeletedConversations(ctx); e != nil && ctx.Err() == nil {
					slog.Error("purge deleted conversations", "error", e)
				}
			}
		})
	})
	w := a.wakeups()
	slots := make(chan struct{}, studioSlots)
	pace(ctx, w.studio, studioPace, func() bool {
		if e := a.syncStudioAssets(ctx); e != nil && ctx.Err() == nil {
			slog.Error("studio media sync", "error", e)
		}
		found := false
		for {
			select {
			case slots <- struct{}{}:
			default:
				return found // A finishing turn wakes the loop.
			}
			id, project, through, ok := a.claimTurn(ctx)
			if !ok {
				<-slots
				return found
			}
			found = true
			wg.Go(func() {
				defer func() { <-slots; poke(w.studio) }()
				a.processVoiceAction(ctx, id, project, through)
			})
		}
	})
}

// claimTurn starts the oldest queued turn in a conversation with none running.
func (a *App) claimTurn(ctx context.Context) (id, project string, through int64, ok bool) {
	e := a.DB.QueryRow(ctx, `UPDATE voice_actions SET status='running',updated_at=now(),started_at=now() WHERE id=(SELECT x.id FROM voice_actions x WHERE x.status='queued' AND NOT EXISTS(SELECT 1 FROM voice_actions busy WHERE busy.project_id=x.project_id AND busy.status='running') AND EXISTS(SELECT 1 FROM voice_projects p WHERE p.id=x.project_id AND p.deleted_at IS NULL) ORDER BY x.created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,project_id,through_seq`).Scan(&id, &project, &through)
	var pe *pgconn.PgError
	switch {
	case e == nil:
		return id, project, through, true
	case errors.As(e, &pe) && pe.Code == "23505":
		// Another replica started a turn in the same conversation first; look again.
		poke(a.wakeups().studio)
	case !errors.Is(e, pgx.ErrNoRows) && ctx.Err() == nil:
		slog.Error("studio claim", "error", e)
	}
	return "", "", 0, false
}

// studioSweeps recover what a crash, a stuck provider or a killed replica left behind.
func (a *App) studioSweeps(ctx context.Context) {
	a.recoverStudioBundles(ctx)
	a.cleanStudioSources(ctx)
	if e := a.failStalledTurns(ctx); e != nil && ctx.Err() == nil {
		slog.Error("studio recovery", "error", e)
	}
	if e := endStaleVoice(ctx, a.DB, ""); e != nil && ctx.Err() == nil {
		slog.Error("voice session sweep", "error", e)
	}
}

// interruptedReplies answers for a turn that stopped without settling (its server died), in
// the language the app last reported for the conversation.
var interruptedReplies = map[string]string{
	"en": "That step was interrupted. Your conversation is saved; ask me to continue.",
	"fr": "Cette étape a été interrompue. Votre conversation est enregistrée ; demandez-moi de continuer.",
	"de": "Dieser Schritt wurde unterbrochen. Dein Gespräch ist gespeichert; bitte mich einfach, weiterzumachen.",
	"ru": "Этот шаг был прерван. Беседа сохранена — попросите меня продолжить.",
	"es": "Ese paso se interrumpió. Tu conversación está guardada; pídeme que continúe.",
	"it": "Questo passaggio si è interrotto. La conversazione è salvata: chiedimi di continuare.",
	"pt": "Essa etapa foi interrompida. Sua conversa está salva; peça para eu continuar.",
	"zh": "这一步被中断了。对话已保存，让我继续即可。",
	"ja": "この手順は中断されました。会話は保存されているので、続けるよう声をかけてください。",
}

// failStalledTurns fails turns running for over five minutes. Like any failed turn, it drops
// the read-back approval and proposal the user never saw answered.
func (a *App) failStalledTurns(ctx context.Context) error {
	_, e := a.DB.Exec(ctx, `WITH failed AS (UPDATE voice_actions x SET status='failed',reply=COALESCE($1::jsonb->>(SELECT p.context->>'language' FROM voice_projects p WHERE p.id=x.project_id),$1::jsonb->>'en'),updated_at=now() WHERE x.status='running' AND x.updated_at<now()-interval '5 minutes' RETURNING *),
 lapsed AS (UPDATE voice_projects SET confirmed_revision=-1,pending=NULL WHERE id IN (SELECT project_id FROM failed))
 INSERT INTO voice_events(project_id,session_id,event_id,role,content) SELECT project_id,session_id,'result_'||id,'assistant',reply FROM failed ON CONFLICT DO NOTHING`, jsonBytes(interruptedReplies))
	return e
}

// Recover the narrow window between saving a draft and enqueueing its media.
// Existing job links are idempotent; failed/ambiguous jobs require an explicit retry.
func (a *App) recoverStudioBundles(ctx context.Context) {
	rows, e := a.DB.Query(ctx, `SELECT p.id FROM voice_projects p WHERE p.auto_media AND p.recipe_id IS NOT NULL AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM voice_assets WHERE project_id=p.id AND revision=p.revision) LIMIT 5`)
	if e != nil {
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		state, e := a.studioProject(ctx, id)
		if e == nil {
			e = a.queueStudioAssets(ctx, state, "missing")
		}
		if e != nil {
			slog.Warn("recover recipe media", "error", e)
		}
	}
}
func (a *App) cleanStudioSources(ctx context.Context) {
	if a.Media == nil || a.Media.S3 == nil {
		return
	}
	rows, e := a.DB.Query(ctx, `SELECT object_key FROM source_deletions LIMIT 10`)
	if e != nil {
		return
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if rows.Scan(&key) == nil {
			keys = append(keys, key)
		}
	}
	rows.Close()
	for _, key := range keys {
		_, e = a.Media.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(key)})
		if e == nil {
			_, _ = a.DB.Exec(ctx, `DELETE FROM source_deletions WHERE object_key=$1`, key)
		}
	}
}
