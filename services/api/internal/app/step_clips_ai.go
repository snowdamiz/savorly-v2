package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"savorly/api/internal/ai"
)

// AI clips of a recipe's steps. Only the cook asks for them, in the editor or of the sous-chef;
// nothing makes them on its own. Each step without a clip gets one four-second clip
// (ai.Client.Video), made from its words, or from its photo when it has one, and the clip goes
// onto the step once it's ready (syncStepClips).

// stepClipsSQL lists a recipe's clips ordered in the last day, the latest for each step text,
// in the order they were ordered: {text, status, error, url}, where text is the step's text when
// its clip was ordered, which is how the app finds the step.
const stepClipsSQL = `SELECT COALESCE(jsonb_agg(x ORDER BY created,step),'[]') FROM (SELECT DISTINCT ON (c.step_text)
 jsonb_build_object('text',c.step_text,'status',j.status,'error',j.error,'url',j.result->>'url') x, j.created_at created, c.step
 FROM step_clip_jobs c JOIN ai_jobs j ON j.id=c.job_id WHERE c.recipe_id=$1 AND j.user_id=$2 AND j.created_at>now()-interval '1 day'
 ORDER BY c.step_text, j.created_at DESC) s`

// GET /recipes/:id/step-clips: the clips being made for one of the member's recipes, and the
// ones made in the last day.
func (a *App) stepClips(c fiber.Ctx) error {
	var clips json.RawMessage
	if e := a.DB.QueryRow(c.Context(), stepClipsSQL, c.Params("id"), userID(c)).Scan(&clips); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"clips": clips})
}

// POST /recipes/:id/step-clips orders a clip for every step of the member's recipe that has
// none, once per Idempotency-Key.
func (a *App) orderStepClips(c fiber.Ctx) error {
	clips, queued, e := a.queueStepClips(c.Context(), userID(c), c.Params("id"), c.Get("Idempotency-Key"))
	if e != nil {
		return e
	}
	if queued {
		c.Status(202)
	}
	return c.JSON(fiber.Map{"clips": clips})
}

// clipsUnavailable says why this server can't make clips at all, or "".
func (a *App) clipsUnavailable() string {
	if !a.AI.VideoEnabled() {
		return "Step clips need a reAPI connection on the server."
	}
	if a.Media == nil || a.Media.S3 == nil {
		return "Connect R2 or local SeaweedFS to generate recipe media."
	}
	return ""
}

// queueStepClips reserves the member's allowance and budget for a clip of each step of their
// recipe that has none and none on its way, and queues them: all of them, or, when the plan or
// the budget can't cover every one, none. It answers the recipe's clips and whether this call
// queued them (rather than finding them from an earlier one with the same key).
func (a *App) queueStepClips(ctx context.Context, owner, recipe, key string) (json.RawMessage, bool, error) {
	if len(key) < 8 || len(key) > 100 {
		return nil, false, fiber.NewError(400, "A valid Idempotency-Key is required.")
	}
	if message := a.clipsUnavailable(); message != "" {
		return nil, false, fiber.NewError(503, message)
	}
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return nil, false, e
	}
	defer tx.Rollback(ctx)
	// Serialize each user's limit check and insert, preventing concurrent overspending.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return nil, false, e
	}
	var title string
	var raw []byte
	e = tx.QueryRow(ctx, `SELECT title,steps FROM recipes WHERE id=$1 AND author_id=$2 FOR UPDATE`, recipe, owner).Scan(&title, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, false, fiber.NewError(404, "Only your own recipes can get step clips.")
	}
	if e != nil {
		return nil, false, e
	}
	var earlier []string
	if e = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(DISTINCT c.recipe_id),'{}') FROM step_clip_jobs c JOIN ai_jobs j ON j.id=c.job_id WHERE j.user_id=$1 AND c.batch=$2`, owner, key).Scan(&earlier); e != nil {
		return nil, false, e
	}
	if len(earlier) > 0 {
		if len(earlier) > 1 || earlier[0] != recipe {
			return nil, false, fiber.NewError(409, "This request key was used for a different generation.")
		}
		clips, e := recipeClips(ctx, tx, recipe, owner)
		return clips, false, e
	}
	var steps []Step
	if e = json.Unmarshal(raw, &steps); e != nil {
		return nil, false, e
	}
	var busy []string
	if e = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(c.step_text),'{}') FROM step_clip_jobs c JOIN ai_jobs j ON j.id=c.job_id WHERE c.recipe_id=$1 AND j.status IN ('queued','running','processing')`, recipe).Scan(&busy); e != nil {
		return nil, false, e
	}
	ordered := map[string]bool{}
	for _, text := range busy {
		ordered[text] = true
	}
	want, places := []Step{}, []int{}
	for i, s := range steps {
		text := strings.TrimSpace(s.Text)
		if s.Video != "" || text == "" || ordered[text] {
			continue
		}
		ordered[text] = true
		want, places = append(want, s), append(places, i)
	}
	if len(want) == 0 {
		return nil, false, fiber.NewError(409, "Every step already has a clip, or one on its way.")
	}
	if e = allowanceFor(ctx, tx, owner, "clip", len(want)); e != nil {
		return nil, false, e
	}
	estimate := ai.GenerationEstimate("clip")
	if e = reserveGeneration(ctx, tx, owner, estimate*float64(len(want))); e != nil {
		return nil, false, e
	}
	for i, s := range want {
		// The provider reads the photo itself, so only a public one can open the clip.
		frame := ""
		if strings.HasPrefix(s.Image, "https://") {
			frame = s.Image
		}
		id := uuid.NewString()
		_, e = tx.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,source,request_key,estimated_cost) VALUES($1,$2,'clip',$3,$4,$5,$6)`,
			id, owner, stepClipPrompt(title, s, frame != ""), frame, "clip-"+key+"-"+strconv.Itoa(i), estimate)
		if e != nil {
			return nil, false, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO step_clip_jobs(job_id,recipe_id,step_text,step,batch) VALUES($1,$2,$3,$4,$5)`, id, recipe, strings.TrimSpace(s.Text), places[i], key); e != nil {
			return nil, false, e
		}
	}
	if e = announce(ctx, tx, "jobs"); e != nil {
		return nil, false, e
	}
	clips, e := recipeClips(ctx, tx, recipe, owner)
	if e != nil {
		return nil, false, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, false, e
	}
	a.wake("jobs")
	return clips, true, nil
}

func recipeClips(ctx context.Context, q querier, recipe, owner string) (json.RawMessage, error) {
	var clips json.RawMessage
	e := q.QueryRow(ctx, stepClipsSQL, recipe, owner).Scan(&clips)
	return clips, e
}

// stepClipPrompt describes one step for its clip: what happens, in the recipe it belongs to.
// The provider recommends prompts of 500 characters or fewer.
func stepClipPrompt(recipe string, s Step, photo bool) string {
	what := strings.TrimSpace(s.Text)
	if t := strings.TrimSpace(s.Title); t != "" {
		what = t + ": " + what
	}
	prompt := fmt.Sprintf("One step of the recipe “%s”. %s", truncate(recipe, 80), truncate(what, 320))
	if photo {
		prompt = "Bring this photo of the step to life. " + prompt
	}
	return prompt + " Hands may appear, but no faces and no on-screen text."
}

// syncStepClips puts finished clips on their steps: the step with the same text that has no clip
// yet. A step whose text changed, or that got a clip of its own meanwhile, keeps what it has; the
// clip stays in the member's AI history. Failed clips are settled too, with nothing to put on.
func (a *App) syncStepClips(ctx context.Context) {
	rows, e := a.DB.Query(ctx, `SELECT c.job_id,c.recipe_id,c.step_text,COALESCE(j.result->>'url','') FROM step_clip_jobs c JOIN ai_jobs j ON j.id=c.job_id
 WHERE NOT c.applied AND j.status IN ('completed','failed') ORDER BY j.updated_at LIMIT 50`)
	if e != nil {
		if ctx.Err() == nil {
			slog.Error("step clips", "error", e)
		}
		return
	}
	type finished struct{ job, recipe, text, url string }
	list := []finished{}
	for rows.Next() {
		var f finished
		if rows.Scan(&f.job, &f.recipe, &f.text, &f.url) == nil {
			list = append(list, f)
		}
	}
	rows.Close()
	for _, f := range list {
		if e = a.applyStepClip(ctx, f.job, f.recipe, f.text, f.url); e != nil && ctx.Err() == nil {
			slog.Error("apply step clip", "job", f.job, "error", e)
		}
	}
}

func (a *App) applyStepClip(ctx context.Context, job, recipe, text, url string) error {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var raw []byte
	e = tx.QueryRow(ctx, `SELECT steps FROM recipes WHERE id=$1 FOR UPDATE`, recipe).Scan(&raw)
	if e != nil {
		return e
	}
	if url != "" && validMedia(url) {
		var steps []Step
		if e = json.Unmarshal(raw, &steps); e != nil {
			return e
		}
		for i := range steps {
			if strings.TrimSpace(steps[i].Text) == text && steps[i].Video == "" {
				steps[i].Video = url
				if _, e = tx.Exec(ctx, `UPDATE recipes SET steps=$2,ai_generated=true,updated_at=now() WHERE id=$1`, recipe, jsonBytes(steps)); e != nil {
					return e
				}
				break
			}
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE step_clip_jobs SET applied=true WHERE job_id=$1`, job); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
