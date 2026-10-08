package app

import (
	"context"
	"fmt"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"log/slog"
	"savorly/api/internal/live"
	"strings"
	"time"
)

func (a *App) voiceCreate(c fiber.Ctx) error {
	if a.Live == nil || !a.Live.Enabled() || !a.AI.TextEnabled() {
		return fiber.NewError(503, "Voice needs an OpenAI project with GPT-Live access and an OpenRouter key. You can still chat by text when OpenRouter is connected.")
	}
	var in struct {
		SDP string `json:"sdp"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if len(in.SDP) > 100000 || !strings.HasPrefix(in.SDP, "v=0") {
		return fiber.NewError(400, "A valid audio connection offer is required.")
	}
	project, owner := strings.Clone(c.Params("id")), userID(c)
	state, e := a.studioState(c.Context(), project, 0)
	if e != nil || state.Owner != owner {
		return fiber.NewError(404, "Conversation not found.")
	}
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	if _, e = tx.Exec(c.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return e
	}
	// A crashed server cannot leave an account locked forever. Its reservation remains
	// charged conservatively until provider final usage is confirmed.
	if _, e = tx.Exec(c.Context(), `UPDATE voice_sessions SET status='interrupted' WHERE user_id=$1 AND status IN ('active','connecting') AND heartbeat_at<now()-interval '90 seconds'`, owner); e != nil {
		return e
	}
	var active bool
	if e = tx.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM voice_sessions WHERE user_id=$1 AND status IN ('active','connecting'))`, owner).Scan(&active); e != nil {
		return e
	}
	if active {
		return fiber.NewError(409, "You already have a voice conversation open. End it before starting another.")
	}
	plan, e := planOf(c.Context(), tx, owner)
	if e != nil {
		return e
	}
	used, e := usageOf(c.Context(), tx, owner)
	if e != nil {
		return e
	}
	remaining := plan.VoiceMinutes*60 - used.VoiceSeconds
	if remaining < 15 {
		return fiber.NewError(429, "You've used this month's live voice time on your plan. Your conversation is saved and you can continue by text.")
	}
	seconds := 1800
	if remaining < seconds {
		seconds = remaining
	}
	if e = reserveGeneration(c.Context(), tx, owner, float64(seconds)*.05/60); e != nil {
		return e
	}
	id := uuid.NewString()
	_, e = tx.Exec(c.Context(), `INSERT INTO voice_sessions(id,project_id,user_id,reserved_seconds,expires_at) VALUES($1,$2,$3,$4,now()+$4*interval '1 second')`, id, project, owner, seconds)
	if e != nil {
		return e
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	failed := func() {
		_, _ = a.DB.Exec(context.Background(), `UPDATE voice_sessions SET status='interrupted' WHERE id=$1`, id)
	}
	handshake, cancel := context.WithTimeout(c.Context(), 24*time.Second)
	defer cancel()
	answer, e := a.Live.Create(handshake, in.SDP, state.Conversation, fmt.Sprintf("Current draft revision: %d. Status: %s. Continue from the conversation; do not repeat completed actions.", state.Revision, state.Status))
	if e != nil {
		failed()
		slog.Warn("voice handshake failed", "error", e)
		return fiber.NewError(502, "Couldn't connect to the voice model. Check the OpenAI project's GPT-Live access, or continue by text.")
	}
	_, e = a.DB.Exec(c.Context(), `UPDATE voice_sessions SET provider_id=$2 WHERE id=$1`, id, answer.Session.ID)
	if e != nil {
		failed()
		return e
	}
	conn, e := a.Live.Attach(handshake, answer.Session.ID)
	if e != nil {
		failed()
		return fiber.NewError(502, "Couldn't attach your sous-chef. Close this attempt and try again.")
	}
	_, e = a.DB.Exec(c.Context(), `UPDATE voice_sessions SET status='active',heartbeat_at=now() WHERE id=$1`, id)
	if e != nil {
		conn.CloseNow()
		failed()
		return e
	}
	parent := a.Context
	if parent == nil {
		parent = context.Background()
	}
	go a.monitorVoice(parent, conn, id, project, owner, seconds)
	return c.Status(201).JSON(fiber.Map{"id": id, "sdp": answer.Transport.SDP, "maxSeconds": seconds, "model": a.Live.ModelID()})
}
func (a *App) voiceClose(c fiber.Ctx) error {
	result, e := a.DB.Exec(c.Context(), `UPDATE voice_sessions SET close_requested=true WHERE id=$1 AND user_id=$2`, c.Params("session"), userID(c))
	if e != nil {
		return e
	}
	if result.RowsAffected() == 0 {
		return fiber.NewError(404, "Voice session not found.")
	}
	return c.SendStatus(204)
}
func (a *App) monitorVoice(parent context.Context, conn *websocket.Conn, id, project, owner string, maxSeconds int) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer conn.CloseNow()
	events := make(chan live.Event, 64)
	readError := make(chan error, 1)
	go func() {
		for {
			var ev live.Event
			if e := wsjson.Read(ctx, conn, &ev); e != nil {
				readError <- e
				return
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	started := time.Now()
	lastSpeech := started
	closing := time.Time{}
	finalized := false
	defer func() {
		end, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		status := "interrupted"
		if finalized {
			status = "closed"
		}
		_, _ = a.DB.Exec(end, `UPDATE voice_sessions SET status=$2,finalized=$3 WHERE id=$1`, id, status, finalized)
	}()
	lastProgress := ""
	endAfter := time.Time{}
	closeCall := func() {
		if !closing.IsZero() {
			return
		}
		closing = time.Now()
		write, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		_ = wsjson.Write(write, conn, map[string]string{"type": "session.close"})
	}
	for {
		select {
		case <-parent.Done():
			closeCall()
			return
		case <-readError:
			closeCall()
			return
		case ev := <-events:
			switch ev.Type {
			case "session.input_transcript.delta", "session.output_transcript.delta":
				if ev.Delta == "" || ev.ID == "" {
					continue
				}
				role := "assistant"
				if ev.Type == "session.input_transcript.delta" {
					role = "user"
					lastSpeech = time.Now()
				}
				_, e := a.DB.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, project, id, ev.ID, role, ev.Delta)
				if e != nil {
					closeCall()
				}
			case "session.delegation.created":
				if ev.Delegation.ID == "" {
					continue
				}
				tx, e := a.DB.Begin(ctx)
				if e != nil {
					continue
				}
				_, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner)
				var seq int64
				if e == nil {
					e = tx.QueryRow(ctx, `SELECT COALESCE(max(seq),0) FROM voice_events WHERE project_id=$1`, project).Scan(&seq)
				}
				if e == nil {
					e = a.enqueueVoiceAction(ctx, tx, owner, project, id, ev.Delegation.ID, seq)
				}
				if e == nil {
					e = tx.Commit(ctx)
				} else {
					_ = tx.Rollback(ctx)
				}
				if e != nil {
					_ = live.Append(ctx, conn, "commentary", ev.Delegation.ID, publicError(e))
				}
			case "session.usage.updated", "session.closed":
				_, _ = a.DB.Exec(ctx, `UPDATE voice_sessions SET seconds=greatest(seconds,$2) WHERE id=$1`, id, ev.Usage.Seconds)
				if ev.Type == "session.closed" {
					finalized = true
					return
				}
			case "error":
				slog.Warn("voice provider event error", "session", id)
			}
		case <-tick.C:
			if !closing.IsZero() {
				if time.Since(closing) > 8*time.Second {
					return
				}
				continue
			}
			var stop bool
			e := a.DB.QueryRow(ctx, `UPDATE voice_sessions SET heartbeat_at=now(),seconds=greatest(seconds,$2) WHERE id=$1 RETURNING close_requested`, id, time.Since(started).Seconds()).Scan(&stop)
			if stop && e == nil {
				if endAfter.IsZero() {
					_ = a.deliverVoiceReplies(ctx, conn, id)
					endAfter = time.Now().Add(6 * time.Second)
				}
				if time.Now().Before(endAfter) {
					continue
				}
			}
			if e != nil || stop || time.Since(started) >= time.Duration(maxSeconds)*time.Second {
				closeCall()
				continue
			}
			if time.Since(lastSpeech) > 3*time.Minute {
				_ = live.Append(ctx, conn, "commentary", "", "I'll pause the microphone now to save your voice time. Our conversation is saved; you can resume whenever you're ready.")
				closeCall()
				continue
			}
			if e = a.deliverVoiceReplies(ctx, conn, id); e != nil {
				slog.Warn("voice reply delivery", "error", e)
			}
			var status string
			e = a.DB.QueryRow(ctx, `SELECT status FROM voice_projects WHERE id=$1`, project).Scan(&status)
			if e == nil && status != lastProgress {
				if status == "ready" {
					_ = live.Append(ctx, conn, "commentary", "", "Your recipe's cover photo and video are ready and attached to the saved draft. You can review, change, or publish it.")
				}
				if status == "needs_attention" {
					_ = live.Append(ctx, conn, "commentary", "", "Your recipe is saved. Some media couldn't finish. You can keep the draft, publish it as it is, or ask to retry the media.")
				}
				lastProgress = status
			}
		}
	}
}
func (a *App) deliverVoiceReplies(ctx context.Context, conn *websocket.Conn, session string) error {
	rows, e := a.DB.Query(ctx, `SELECT id,CASE WHEN session_id=$1 THEN delegation_id ELSE '' END,reply FROM voice_actions WHERE project_id=(SELECT project_id FROM voice_sessions WHERE id=$1) AND (session_id=$1 OR updated_at>(SELECT created_at FROM voice_sessions WHERE id=$1)) AND status IN ('completed','failed') AND NOT delivered ORDER BY created_at`, session)
	if e != nil {
		return e
	}
	type reply struct{ id, delegation, text string }
	list := []reply{}
	for rows.Next() {
		var r reply
		if e = rows.Scan(&r.id, &r.delegation, &r.text); e != nil {
			rows.Close()
			return e
		}
		list = append(list, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, r := range list {
		if e = live.Append(ctx, conn, "commentary", r.delegation, r.text); e != nil {
			return e
		}
		if _, e = a.DB.Exec(ctx, `UPDATE voice_actions SET delivered=true WHERE id=$1`, r.id); e != nil {
			return e
		}
	}
	return nil
}
