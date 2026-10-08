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

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"savorly/api/internal/narration"
)

func narrationKey(recipe string, step int, text, voice string) string {
	return hashToken(fmt.Sprintf("%s\x00%d\x00%s\x00%s\x00%s\x00%s", recipe, step, text, voice, narration.Model, narration.Format))
}

// Only saved instructions are synthesized. Neither arbitrary text nor provider
// settings from the mobile client can spend the application's voice budget.
func (a *App) narrationStep(c fiber.Ctx) (string, string, int, error) {
	id := strings.Clone(c.Params("id"))
	step, err := strconv.Atoi(c.Params("step"))
	if err != nil || step < 0 || step > 99 {
		return "", "", 0, fiber.NewError(400, "Invalid cooking step.")
	}
	var text string
	err = a.DB.QueryRow(c.Context(), `SELECT steps->($2::int)->>'text' FROM recipes WHERE id=$1 AND (published OR author_id=$3) AND jsonb_array_length(steps)>$2::int`, id, step, userID(c)).Scan(&text)
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
		return fiber.NewError(503, "Natural narration is not configured.")
	}
	id, text, step, err := a.narrationStep(c)
	if err != nil {
		return err
	}
	var in struct {
		Text string `json:"text"`
	}
	if err = decode(c, &in); err != nil {
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
			return fiber.NewError(503, "Narration is busy. Please try again.")
		}
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(fiber.Map{"path": fmt.Sprintf("/recipes/%s/steps/%d/narration/%s", id, step, key), "model": narration.Model})
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
	var audio []byte
	err = tx.QueryRow(ctx, `SELECT audio FROM recipe_narrations WHERE cache_key=$1`, key).Scan(&audio)
	if err == nil {
		_, err = stream.Write(audio)
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
	if _, err = tx.Exec(ctx, `INSERT INTO recipe_narrations(cache_key,recipe_id,audio) VALUES($1,$2,$3)`, key, recipe, stream.Bytes()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (a *App) readNarration(c fiber.Ctx) error {
	if a.Narrator == nil {
		return fiber.NewError(503, "Narration unavailable.")
	}
	id, text, step, err := a.narrationStep(c)
	if err != nil {
		return err
	}
	key := narrationKey(id, step, text, a.Narrator.Voice)
	if c.Params("key") != key {
		return fiber.NewError(404, "Narration not found.")
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
	var audio []byte
	err = a.DB.QueryRow(ctx, `SELECT audio FROM recipe_narrations WHERE cache_key=$1`, key).Scan(&audio)
	if err == nil {
		cancel()
		return sendNarration(c, audio)
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
			audio, err = io.ReadAll(reader)
			if err != nil {
				return fiber.NewError(502, "Narration unavailable.")
			}
			return sendNarration(c, audio)
		}
		// Wait for one byte so provider failures can return an HTTP error.
		first := make([]byte, 1)
		if _, err = io.ReadFull(reader, first); err != nil {
			cancel()
			reader.Close()
			return fiber.NewError(502, "Narration unavailable.")
		}
		// A full-file bytes=0- request can receive a 200 chunked response while
		// the length is unknown. Do not buffer Chrome/Android's normal request.
		c.Set("Accept-Ranges", "none")
		return c.SendStream(&narrationResponse{Reader: io.MultiReader(bytes.NewReader(first), reader), close: func() { cancel(); reader.Close() }})
	}
	// A load balancer may send the GET to a different replica. Wait for the
	// shared cache instead of starting a second paid generation.
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return fiber.NewError(504, "Narration is not ready.")
		case <-tick.C:
			err = a.DB.QueryRow(ctx, `SELECT audio FROM recipe_narrations WHERE cache_key=$1`, key).Scan(&audio)
			if err == nil {
				return sendNarration(c, audio)
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
