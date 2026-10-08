package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProviderContracts(t *testing.T) {
	clearModelEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing auth")
		}
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		if r.Method == "POST" {
			if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
				t.Error(e)
			}
		}
		switch r.URL.Path {
		case "/chat/completions":
			if body["response_format"].(map[string]any)["type"] != "json_object" {
				t.Error("missing JSON mode")
			}
			w.Write([]byte(`{"choices":[{"message":{"content":"{\"text\":\"Try a little lemon.\"}"}}]}`))
		case "/images":
			if body["n"] != float64(1) || body["model"] != "openai/gpt-image-2.5-flare" || body["aspect_ratio"] != "4:3" || body["quality"] != "medium" || body["output_format"] != "jpeg" {
				t.Error("incorrect GPT Image contract")
			}
			if body["provider"].(map[string]any)["sort"] != "latency" {
				t.Error("image routing should favor latency")
			}
			w.Write([]byte(`{"data":[{"b64_json":"aW1hZ2U=","media_type":"image/jpeg"}]}`))
		case "/videos/generations":
			if body["duration"] != float64(5) || body["resolution"] != "720p" || body["model"] != "doubao-seedance-2.5-eco" || body["content_filter"] != true {
				t.Error("incorrect video contract")
			}
			w.Write([]byte(`{"id":"task_123","status":"processing"}`))
		case "/tasks/task_123":
			w.Write([]byte(`{"id":"task_123","status":"completed","output":{"video_urls":["https://cdn.example/video.mp4"]}}`))
		default:
			t.Errorf("unknown route %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	c := New()
	c.OpenRouterURL = server.URL
	c.VideoURL = server.URL
	c.OpenRouterKey = "test-key"
	c.VideoKey = "test-key"
	c.VideoModel = "doubao-seedance-2.5-eco"
	ctx := context.Background()
	text, e := c.Text(ctx, "assistant", "Help with dinner")
	if e != nil || string(text) != `{"text":"Try a little lemon."}` {
		t.Fatalf("text: %s %v", text, e)
	}
	b, mime, e := c.Image(ctx, "pasta")
	if e != nil || string(b) != "image" || mime != "image/jpeg" {
		t.Fatalf("image: %v", e)
	}
	task, e := c.Video(ctx, "pasta")
	if e != nil || task.ID != "task_123" {
		t.Fatalf("video: %v", e)
	}
	task, e = c.PollVideo(ctx, task.ID)
	if e != nil || task.Status != "completed" || len(task.Output.URLs) != 1 {
		t.Fatalf("poll: %v", e)
	}
}
func TestProviderFailureAndMalformedResponses(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{{"billing", "do not expose provider internals", 402}, {"empty", "{\"choices\":[]}", 200}, {"invalid JSON", "{", 200}, {"invalid content", `{"choices":[{"message":{"content":"not-json"}}]}`, 200}} {
		t.Run(tc.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
			defer s.Close()
			c := New()
			c.OpenRouterURL = s.URL
			if _, e := c.Text(context.Background(), "assistant", "hello"); e == nil {
				t.Fatal("expected error")
			}
		})
	}
}
