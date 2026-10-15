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
	"log/slog"
	"savorly/api/internal/ai"
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
	if e = tx.QueryRow(ctx, `SELECT revision FROM voice_projects WHERE id=$1 FOR UPDATE`, state.ID).Scan(&revision); e != nil {
		return e
	}
	if revision != state.Revision {
		return nil
	}
	plan, e := planOf(ctx, tx, state.Owner)
	if e != nil {
		return e
	}
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
		if e == nil && (redo == "missing" || (redo == "failed" && status != "failed")) {
			continue
		}
		estimate := ai.GenerationEstimate(kind)
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
	return tx.Commit(ctx)
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
func (a *App) runStudioWorker(ctx context.Context) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			a.recoverStudioBundles(ctx)
			a.cleanStudioSources(ctx)
			_, e := a.DB.Exec(ctx, `WITH failed AS (UPDATE voice_actions SET status='failed',reply='That step was interrupted. Your conversation is saved; ask me to continue.',updated_at=now() WHERE status='running' AND updated_at<now()-interval '5 minutes' RETURNING *) INSERT INTO voice_events(project_id,session_id,event_id,role,content) SELECT project_id,session_id,'result_'||id,'assistant',reply FROM failed ON CONFLICT DO NOTHING`)
			if e != nil {
				slog.Error("studio recovery", "error", e)
			}
			if e = a.syncStudioAssets(ctx); e != nil {
				slog.Error("studio media sync", "error", e)
			}
			var id, project string
			var through int64
			e = a.DB.QueryRow(ctx, `UPDATE voice_actions SET status='running',updated_at=now() WHERE id=(SELECT x.id FROM voice_actions x WHERE x.status='queued' AND NOT EXISTS(SELECT 1 FROM voice_actions busy WHERE busy.project_id=x.project_id AND busy.status='running') ORDER BY x.created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,project_id,through_seq`).Scan(&id, &project, &through)
			if errors.Is(e, pgx.ErrNoRows) {
				continue
			}
			if e != nil {
				slog.Error("studio claim", "error", e)
				continue
			}
			a.processVoiceAction(ctx, id, project, through)
		}
	}
}

// Recover the narrow window between saving a draft and enqueueing its media.
// Existing job links are idempotent; failed/ambiguous jobs require an explicit retry.
func (a *App) recoverStudioBundles(ctx context.Context) {
	rows, e := a.DB.Query(ctx, `SELECT p.id FROM voice_projects p WHERE p.auto_media AND p.recipe_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM voice_assets WHERE project_id=p.id AND revision=p.revision) LIMIT 5`)
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
		state, e := a.studioState(ctx, id, 0)
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
