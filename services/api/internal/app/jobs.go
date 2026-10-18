package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

const jobJSON = `jsonb_build_object('id',id,'kind',kind,'prompt',prompt,'source',source,'status',status,'result',result,'error',error,'createdAt',created_at)`

// jobs lists the member's latest jobs, leaving out a bulk import's, whose recipes are saved as
// drafts already (import_batches.go).
func (a *App) jobs(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT `+jobJSON+` FROM ai_jobs WHERE user_id=$1 AND NOT starts_with(request_key,$2) ORDER BY created_at DESC LIMIT 30`, userID(c), batchJobKey)
}
func (a *App) job(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT `+jobJSON+` FROM ai_jobs WHERE id=$1 AND user_id=$2`, c.Params("id"), userID(c))
}

// createJob makes a photo or a clip from a description (the editor's Create a cover photo and
// Create a short clip). Questions, twists, swaps, nutrition, meal plans and new recipes are the
// sous-chef's conversation; a recipe job is made only by importing a page.
func (a *App) createJob(c fiber.Ctx) error {
	var in struct{ Kind, Prompt string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if (in.Kind != "image" && in.Kind != "video") || !validText(in.Prompt, 8, 12000) {
		return fiber.NewError(400, "Choose a tool and describe what you would like (8–12,000 characters).")
	}
	if in.Kind == "video" && !a.AI.VideoEnabled() {
		return fiber.NewError(503, "Video generation is not connected yet. Add a reAPI key on the server.")
	}
	if in.Kind != "video" && !a.AI.TextEnabled() {
		return fiber.NewError(503, "The sous-chef is not connected yet. Add an OpenRouter key on the server.")
	}
	return a.queueJob(c, in.Kind, in.Prompt, "")
}

// Touch-ups keep the subject exactly as it is: they polish a photo rather than invent one.
var touchUps = map[string]string{
	"avatar": "Retouch this photo into a polished profile picture. Keep the same person or subject exactly as they are: identical face, features, skin tone, age, expression, hair, clothing and pose, so it is unmistakably them. Improve exposure, white balance, color and sharpness, gently soften harsh shadows and noise, and calm a distracting background with a soft natural blur. Keep the subject centered and the framing the same. Photorealistic and natural: no filters, illustration, beauty smoothing, text, borders or added objects.",
	"dish":   "Retouch this food photo so the dish looks its best. Keep the same dish, plating, ingredients, portions and tableware exactly as they are, in the same framing. Improve light, white balance, color and sharpness, reduce noise and glare, and tidy small smudges or crumbs on the plate and table. Photorealistic editorial food photography: no text, watermarks, filters, or added food or props.",
}

// touchUp queues an AI retouch of a photo the member already has: one they uploaded or
// generated, or the profile photo they use now (such as one from their Google account).
func (a *App) touchUp(c fiber.Ctx) error {
	var in struct{ URL, Kind string }
	if e := decode(c, &in); e != nil {
		return e
	}
	prompt, known := touchUps[in.Kind]
	if !known || !validMedia(in.URL) || in.URL == "" {
		return fiber.NewError(400, "Choose a photo to touch up.")
	}
	if !a.AI.TextEnabled() {
		return fiber.NewError(503, "AI photos are not connected yet. Add an OpenRouter key on the server.")
	}
	if !a.Media.Own(userID(c), in.URL) {
		var avatar string
		if e := a.DB.QueryRow(c.Context(), `SELECT avatar FROM users WHERE id=$1`, userID(c)).Scan(&avatar); e != nil {
			return e
		}
		if avatar != in.URL || !strings.HasPrefix(in.URL, "https://") {
			return fiber.NewError(400, "Touch up a photo you’ve added to Savorly.")
		}
	}
	return a.queueJob(c, "image", prompt, in.URL)
}

// queueJob reserves the member's allowance and budget for one generation and queues it, once
// per Idempotency-Key.
func (a *App) queueJob(c fiber.Ctx, kind, prompt, source string) error {
	job, queued, e := a.enqueueJob(c, c.Get("Idempotency-Key"), kind, prompt, source)
	if e != nil {
		return e
	}
	if queued {
		c.Status(202)
	}
	return c.Type("json").Send(job)
}

// enqueueJob is queueJob with its key given: the job, and whether this request queued it
// (rather than finding it from an earlier one).
func (a *App) enqueueJob(c fiber.Ctx, key, kind, prompt, source string) ([]byte, bool, error) {
	return a.enqueueJobFor(c.Context(), userID(c), key, kind, prompt, source, ai.GenerationEstimate(kind))
}

// enqueueEstimated is enqueueJob reserving estimate rather than the kind's usual reservation: a
// family recording's depends on its length (family.go).
func (a *App) enqueueEstimated(c fiber.Ctx, key, kind, prompt, source string, estimate float64) ([]byte, bool, error) {
	return a.enqueueJobFor(c.Context(), userID(c), key, kind, prompt, source, estimate)
}

// enqueueJobFor is enqueueJob for owner, reserving estimate, outside a request too: a bulk
// import's worker queues its recipe jobs this way.
func (a *App) enqueueJobFor(ctx context.Context, owner, key, kind, prompt, source string, estimate float64) ([]byte, bool, error) {
	if len(key) < 8 || len(key) > 100 {
		return nil, false, fiber.NewError(400, "A valid Idempotency-Key is required.")
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
	var existing []byte
	e = tx.QueryRow(ctx, `SELECT `+jobJSON+` FROM ai_jobs WHERE user_id=$1 AND request_key=$2`, owner, key).Scan(&existing)
	if e == nil {
		var old struct{ Kind, Prompt, Source string }
		json.Unmarshal(existing, &old)
		if old.Kind != kind || old.Prompt != prompt || old.Source != source {
			return nil, false, fiber.NewError(409, "This request key was used for a different generation.")
		}
		return existing, false, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, false, e
	}

	if e = allowance(ctx, tx, owner, kind); e != nil {
		return nil, false, e
	}
	if e = reserveGeneration(ctx, tx, owner, estimate); e != nil {
		return nil, false, e
	}
	var result []byte
	e = tx.QueryRow(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,source,request_key,estimated_cost) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+jobJSON, uuid.NewString(), owner, kind, prompt, source, key, estimate).Scan(&result)
	if e != nil {
		return nil, false, e
	}
	if e = announce(ctx, tx, "jobs"); e != nil {
		return nil, false, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, false, e
	}
	a.wake("jobs")
	return result, true, nil
}

// RunWorker persists every transition. Ambiguous interrupted submissions are never automatically
// re-sent. It returns once everything it started has stopped.
func RunWorker(ctx context.Context, db *pgxpool.Pool, config Config) {
	a := &App{DB: db, Config: config, AI: ai.New(), Media: NewMediaStore()}
	// The API's voice monitors end their sessions and record what they bill before it returns.
	defer a.waitForVoice(15 * time.Second)
	var wg sync.WaitGroup
	defer wg.Wait()
	wg.Go(func() { a.listenForWork(ctx) })
	wg.Go(func() { a.runStudioWorker(ctx) })
	wg.Go(func() { a.runImports(ctx) })
	wg.Go(func() { every(ctx, sweepEvery, func() { a.failStalledJobs(ctx) }) })
	w := a.wakeups()
	slots := make(chan struct{}, 2)
	pace(ctx, w.jobs, jobPace, func() bool {
		found := a.pollVideos(ctx)
		for {
			select {
			case slots <- struct{}{}:
			default:
				return found // A finishing job wakes the loop.
			}
			id, owner, kind, prompt, source, ok := a.claimJob(ctx)
			if !ok {
				<-slots
				return found
			}
			found = true
			wg.Go(func() {
				defer func() { <-slots; poke(w.jobs) }()
				a.processJob(ctx, id, owner, kind, prompt, source)
			})
		}
	})
}
func (a *App) claimJob(ctx context.Context) (id, owner, kind, prompt, source string, ok bool) {
	e := a.DB.QueryRow(ctx, `UPDATE ai_jobs SET status='running',updated_at=now() WHERE id=(SELECT id FROM ai_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,user_id,kind,prompt,source`).Scan(&id, &owner, &kind, &prompt, &source)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) && ctx.Err() == nil {
		slog.Error("claim job", "error", e)
	}
	return id, owner, kind, prompt, source, e == nil
}

// A job cut off mid-request may still have been done, and billed, by the provider.
const jobInterrupted = "Generation was interrupted. Check provider usage before starting a new request."

func (a *App) failStalledJobs(ctx context.Context) {
	_, e := a.DB.Exec(ctx, `UPDATE ai_jobs SET status='failed',error=$1,updated_at=now() WHERE status='running' AND updated_at<now()-interval '10 minutes'`, jobInterrupted)
	if e != nil && ctx.Err() == nil {
		slog.Error("job recovery", "error", e)
	}
}
func (a *App) processJob(parent context.Context, id, owner, kind, prompt, source string) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Minute)
	defer cancel()
	var result json.RawMessage
	var err error
	// Whether the provider was asked: an import that never reached it cost nothing at all.
	called := true
	switch kind {
	case "image":
		var b []byte
		if source != "" {
			b, err = a.retouch(ctx, owner, prompt, source)
		} else {
			b, _, err = a.AI.Image(ctx, prompt)
		}
		if err == nil {
			var url string
			url, err = a.Media.Put(ctx, owner, b)
			result = jsonBytes(fiber.Map{"url": url, "aiGenerated": true})
		}
	case "video":
		var task ai.VideoTask
		task, err = a.AI.Video(ctx, prompt)
		if err == nil {
			// A job cancelled or timed out meanwhile stays that way.
			_, err = a.DB.Exec(ctx, `UPDATE ai_jobs SET status='processing',provider_id=$2,updated_at=now() WHERE id=$1 AND status IN ('queued','running')`, id, task.ID)
			if err == nil {
				return
			}
		}
	case "recipe":
		// A family recording or recipe card is written down as a recipe of the member's own.
		if family, ok := familyJobOf(prompt); ok {
			a.processFamilyJob(parent, id, owner, family)
			return
		}
		if !a.AI.TextEnabled() {
			called, err = false, errors.New("text AI is not configured")
			break
		}
		result, err = a.AI.Recipe(ctx, prompt)
		if err == nil {
			var out struct {
				Recipe RecipeInput `json:"recipe"`
			}
			err = json.Unmarshal(result, &out)
			if err == nil {
				out.Recipe.AIGenerated = true
				out.Recipe.Published = false
				// An import credits its page or post; nothing a model writes sets an original.
				out.Recipe.SourceURL, out.Recipe.DerivedFrom = importedFrom(prompt), RecipeRef{}
				if out.Recipe.SourceURL != nil {
					creditImport(prompt, &out.Recipe)
				}
				// A page can list more equipment, or longer names, than a recipe holds.
				out.Recipe.Equipment = fitEquipment(out.Recipe.Equipment)
				// The model's step timing is its estimate, held to what a step may have.
				fitTiming(out.Recipe.Steps, nil)
				err = out.Recipe.Validate()
				result = jsonBytes(out)
			}
			if err != nil && importJob(prompt) {
				err = errors.Join(errNoRecipe, err)
			}
		}
	default:
		// A question, twist, swap, nutrition or meal-plan job left from before they moved to the
		// sous-chef's conversation.
		err = errors.New("unsupported job kind " + kind)
	}
	if err != nil {
		slog.Error("generation failed", "job", id, "error", err)
		message := "The generation did not complete. Check your provider connection or balance, then try again."
		if errors.Is(err, errNoRecipe) {
			message = noRecipeOnPage
			if strings.HasPrefix(prompt, captionPrefix) {
				message = captionNoRecipe
			} else if strings.HasPrefix(prompt, pastedPrefix) {
				message = pastedNoRecipe
			}
		}
		if parent.Err() != nil {
			message = jobInterrupted // The worker is stopping.
		}
		if kind == "recipe" && importJob(prompt) {
			a.failImport(parent, id, message, called)
			return
		}
		a.finishJob(parent, id, nil, message)
		return
	}
	a.finishJob(parent, id, result, "")
}
func (a *App) retouch(ctx context.Context, owner, prompt, source string) ([]byte, error) {
	photo, e := a.Media.Read(ctx, owner, source, 20*1024*1024)
	if e != nil {
		return nil, e
	}
	mime, _ := mediaType(photo)
	if !strings.HasPrefix(mime, "image/") {
		return nil, errors.New("touch-up source is not a supported photo")
	}
	b, _, e := a.AI.EditImage(ctx, prompt, photo, mime)
	return b, e
}

// finishJob records a job's outcome, even while the worker stops. Only a job not yet finished
// changes: an admin's cancellation, or the stalled-job sweep, stands.
func (a *App) finishJob(ctx context.Context, id string, result []byte, message string) {
	status := "completed"
	if message != "" {
		status = "failed"
		result = []byte(`{}`)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	var key string
	e := a.DB.QueryRow(ctx, `UPDATE ai_jobs SET status=$2,result=$3,error=$4,updated_at=now() WHERE id=$1 AND status IN ('queued','running','processing') RETURNING request_key`, id, status, result, message).Scan(&key)
	if e != nil {
		if !errors.Is(e, pgx.ErrNoRows) {
			slog.Error("save generation result", "job", id, "error", e)
		}
		return
	}
	if strings.HasPrefix(key, "studio-") {
		// A conversation's draft picks up its media on the studio loop's next pass.
		if _, e = a.DB.Exec(ctx, `SELECT pg_notify($1,'studio')`, workChannel); e != nil {
			slog.Warn("announce studio media", "error", e)
		}
		a.wake("studio")
	}
	if strings.HasPrefix(key, batchJobKey) {
		a.importJobDone(ctx)
	}
}

// pollVideos checks provider tasks still processing, each at most every 10 seconds, and
// reports whether any remain, so the loop keeps its pace until they finish.
func (a *App) pollVideos(ctx context.Context) bool {
	rows, e := a.DB.Query(ctx, `SELECT id,user_id,provider_id,created_at,updated_at<now()-interval '10 seconds' FROM ai_jobs WHERE status='processing' ORDER BY updated_at LIMIT 20`)
	if e != nil {
		return false
	}
	type pending struct {
		id, owner, provider string
		created             time.Time
		due                 bool
	}
	jobs := []pending{}
	for rows.Next() {
		var j pending
		if e = rows.Scan(&j.id, &j.owner, &j.provider, &j.created, &j.due); e == nil {
			jobs = append(jobs, j)
		}
	}
	rows.Close()
	for _, j := range jobs {
		if !j.due {
			continue
		}
		if time.Since(j.created) > 60*time.Minute {
			a.finishJob(ctx, j.id, nil, "Video is taking longer than expected. Check the provider task before generating again.")
			continue
		}
		pollCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		task, e := a.AI.PollVideo(pollCtx, j.provider)
		cancel()
		if e != nil {
			continue
		}
		if task.Status == "completed" {
			if len(task.Output.URLs) == 0 || !strings.HasPrefix(task.Output.URLs[0], "https://") {
				a.finishJob(ctx, j.id, nil, "The provider returned no usable video.")
			} else {
				storedURL, err := a.Media.Import(ctx, j.owner, task.Output.URLs[0])
				if err != nil {
					slog.Error("archive generated video", "job", j.id, "error", err)
					a.finishJob(ctx, j.id, nil, "The video was generated, but could not be saved. Contact support with this job ID before retrying.")
				} else {
					a.finishJob(ctx, j.id, jsonBytes(fiber.Map{"url": storedURL, "aiGenerated": true, "providerTaskId": j.provider}), "")
				}
			}
		} else if task.Status == "failed" {
			a.finishJob(ctx, j.id, nil, "The video provider could not complete this generation. Review your prompt and try again.")
		} else {
			if _, e = a.DB.Exec(ctx, `UPDATE ai_jobs SET updated_at=now() WHERE id=$1 AND status='processing'`, j.id); e != nil {
				slog.Error("video poll update", "error", e)
			}
		}
	}
	return len(jobs) > 0
}
