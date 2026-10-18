package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

func clipsApp(db *pgxpool.Pool) (*App, func(method, path, user, key string) (int, map[string]any)) {
	a := &App{DB: db, AI: ai.New(), Media: &MediaStore{S3: &s3.Client{}}}
	a.AI.VideoKey = "test"
	f := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	as := func(h fiber.Handler) fiber.Handler {
		return func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return h(c) }
	}
	f.Post("/recipes/:id/step-clips", as(a.orderStepClips))
	f.Get("/recipes/:id/step-clips", as(a.stepClips))
	return a, func(method, path, user, key string) (int, map[string]any) {
		req := httptest.NewRequest(method, path, bytes.NewReader(nil))
		req.Header.Set("Test-User", user)
		req.Header.Set("Idempotency-Key", key)
		res, e := f.Test(req, fiber.TestConfig{Timeout: 10 * time.Second})
		if e != nil {
			panic(e)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
}

func recipeWithSteps(t *testing.T, db *pgxpool.Pool, author string, steps []Step) string {
	t.Helper()
	id := uuid.NewString()
	_, e := db.Exec(context.Background(), `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps)
 VALUES($1,$2,'Lemon pasta','A recipe for testing step clips.','Italian',20,2,'Easy','[{"name":"Lemon","amount":1,"unit":"","category":"Produce"}]',$3)`, id, author, jsonBytes(steps))
	if e != nil {
		t.Fatal(e)
	}
	return id
}

func savedSteps(t *testing.T, db *pgxpool.Pool, recipe string) ([]Step, bool) {
	t.Helper()
	var raw []byte
	var generated bool
	if e := db.QueryRow(context.Background(), `SELECT steps,ai_generated FROM recipes WHERE id=$1`, recipe).Scan(&raw, &generated); e != nil {
		t.Fatal(e)
	}
	var steps []Step
	if e := json.Unmarshal(raw, &steps); e != nil {
		t.Fatal(e)
	}
	return steps, generated
}

func clipTexts(out map[string]any) []string {
	texts := []string{}
	clips, _ := out["clips"].([]any)
	for _, c := range clips {
		texts = append(texts, c.(map[string]any)["text"].(string))
	}
	return texts
}

// The cook orders clips for a recipe of their own, once per key: one for each step that has
// none, made from the step's words, or from its photo when it has one. Finished clips go onto
// the step with the same text that still has no clip, wherever it has moved.
func TestStepClipsAreMadeForEveryStepWithoutOne(t *testing.T) {
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "other")
	a, call := clipsApp(db)
	recipe := recipeWithSteps(t, db, "cook", []Step{
		{Title: "Boil", Text: "Boil the pasta.", Video: "https://media.example.com/cook/boil.mp4"},
		{Title: "Zest", Text: "Zest the lemon.", Image: "https://media.example.com/cook/zest.jpg"},
		{Title: "Toss", Text: "Toss it all together."},
	})
	path := "/recipes/" + recipe + "/step-clips"

	if status, out := call("POST", path, "cook", ""); status != 400 {
		t.Fatalf("no key: %d %v", status, out)
	}
	if status, out := call("POST", path, "other", "other-key-1"); status != 404 {
		t.Fatalf("someone else's recipe: %d %v", status, out)
	}
	status, out := call("POST", path, "cook", "clips-key-1")
	if status != 202 || strings.Join(clipTexts(out), "|") != "Zest the lemon.|Toss it all together." {
		t.Fatalf("order: %d %v", status, out)
	}
	type job struct {
		id, prompt, source string
		cost               float64
	}
	jobs := map[string]job{}
	rows, e := db.Query(ctx, `SELECT c.step_text,j.id,j.prompt,j.source,j.estimated_cost::float8 FROM step_clip_jobs c JOIN ai_jobs j ON j.id=c.job_id WHERE j.kind='clip' AND j.user_id='cook' AND j.status='queued'`)
	if e != nil {
		t.Fatal(e)
	}
	for rows.Next() {
		var text string
		var j job
		if e = rows.Scan(&text, &j.id, &j.prompt, &j.source, &j.cost); e != nil {
			t.Fatal(e)
		}
		jobs[text] = j
	}
	rows.Close()
	zest, toss := jobs["Zest the lemon."], jobs["Toss it all together."]
	if len(jobs) != 2 || zest.source != "https://media.example.com/cook/zest.jpg" || toss.source != "" || zest.cost != ai.GenerationEstimate("clip") {
		t.Fatalf("jobs: %+v", jobs)
	}
	if !strings.HasPrefix(zest.prompt, "Bring this photo of the step to life.") || !strings.Contains(toss.prompt, "“Lemon pasta”") || !strings.Contains(toss.prompt, "Toss: Toss it all together.") {
		t.Fatalf("prompts: %q %q", zest.prompt, toss.prompt)
	}

	// The same request again answers what it ordered, and pays nothing more.
	if status, out = call("POST", path, "cook", "clips-key-1"); status != 200 || len(clipTexts(out)) != 2 {
		t.Fatalf("repeat: %d %v", status, out)
	}
	// Clips on their way aren't ordered twice; a key is for one recipe.
	if status, out = call("POST", path, "cook", "clips-key-2"); status != 409 || out["error"] != "Every step already has a clip, or one on its way." {
		t.Fatalf("again: %d %v", status, out)
	}
	other := recipeWithSteps(t, db, "cook", []Step{{Title: "Serve", Text: "Serve it warm."}})
	if status, out = call("POST", "/recipes/"+other+"/step-clips", "cook", "clips-key-1"); status != 409 {
		t.Fatalf("a key for another recipe: %d %v", status, out)
	}

	// The tossing clip is made while the cook moves that step to the top; the zest clip fails.
	if _, e = db.Exec(ctx, `UPDATE ai_jobs SET status='completed',result='{"url":"https://media.example.com/cook/toss.mp4","aiGenerated":true}' WHERE id=$1`, toss.id); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, `UPDATE ai_jobs SET status='failed',error='The video provider could not complete this generation. Review your prompt and try again.' WHERE id=$1`, zest.id); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, `UPDATE recipes SET steps=jsonb_build_array(steps->2,steps->0,steps->1) WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	a.syncStepClips(ctx)
	steps, generated := savedSteps(t, db, recipe)
	if steps[0].Text != "Toss it all together." || steps[0].Video != "https://media.example.com/cook/toss.mp4" || steps[2].Video != "" || steps[1].Video != "https://media.example.com/cook/boil.mp4" || !generated {
		t.Fatalf("clips on steps: %+v (AI %v)", steps, generated)
	}
	var waiting int
	if e = db.QueryRow(ctx, `SELECT count(*) FROM step_clip_jobs WHERE NOT applied`).Scan(&waiting); e != nil || waiting != 0 {
		t.Fatalf("settled: %d %v", waiting, e)
	}
	status, out = call("GET", path, "cook", "")
	clips, _ := out["clips"].([]any)
	if status != 200 || len(clips) != 2 {
		t.Fatalf("list: %d %v", status, out)
	}
	for _, c := range clips {
		c := c.(map[string]any)
		if c["text"] == "Toss it all together." && (c["status"] != "completed" || c["url"] != "https://media.example.com/cook/toss.mp4") ||
			c["text"] == "Zest the lemon." && (c["status"] != "failed" || c["error"] == "") {
			t.Errorf("listed clip: %v", c)
		}
	}
	if status, out = call("GET", path, "other", ""); status != 200 || len(clipTexts(out)) != 0 {
		t.Fatalf("someone else's list: %d %v", status, out)
	}

	// Ordering again makes only the clip that failed. It's ready after the cook rewrote that step
	// and gave it a clip of their own, so the step keeps theirs.
	if status, out = call("POST", path, "cook", "clips-key-3"); status != 202 || strings.Join(clipTexts(out), "|") != "Toss it all together.|Zest the lemon." {
		t.Fatalf("retry: %d %v", status, out)
	}
	if _, e = db.Exec(ctx, `UPDATE ai_jobs SET status='completed',result='{"url":"https://media.example.com/cook/zest.mp4"}' WHERE kind='clip' AND status='queued'`); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{2}','{"title":"Zest","text":"Zest the lemon.","seconds":0,"video":"https://media.example.com/cook/mine.mp4"}') WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	a.syncStepClips(ctx)
	if steps, _ = savedSteps(t, db, recipe); steps[2].Video != "https://media.example.com/cook/mine.mp4" {
		t.Fatalf("the cook's own clip was replaced: %+v", steps[2])
	}
	if status, out = call("POST", path, "cook", "clips-key-4"); status != 409 {
		t.Fatalf("every step has a clip: %d %v", status, out)
	}

	// A server without reAPI says so before anything is reserved.
	a.AI.VideoKey = ""
	if status, out = call("POST", "/recipes/"+other+"/step-clips", "cook", "clips-key-5"); status != 503 || out["error"] != "Step clips need a reAPI connection on the server." {
		t.Fatalf("unconnected: %d %v", status, out)
	}
}

// With paid plans, a recipe's clips are all ordered or none: the plan's clips left must cover
// every step without one.
func TestStepClipsNeedAClipLeftForEveryStep(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "plus")
	testUser(t, db, "pro")
	if _, e := db.Exec(ctx, `UPDATE users SET plan=id,plan_status='active' WHERE id IN ('plus','pro')`); e != nil {
		t.Fatal(e)
	}
	_, call := clipsApp(db)
	steps := func(n int) []Step {
		out := []Step{}
		for i := range n {
			out = append(out, Step{Title: "Step", Text: "Do thing number " + string(rune('a'+i)) + "."})
		}
		return out
	}
	order := func(user string, n int, key string) (int, map[string]any) {
		return call("POST", "/recipes/"+recipeWithSteps(t, db, user, steps(n))+"/step-clips", user, key)
	}
	if status, out := order("plus", 1, "plus-key-1"); status != 429 || out["error"] != "Your plan doesn't include AI step clips." {
		t.Fatalf("plus: %d %v", status, out)
	}
	var pro Plan
	for _, p := range plans {
		if p.ID == "pro" {
			pro = p
		}
	}
	if status, out := order("pro", pro.Videos+1, "pro-key-1"); status != 429 || out["error"] != "Your plan's AI step clips left for the last 30 days don't cover every step of this recipe." {
		t.Fatalf("more steps than clips: %d %v", status, out)
	}
	var jobs int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM ai_jobs`).Scan(&jobs); e != nil || jobs != 0 {
		t.Fatalf("a refusal queued %d jobs (%v)", jobs, e)
	}
	if status, out := order("pro", pro.Videos, "pro-key-2"); status != 202 || len(clipTexts(out)) != pro.Videos {
		t.Fatalf("every clip the plan has: %d %v", status, out)
	}
	if status, out := order("pro", 1, "pro-key-3"); status != 429 || out["error"] != "You've used your plan's AI step clips for the last 30 days." {
		t.Fatalf("used up: %d %v", status, out)
	}
}

// A clip job hands the provider its step's photo as the opening frame, and waits for the clip.
func TestClipJobsOpenWithTheStepsPhoto(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	var sent map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		w.Write([]byte(`{"id":"task_clip","status":"processing"}`))
	}))
	defer provider.Close()
	a, _ := clipsApp(db)
	a.AI.VideoURL = provider.URL
	id := uuid.NewString()
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,source,request_key,status) VALUES($1,'cook','clip','Zest the lemon.','https://media.example.com/cook/zest.jpg','clip-test-0','running')`, id); e != nil {
		t.Fatal(e)
	}
	a.processJob(ctx, id, "cook", "clip", "Zest the lemon.", "https://media.example.com/cook/zest.jpg")
	frames, _ := sent["image_with_roles"].([]any)
	if len(frames) != 1 || frames[0].(map[string]any)["url"] != "https://media.example.com/cook/zest.jpg" || frames[0].(map[string]any)["role"] != "first_frame" {
		t.Fatalf("sent %v", sent)
	}
	var status, task string
	if e := db.QueryRow(ctx, `SELECT status,provider_id FROM ai_jobs WHERE id=$1`, id).Scan(&status, &task); e != nil || status != "processing" || task != "task_clip" {
		t.Fatalf("job %s %s %v", status, task, e)
	}
}

// The sous-chef orders a recipe's step clips only through generate_recipe_media's step_clips,
// which leaves the conversation's draft alone; asked twice in a turn, it orders once.
func TestAssistantMakesStepClipsWhenAsked(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	mine := exampleVoiceRecipe()
	mine.Steps = append(mine.Steps, Step{Title: "Zest", Text: "Zest a lemon over the toast."})
	if e := persistRecipe(ctx, a.DB, "cook", "mine", mine, false); e != nil {
		t.Fatal(e)
	}
	run := agentTurn(t, a, p)
	run.action = "turn-1"
	clips := func() string {
		return a.agentTool(ctx, run, "generate_recipe_media", jsonBytes(map[string]any{"recipe_id": "mine", "kinds": []string{"step_clips"}}))
	}
	jobs := func() (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM ai_jobs WHERE user_id='cook' AND kind='clip'`).Scan(&n)
		return n
	}
	out := clips()
	if !strings.Contains(out, `"stepClips"`) || !strings.Contains(out, "Zest a lemon over the toast.") || strings.Contains(out, `"media"`) || jobs() != 2 || run.state.RecipeID != "" {
		t.Fatalf("clips: %s, %d jobs, draft %q", out, jobs(), run.state.RecipeID)
	}
	if out = clips(); !strings.Contains(out, `"stepClips"`) || jobs() != 2 {
		t.Fatalf("asked again: %s, %d jobs", out, jobs())
	}
	if out = a.agentTool(ctx, run, "generate_recipe_media", jsonBytes(map[string]any{"recipe_id": "mine", "kinds": []string{"video"}})); !strings.Contains(out, "Choose image, step_clips, or both.") {
		t.Fatalf("a recipe video: %s", out)
	}
}
