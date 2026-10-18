package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func clearModelEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"OPENROUTER_RECIPE_MODEL", "OPENROUTER_AGENT_MODEL", "OPENROUTER_VOICE_MODEL", "OPENROUTER_IMAGE_MODEL", "OPENROUTER_IMAGE_EDIT_MODEL", "REAPI_VIDEO_MODEL"} {
		t.Setenv(key, "")
	}
}

func TestModelConfiguration(t *testing.T) {
	clearModelEnv(t)
	c := New()
	if c.RecipeModel != "openai/gpt-6.1-sol" || c.AgentModel != "openai/gpt-6-luna" || c.ImageModel != "openai/gpt-image-2.5-flare" || c.ImageEditModel != "openai/gpt-image-2.5-sunburst" || c.VideoModel != "doubao-seedance-2.0-eco-mini" {
		t.Fatal("model defaults drifted from the documented configuration")
	}
	t.Setenv("OPENROUTER_VOICE_MODEL", "legacy/agent")
	if New().AgentModel != "legacy/agent" {
		t.Fatal("legacy deployments lost their agent override")
	}
	t.Setenv("OPENROUTER_RECIPE_MODEL", "custom/recipe")
	t.Setenv("OPENROUTER_AGENT_MODEL", "custom/agent")
	t.Setenv("OPENROUTER_IMAGE_MODEL", "custom/image")
	t.Setenv("OPENROUTER_IMAGE_EDIT_MODEL", "custom/edit")
	c = New()
	if c.RecipeModel != "custom/recipe" || c.AgentModel != "custom/agent" || c.ImageModel != "custom/image" || c.ImageEditModel != "custom/edit" {
		t.Fatal("explicit model overrides were ignored")
	}
}

func TestRecipesUseTheRecipeModel(t *testing.T) {
	t.Setenv("OPENROUTER_RECIPE_MODEL", "configured/detailed")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Error(e)
			return
		}
		if body["model"] != "configured/detailed" || body["max_tokens"] != float64(8192) {
			t.Errorf("wrong model/token budget: %v", body)
		}
		if !reflect.DeepEqual(body["reasoning"], map[string]any{"effort": "medium", "exclude": true}) {
			t.Errorf("wrong reasoning: %v", body["reasoning"])
		}
		if !reflect.DeepEqual(body["provider"], map[string]any{"sort": "throughput", "require_parameters": true}) {
			t.Errorf("wrong routing: %v", body["provider"])
		}
		if body["response_format"].(map[string]any)["type"] != "json_object" {
			t.Error("JSON mode lost")
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"{\"recipe\":{\"title\":\"Lentil soup\"}}"}}]}`))
	}))
	defer server.Close()
	c := New()
	c.OpenRouterURL = server.URL
	if _, e := c.Recipe(context.Background(), "Import the recipe on this web page: https://cook.example/soup"); e != nil {
		t.Fatal(e)
	}
}

func TestAgentPreservesReasoningSignaturesAndUsesFastRouting(t *testing.T) {
	t.Setenv("OPENROUTER_AGENT_MODEL", "configured/agent")
	reasoning := json.RawMessage(`[{"type":"reasoning.encrypted","data":"opaque-signature","id":"call_1","format":"google-gemini-v1","index":0}]`)
	turn, executed := 0, 0
	var rounds []AgentRound
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model     string                       `json:"model"`
			Provider  map[string]any               `json:"provider"`
			Reasoning map[string]any               `json:"reasoning"`
			Messages  []map[string]json.RawMessage `json:"messages"`
		}
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Error(e)
			return
		}
		if body.Model != "configured/agent" || body.Provider["sort"] != "latency" || body.Provider["require_parameters"] != true || body.Reasoning["effort"] != "low" {
			t.Errorf("wrong agent request: %+v", body)
		}
		var message map[string]any
		if turn == 0 {
			message = map[string]any{"content": nil, "reasoning_details": reasoning, "tool_calls": []any{map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "get_kitchen", "arguments": "{}"}}}}
		} else {
			if len(body.Messages) != 4 {
				t.Errorf("missing tool history: %d", len(body.Messages))
				return
			}
			var got, want any
			json.Unmarshal(body.Messages[2]["reasoning_details"], &got)
			json.Unmarshal(reasoning, &want)
			if !reflect.DeepEqual(got, want) {
				t.Error("opaque reasoning metadata lost or changed")
			}
			message = map[string]any{"content": "Your pantry has lentils."}
		}
		turn++
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message}}, "usage": map[string]any{"cost": .001}})
	}))
	defer server.Close()
	c := New()
	c.OpenRouterURL = server.URL
	reply, cost, e := c.Agent(context.Background(), map[string]string{"question": "What's in my pantry?"}, nil, []Tool{{Name: "get_kitchen", Parameters: map[string]any{"type": "object"}}}, func(name string, args json.RawMessage) string {
		executed++
		if name != "get_kitchen" || string(args) != "{}" {
			t.Error("tool arguments changed")
		}
		return `{"pantry":["lentils"]}`
	}, AgentHooks{Round: func(r AgentRound) { rounds = append(rounds, r) }, Settled: func(content string) (string, bool) {
		if content != "" {
			t.Errorf("content with the calls: %q", content)
		}
		return "", false
	}})
	if e != nil || reply != "Your pantry has lentils." || cost != .002 || executed != 1 || turn != 2 {
		t.Fatalf("agent result: %q cost=%v tools=%d turns=%d err=%v", reply, cost, executed, turn, e)
	}
	// Each round is reported with what it cost and the tools it called.
	if len(rounds) != 2 || rounds[0].Cost != .001 || len(rounds[0].Calls) != 1 || rounds[0].Calls[0] != "get_kitchen" || len(rounds[1].Calls) != 0 {
		t.Fatalf("rounds: %+v", rounds)
	}
}

func TestAgentEndsWhenTheAppSettlesARound(t *testing.T) {
	rounds := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rounds++
		message := map[string]any{"content": " Opening it now. ", "tool_calls": []any{map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "app_action", "arguments": `{"action":"open_recipe"}`}}}}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message}}, "usage": map[string]any{"cost": .001}})
	}))
	defer server.Close()
	c := New()
	c.OpenRouterURL = server.URL
	reply, cost, e := c.Agent(context.Background(), map[string]string{}, nil, []Tool{{Name: "app_action", Parameters: map[string]any{"type": "object"}}}, func(string, json.RawMessage) string { return `{"ok":true}` }, AgentHooks{Settled: func(content string) (string, bool) {
		return content, content != ""
	}})
	if e != nil || reply != "Opening it now." || cost != .001 || rounds != 1 {
		t.Fatalf("settled round: %q cost=%v rounds=%d err=%v", reply, cost, rounds, e)
	}
}
