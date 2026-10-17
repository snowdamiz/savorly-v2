package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestATurnLeavesATraceForTheAdminConsole(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	a, p := studioFixture(t)
	ctx := context.Background()
	toast := exampleVoiceRecipe()
	toast.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", toast, false); e != nil {
		t.Fatal(e)
	}
	studioAgent(t, a, func(r agentRound) any {
		if !r.answered() {
			return orderedCalls("get_recipe", map[string]any{"recipe_id": "toast"}, "plan_meal", map[string]any{"recipe_id": "missing", "day": "2026-10-20", "meal": "Dinner", "servings": 2})
		}
		return map[string]any{"content": "That one isn't there."}
	})
	id := studioTurn(t, ctx, a, p, "Plan the secret toast.")
	var raw []byte
	if e := a.DB.QueryRow(ctx, `SELECT trace FROM voice_actions WHERE id=$1`, id).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	var trace turnTrace
	if e := json.Unmarshal(raw, &trace); e != nil {
		t.Fatal(e)
	}
	switch {
	case trace.Channel != "text" || trace.Model != a.AI.AgentModel || trace.Ms < 0 || trace.Error != "":
		t.Fatalf("trace: %s", raw)
	case len(trace.Rounds) != 2 || trace.Rounds[0].Cost != .001 || len(trace.Rounds[0].Tools) != 2 || len(trace.Rounds[1].Tools) != 0:
		t.Fatalf("rounds: %s", raw)
	case trace.Rounds[0].Tools[0].Name != "get_recipe" || trace.Rounds[0].Tools[0].Error != "":
		t.Fatalf("first tool: %s", raw)
	case trace.Rounds[0].Tools[1].Name != "plan_meal" || trace.Rounds[0].Tools[1].Error != "Recipe not found.":
		t.Fatalf("a failed tool keeps its error: %s", raw)
	case strings.Contains(string(raw), "secret") || strings.Contains(string(raw), "missing"):
		t.Fatalf("the trace holds what was said or sent: %s", raw)
	}

	// Admins see the turn in a list, and its trace and reply on their own.
	f := adminApp(a.DB, false)
	_, owner := signedIn(t, a.DB, "owner@example.test", true)
	_, member := signedIn(t, a.DB, "member@example.test", true)
	var list struct {
		Items []struct {
			ID, Status, Channel, Model string
			Rounds, ToolErrors         int
			Tools                      []string
			User                       struct{ ID string }
		}
		Total int
	}
	status, b := send(t, f, "GET", "/v1/admin/turns?channel=text&q=cook", owner, nil)
	if status != 200 || json.Unmarshal(b, &list) != nil || list.Total != 1 {
		t.Fatalf("list %d %s", status, b)
	}
	if row := list.Items[0]; row.ID != id || row.Status != "completed" || row.Rounds != 2 || row.ToolErrors != 1 || strings.Join(row.Tools, ",") != "get_recipe,plan_meal" || row.User.ID != "cook" {
		t.Fatalf("row: %+v", row)
	}
	if strings.Contains(string(b), "That one isn't there.") {
		t.Fatalf("the list carries replies: %s", b)
	}
	if status, b = send(t, f, "GET", "/v1/admin/turns?channel=voice", owner, nil); status != 200 || !strings.Contains(string(b), `"total":0`) {
		t.Fatalf("voice turns: %d %s", status, b)
	}
	var one struct {
		Trace turnTrace
		Reply string
	}
	if status, b = send(t, f, "GET", "/v1/admin/turns/"+id, owner, nil); status != 200 || json.Unmarshal(b, &one) != nil || one.Reply != "That one isn't there." || len(one.Trace.Rounds) != 2 {
		t.Fatalf("turn %d %s", status, b)
	}
	if status, _ = send(t, f, "GET", "/v1/admin/turns/"+id, member, nil); status != 403 {
		t.Fatalf("a member read a turn: %d", status)
	}
}

// Every tool the model is offered does something, under one name and with a schema.
func TestEveryToolIsDefinedOnce(t *testing.T) {
	seen := map[string]bool{}
	for _, d := range agentToolDefs {
		if seen[d.Name] || d.do == nil || d.Parameters["type"] != "object" {
			t.Errorf("tool %q: duplicate %v, handler %v, schema %v", d.Name, seen[d.Name], d.do != nil, d.Parameters["type"])
		}
		seen[d.Name] = true
	}
	if len(agentTools) != len(agentToolDefs) || len(agentToolNamed) != len(agentToolDefs) {
		t.Fatalf("%d tools offered, %d named, %d defined", len(agentTools), len(agentToolNamed), len(agentToolDefs))
	}
}
