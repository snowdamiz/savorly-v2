package app

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestCapabilitiesExposeConfiguredModels(t *testing.T) {
	settings := map[string]string{
		"OPENROUTER_TEXT_MODEL":   "textModel",
		"OPENROUTER_RECIPE_MODEL": "recipeModel",
		"OPENROUTER_AGENT_MODEL":  "agentModel",
		"OPENROUTER_IMAGE_MODEL":  "imageModel",
		"OPENAI_LIVE_MODEL":       "voiceModel",
	}
	for key, field := range settings {
		t.Setenv(key, "configured-"+field)
	}
	t.Setenv("OPENAI_API_KEY", "test-openai-secret")
	t.Setenv("OPENROUTER_API_KEY", "test-router-secret")
	t.Setenv("ELEVENLABS_API_KEY", "")
	f := New(nil, Config{Origins: []string{"http://localhost:8081"}})
	res, e := f.Test(httptest.NewRequest("GET", "/v1/capabilities", nil))
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	var body map[string]any
	if e = json.NewDecoder(res.Body).Decode(&body); e != nil {
		t.Fatal(e)
	}
	if res.StatusCode != 200 || body["voiceAI"] != true {
		t.Fatal("Live and OpenRouter should enable voice together")
	}
	if body["cookingNarration"] != true || body["cookingNarrationModel"] != "elevenlabs/eleven-v4-turbo" {
		t.Fatal("OpenRouter alone should enable ElevenLabs narration")
	}
	for _, field := range settings {
		if body[field] != "configured-"+field {
			t.Errorf("%s did not reflect runtime configuration: %v", field, body[field])
		}
	}
	for _, value := range body {
		if value == "test-openai-secret" || value == "test-router-secret" {
			t.Fatal("provider credential exposed")
		}
	}
}
