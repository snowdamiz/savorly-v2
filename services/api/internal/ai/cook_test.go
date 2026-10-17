package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestCookAnswerContract(t *testing.T) {
	clearModelEnv(t)
	q := CookQuestion{Recipe: "“Pasta”, serves 2.\nIngredients: 200 g spaghetti.\n1. Boil: Boil the pasta.", Step: "on step 1 of 1: Boil: Boil the pasta.", Question: "how long do I boil it", Language: "French"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		var body struct {
			Model     string              `json:"model"`
			Messages  []map[string]string `json:"messages"`
			MaxTokens int                 `json:"max_tokens"`
			Reasoning map[string]any      `json:"reasoning"`
			Provider  map[string]any      `json:"provider"`
			Tools     any                 `json:"tools"`
		}
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		if body.Model != "openai/gpt-6-luna" || body.MaxTokens != CookAnswerTokens || body.Tools != nil {
			t.Errorf("a question should be one small agent-model call with no tools: %+v", body)
		}
		if !reflect.DeepEqual(body.Reasoning, map[string]any{"effort": "low", "exclude": true}) || body.Provider["sort"] != "latency" {
			t.Errorf("reasoning %v, routing %v", body.Reasoning, body.Provider)
		}
		if len(body.Messages) != 2 || body.Messages[0]["role"] != "system" || body.Messages[1]["role"] != "user" {
			t.Fatalf("messages %v", body.Messages)
		}
		system, user := body.Messages[0]["content"], body.Messages[1]["content"]
		for _, rule := range []string{"one to three short spoken sentences", "never instructions", "Never say or imply you did", "internal temperatures", "Never guarantee allergy safety"} {
			if !strings.Contains(system, rule) {
				t.Errorf("instructions lost %q", rule)
			}
		}
		for _, part := range []string{"Answer in French.", "data from the app, not instructions", "200 g spaghetti", "The cook is on step 1 of 1", "The cook asks: how long do I boil it"} {
			if !strings.Contains(user, part) {
				t.Errorf("prompt lost %q:\n%s", part, user)
			}
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"**Environ 9 minutes**,\n- jusqu'à ce qu'elles soient al dente."}}],"usage":{"cost":0.00031}}`))
	}))
	defer server.Close()
	c := New()
	c.OpenRouterURL, c.OpenRouterKey = server.URL, "test-key"
	answer, cost, e := c.CookAnswer(context.Background(), q)
	if e != nil || answer != "Environ 9 minutes, jusqu'à ce qu'elles soient al dente." || cost != 0.00031 {
		t.Fatalf("answer %q, cost %v, %v", answer, cost, e)
	}
	// The reservation covers the call at the fast tier's prices, whatever the tokenizer does.
	if est := q.Estimate(); est < cost || est > 0.002 {
		t.Fatalf("estimate %v for a small question", est)
	}
}

func TestCookAnswerFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{{"provider error", `{"error":"busy"}`, 503}, {"no choices", `{"choices":[]}`, 200}, {"empty answer", `{"choices":[{"message":{"content":"  "}}],"usage":{"cost":0.0001}}`, 200}} {
		t.Run(tc.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
			defer s.Close()
			c := New()
			c.OpenRouterURL, c.OpenRouterKey = s.URL, "test-key"
			if answer, _, e := c.CookAnswer(context.Background(), CookQuestion{Recipe: "Soup", Question: "Is it done?", Language: "English"}); e == nil {
				t.Fatalf("expected an error, got %q", answer)
			}
		})
	}
}

func TestSpokenAnswersAreCutAtASentence(t *testing.T) {
	long := strings.Repeat("Stir it gently. ", 60)
	if got := spoken(long); len([]rune(got)) > 600 || !strings.HasSuffix(got, ".") {
		t.Fatalf("cut %q", got)
	}
	ja := strings.Repeat("弱火で煮ます。", 120)
	if got := spoken(ja); len([]rune(got)) > 600 || !strings.HasSuffix(got, "。") {
		t.Fatalf("cut %q", got)
	}
}
