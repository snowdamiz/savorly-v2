package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"savorly/api/internal/narration"
)

func narrationKey(recipe string, step int, text, voice string) string {
	return hashToken(fmt.Sprintf("%s\x00%d\x00%s\x00%s\x00%s\x00%s", recipe, step, text, voice, narration.Model, narration.Format))
}

// Only saved instructions are synthesized. Neither arbitrary text nor provider
// settings from the mobile client can spend the application's voice budget. With a language
// (a reader cooking the recipe translated), the step is its saved translation's (translatedStep).
func (a *App) narrationStep(c fiber.Ctx, language string) (string, string, int, error) {
	id := strings.Clone(c.Params("id"))
	step, err := strconv.Atoi(c.Params("step"))
	if err != nil || step < 0 || step > 99 {
		return "", "", 0, fiber.NewError(400, "Invalid cooking step.")
	}
	var text string
	if language != "" {
		text, err = translatedStep(c.Context(), a.DB, id, step, userID(c), language)
	} else {
		err = a.DB.QueryRow(c.Context(), `SELECT r.steps->($2::int)->>'text' FROM recipes r WHERE r.id=$1 AND `+visibleRecipeSQL("r", "$3")+` AND jsonb_array_length(r.steps)>$2::int`, id, step, userID(c)).Scan(&text)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", 0, fiber.NewError(404, "Cooking step not found.")
	}
	if err != nil {
		return "", "", 0, err
	}
	if strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > 4000 {
		return "", "", 0, fiber.NewError(422, "Use the device voice for this step.")
	}
	return id, text, step, nil
}

func (a *App) prepareNarration(c fiber.Ctx) error {
	if !a.Narrator.Enabled() {
		return fiber.NewError(503, "Natural-voice read-aloud isn't set up on this server.")
	}
	var in struct {
		Text string `json:"text"`
		// The language of the recipe's translation the cook is reading; "" for the recipe as written.
		Language string `json:"language"`
	}
	if err := decode(c, &in); err != nil {
		return err
	}
	language, ok := recipeLanguage(in.Language)
	if !ok {
		return fiber.NewError(400, "Choose a supported language.")
	}
	id, text, step, err := a.narrationStep(c, language)
	if err != nil {
		return err
	}
	if in.Text != text {
		return fiber.NewError(409, "This recipe has changed. Refresh it before reading aloud.")
	}
	key := narrationKey(id, step, text, a.Narrator.Voice)
	var cached bool
	if err = a.DB.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM recipe_narrations WHERE cache_key=$1)`, key).Scan(&cached); err != nil {
		return err
	}
	if !cached {
		owner := strings.Clone(userID(c))
		parent := a.Context
		if parent == nil {
			parent = context.Background()
		}
		err = a.NarrationStreams.Start(parent, key, func(ctx context.Context, stream *narration.Stream) error {
			err := a.generateNarration(ctx, key, id, owner, text, stream)
			if err != nil {
				slog.Warn("cooking narration failed", "recipe", id, "error", err)
			}
			return err
		})
		if err != nil {
			return fiber.NewError(503, "Read-aloud is busy. Please try again.")
		}
	}
	c.Set("Cache-Control", "no-store")
	path := fmt.Sprintf("/recipes/%s/steps/%d/narration/%s", id, step, key)
	if language != "" {
		path += "?language=" + language
	}
	return c.JSON(fiber.Map{"path": path, "model": narration.Model})
}

func (a *App) generateNarration(ctx context.Context, key, recipe, owner, text string, stream *narration.Stream) error {
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	// Serialize this exact recording across API replicas, as well as local players.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,7182303))`, key); err != nil {
		return err
	}
	cached, err := loadNarration(ctx, tx, key)
	if err == nil {
		var audio []byte
		if audio, err = a.narrationBytes(ctx, cached); err == nil {
			_, err = stream.Write(audio)
		}
		return err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Commit spend before contacting the provider, without holding the shared
	// global budget lock for the duration of audio generation.
	budget, err := a.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer budget.Rollback(context.Background())
	estimate := float64(utf8.RuneCountInString(text)) * .00004
	if err = allowance(ctx, budget, owner, "narration"); err != nil {
		return err
	}
	if err = reserveGeneration(ctx, budget, owner, estimate); err != nil {
		return err
	}
	var recent bool
	if err = budget.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM narration_usage WHERE cache_key=$1 AND created_at>now()-interval '30 seconds')`, key).Scan(&recent); err != nil {
		return err
	}
	if recent {
		return errors.New("narration retry is cooling down")
	}
	if _, err = budget.Exec(ctx, `INSERT INTO narration_usage(cache_key,user_id,estimated_cost) VALUES($1,$2,$3)`, key, owner, estimate); err != nil {
		return err
	}
	if err = budget.Commit(ctx); err != nil {
		return err
	}
	if err = a.Narrator.Generate(ctx, text, stream); err != nil {
		return err
	}
	audio := stream.Bytes()
	object := a.storeNarration(ctx, audio)
	if object == "" {
		_, err = tx.Exec(ctx, `INSERT INTO recipe_narrations(cache_key,recipe_id,audio) VALUES($1,$2,$3)`, key, recipe, audio)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO recipe_narrations(cache_key,recipe_id,object_key,size) VALUES($1,$2,$3,$4)`, key, recipe, object, len(audio))
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil && object != "" {
		// The worker that clears the private bucket removes the stray recording.
		_, _ = a.DB.Exec(context.Background(), `INSERT INTO source_deletions(object_key) VALUES($1) ON CONFLICT DO NOTHING`, object)
	}
	return err
}

// storeNarration puts a new recording in the private bucket and returns its key, or "" to keep
// it in Postgres: without object storage, or if the upload fails (the audio is paid for).
func (a *App) storeNarration(ctx context.Context, audio []byte) string {
	if a.Media == nil || a.Media.S3 == nil || a.Media.SourceBucket == "" {
		return ""
	}
	if e := a.Media.ensureSourceBucket(ctx, a.Config.Production); e != nil {
		slog.Warn("narration storage unavailable", "error", e)
		return ""
	}
	// A fresh name per recording: a purged one's deletion can't remove its replacement.
	key := "narration/" + uuid.NewString() + "." + narration.Format
	_, e := a.Media.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(key), Body: bytes.NewReader(audio), ContentType: aws.String("audio/mpeg"), CacheControl: aws.String("private,no-store")})
	if e != nil {
		slog.Warn("store narration audio", "error", e)
		return ""
	}
	return key
}

// storedNarration is a cached recording: bytes in the row (older rows, or no object storage)
// or an object in the private bucket.
type storedNarration struct {
	audio  []byte
	object string
	size   int64
	stale  bool // last used over an hour ago
}

func loadNarration(ctx context.Context, q querier, key string) (storedNarration, error) {
	var n storedNarration
	e := q.QueryRow(ctx, `SELECT audio,COALESCE(object_key,''),COALESCE(size,octet_length(audio)),last_used_at<now()-interval '1 hour' FROM recipe_narrations WHERE cache_key=$1`, key).Scan(&n.audio, &n.object, &n.size, &n.stale)
	return n, e
}

// narrationBytes reads a whole recording, for a stream that replays the cache.
func (a *App) narrationBytes(ctx context.Context, n storedNarration) ([]byte, error) {
	if n.object == "" {
		return n.audio, nil
	}
	if a.Media == nil || a.Media.S3 == nil {
		return nil, errors.New("narration storage is not configured")
	}
	out, e := a.Media.S3.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(n.object)})
	if e != nil {
		return nil, e
	}
	defer out.Body.Close()
	return io.ReadAll(io.LimitReader(out.Body, 8<<20))
}

// sendStoredNarration answers with a cached recording, streaming an object from storage
// (with Range support) rather than holding it in memory.
func (a *App) sendStoredNarration(c fiber.Ctx, key string, n storedNarration) error {
	if n.stale {
		// Purging goes by last use; an hour's precision saves a write per play.
		if _, e := a.DB.Exec(c.Context(), `UPDATE recipe_narrations SET last_used_at=now() WHERE cache_key=$1`, key); e != nil {
			slog.Warn("touch narration", "error", e)
		}
	}
	if n.object == "" {
		return sendNarration(c, n.audio)
	}
	if a.Media == nil || a.Media.S3 == nil {
		return fiber.NewError(503, "Read-aloud is unavailable.")
	}
	in := &s3.GetObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(n.object)}
	status, length := 200, n.size
	c.Set("Accept-Ranges", "bytes")
	if c.Get("Range") != "" {
		r, err := c.Range(n.size)
		if err != nil || r.Type != "bytes" || len(r.Ranges) != 1 {
			c.Set("Content-Range", fmt.Sprintf("bytes */%d", n.size))
			return c.SendStatus(416)
		}
		part := r.Ranges[0]
		in.Range = aws.String(fmt.Sprintf("bytes=%d-%d", part.Start, part.End))
		status, length = 206, int64(part.End-part.Start+1)
		c.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", part.Start, part.End, n.size))
	}
	parent := a.Context
	if parent == nil {
		parent = context.Background()
	}
	// The body is read after the handler returns, so it gets its own deadline.
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	out, e := a.Media.S3.GetObject(ctx, in)
	if e != nil {
		cancel()
		if storageNotFound(e) {
			// Lost from storage: drop the row so the next read-aloud records it again.
			_, _ = a.DB.Exec(c.Context(), `DELETE FROM recipe_narrations WHERE cache_key=$1 AND object_key=$2`, key, n.object)
			return fiber.NewError(404, "This read-aloud wasn't found.")
		}
		return e
	}
	return c.Status(status).SendStream(&narrationResponse{Reader: out.Body, close: func() { cancel(); out.Body.Close() }}, int(length))
}

func (a *App) readNarration(c fiber.Ctx) error {
	if a.Narrator == nil {
		return fiber.NewError(503, "Read-aloud is unavailable.")
	}
	language, ok := recipeLanguage(c.Query("language"))
	if !ok {
		return fiber.NewError(400, "Choose a supported language.")
	}
	id, text, step, err := a.narrationStep(c, language)
	if err != nil {
		return err
	}
	key := narrationKey(id, step, text, a.Narrator.Voice)
	if c.Params("key") != key {
		return fiber.NewError(404, "This read-aloud wasn't found.")
	}
	c.Set("Content-Type", "audio/mpeg")
	c.Set("Cache-Control", "private, no-cache")
	c.Set("X-Accel-Buffering", "no")
	// GET only reads audio; it never initiates a paid generation.
	parent := a.Context
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 26*time.Second)
	stored, err := loadNarration(ctx, a.DB, key)
	if err == nil {
		cancel()
		return a.sendStoredNarration(c, key, stored)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		cancel()
		return err
	}
	if stream := a.NarrationStreams.Get(key); stream != nil {
		reader := stream.Reader(ctx)
		if requestedRange := c.Get("Range"); requestedRange != "" && requestedRange != "bytes=0-" {
			// iOS may probe with bytes=0-1; it needs an accurate total length.
			defer cancel()
			defer reader.Close()
			audio, err := io.ReadAll(reader)
			if err != nil {
				return fiber.NewError(502, "Read-aloud is unavailable.")
			}
			return sendNarration(c, audio)
		}
		// Wait for one byte so provider failures can return an HTTP error.
		first := make([]byte, 1)
		if _, err = io.ReadFull(reader, first); err != nil {
			cancel()
			reader.Close()
			return fiber.NewError(502, "Read-aloud is unavailable.")
		}
		// A full-file bytes=0- request can receive a 200 chunked response while
		// the length is unknown. Do not buffer Chrome/Android's normal request.
		c.Set("Accept-Ranges", "none")
		return c.SendStream(&narrationResponse{Reader: io.MultiReader(bytes.NewReader(first), reader), close: func() { cancel(); reader.Close() }})
	}
	// A load balancer may send the GET to a different replica. Wait for the
	// shared cache instead of starting a second paid generation. A row with an
	// object key is written only after its upload, so the object is there to read.
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return fiber.NewError(504, "This read-aloud isn't ready yet.")
		case <-tick.C:
			stored, err = loadNarration(ctx, a.DB, key)
			if err == nil {
				return a.sendStoredNarration(c, key, stored)
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
	}
}

type narrationResponse struct {
	io.Reader
	close func()
}

func (r *narrationResponse) Close() error { r.close(); return nil }

func sendNarration(c fiber.Ctx, audio []byte) error {
	c.Set("Accept-Ranges", "bytes")
	if c.Get("Range") != "" {
		r, err := c.Range(int64(len(audio)))
		if err != nil || r.Type != "bytes" || len(r.Ranges) != 1 {
			c.Set("Content-Range", fmt.Sprintf("bytes */%d", len(audio)))
			return c.SendStatus(416)
		}
		part := r.Ranges[0]
		c.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", part.Start, part.End, len(audio)))
		return c.Status(206).Send(audio[part.Start : part.End+1])
	}
	return c.Send(audio)
}
