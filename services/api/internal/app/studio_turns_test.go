package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

// agentRound is one model request of a turn: its input and the tool results so far.
type agentRound struct {
	Messages []map[string]any `json:"messages"`
}

func (r agentRound) input() map[string]any {
	var in map[string]any
	if content, _ := r.Messages[1]["content"].([]any); len(content) > 0 {
		text, _ := content[0].(map[string]any)["text"].(string)
		_ = json.Unmarshal([]byte(text), &in)
	}
	return in
}

// photos counts the images sent with the turn.
func (r agentRound) photos() int {
	content, _ := r.Messages[1]["content"].([]any)
	return len(content) - 1
}

// said is the user's latest message as the turn sees it.
func (r agentRound) said() string {
	conversation, _ := r.input()["conversation"].([]any)
	for i := len(conversation) - 1; i >= 0; i-- {
		if m, _ := conversation[i].(map[string]any); m["role"] == "user" {
			s, _ := m["content"].(string)
			return s
		}
	}
	return ""
}

// results are the tool results the model has seen in this turn.
func (r agentRound) results() string {
	var b strings.Builder
	for _, m := range r.Messages {
		if m["role"] == "tool" {
			s, _ := m["content"].(string)
			b.WriteString(s + "\n")
		}
	}
	return b.String()
}
func (r agentRound) answered() bool { return r.Messages[len(r.Messages)-1]["role"] == "tool" }

// stall makes the provider hold a request until the turn gives up on it.
type stall struct{}

// studioAgent answers each model request with reply's message, an HTTP status for an int, or
// nothing for a stall. reply runs on the server's goroutines.
func studioAgent(t *testing.T, a *App, reply func(agentRound) any) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var round agentRound
		_ = json.NewDecoder(r.Body).Decode(&round)
		switch out := reply(round).(type) {
		case stall:
			<-r.Context().Done()
		case int:
			w.WriteHeader(out)
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": out}}, "usage": map[string]any{"cost": 0.001}})
		}
	}))
	t.Cleanup(server.Close)
	a.AI.OpenRouterURL = server.URL
}

// orderedCalls is a model message calling tools in order: name, arguments (JSON text or a
// value), name, arguments…
func orderedCalls(pairs ...any) map[string]any {
	list := []any{}
	for i := 0; i+1 < len(pairs); i += 2 {
		args, ok := pairs[i+1].(string)
		if !ok {
			args = string(jsonBytes(pairs[i+1]))
		}
		list = append(list, map[string]any{"id": "call_" + strconv.Itoa(i/2), "type": "function", "function": map[string]any{"name": pairs[i], "arguments": args}})
	}
	return map[string]any{"content": "", "tool_calls": list}
}

// studioTurn records the user's message and runs the turn as the worker would, under ctx.
func studioTurn(t *testing.T, ctx context.Context, a *App, p, text string) string {
	t.Helper()
	say(t, a, p, text)
	id := uuid.NewString()
	var through int64
	if e := a.DB.QueryRow(context.Background(), `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,through_seq,status) SELECT $1,$2,'chat_'||$2,$1,max(seq),'running' FROM voice_events WHERE project_id=$2 RETURNING through_seq`, id, p).Scan(&through); e != nil {
		t.Fatal(e)
	}
	a.processVoiceAction(ctx, id, p, through)
	return id
}
func studioOutcome(t *testing.T, a *App, id string) (status, reply string) {
	t.Helper()
	if e := a.DB.QueryRow(context.Background(), `SELECT status,reply FROM voice_actions WHERE id=$1`, id).Scan(&status, &reply); e != nil {
		t.Fatal(e)
	}
	return status, reply
}
func studioPending(t *testing.T, a *App, p string) (pending string, confirmed, revision int) {
	t.Helper()
	var b []byte
	if e := a.DB.QueryRow(context.Background(), `SELECT pending,confirmed_revision,revision FROM voice_projects WHERE id=$1`, p).Scan(&b, &confirmed, &revision); e != nil {
		t.Fatal(e)
	}
	return string(b), confirmed, revision
}

var studioTurnFailed = publicError(errors.New("provider returned HTTP 502"))

func TestFailedTurnLapsesAnEarlierProposal(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	_ = persistRecipe(ctx, a.DB, "cook", "mine", exampleVoiceRecipe(), false)
	confirmed := ""
	studioAgent(t, a, func(r agentRound) any {
		switch {
		case r.answered():
			confirmed += r.results()
			return map[string]any{"content": "Done."}
		case r.said() == "Delete my toast recipe.":
			return orderedCalls("delete_recipe", map[string]any{"recipe_id": "mine"})
		case r.said() == "Yes.":
			return orderedCalls("confirm_action", "{}")
		}
		return 502
	})
	studioTurn(t, ctx, a, p, "Delete my toast recipe.")
	if pending, _, _ := studioPending(t, a, p); !strings.Contains(pending, "delete_recipe") {
		t.Fatalf("deletion not held: %s", pending)
	}
	// "Never mind, what's for dinner?" fails at the provider; the user never sees an answer.
	id := studioTurn(t, ctx, a, p, "Never mind, what's for dinner?")
	if status, reply := studioOutcome(t, a, id); status != "failed" || reply != studioTurnFailed {
		t.Fatalf("failed turn: %s %q", status, reply)
	}
	if pending, _, _ := studioPending(t, a, p); pending != "" {
		t.Fatalf("a failed turn kept the proposal: %s", pending)
	}
	// So a "yes" to something else later can't confirm the old deletion.
	studioTurn(t, ctx, a, p, "Yes.")
	if _, e := a.ownRecipe(ctx, "cook", "mine"); e != nil || !strings.Contains(confirmed, "Nothing is waiting") {
		t.Fatalf("a yes after a failed turn ran the old proposal: %v %s", e, confirmed)
	}
}

func TestFailedTurnLapsesItsOwnReadBack(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	state, _ := a.studioState(ctx, p, 0)
	r := exampleVoiceRecipe()
	if _, e := a.applyDraftAction(ctx, state, "build", &r, false); e != nil {
		t.Fatal(e)
	}
	studioAgent(t, a, func(r agentRound) any {
		switch {
		case r.said() == "Read it back." && !r.answered():
			return orderedCalls("read_back_draft", "{}")
		case r.said() == "Yes, publish it." && !r.answered():
			return orderedCalls("publish_draft", "{}")
		case r.said() == "Yes, publish it.":
			return map[string]any{"content": "Here it is again."}
		}
		return 502 // The read-back is made, then the turn fails before the user hears it.
	})
	id := studioTurn(t, ctx, a, p, "Read it back.")
	if status, _ := studioOutcome(t, a, id); status != "failed" {
		t.Fatal(status)
	}
	if _, confirmed, _ := studioPending(t, a, p); confirmed != -1 {
		t.Fatalf("a read-back the user never heard stayed approvable: %d", confirmed)
	}
	studioTurn(t, ctx, a, p, "Yes, publish it.")
	if state, _ = a.studioState(ctx, p, 0); state.Recipe.Published {
		t.Fatal("published after a read-back the user never heard")
	}
}

func TestTimedOutTurnSettlesAtOnce(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	_ = persistRecipe(ctx, a.DB, "cook", "mine", exampleVoiceRecipe(), false)
	studioAgent(t, a, func(r agentRound) any {
		switch {
		case r.answered():
			return map[string]any{"content": "Done."}
		case r.said() == "Delete my toast recipe.":
			return orderedCalls("delete_recipe", map[string]any{"recipe_id": "mine"})
		}
		return stall{}
	})
	studioTurn(t, ctx, a, p, "Delete my toast recipe.")
	// The turn's own deadline passes mid-request; settling must not reuse it.
	deadline, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	id := studioTurn(t, deadline, a, p, "Never mind, what's for dinner?")
	if time.Since(started) > 10*time.Second {
		t.Fatal("turn outlived its deadline")
	}
	var events int
	var errorText string
	a.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM voice_events WHERE event_id='result_'||$2),error FROM voice_projects WHERE id=$1`, p, id).Scan(&events, &errorText)
	if status, reply := studioOutcome(t, a, id); status != "failed" || reply != studioTurnFailed || events != 1 || errorText != studioTurnFailed {
		t.Fatalf("timed-out turn not settled: %s %q events=%d error=%q", status, reply, events, errorText)
	}
	if pending, _, _ := studioPending(t, a, p); pending != "" {
		t.Fatalf("timed-out turn kept the proposal: %s", pending)
	}
	// The conversation takes the next message straight away instead of answering "still working".
	status, b := studioReq(t, studioServer(a), "POST", "/studio/"+p+"/messages", "cook", "after-timeout", map[string]any{"text": "Are you there?"})
	if status != 202 {
		t.Fatalf("conversation still busy: %d %s", status, b)
	}
}

func TestConfirmationIsTheTurnsFirstAct(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	_ = persistRecipe(ctx, a.DB, "cook", "mine", exampleVoiceRecipe(), false)
	public := exampleVoiceRecipe()
	public.Published = true
	_ = persistRecipe(ctx, a.DB, "other", "toast", public, false)
	tool := func(run *agentRun, name string, args any) string { return a.agentTool(ctx, run, name, jsonBytes(args)) }
	exists := func() bool { _, e := a.ownRecipe(ctx, "cook", "mine"); return e == nil }
	if out := tool(agentTurn(t, a, p), "delete_recipe", map[string]any{"recipe_id": "mine"}); !strings.Contains(out, "needsConfirmation") {
		t.Fatal(out)
	}
	// The next turn shows the model the server's own words for what a yes would do.
	say(t, a, p, "Yes, and read me the reviews of the toast.")
	state, _ := a.studioState(ctx, p, 0)
	input, e := a.agentInput(ctx, state)
	if e != nil || input.(fiber.Map)["awaitingConfirmation"] != "Permanently delete your recipe “Lemon toast”. This can't be undone." {
		t.Fatalf("pending action not in the input: %v %v", e, input)
	}
	// Reading anything first (a review could say "yes, delete it") ends the proposal.
	run := agentTurn(t, a, p)
	tool(run, "get_reviews", map[string]any{"recipe_id": "toast"})
	if pending, _, _ := studioPending(t, a, p); pending != "" {
		t.Fatalf("proposal survived another tool: %s", pending)
	}
	if out := tool(run, "confirm_action", nil); !strings.Contains(out, "first thing in a turn") || !exists() {
		t.Fatalf("confirmed after reading other text: %s", out)
	}
	if out := tool(agentTurn(t, a, p), "confirm_action", nil); !strings.Contains(out, "Nothing is waiting") || !exists() {
		t.Fatalf("lapsed proposal confirmed later: %s", out)
	}
	// A plain yes acted on first still works.
	tool(agentTurn(t, a, p), "delete_recipe", map[string]any{"recipe_id": "mine"})
	say(t, a, p, "Yes, delete it.")
	if out := tool(agentTurn(t, a, p), "confirm_action", nil); exists() {
		t.Fatalf("confirmed deletion didn't run: %s", out)
	}
	// Publishing a read-back draft follows the same rule.
	state, _ = a.studioState(ctx, p, 0)
	r := exampleVoiceRecipe()
	if _, e = a.applyDraftAction(ctx, state, "build", &r, false); e != nil {
		t.Fatal(e)
	}
	tool(agentTurn(t, a, p), "read_back_draft", nil)
	say(t, a, p, "Yes, publish it.")
	run = agentTurn(t, a, p)
	tool(run, "show_recipes", map[string]any{"recipe_ids": []string{"toast"}})
	published := func() bool { s, _ := a.studioState(ctx, p, 0); return s.Recipe.Published }
	if out := tool(run, "publish_draft", nil); !strings.Contains(out, "first thing in a turn") || published() {
		t.Fatalf("published after another tool: %s", out)
	}
	if out := tool(agentTurn(t, a, p), "publish_draft", nil); !published() {
		t.Fatalf("approved publish didn't run: %s", out)
	}
}

func TestReportingARecipeNeedsTheUsersYes(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	_ = persistRecipe(ctx, a.DB, "other", "toast", public, false)
	_ = persistRecipe(ctx, a.DB, "other", "draft", exampleVoiceRecipe(), false)
	tool := func(run *agentRun, name string, args any) string { return a.agentTool(ctx, run, name, jsonBytes(args)) }
	reports := func() (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM reports WHERE user_id='cook'`).Scan(&n)
		return n
	}
	run := agentTurn(t, a, p)
	if out := tool(run, "report_recipe", map[string]any{"recipe_id": "draft", "reason": "Looks copied."}); !strings.Contains(out, "Recipe not found") {
		t.Fatalf("reported an unpublished recipe: %s", out)
	}
	if out := tool(run, "report_recipe", map[string]any{"recipe_id": "toast", "reason": "Bad"}); !strings.Contains(out, "5–1000") {
		t.Fatalf("short reason accepted: %s", out)
	}
	out := tool(run, "report_recipe", map[string]any{"recipe_id": "toast", "reason": "Copied from a cookbook."})
	if !strings.Contains(out, "needsConfirmation") || !strings.Contains(out, "Report “Lemon toast”") || reports() != 0 {
		t.Fatalf("report not held for confirmation: %s", out)
	}
	say(t, a, p, "Yes, report it.")
	tool(agentTurn(t, a, p), "confirm_action", nil)
	var reason string
	a.DB.QueryRow(ctx, `SELECT reason FROM reports WHERE user_id='cook' AND recipe_id='toast'`).Scan(&reason)
	if reports() != 1 || reason != "Copied from a cookbook." {
		t.Fatalf("confirmed report not filed: %d %q", reports(), reason)
	}
}

func TestMalformedToolCallsAndProviderErrorsMidTurn(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	seen := ""
	studioAgent(t, a, func(r agentRound) any {
		switch {
		case r.said() == "Add milk." && !r.answered():
			return orderedCalls("add_groceries", `{"items": [`, "invent_a_tool", "{}")
		case r.said() == "Add milk.":
			seen = r.results()
			return map[string]any{"content": "Sorry, that didn't work. Let me try again."}
		case r.said() == "Add eggs." && !r.answered():
			return orderedCalls("add_groceries", map[string]any{"items": []map[string]string{{"name": "Eggs"}}})
		}
		return 503 // The provider fails after the eggs were added.
	})
	groceries := func() (n int) {
		a.DB.QueryRow(ctx, `SELECT count(*) FROM groceries WHERE user_id='cook'`).Scan(&n)
		return n
	}
	id := studioTurn(t, ctx, a, p, "Add milk.")
	if status, reply := studioOutcome(t, a, id); status != "completed" || !strings.HasPrefix(reply, "Sorry") || groceries() != 0 {
		t.Fatalf("malformed calls broke the turn: %s %q", status, reply)
	}
	if !strings.Contains(seen, "Arguments must be a JSON object") || !strings.Contains(seen, "Unknown tool") {
		t.Fatalf("model wasn't told what was wrong: %s", seen)
	}
	// The eggs are added, then the provider fails: the reply says changes were saved, and the
	// turn keeps its reservation (0.05 here) since the provider reported no cost.
	id = studioTurn(t, ctx, a, p, "Add eggs.")
	var cost float64
	a.DB.QueryRow(ctx, `SELECT estimated_cost FROM voice_actions WHERE id=$1`, id).Scan(&cost)
	if status, reply := studioOutcome(t, a, id); status != "failed" || reply != turnFailedAfterChanges || groceries() != 1 || cost != .05 {
		t.Fatalf("mid-turn failure: %s %q groceries=%d cost=%v", status, reply, groceries(), cost)
	}
}

// studioEvent records one transcript event directly.
func studioEvent(t *testing.T, a *App, p, role, content string, images ...string) {
	t.Helper()
	if images == nil {
		images = []string{}
	}
	_, e := a.DB.Exec(context.Background(), `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) VALUES('chat_'||$1,$1,'cook','closed',0,0,true,now()) ON CONFLICT DO NOTHING`, p)
	if e == nil {
		_, e = a.DB.Exec(context.Background(), `INSERT INTO voice_events(project_id,session_id,event_id,role,content,images) VALUES($1,'chat_'||$1,$2,$3,$4,$5)`, p, uuid.NewString(), role, content, jsonBytes(images))
	}
	if e != nil {
		t.Fatal(e)
	}
}

func TestTurnWindowKeepsTheOpeningRequestAndRecentMessages(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	studioEvent(t, a, p, "assistant", "Hi! What are we cooking?")
	studioEvent(t, a, p, "user", "Lasagna for twelve, ", "opening-photo")
	studioEvent(t, a, p, "user", "with my grandmother's sauce.")
	for i := range 60 {
		studioEvent(t, a, p, "assistant", "Noted "+strconv.Itoa(i)+".")
		studioEvent(t, a, p, "user", "Detail "+strconv.Itoa(i)+".")
	}
	studioEvent(t, a, p, "assistant", "Anything else?")
	studioEvent(t, a, p, "user", "These pages.", "p1", "p2", "p3")
	studioEvent(t, a, p, "assistant", "Got them.")
	studioEvent(t, a, p, "user", "And these.", "p4", "p5")
	w, e := conversationWindow(ctx, a.DB, p, 0)
	if e != nil {
		t.Fatal(e)
	}
	// 126 messages: the opening request (fragments joined) and the newest 40 go.
	if len(w.Messages) != 41 || w.Messages[0].Content != "Lasagna for twelve, with my grandmother's sauce." || w.Messages[40].Content != "And these." || w.Omitted != 126-41 {
		t.Fatalf("window: %d messages, omitted %d, first %q", len(w.Messages), w.Omitted, w.Messages[0].Content)
	}
	// Photos come from the last two user messages only, at most four, newest kept.
	if strings.Join(w.Images, ",") != "p2,p3,p4,p5" {
		t.Fatalf("photos %v", w.Images)
	}
	var last int64
	a.DB.QueryRow(ctx, `SELECT max(seq) FROM voice_events WHERE project_id=$1`, p).Scan(&last)
	if w.Through != last {
		t.Fatalf("through %d, want %d", w.Through, last)
	}
	// A turn sees only what was said up to its own message.
	early, _ := conversationWindow(ctx, a.DB, p, last-2)
	if early.Messages[len(early.Messages)-1].Content != "These pages." || strings.Join(early.Images, ",") != "p1,p2,p3" {
		t.Fatalf("earlier turn saw later events: %v", early.Images)
	}
	// Long messages use up the byte budget sooner; the newest always goes, and the photos of
	// the user's last two messages still do.
	studioEvent(t, a, p, "assistant", strings.Repeat("A long answer. ", 1000))
	studioEvent(t, a, p, "user", strings.Repeat("A long dictation. ", 2000))
	w, _ = conversationWindow(ctx, a.DB, p, 0)
	if len(w.Messages) != 2 || w.Bytes != len(strings.Repeat("A long dictation. ", 2000))+len("Lasagna for twelve, with my grandmother's sauce.") || strings.Join(w.Images, ",") != "p4,p5" {
		t.Fatalf("budget: %d messages, %d bytes, photos %v", len(w.Messages), w.Bytes, w.Images)
	}
}

func TestLongConversationsStayWithinTheFreeAllowance(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	ctx := context.Background()
	if _, e := a.DB.Exec(ctx, `UPDATE users SET plan='free',plan_status='' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	// Eighty long messages and a dozen recipe photos, all well before the latest exchange.
	for i := range 40 {
		var photos []string
		if i < 12 {
			photos = []string{"old-photo-" + strconv.Itoa(i)}
		}
		studioEvent(t, a, p, "user", strings.Repeat("Another detail about the stock. ", 50), photos...)
		studioEvent(t, a, p, "assistant", strings.Repeat("Noted, and here is a thought. ", 50))
	}
	f := studioServer(a)
	status, b := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "long-conversation", map[string]any{"text": "What should I do with the bones?"})
	if status != 202 {
		t.Fatalf("a long conversation was refused: %d %s", status, b)
	}
	var id string
	var through int64
	var reserved float64
	a.DB.QueryRow(ctx, `SELECT id,through_seq,estimated_cost FROM voice_actions WHERE project_id=$1`, p).Scan(&id, &through, &reserved)
	w, _ := conversationWindow(ctx, a.DB, p, through)
	// Before windowing this reserved $2.49 (every byte and photo, every round) against a $0.50 cap.
	if reserved >= plans[0].SpendCap || reserved < turnEstimate(w)-.0001 || reserved > turnEstimate(w)+.0001 {
		t.Fatalf("reserved %v for window %d bytes, %d photos", reserved, w.Bytes, len(w.Images))
	}
	// The turn sends that window and no old photos.
	var sent agentRound
	studioAgent(t, a, func(r agentRound) any { sent = r; return map[string]any{"content": "Make stock."} })
	if _, e := a.DB.Exec(ctx, `UPDATE voice_actions SET status='running' WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	a.processVoiceAction(ctx, id, p, through)
	in := sent.input()
	conversation, _ := in["conversation"].([]any)
	if sent.photos() != 0 || len(conversation) != len(w.Messages) || in["earlierMessagesOmitted"] != float64(w.Omitted) || w.Omitted == 0 {
		t.Fatalf("sent %d photos, %d messages, omitted %v", sent.photos(), len(conversation), in["earlierMessagesOmitted"])
	}
	if status, _ := studioOutcome(t, a, id); status != "completed" {
		t.Fatal(status)
	}
}
