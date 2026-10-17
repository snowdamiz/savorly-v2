package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestConversationCapErasesLongIdleConversations(t *testing.T) {
	a, _ := studioFixture(t)
	ctx := context.Background()
	f := studioServer(a)
	conversations := func() (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM voice_projects WHERE user_id='cook' AND deleted_at IS NULL`).Scan(&n)
		return n
	}
	exists := func(id string) (found bool) {
		a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voice_projects WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&found)
		return found
	}
	// 200 in all: 150 idle for over a month (old-150 the oldest), and 49 recent.
	_, e := a.DB.Exec(ctx, `INSERT INTO voice_projects(id,user_id,updated_at) SELECT 'old-'||n,'cook',now()-interval '40 days'-n*interval '1 minute' FROM generate_series(1,150) n`)
	if e == nil {
		_, e = a.DB.Exec(ctx, `INSERT INTO voice_projects(id,user_id) SELECT 'recent-'||n,'cook' FROM generate_series(1,49) n`)
	}
	// The oldest has a turn still waiting, so it stays; the next has a turn billed this
	// month, which keeps counting after it's erased.
	if e == nil {
		_, e = a.DB.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) SELECT 'chat_'||id,id,'cook','closed',0,0,true,now() FROM voice_projects WHERE id IN ('old-150','old-149')`)
	}
	if e == nil {
		_, e = a.DB.Exec(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,status,estimated_cost) VALUES('waiting','old-150','chat_old-150','waiting','queued',0.18),('billed','old-149','chat_old-149','billed','completed',0.2)`)
	}
	if e != nil {
		t.Fatal(e)
	}
	before, _ := usageOf(ctx, a.DB, "cook")
	key := uuid.NewString()
	if status, b := studioReq(t, f, "POST", "/studio", "cook", key, nil); status != 200 {
		t.Fatalf("new conversation at the cap: %d %s", status, b)
	}
	if conversations() != 200 || !exists(key) || !exists("old-150") || exists("old-149") || !exists("old-148") {
		t.Fatalf("pruned the wrong conversations: %d", conversations())
	}
	if after, _ := usageOf(ctx, a.DB, "cook"); after != before {
		t.Fatalf("pruning changed usage: %+v, was %+v", after, before)
	}
	if status, _ := studioReq(t, f, "POST", "/studio", "cook", key, nil); status != 200 || conversations() != 200 {
		t.Fatalf("replaying a creation: %d", status)
	}
	// With every conversation in use, a new one is refused rather than deleting recent history.
	if _, e = a.DB.Exec(ctx, `UPDATE voice_projects SET updated_at=now() WHERE user_id='cook'`); e != nil {
		t.Fatal(e)
	}
	status, b := studioReq(t, f, "POST", "/studio", "cook", uuid.NewString(), nil)
	if status != 409 || !strings.Contains(string(b), "200 sous-chef conversations") || conversations() != 200 {
		t.Fatalf("over the cap: %d %s", status, b)
	}
}

func TestRecipePhotosAreCappedPerMember(t *testing.T) {
	a, p := studioFixture(t)
	a.Media.SourceBucket = "savorly-sources"
	ctx := context.Background()
	_, e := a.DB.Exec(ctx, `INSERT INTO voice_projects(id,user_id) SELECT 'photos-'||n,'cook' FROM generate_series(1,10) n`)
	if e == nil {
		_, e = a.DB.Exec(ctx, `INSERT INTO voice_sources(id,project_id,object_key,mime) SELECT 'source-'||n,'photos-'||(n%10+1),'recipe-sources/cook/'||n,'image/jpeg' FROM generate_series(1,200) n`)
	}
	if e != nil {
		t.Fatal(e)
	}
	f := studioServer(a)
	status, b := studioReq(t, f, "POST", "/studio/"+p+"/images", "cook", "", nil)
	if status != 400 || !strings.Contains(string(b), "200 recipe photos") {
		t.Fatalf("photo over the member's cap: %d %s", status, b)
	}
	// Below the cap the upload goes on (and here stops at the missing file).
	if _, e = a.DB.Exec(ctx, `DELETE FROM voice_sources WHERE id='source-1'`); e != nil {
		t.Fatal(e)
	}
	if status, b = studioReq(t, f, "POST", "/studio/"+p+"/images", "cook", "", nil); status != 400 || !strings.Contains(string(b), "Choose or take a recipe photo") {
		t.Fatalf("below the cap: %d %s", status, b)
	}
}

func TestSuspendedCooksRecipesLeaveTheSousChef(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	_ = persistRecipe(ctx, a.DB, "other", "gone", public, false)
	_ = persistRecipe(ctx, a.DB, "cook", "mine", public, false)
	studioEvent(t, a, p, "assistant", "Try these.")
	if _, e := a.DB.Exec(ctx, `UPDATE voice_events SET recipes='["gone","mine"]' WHERE project_id=$1`, p); e != nil {
		t.Fatal(e)
	}
	if _, e := a.DB.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id='other'`); e != nil {
		t.Fatal(e)
	}
	tool := func(run *agentRun, name string, args any) string { return a.agentTool(ctx, run, name, jsonBytes(args)) }
	run := agentTurn(t, a, p)
	if out := tool(run, "show_recipes", map[string]any{"recipe_ids": []string{"gone", "mine"}}); !strings.Contains(out, `"shown":1`) || len(run.recipes) != 1 || run.recipes[0] != "mine" {
		t.Fatalf("showed a suspended cook's recipe: %s %v", out, run.recipes)
	}
	if out := tool(run, "app_action", map[string]any{"action": "open_recipe", "recipe_id": "gone"}); !strings.Contains(out, "Recipe not found") {
		t.Fatalf("opened a suspended cook's recipe: %s", out)
	}
	if out := tool(run, "report_recipe", map[string]any{"recipe_id": "gone", "reason": "Copied from a cookbook."}); !strings.Contains(out, "Recipe not found") {
		t.Fatalf("reported a hidden recipe: %s", out)
	}
	if out := tool(run, "app_action", map[string]any{"action": "start_cooking", "recipe_id": "mine", "step": 1}); !strings.Contains(out, `"ok":true`) {
		t.Fatal(out)
	}
	status, b := studioEventsOf(t, studioServer(a), p, "cook")
	var events []struct{ Recipes []struct{ ID string } }
	if status != 200 || json.Unmarshal(b, &events) != nil || len(events) != 1 || len(events[0].Recipes) != 1 || events[0].Recipes[0].ID != "mine" {
		t.Fatalf("cards %d %s", status, b)
	}
}

func TestRecipeMediaChecksThePlanBeforeAdoptingTheRecipe(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	ctx := context.Background()
	if _, e := a.DB.Exec(ctx, `UPDATE users SET plan='free',plan_status='' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	mine := exampleVoiceRecipe()
	mine.Published = true
	_ = persistRecipe(ctx, a.DB, "cook", "mine", mine, false)
	// This month's one AI photo is used, and Free has no videos.
	if _, e := a.DB.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost,status) VALUES('used','cook','image','A cover','used-key',0.05,'completed')`); e != nil {
		t.Fatal(e)
	}
	run := agentTurn(t, a, p)
	for kind, refusal := range map[string]string{"image": "You've used your plan's AI photos for the last 30 days", "video": "Your plan doesn't include AI video generation"} {
		if out := a.agentTool(ctx, run, "generate_recipe_media", jsonBytes(map[string]any{"recipe_id": "mine", "kinds": []string{kind}})); !strings.Contains(out, refusal) {
			t.Fatalf("%s: %s", kind, out)
		}
	}
	// Refused before the conversation took the recipe over: no adoption, revision bump or job.
	var recipe *string
	var revision, jobs int
	a.DB.QueryRow(ctx, `SELECT recipe_id,revision,(SELECT count(*) FROM ai_jobs) FROM voice_projects WHERE id=$1`, p).Scan(&recipe, &revision, &jobs)
	if recipe != nil || revision != 0 || jobs != 1 {
		t.Fatalf("refused media changed the conversation: %v %d %d", recipe, revision, jobs)
	}
}
