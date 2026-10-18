package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

func TestCookStepKeyFollowsTheText(t *testing.T) {
	key := cookStepKey("Simmer the  sauce\nfor 8 minutes.")
	if len(key) != 16 || strings.Trim(key, "0123456789abcdef") != "" {
		t.Fatalf("key %q", key)
	}
	// Spacing and case don't make a new step; different words do.
	if cookStepKey("  simmer the sauce for 8 MINUTES.") != key {
		t.Fatal("the same words gave another key")
	}
	if cookStepKey("Simmer the sauce for 10 minutes.") == key {
		t.Fatal("an edited step kept its key")
	}
}

func TestNoteForSaysOnlyWhatMatters(t *testing.T) {
	for _, c := range []struct {
		sessions, median, timer int
		want                    *stepNote
	}{
		{4, 720, 480, nil},                       // too few sessions
		{5, 720, 480, &stepNote{"longer", 4}},    // 12 minutes against an 8-minute timer
		{5, 590, 480, nil},                       // under 2 minutes over
		{5, 2700, 2400, nil},                     // 5 minutes over a 40-minute timer: under a quarter
		{5, 3100, 2400, &stepNote{"longer", 12}}, // over a quarter
		{5, 175, 0, nil},                         // a short step without a timer
		{5, 690, 0, &stepNote{"usual", 12}},      // a long one says how long
	} {
		if got := noteFor(c.sessions, c.median, c.timer); !reflect.DeepEqual(got, c.want) {
			t.Errorf("noteFor(%d,%d,%d) = %+v, want %+v", c.sessions, c.median, c.timer, got, c.want)
		}
	}
}

func TestPercentileInterpolates(t *testing.T) {
	if got := percentile([]int{60, 120, 180, 600}, 0.5); got != 150 {
		t.Fatalf("median %d", got)
	}
	if got := percentile([]int{60, 120, 180, 600}, 0.75); got != 285 {
		t.Fatalf("p75 %d", got)
	}
	if percentile(nil, 0.5) != 0 || percentile([]int{42}, 0.75) != 42 {
		t.Fatal("edge cases")
	}
}

func TestFoldSessionsCountsRealTimeOnSteps(t *testing.T) {
	const a, b, c = "aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"
	ev := func(kind, key string, seconds int64) insightEvent {
		return insightEvent{kind, key, 1_700_000_000_000 + seconds*1000}
	}
	timers := map[string]int{a: 0, b: 480, c: 0}
	sessions := []insightSession{
		// Finished: 2 minutes on a, 12 on b (its timer started), 1 on c; back to b for a glance.
		{finished: true, over: true, events: []insightEvent{ev("enter", a, 0), ev("enter", b, 120), ev("timer_start", b, 130), ev("enter", c, 840),
			ev("enter", b, 870), ev("enter", c, 872), ev("leave", c, 930)}},
		// Gave up at b, after reading ahead to c for a moment and coming back.
		{over: true, events: []insightEvent{ev("enter", a, 0), ev("enter", b, 60), ev("enter", c, 300), ev("enter", b, 302), ev("leave", b, 600)}},
		// Still under way: its times count, but not toward giving up or finishing.
		{events: []insightEvent{ev("enter", a, 0), ev("enter", b, 300)}},
		// A phone left on b for two hours: b doesn't count for this session, a does.
		{finished: true, over: true, events: []insightEvent{ev("enter", a, 0), ev("enter", b, 90), ev("enter", c, 90+2*3600), ev("leave", c, 90+2*3600+60)}},
	}
	folds, over, finished := foldSessions(sessions, timers)
	if over != 3 || finished != 2 {
		t.Fatalf("over %d finished %d", over, finished)
	}
	if got := folds[a].times; !reflect.DeepEqual(got, []int{120, 60, 300, 90}) {
		t.Errorf("a: %v", got)
	}
	// 720 s for the first (the 2-second glance back left out), 240+298 for the second; the third
	// never left b and the fourth idled there.
	if got := folds[b].times; !reflect.DeepEqual(got, []int{720, 538}) {
		t.Errorf("b: %v", got)
	}
	if got := folds[c].times; len(got) != 2 || got[0] != 88 || got[1] != 60 {
		t.Errorf("c: %v", got)
	}
	if folds[b].entered != 3 || folds[b].gaveUp != 1 || folds[c].gaveUp != 0 || folds[a].gaveUp != 0 || folds[b].timerStarts != 1 {
		t.Errorf("b entered %d gave up %d timers %d; c gave up %d", folds[b].entered, folds[b].gaveUp, folds[b].timerStarts, folds[c].gaveUp)
	}
}

// insightRecipe adds a published recipe of three steps: a 2-minute prep, an 8-minute simmer with a
// timer, and serving.
func insightRecipe(t *testing.T, db *pgxpool.Pool, author string) string {
	t.Helper()
	id := uuid.NewString()
	_, e := db.Exec(context.Background(), `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published)
 VALUES($1,$2,'Tomato sauce','A sauce for testing what cooks find.','Italian',20,2,'Easy','[{"name":"Tomatoes","amount":1,"unit":"kg","category":"Produce"}]',
 '[{"title":"Prep","text":"Chop the onion.","seconds":0},{"title":"Simmer","text":"Simmer the sauce for 8 minutes.","seconds":480},{"title":"Serve","text":"Serve it hot.","seconds":0}]',true)`, id, author)
	if e != nil {
		t.Fatal(e)
	}
	return id
}

// cookThrough records a session by tok on recipe with the given seconds on each step in turn,
// through to "Dinner is served" when finished, or stopping after the last step given.
func cookThrough(t *testing.T, f *fiber.App, db *pgxpool.Pool, tok, recipe string, seconds []int, finished bool) string {
	t.Helper()
	out := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", tok, nil)
	id, _ := out["id"].(string)
	at, events := int64(1_700_000_000_000), []map[string]any{}
	for i, s := range seconds {
		events = append(events, map[string]any{"seq": len(events), "kind": "enter", "step": i + 1, "at": at})
		at += int64(s) * 1000
	}
	events = append(events, map[string]any{"seq": len(events), "kind": "leave", "step": len(seconds), "at": at})
	expect(t, f, 204, "POST", "/v1/cook-sessions/"+id+"/events", tok, map[string]any{"events": events})
	if finished {
		// As long ago as the steps took, so a long enough cook is verified.
		total := 0
		for _, s := range seconds {
			total += s
		}
		startedAgo(t, db, id, (total+59)/60)
		expect(t, f, 200, "PATCH", "/v1/cook-sessions/"+id, tok, map[string]any{"step": len(seconds), "finished": true})
	} else {
		// A day old and unfinished: over, given up.
		startedAgo(t, db, id, 25*60)
	}
	return id
}

func insightApp(db *pgxpool.Pool) *App {
	return &App{DB: db, AI: ai.New(), Context: context.Background()}
}

// passTime is 04:00 UTC today, when the day's pass runs.
func passTime() time.Time {
	y, m, d := time.Now().UTC().Date()
	return time.Date(y, m, d, 4, 0, 0, 0, time.UTC)
}

func TestCookEventsAreKeptOnlyWhereTheyCount(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	authorID, author := signedIn(t, db, "author@example.test", true)
	_, cook := signedIn(t, db, "cook@example.test", true)
	_, other := signedIn(t, db, "other@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	out := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", cook, nil)
	session, _ := out["id"].(string)
	path := "/v1/cook-sessions/" + session + "/events"
	event := func(seq int, kind string, step int) map[string]any {
		return map[string]any{"seq": seq, "kind": kind, "step": step, "at": 1_700_000_000_000 + seq*1000}
	}
	// Malformed batches are refused.
	expect(t, f, 400, "POST", path, cook, map[string]any{"events": []any{}})
	expect(t, f, 400, "POST", path, cook, map[string]any{"events": []any{event(0, "explode", 1)}})
	expect(t, f, 400, "POST", path, cook, map[string]any{"events": []any{event(0, "enter", 0)}})
	many := make([]any, 51)
	for i := range many {
		many[i] = event(i, "enter", 1)
	}
	expect(t, f, 400, "POST", path, cook, map[string]any{"events": many})
	// Someone else's session isn't theirs to add to.
	expect(t, f, 404, "POST", path, other, map[string]any{"events": []any{event(0, "enter", 1)}})

	// Kept with the step's key, once however often the app retries; steps past the recipe's end
	// are dropped.
	batch := map[string]any{"events": []any{event(0, "enter", 1), event(1, "enter", 2), event(2, "timer_start", 2), event(3, "enter", 9)}}
	expect(t, f, 204, "POST", path, cook, batch)
	expect(t, f, 204, "POST", path, cook, batch)
	var kept, counted int
	var key string
	if e := db.QueryRow(ctx, `SELECT count(*),(SELECT events FROM cook_sessions WHERE id=$1),max(step_key) FILTER (WHERE seq=1) FROM cook_step_events WHERE session_id=$1`, session).Scan(&kept, &counted, &key); e != nil {
		t.Fatal(e)
	}
	if kept != 3 || counted != 3 || key != cookStepKey("Simmer the sauce for 8 minutes.") {
		t.Fatalf("kept %d counted %d key %q", kept, counted, key)
	}
	var due bool
	if e := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recipe_insights_due WHERE recipe_id=$1)`, recipe).Scan(&due); e != nil || !due {
		t.Fatalf("recipe not queued: %v %v", due, e)
	}

	// The author's own cooking isn't evidence.
	out = expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", author, nil)
	own, _ := out["id"].(string)
	expect(t, f, 404, "POST", "/v1/cook-sessions/"+own+"/events", author, map[string]any{"events": []any{event(0, "enter", 1)}})

	// A session over a day old, or a member keeping their cooking out, keeps nothing.
	out = expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", other, nil)
	late, _ := out["id"].(string)
	startedAgo(t, db, late, 25*60)
	expect(t, f, 204, "POST", "/v1/cook-sessions/"+late+"/events", other, map[string]any{"events": []any{event(0, "enter", 1)}})
	expect(t, f, 200, "PATCH", "/v1/me/preferences", other, map[string]any{"shareCooking": false})
	out = expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", other, nil)
	private, _ := out["id"].(string)
	expect(t, f, 204, "POST", "/v1/cook-sessions/"+private+"/events", other, map[string]any{"events": []any{event(0, "enter", 1)}})
	if e := db.QueryRow(ctx, `SELECT count(*) FROM cook_step_events WHERE session_id IN ($1,$2)`, late, private).Scan(&kept); e != nil || kept != 0 {
		t.Fatalf("kept %d events nobody should have: %v", kept, e)
	}

	// A session holds at most its share.
	if _, e := db.Exec(ctx, `UPDATE cook_sessions SET events=$2-1 WHERE id=$1`, session, cookEventsPerSession); e != nil {
		t.Fatal(e)
	}
	expect(t, f, 204, "POST", path, cook, map[string]any{"events": []any{event(10, "enter", 1), event(11, "enter", 2)}})
	if e := db.QueryRow(ctx, `SELECT events FROM cook_sessions WHERE id=$1`, session).Scan(&counted); e != nil || counted != cookEventsPerSession {
		t.Fatalf("events %d %v", counted, e)
	}
}

func TestCookInsightsShowWhatCooksFound(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	a := insightApp(db)
	ctx := context.Background()
	authorID, author := signedIn(t, db, "author@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	// Six cooks: most needed about 12 minutes for the 8-minute simmer; one gave up there.
	for i, simmer := range []int{700, 720, 760, 690, 740} {
		_, cook := signedIn(t, db, "cook"+strconv.Itoa(i)+"@example.test", true)
		cookThrough(t, f, db, cook, recipe, []int{120, simmer, 60}, true)
	}
	_, quitter := signedIn(t, db, "quitter@example.test", true)
	cookThrough(t, f, db, quitter, recipe, []int{100, 300}, false)

	// Nothing shows before the night's pass.
	out := expect(t, f, 200, "GET", "/v1/recipes/"+recipe+"/insights", "", nil)
	if steps, _ := out["steps"].([]any); len(steps) != 0 {
		t.Fatalf("insights before the pass: %v", out)
	}
	if run, e := a.runCookInsights(ctx, passTime().Add(-2*time.Hour)); run != nil || e != nil {
		t.Fatalf("ran before 03:00: %v %v", run, e)
	}
	run, e := a.runCookInsights(ctx, passTime())
	if e != nil || run == nil || run.recipes != 1 {
		t.Fatalf("pass: %+v %v", run, e)
	}
	// Once a day, however many replicas or restarts ask.
	if again, e := a.runCookInsights(ctx, passTime().Add(time.Hour)); again != nil || e != nil {
		t.Fatalf("a second pass the same day: %+v %v", again, e)
	}

	var insights recipeInsight
	_, b := send(t, f, "GET", "/v1/recipes/"+recipe+"/insights", "", nil)
	if e := json.Unmarshal(b, &insights); e != nil {
		t.Fatal(e)
	}
	// Six sessions over, five finished; a finish rate needs 20.
	if insights.Sessions != 6 || insights.Finished != 5 || insights.FinishRate != nil {
		t.Fatalf("recipe: %s", b)
	}
	// Only the simmer has something to say: cooks needed about 4 minutes more than its timer.
	if len(insights.Steps) != 1 || insights.Steps[0].Step != 2 || insights.Steps[0].Sessions != 6 || insights.Steps[0].Note == nil || *insights.Steps[0].Note != (stepNote{"longer", 4}) {
		t.Fatalf("steps: %s", b)
	}
	if insights.Steps[0].Entered != nil || insights.Steps[0].GaveUp != nil {
		t.Fatalf("cooks see where others gave up: %s", b)
	}

	// Its author sees every step, and where cooks stopped.
	expect(t, f, 401, "GET", "/v1/recipes/"+recipe+"/insights/author", "", nil)
	_, cookTok := signedIn(t, db, "nosy@example.test", true)
	expect(t, f, 404, "GET", "/v1/recipes/"+recipe+"/insights/author", cookTok, nil)
	view := expect(t, f, 200, "GET", "/v1/recipes/"+recipe+"/insights/author", author, nil)
	steps, _ := view["steps"].([]any)
	if len(steps) != 3 || view["finished"] != 5.0 {
		t.Fatalf("author view: %v", view)
	}
	simmer, _ := steps[1].(map[string]any)
	if simmer["entered"] != 6.0 || simmer["gaveUp"] != 1.0 || simmer["timerSeconds"] != 480.0 {
		t.Fatalf("simmer: %v", simmer)
	}
	if serve, _ := steps[2].(map[string]any); serve["entered"] != 5.0 || serve["gaveUp"] != 0.0 {
		t.Fatalf("serve: %v", serve)
	}

	// Editing a step starts its numbers afresh: the new text has none.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{1,text}','"Simmer the sauce gently for 10 minutes."') WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	out = expect(t, f, 200, "GET", "/v1/recipes/"+recipe+"/insights", "", nil)
	if steps, _ := out["steps"].([]any); len(steps) != 0 {
		t.Fatalf("an edited step kept its notes: %v", out)
	}

	// The sous-chef hears it in cooking mode.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{1,text}','"Simmer the sauce for 8 minutes."') WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	r, e := a.cookRecipe(ctx, recipe, authorID)
	if e != nil {
		t.Fatal(e)
	}
	if line := r.insight(2); !strings.Contains(line, "about 12 min") || !strings.Contains(line, "timer says 8 min") || r.insight(1) != "" {
		t.Fatalf("insight for the sous-chef: %q / %q", r.insight(2), r.insight(1))
	}
}

func TestFinishRateShowsFromTwentySessions(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	a := insightApp(db)
	authorID, _ := signedIn(t, db, "author@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	for i := range 20 {
		_, cook := signedIn(t, db, "cook"+strconv.Itoa(i)+"@example.test", true)
		cookThrough(t, f, db, cook, recipe, []int{60, 500, 30}, i < 18)
	}
	if _, e := a.runCookInsights(context.Background(), passTime()); e != nil {
		t.Fatal(e)
	}
	var insights recipeInsight
	_, b := send(t, f, "GET", "/v1/recipes/"+recipe+"/insights", "", nil)
	if e := json.Unmarshal(b, &insights); e != nil || insights.FinishRate == nil || *insights.FinishRate != 0.9 {
		t.Fatalf("finish rate: %s %v", b, e)
	}
}

// questionModel stands in for OpenRouter's grouping: every asked question goes into the step's
// first known question, or a new one.
type questionModel struct {
	calls  atomic.Int32
	server *httptest.Server
}

func newQuestionModel(t *testing.T) *questionModel {
	t.Helper()
	m := &questionModel{}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.calls.Add(1)
		var body struct{ Messages []struct{ Content string } }
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil || len(body.Messages) != 2 {
			t.Errorf("grouping request: %v", e)
			return
		}
		var input struct {
			Language string
			Steps    []ai.QuestionStep
		}
		if e := json.Unmarshal([]byte(body.Messages[1].Content), &input); e != nil {
			t.Error(e)
		}
		out := ai.Grouped{}
		for _, s := range input.Steps {
			group := "n" + strconv.Itoa(s.Step)
			if len(s.Known) > 0 {
				group = s.Known[0].ID
			} else {
				out.New = append(out.New, ai.NewQuestion{Key: group, Step: s.Step, Question: "Can I use a smaller pan?", Answer: "Yes, a 20 cm pan works; it may take a few minutes longer."})
			}
			for _, q := range s.Asked {
				out.Assign = append(out.Assign, ai.Assignment{Question: q.ID, Group: group})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(jsonBytes(out))}}}, "usage": map[string]float64{"cost": 0.0008}})
	}))
	t.Cleanup(m.server.Close)
	return m
}

func TestQuestionsCooksKeepAskingShowWithAnswers(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	model := newQuestionModel(t)
	a := insightApp(db)
	a.AI.OpenRouterURL, a.AI.OpenRouterKey = model.server.URL, "test-only-never-sent"
	ctx := context.Background()
	authorID, author := signedIn(t, db, "author@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	ask := func(member string, step int, text string) {
		recordCookQuestion(ctx, db, member, recipe, step, text, "hands_free")
	}
	var members []string
	for i := range 3 {
		id, _ := signedIn(t, db, "asker"+strconv.Itoa(i)+"@example.test", true)
		members = append(members, id)
	}
	// Two cooks ask at step 1: not enough to show or to group.
	ask(members[0], 1, "do I peel the onion first")
	ask(members[1], 1, "peel it?")
	// Three ask at step 2, one twice; the author's own questions and step 0 aren't kept.
	ask(members[0], 2, "can i use a smaller pan")
	ask(members[1], 2, "Is a small pan OK?")
	ask(members[2], 2, "my pan is tiny, will it work")
	ask(members[2], 2, "smaller pan fine?")
	ask(authorID, 2, "my own question")
	ask(members[0], 0, "not at a step")
	var kept int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM cook_questions WHERE recipe_id=$1`, recipe).Scan(&kept); e != nil || kept != 6 {
		t.Fatalf("kept %d questions: %v", kept, e)
	}
	run, e := a.runCookInsights(ctx, passTime())
	if e != nil || run == nil || run.grouped != 1 || model.calls.Load() != 1 {
		t.Fatalf("pass %+v %v, %d calls", run, e, model.calls.Load())
	}
	var usage int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM ai_usage WHERE kind='cook_questions' AND user_id IS NULL`).Scan(&usage); e != nil || usage != 1 {
		t.Fatalf("grouping wasn't paid from the shared budget: %d %v", usage, e)
	}
	var insights recipeInsight
	_, b := send(t, f, "GET", "/v1/recipes/"+recipe+"/insights", "", nil)
	if e := json.Unmarshal(b, &insights); e != nil {
		t.Fatal(e)
	}
	if len(insights.Steps) != 1 || insights.Steps[0].Step != 2 || len(insights.Steps[0].Questions) != 1 {
		t.Fatalf("questions: %s", b)
	}
	q := insights.Steps[0].Questions[0]
	if q.Question != "Can I use a smaller pan?" || q.Checked || q.Askers != 0 || strings.Contains(string(b), "tiny") {
		t.Fatalf("question as cooks see it: %+v / %s", q, b)
	}
	// Step 1's two questions stay unread for when a third cook asks.
	var unread int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM cook_questions WHERE recipe_id=$1 AND clustered_at IS NULL`, recipe).Scan(&unread); e != nil || unread != 2 {
		t.Fatalf("unread %d %v", unread, e)
	}

	// The author answers it in their own words, or hides it.
	path := "/v1/recipes/" + recipe + "/insights/questions/" + q.ID
	expect(t, f, 401, "PATCH", path, "", map[string]any{"approve": true})
	_, stranger := signedIn(t, db, "stranger@example.test", true)
	expect(t, f, 404, "PATCH", path, stranger, map[string]any{"approve": true})
	expect(t, f, 400, "PATCH", path, author, map[string]any{"answer": "x"})
	got := expect(t, f, 200, "PATCH", path, author, map[string]any{"answer": "Yes. Use a 20 cm pan and give it 2 more minutes."})
	if got["checked"] != true || got["answer"] != "Yes. Use a 20 cm pan and give it 2 more minutes." {
		t.Fatalf("answered: %v", got)
	}
	view := expect(t, f, 200, "GET", "/v1/recipes/"+recipe+"/insights/author", author, nil)
	steps, _ := view["steps"].([]any)
	second, _ := steps[1].(map[string]any)
	questions, _ := second["questions"].([]any)
	if len(questions) != 1 || questions[0].(map[string]any)["askers"] != 3.0 {
		t.Fatalf("author's questions: %v", second)
	}
	expect(t, f, 200, "PATCH", path, author, map[string]any{"hidden": true})
	_, b = send(t, f, "GET", "/v1/recipes/"+recipe+"/insights", "", nil)
	if strings.Contains(string(b), "smaller pan") {
		t.Fatalf("a hidden question shows: %s", b)
	}

	// A new question tomorrow joins the one the step has; nothing is sent twice.
	if _, e := db.Exec(ctx, `DELETE FROM cook_insight_runs`); e != nil {
		t.Fatal(e)
	}
	ask(members[1], 2, "what size pan")
	if _, e := a.runCookInsights(ctx, passTime()); e != nil || model.calls.Load() != 2 {
		t.Fatalf("second night: %v, %d calls", e, model.calls.Load())
	}
	var clusters, grouped int
	if e := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM recipe_step_questions WHERE recipe_id=$1),(SELECT count(*) FROM cook_questions WHERE cluster_id=$2)`, recipe, q.ID).Scan(&clusters, &grouped); e != nil || clusters != 1 || grouped != 5 {
		t.Fatalf("%d questions, %d grouped: %v", clusters, grouped, e)
	}
	if _, e := db.Exec(ctx, `DELETE FROM cook_insight_runs`); e != nil {
		t.Fatal(e)
	}
	if _, e := a.runCookInsights(ctx, passTime()); e != nil || model.calls.Load() != 2 {
		t.Fatalf("a night with nothing new asked the model: %v, %d calls", e, model.calls.Load())
	}
}

func TestKeepingCookingOutTakesItBack(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	authorID, _ := signedIn(t, db, "author@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", true)
	recipe := insightRecipe(t, db, authorID)
	session := cookThrough(t, f, db, cook, recipe, []int{60, 600, 30}, true)
	recordCookQuestion(ctx, db, cookID, recipe, 2, "how thick should it be", "sous_chef")
	me := expect(t, f, 200, "GET", "/v1/me", cook, nil)
	if prefs, _ := me["preferences"].(map[string]any); prefs["shareCooking"] != true {
		t.Fatalf("sharing isn't on by default: %v", me["preferences"])
	}
	expect(t, f, 400, "PATCH", "/v1/me/preferences", cook, map[string]any{"shareCooking": "no"})
	expect(t, f, 200, "PATCH", "/v1/me/preferences", cook, map[string]any{"shareCooking": false})
	var events, counted, questions int
	var verified bool
	if e := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM cook_step_events WHERE session_id=$1),events,verified,(SELECT count(*) FROM cook_questions WHERE user_id=$2) FROM cook_sessions WHERE id=$1`, session, cookID).
		Scan(&events, &counted, &verified, &questions); e != nil {
		t.Fatal(e)
	}
	// The verified cook stays: it pays the creator and counts for the cook time.
	if events != 0 || counted != 0 || questions != 0 || !verified {
		t.Fatalf("after keeping cooking out: %d events (%d counted), %d questions, verified %v", events, counted, questions, verified)
	}
	recordCookQuestion(ctx, db, cookID, recipe, 2, "how thick should it be", "sous_chef")
	if e := db.QueryRow(ctx, `SELECT count(*) FROM cook_questions WHERE user_id=$1`, cookID).Scan(&questions); e != nil || questions != 0 {
		t.Fatalf("a question was kept after opting out: %d %v", questions, e)
	}
}

func TestCookTestedFilterAndInsightsRetention(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	authorID, _ := signedIn(t, db, "author@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", true)
	tested := insightRecipe(t, db, authorID)
	early := insightRecipe(t, db, authorID)
	if _, e := db.Exec(ctx, `INSERT INTO recipe_cook_times(recipe_id,cooks,minutes) VALUES($1,$3,22),($2,4,25)`, tested, early, cookTestedCooks); e != nil {
		t.Fatal(e)
	}
	_, b := send(t, f, "GET", "/v1/recipes?cookTested=true", "", nil)
	if !strings.Contains(string(b), tested) || strings.Contains(string(b), early) {
		t.Fatalf("cook-tested filter: %s", b)
	}
	if !strings.Contains(feedSQL, "t.cooks>="+strconv.Itoa(cookTestedCooks)+" ") {
		t.Fatal("the feed's boost doesn't use the cook-tested threshold")
	}

	// An unfinished session with step events outlives the 35 days others get (for the console's
	// finish rate); one without doesn't, and both go after the window.
	stepped := cookThrough(t, f, db, cook, early, []int{60, 300}, false)
	out := expect(t, f, 201, "POST", "/v1/recipes/"+early+"/cook-sessions", cook, nil)
	bare, _ := out["id"].(string)
	recordCookQuestion(ctx, db, cookID, early, 1, "how fine do I chop it", "hands_free")
	if _, e := db.Exec(ctx, `UPDATE cook_sessions SET started_at=now()-interval '36 days' WHERE id IN ($1,$2)`, stepped, bare); e != nil {
		t.Fatal(e)
	}
	if _, e := runJanitor(ctx, db); e != nil {
		t.Fatal(e)
	}
	var sessions, events, questions int
	count := func() {
		t.Helper()
		if e := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM cook_sessions WHERE id IN ($1,$2)),(SELECT count(*) FROM cook_step_events WHERE session_id=$1),(SELECT count(*) FROM cook_questions)`, stepped, bare).
			Scan(&sessions, &events, &questions); e != nil {
			t.Fatal(e)
		}
	}
	if count(); sessions != 1 || events != 3 || questions != 1 {
		t.Fatalf("after 36 days: %d sessions, %d events, %d questions", sessions, events, questions)
	}
	if _, e := db.Exec(ctx, `UPDATE cook_sessions SET started_at=now()-interval '181 days' WHERE id=$1;`, stepped); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE cook_step_events SET created_at=now()-interval '181 days'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE cook_questions SET created_at=now()-interval '91 days'`); e != nil {
		t.Fatal(e)
	}
	if _, e := runJanitor(ctx, db); e != nil {
		t.Fatal(e)
	}
	if count(); sessions != 0 || events != 0 || questions != 0 {
		t.Fatalf("after the window: %d sessions, %d events, %d questions", sessions, events, questions)
	}
}

func TestCheckGroupedKeepsOnlyWhatFits(t *testing.T) {
	q := ai.RecipeQuestions{Steps: []ai.QuestionStep{
		{Step: 1, Known: []ai.KnownQuestion{{ID: "k1", Question: "Peel first?"}}, Asked: []ai.AskedQuestion{{ID: "a1"}, {ID: "a2"}}},
		{Step: 2, Asked: []ai.AskedQuestion{{ID: "a3"}, {ID: "a4"}}},
	}}
	g := ai.CheckGrouped(q, ai.Grouped{
		Assign: []ai.Assignment{
			{Question: "a1", Group: "k1"},   // a known question of its step
			{Question: "a2", Group: "n9"},   // a new question of another step
			{Question: "a3", Group: "n1"},   // its own step's new question
			{Question: "a3", Group: "n1"},   // twice
			{Question: "a4", Group: "k1"},   // another step's known question
			{Question: "zz", Group: "n1"},   // not asked
			{Question: "a4", Group: "nope"}, // nothing
		},
		New: []ai.NewQuestion{
			{Key: "n1", Step: 2, Question: "  Smaller   pan? ", Answer: "Yes."},
			{Key: "n9", Step: 2, Question: "Unused", Answer: "Dropped."},
			{Key: "n2", Step: 2, Question: "", Answer: "No question."},
		},
	})
	want := ai.Grouped{Assign: []ai.Assignment{{Question: "a1", Group: "k1"}, {Question: "a3", Group: "n1"}}, New: []ai.NewQuestion{{Key: "n1", Step: 2, Question: "Smaller pan?", Answer: "Yes."}}}
	if !reflect.DeepEqual(g, want) {
		t.Fatalf("got %+v", g)
	}
}

func TestHandsFreeQuestionsAreKeptAndHearWhatCooksFound(t *testing.T) {
	t.Setenv("PAID_PLANS", "")
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := cookKitchen(t)
	chef := &fakeChef{cost: 0.0003}
	f := cookServer(db, chef.server(t).URL)
	ctx := context.Background()
	boil := cookStepKey("Boil the spaghetti in salted water.")
	if _, e := db.Exec(ctx, `INSERT INTO recipe_step_stats(recipe_id,step_key,sessions,median_seconds,p75_seconds,entered,gave_up) VALUES('pasta',$1,6,720,800,6,0)`, boil); e != nil {
		t.Fatal(e)
	}
	if status, _ := askChef(t, f, "guest", "pasta", fiber.Map{"question": "how salty should the water be", "step": 1}); status != 200 {
		t.Fatal(status)
	}
	if prompt := chef.lastPrompt(); !strings.Contains(prompt, "What other cooks found at this step") || !strings.Contains(prompt, "about 12 min") || !strings.Contains(prompt, "timer says 9 min") {
		t.Fatalf("the answer didn't hear what cooks found:\n%s", prompt)
	}
	// The author's own questions, and those outside a step, aren't kept.
	for _, c := range []struct {
		user string
		in   fiber.Map
	}{{"owner", fiber.Map{"question": "is my recipe clear", "step": 1}}, {"guest", fiber.Map{"question": "can I use penne"}}, {"guest", fiber.Map{"question": "and now?", "step": 7}}} {
		if status, _ := askChef(t, f, c.user, "pasta", c.in); status != 200 {
			t.Fatalf("%v: %d", c.in, status)
		}
	}
	var kept, step int
	var key, source, question string
	if e := db.QueryRow(ctx, `SELECT count(*),max(step),max(step_key),max(source),max(question) FROM cook_questions WHERE recipe_id='pasta'`).Scan(&kept, &step, &key, &source, &question); e != nil {
		t.Fatal(e)
	}
	if kept != 1 || step != 1 || key != boil || source != "hands_free" || question != "how salty should the water be" {
		t.Fatalf("kept %d: step %d %q %q %q", kept, step, key, source, question)
	}
}

func TestSousChefQuestionsInCookingModeAreKept(t *testing.T) {
	a, p := studioFixture(t)
	f := studioServer(a)
	ctx := context.Background()
	public := exampleVoiceRecipe()
	public.Published = true
	if e := persistRecipe(ctx, a.DB, "other", "toast", public, false); e != nil {
		t.Fatal(e)
	}
	if status, b := studioReq(t, f, "PUT", "/studio/"+p+"/context", "cook", "", map[string]any{"screen": "discover", "recipeId": "toast", "cookingStep": 1}); status != 204 {
		t.Fatalf("context %d %s", status, b)
	}
	if status, b := studioReq(t, f, "POST", "/studio/"+p+"/messages", "cook", "golden-question", map[string]any{"text": "How golden should it get?"}); status != 202 {
		t.Fatalf("message %d %s", status, b)
	}
	var kept int
	var source string
	if e := a.DB.QueryRow(ctx, `SELECT count(*),max(source) FROM cook_questions WHERE user_id='cook' AND recipe_id='toast' AND step=1`).Scan(&kept, &source); e != nil || kept != 1 || source != "sous_chef" {
		t.Fatalf("kept %d %q %v", kept, source, e)
	}
}
