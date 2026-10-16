package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"savorly/api/internal/live"
	"testing"
	"time"

	"github.com/coder/websocket"
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
