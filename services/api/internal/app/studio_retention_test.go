package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestDeletingAConversationErasesItButKeepsItsAccounting(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	ctx := context.Background()
	f := studioServer(a)
	// A draft with its media on the way, a photo, an answered turn, a voice call, a proposal.
	state, _ := a.studioState(ctx, p, 0)
	r := exampleVoiceRecipe()
	if _, e := a.applyDraftAction(ctx, state, "build", &r, false); e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	studioEvent(t, a, p, "user", "Read this page.", "page-photo")
	for _, sql := range []string{
		`INSERT INTO voice_sources(id,project_id,object_key,mime) VALUES('page-photo',$1,'recipe-sources/cook/page.jpg','image/jpeg')`,
		`INSERT INTO voice_actions(id,project_id,session_id,delegation_id,status,reply,estimated_cost) VALUES('answered',$1,'chat_'||$1,'answered','completed','Saved your toast.',0.2)`,
		`INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) VALUES('call',$1,'cook','closed',120,42,true,now())`,
		`UPDATE voice_projects SET reply='Saved your toast.',pending='{"tool":"delete_recipe","args":{},"description":"Delete it"}',context='{"screen":"planner"}' WHERE id=$1`,
	} {
		if _, e := a.DB.Exec(ctx, sql, p); e != nil {
			t.Fatal(e)
		}
	}
	before, _ := usageOf(ctx, a.DB, "cook")
	if before.Assistant != 1 || before.VoiceSeconds != 42 || before.Images != 1 || before.Spend == 0 {
		t.Fatalf("fixture usage %+v", before)
	}
	if status, b := studioReq(t, f, "DELETE", "/studio/"+p, "cook", "", nil); status != 204 {
		t.Fatalf("delete %d %s", status, b)
	}
	// Spend and allowance use stay counted for the rest of their 30 days.
	if after, _ := usageOf(ctx, a.DB, "cook"); after != before {
		t.Fatalf("deleting changed usage: %+v, was %+v", after, before)
	}
	// The content is gone at once; the private photo is queued for removal from storage.
	var events, sources, assets, replies, queued int
	var reply, errorText, context string
	var pending, recipe *string
	var deleted bool
	a.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM voice_events WHERE project_id=$1),(SELECT count(*) FROM voice_sources WHERE project_id=$1),(SELECT count(*) FROM voice_assets WHERE project_id=$1),
 (SELECT count(*) FROM voice_actions WHERE project_id=$1 AND reply<>''),(SELECT count(*) FROM source_deletions WHERE object_key='recipe-sources/cook/page.jpg'),
 reply,error,context::text,pending::text,recipe_id,deleted_at IS NOT NULL FROM voice_projects WHERE id=$1`, p).Scan(&events, &sources, &assets, &replies, &queued, &reply, &errorText, &context, &pending, &recipe, &deleted)
	if events+sources+assets+replies != 0 || queued != 1 || reply != "" || errorText != "" || context != "{}" || pending != nil || recipe != nil || !deleted {
		t.Fatalf("content left: events=%d sources=%d assets=%d replies=%d queued=%d reply=%q context=%s pending=%v recipe=%v deleted=%v", events, sources, assets, replies, queued, reply, context, pending, recipe, deleted)
	}
	// The recipe made in it stays as it was.
	if kept, e := a.ownRecipe(ctx, "cook", state.RecipeID); e != nil || kept.Title != r.Title {
		t.Fatalf("recipe lost: %v", e)
	}
	// Everywhere else it is gone.
	status, b := studioReq(t, f, "GET", "/studio", "cook", "", nil)
	var listed []struct{ ID string }
	if status != 200 || json.Unmarshal(b, &listed) != nil || len(listed) != 0 {
		t.Fatalf("listed: %d %s", status, b)
	}
	if status, b = studioReq(t, f, "GET", "/studio/"+p+"/events", "cook", "", nil); status != 200 || strings.TrimSpace(string(b)) != "[]" {
		t.Fatalf("events: %d %s", status, b)
	}
	startFakeLive(t, a, 201, 0)
	for _, request := range []struct{ method, path, key string }{{"GET", "/studio/" + p, ""}, {"POST", "/studio/" + p + "/messages", "after-delete"}, {"PUT", "/studio/" + p + "/context", ""}, {"POST", "/studio/" + p + "/voice", ""}, {"DELETE", "/studio/" + p, ""}} {
		if status, _ := studioReq(t, f, request.method, request.path, "cook", request.key, map[string]any{"text": "Hello", "screen": "planner", "sdp": "v=0"}); status != 404 {
			t.Fatalf("%s %s on a deleted conversation: %d", request.method, request.path, status)
		}
	}
}

func TestDeletingAConversationStopsItsTurns(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	f := studioServer(a)
	say(t, a, p, "Plan dinner for the week.")
	var through int64
	if e := a.DB.QueryRow(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,through_seq,status,estimated_cost) SELECT 'running',$1,'chat_'||$1,'running',max(seq),'running',0.2 FROM voice_events WHERE project_id=$1 RETURNING through_seq`, p).Scan(&through); e != nil {
		t.Fatal(e)
	}
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,status,estimated_cost) VALUES('waiting',$1,'chat_'||$1,'waiting','queued',0.18)`, p); e != nil {
		t.Fatal(e)
	}
	// The user deletes the conversation while its turn is with the provider.
	deleted := 0
	studioAgent(t, a, func(agentRound) any {
		req := httptest.NewRequest("DELETE", "/studio/"+p, nil)
		req.Header.Set("Test-User", "cook")
		if res, e := f.Test(req); e == nil {
			deleted = res.StatusCode
			res.Body.Close()
		}
		return map[string]any{"content": "Here's your plan."}
	})
	// The turn started before the deletion, as the worker would have claimed it.
	state, _ := a.studioState(ctx, p, through)
	run := &agentRun{state: state}
	input, e := a.agentInput(ctx, state)
	if e != nil {
		t.Fatal(e)
	}
	reply, cost, e := a.AI.Agent(ctx, input, nil, agentTools, func(name string, args json.RawMessage) string { return a.agentTool(ctx, run, name, args) })
	if e != nil || deleted != 204 {
		t.Fatalf("turn %v, delete %d", e, deleted)
	}
	// Its answer arrives after the deletion and is not written back.
	if e = a.settleTurn(ctx, "running", p, run, reply, cost, false, false); e != nil {
		t.Fatal(e)
	}
	var events int
	var running, waiting string
	var runningCost, waitingCost float64
	a.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM voice_events WHERE project_id=$1),
 (SELECT status FROM voice_actions WHERE id='running'),(SELECT estimated_cost FROM voice_actions WHERE id='running'),
 (SELECT status FROM voice_actions WHERE id='waiting'),(SELECT estimated_cost FROM voice_actions WHERE id='waiting')`, p).Scan(&events, &running, &runningCost, &waiting, &waitingCost)
	// The turn in flight keeps its reservation; the waiting one never reached the provider.
	if events != 0 || running != "failed" || runningCost != .2 || waiting != "failed" || waitingCost != 0 {
		t.Fatalf("events=%d running=%s %v waiting=%s %v", events, running, runningCost, waiting, waitingCost)
	}
	if _, _, _, ok := a.claimTurn(ctx); ok {
		t.Fatal("claimed a turn of a deleted conversation")
	}
}

func TestDeletedConversationsArePurgedAfter35Days(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	f := studioServer(a)
	recent := uuid.NewString()
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_projects(id,user_id) VALUES($1,'cook')`, recent); e != nil {
		t.Fatal(e)
	}
	say(t, a, p, "Plan dinner.")
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,status) VALUES('old-turn',$1,'chat_'||$1,'old-turn','completed')`, p); e != nil {
		t.Fatal(e)
	}
	for _, id := range []string{p, recent} {
		if status, _ := studioReq(t, f, "DELETE", "/studio/"+id, "cook", "", nil); status != 204 {
			t.Fatal(status)
		}
	}
	if _, e := a.DB.Exec(ctx, `UPDATE voice_projects SET deleted_at=now()-interval '36 days' WHERE id=$1`, p); e != nil {
		t.Fatal(e)
	}
	if e := a.purgeDeletedConversations(ctx); e != nil {
		t.Fatal(e)
	}
	var shells, turns, sessions int
	a.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM voice_projects WHERE id=$1),(SELECT count(*) FROM voice_actions WHERE project_id=$1),(SELECT count(*) FROM voice_sessions WHERE project_id=$1)`, p).Scan(&shells, &turns, &sessions)
	if shells+turns+sessions != 0 {
		t.Fatalf("old shell left: %d %d %d", shells, turns, sessions)
	}
	// One deleted today still holds its usage records.
	if a.DB.QueryRow(ctx, `SELECT count(*) FROM voice_projects WHERE id=$1`, recent).Scan(&shells); shells != 1 {
		t.Fatal("purged a recent deletion")
	}
}
