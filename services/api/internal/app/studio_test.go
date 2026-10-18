package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"savorly/api/internal/ai"
	"strings"
	"testing"
	"time"
)

func studioFixture(t *testing.T) (*App, string) {
	t.Helper()
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	testUser(t, db, "cook")
	testUser(t, db, "other")
	// Studio media tests exercise a member whose plan includes video.
	if _, e := db.Exec(context.Background(), `UPDATE users SET plan='pro',plan_status='active' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	a := &App{DB: db, AI: ai.New(), Media: &MediaStore{S3: &s3.Client{}}}
	a.AI.OpenRouterKey = "test"
	a.AI.VideoKey = "test"
	project := uuid.NewString()
	_, e := db.Exec(context.Background(), `INSERT INTO voice_projects(id,user_id) VALUES($1,'cook')`, project)
	if e != nil {
		t.Fatal(e)
	}
	return a, project
}
func studioServer(a *App) *fiber.App {
	f := fiber.New()
	f.Use(func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return c.Next() })
	f.Get("/studio/:id", a.studioGet)
	f.Post("/studio/:id/messages", a.studioMessage)
	f.Delete("/studio/:id", a.studioDelete)
	f.Put("/studio/:id/context", a.studioContext)
	f.Post("/studio/:id/voice", a.voiceCreate)
	f.Delete("/studio/voice/:session", a.voiceClose)
	f.Get("/studio", a.studioList)
	f.Post("/studio", a.studioCreate)
	f.Post("/studio/:id/images", a.studioImage)
	f.Post("/studio/:id/undo", a.studioUndo)
	f.Post("/studio/:id/cancel", a.studioCancel)
	return f
}

// studioEventsOf reads a conversation's events as the app does, with the conversation itself.
func studioEventsOf(t *testing.T, f *fiber.App, p, who string) (int, []byte) {
	t.Helper()
	status, b := studioReq(t, f, "GET", "/studio/"+p+"?after=0", who, "", nil)
	if status != 200 {
		return status, b
	}
	var out struct{ Events json.RawMessage }
	if e := json.Unmarshal(b, &out); e != nil {
		t.Fatal(e)
	}
	return status, out.Events
}
func studioReq(t *testing.T, f *fiber.App, method, path, owner, key string, body any) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(jsonBytes(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Test-User", owner)
	req.Header.Set("Idempotency-Key", key)
	res, e := f.Test(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	var b bytes.Buffer
	b.ReadFrom(res.Body)
	return res.StatusCode, b.Bytes()
}
func exampleVoiceRecipe() RecipeInput {
	return RecipeInput{Title: "Lemon toast", Description: "A bright and crunchy lemon toast for a simple lunch.", Cuisine: "Italian", Minutes: 10, Servings: 2, Difficulty: "Easy", Ingredients: []Ingredient{{Name: "Bread", Amount: 2, Unit: "slices", Category: "Bakery"}}, Steps: []Step{{Title: "Toast", Text: "Toast the bread until golden, then serve."}}, Tags: []string{}, AIGenerated: true}
}
func toolCalls(calls map[string]any) map[string]any {
	list := []any{}
	for name, args := range calls {
		list = append(list, map[string]any{"id": "call_" + name, "type": "function", "function": map[string]any{"name": name, "arguments": string(jsonBytes(args))}})
	}
	return map[string]any{"content": "", "tool_calls": list}
}
func TestStudioConversationOwnershipIdempotencyAndBusy(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	body := map[string]any{"text": "Make my recipe for lemon toast", "images": []string{}}
	status, _ := studioReq(t, f, "POST", "/studio/"+p+"/messages", "other", "request-one", body)
	if status != 404 {
		t.Fatalf("foreign project accepted %d", status)
	}
	status, _ = studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "request-one", body)
	if status != 202 {
		t.Fatalf("message %d", status)
	}
	status, _ = studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "request-one", body)
	if status != 202 {
		t.Fatalf("idempotent replay %d", status)
	}
	status, _ = studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "request-one", map[string]any{"text": "Different recipe"})
	if status != 409 {
		t.Fatalf("changed replay %d", status)
	}
	status, _ = studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "request-two", body)
	if status != 409 {
		t.Fatalf("parallel conversation %d", status)
	}
	status, b := studioReq(t, f, "GET", "/studio/"+p, "cook", "", nil)
	if status != 200 || !bytes.Contains(bytes.ReplaceAll(b, []byte(" "), nil), []byte(`"busy":true`)) {
		t.Fatalf("project shape %d %s", status, b)
	}
	status, _ = studioEventsOf(t, f, p, "other")
	if status != 404 {
		t.Fatal(status)
	}
	var count int
	a.DB.QueryRow(context.Background(), `SELECT count(*) FROM voice_actions`).Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
}
func TestStudioClarificationBuildMediaAndPublish(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	recipe := exampleVoiceRecipe()
	turn := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		turn++
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in["model"] != "openai/gpt-6-luna" {
			t.Errorf("unexpected model %v", in["model"])
		}
		message := map[string]any{"content": "How many slices of bread?"}
		if turn == 2 {
			message = toolCalls(map[string]any{"save_recipe_draft": map[string]any{"recipe": recipe}})
		}
		if turn == 3 {
			message = map[string]any{"content": "Saved your lemon toast."}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message}}})
	}))
	defer provider.Close()
	a.AI.OpenRouterURL = provider.URL
	send := func(message, key string) {
		t.Helper()
		status, b := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", key, map[string]any{"text": message})
		if status != 202 {
			t.Fatalf("send %d %s", status, b)
		}
		var id string
		var through int64
		e := a.DB.QueryRow(ctx, `UPDATE voice_actions SET status='running' WHERE project_id=$1 AND status='queued' RETURNING id,through_seq`, p).Scan(&id, &through)
		if e != nil {
			t.Fatal(e)
		}
		a.processVoiceAction(ctx, id, p, through)
	}
	send("I make lemon toast. That's everything, make it.", "first-request")
	state, e := a.studioState(ctx, p, 0)
	if e != nil || state.Recipe != nil {
		t.Fatalf("clarification created recipe %v", e)
	}
	send("Two slices. Please make it.", "second-request")
	state, e = a.studioState(ctx, p, 0)
	if e != nil || state.Recipe == nil || state.Recipe.Published {
		t.Fatalf("draft missing or public %v %#v", e, state)
	}
	var count int
	a.DB.QueryRow(ctx, `SELECT count(*) FROM voice_assets WHERE project_id=$1`, p).Scan(&count)
	// A draft gets its cover photo; step clips wait for the cook to ask.
	if count != 1 {
		t.Fatalf("expected the cover photo job alone, got %d", count)
	}
	_, e = a.DB.Exec(ctx, `UPDATE ai_jobs SET status='completed',result=jsonb_build_object('url','https://media.example/cover.jpg') WHERE id IN(SELECT job_id FROM voice_assets WHERE project_id=$1)`, p)
	if e != nil {
		t.Fatal(e)
	}
	if e = a.syncStudioAssets(ctx); e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if state.Recipe.Image == "" || state.Recipe.Video != "" || state.Status != "ready" {
		t.Fatalf("assets not applied: %#v", state)
	}
	_, e = a.applyDraftAction(ctx, state, "publish", nil, false)
	if e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if state.Recipe.Published || state.Confirmed != state.Revision {
		t.Fatal("published without review")
	}
	// A fresh user response is required after the saved review; replaying the
	// original publish action cannot satisfy confirmation.
	asked(t, a, p, "Here's the draft. Shall I publish this version?")
	_, e = a.DB.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES($1,$2,'confirmation','user','Yes, publish this recipe.')`, p, "chat_"+p)
	if e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	_, e = a.applyDraftAction(ctx, state, "publish", nil, false)
	if e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if !state.Recipe.Published {
		t.Fatal("explicit publish failed")
	}
}
func TestStudioCorrectionsRejectStaleResultsAndMedia(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	state, _ := a.studioState(ctx, p, 0)
	r := exampleVoiceRecipe()
	if _, e := a.applyDraftAction(ctx, state, "build", &r, false); e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	r.Servings = 4
	if _, e := a.applyDraftAction(ctx, state, "build", &r, false); e != nil {
		t.Fatal(e)
	}
	_, _ = a.DB.Exec(ctx, `UPDATE ai_jobs SET status='completed',result='{"url":"https://media.example/old.jpg"}' WHERE id IN (SELECT job_id FROM voice_assets WHERE project_id=$1 AND revision=1)`, p)
	if e := a.syncStudioAssets(ctx); e != nil {
		t.Fatal(e)
	}
	current, _ := a.studioState(ctx, p, 0)
	if current.Recipe.Image != "" || current.Recipe.Servings != 4 {
		t.Fatal("stale media overwrote correction")
	}
	_, e := a.applyDraftAction(ctx, state, "publish", nil, false)
	if e != nil {
		t.Fatal(e)
	}
	current, _ = a.studioState(ctx, p, 0)
	if current.Confirmed != -1 || current.Recipe.Published {
		t.Fatal("stale review accepted")
	}
}
func TestStudioBudgetKeepsRecipeAndLongConversation(t *testing.T) {
	a, p := studioFixture(t)
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "0.01")
	ctx := context.Background()
	if _, e := a.DB.Exec(ctx, `UPDATE users SET plan='free',plan_status='' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	state, _ := a.studioState(ctx, p, 0)
	r := exampleVoiceRecipe()
	_, e := a.applyDraftAction(ctx, state, "build", &r, false)
	if e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if state.Recipe == nil {
		t.Fatal("budget discarded recipe")
	}
	if e = a.syncStudioAssets(ctx); e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if state.Status != "needs_attention" {
		t.Fatal(state.Status)
	}
	session := uuid.NewString()
	_, e = a.DB.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,expires_at) VALUES($1,$2,'cook','closed',0,now())`, session, p)
	if e != nil {
		t.Fatal(e)
	}
	long := strings.Repeat("This is a recipe detail. ", 10000)
	_, e = a.DB.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES($1,$2,'long-event','user',$3)`, p, session, long)
	if e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if len(state.Conversation) != 1 || state.Conversation[0].Content != long {
		t.Fatal("dictation was truncated")
	}
}
func TestStudioRejectsCrossProjectPhotos(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	status, _ := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "foreign-photo", map[string]any{"text": "Read this recipe", "images": []string{"not-my-photo"}})
	if status != 400 {
		t.Fatalf("foreign photo accepted: %d", status)
	}
}

func TestManualEditInvalidatesStudioMediaAndApproval(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	state, _ := a.studioState(ctx, p, 0)
	r := exampleVoiceRecipe()
	_, e := a.applyDraftAction(ctx, state, "build", &r, false)
	if e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	_, e = a.applyDraftAction(ctx, state, "review", nil, false)
	if e != nil {
		t.Fatal(e)
	}
	f := fiber.New()
	f.Put("/recipes/:id", func(c fiber.Ctx) error { c.Locals("userID", "cook"); return a.updateRecipe(c) })
	r.Image = "https://media.example/my-photo.jpg"
	r.Title = "Manually edited toast"
	status, b := studioReq(t, f, "PUT", "/recipes/"+state.RecipeID, "cook", "", r)
	if status != 200 {
		t.Fatalf("manual update %d %s", status, b)
	}
	_, _ = a.DB.Exec(ctx, `UPDATE ai_jobs SET status='completed',result='{"url":"https://media.example/stale.jpg"}' WHERE id IN(SELECT job_id FROM voice_assets WHERE project_id=$1)`, p)
	if e = a.syncStudioAssets(ctx); e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if state.Recipe.Image != r.Image || state.Confirmed != -1 {
		t.Fatal("manual edits overwritten or stale approval retained")
	}
}

// A draft's automatic media is its cover photo, even with a video provider and a plan with step
// clips: those are made only when the cook asks.
func TestAutomaticMediaIsTheCoverPhotoAlone(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	id := uuid.NewString()
	if e := persistRecipe(ctx, a.DB, "cook", id, exampleVoiceRecipe(), false); e != nil {
		t.Fatal(e)
	}
	if _, e := a.DB.Exec(ctx, `UPDATE voice_projects SET recipe_id=$2,revision=1,status='draft' WHERE id=$1`, p, id); e != nil {
		t.Fatal(e)
	}
	a.recoverStudioBundles(ctx)
	var kinds string
	a.DB.QueryRow(ctx, `SELECT string_agg(kind,',') FROM voice_assets WHERE project_id=$1`, p).Scan(&kinds)
	if kinds != "image" {
		t.Fatalf("automatic media: %q", kinds)
	}
}

func TestStudioRecoversUnqueuedBundleAndQueuesSourceDeletion(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	r := exampleVoiceRecipe()
	id := uuid.NewString()
	if e := persistRecipe(ctx, a.DB, "cook", id, r, false); e != nil {
		t.Fatal(e)
	}
	_, e := a.DB.Exec(ctx, `UPDATE voice_projects SET recipe_id=$2,revision=1,status='draft' WHERE id=$1`, p, id)
	if e != nil {
		t.Fatal(e)
	}
	a.recoverStudioBundles(ctx)
	a.recoverStudioBundles(ctx)
	var count int
	a.DB.QueryRow(ctx, `SELECT count(*) FROM voice_assets WHERE project_id=$1`, p).Scan(&count)
	if count != 1 {
		t.Fatalf("recovery not idempotent: %d", count)
	}
	_, e = a.DB.Exec(ctx, `INSERT INTO voice_sources(id,project_id,object_key,mime) VALUES('source',$1,'private-source.jpg','image/jpeg')`, p)
	if e != nil {
		t.Fatal(e)
	}
	_, e = a.DB.Exec(ctx, `DELETE FROM voice_projects WHERE id=$1`, p)
	if e != nil {
		t.Fatal(e)
	}
	a.DB.QueryRow(ctx, `SELECT count(*) FROM source_deletions WHERE object_key='private-source.jpg'`).Scan(&count)
	if count != 1 {
		t.Fatal("source cleanup lost after cascade")
	}
}

func TestAssistantActsThroughAppHandlers(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", public, false); e != nil {
		t.Fatal(e)
	}
	if e := persistRecipe(ctx, a.DB, "other", "secret", exampleVoiceRecipe(), false); e != nil {
		t.Fatal(e)
	}
	rounds := []map[string]any{
		toolCalls(map[string]any{
			"search_recipes": map[string]any{"query": "toast"},
			"plan_meal":      map[string]any{"recipe_id": "secret", "day": "2026-10-05", "meal": "Dinner", "servings": 2},
			"remove":         map[string]any{"kind": "grocery", "ids": []string{"../../recipes/toast"}},
		}),
		toolCalls(map[string]any{
			"plan_meal":            map[string]any{"recipe_id": "toast", "day": "2026-10-05", "meal": "Dinner", "servings": 2},
			"add_recipe_groceries": map[string]any{"recipe_id": "toast", "servings": 4},
			"show_recipes":         map[string]any{"recipe_ids": []string{"toast", "secret", "missing"}},
		}),
		{"content": "Lemon toast is on Monday's dinner and its bread is on your list."},
	}
	results := map[string]string{}
	turn := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Messages []map[string]any `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		for _, m := range in.Messages {
			if m["role"] == "tool" {
				results[turn2name(m["tool_call_id"])] = m["content"].(string)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": rounds[turn]}}, "usage": map[string]any{"cost": 0.004}})
		turn++
	}))
	defer provider.Close()
	a.AI.OpenRouterURL = provider.URL
	status, b := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "plan-request", map[string]any{"text": "Plan lemon toast for Monday dinner and get me the groceries for four."})
	if status != 202 {
		t.Fatalf("send %d %s", status, b)
	}
	var id string
	var through int64
	var reserved float64
	if e := a.DB.QueryRow(ctx, `UPDATE voice_actions SET status='running' WHERE project_id=$1 RETURNING id,through_seq,estimated_cost`, p).Scan(&id, &through, &reserved); e != nil {
		t.Fatal(e)
	}
	a.processVoiceAction(ctx, id, p, through)

	if !strings.Contains(results["search_recipes"], `"toast"`) || strings.Contains(results["search_recipes"], "secret") {
		t.Fatalf("search leaked or missed recipes: %s", results["search_recipes"])
	}
	if !strings.Contains(results["remove"], "Item not found") {
		t.Fatalf("path traversal reached another route: %s", results["remove"])
	}
	var plans, groceries int
	var quantity string
	a.DB.QueryRow(ctx, `SELECT count(*) FROM meal_plans WHERE user_id='cook' AND recipe_id='toast' AND meal='Dinner'`).Scan(&plans)
	a.DB.QueryRow(ctx, `SELECT count(*),max(quantity) FROM groceries WHERE user_id='cook'`).Scan(&groceries, &quantity)
	if plans != 1 || groceries != 1 || quantity != "4 slices" {
		t.Fatalf("actions not applied: plans=%d groceries=%d %q", plans, groceries, quantity)
	}
	if n := 0; a.DB.QueryRow(ctx, `SELECT count(*) FROM meal_plans WHERE recipe_id='secret'`).Scan(&n) == nil && n != 0 {
		t.Fatal("planned another cook's private recipe")
	}
	status, b = studioEventsOf(t, f, p, "cook")
	var events []struct {
		Role, Content string
		Recipes       []struct{ ID string }
	}
	if status != 200 || json.Unmarshal(b, &events) != nil || len(events) != 2 {
		t.Fatalf("events %d %s", status, b)
	}
	last := events[1]
	if last.Role != "assistant" || !strings.HasPrefix(last.Content, "Lemon toast is on") || len(last.Recipes) != 1 || last.Recipes[0].ID != "toast" {
		t.Fatalf("reply or cards wrong: %+v", last)
	}
	var settled float64
	a.DB.QueryRow(ctx, `SELECT estimated_cost FROM voice_actions WHERE id=$1`, id).Scan(&settled)
	if settled < .0119 || settled > .0121 || reserved <= settled {
		t.Fatalf("reservation %v not settled to reported cost, got %v", reserved, settled)
	}
}
func turn2name(id any) string { s, _ := id.(string); return strings.TrimPrefix(s, "call_") }

// agentTurn starts a turn over everything said so far, as the worker would.
func agentTurn(t *testing.T, a *App, p string) *agentRun {
	t.Helper()
	state, e := a.studioState(context.Background(), p, 0)
	if e != nil {
		t.Fatal(e)
	}
	return &agentRun{state: state}
}
func say(t *testing.T, a *App, p, text string) {
	t.Helper()
	_, e := a.DB.Exec(context.Background(), `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) VALUES('chat_'||$1,$1,'cook','closed',0,0,true,now()) ON CONFLICT DO NOTHING; `, p)
	if e == nil {
		_, e = a.DB.Exec(context.Background(), `INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES($1,'chat_'||$1,$2,'user',$3)`, p, uuid.NewString(), text)
	}
	if e != nil {
		t.Fatal(e)
	}
}

// asked records the reply that put a question to the user, as a settled turn would; an answer
// counts only after it.
func asked(t *testing.T, a *App, p, text string) {
	t.Helper()
	_, e := a.DB.Exec(context.Background(), `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) VALUES('chat_'||$1,$1,'cook','closed',0,0,true,now()) ON CONFLICT DO NOTHING; `, p)
	if e == nil {
		_, e = a.DB.Exec(context.Background(), `INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES($1,'chat_'||$1,'result_'||$2,'assistant',$3)`, p, uuid.NewString(), text)
	}
	if e != nil {
		t.Fatal(e)
	}
}
func TestAssistantSeesScreenAndLocalTime(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	_ = persistRecipe(ctx, a.DB, "other", "toast", public, false)
	_ = persistRecipe(ctx, a.DB, "other", "secret", exampleVoiceRecipe(), false)
	view := func(body map[string]any) map[string]any {
		t.Helper()
		if status, b := studioReq(t, f, "PUT", "/studio/"+p+"/context", "cook", "", body); status != 204 {
			t.Fatalf("context %d %s", status, b)
		}
		state, _ := a.studioState(ctx, p, 0)
		input, e := a.agentInput(ctx, state)
		if e != nil {
			t.Fatal(e)
		}
		return input.(fiber.Map)
	}
	if status, _ := studioReq(t, f, "PUT", "/studio/"+p+"/context", "other", "", map[string]any{"screen": "planner"}); status != 404 {
		t.Fatal("another user set this conversation's context")
	}
	in := view(map[string]any{"screen": "planner", "recipeId": "toast", "cookingStep": 1, "timeZone": "Pacific/Kiritimati"})
	if want := time.Now().In(time.FixedZone("", 14*3600)).Format("Monday 2006-01-02"); !strings.HasPrefix(in["now"].(string), want) {
		t.Fatalf("now %v, want local %s", in["now"], want)
	}
	screen := in["screen"].(fiber.Map)
	open, _ := screen["openRecipe"].(map[string]any)
	if screen["page"] != "planner" || open["title"] != "Lemon toast" || open["steps"] == nil || screen["cookingStep"] != 1 {
		t.Fatalf("screen %#v", screen)
	}
	// Opened from Create a recipe, the assistant knows it's there to write a new recipe, and the
	// conversation says so to the app.
	in = view(map[string]any{"screen": "discover", "purpose": "recipe"})
	if screen := in["screen"].(fiber.Map); screen["purpose"] != "newRecipe" {
		t.Fatalf("purpose %#v", screen)
	}
	var listed struct{ Purpose string }
	if status, b := studioReq(t, f, "GET", "/studio/"+p, "cook", "", nil); status != 200 || json.Unmarshal(b, &listed) != nil || listed.Purpose != "recipe" {
		t.Fatalf("conversation %d %s", status, b)
	}
	in = view(map[string]any{"screen": "admin", "recipeId": "secret", "cookingStep": 3, "timeZone": "Local", "purpose": "admin"})
	screen = in["screen"].(fiber.Map)
	if screen["page"] != "" || screen["openRecipe"] != nil || screen["purpose"] != nil || in["timeZone"] != "UTC" {
		t.Fatalf("untrusted context leaked: %#v %v", screen, in["timeZone"])
	}
}
func TestAssistantEditsOwnRecipesAndConfirmsConsequentialActions(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	mine := exampleVoiceRecipe()
	mine.AIGenerated = false
	mine.Image = "https://media.example/my-photo.jpg"
	_ = persistRecipe(ctx, a.DB, "cook", "mine", mine, false)
	public := exampleVoiceRecipe()
	public.Published = true
	_ = persistRecipe(ctx, a.DB, "other", "toast", public, false)
	tool := func(run *agentRun, name string, args any) string {
		return a.agentTool(ctx, run, name, jsonBytes(args))
	}
	current := func() RecipeInput {
		r, e := a.ownRecipe(ctx, "cook", "mine")
		if e != nil {
			t.Fatal(e)
		}
		return r
	}

	run := agentTurn(t, a, p)
	out := tool(run, "edit_recipe", map[string]any{"recipe_id": "mine", "changes": map[string]any{"servings": 4, "image": "https://evil.example/x.jpg"}})
	if !strings.Contains(out, "servings 2 → 4") || current().Servings != 4 || current().Image != mine.Image {
		t.Fatalf("private edit not applied or photo replaced: %s", out)
	}
	if out = tool(run, "edit_recipe", map[string]any{"recipe_id": "toast", "changes": map[string]any{"servings": 9}}); !strings.Contains(out, "Only your own") {
		t.Fatalf("edited another cook's recipe: %s", out)
	}
	if out = tool(run, "edit_recipe", map[string]any{"recipe_id": "mine", "published": true}); !strings.Contains(out, "needsConfirmation") || current().Published {
		t.Fatalf("published without confirmation: %s", out)
	}
	if out = tool(run, "confirm_action", nil); !strings.Contains(out, "first thing in a turn") || current().Published {
		t.Fatalf("confirmed later in the turn: %s", out)
	}
	if out = tool(agentTurn(t, a, p), "confirm_action", nil); !strings.Contains(out, "Wait for the user") || current().Published {
		t.Fatalf("confirmed without an answer: %s", out)
	}
	asked(t, a, p, "Publish “Lemon toast” so everyone can see it?")
	say(t, a, p, "Yes, publish it.")
	run = agentTurn(t, a, p)
	if out = tool(run, "confirm_action", nil); !current().Published || !strings.Contains(out, "publishes it") {
		t.Fatalf("confirmed publish failed: %s", out)
	}
	if out = tool(run, "confirm_action", nil); !strings.Contains(out, "first thing in a turn") {
		t.Fatalf("confirmation replayed: %s", out)
	}
	if out = tool(agentTurn(t, a, p), "confirm_action", nil); !strings.Contains(out, "Nothing is waiting") {
		t.Fatalf("confirmation replayed in a later turn: %s", out)
	}
	// Making it private changes what others see too, so it waits as well.
	if out = tool(agentTurn(t, a, p), "edit_recipe", map[string]any{"recipe_id": "mine", "published": false}); !strings.Contains(out, "needsConfirmation") || !strings.Contains(out, "makes it private") || !current().Published {
		t.Fatalf("made private without confirmation: %s", out)
	}
	if out = tool(run, "review_recipe", map[string]any{"recipe_id": "mine", "rating": 5, "text": "So good"}); !strings.Contains(out, "other cooks' published recipes") {
		t.Fatalf("reviewed own recipe: %s", out)
	}
	if out = tool(run, "review_recipe", map[string]any{"recipe_id": "toast", "rating": 4, "text": "Lovely and quick."}); !strings.Contains(out, "4-star review of “Lemon toast”") {
		t.Fatalf("review not held for confirmation: %s", out)
	}
	// Diets decide what's safe to suggest, so a change waits for the user's yes to exactly it.
	if out = tool(run, "update_profile", map[string]any{"diets": []string{"vegetarian"}}); !strings.Contains(out, "needsConfirmation") || !strings.Contains(out, "your diets to vegetarian") {
		t.Fatalf("profile change not held for confirmation: %s", out)
	}
	var name, diets string
	a.DB.QueryRow(ctx, `SELECT name,preferences->>'diets' FROM users WHERE id='cook'`).Scan(&name, &diets)
	if diets == `["vegetarian"]` {
		t.Fatal("diets changed before the user's yes")
	}
	asked(t, a, p, "Change your diets to vegetarian?")
	say(t, a, p, "Yes.")
	if out = tool(agentTurn(t, a, p), "confirm_action", nil); strings.Contains(out, "@") || !strings.Contains(out, "vegetarian") {
		t.Fatalf("profile update: %s", out)
	}
	a.DB.QueryRow(ctx, `SELECT name,preferences->>'diets' FROM users WHERE id='cook'`).Scan(&name, &diets)
	if name != "Test cook" || diets != `["vegetarian"]` {
		t.Fatalf("profile overwritten: %s %s", name, diets)
	}

	// An unrelated reply abandons a pending deletion; a later yes can't revive it.
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Messages []map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&in)
		message := map[string]any{"content": "Done."}
		last := in.Messages[len(in.Messages)-1]
		conversation := fmt.Sprint(in.Messages[1]["content"])
		switch {
		case last["role"] == "tool":
		case strings.Contains(conversation, "Delete my toast") && !strings.Contains(conversation, "Never mind"):
			message = toolCalls(map[string]any{"delete_recipe": map[string]any{"recipe_id": "mine"}})
		case strings.Contains(conversation, "Yes, delete"):
			message = toolCalls(map[string]any{"confirm_action": map[string]any{}})
		case strings.Contains(conversation, "Never mind"):
			message = toolCalls(map[string]any{"app_action": map[string]any{"action": "go_to", "page": "planner"}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message}}})
	}))
	defer provider.Close()
	a.AI.OpenRouterURL = provider.URL
	turn := func(text string) {
		t.Helper()
		say(t, a, p, text)
		var id string
		var through int64
		_, _ = a.DB.Exec(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,through_seq) SELECT $1,$2,'chat_'||$2,$1,max(seq) FROM voice_events WHERE project_id=$2`, uuid.NewString(), p)
		if e := a.DB.QueryRow(ctx, `UPDATE voice_actions SET status='running' WHERE project_id=$1 AND status='queued' RETURNING id,through_seq`, p).Scan(&id, &through); e != nil {
			t.Fatal(e)
		}
		a.processVoiceAction(ctx, id, p, through)
	}
	turn("Delete my toast recipe.")
	var pending []byte
	a.DB.QueryRow(ctx, `SELECT pending FROM voice_projects WHERE id=$1`, p).Scan(&pending)
	if !bytes.Contains(pending, []byte("delete_recipe")) {
		t.Fatalf("deletion not held: %s", pending)
	}
	turn("Never mind, show me my planner.")
	turn("Yes, delete it.")
	if current().Title == "" {
		t.Fatal("abandoned deletion ran")
	}
	var actions string
	a.DB.QueryRow(ctx, `SELECT actions::text FROM voice_events WHERE project_id=$1 AND actions<>'[]'`, p).Scan(&actions)
	if !strings.Contains(actions, `"page": "planner"`) {
		t.Fatalf("screen action not stored: %q", actions)
	}
}
func TestAssistantMakesMediaForAnExistingRecipe(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	mine := exampleVoiceRecipe()
	mine.Published = true
	mine.AIGenerated = false
	mine.Image = "https://media.example/my-photo.jpg"
	_ = persistRecipe(ctx, a.DB, "cook", "mine", mine, false)
	run := agentTurn(t, a, p)
	media := func() string {
		return a.agentTool(ctx, run, "generate_recipe_media", jsonBytes(map[string]any{"recipe_id": "mine", "kinds": []string{"image"}}))
	}
	out := media()
	if run.state.RecipeID != "mine" || !strings.Contains(out, `"image"`) || strings.Contains(out, `"video"`) {
		t.Fatalf("media not queued for the recipe: %s", out)
	}
	// Asking again while it's being made neither orders nor reserves another.
	out = media()
	jobs := func() (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM ai_jobs WHERE user_id='cook'`).Scan(&n)
		return n
	}
	if jobs() != 1 || !strings.Contains(out, `"queued"`) {
		t.Fatalf("repeat request ordered again: %d jobs, %s", jobs(), out)
	}
	// "Change the servings to 6" must not take the live recipe offline or relabel the cook's
	// own recipe as AI-made; the sous-chef is sent to edit_recipe, which asks first.
	r := mine
	r.Servings = 6
	out = a.agentTool(ctx, run, "save_recipe_draft", jsonBytes(map[string]any{"recipe": r}))
	current, _ := a.ownRecipe(ctx, "cook", "mine")
	if !strings.Contains(out, "edit_recipe") || !current.Published || current.AIGenerated || current.Servings != 2 {
		t.Fatalf("a draft write changed the published recipe: %s %#v", out, current)
	}
	if out = a.agentTool(ctx, run, "edit_recipe", jsonBytes(map[string]any{"recipe_id": "mine", "changes": map[string]any{"servings": 6}})); !strings.Contains(out, "needsConfirmation") {
		t.Fatalf("published edit not held for confirmation: %s", out)
	}
	_, _ = a.DB.Exec(ctx, `UPDATE ai_jobs SET status='completed',result='{"url":"https://media.example/new-cover.jpg"}' WHERE id IN (SELECT job_id FROM voice_assets WHERE project_id=$1)`, p)
	if e := a.syncStudioAssets(ctx); e != nil {
		t.Fatal(e)
	}
	state, _ := a.studioState(ctx, p, 0)
	if state.Recipe.Image != "https://media.example/new-cover.jpg" || !state.Recipe.Published || state.Status != "published" || jobs() != 1 {
		t.Fatalf("cover not attached: %#v", state)
	}
}
func TestAssistantRevisesAnAdoptedPrivateRecipeInPlace(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	mine := exampleVoiceRecipe()
	mine.AIGenerated = false
	mine.Image = "https://media.example/my-photo.jpg"
	_ = persistRecipe(ctx, a.DB, "cook", "mine", mine, false)
	run := agentTurn(t, a, p)
	if e := a.adoptRecipe(ctx, run, "mine"); e != nil {
		t.Fatal(e)
	}
	// A chat revision of an adopted recipe keeps its photos and authorship and starts no media.
	r := mine
	r.Servings = 6
	if out := a.agentTool(ctx, run, "save_recipe_draft", jsonBytes(map[string]any{"recipe": r})); !strings.Contains(out, "keeping its photos") {
		t.Fatalf("revision refused: %s", out)
	}
	current, _ := a.ownRecipe(ctx, "cook", "mine")
	var jobs int
	a.DB.QueryRow(ctx, `SELECT count(*) FROM ai_jobs WHERE user_id='cook'`).Scan(&jobs)
	if current.Servings != 6 || current.Image != mine.Image || current.AIGenerated || current.Published || jobs != 0 {
		t.Fatalf("revision relabelled the recipe, replaced photos or queued media: %#v, %d jobs", current, jobs)
	}
}
