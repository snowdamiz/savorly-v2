package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
			w.Write([]byte(`{"choices":[{"message":{"content":"{\"recipe\":{\"title\":\"Lemon pasta\"}}"}}]}`))
		case "/images":
			// A touch-up sends the photo as a reference to the edit model and keeps its framing; a new
			// cover is 4:3.
			aspect, model := "4:3", "openai/gpt-image-2.5-flare"
			if refs, _ := body["input_references"].([]any); refs != nil {
				aspect, model = "auto", "openai/gpt-image-2.5-sunburst"
				ref, _ := refs[0].(map[string]any)
				url, _ := ref["image_url"].(map[string]any)["url"].(string)
				if len(refs) != 1 || ref["type"] != "image_url" || url != "data:image/png;base64,cGhvdG8=" {
					t.Errorf("incorrect touch-up reference: %v", refs)
				}
			}
			if body["n"] != float64(1) || body["model"] != model || body["aspect_ratio"] != aspect || body["quality"] != "medium" || body["output_format"] != "jpeg" {
				t.Error("incorrect GPT Image contract")
			}
			if body["provider"].(map[string]any)["sort"] != "latency" {
				t.Error("image routing should favor latency")
			}
			w.Write([]byte(`{"data":[{"b64_json":"aW1hZ2U=","media_type":"image/jpeg"}]}`))
		case "/videos/generations":
			if body["duration"] != float64(4) || body["resolution"] != "720p" || body["size"] != "16:9" || body["model"] != "doubao-seedance-2.0-eco-mini" || body["content_filter"] != true || body["generate_audio"] != false || body["watermark"] != true {
				t.Errorf("incorrect video contract: %v", body)
			}
			// A step's photo opens its clip; a step without one is made from its words alone.
			frames, _ := body["image_with_roles"].([]any)
			if strings.Contains(body["prompt"].(string), "photo") {
				frame, _ := frames[0].(map[string]any)
				if len(frames) != 1 || frame["url"] != "https://cdn.example/step.jpg" || frame["role"] != "first_frame" {
					t.Errorf("incorrect first frame: %v", frames)
				}
			} else if frames != nil {
				t.Errorf("a clip without a photo sent frames: %v", frames)
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
	ctx := context.Background()
	recipe, e := c.Recipe(ctx, "Import the recipe on this web page: https://cook.example/pasta")
	if e != nil || string(recipe) != `{"recipe":{"title":"Lemon pasta"}}` {
		t.Fatalf("recipe: %s %v", recipe, e)
	}
	b, mime, e := c.Image(ctx, "pasta")
	if e != nil || string(b) != "image" || mime != "image/jpeg" {
		t.Fatalf("image: %v", e)
	}
	b, mime, e = c.EditImage(ctx, "Retouch it", []byte("photo"), "image/png")
	if e != nil || string(b) != "image" || mime != "image/jpeg" {
		t.Fatalf("touch-up: %v", e)
	}
	task, e := c.Video(ctx, "Toss the pasta", "")
	if e != nil || task.ID != "task_123" {
		t.Fatalf("video: %v", e)
	}
	if _, e = c.Video(ctx, "Toss the pasta in the photo", "https://cdn.example/step.jpg"); e != nil {
		t.Fatalf("video from a photo: %v", e)
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
			if _, e := c.Recipe(context.Background(), "hello"); e == nil {
				t.Fatal("expected error")
			}
		})
	}
}

// Recipe jobs (imports of pages and captions) ask for the equipment the editor holds, and what the
// model lists comes back with the recipe.
func TestRecipeSchemaAsksForEquipment(t *testing.T) {
	clearModelEnv(t)
	var system string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []map[string]string `json:"messages"`
		}
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil || len(body.Messages) != 2 {
			t.Errorf("request: %v %v", body, e)
		} else {
			system = body.Messages[0]["content"]
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"content":"{\"recipe\":{\"title\":\"Soup\",\"equipment\":[\"Large pot\",\"Blender\"]}}"}}]}`))
	}))
	defer server.Close()
	c := New()
	c.OpenRouterURL, c.OpenRouterKey = server.URL, "test-key"
	out, e := c.Recipe(context.Background(), "Import the recipe on this web page: https://cook.example/soup")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(system, "equipment (array of up to 20 short names") || !strings.Contains(system, "pots, pans, appliances and tools") {
		t.Errorf("the schema doesn't ask for equipment: %s", system)
	}
	var r struct {
		Recipe struct{ Equipment []string } `json:"recipe"`
	}
	if e = json.Unmarshal(out, &r); e != nil || strings.Join(r.Recipe.Equipment, "|") != "Large pot|Blender" {
		t.Fatalf("equipment: %s %v", out, e)
	}
}
