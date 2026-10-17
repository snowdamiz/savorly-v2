package app

import (
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"savorly/api/internal/live"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestVoiceCreateReservesAndAttachesASession(t *testing.T) {
	a, p := studioFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/live/sessions" {
			w.WriteHeader(201)
			w.Write([]byte(`{"session":{"id":"live_test"},"transport":{"type":"webrtc","sdp":"answer"}}`))
			return
		}
		conn, e := websocket.Accept(w, r, nil)
		if e != nil {
			return
		}
		defer conn.CloseNow()
		// The sideband stays open until the API closes it.
		for {
			if _, _, e = conn.Read(r.Context()); e != nil {
				return
			}
		}
	}))
	defer provider.Close()
	a.Live = &live.Client{Key: "test", BaseURL: provider.URL, HTTP: provider.Client()}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	a.Context = ctx
	f := studioServer(a)
	code, body := studioReq(t, f, "POST", "/studio/"+p+"/voice", "cook", "", map[string]string{"sdp": "v=0\r\n"})
	if code != 201 {
		t.Fatal(code, string(body))
	}
	var answer struct {
		ID, SDP    string
		MaxSeconds int
	}
	if e := json.Unmarshal(body, &answer); e != nil || answer.SDP != "answer" || answer.MaxSeconds != 1800 {
		t.Fatal(e, string(body))
	}
	var status string
	var reserved, lease int
	e := a.DB.QueryRow(context.Background(), `SELECT status,reserved_seconds,extract(epoch FROM expires_at-created_at)::int FROM voice_sessions WHERE id=$1`, answer.ID).Scan(&status, &reserved, &lease)
	if e != nil || status != "active" || reserved != 1800 || lease != 1800 {
		t.Fatal(e, status, reserved, lease)
	}
	// Shutting down ends the monitor, which records the session before the schema goes away.
	stop()
	deadline := time.Now().Add(10 * time.Second)
	for status == "active" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		_ = a.DB.QueryRow(context.Background(), `SELECT status FROM voice_sessions WHERE id=$1`, answer.ID).Scan(&status)
	}
	if status != "interrupted" {
		t.Fatal(status)
	}
}

// fakeLive is GPT-Live for tests. Handshakes answer createStatus (201 creates a session) and
// first attaches attachStatus (0 opens the sideband); later attaches answer reattach and REST
// hangups answer hangup (0 allows them). Handshake requests are kept in created. The sideband
// sends what the test queues (nil drops the connection), records the API's commands, and
// answers session.close with session.closed reporting closeUsage seconds, unless silent.
type fakeLive struct {
	events            chan any
	commands          chan map[string]any
	created           chan map[string]any
	reattach, hangup  atomic.Int32
	attaches, hangups atomic.Int32
	closeUsage        atomic.Int64
	silent            atomic.Bool
}

func startFakeLive(t *testing.T, a *App, createStatus, attachStatus int) *fakeLive {
	t.Helper()
	f := &fakeLive{events: make(chan any, 16), commands: make(chan map[string]any, 64), created: make(chan map[string]any, 4)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/live/sessions":
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) == nil {
				select {
				case f.created <- body:
				default:
				}
			}
			w.WriteHeader(createStatus)
			if createStatus == 201 {
				w.Write([]byte(`{"session":{"id":"live_test"},"transport":{"type":"webrtc","sdp":"answer"}}`))
			}
			return
		case r.URL.Path == "/live/sessions/live_test/hangup" && r.Method == "POST":
			f.hangups.Add(1)
			w.WriteHeader(cmp.Or(int(f.hangup.Load()), 200))
			return
		}
		if n := f.attaches.Add(1); n == 1 && attachStatus != 0 {
			w.WriteHeader(attachStatus)
			return
		} else if status := f.reattach.Load(); n > 1 && status != 0 {
			w.WriteHeader(int(status))
			return
		}
		conn, e := websocket.Accept(w, r, nil)
		if e != nil {
			return
		}
		defer conn.CloseNow()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() {
			defer cancel()
			for {
				var command map[string]any
				if wsjson.Read(ctx, conn, &command) != nil {
					return
				}
				select {
				case f.commands <- command:
				default:
				}
				if command["type"] == "session.close" && !f.silent.Load() {
					_ = wsjson.Write(ctx, conn, map[string]any{"type": "session.closed", "usage": map[string]any{"seconds": f.closeUsage.Load()}})
				}
			}
		}()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-f.events:
				if ev == nil {
					return
				}
				if wsjson.Write(ctx, conn, ev) != nil {
					return
				}
			}
		}
	}))
	t.Cleanup(server.Close)
	a.Live = &live.Client{Key: "test", BaseURL: server.URL, HTTP: server.Client()}
	return f
}

// runVoice gives voice monitors a lifetime, as the server's own, that ends (stop is the server
// stopping) and waits for them before the test's schema goes away.
func runVoice(t *testing.T, a *App) (stop func()) {
	t.Helper()
	ctx, stop := context.WithCancel(context.Background())
	a.Context = ctx
	t.Cleanup(func() {
		stop()
		a.waitForVoice(15 * time.Second)
	})
	return stop
}
func startVoice(t *testing.T, a *App, p string) (int, string) {
	t.Helper()
	status, body := studioReq(t, studioServer(a), "POST", "/studio/"+p+"/voice", "cook", "", map[string]string{"sdp": "v=0\r\n"})
	var answer struct{ ID string }
	_ = json.Unmarshal(body, &answer)
	return status, answer.ID
}
func voiceSession(t *testing.T, a *App, id string) (status string, reserved int, seconds float64, finalized bool) {
	t.Helper()
	if e := a.DB.QueryRow(context.Background(), `SELECT status,reserved_seconds,seconds,finalized FROM voice_sessions WHERE id=$1`, id).Scan(&status, &reserved, &seconds, &finalized); e != nil {
		t.Fatal(e)
	}
	return
}
func lastVoiceSession(t *testing.T, a *App, p string) string {
	t.Helper()
	var id string
	if e := a.DB.QueryRow(context.Background(), `SELECT id FROM voice_sessions WHERE project_id=$1 AND id NOT LIKE 'chat_%' ORDER BY created_at DESC LIMIT 1`, p).Scan(&id); e != nil {
		t.Fatal(e)
	}
	return id
}
func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(15 * time.Second); !ok(); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting: " + what)
		}
	}
}

func TestVoiceHandshakeFailureReleasesTheReservation(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	ctx := context.Background()
	if _, e := a.DB.Exec(ctx, `UPDATE users SET plan='free',plan_status='' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	runVoice(t, a)
	startFakeLive(t, a, 503, 0)
	if status, _ := startVoice(t, a, p); status != 502 {
		t.Fatal(status)
	}
	// The provider made no session, so nothing was billed and nothing stays reserved.
	if status, reserved, seconds, finalized := voiceSession(t, a, lastVoiceSession(t, a, p)); status != "interrupted" || reserved != 0 || seconds != 0 || !finalized {
		t.Fatalf("failed handshake: %s reserved=%d seconds=%v finalized=%v", status, reserved, seconds, finalized)
	}
	if used, e := usageOf(ctx, a.DB, "cook"); e != nil || used.VoiceSeconds != 0 || used.Spend != 0 {
		t.Fatalf("failed handshake counted: %+v %v", used, e)
	}
	// So the Free member still has their whole two minutes.
	startFakeLive(t, a, 201, 0)
	status, id := startVoice(t, a, p)
	if _, reserved, _, _ := voiceSession(t, a, id); status != 201 || reserved != 120 {
		t.Fatalf("retry: %d reserved %d", status, reserved)
	}
}

func TestVoiceAttachFailureBillsTheMinimum(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	ctx := context.Background()
	if _, e := a.DB.Exec(ctx, `UPDATE users SET plan='free',plan_status='' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	runVoice(t, a)
	startFakeLive(t, a, 201, 403)
	if status, _ := startVoice(t, a, p); status != 502 {
		t.Fatal(status)
	}
	// The provider has a session, which bills its 15-second minimum; the rest is released.
	if status, _, seconds, finalized := voiceSession(t, a, lastVoiceSession(t, a, p)); status != "interrupted" || seconds != 15 || !finalized {
		t.Fatalf("failed attach: %s seconds=%v finalized=%v", status, seconds, finalized)
	}
	if used, e := usageOf(ctx, a.DB, "cook"); e != nil || used.VoiceSeconds != 15 || used.Spend < .0124 || used.Spend > .0126 {
		t.Fatalf("failed attach counted: %+v %v", used, e)
	}
}

func TestVoiceRenewalReplacesTheClosingSession(t *testing.T) {
	a, p := studioFixture(t)
	runVoice(t, a)
	startFakeLive(t, a, 201, 0)
	status, first := startVoice(t, a, p)
	if status != 201 {
		t.Fatal(status)
	}
	if status, _ = startVoice(t, a, p); status != 409 {
		t.Fatalf("a second open session: %d", status)
	}
	// Renewing at the end of a lease closes the old session first; its slot frees at once,
	// while it finishes its last words.
	if status, _ = studioReq(t, studioServer(a), "DELETE", "/studio/voice/"+first, "cook", "", nil); status != 204 {
		t.Fatal(status)
	}
	if status, _, _, _ := voiceSession(t, a, first); status != "closing" {
		t.Fatal(status)
	}
	if status, second := startVoice(t, a, p); status != 201 || second == first {
		t.Fatalf("renewal refused: %d", status)
	}
}

func TestVoiceMonitorRecordsTheConversationAndClosesGracefully(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	runVoice(t, a)
	provider := startFakeLive(t, a, 201, 0)
	status, id := startVoice(t, a, p)
	if status != 201 {
		t.Fatal(status)
	}
	provider.events <- map[string]any{"type": "session.input_transcript.delta", "event_id": "in-1", "delta": "Two slices "}
	provider.events <- map[string]any{"type": "session.input_transcript.delta", "event_id": "in-2", "delta": "of bread."}
	provider.events <- map[string]any{"type": "session.input_transcript.delta", "event_id": "in-2", "delta": "of bread."} // redelivered
	provider.events <- map[string]any{"type": "session.output_transcript.delta", "event_id": "out-1", "delta": "Got it."}
	provider.events <- map[string]any{"type": "session.delegation.created", "delegation": map[string]any{"id": "d-1"}}
	provider.events <- map[string]any{"type": "session.usage.updated", "usage": map[string]any{"seconds": 42}}
	var through, last int64
	eventually(t, "the delegated turn", func() bool {
		return a.DB.QueryRow(ctx, `SELECT through_seq,(SELECT max(seq) FROM voice_events WHERE project_id=$1) FROM voice_actions WHERE project_id=$1 AND delegation_id='d-1' AND session_id=$2 AND status='queued'`, p, id).Scan(&through, &last) == nil
	})
	state, _ := a.studioState(ctx, p, 0)
	if through != last || len(state.Conversation) != 2 || state.Conversation[0].Content != "Two slices of bread." || state.Conversation[1].Content != "Got it." {
		t.Fatalf("transcript %+v through %d of %d", state.Conversation, through, last)
	}
	eventually(t, "usage", func() bool { _, _, seconds, _ := voiceSession(t, a, id); return seconds >= 42 })
	// When the worker answers, the monitor gives the reply to the voice model to say.
	if _, e := a.DB.Exec(ctx, `UPDATE voice_actions SET status='completed',reply='Saved your toast.' WHERE delegation_id='d-1'`); e != nil {
		t.Fatal(e)
	}
	if c := provider.await(t, "session.commentary.append"); c["delegation_id"] != "d-1" || c["content"] != "Saved your toast." {
		t.Fatal(c)
	}
	eventually(t, "delivery", func() bool {
		var delivered bool
		_ = a.DB.QueryRow(ctx, `SELECT delivered FROM voice_actions WHERE delegation_id='d-1'`).Scan(&delivered)
		return delivered
	})
	// Ending: the monitor lets the model finish speaking, closes the provider session, and
	// bills what the provider reports.
	provider.closeUsage.Store(50)
	if status, _ = studioReq(t, studioServer(a), "DELETE", "/studio/voice/"+id, "cook", "", nil); status != 204 {
		t.Fatal(status)
	}
	provider.await(t, "session.close")
	eventually(t, "the provider's final usage", func() bool {
		status, _, seconds, finalized := voiceSession(t, a, id)
		return status == "closed" && finalized && seconds == 50
	})
}

// await returns the API's next command of this kind.
func (f *fakeLive) await(t *testing.T, kind string) map[string]any {
	t.Helper()
	for deadline := time.After(30 * time.Second); ; {
		select {
		case c := <-f.commands:
			if c["type"] == kind {
				return c
			}
		case <-deadline:
			t.Fatal("no " + kind)
		}
	}
}

func TestVoiceShutdownEndsTheSessionAndBillsWhatWasUsed(t *testing.T) {
	for _, silent := range []bool{false, true} {
		t.Run(map[bool]string{false: "provider reports final usage", true: "provider says nothing"}[silent], func(t *testing.T) {
			a, p := studioFixture(t)
			stop := runVoice(t, a)
			provider := startFakeLive(t, a, 201, 0)
			provider.closeUsage.Store(50)
			provider.silent.Store(silent)
			status, id := startVoice(t, a, p)
			if status != 201 {
				t.Fatal(status)
			}
			provider.events <- map[string]any{"type": "session.usage.updated", "usage": map[string]any{"seconds": 42}}
			eventually(t, "usage", func() bool { _, _, seconds, _ := voiceSession(t, a, id); return seconds >= 42 })
			// The server stops (a deploy): the session ends at the provider, so nothing accrues
			// unseen, and it bills what was used rather than its 30-minute reservation.
			stop()
			provider.await(t, "session.close")
			want, outcome := 50.0, "closed"
			if silent {
				want, outcome = 42, "interrupted"
			}
			eventually(t, "the session's final billing", func() bool {
				status, _, seconds, finalized := voiceSession(t, a, id)
				return status == outcome && finalized && seconds == want
			})
			if provider.hangups.Load() != 0 {
				t.Fatal("hung up a session the sideband closed")
			}
		})
	}
}

func TestVoiceSidebandDropRejoinsTheSession(t *testing.T) {
	a, p := studioFixture(t)
	runVoice(t, a)
	provider := startFakeLive(t, a, 201, 0)
	status, id := startVoice(t, a, p)
	if status != 201 {
		t.Fatal(status)
	}
	provider.events <- nil
	eventually(t, "the second attach", func() bool { return provider.attaches.Load() == 2 })
	// The rejoined sideband keeps recording the conversation.
	provider.events <- map[string]any{"type": "session.input_transcript.delta", "event_id": "after-drop", "delta": "Still here."}
	eventually(t, "the transcript after the drop", func() bool {
		var n int
		_ = a.DB.QueryRow(context.Background(), `SELECT count(*) FROM voice_events WHERE session_id=$1 AND content='Still here.'`, id).Scan(&n)
		return n == 1
	})
	if status, _, _, finalized := voiceSession(t, a, id); status != "active" || finalized || provider.hangups.Load() != 0 {
		t.Fatalf("rejoined session: %s finalized=%v", status, finalized)
	}
}

func TestVoiceSidebandDropHangsUpWhenItCantRejoin(t *testing.T) {
	a, p := studioFixture(t)
	runVoice(t, a)
	provider := startFakeLive(t, a, 201, 0)
	provider.reattach.Store(410)
	status, id := startVoice(t, a, p)
	if status != 201 {
		t.Fatal(status)
	}
	provider.events <- map[string]any{"type": "session.usage.updated", "usage": map[string]any{"seconds": 42}}
	eventually(t, "usage", func() bool { _, _, seconds, _ := voiceSession(t, a, id); return seconds >= 42 })
	provider.events <- nil
	// Three tries to rejoin, then a REST hangup: the session is known to be over, so it bills
	// the time observed.
	eventually(t, "the hung-up session", func() bool {
		status, _, seconds, finalized := voiceSession(t, a, id)
		return status == "interrupted" && finalized && seconds == 42
	})
	if provider.attaches.Load() != 4 || provider.hangups.Load() != 1 {
		t.Fatalf("attaches %d, hangups %d", provider.attaches.Load(), provider.hangups.Load())
	}
}

func TestVoiceSessionNobodyCanEndKeepsItsReservationUntilTheSweep(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	runVoice(t, a)
	provider := startFakeLive(t, a, 201, 0)
	provider.reattach.Store(410)
	provider.hangup.Store(404)
	status, id := startVoice(t, a, p)
	if status != 201 {
		t.Fatal(status)
	}
	provider.events <- map[string]any{"type": "session.usage.updated", "usage": map[string]any{"seconds": 42}}
	eventually(t, "usage", func() bool { _, _, seconds, _ := voiceSession(t, a, id); return seconds >= 42 })
	provider.events <- nil
	// Usage may still be accruing where nothing can see it: the reservation stands, and the
	// app is told the call was interrupted so it hangs up its side.
	eventually(t, "the lost session", func() bool {
		status, reserved, _, finalized := voiceSession(t, a, id)
		return status == "interrupted" && reserved == 1800 && !finalized && provider.hangups.Load() == 1
	})
	if used, _ := usageOf(ctx, a.DB, "cook"); used.VoiceSeconds != 1800 {
		t.Fatalf("lost session counted %d seconds", used.VoiceSeconds)
	}
	// Once its heartbeat is stale, the sweep finalizes it at what was recorded.
	if _, e := a.DB.Exec(ctx, `UPDATE voice_sessions SET heartbeat_at=now()-interval '2 minutes' WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	if e := endStaleVoice(ctx, a.DB, ""); e != nil {
		t.Fatal(e)
	}
	if status, _, seconds, finalized := voiceSession(t, a, id); status != "interrupted" || !finalized || seconds != 42 {
		t.Fatalf("swept: %s %v %v", status, seconds, finalized)
	}
	if used, _ := usageOf(ctx, a.DB, "cook"); used.VoiceSeconds != 42 {
		t.Fatalf("swept session counted %d seconds", used.VoiceSeconds)
	}
}

func TestStaleVoiceSessionsEndAndBillWhatWasRecorded(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	session := func(id, user, status string, seconds float64, heartbeat string) {
		t.Helper()
		if _, e := a.DB.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,heartbeat_at,expires_at) VALUES($1,$2,$3,$4,1800,$5,now()-$6::interval,now()+interval '30 minutes')`, id, p, user, status, seconds, heartbeat); e != nil {
			t.Fatal(e)
		}
	}
	// A replica died mid-call and while a call was closing; another call is alive.
	session("crashed", "cook", "active", 42, "5 minutes")
	session("crashed-closing", "cook", "closing", 3, "5 minutes")
	session("alive", "other", "active", 10, "1 second")
	if status, _ := studioReq(t, studioServer(a), "DELETE", "/studio/"+p, "cook", "", nil); status != 409 {
		t.Fatalf("deleted a conversation with a call open: %d", status)
	}
	if e := endStaleVoice(ctx, a.DB, ""); e != nil {
		t.Fatal(e)
	}
	for id, want := range map[string]float64{"crashed": 42, "crashed-closing": 15} {
		if status, _, seconds, finalized := voiceSession(t, a, id); status != "interrupted" || seconds != want || !finalized {
			t.Fatalf("%s: %s %v %v", id, status, seconds, finalized)
		}
	}
	if status, _, _, finalized := voiceSession(t, a, "alive"); status != "active" || finalized {
		t.Fatal("a live call was ended")
	}
	if used, _ := usageOf(ctx, a.DB, "cook"); used.VoiceSeconds != 57 {
		t.Fatalf("billed %d seconds", used.VoiceSeconds)
	}
	if _, e := a.DB.Exec(ctx, `UPDATE voice_sessions SET status='closed',finalized=true WHERE id='alive'`); e != nil {
		t.Fatal(e)
	}
	if status, b := studioReq(t, studioServer(a), "DELETE", "/studio/"+p, "cook", "", nil); status != 204 {
		t.Fatalf("stale call still blocks deleting the conversation: %d %s", status, b)
	}
}
