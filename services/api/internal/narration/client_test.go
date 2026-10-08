package narration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConfigurationUsesOnlyOpenRouter(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "router-secret")
	t.Setenv("OPENROUTER_TTS_VOICE", "")
	t.Setenv("ELEVENLABS_API_KEY", "unused-secret")
	t.Setenv("ELEVENLABS_VOICE_ID", "unsupported-direct-voice")
	c := New()
	if !c.Enabled() || c.Key != "router-secret" || c.Voice != "sarah" || c.URL != "https://openrouter.ai/api/v1/audio/speech" {
		t.Fatal("incorrect OpenRouter speech configuration")
	}
	t.Setenv("OPENROUTER_TTS_VOICE", "george")
	if New().Voice != "george" {
		t.Fatal("voice override ignored")
	}
	t.Setenv("OPENROUTER_API_KEY", "")
	if New().Enabled() {
		t.Fatal("legacy ElevenLabs key must not enable narration")
	}
}

func TestOpenRouterStreamsBeforeCompletionAndKeepsFinalBytes(t *testing.T) {
	finish := make(chan struct{})
	var once sync.Once
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/audio/speech" || r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Xi-Api-Key") != "" {
			t.Error("incorrect endpoint or authentication")
		}
		var input map[string]string
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		if len(input) != 4 || input["model"] != "elevenlabs/eleven-v4-turbo" || input["voice"] != "sarah" || input["input"] != "Stir." || input["response_format"] != "mp3" {
			t.Error("incorrect speech payload")
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("first"))
		w.(http.Flusher).Flush()
		select {
		case <-finish:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte("tail"))
	}))
	defer server.Close()
	defer once.Do(func() { close(finish) })
	c := &Client{Key: "secret", Voice: "sarah", URL: server.URL + "/api/v1/audio/speech"}
	reader, writer := io.Pipe()
	defer reader.Close()
	done := make(chan error, 1)
	go func() {
		err := c.Generate(ctx, "Stir.", writer)
		_ = writer.CloseWithError(err)
		done <- err
	}()
	first := make([]byte, 5)
	if _, err := io.ReadFull(reader, first); err != nil || string(first) != "first" {
		t.Fatalf("first chunk not streamed: %q %v", first, err)
	}
	select {
	case err := <-done:
		t.Fatalf("completed before stream ended: %v", err)
	default:
	}
	once.Do(func() { close(finish) })
	tail, err := io.ReadAll(reader)
	if err != nil || string(tail) != "tail" {
		t.Fatalf("lost final encoder bytes: %q %v", tail, err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}

func TestProviderFailuresAreNotSuccessfulAudio(t *testing.T) {
	for _, tc := range []struct {
		name               string
		status             int
		mime, body, length string
	}{
		{"unauthorized", 401, "application/json", `{"error":"do not leak provider secrets"}`, ""},
		{"billing", 402, "application/json", `{"error":"do not leak provider secrets"}`, ""},
		{"rate limit", 429, "text/html", "do not leak provider secrets", ""},
		{"empty", 200, "audio/mpeg", "", ""},
		{"json instead of audio", 200, "application/json", `{"error":"do not leak provider secrets"}`, ""},
		{"wrong format", 200, "audio/pcm", "raw", ""},
		{"truncated", 200, "audio/mpeg", "partial", "100"},
		{"oversized length", 200, "audio/mpeg", "", strconv.Itoa(MaxAudioBytes + 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", tc.mime)
				if tc.length != "" {
					w.Header().Set("Content-Length", tc.length)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			c := &Client{Key: "secret", Voice: "sarah", URL: server.URL}
			var out bytes.Buffer
			err := c.Generate(context.Background(), "Stir.", &out)
			if err == nil || strings.Contains(err.Error(), "do not leak") {
				t.Fatalf("unsafe success/error: %v", err)
			}
			if tc.name != "truncated" && out.Len() != 0 {
				t.Fatal("non-audio response was forwarded")
			}
			if calls.Load() != 1 {
				t.Fatal("failed request was retried")
			}
		})
	}
}

func TestChunkedAudioIsBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.(http.Flusher).Flush() // Unknown length must also enforce the cap.
		chunk := bytes.Repeat([]byte("a"), 32*1024)
		for sent := 0; sent <= MaxAudioBytes; sent += len(chunk) {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	c := &Client{Key: "secret", Voice: "sarah", URL: server.URL}
	var out bytes.Buffer
	if err := c.Generate(context.Background(), "Stir.", &out); err == nil {
		t.Fatal("oversized stream accepted")
	}
	if out.Len() > MaxAudioBytes {
		t.Fatal("stream exceeded memory bound")
	}
}

func TestCancellationClosesProviderStream(t *testing.T) {
	started, disconnected := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(disconnected)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c := &Client{Key: "secret", Voice: "sarah", URL: server.URL}
	done := make(chan error, 1)
	go func() { done <- c.Generate(ctx, "Stir.", io.Discard) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("request never started")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled stream succeeded")
	}
	select {
	case <-disconnected:
	case <-time.After(time.Second):
		t.Fatal("provider connection left open")
	}
}

func TestStreamStartsEarlyAndSharesGeneration(t *testing.T) {
	var hub Hub
	var calls atomic.Int32
	finish := make(chan struct{})
	work := func(ctx context.Context, s *Stream) error {
		calls.Add(1)
		_, _ = s.Write([]byte("first"))
		select {
		case <-finish:
		case <-ctx.Done():
			return ctx.Err()
		}
		_, err := s.Write([]byte("last"))
		return err
	}
	for range 5 {
		if err := hub.Start(context.Background(), "key", work); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	reader := hub.Get("key").Reader(ctx)
	first := make([]byte, 5)
	if _, err := io.ReadFull(reader, first); err != nil || string(first) != "first" {
		t.Fatalf("not streaming: %s %v", first, err)
	}
	_ = reader.Close() // Closing one listener must not cancel or block generation.
	close(finish)
	second := hub.Get("key").Reader(ctx)
	defer second.Close()
	all, err := io.ReadAll(second)
	if err != nil || string(all) != "firstlast" || calls.Load() != 1 {
		t.Fatalf("duplicate/lost audio: %s %v calls=%d", all, err, calls.Load())
	}
}
