package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"savorly/api/internal/narration"
)

func TestNarrationCacheKeyAndRanges(t *testing.T) {
	key := narrationKey("recipe", 0, "Stir.", "voice")
	for _, changed := range []string{narrationKey("recipe", 0, "Stir again.", "voice"), narrationKey("recipe", 0, "Stir.", "other"), narrationKey("other", 0, "Stir.", "voice"), narrationKey("recipe", 1, "Stir.", "voice")} {
		if key == changed {
			t.Fatal("stale/private audio cache collision")
		}
	}
	f := fiber.New()
	f.Get("/audio", func(c fiber.Ctx) error { return sendNarration(c, []byte("0123456789")) })
	for _, tc := range []struct {
		header string
		status int
		body   string
	}{{"", 200, "0123456789"}, {"bytes=0-1", 206, "01"}, {"bytes=5-", 206, "56789"}, {"bytes=-3", 206, "789"}, {"bytes=99-", 416, ""}} {
		req := httptest.NewRequest("GET", "/audio", nil)
		if tc.header != "" {
			req.Header.Set("Range", tc.header)
		}
		res, err := f.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != tc.status || (tc.status != 416 && string(data) != tc.body) {
			t.Fatalf("range %s: %d %q", tc.header, res.StatusCode, data)
		}
	}
}

func TestNarrationAccessCachingConcurrencyAndBudget(t *testing.T) {
	db := isolatedDB(t)
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	testUser(t, db, "owner")
	testUser(t, db, "other")
	_, err := db.Exec(context.Background(), `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published) VALUES('recipe','owner','Toast','Toast','Italian',5,1,'Easy','[]','[{"text":"Stir."},{"text":"Serve."}]',false)`)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer test" {
			t.Error("incorrect OpenRouter speech request")
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("fake-mp3"))
	}))
	defer provider.Close()
	client := &narration.Client{Key: "test", Voice: "voice", URL: provider.URL}
	newServer := func() *fiber.App {
		a := &App{DB: db, Narrator: client, Context: context.Background()}
		f := fiber.New()
		f.Use(func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return c.Next() })
		f.Post("/recipes/:id/steps/:step/narration", a.prepareNarration)
		f.Get("/recipes/:id/steps/:step/narration/:key", a.readNarration)
		return f
	}
	servers := []*fiber.App{newServer(), newServer()}
	request := func(f *fiber.App, method, path, user, text string) (int, []byte) {
		body, _ := json.Marshal(map[string]string{"text": text})
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Test-User", user)
		res, e := f.Test(r, fiber.TestConfig{Timeout: 30 * time.Second})
		if e != nil {
			t.Error(e)
			return 0, nil
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, b
	}
	path := "/recipes/recipe/steps/0/narration"
	if code, _ := request(servers[0], "POST", path, "other", "Stir."); code != 404 {
		t.Fatalf("private recipe leaked: %d", code)
	}
	if code, _ := request(servers[0], "POST", path, "owner", "Different text"); code != 409 {
		t.Fatalf("arbitrary text accepted: %d", code)
	}
	var wg sync.WaitGroup
	for i := range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, _ := request(servers[i%2], "POST", path, "owner", "Stir."); code != 200 {
				t.Errorf("prepare %d", code)
			}
		}()
	}
	wg.Wait()
	audioPath := path + "/" + narrationKey("recipe", 0, "Stir.", "voice")
	if code, b := request(servers[0], "GET", audioPath, "owner", ""); code != 200 || string(b) != "fake-mp3" {
		t.Fatalf("audio %d %q", code, b)
	}
	if code, _ := request(servers[1], "GET", audioPath, "other", ""); code != 404 {
		t.Fatalf("private audio leaked: %d", code)
	}
	// A fresh replica reuses the durable cache without calling OpenRouter.
	fresh := newServer()
	if code, _ := request(fresh, "POST", path, "owner", "Stir."); code != 200 {
		t.Fatal(code)
	}
	if code, b := request(fresh, "GET", audioPath, "owner", ""); code != 200 || string(b) != "fake-mp3" {
		t.Fatalf("cached audio %d %q", code, b)
	}
	if calls.Load() != 1 {
		t.Fatalf("charged %d times", calls.Load())
	}
	var reserved int
	if err = db.QueryRow(context.Background(), `SELECT count(*) FROM narration_usage`).Scan(&reserved); err != nil || reserved != 1 {
		t.Fatalf("reservations %d %v", reserved, err)
	}
	t.Setenv("AI_DAILY_BUDGET_USD", "0")
	if code, _ := request(fresh, "POST", "/recipes/recipe/steps/1/narration", "owner", "Serve."); code != 200 {
		t.Fatal(code)
	}
	if code, _ := request(fresh, "GET", "/recipes/recipe/steps/1/narration/"+narrationKey("recipe", 1, "Serve.", "voice"), "owner", ""); code != 502 {
		t.Fatalf("budget not enforced: %d", code)
	}
	if calls.Load() != 1 {
		t.Fatal("budget bypass called provider")
	}
	_, _ = db.Exec(context.Background(), `UPDATE recipes SET steps='[{"text":"Changed."}]' WHERE id='recipe'`)
	if code, _ := request(fresh, "GET", audioPath, "owner", ""); code != 404 {
		t.Fatalf("stale audio served: %d", code)
	}
}

func TestNarrationDisabledWithoutKey(t *testing.T) {
	a := &App{Narrator: &narration.Client{}}
	f := fiber.New()
	f.Post("/", a.prepareNarration)
	res, err := f.Test(httptest.NewRequest("POST", "/", strings.NewReader(`{}`)))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 503 {
		t.Fatal(res.StatusCode)
	}
}

func TestNarrationHTTPStreamsBeforeGenerationFinishes(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "stream-owner")
	_, err := db.Exec(context.Background(), `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published) VALUES('stream-recipe','stream-owner','Toast','Toast','Italian',5,1,'Easy','[]','[{"text":"Stir."}]',true)`)
	if err != nil {
		t.Fatal(err)
	}
	for _, header := range []string{"", "bytes=0-"} {
		t.Run(header, func(t *testing.T) {
			a := &App{DB: db, Narrator: &narration.Client{Voice: "voice"}}
			key := narrationKey("stream-recipe", 0, "Stir.", "voice")
			finish := make(chan struct{})
			var once sync.Once
			defer once.Do(func() { close(finish) })
			if err := a.NarrationStreams.Start(context.Background(), key, func(ctx context.Context, s *narration.Stream) error {
				_, _ = s.Write([]byte("first"))
				select {
				case <-finish:
				case <-ctx.Done():
					return ctx.Err()
				}
				_, err := s.Write([]byte("last"))
				return err
			}); err != nil {
				t.Fatal(err)
			}
			f := fiber.New()
			f.Get("/recipes/:id/steps/:step/narration/:key", a.readNarration)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go func() { _ = f.Listener(listener, fiber.ListenConfig{DisableStartupMessage: true}) }()
			client := &http.Client{Timeout: 2 * time.Second}
			defer client.CloseIdleConnections()
			req, _ := http.NewRequest("GET", "http://"+listener.Addr().String()+"/recipes/stream-recipe/steps/0/narration/"+key, nil)
			if header != "" {
				req.Header.Set("Range", header)
			}
			response, err := client.Do(req)
			if err != nil {
				t.Fatalf("response waited for complete generation: %v", err)
			}
			defer response.Body.Close()
			first := make([]byte, 5)
			if _, err = io.ReadFull(response.Body, first); err != nil || string(first) != "first" {
				t.Fatalf("first chunk not streamed: %s %v", first, err)
			}
			once.Do(func() { close(finish) })
			rest, err := io.ReadAll(response.Body)
			if err != nil || string(rest) != "last" {
				t.Fatalf("stream tail: %s %v", rest, err)
			}
		})
	}
}
