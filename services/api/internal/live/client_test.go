package live

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLiveWebRTCAndSidebandContract(t *testing.T) {
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("missing server authentication")
		}
		if r.URL.Path == "/live/sessions" {
			var body map[string]any
			if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
				t.Error(e)
			}
			session := body["session"].(map[string]any)
			if session["model"] != "gpt-live-1" || session["store"] != false || session["delegation"].(map[string]any)["type"] != "client" {
				t.Error("wrong live configuration")
			}
			if body["transport"].(map[string]any)["type"] != "webrtc" {
				t.Error("wrong transport")
			}
			w.WriteHeader(201)
			w.Write([]byte(`{"session":{"id":"live_test"},"transport":{"type":"webrtc","sdp":"answer"}}`))
			return
		}
		if r.URL.Path != "/live/sessions/live_test/attach" {
			t.Errorf("wrong attach %s", r.URL.Path)
		}
		conn, e := websocket.Accept(w, r, nil)
		if e != nil {
			t.Error(e)
			return
		}
		defer conn.CloseNow()
		var command map[string]any
		if e = wsjson.Read(r.Context(), conn, &command); e != nil {
			t.Error(e)
			return
		}
		received <- command
	}))
	defer server.Close()
	client := &Client{Key: "test-secret", BaseURL: server.URL, Voice: "gleam", HTTP: server.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	answer, e := client.Create(ctx, "v=0", []Message{{Role: "user", Content: "Two slices"}}, "Draft saved.")
	if e != nil || answer.Transport.SDP != "answer" {
		t.Fatal(e)
	}
	conn, e := client.Attach(ctx, answer.Session.ID)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.CloseNow()
	if e = Append(ctx, conn, "commentary", "delegation-1", "How many servings?"); e != nil {
		t.Fatal(e)
	}
	command := <-received
	if command["type"] != "session.commentary.append" || command["delegation_id"] != "delegation-1" {
		t.Fatal(command)
	}
	if strings.Contains(string(mustMarshal(answer)), "test-secret") {
		t.Fatal("secret exposed")
	}
}
func mustMarshal(v any) []byte { b, _ := json.Marshal(v); return b }

func TestLiveModelEnvironmentReachesSession(t *testing.T) {
	for _, configured := range []string{"", "gpt-live-contract-test"} {
		t.Run(configured, func(t *testing.T) {
			t.Setenv("OPENAI_LIVE_MODEL", configured)
			want := configured
			if want == "" {
				want = "gpt-live-1"
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Session struct {
						Model string `json:"model"`
					} `json:"session"`
				}
				if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
					t.Error(e)
					return
				}
				if body.Session.Model != want {
					t.Errorf("model %q, want %q", body.Session.Model, want)
				}
				w.WriteHeader(201)
				w.Write([]byte(`{"session":{"id":"live_test"},"transport":{"sdp":"answer"}}`))
			}))
			defer server.Close()
			c := New()
			c.BaseURL = server.URL
			if c.ModelID() != want {
				t.Fatal("model configuration not exposed")
			}
			if _, e := c.Create(context.Background(), "offer", nil, ""); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestAppendSplitsWithoutLosingUnicode(t *testing.T) {
	original := strings.Repeat("レモンの皮をすりおろして加える。", 100)
	remaining, joined := original, ""
	for remaining != "" {
		part, rest := splitAppend(remaining)
		if len(part) > 480 || !json.Valid([]byte(`"`+part+`"`)) {
			t.Fatal("invalid UTF-8 chunk")
		}
		joined += part
		remaining = rest
	}
	if joined != original {
		t.Fatal("append lost text")
	}
}
