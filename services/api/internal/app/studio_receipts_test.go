package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

type receipt struct {
	Kind     string
	Count    int
	Title    string
	Page     string
	Undoable bool
	Undone   bool
}

// lastReply is the newest reply as the app reads it.
func lastReply(t *testing.T, f *fiber.App, p string) (seq int64, effects []receipt, failed bool, content string) {
	t.Helper()
	var events []struct {
		Seq     int64
		Role    string
		Content string
		Failed  bool
		Effects []receipt
	}
	status, b := studioEventsOf(t, f, p, "cook")
	if status != 200 || json.Unmarshal(b, &events) != nil {
		t.Fatalf("events %d %s", status, b)
	}
	if strings.Contains(string(b), `"undo"`) {
		t.Fatalf("undo details reached the app: %s", b)
	}
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Role == "assistant" {
			return events[i].Seq, events[i].Effects, events[i].Failed, events[i].Content
		}
	}
	t.Fatal("no reply")
	return
}

func undo(t *testing.T, f *fiber.App, p, who string, seq int64, index int) int {
	t.Helper()
	status, _ := studioReq(t, f, "POST", "/studio/"+p+"/undo", who, "", map[string]any{"seq": seq, "index": index})
	return status
}

func TestRepliesCarryReceiptsAndUndoTakesThemBack(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	_ = persistRecipe(ctx, a.DB, "other", "toast", public, false)
	_ = persistRecipe(ctx, a.DB, "other", "soup", public, false)
	calls := map[string]any{}
	var input map[string]any
	studioAgent(t, a, func(r agentRound) any {
		input = r.input()
		if call, ok := calls[r.said()]; ok && !r.answered() {
			return call
		}
		return map[string]any{"content": "Done."}
	})
	turn := func(text string, call map[string]any) (int64, []receipt) {
		t.Helper()
		calls[text] = call
		studioTurn(t, ctx, a, p, text)
		seq, effects, _, _ := lastReply(t, f, p)
		return seq, effects
	}
	count := func(query string, args ...any) (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM `+query, args...).Scan(&n)
		return n
	}

	seq, effects := turn("Add milk and eggs.", orderedCalls("add_groceries", map[string]any{"items": []any{map[string]any{"name": "Milk"}, map[string]any{"name": "Eggs"}}}))
	if len(effects) != 1 || effects[0].Kind != "groceries" || effects[0].Count != 2 || effects[0].Page != "planner" || !effects[0].Undoable {
		t.Fatalf("groceries receipt: %+v", effects)
	}
	if status := undo(t, f, p, "other", seq, 0); status != 404 {
		t.Fatalf("someone else undid it: %d", status)
	}
	if status := undo(t, f, p, "cook", seq, 0); status != 200 || count(`groceries WHERE user_id='cook'`) != 0 {
		t.Fatalf("undo didn't take the groceries back: %d", status)
	}
	if _, effects, _, _ = lastReply(t, f, p); !effects[0].Undone || effects[0].Undoable {
		t.Fatalf("receipt not marked undone: %+v", effects)
	}
	if status := undo(t, f, p, "cook", seq, 0); status != 409 {
		t.Fatalf("undone twice: %d", status)
	}

	// A meal planned over another goes back to the one before; one planned on an empty slot goes.
	if _, e := a.DB.Exec(ctx, `INSERT INTO meal_plans(id,user_id,recipe_id,day,meal,servings) VALUES('m1','cook','soup','2026-10-20','Dinner',3)`); e != nil {
		t.Fatal(e)
	}
	seq, effects = turn("Plan toast for dinner.", orderedCalls("plan_meal", map[string]any{"recipe_id": "toast", "day": "2026-10-20", "meal": "Dinner", "servings": 2}))
	if effects[0].Kind != "plan" || effects[0].Title != "Lemon toast" {
		t.Fatalf("plan receipt: %+v", effects)
	}
	undo(t, f, p, "cook", seq, 0)
	if count(`meal_plans WHERE user_id='cook' AND recipe_id='soup' AND servings=3`) != 1 {
		t.Fatal("the meal planned over didn't come back")
	}
	seq, _ = turn("Plan toast for lunch.", orderedCalls("plan_meal", map[string]any{"recipe_id": "toast", "day": "2026-10-20", "meal": "Lunch", "servings": 2}))
	undo(t, f, p, "cook", seq, 0)
	if count(`meal_plans WHERE user_id='cook' AND meal='Lunch'`) != 0 {
		t.Fatal("a newly planned meal stayed")
	}

	// Pantry, saving, following, cookbooks and checking off all go back the same way.
	if _, e := a.DB.Exec(ctx, `INSERT INTO pantry(id,user_id,name,quantity) VALUES('p1','cook','rice','1 kg'); INSERT INTO groceries(id,user_id,name) VALUES('g1','cook','Salt')`); e != nil {
		t.Fatal(e)
	}
	seq, _ = turn("I have 2 kg of rice.", orderedCalls("set_pantry_item", map[string]any{"name": "Rice", "quantity": "2 kg"}))
	undo(t, f, p, "cook", seq, 0)
	if count(`pantry WHERE user_id='cook' AND name='rice' AND quantity='1 kg'`) != 1 {
		t.Fatal("the pantry quantity didn't come back")
	}
	seq, effects = turn("Save the toast and follow its cook.", orderedCalls("save_recipe", map[string]any{"recipe_id": "toast"}, "follow_cook", map[string]any{"cook_id": "other"}))
	if len(effects) != 2 || effects[0].Kind != "saved" || effects[1].Kind != "followed" {
		t.Fatalf("save and follow receipts: %+v", effects)
	}
	undo(t, f, p, "cook", seq, 0)
	undo(t, f, p, "cook", seq, 1)
	if count(`saves WHERE user_id='cook'`)+count(`follows WHERE user_id='cook'`) != 0 {
		t.Fatal("save or follow stayed after undo")
	}
	seq, _ = turn("Make a Weeknight cookbook and check off salt.", orderedCalls("create_cookbook", map[string]any{"name": "Weeknight"}, "check_grocery", map[string]any{"grocery_id": "g1", "checked": true}))
	undo(t, f, p, "cook", seq, 0)
	undo(t, f, p, "cook", seq, 1)
	if count(`collections WHERE user_id='cook'`)+count(`groceries WHERE id='g1' AND checked`) != 0 {
		t.Fatal("cookbook or check-off stayed after undo")
	}

	// The next turn knows what was taken back.
	turn("What's left?", nil)
	undone, _ := input["undoneByUser"].([]any)
	if len(undone) < 8 || !strings.Contains(strings.Join(func() []string {
		s := []string{}
		for _, u := range undone {
			s = append(s, u.(string))
		}
		return s
	}(), "|"), "planned a meal: Lemon toast") {
		t.Fatalf("the model wasn't told what was undone: %v", input["undoneByUser"])
	}
	// What can't be undone says so.
	seq, effects = turn("Remove the salt.", orderedCalls("remove", map[string]any{"kind": "grocery", "ids": []string{"g1"}}))
	if effects[0].Kind != "removed" || effects[0].Undoable || undo(t, f, p, "cook", seq, 0) != 400 {
		t.Fatalf("removal receipt: %+v", effects)
	}
}

func TestATurnSaysWhatItsDoingAndCanBeStopped(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	step := ""
	studioAgent(t, a, func(r agentRound) any {
		if !r.answered() {
			return orderedCalls("search_recipes", map[string]any{"query": "toast"})
		}
		var got struct{ Turn struct{ Step string } }
		_, b := studioReq(t, f, "GET", "/studio/"+p, "cook", "", nil)
		_ = json.Unmarshal(b, &got)
		step = got.Turn.Step
		if status, _ := studioReq(t, f, "POST", "/studio/"+p+"/cancel", "cook", "", nil); status != 202 {
			t.Errorf("cancel %d", status)
		}
		return stall{}
	})
	id := studioTurn(t, ctx, a, p, "Find me toast.")
	status, reply := studioOutcome(t, a, id)
	if step != "looking" || status != "failed" || reply != turnStopped {
		t.Fatalf("a stopped turn: step %q, %s %q", step, status, reply)
	}
	if _, _, failed, content := lastReply(t, f, p); !failed || content != turnStopped {
		t.Fatalf("the stop isn't the reply: %v %q", failed, content)
	}
	// A turn still queued never runs, and costs nothing.
	if status, b := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", uuid.NewString(), map[string]any{"text": "Plan dinner."}); status != 202 {
		t.Fatalf("message %d %s", status, b)
	}
	if status, _ := studioReq(t, f, "POST", "/studio/"+p+"/cancel", "cook", "", nil); status != 202 {
		t.Fatalf("cancel %d", status)
	}
	var queued, cost float64
	a.DB.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status IN ('queued','running')),sum(estimated_cost) FILTER (WHERE through_seq=(SELECT max(through_seq) FROM voice_actions WHERE project_id=$1)) FROM voice_actions WHERE project_id=$1`, p).Scan(&queued, &cost)
	if queued != 0 || cost != 0 {
		t.Fatalf("a stopped queued turn: %v still waiting, cost %v", queued, cost)
	}
	if status, _ := studioReq(t, f, "POST", "/studio/"+p+"/cancel", "cook", "", nil); status != 204 {
		t.Fatalf("nothing to stop: %d", status)
	}
}

func TestAFailedReplyIsMarked(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	studioAgent(t, a, func(r agentRound) any { return 502 })
	studioTurn(t, context.Background(), a, p, "Hello.")
	if _, _, failed, content := lastReply(t, f, p); !failed || content != studioTurnFailed {
		t.Fatalf("failed reply: %v %q", failed, content)
	}
}
