package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"savorly/api/internal/ai"
)

func TestTouchUpRetouchesOnlyTheMembersOwnPhotos(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "other")
	png := testPNG(t)
	// A stand-in for R2: the cook's upload can be read back, and the retouched photo is stored.
	stored := map[string][]byte{"/media/cook/before.png": png}
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			b, ok := stored[r.URL.Path]
			if !ok {
				w.WriteHeader(404)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			w.Write(b)
		case http.MethodPut:
			stored[r.URL.Path], _ = io.ReadAll(r.Body)
			w.Header().Set("ETag", `"test"`)
		}
	}))
	defer storage.Close()
	t.Setenv("S3_ENDPOINT", storage.URL)
	t.Setenv("S3_ACCESS_KEY_ID", "test-key")
	t.Setenv("S3_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("S3_BUCKET", "media")
	t.Setenv("S3_PUBLIC_URL", "https://media.example.com")
	// The image model gets the cook's own photo as its one reference.
	var sent string
	retouched := []byte("\xff\xd8\xff\xe0 retouched jpeg")
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Prompt     string `json:"prompt"`
			References []struct {
				ImageURL struct{ URL string } `json:"image_url"`
			} `json:"input_references"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if len(body.References) == 1 && strings.Contains(body.Prompt, "profile picture") {
			sent = body.References[0].ImageURL.URL
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(retouched), "media_type": "image/jpeg"}}})
	}))
	defer model.Close()
	a := &App{DB: db, AI: ai.New(), Media: NewMediaStore()}
	a.AI.OpenRouterURL, a.AI.OpenRouterKey = model.URL, "test-key"

	f := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	as := func(h fiber.Handler) fiber.Handler {
		return func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return h(c) }
	}
	f.Post("/touch-up", as(a.touchUp))
	f.Get("/jobs/:id", as(a.job))
	call := func(method, path, user, key string, body any) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(jsonBytes(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Test-User", user)
		req.Header.Set("Idempotency-Key", key)
		res, e := f.Test(req, fiber.TestConfig{Timeout: 10 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	mine := "https://media.example.com/cook/before.png"
	for name, body := range map[string]map[string]string{
		"someone else's upload": {"url": "https://media.example.com/other/before.png", "kind": "avatar"},
		"a photo from the web":  {"url": "https://example.com/face.jpg", "kind": "avatar"},
		"an unknown touch-up":   {"url": mine, "kind": "cartoon"},
	} {
		if status, out := call("POST", "/touch-up", "cook", "key-"+name, body); status != 400 {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	// The photo a member already uses counts as theirs wherever it lives, such as Google's.
	if _, e := db.Exec(ctx, `UPDATE users SET avatar='https://lh3.googleusercontent.com/a/me=s512-c' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	if status, out := call("POST", "/touch-up", "cook", "key-avatar", map[string]string{"url": "https://lh3.googleusercontent.com/a/me=s512-c", "kind": "avatar"}); status != 202 || out["source"] != "https://lh3.googleusercontent.com/a/me=s512-c" {
		t.Fatalf("current avatar: %d %v", status, out)
	}

	status, job := call("POST", "/touch-up", "cook", "key-upload", map[string]string{"url": mine, "kind": "avatar"})
	if status != 202 || job["kind"] != "image" || job["source"] != mine || job["status"] != "queued" {
		t.Fatalf("queue: %d %v", status, job)
	}
	id := job["id"].(string)
	if status, _ = call("GET", "/jobs/"+id, "other", "", nil); status != 404 {
		t.Fatalf("another member read the job: %d", status)
	}
	var prompt string
	if e := db.QueryRow(ctx, `SELECT prompt FROM ai_jobs WHERE id=$1`, id).Scan(&prompt); e != nil {
		t.Fatal(e)
	}
	a.processJob(ctx, id, "cook", "image", prompt, mine)
	status, job = call("GET", "/jobs/"+id, "cook", "", nil)
	result, _ := job["result"].(map[string]any)
	url, _ := result["url"].(string)
	if status != 200 || job["status"] != "completed" || !strings.HasPrefix(url, "https://media.example.com/cook/") || url == mine {
		t.Fatalf("result: %d %v", status, job)
	}
	if sent != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(png) {
		t.Fatalf("the model did not get the cook's photo: %.60s", sent)
	}
	if !bytes.Equal(stored["/media"+strings.TrimPrefix(url, "https://media.example.com")], retouched) {
		t.Fatal("the retouched photo was not stored")
	}
}
