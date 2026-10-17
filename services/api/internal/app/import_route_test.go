package app

import (
	"bytes"
	"context"
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

const soupPage = `<html><body><nav>Home</nav><article><h1>Grandma's leek soup</h1><h2>Ingredients</h2><ul><li>2 leeks</li><li>1 litre stock</li></ul>
<p>Slice the leeks and soften them in butter for ten minutes, then pour in the stock.</p>
<p>Simmer for twenty minutes and blend until smooth. Season to taste and serve with bread.</p></article></body></html>`

// importing posts a link to POST /v1/recipes/import as token, with an Idempotency-Key if given.
func importing(t *testing.T, f *fiber.App, token, link, key string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/recipes/import", bytes.NewReader(jsonBytes(fiber.Map{"url": link})))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	_ = json.Unmarshal(b, &out)
	return res.StatusCode, out
}

func TestImportRecipeFromALink(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "hasty")
	site := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/go":
			http.Redirect(w, r, "/lemon-pasta?utm_source=newsletter#print", http.StatusMovedPermanently)
		case "/lemon-pasta":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(recipePage(fullRecipeLD))
		case "/soup":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(soupPage))
		case "/tiny":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte("<p>Coming soon.</p>"))
		case "/photo.jpg":
			w.Header().Set("Content-Type", "image/jpeg")
			w.Write([]byte("\xff\xd8\xff\xe0"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer site.Close()
	old := pageClient
	pageClient = site.Client()
	t.Cleanup(func() { pageClient = old })
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")

	// Recipe data on the page comes back as a private draft crediting the page it ended at.
	status, out := importing(t, f, cook, site.URL+"/go", "")
	recipe, _ := out["recipe"].(map[string]any)
	if status != 200 || out["method"] != "structured" || recipe["title"] != "Lemon & ricotta pasta" || recipe["sourceUrl"] != site.URL+"/lemon-pasta" ||
		recipe["published"] != false || recipe["aiGenerated"] != false || len(recipe["steps"].([]any)) != 3 || len(recipe["ingredients"].([]any)) != 5 {
		t.Fatalf("structured import: %d %v", status, out)
	}
	// Nothing is saved until the editor saves it, as it came.
	if n := count(t, db, `SELECT count(*) FROM recipes`); n != 0 {
		t.Fatalf("the import saved %d recipes", n)
	}
	saved := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recipes", cook, recipe))
	if saved["sourceUrl"] != site.URL+"/lemon-pasta" || saved["published"] != false {
		t.Fatalf("saved import: %v", saved)
	}

	for link, want := range map[string]int{
		"": 400, "ftp://cook.example/soup": 400, "javascript:alert(1)": 400, "https://user:pw@cook.example/": 400,
		site.URL + "/tiny":      422, // no recipe and too little text to look for one
		site.URL + "/photo.jpg": 422,
		site.URL + "/missing":   502,
		site.URL + "/soup":      503, // no recipe data, and text AI is off
	} {
		if status, out := importing(t, f, cook, link, ""); status != want {
			t.Errorf("%q: %d, want %d (%v)", link, status, want, out)
		}
	}
	if _, out := importing(t, f, cook, site.URL+"/soup", ""); out["error"] != "We couldn’t read a recipe from that page." {
		t.Errorf("503 message: %v", out)
	}
	if _, out := importing(t, f, cook, site.URL+"/tiny", ""); out["error"] != noRecipeOnPage {
		t.Errorf("422 message: %v", out)
	}
	if _, out := importing(t, f, cook, site.URL+"/missing", ""); out["error"] != "We couldn’t open that page." {
		t.Errorf("502 message: %v", out)
	}

	// With text AI on, a page without recipe data becomes an ordinary recipe job.
	t.Setenv("OPENROUTER_API_KEY", "test-only-never-sent")
	f = recipesApp(db, false)
	status, out = importing(t, f, cook, site.URL+"/soup", "import-key-1")
	job, _ := out["job"].(map[string]any)
	prompt, _ := job["prompt"].(string)
	if status != 202 || out["method"] != "ai" || job["kind"] != "recipe" || job["status"] != "queued" || job["source"] != "" ||
		!strings.HasPrefix(prompt, importPrefix+site.URL+"/soup\n\nContext: ") || !strings.Contains(prompt, "Slice the leeks") || strings.Contains(prompt, "Home") {
		t.Fatalf("AI import: %d %v", status, out)
	}
	if status, again := importing(t, f, cook, site.URL+"/soup", "import-key-1"); status != 202 || again["job"].(map[string]any)["id"] != job["id"] {
		t.Fatalf("the same key queued another job: %d %v", status, again)
	}
	status, other := importing(t, f, cook, site.URL+"/soup", "")
	second, _ := other["job"].(map[string]any)
	if status != 202 || second["id"] == job["id"] {
		t.Fatalf("a request without a key: %d %v", status, other)
	}

	// The worker's result credits the page and is marked as AI-made, whatever the model says.
	reply := ""
	var asked string
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct{ Role, Content string }
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		asked = body.Messages[len(body.Messages)-1].Content
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": reply}}}})
	}))
	defer model.Close()
	worker := &App{DB: db, AI: ai.New()}
	worker.AI.OpenRouterURL, worker.AI.OpenRouterKey = model.URL, "test-key"
	modelRecipe := func(extra map[string]any) string {
		var r map[string]any
		_ = json.Unmarshal(jsonBytes(validRecipe()), &r)
		for k, v := range extra {
			r[k] = v
		}
		return string(jsonBytes(map[string]any{"recipe": r}))
	}
	result := func(id string) map[string]any {
		t.Helper()
		return jsonObject(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs/"+id, cook, nil))
	}
	reply = modelRecipe(map[string]any{"sourceUrl": "https://elsewhere.example/", "derivedFrom": "some-recipe", "aiGenerated": false, "published": true})
	worker.processJob(ctx, job["id"].(string), "cook", "recipe", prompt, "")
	done := result(job["id"].(string))
	drafted, _ := done["result"].(map[string]any)["recipe"].(map[string]any)
	if done["status"] != "completed" || drafted["sourceUrl"] != site.URL+"/soup" || drafted["aiGenerated"] != true || drafted["published"] != false || drafted["derivedFrom"] != nil || asked != prompt {
		t.Fatalf("finished import: %v", done)
	}
	// A page the model finds no recipe on says so.
	reply = `{"recipe": null}`
	worker.processJob(ctx, second["id"].(string), "cook", "recipe", second["prompt"].(string), "")
	if failed := result(second["id"].(string)); failed["status"] != "failed" || failed["error"] != noRecipeOnPage {
		t.Fatalf("no recipe on the page: %v", failed)
	}
	// Other recipe jobs never carry a source, and fail as before.
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key) VALUES('plain','cook','recipe','A quick leek soup, please','plain-key'),('broken','cook','recipe','Another soup','broken-key')`); e != nil {
		t.Fatal(e)
	}
	reply = modelRecipe(map[string]any{"sourceUrl": "https://elsewhere.example/"})
	worker.processJob(ctx, "plain", "cook", "recipe", "A quick leek soup, please", "")
	if r := result("plain")["result"].(map[string]any)["recipe"].(map[string]any); r["sourceUrl"] != nil {
		t.Fatalf("a recipe job took the model's source: %v", r)
	}
	reply = `{"recipe": null}`
	worker.processJob(ctx, "broken", "cook", "recipe", "Another soup", "")
	if failed := result("broken"); failed["error"] == noRecipeOnPage {
		t.Fatalf("an ordinary job failed as an import: %v", failed)
	}

	// 20 imports an hour.
	hasty := bearerFor(t, db, "hasty")
	for range 20 {
		if status, _ := importing(t, f, hasty, "not a link", ""); status != 400 {
			t.Fatalf("import: %d", status)
		}
	}
	if status, _ := importing(t, f, hasty, "not a link", ""); status != 429 {
		t.Fatalf("21st import: %d", status)
	}
}
