package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

// translator is a stand-in for OpenRouter that "translates" a recipe by marking every field with
// the target language, after a pause long enough for concurrent readers to overlap. broken makes
// it answer with a recipe of the wrong shape.
type translator struct {
	calls  atomic.Int32
	broken atomic.Bool
	server *httptest.Server
}

func newTranslator(t *testing.T) *translator {
	t.Helper()
	tr := &translator{}
	tr.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tr.calls.Add(1)
		var body struct{ Messages []struct{ Content string } }
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil || len(body.Messages) != 2 {
			t.Errorf("translation request: %v", e)
			return
		}
		var input struct {
			Target string
			Recipe ai.RecipeText
		}
		if e := json.Unmarshal([]byte(body.Messages[1].Content), &input); e != nil {
			t.Error(e)
		}
		mark := "[" + input.Target + "] "
		out := input.Recipe
		out.Title, out.Description = mark+out.Title, mark+out.Description
		for i := range out.Ingredients {
			out.Ingredients[i].Name = mark + out.Ingredients[i].Name
		}
		for i := range out.Steps {
			out.Steps[i] = ai.StepText{Title: mark + out.Steps[i].Title, Text: mark + out.Steps[i].Text}
		}
		if tr.broken.Load() {
			out.Steps = out.Steps[:1]
		}
		time.Sleep(200 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(jsonBytes(out))}}}, "usage": map[string]float64{"cost": 0.004}})
	}))
	t.Cleanup(tr.server.Close)
	return tr
}

// translationServer is one API replica with the translation route and the real session lookup.
func translationServer(db *pgxpool.Pool, provider *translator) (*App, *fiber.App) {
	a := &App{DB: db, AI: ai.New(), Context: context.Background()}
	a.AI.OpenRouterURL, a.AI.OpenRouterKey = provider.server.URL, "test-only-never-sent"
	f := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	a.translationRoutes(f.Group("/v1"))
	return a, f
}

// frenchSoup is a published recipe written in French.
func frenchSoup(t *testing.T, db *pgxpool.Pool, owner, id string, published bool) {
	t.Helper()
	publishRecipe(t, db, owner, id, func(r *RecipeInput) {
		r.Title, r.Description, r.Language, r.Published = "Soupe à l’oignon", "Une soupe gratinée pour les soirs d’hiver.", "fr", published
		r.Ingredients = []Ingredient{{Name: "Oignons", Amount: 1, Unit: "kg"}, {Name: "Beurre", Amount: 50, Unit: "g"}}
		r.Steps = []Step{{Title: "Oignons", Text: "Faites fondre les oignons.", Seconds: 2400}, {Title: "Servir", Text: "Servez bien chaud."}}
	})
}

type translationBody struct {
	Language, SourceLanguage, Title, Description string
	Ingredients                                  []struct{ Name string }
	Steps                                        []struct{ Title, Text string }
	TranslatedAt                                 *time.Time
	Error                                        string
}

func getTranslation(t *testing.T, f *fiber.App, path, token string) (int, translationBody) {
	t.Helper()
	status, b := callAPI(t, f, "GET", path, token, nil)
	var out translationBody
	if e := json.Unmarshal(b, &out); e != nil {
		t.Fatalf("%s: %d %s", path, status, b)
	}
	return status, out
}

func usageRows(t *testing.T, db *pgxpool.Pool) (int, float64) {
	t.Helper()
	var n int
	var cost float64
	if e := db.QueryRow(context.Background(), `SELECT count(*),COALESCE(sum(estimated_cost),0)::float8 FROM ai_usage WHERE kind='translation' AND user_id IS NULL`).Scan(&n, &cost); e != nil {
		t.Fatal(e)
	}
	return n, cost
}

func TestRecipeTranslationsAreSharedAndFollowEdits(t *testing.T) {
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "5")
	t.Setenv("AI_DAILY_BUDGET_USD", "25")
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"cook", "reader", "other"} {
		testUser(t, db, id)
	}
	frenchSoup(t, db, "cook", "soup", true)
	frenchSoup(t, db, "cook", "draft", false)
	provider := newTranslator(t)
	_, f := translationServer(db, provider)
	reader, cook, other := bearerFor(t, db, "reader"), bearerFor(t, db, "cook"), bearerFor(t, db, "other")

	for _, bad := range []string{"", "?language=xx", "?language=tlh"} {
		if status, _ := getTranslation(t, f, "/v1/recipes/soup/translation"+bad, reader); status != 400 {
			t.Errorf("language %q: %d", bad, status)
		}
	}
	// A guest reads only translations members made.
	if status, out := getTranslation(t, f, "/v1/recipes/soup/translation?language=en", ""); status != 401 || out.Error != "Sign in to translate this recipe." {
		t.Fatalf("guest started a translation: %d %+v", status, out)
	}
	status, out := getTranslation(t, f, "/v1/recipes/soup/translation?language=en", reader)
	if status != 200 || out.Language != "en" || out.SourceLanguage != "fr" || out.Title != "[English] Soupe à l’oignon" || out.TranslatedAt == nil {
		t.Fatalf("translation: %d %+v", status, out)
	}
	if len(out.Ingredients) != 2 || out.Ingredients[1].Name != "[English] Beurre" || len(out.Steps) != 2 || out.Steps[1].Text != "[English] Servez bien chaud." {
		t.Fatalf("ingredients and steps out of order: %+v", out)
	}
	// Shared, and paid for by no member: the reservation is settled to the reported cost.
	if n, cost := usageRows(t, db); n != 1 || cost != 0.004 {
		t.Fatalf("usage: %d rows, $%v", n, cost)
	}
	if status, out = getTranslation(t, f, "/v1/recipes/soup/translation?language=en", ""); status != 200 || out.Title != "[English] Soupe à l’oignon" {
		t.Fatalf("guest reading the shared translation: %d %+v", status, out)
	}
	if provider.calls.Load() != 1 {
		t.Fatalf("translated %d times", provider.calls.Load())
	}
	// Written in the reader's language already: the recipe as it is, without the model.
	if status, out = getTranslation(t, f, "/v1/recipes/soup/translation?language=fr", reader); status != 200 || out.Title != "Soupe à l’oignon" || out.TranslatedAt != nil {
		t.Fatalf("same language: %d %+v", status, out)
	}
	// Someone else's draft is not there to translate; its cook's own is.
	if status, _ = getTranslation(t, f, "/v1/recipes/draft/translation?language=en", other); status != 404 {
		t.Fatalf("private recipe translated for another member: %d", status)
	}
	if status, _ = getTranslation(t, f, "/v1/recipes/draft/translation?language=en", ""); status != 404 {
		t.Fatalf("private recipe shown to a guest: %d", status)
	}
	if status, out = getTranslation(t, f, "/v1/recipes/draft/translation?language=en", cook); status != 200 || out.Title != "[English] Soupe à l’oignon" {
		t.Fatalf("own draft: %d %+v", status, out)
	}
	if status, _ = getTranslation(t, f, "/v1/recipes/missing/translation?language=en", reader); status != 404 {
		t.Fatalf("missing recipe: %d", status)
	}

	// Readers asking at once, on one replica or two, share one translation.
	_, replica := translationServer(db, provider)
	before := provider.calls.Load()
	var wg sync.WaitGroup
	for i := range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			server := f
			if i%2 == 1 {
				server = replica
			}
			if status, out := getTranslation(t, server, "/v1/recipes/soup/translation?language=de", reader); status != 200 || out.Title != "[German] Soupe à l’oignon" {
				t.Errorf("concurrent reader: %d %+v", status, out)
			}
		}()
	}
	wg.Wait()
	if n := provider.calls.Load() - before; n != 1 {
		t.Fatalf("concurrent readers paid for %d translations", n)
	}

	// An edited recipe is translated again; the old translation is replaced, never shown for it.
	if _, e := db.Exec(ctx, `UPDATE recipes SET title='Soupe à l’oignon gratinée' WHERE id='soup'`); e != nil {
		t.Fatal(e)
	}
	before = provider.calls.Load()
	if status, out = getTranslation(t, f, "/v1/recipes/soup/translation?language=en", ""); status != 401 {
		t.Fatalf("a guest was shown a translation of the earlier text: %d %+v", status, out)
	}
	if status, out = getTranslation(t, f, "/v1/recipes/soup/translation?language=en", reader); status != 200 || out.Title != "[English] Soupe à l’oignon gratinée" {
		t.Fatalf("after the edit: %d %+v", status, out)
	}
	var kept int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM recipe_translations WHERE recipe_id='soup' AND language='en'`).Scan(&kept); e != nil || kept != 1 {
		t.Fatalf("translations kept: %d %v", kept, e)
	}
	if provider.calls.Load()-before != 1 {
		t.Fatal("the edited recipe wasn't translated once")
	}
	// A cook who is suspended takes their recipes, translations included, out of view.
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	if status, _ = getTranslation(t, f, "/v1/recipes/soup/translation?language=en", reader); status != 404 {
		t.Fatalf("suspended cook's recipe: %d", status)
	}
	// Deleting the recipe deletes its translations.
	if _, e := db.Exec(ctx, `DELETE FROM recipes WHERE id='soup'`); e != nil {
		t.Fatal(e)
	}
	if e := db.QueryRow(ctx, `SELECT count(*) FROM recipe_translations WHERE recipe_id='soup'`).Scan(&kept); e != nil || kept != 0 {
		t.Fatalf("translations outlived their recipe: %d %v", kept, e)
	}
}

func TestRecipeTranslationSpendingLimits(t *testing.T) {
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "5")
	t.Setenv("AI_DAILY_BUDGET_USD", "25")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "reader")
	frenchSoup(t, db, "cook", "soup", true)
	provider := newTranslator(t)
	a, f := translationServer(db, provider)
	reader := bearerFor(t, db, "reader")
	path := "/v1/recipes/soup/translation?language="
	refused := func(language string, status int, message string) {
		t.Helper()
		got, out := getTranslation(t, f, path+language, reader)
		if got != status || out.Error != message {
			t.Fatalf("%s: want %d %q, got %d %+v", language, status, message, got, out)
		}
	}

	// Paused from the admin console: nothing is reserved or asked.
	if _, e := db.Exec(ctx, `INSERT INTO app_settings(key,value) VALUES('operator','{"aiPaused":true}')`); e != nil {
		t.Fatal(e)
	}
	refused("en", 503, aiPausedMessage)
	if _, e := db.Exec(ctx, `DELETE FROM app_settings`); e != nil {
		t.Fatal(e)
	}
	// The shared free budget is spent.
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "0.001")
	refused("de", 429, "Free AI use is at capacity today. Try again tomorrow.")
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "5")
	if n, _ := usageRows(t, db); n != 0 || provider.calls.Load() != 0 {
		t.Fatalf("refusals spent: %d rows, %d calls", n, provider.calls.Load())
	}

	// A translation of the wrong shape is refused; what it cost stays counted, and asking again at
	// once doesn't pay for another.
	provider.broken.Store(true)
	refused("es", 502, "We couldn’t translate this recipe. Please try again.")
	refused("es", 502, "We couldn’t translate this recipe. Please try again.")
	if n, cost := usageRows(t, db); n != 1 || cost != 0.004 || provider.calls.Load() != 1 {
		t.Fatalf("failed translation: %d rows, $%v, %d calls", n, cost, provider.calls.Load())
	}
	var stored int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM recipe_translations`).Scan(&stored); e != nil || stored != 0 {
		t.Fatalf("a malformed translation was kept: %d %v", stored, e)
	}
	provider.broken.Store(false)

	// A call that never reached the provider costs nothing.
	a.AI.OpenRouterURL = "http://bad host"
	refused("it", 502, "We couldn’t translate this recipe. Please try again.")
	if n, _ := usageRows(t, db); n != 1 {
		t.Fatalf("an unsent call kept its reservation: %d rows", n)
	}
	a.AI.OpenRouterURL = provider.server.URL

	// Each member starts a limited number an hour.
	for range translationsPerHour {
		a.translations.members.hit("reader", translationsPerHour, time.Hour)
	}
	refused("ja", 429, "You’ve translated a lot of recipes in the last hour. Please try again later.")

	// Without an OpenRouter key nothing new is translated.
	a.AI.OpenRouterKey = ""
	refused("ru", 503, "Recipe translation isn’t set up on this server.")
}

func TestTranslationFlightsShareOneRun(t *testing.T) {
	var w translationWork
	release := make(chan struct{})
	var runs atomic.Int32
	run := func(ctx context.Context) (translationReply, error) {
		runs.Add(1)
		<-release
		return translationReply{Language: "en", RecipeText: ai.RecipeText{Title: "Soup"}}, nil
	}
	ctx := context.Background()
	results := make(chan translationReply, 3)
	for range 3 {
		go func() {
			reply, _ := w.join(ctx, ctx, "soup", run)
			results <- reply
		}()
	}
	// A reader who gives up leaves the others waiting on the same run.
	gone, cancel := context.WithCancel(ctx)
	cancel()
	if _, e := w.join(gone, ctx, "soup", run); e == nil {
		t.Fatal("a cancelled reader kept waiting")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		w.mu.Lock()
		f := w.flights["soup"]
		w.mu.Unlock()
		if f != nil && runs.Load() == 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Others start no more than activeTranslations at once.
	blocked := make(chan struct{})
	defer close(blocked)
	for i := range activeTranslations - 1 {
		go func() {
			_, _ = w.join(ctx, ctx, "busy"+string(rune('a'+i)), func(context.Context) (translationReply, error) { <-blocked; return translationReply{}, nil })
		}()
	}
	for start := time.Now(); time.Since(start) < 2*time.Second; time.Sleep(10 * time.Millisecond) {
		w.mu.Lock()
		full := w.active == activeTranslations
		w.mu.Unlock()
		if full {
			break
		}
	}
	if _, e := w.join(ctx, ctx, "another", run); e == nil || !strings.Contains(e.Error(), "busy") {
		t.Fatalf("a translation past the limit started: %v", e)
	}
	close(release)
	for range 3 {
		if reply := <-results; reply.Title != "Soup" {
			t.Fatalf("reply %+v", reply)
		}
	}
	if runs.Load() != 1 {
		t.Fatalf("%d runs for one translation", runs.Load())
	}
}

func TestAlwaysTranslatePreference(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	tok := bearerFor(t, db, "cook")
	translate := func(method string, body any, want int) any {
		t.Helper()
		status, b := callAPI(t, f, method, map[string]string{"GET": "/v1/me", "PATCH": "/v1/me/preferences"}[method], tok, body)
		var out struct{ Preferences map[string]any }
		if status != want || json.Unmarshal(b, &out) != nil {
			t.Fatalf("%s %v: want %d, got %d: %s", method, body, want, status, b)
		}
		return out.Preferences["translateRecipes"]
	}
	if on := translate("GET", nil, 200); on != false {
		t.Fatalf("default: %v", on)
	}
	if on := translate("PATCH", map[string]any{"translateRecipes": true}, 200); on != true {
		t.Fatalf("turned on: %v", on)
	}
	// Other preferences leave it as it is.
	if on := translate("PATCH", map[string]any{"units": "metric"}, 200); on != true {
		t.Fatalf("after units: %v", on)
	}
	for _, bad := range []any{"yes", nil, 1} {
		if status, b := callAPI(t, f, "PATCH", "/v1/me/preferences", tok, map[string]any{"translateRecipes": bad}); status != 400 {
			t.Errorf("%v: %d %s", bad, status, b)
		}
	}
	if on := translate("PATCH", map[string]any{"translateRecipes": false}, 200); on != false {
		t.Fatalf("turned off: %v", on)
	}
}

func TestCapabilitiesReportRecipeTranslation(t *testing.T) {
	for _, key := range []string{"", "test-router-secret"} {
		t.Setenv("OPENROUTER_API_KEY", key)
		t.Setenv("OPENROUTER_TRANSLATION_MODEL", "configured/translator")
		res, e := New(nil, Config{Origins: []string{"http://localhost:8081"}}).Test(httptest.NewRequest("GET", "/v1/capabilities", nil))
		if e != nil {
			t.Fatal(e)
		}
		var body map[string]any
		e = json.NewDecoder(res.Body).Decode(&body)
		res.Body.Close()
		if e != nil || body["recipeTranslation"] != (key != "") || body["translationModel"] != "configured/translator" {
			t.Fatalf("key %q: %v %v", key, body["recipeTranslation"], body["translationModel"])
		}
	}
}

func TestJanitorPurgesUnreadTranslations(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	frenchSoup(t, db, "cook", "soup", true)
	if _, e := db.Exec(ctx, `INSERT INTO recipe_translations(recipe_id,language,source_hash,content,last_used_at) VALUES
 ('soup','en','a','{}',now()-interval '91 days'),('soup','de','b','{}',now()-interval '89 days')`); e != nil {
		t.Fatal(e)
	}
	counts, e := runJanitor(ctx, db)
	if e != nil || counts["recipe_translations"] != 1 {
		t.Fatalf("purged %v %v", counts, e)
	}
	var left string
	if e = db.QueryRow(ctx, `SELECT string_agg(language,',') FROM recipe_translations`).Scan(&left); e != nil || left != "de" {
		t.Fatalf("left %q %v", left, e)
	}
}
