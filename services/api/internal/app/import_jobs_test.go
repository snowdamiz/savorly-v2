package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"savorly/api/internal/ai"
)

// recipeModel stands in for the recipe model, answering every request with reply() and
// recording the last prompt it was asked.
func recipeModel(t *testing.T, reply func() string) (worker func(*App) *App, asked func() string) {
	t.Helper()
	var mu sync.Mutex
	last := ""
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct{ Role, Content string }
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		last = body.Messages[len(body.Messages)-1].Content
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": reply()}}}})
	}))
	t.Cleanup(model.Close)
	return func(a *App) *App {
			a.AI = ai.New()
			a.AI.OpenRouterURL, a.AI.OpenRouterKey = model.URL, "test-key"
			return a
		}, func() string {
			mu.Lock()
			defer mu.Unlock()
			return last
		}
}

func TestImportingAVideoCaption(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "test-only-never-sent")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	socialWeb(t, postPages)
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")

	// A short link to a TikTok whose caption holds a recipe queues an ordinary recipe job.
	status, out := importing(t, f, cook, "https://vm.tiktok.com/ZMabc123/", "video-key-1")
	job, _ := out["job"].(map[string]any)
	prompt, _ := job["prompt"].(string)
	canonical := "https://www.tiktok.com/@chefjo/video/7300000000000000001"
	if status != 202 || out["method"] != "ai" || job["kind"] != "recipe" || job["source"] != "" ||
		!strings.HasPrefix(prompt, captionPrefix+canonical+"\n"+creditPrefix+"Chef Jo (@chefjo) on TikTok\n\nContext: ") || !strings.HasSuffix(prompt, tiktokCaption) {
		t.Fatalf("caption import: %d %v", status, out)
	}
	for link, want := range map[string]struct {
		status  int
		message string
	}{
		"https://www.tiktok.com/@chefjo/video/7300000000000000002": {422, captionNoRecipe},
		"https://www.instagram.com/p/PrivatePost1/":                {502, postUnavailable},
		"https://fb.watch/": {502, "We couldn’t open that page."}, // not a post: an ordinary page
	} {
		if status, out := importing(t, f, cook, link, ""); status != want.status || out["error"] != want.message {
			t.Errorf("%s: %d %v, want %d %q", link, status, out, want.status, want.message)
		}
	}
	// A caption linking to a recipe page brings in that page's recipe data, crediting both.
	status, out = importing(t, f, cook, "https://www.tiktok.com/@chefjo/video/7300000000000000003", "")
	if recipe, _ := out["recipe"].(map[string]any); status != 200 || out["method"] != "structured" || recipe["sourceUrl"] != "https://cook.example/lemon-pasta" ||
		!strings.HasSuffix(recipe["description"].(string), "Shared by Chef Jo (@chefjo) on TikTok.") {
		t.Fatalf("linked recipe: %d %v", status, out)
	}

	// The finished draft credits the post and its creator, keeps none of the post's media, and
	// is marked as AI-made.
	var reply string
	worker, asked := recipeModel(t, func() string { return reply })
	r := validRecipe()
	r.Description = "Creamy lemon pasta in 15 minutes. The butter amount was estimated."
	r.Image, r.Video, r.Photos = "https://p16-sign.tiktokcdn-us.com/cover.jpeg", "https://v16-webapp.tiktok.com/video.mp4", []string{"https://p16-sign.tiktokcdn-us.com/2.jpeg"}
	r.Steps[0].Image = "https://p16-sign.tiktokcdn-us.com/step.jpeg"
	reply = string(jsonBytes(map[string]any{"recipe": r}))
	worker(&App{DB: db}).processJob(ctx, job["id"].(string), "cook", "recipe", prompt, "")
	done := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs/"+job["id"].(string), cook, nil))
	drafted, _ := done["result"].(map[string]any)["recipe"].(map[string]any)
	if done["status"] != "completed" || asked() != prompt || drafted["sourceUrl"] != canonical || drafted["aiGenerated"] != true || drafted["published"] != false ||
		drafted["image"] != "" || drafted["video"] != "" || len(drafted["photos"].([]any)) != 0 || drafted["steps"].([]any)[0].(map[string]any)["image"] != nil ||
		drafted["description"] != "Creamy lemon pasta in 15 minutes. The butter amount was estimated. From Chef Jo (@chefjo) on TikTok." {
		t.Fatalf("finished caption import: %v", done)
	}
}

// A failed import never counts against the member: not in their plan's allowance, nor in their
// 30-day spend. What the model may have cost still counts in the day's shared budgets.
func TestFailedImportsDontCountAgainstTheMember(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "test-only-never-sent")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	socialWeb(t, postPages)
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	queue := func(link, key string) (id, prompt string) {
		t.Helper()
		status, out := importing(t, f, cook, link, key)
		job, _ := out["job"].(map[string]any)
		if status != 202 {
			t.Fatalf("%s: %d %v", link, status, out)
		}
		return job["id"].(string), job["prompt"].(string)
	}
	page, pagePrompt := queue("https://cook.example/soup", "unread-page")
	caption, captionPrompt := queue("https://vm.tiktok.com/ZMabc123/", "unread-caption")
	kept, keptPrompt := queue("https://cook.example/soup", "read-page")
	unsent, unsentPrompt := queue("https://cook.example/soup", "never-sent")
	cancelled, cancelledPrompt := queue("https://cook.example/soup", "cancelled")
	if u, e := usageOf(ctx, db, "cook"); e != nil || u.Assistant != 5 {
		t.Fatalf("queued imports hold their reservations: %+v %v", u, e)
	}

	reply := `{"recipe": null}`
	worker, _ := recipeModel(t, func() string { return reply })
	a := worker(&App{DB: db})
	a.processJob(ctx, page, "cook", "recipe", pagePrompt, "")
	a.processJob(ctx, caption, "cook", "recipe", captionPrompt, "")
	reply = string(jsonBytes(map[string]any{"recipe": validRecipe()}))
	a.processJob(ctx, kept, "cook", "recipe", keptPrompt, "")
	// A worker without a model never sends the job anywhere.
	unconnected := &App{DB: db, AI: ai.New()}
	unconnected.AI.OpenRouterKey = ""
	unconnected.processJob(ctx, unsent, "cook", "recipe", unsentPrompt, "")
	// An admin's cancellation of a running job stands, whatever the worker meant to record.
	stopped := "Cancelled by an admin. The provider may still finish and bill this task."
	if _, e := db.Exec(ctx, `UPDATE ai_jobs SET status='failed',error=$2 WHERE id=$1`, cancelled, stopped); e != nil {
		t.Fatal(e)
	}
	reply = `{"recipe": null}`
	a.processJob(ctx, cancelled, "cook", "recipe", cancelledPrompt, "")

	for id, want := range map[string]struct {
		status, message string
		cost            float64
	}{
		page:      {"failed", noRecipeOnPage, 0},
		caption:   {"failed", captionNoRecipe, 0},
		kept:      {"completed", "", ai.GenerationEstimate("recipe")},
		unsent:    {"failed", "The generation did not complete. Check your provider connection or balance, then try again.", 0},
		cancelled: {"failed", stopped, ai.GenerationEstimate("recipe")},
	} {
		var status, message string
		var cost float64
		if e := db.QueryRow(ctx, `SELECT status,error,estimated_cost::float8 FROM ai_jobs WHERE id=$1`, id).Scan(&status, &message, &cost); e != nil || status != want.status || message != want.message || cost != want.cost {
			t.Errorf("job %s: %s %q %v (%v), want %+v", id, status, message, cost, e, want)
		}
	}
	// Only the import that brought a recipe counts, as a sous-chef message and as spend, besides
	// the one the admin left as it was.
	u, e := usageOf(ctx, db, "cook")
	var mine, total float64
	if e == nil {
		e = db.QueryRow(ctx, budgetSumsSQL, []string{"cook"}).Scan(&mine, new(float64), &total)
	}
	estimate := ai.GenerationEstimate("recipe")
	if e != nil || u.Assistant != 2 || u.Spend != 2*estimate || mine != 2*estimate {
		t.Fatalf("the member's use: %+v, spend %v (%v)", u, mine, e)
	}
	// The two the model read moved to the shared ledger; the unsent one cost nothing. The
	// day's budgets see the read ones, the kept one and the cancelled one.
	var shared int
	var sharedCost float64
	if e := db.QueryRow(ctx, `SELECT count(*),COALESCE(sum(estimated_cost),0)::float8 FROM ai_usage WHERE user_id IS NULL AND kind='unread_import'`).Scan(&shared, &sharedCost); e != nil || shared != 2 || sharedCost != 2*estimate {
		t.Fatalf("shared ledger: %d rows, %v (%v)", shared, sharedCost, e)
	}
	if total != 4*estimate {
		t.Fatalf("the day's spend: %v, want %v", total, 4*estimate)
	}
}

// The sous-chef reads a video the member shares as a short link, and its draft credits the
// post: a youtu.be link counts as sharing youtube.com.
func TestTheSousChefImportsAVideoTheUserShared(t *testing.T) {
	socialWeb(t, postPages)
	a, p := studioFixture(t)
	ctx := context.Background()
	link := "https://youtu.be/dQw4w9WgXcQ?si=abc"
	var imported, draft map[string]any
	_ = json.Unmarshal(jsonBytes(validRecipe()), &draft)
	studioAgent(t, a, func(r agentRound) any {
		switch {
		case !r.answered():
			return orderedCalls("import_recipe", map[string]any{"url": link})
		case imported == nil:
			_ = json.Unmarshal([]byte(strings.TrimSpace(r.results())), &imported)
			return orderedCalls("save_recipe_draft", map[string]any{"recipe": draft, "new_recipe": true, "source_url": imported["sourceUrl"]})
		}
		return map[string]any{"content": "Saved it as a draft."}
	})
	studioTurn(t, ctx, a, p, "Save this one for me: "+link)
	caption, _ := imported["caption"].(string)
	note, _ := imported["note"].(string)
	if imported["sourceUrl"] != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" || imported["creator"] != "Chef Jo (@chefjo) on YouTube" ||
		imported["postTitle"] != "Lemon pasta | 15 minutes" || !strings.Contains(caption, "Ingredients\n200g spaghetti") || !strings.Contains(note, "Keep the creator's amounts exactly") {
		t.Fatalf("imported video: %v", imported)
	}
	var source string
	if e := a.DB.QueryRow(ctx, `SELECT r.source_url FROM voice_projects p JOIN recipes r ON r.id=p.recipe_id WHERE p.id=$1`, p).Scan(&source); e != nil || source != imported["sourceUrl"] {
		t.Fatalf("draft credits %q: %v", source, e)
	}
}
