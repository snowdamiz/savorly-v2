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
	"sync"
	"sync/atomic"
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
	// A crashed server cannot leave an account locked until the worker's next sweep.
	if e = endStaleVoice(c.Context(), tx, owner); e != nil {
		return e
	}
	// A session already asked to end (renewing at the end of a lease, or the assistant ending
	// the call) is only finishing its last words; it doesn't hold the user's one voice slot.
	if _, e = tx.Exec(c.Context(), `UPDATE voice_sessions SET status='closing' WHERE user_id=$1 AND status='active' AND close_requested`, owner); e != nil {
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
		return fiber.NewError(429, "You've used your plan's live voice time for the last 30 days. Your conversation is saved and you can continue by text.")
	}
	seconds := 1800
	if remaining < seconds {
		seconds = remaining
	}
	if e = reserveGeneration(c.Context(), tx, owner, float64(seconds)*.05/60); e != nil {
		return e
	}
	id := uuid.NewString()
	// One type for $4: unannotated, Postgres deduces integer for the column and double
	// precision for the interval product, and refuses to prepare the statement.
	_, e = tx.Exec(c.Context(), `INSERT INTO voice_sessions(id,project_id,user_id,reserved_seconds,expires_at) VALUES($1,$2,$3,$4::int,now()+$4::int*interval '1 second')`, id, project, owner, seconds)
	if e != nil {
		return e
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	// Until the provider has a session nothing is billed, so a failure releases the whole
	// reservation; after that it bills the 15-second minimum, as a short call would.
	failed := func(billed bool) {
		end, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		query := `UPDATE voice_sessions SET status='interrupted',reserved_seconds=0,seconds=0,finalized=true WHERE id=$1`
		if billed {
			query = `UPDATE voice_sessions SET status='interrupted',seconds=greatest(seconds,15),finalized=true WHERE id=$1`
		}
		if _, e := a.DB.Exec(end, query, id); e != nil {
			slog.Error("release voice reservation", "session", id, "error", e)
		}
	}
	handshake, cancel := context.WithTimeout(c.Context(), 24*time.Second)
	defer cancel()
	opening := fmt.Sprintf("Current draft revision: %d. Status: %s. Continue from the conversation; do not repeat completed actions.", state.Revision, state.Status)
	// Opened from Create a recipe, the call starts by asking for the recipe. Best effort: without
	// the purpose it greets as usual.
	var purpose string
	_ = a.DB.QueryRow(c.Context(), `SELECT COALESCE(context->>'purpose','') FROM voice_projects WHERE id=$1`, project).Scan(&purpose)
	if purpose == "recipe" && state.Recipe == nil {
		opening += " The user opened this call from Create a recipe to add a new recipe of their own: greet them briefly and ask them to tell you the recipe."
	}
	answer, e := a.Live.Create(handshake, in.SDP, state.Conversation, opening)
	if e != nil {
		failed(false)
		slog.Warn("voice handshake failed", "error", e)
		return fiber.NewError(502, "Couldn't connect to the voice model. Check the OpenAI project's GPT-Live access, or continue by text.")
	}
	_, e = a.DB.Exec(c.Context(), `UPDATE voice_sessions SET provider_id=$2 WHERE id=$1`, id, answer.Session.ID)
	if e != nil {
		failed(true)
		return e
	}
	conn, e := a.Live.Attach(handshake, answer.Session.ID)
	if e != nil {
		failed(true)
		slog.Warn("voice attach failed", "error", e)
		return fiber.NewError(502, "Couldn't connect to your sous-chef. End the call and try again.")
	}
	_, e = a.DB.Exec(c.Context(), `UPDATE voice_sessions SET status='active',heartbeat_at=now() WHERE id=$1`, id)
	if e != nil {
		conn.CloseNow()
		failed(true)
		return e
	}
	parent := a.Context
	if parent == nil {
		parent = context.Background()
	}
	running := a.voiceMonitors()
	running.Add(1)
	go func() {
		defer running.Add(-1)
		a.monitorVoice(parent, conn, id, answer.Session.ID, project, owner, seconds)
	}()
	return c.Status(201).JSON(fiber.Map{"id": id, "sdp": answer.Transport.SDP, "maxSeconds": seconds, "model": a.Live.ModelID()})
}

// Voice monitors run on the API's App, but the worker's shutdown waits for them too (see
// waitForVoice), so each can end its provider session and record what it bills before the
// pool closes.
var voiceMonitorCounts sync.Map

func (a *App) voiceMonitors() *atomic.Int64 {
	n, _ := voiceMonitorCounts.LoadOrStore(a.DB, new(atomic.Int64))
	return n.(*atomic.Int64)
}

// waitForVoice returns once no voice monitor runs on this pool, or after limit.
func (a *App) waitForVoice(limit time.Duration) {
	for deadline := time.Now().Add(limit); a.voiceMonitors().Load() > 0 && time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
	}
}

// voiceClose asks the session's server to end it gracefully. The user's voice slot frees at
// once, so a renewal can start while the old session says its last words.
func (a *App) voiceClose(c fiber.Ctx) error {
	result, e := a.DB.Exec(c.Context(), `UPDATE voice_sessions SET close_requested=true,status=CASE WHEN status='active' THEN 'closing' ELSE status END WHERE id=$1 AND user_id=$2`, c.Params("session"), userID(c))
	if e != nil {
		return e
	}
	if result.RowsAffected() == 0 {
		return fiber.NewError(404, "Voice session not found.")
	}
	return c.SendStatus(204)
}

// endStaleVoice finalizes sessions nothing reports on any more: their server stopped
// heartbeating (it crashed or was replaced), or lost the session without being able to end
// it. They stop holding the user's voice slot, blocking deletion and counting as live, and
// bill the connected time last recorded, at least the 15-second minimum. user limits it to
// one member; "" sweeps everyone.
func endStaleVoice(ctx context.Context, q execer, user string) error {
	_, e := q.Exec(ctx, `UPDATE voice_sessions SET status='interrupted',seconds=greatest(seconds,15),finalized=true WHERE NOT finalized AND heartbeat_at<now()-interval '90 seconds' AND ($1='' OR user_id=$1)`, user)
	return e
}

// monitorVoice is the server's side of a live session: it records transcripts, runs
// delegations, relays replies and ends the session. It bills what was used whenever that can
// be known: the provider's final usage, or the connected time it observed once the session is
// known to be over. A session it can neither observe nor end keeps its reservation, which the
// stale sweep finalizes once heartbeats stop.
func (a *App) monitorVoice(parent context.Context, conn *websocket.Conn, id, provider, project, owner string, maxSeconds int) {
	// The sideband outlives a stop request long enough to end the session properly.
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	defer cancel()
	defer func() { conn.CloseNow() }()
	events := make(chan live.Event, 64)
	dropped := make(chan error, 1)
	read := func(conn *websocket.Conn) {
		for {
			var ev live.Event
			if e := wsjson.Read(ctx, conn, &ev); e != nil {
				dropped <- e
				return
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}
	go read(conn)
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	started := time.Now()
	lastSpeech := started
	closing := time.Time{}
	var giveUp <-chan time.Time
	sent := false // session.close reached the provider
	// "closed": the provider reported final usage; "ended": the session is known to be over.
	outcome := ""
	defer func() {
		end, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		observed := time.Since(started)
		if !closing.IsZero() {
			observed = closing.Sub(started)
		}
		query, args := `UPDATE voice_sessions SET status='interrupted' WHERE id=$1`, []any{id}
		switch outcome {
		case "closed":
			query = `UPDATE voice_sessions SET status='closed',finalized=true WHERE id=$1`
		case "ended":
			query, args = `UPDATE voice_sessions SET status='interrupted',seconds=greatest(seconds,$2,15),finalized=true WHERE id=$1`, []any{id, observed.Seconds()}
		}
		if _, e := a.DB.Exec(end, query, args...); e != nil {
			slog.Error("record voice session end", "session", id, "error", e)
		}
	}()
	lastProgress := ""
	endAfter := time.Time{}
	closeCall := func(grace time.Duration) {
		if !closing.IsZero() {
			return
		}
		closing, giveUp = time.Now(), time.After(grace)
		write, c := context.WithTimeout(ctx, 3*time.Second)
		defer c()
		sent = wsjson.Write(write, conn, map[string]string{"type": "session.close"}) == nil
	}
	// over reports whether the session is known to have ended; without the sideband it hangs
	// up over REST.
	over := func() bool {
		if sent {
			return true
		}
		hangup, c := context.WithTimeout(ctx, 5*time.Second)
		defer c()
		e := a.Live.Hangup(hangup, provider)
		if e != nil {
			slog.Warn("voice hangup failed", "session", id, "error", e)
		}
		return e == nil
	}
	stopping := parent.Done()
	for {
		select {
		case <-stopping:
			// The server is stopping: end the session so nothing accrues unseen, and give the
			// provider a moment to report its final usage.
			stopping = nil
			closeCall(3 * time.Second)
			if !sent {
				if over() {
					outcome = "ended"
				}
				return
			}
			giveUp = time.After(3 * time.Second) // Also shortens a close already under way.
		case <-giveUp:
			if over() {
				outcome = "ended"
			}
			return
		case e := <-dropped:
			if closing.IsZero() && parent.Err() == nil {
				slog.Warn("voice sideband dropped", "session", id, "error", e)
				if next, ok := a.reattachVoice(parent, provider); ok {
					conn.CloseNow()
					conn = next
					go read(conn)
					continue
				}
			}
			if over() {
				outcome = "ended"
			}
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
					closeCall(8 * time.Second)
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
				} else {
					a.wake("studio")
				}
			case "session.usage.updated", "session.closed":
				_, _ = a.DB.Exec(ctx, `UPDATE voice_sessions SET seconds=greatest(seconds,$2) WHERE id=$1`, id, ev.Usage.Seconds)
				if ev.Type == "session.closed" {
					outcome = "closed"
					return
				}
			case "error":
				slog.Warn("voice provider event error", "session", id)
			}
		case <-tick.C:
			if !closing.IsZero() {
				continue // Waiting for session.closed, or giveUp.
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
				closeCall(8 * time.Second)
				continue
			}
			if time.Since(lastSpeech) > 3*time.Minute {
				_ = live.Append(ctx, conn, "commentary", "", "I'll pause the microphone now to save your voice time. Our conversation is saved; you can resume whenever you're ready.")
				closeCall(8 * time.Second)
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

// reattachVoice rejoins a session whose sideband dropped, if the provider allows it, and gives
// up when the server stops.
func (a *App) reattachVoice(ctx context.Context, provider string) (*websocket.Conn, bool) {
	wait := 500 * time.Millisecond
	for range 3 {
		select {
		case <-ctx.Done():
			return nil, false
		case <-time.After(wait):
		}
		attach, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn, e := a.Live.Attach(attach, provider)
		cancel()
		if e == nil {
			return conn, true
		}
		wait *= 2
	}
	return nil, false
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
