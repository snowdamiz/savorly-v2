package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

const jobJSON = `jsonb_build_object('id',id,'kind',kind,'prompt',prompt,'source',source,'status',status,'result',result,'error',error,'createdAt',created_at)`

func (a *App) jobs(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT `+jobJSON+` FROM ai_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, userID(c))
}
func (a *App) job(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT `+jobJSON+` FROM ai_jobs WHERE id=$1 AND user_id=$2`, c.Params("id"), userID(c))
}
func (a *App) createJob(c fiber.Ctx) error {
	var in struct{ Kind, Prompt string }
	if e := decode(c, &in); e != nil {
		return e
	}
	kinds := map[string]bool{"recipe": true, "adapt": true, "substitute": true, "nutrition": true, "plan": true, "assistant": true, "image": true, "video": true}
	if !kinds[in.Kind] || !validText(in.Prompt, 8, 12000) {
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
	key := c.Get("Idempotency-Key")
	if len(key) < 8 || len(key) > 100 {
		return fiber.NewError(400, "A valid Idempotency-Key is required.")
	}
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	// Serialize each user's limit check and insert, preventing concurrent overspending.
	if _, e = tx.Exec(c.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, userID(c)); e != nil {
		return e
	}
	var existing []byte
	e = tx.QueryRow(c.Context(), `SELECT `+jobJSON+` FROM ai_jobs WHERE user_id=$1 AND request_key=$2`, userID(c), key).Scan(&existing)
	if e == nil {
		var old struct{ Kind, Prompt, Source string }
		json.Unmarshal(existing, &old)
		if old.Kind != kind || old.Prompt != prompt || old.Source != source {
			return fiber.NewError(409, "This request key was used for a different generation.")
		}
		return c.Type("json").Send(existing)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return e
	}

	estimate := ai.GenerationEstimate(kind)
	if e = allowance(c.Context(), tx, userID(c), kind); e != nil {
		return e
	}
	if e = reserveGeneration(c.Context(), tx, userID(c), estimate); e != nil {
		return e
	}
	var result []byte
	e = tx.QueryRow(c.Context(), `INSERT INTO ai_jobs(id,user_id,kind,prompt,source,request_key,estimated_cost) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+jobJSON, uuid.NewString(), userID(c), kind, prompt, source, key, estimate).Scan(&result)
	if e != nil {
		return e
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	return c.Status(202).Type("json").Send(result)
}

// RunWorker persists every transition. Ambiguous interrupted submissions are never automatically re-sent.
func RunWorker(ctx context.Context, db *pgxpool.Pool, config Config) {
	a := &App{DB: db, Config: config, AI: ai.New(), Media: NewMediaStore()}
	go a.runStudioWorker(ctx)
	slots := make(chan struct{}, 2)
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			_, e := db.Exec(ctx, `UPDATE ai_jobs SET status='failed',error='Generation was interrupted. Check provider usage before starting a new request.',updated_at=now() WHERE status='running' AND updated_at<now()-interval '10 minutes'`)
			if e != nil {
				slog.Error("job recovery", "error", e)
			}
			a.pollVideos(ctx)
			select {
			case slots <- struct{}{}:
			default:
				continue
			}
			var id, owner, kind, prompt, source string
			e = db.QueryRow(ctx, `UPDATE ai_jobs SET status='running',updated_at=now() WHERE id=(SELECT id FROM ai_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,user_id,kind,prompt,source`).Scan(&id, &owner, &kind, &prompt, &source)
			if errors.Is(e, pgx.ErrNoRows) {
				<-slots
				continue
			}
			if e != nil {
				slog.Error("claim job", "error", e)
				<-slots
				continue
			}
			go func() { defer func() { <-slots }(); a.processJob(ctx, id, owner, kind, prompt, source) }()
		}
	}
}
func (a *App) processJob(parent context.Context, id, owner, kind, prompt, source string) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Minute)
	defer cancel()
	var result json.RawMessage
	var err error
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
			_, err = a.DB.Exec(ctx, `UPDATE ai_jobs SET status='processing',provider_id=$2,updated_at=now() WHERE id=$1`, id, task.ID)
			if err == nil {
				return
			}
		}
	default:
		result, err = a.AI.Text(ctx, kind, prompt)
		if err == nil {
			if kind == "recipe" || kind == "adapt" {
				var out struct {
					Recipe RecipeInput `json:"recipe"`
				}
				err = json.Unmarshal(result, &out)
				if err == nil {
					out.Recipe.AIGenerated = true
					out.Recipe.Published = false
					err = out.Recipe.Validate()
					result = jsonBytes(out)
				}
			} else {
				var out struct {
					Text string `json:"text"`
				}
				err = json.Unmarshal(result, &out)
				if err == nil && !validText(out.Text, 1, 20000) {
					err = errors.New("empty response")
				}
			}
		}
	}
	if err != nil {
		slog.Error("generation failed", "job", id, "error", err)
		a.finishJob(parent, id, nil, "The generation did not complete. Check your provider connection or balance, then try again.")
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
func (a *App) finishJob(ctx context.Context, id string, result []byte, message string) {
	status := "completed"
	if message != "" {
		status = "failed"
		result = []byte(`{}`)
	}
	if _, e := a.DB.Exec(ctx, `UPDATE ai_jobs SET status=$2,result=$3,error=$4,updated_at=now() WHERE id=$1`, id, status, result, message); e != nil {
		slog.Error("save generation result", "job", id, "error", e)
	}
}
func (a *App) pollVideos(ctx context.Context) {
	rows, e := a.DB.Query(ctx, `SELECT id,user_id,provider_id,created_at FROM ai_jobs WHERE status='processing' AND updated_at<now()-interval '10 seconds' LIMIT 10`)
	if e != nil {
		return
	}
	type pending struct {
		id, owner, provider string
		created             time.Time
	}
	jobs := []pending{}
	for rows.Next() {
		var j pending
		if e = rows.Scan(&j.id, &j.owner, &j.provider, &j.created); e == nil {
			jobs = append(jobs, j)
		}
	}
	rows.Close()
	for _, j := range jobs {
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
			if _, e = a.DB.Exec(ctx, `UPDATE ai_jobs SET updated_at=now() WHERE id=$1`, j.id); e != nil {
				slog.Error("video poll update", "error", e)
			}
		}
	}
}
