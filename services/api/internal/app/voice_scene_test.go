package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// handshake is the next session request the API sent.
func (f *fakeLive) handshake(t *testing.T) map[string]any {
	t.Helper()
	select {
	case body := <-f.created:
		return body
	case <-time.After(10 * time.Second):
		t.Fatal("no handshake")
	}
	return nil
}

// paceVoice runs voice monitors' ticks every d for one test.
func paceVoice(t *testing.T, d time.Duration) {
	was := voiceTick
	voiceTick = d
	t.Cleanup(func() { voiceTick = was })
}

func TestVoiceKnowsWhatTheUserHasOpen(t *testing.T) {
	paceVoice(t, 100*time.Millisecond)
	a, p := studioFixture(t)
	ctx := context.Background()
	f := studioServer(a)
	runVoice(t, a)
	provider := startFakeLive(t, a, 201, 0)
	toast := exampleVoiceRecipe()
	toast.Published = true
	toast.Steps = append(toast.Steps, Step{Text: "Grate lemon zest over the top.", Seconds: 90}, Step{Text: "Drizzle with olive oil."})
	secret := exampleVoiceRecipe()
	secret.Title = "Secret stew"
	if e := persistRecipe(ctx, a.DB, "other", "toast", toast, false); e != nil {
		t.Fatal(e)
	}
	if e := persistRecipe(ctx, a.DB, "other", "secret", secret, false); e != nil {
		t.Fatal(e)
	}
	if e := persistRecipe(ctx, a.DB, "cook", "mine", exampleVoiceRecipe(), false); e != nil {
		t.Fatal(e)
	}
	if _, e := a.DB.Exec(ctx, `UPDATE users SET preferences='{"diets":["vegetarian"],"allergies":["peanuts"]}' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	view := func(body map[string]any) {
		t.Helper()
		if status, b := studioReq(t, f, "PUT", "/studio/"+p+"/context", "cook", "", body); status != 204 {
			t.Fatalf("context %d %s", status, b)
		}
	}
	update := func(want ...string) string {
		t.Helper()
		c := provider.await(t, "session.instructions.append")
		content, _ := c["content"].(string)
		if c["delegation_id"] != nil {
			t.Fatalf("an update tied to a delegation: %v", c)
		}
		for _, w := range want {
			if !strings.Contains(content, w) {
				t.Fatalf("update lacks %q:\n%s", w, content)
			}
		}
		return content
	}

	view(map[string]any{"screen": "discover", "recipeId": "toast", "cookingStep": 2, "timeZone": "Europe/Berlin", "language": "de"})
	if status, _ := startVoice(t, a, p); status != 201 {
		t.Fatal(status)
	}
	session, _ := provider.handshake(t)["session"].(map[string]any)
	instructions, _ := session["instructions"].(string)
	for _, want := range []string{"App language: German.", "The user's diets: vegetarian.", "The user's allergies: peanuts.", "Open recipe: “Lemon toast” by ", "Ingredients: 2 slices Bread.", "2. Grate lemon zest over the top. (timer 1 min 30 s)", "In cooking mode, the user is on step 2 of 3: Grate lemon zest"} {
		if !strings.Contains(instructions, want) {
			t.Fatalf("instructions lack %q:\n%s", want, instructions)
		}
	}
	// As the user moves on, the voice model hears it as quiet, session-wide context.
	view(map[string]any{"screen": "discover", "recipeId": "toast", "cookingStep": 3, "language": "de"})
	update("App context update.", "step 3 of 3: Drizzle with olive oil.")
	view(map[string]any{"screen": "planner", "language": "de"})
	update("Open page: Meal planner")
	// A recipe the user may not see is never described; a new language still is.
	view(map[string]any{"screen": "planner", "recipeId": "secret", "language": "fr"})
	if content := update("The app language is now French."); strings.Contains(content, "Secret stew") {
		t.Fatal(content)
	}
	// The user's own recipe, changed while it is open, is described again.
	view(map[string]any{"screen": "planner", "recipeId": "mine", "language": "fr"})
	update("“Lemon toast”, the user's own recipe, serves 2")
	if _, e := a.DB.Exec(ctx, `UPDATE recipes SET servings=4 WHERE id='mine'`); e != nil {
		t.Fatal(e)
	}
	update("The open recipe just changed.", "serves 4")
}

// voiceTurn runs the turn a live call delegated, as the worker would.
func voiceTurn(t *testing.T, a *App, provider *fakeLive, p, said, delegation string) (id string) {
	t.Helper()
	ctx := context.Background()
	provider.events <- map[string]any{"type": "session.input_transcript.delta", "event_id": "in-" + delegation, "delta": said}
	provider.events <- map[string]any{"type": "session.delegation.created", "delegation": map[string]any{"id": delegation}}
	var through int64
	eventually(t, "the delegated turn", func() bool {
		return a.DB.QueryRow(ctx, `UPDATE voice_actions SET status='running' WHERE project_id=$1 AND delegation_id=$2 AND status='queued' RETURNING id,through_seq`, p, delegation).Scan(&id, &through) == nil
	})
	a.processVoiceAction(ctx, id, p, through)
	return id
}

func TestVoiceSaysAReplyAsSoonAsItsTurnSettles(t *testing.T) {
	// The monitor's own checks never come round, so only the settling turn can wake it.
	paceVoice(t, time.Hour)
	a, p := studioFixture(t)
	runVoice(t, a)
	provider := startFakeLive(t, a, 201, 0)
	studioAgent(t, a, func(agentRound) any { return map[string]any{"content": "Saved your toast."} })
	if status, _ := startVoice(t, a, p); status != 201 {
		t.Fatal(status)
	}
	voiceTurn(t, a, provider, p, "Save my toast.", "d-1")
	if c := provider.await(t, "session.commentary.append"); c["delegation_id"] != "d-1" || c["content"] != "Saved your toast." {
		t.Fatal(c)
	}
}

func TestVoiceSaysTheServersOwnWordsInTheAppLanguage(t *testing.T) {
	a, p := studioFixture(t)
	runVoice(t, a)
	provider := startFakeLive(t, a, 201, 0)
	studioAgent(t, a, func(agentRound) any { return 502 })
	if status, _ := studioReq(t, studioServer(a), "PUT", "/studio/"+p+"/context", "cook", "", map[string]any{"language": "fr"}); status != 204 {
		t.Fatal(status)
	}
	if status, _ := startVoice(t, a, p); status != 201 {
		t.Fatal(status)
	}
	id := voiceTurn(t, a, provider, p, "Plan dinner.", "d-1")
	if c := provider.await(t, "session.commentary.append"); c["content"] != voiceNotes[turnFailed]["fr"] {
		t.Fatal(c)
	}
	// The stored reply stays in English, for the app to translate on screen.
	if _, reply := studioOutcome(t, a, id); reply != turnFailed {
		t.Fatal(reply)
	}
	for note, languages := range voiceNotes {
		for _, language := range []string{"fr", "de", "ru", "es", "it", "pt", "zh", "ja"} {
			if languages[language] == "" {
				t.Errorf("%s has no %s for %q", note, language, note)
			}
		}
	}
}

func TestVoiceTellsTheAppHowLongTheCallCanLast(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	a, p := studioFixture(t)
	if _, e := a.DB.Exec(context.Background(), `UPDATE users SET plan='free',plan_status='' WHERE id='cook'`); e != nil {
		t.Fatal(e)
	}
	runVoice(t, a)
	startFakeLive(t, a, 201, 0)
	status, body := studioReq(t, studioServer(a), "POST", "/studio/"+p+"/voice", "cook", "", map[string]string{"sdp": "v=0\r\n"})
	var answer struct{ MaxSeconds, RemainingSeconds int }
	if status != 201 || json.Unmarshal(body, &answer) != nil || answer.MaxSeconds != 120 || answer.RemainingSeconds != 120 {
		t.Fatalf("%d %s", status, body)
	}
}

func TestAVoiceTurnThatOnlyMovesTheScreenEndsInOneRound(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	toast := exampleVoiceRecipe()
	toast.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", toast, false); e != nil {
		t.Fatal(e)
	}
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) VALUES('call-'||$1,$1,'cook','closed',0,0,true,now())`, p); e != nil {
		t.Fatal(e)
	}
	var first map[string]any
	rounds, channel := 0, any(nil)
	studioAgent(t, a, func(r agentRound) any {
		rounds++
		channel = r.input()["channel"]
		if r.answered() {
			return map[string]any{"content": "Second round."}
		}
		return first
	})
	writing := func(content string, pairs ...any) map[string]any {
		m := orderedCalls(pairs...)
		m["content"] = content
		return m
	}
	turn := func(voice bool, message map[string]any) (reply string, n int) {
		t.Helper()
		first, rounds = message, 0
		say(t, a, p, "Start cooking the toast.")
		session := "'chat_'||$2"
		if voice {
			session = "'call-'||$2"
		}
		id := uuid.NewString()
		var through int64
		if e := a.DB.QueryRow(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,through_seq,status) SELECT $1,$2,`+session+`,$1,max(seq),'running' FROM voice_events WHERE project_id=$2 RETURNING through_seq`, id, p).Scan(&through); e != nil {
			t.Fatal(e)
		}
		a.processVoiceAction(ctx, id, p, through)
		_, reply = studioOutcome(t, a, id)
		return reply, rounds
	}
	cooking := map[string]any{"action": "start_cooking", "recipe_id": "toast", "step": 1}

	// In a call, a round that only moves the screen and says so is the whole turn.
	if reply, n := turn(true, writing("Step 1: toast the bread until golden.", "app_action", cooking)); n != 1 || reply != "Step 1: toast the bread until golden." || channel != "voice" {
		t.Fatalf("screen-only call turn: %d rounds, %q, channel %v", n, reply, channel)
	}
	var actions string
	if e := a.DB.QueryRow(ctx, `SELECT actions::text FROM voice_events WHERE project_id=$1 AND role='assistant' ORDER BY seq DESC LIMIT 1`, p).Scan(&actions); e != nil || !strings.Contains(actions, `"start_cooking"`) {
		t.Fatal(e, actions)
	}
	// Models that write nothing beside a tool call put the reply in app_action's say.
	saying := map[string]any{"action": "start_cooking", "recipe_id": "toast", "step": 1, "say": "Step 1: toast the bread."}
	if reply, n := turn(true, orderedCalls("app_action", saying)); n != 1 || reply != "Step 1: toast the bread." {
		t.Fatalf("a call's screen turn said in say: %d rounds, %q", n, reply)
	}
	// Anything else takes the usual second round: a typed chat, a screen action that failed,
	// a reply not written yet, or another tool.
	for name, c := range map[string]struct {
		voice   bool
		message map[string]any
	}{
		"typed":         {false, writing("Step 1: toast the bread.", "app_action", cooking)},
		"typed, saying": {false, orderedCalls("app_action", saying)},
		"failed":        {true, writing("Opening it.", "app_action", map[string]any{"action": "open_recipe", "recipe_id": "missing"})},
		"no reply yet":  {true, orderedCalls("app_action", cooking)},
		"another tool":  {true, writing("Opening it.", "app_action", cooking, "search_recipes", map[string]any{"query": "toast"})},
	} {
		if reply, n := turn(c.voice, c.message); n != 2 || reply != "Second round." {
			t.Errorf("%s: %d rounds, %q", name, n, reply)
		}
		// The model is told which one it's answering in.
		if want := map[bool]string{true: "voice", false: "text"}[c.voice]; channel != want {
			t.Errorf("%s: channel %v", name, channel)
		}
	}
}
