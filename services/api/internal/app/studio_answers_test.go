package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

// tapTurn sends a message as the app does, and runs its turn as the worker would.
func tapTurn(t *testing.T, a *App, f *fiber.App, p string, body map[string]any) {
	t.Helper()
	if status, b := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", uuid.NewString(), body); status != 202 {
		t.Fatalf("message %d %s", status, b)
	}
	var id string
	var through int64
	if e := a.DB.QueryRow(context.Background(), `UPDATE voice_actions SET status='running' WHERE project_id=$1 AND status='queued' RETURNING id,through_seq`, p).Scan(&id, &through); e != nil {
		t.Fatal(e)
	}
	a.processVoiceAction(context.Background(), id, p, through)
}

// waiting is the question the app sees the conversation waiting on.
func waiting(t *testing.T, f *fiber.App, p string) (kind string, seq int64) {
	t.Helper()
	var got struct {
		Question *struct {
			Kind string
			Seq  int64
		}
	}
	if status, b := studioReq(t, f, "GET", "/studio/"+p, "cook", "", nil); status != 200 || json.Unmarshal(b, &got) != nil {
		t.Fatalf("conversation %d %s", status, b)
	}
	if got.Question == nil {
		return "", 0
	}
	return got.Question.Kind, got.Question.Seq
}

func TestATappedYesDoesWhatWasAskedAndNoLeavesIt(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	_ = persistRecipe(ctx, a.DB, "cook", "mine", exampleVoiceRecipe(), false)
	exists := func() bool { _, e := a.ownRecipe(ctx, "cook", "mine"); return e == nil }
	var answered map[string]any
	var awaiting any
	studioAgent(t, a, func(r agentRound) any {
		switch {
		case r.said() == "Delete my lemon toast." && !r.answered():
			return orderedCalls("delete_recipe", map[string]any{"recipe_id": "mine"})
		case r.said() == "Delete my lemon toast.":
			return map[string]any{"content": "Delete “Lemon toast” for good?"}
		}
		answered, _ = r.input()["answered"].(map[string]any)
		awaiting = r.input()["awaitingConfirmation"]
		return map[string]any{"content": "Done."}
	})

	studioTurn(t, ctx, a, p, "Delete my lemon toast.")
	kind, seq := waiting(t, f, p)
	if kind != "action" || seq == 0 {
		t.Fatalf("no question for the app: %q %d", kind, seq)
	}
	// A tap on an older question does nothing.
	if status, _ := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", uuid.NewString(), map[string]any{"text": "Yes", "answer": "yes", "question": seq - 1}); status != 409 {
		t.Fatalf("a stale answer was accepted: %d", status)
	}
	// No leaves it undone, and the model only acknowledges it.
	tapTurn(t, a, f, p, map[string]any{"text": "No", "answer": "no", "question": seq})
	if !exists() || answered["answer"] != "no" || awaiting != nil {
		t.Fatalf("no wasn't respected: %v %v %v", exists(), answered, awaiting)
	}
	if kind, _ := waiting(t, f, p); kind != "" {
		t.Fatal("the question still waits after no")
	}
	// Yes does what was described before the model replies, whatever the model makes of it.
	studioTurn(t, ctx, a, p, "Delete my lemon toast.")
	_, seq = waiting(t, f, p)
	tapTurn(t, a, f, p, map[string]any{"text": "Yes", "answer": "yes", "question": seq})
	if exists() {
		t.Fatal("a tapped yes didn't delete the recipe")
	}
	if answered["answer"] != "yes" || !strings.Contains(fmt.Sprint(answered["action"]), "Lemon toast") || answered["result"] == nil || awaiting != nil {
		t.Fatalf("the model wasn't told what happened: %v %v", answered, awaiting)
	}
}

func TestATappedPublishFollowsTheReadBack(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	recipe := exampleVoiceRecipe()
	studioAgent(t, a, func(r agentRound) any {
		switch {
		case r.said() == "Save it." && !r.answered():
			return orderedCalls("save_recipe_draft", map[string]any{"recipe": recipe})
		case r.said() == "Read it back." && !r.answered():
			return orderedCalls("read_back_draft", map[string]any{})
		case r.answered():
			return map[string]any{"content": "Here it is. Shall I publish it?"}
		}
		return map[string]any{"content": "Published."}
	})
	studioTurn(t, ctx, a, p, "Save it.")
	if kind, _ := waiting(t, f, p); kind != "" {
		t.Fatalf("a question waits before the read-back: %q", kind)
	}
	studioTurn(t, ctx, a, p, "Read it back.")
	kind, seq := waiting(t, f, p)
	if kind != "publish" {
		t.Fatalf("no publish question after the read-back: %q", kind)
	}
	tapTurn(t, a, f, p, map[string]any{"text": "Publish it", "answer": "yes", "question": seq})
	if state, _ := a.studioState(ctx, p, 0); state.Recipe == nil || !state.Recipe.Published {
		t.Fatal("a tapped publish didn't publish the read-back draft")
	}
}

func TestAnAnswerCountsOnlyAfterTheQuestion(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	tool := func(run *agentRun, name string, args any) string { return a.agentTool(ctx, run, name, jsonBytes(args)) }
	mine := func() bool { _, e := a.ownRecipe(ctx, "cook", "mine"); return e == nil }
	_ = persistRecipe(ctx, a.DB, "cook", "mine", exampleVoiceRecipe(), false)
	tool(agentTurn(t, a, p), "delete_recipe", map[string]any{"recipe_id": "mine"})
	// Said while the sous-chef was still working, before it asked: not an answer.
	say(t, a, p, "Yes, and add milk.")
	asked(t, a, p, "Delete “Lemon toast” for good?")
	if out := tool(agentTurn(t, a, p), "confirm_action", nil); !strings.Contains(out, "Wait for the user") || !mine() {
		t.Fatalf("words from before the question confirmed it: %s", out)
	}
	say(t, a, p, "Yes, delete it.")
	if tool(agentTurn(t, a, p), "confirm_action", nil); mine() {
		t.Fatal("the answer after the question didn't confirm it")
	}

	// In a live call the answer must also follow the assistant starting to read the question.
	_ = persistRecipe(ctx, a.DB, "cook", "mine", exampleVoiceRecipe(), false)
	tool(agentTurn(t, a, p), "delete_recipe", map[string]any{"recipe_id": "mine"})
	asked(t, a, p, "Delete “Lemon toast” for good?")
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) VALUES('live-1',$1,'cook','closed',60,15,true,now())`, p); e != nil {
		t.Fatal(e)
	}
	spoken := func(role, text string) {
		if _, e := a.DB.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES($1,'live-1',$2,$3,$4)`, p, uuid.NewString(), role, text); e != nil {
			t.Fatal(e)
		}
	}
	spoken("user", "Yes.")
	if out := tool(agentTurn(t, a, p), "confirm_action", nil); !strings.Contains(out, "Wait for the user") || !mine() {
		t.Fatalf("speech before the question was read out confirmed it: %s", out)
	}
	spoken("assistant", "Delete Lemon toast for good?")
	spoken("user", "Yes, delete it.")
	if tool(agentTurn(t, a, p), "confirm_action", nil); mine() {
		t.Fatal("the spoken answer after the question didn't confirm it")
	}
}

func TestRemovingABatchOrACookbookAndProfileChangesWaitForAYes(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	tool := func(name string, args any) string { return a.agentTool(ctx, agentTurn(t, a, p), name, jsonBytes(args)) }
	if _, e := a.DB.Exec(ctx, `INSERT INTO groceries(id,user_id,name) VALUES('g1','cook','Milk'),('g2','cook','Eggs'),('g3','cook','Apples'),('g4','cook','Bread'),('g5','cook','Rice'),('g6','cook','Salt');
 INSERT INTO collections(id,user_id,name) VALUES('c1','cook','Weeknight')`); e != nil {
		t.Fatal(e)
	}
	count := func(table string) (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE user_id='cook'`).Scan(&n)
		return n
	}
	if out := tool("remove", map[string]any{"kind": "grocery", "ids": []string{"g1", "g2"}}); !strings.Contains(out, `"removed":2`) || count("groceries") != 4 {
		t.Fatalf("a small removal waited or failed: %s", out)
	}
	out := tool("remove", map[string]any{"kind": "grocery", "ids": []string{"g3", "g4", "g5", "g6"}})
	if !strings.Contains(out, "needsConfirmation") || !strings.Contains(out, "Remove 4 items from your grocery list: Apples; Bread; Rice; Salt.") || count("groceries") != 4 {
		t.Fatalf("a batch removal didn't wait: %s", out)
	}
	out = tool("remove", map[string]any{"kind": "cookbook", "ids": []string{"c1"}})
	if !strings.Contains(out, "Delete your cookbook “Weeknight”. The recipes in it stay saved.") || count("collections") != 1 {
		t.Fatalf("a cookbook deletion didn't wait: %s", out)
	}
	out = tool("update_profile", map[string]any{"name": "Robin", "allergies": []string{"peanuts"}})
	if !strings.Contains(out, "Change your name to “Robin”, your allergies to peanuts.") {
		t.Fatalf("a profile change didn't wait: %s", out)
	}
	if out = tool("update_profile", map[string]any{"name": "Test cook"}); !strings.Contains(out, "wouldn't change anything") {
		t.Fatalf("a no-op profile change was proposed: %s", out)
	}
}

// More than three removals in one turn wait for a yes, however the model splits them.
func TestABatchSplitAcrossCallsStillWaitsForAYes(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	if _, e := a.DB.Exec(ctx, `INSERT INTO groceries(id,user_id,name) VALUES('g1','cook','Milk'),('g2','cook','Eggs'),('g3','cook','Apples'),('g4','cook','Bread'),('g5','cook','Rice')`); e != nil {
		t.Fatal(e)
	}
	left := func() (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM groceries WHERE user_id='cook'`).Scan(&n)
		return n
	}
	run := agentTurn(t, a, p)
	remove := func(run *agentRun, ids ...string) string {
		return a.agentTool(ctx, run, "remove", jsonBytes(map[string]any{"kind": "grocery", "ids": ids}))
	}
	if out := remove(run, "g1", "g2", "g3"); !strings.Contains(out, `"removed":3`) {
		t.Fatalf("a small removal waited or failed: %s", out)
	}
	if out := remove(run, "g4", "g5"); !strings.Contains(out, "needsConfirmation") || left() != 2 {
		t.Fatalf("the rest of a split batch didn't wait: %s", out)
	}
	// The next turn counts afresh.
	if out := remove(agentTurn(t, a, p), "g4"); !strings.Contains(out, `"removed":1`) {
		t.Fatalf("a later turn's removal waited: %s", out)
	}
}

func TestADraftOnlyPromisesTheMediaThatsComing(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, _ := studioFixture(t)
	ctx := context.Background()
	build := func(plan string) string {
		t.Helper()
		if _, e := a.DB.Exec(ctx, `UPDATE users SET plan=$1,plan_status='active' WHERE id='cook'`, plan); e != nil {
			t.Fatal(e)
		}
		p := uuid.NewString()
		if _, e := a.DB.Exec(ctx, `INSERT INTO voice_projects(id,user_id) VALUES($1,'cook')`, p); e != nil {
			t.Fatal(e)
		}
		state, _ := a.studioState(ctx, p, 0)
		r := exampleVoiceRecipe()
		reply, e := a.applyDraftAction(ctx, state, "build", &r, false)
		if e != nil {
			t.Fatal(e)
		}
		return reply
	}
	// Step clips are only made when the cook asks, so even Pro's draft gets just its photo.
	if reply := build("pro"); !strings.Contains(reply, "Its cover photo is being prepared.") || strings.Contains(reply, "video") || strings.Contains(reply, "clip") {
		t.Fatalf("pro: %s", reply)
	}
	if reply := build("plus"); !strings.Contains(reply, "Its cover photo is being prepared.") || strings.Contains(reply, "video") {
		t.Fatalf("plus: %s", reply)
	}
	// Free includes one photo a month, already used by the plus draft above.
	if reply := build("free"); !strings.Contains(reply, "No cover photo is being made: You've used your plan's AI photos for the last 30 days.") || strings.Contains(reply, "being prepared") {
		t.Fatalf("a used-up allowance was promised a photo: %s", reply)
	}
}

func TestATurnThatFailsBeforeTheModelIsFree(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	calls := 0
	studioAgent(t, a, func(r agentRound) any { calls++; return map[string]any{"content": "Hello."} })
	// The photo's private copy can't be read, so the turn fails before reaching the model.
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_sources(id,project_id,object_key,mime) VALUES('photo',$1,'recipe-sources/cook/photo.jpg','image/jpeg')`, p); e != nil {
		t.Fatal(e)
	}
	a.Media.S3 = nil
	tapTurn(t, a, f, p, map[string]any{"text": "Here's my recipe.", "images": []string{"photo"}})
	var status string
	var cost float64
	if e := a.DB.QueryRow(ctx, `SELECT status,estimated_cost FROM voice_actions WHERE project_id=$1`, p).Scan(&status, &cost); e != nil {
		t.Fatal(e)
	}
	u, _ := usageOf(ctx, a.DB, "cook")
	if calls != 0 || status != "failed" || cost != 0 || u.Assistant != 0 {
		t.Fatalf("a turn that never reached the model was charged: calls %d, %s, cost %v, counted %d", calls, status, cost, u.Assistant)
	}
	// A turn that reaches the model counts. (The photo above goes with the next message too, so
	// this one is in a conversation of its own.)
	other := uuid.NewString()
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_projects(id,user_id) VALUES($1,'cook')`, other); e != nil {
		t.Fatal(e)
	}
	tapTurn(t, a, f, other, map[string]any{"text": "Hello"})
	if u, _ = usageOf(ctx, a.DB, "cook"); calls != 1 || u.Assistant != 1 {
		t.Fatalf("a completed turn: calls %d, counted %d", calls, u.Assistant)
	}
}

func TestRepliesSayWhetherTheyChangedTheMembersData(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	studioAgent(t, a, func(r agentRound) any {
		if r.said() == "Add milk." && !r.answered() {
			return orderedCalls("add_groceries", map[string]any{"items": []any{map[string]any{"name": "Milk"}}})
		}
		return map[string]any{"content": "Okay."}
	})
	studioTurn(t, ctx, a, p, "Add milk.")
	studioTurn(t, ctx, a, p, "Thanks.")
	var events []struct {
		Role    string
		Changed bool
	}
	if status, b := studioEventsOf(t, f, p, "cook"); status != 200 || json.Unmarshal(b, &events) != nil {
		t.Fatalf("events %d %s", status, b)
	}
	got := []bool{}
	for _, e := range events {
		if e.Role == "assistant" {
			got = append(got, e.Changed)
		}
	}
	if fmt.Sprint(got) != "[true false]" {
		t.Fatalf("replies' changed flags: %v", got)
	}
}
