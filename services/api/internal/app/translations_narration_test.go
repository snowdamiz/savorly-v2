package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"savorly/api/internal/narration"
)

func TestNarrationReadsTheTranslation(t *testing.T) {
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "5")
	t.Setenv("AI_DAILY_BUDGET_USD", "25")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "reader")
	frenchSoup(t, db, "cook", "soup", true)
	_, tf := translationServer(db, newTranslator(t))
	if status, _ := getTranslation(t, tf, "/v1/recipes/soup/translation?language=en", bearerFor(t, db, "reader")); status != 200 {
		t.Fatal(status)
	}
	var mu sync.Mutex
	var spoken []string
	voice := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Input string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		spoken = append(spoken, body.Input)
		mu.Unlock()
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("mp3:" + body.Input))
	}))
	defer voice.Close()
	a := &App{DB: db, Narrator: &narration.Client{Key: "test", Voice: "voice", URL: voice.URL}, Context: ctx}
	f := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	f.Use(func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return c.Next() })
	f.Post("/recipes/:id/steps/:step/narration", a.prepareNarration)
	f.Get("/recipes/:id/steps/:step/narration/:key", a.readNarration)
	send := func(method, path string, body any) (int, []byte) {
		t.Helper()
		var r io.Reader
		if body != nil {
			r = strings.NewReader(string(jsonBytes(body)))
		}
		req := httptest.NewRequest(method, path, r)
		req.Header.Set("Test-User", "reader")
		res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, b
	}
	prepare := func(step int, text, language string) (int, string) {
		t.Helper()
		status, b := send("POST", fmt.Sprintf("/recipes/soup/steps/%d/narration", step), map[string]string{"text": text, "language": language})
		var out struct{ Path string }
		_ = json.Unmarshal(b, &out)
		return status, out.Path
	}
	// The translated step, in the reader's language, is what's read aloud.
	status, path := prepare(1, "[English] Servez bien chaud.", "en")
	if status != 200 || !strings.HasSuffix(path, "?language=en") {
		t.Fatalf("prepare: %d %q", status, path)
	}
	if status, audio := send("GET", path, nil); status != 200 || string(audio) != "mp3:[English] Servez bien chaud." {
		t.Fatalf("translated narration: %d %q", status, audio)
	}
	// The original text sent as the translation, or a language nobody translated it into, is
	// refused, and the app reads the step with the device's voice.
	if status, _ = prepare(1, "Servez bien chaud.", "en"); status != 409 {
		t.Fatalf("original text read as the translation: %d", status)
	}
	if status, _ = prepare(1, "[German] Servez bien chaud.", "de"); status != 409 {
		t.Fatalf("an untranslated language: %d", status)
	}
	if status, _ = prepare(1, "Servez bien chaud.", "xx"); status != 400 {
		t.Fatalf("an unknown language: %d", status)
	}
	if status, _ = prepare(5, "Servez bien chaud.", "en"); status != 404 {
		t.Fatalf("a missing step: %d", status)
	}
	// Older apps send no language and hear the recipe as written; so does its own language.
	for _, language := range []string{"", "fr"} {
		status, path = prepare(0, "Faites fondre les oignons.", language)
		if status != 200 {
			t.Fatalf("original (%q): %d", language, status)
		}
		if status, audio := send("GET", path, nil); status != 200 || string(audio) != "mp3:Faites fondre les oignons." {
			t.Fatalf("original narration (%q): %d %q", language, status, audio)
		}
	}
	// Once the recipe changes, the narration of its old translation is no longer served.
	translated := "/recipes/soup/steps/1/narration/" + narrationKey("soup", 1, "[English] Servez bien chaud.", "voice") + "?language=en"
	if _, e := db.Exec(ctx, `UPDATE recipes SET title='Soupe gratinée' WHERE id='soup'`); e != nil {
		t.Fatal(e)
	}
	if status, _ := send("GET", translated, nil); status != 409 {
		t.Fatalf("narration of a stale translation: %d", status)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(spoken) != 2 {
		t.Fatalf("synthesized %q", spoken)
	}
}
