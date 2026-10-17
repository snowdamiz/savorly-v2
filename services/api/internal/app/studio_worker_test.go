package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// startStudioWorker runs the studio loop at the given pace until the test ends.
func startStudioWorker(t *testing.T, a *App, p pacing) {
	t.Helper()
	pace, sweeps := studioPace, sweepEvery
	studioPace, sweepEvery = p, time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.runStudioWorker(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-done
		studioPace, sweepEvery = pace, sweeps
	})
}

// settled waits for a conversation's turns to finish and returns their statuses.
func settled(t *testing.T, a *App, p string, turns int) []string {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		statuses := []string{}
		rows, e := a.DB.Query(context.Background(), `SELECT status FROM voice_actions WHERE project_id=$1 AND status NOT IN ('queued','running') ORDER BY created_at`, p)
		if e != nil {
			t.Fatal(e)
		}
		for rows.Next() {
			var s string
			_ = rows.Scan(&s)
			statuses = append(statuses, s)
		}
		rows.Close()
		if len(statuses) >= turns {
			return statuses
		}
		if time.Now().After(deadline) {
			t.Fatalf("turns didn't finish: %v", statuses)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestStudioWorkerWakesForNewMessages(t *testing.T) {
	a, p := studioFixture(t)
	studioAgent(t, a, func(agentRound) any { return map[string]any{"content": "Hello!"} })
	// Idle, the loop would sleep an hour; the message wakes it.
	startStudioWorker(t, a, pacing{base: time.Hour, idle: time.Hour})
	time.Sleep(300 * time.Millisecond)
	if status, b := studioReq(t, studioServer(a), "POST", "/studio/"+p+"/messages", "cook", "wake-up-message", map[string]any{"text": "Hi"}); status != 202 {
		t.Fatalf("send %d %s", status, b)
	}
	if s := settled(t, a, p, 1); s[0] != "completed" {
		t.Fatal(s)
	}
}

func TestStudioWorkerRunsConversationsInParallel(t *testing.T) {
	a, p := studioFixture(t)
	second := uuid.NewString()
	if _, e := a.DB.Exec(context.Background(), `INSERT INTO voice_projects(id,user_id) VALUES($1,'cook')`, second); e != nil {
		t.Fatal(e)
	}
	var mu sync.Mutex
	inside, most := 0, 0
	both := make(chan struct{})
	studioAgent(t, a, func(agentRound) any {
		mu.Lock()
		inside++
		most = max(most, inside)
		if inside == 2 {
			close(both)
		}
		mu.Unlock()
		select { // One slow turn no longer holds up another conversation.
		case <-both:
		case <-time.After(5 * time.Second):
		}
		mu.Lock()
		inside--
		mu.Unlock()
		return map[string]any{"content": "Done."}
	})
	startStudioWorker(t, a, pacing{base: 20 * time.Millisecond, idle: 100 * time.Millisecond})
	f := studioServer(a)
	for _, project := range []string{p, second} {
		if status, b := studioReq(t, f, "POST", "/studio/"+project+"/messages", "cook", "parallel-"+project, map[string]any{"text": "Plan dinner"}); status != 202 {
			t.Fatalf("send %d %s", status, b)
		}
	}
	settled(t, a, p, 1)
	settled(t, a, second, 1)
	mu.Lock()
	defer mu.Unlock()
	if most != 2 {
		t.Fatalf("turns ran one at a time (at most %d at once)", most)
	}
}

func TestStudioWorkerSettlesTurnsWhenStopping(t *testing.T) {
	a, p := studioFixture(t)
	started := make(chan struct{}, 1)
	studioAgent(t, a, func(agentRound) any {
		started <- struct{}{}
		return stall{}
	})
	pace, sweeps := studioPace, sweepEvery
	studioPace, sweepEvery = pacing{base: 20 * time.Millisecond, idle: 100 * time.Millisecond}, time.Hour
	defer func() { studioPace, sweepEvery = pace, sweeps }()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.runStudioWorker(ctx) }()
	if status, b := studioReq(t, studioServer(a), "POST", "/studio/"+p+"/messages", "cook", "stopping", map[string]any{"text": "Plan dinner"}); status != 202 {
		t.Fatalf("send %d %s", status, b)
	}
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("turn never started")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("worker didn't stop")
	}
	// By the time the worker returns, the cancelled turn has answered instead of waiting for
	// the five-minute sweep.
	var status, reply string
	a.DB.QueryRow(context.Background(), `SELECT status,reply FROM voice_actions WHERE project_id=$1`, p).Scan(&status, &reply)
	if status != "failed" || reply != studioTurnFailed {
		t.Fatalf("turn left %s %q", status, reply)
	}
}

func TestStalledTurnsAnswerInTheAppsLanguage(t *testing.T) {
	a, french := studioFixture(t)
	ctx := context.Background()
	f := studioServer(a)
	if status, _ := studioReq(t, f, "PUT", "/studio/"+french+"/context", "cook", "", map[string]any{"screen": "planner", "language": "fr"}); status != 204 {
		t.Fatal(status)
	}
	english := uuid.NewString()
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_projects(id,user_id) VALUES($1,'cook')`, english); e != nil {
		t.Fatal(e)
	}
	// An unknown language is dropped rather than stored.
	if status, _ := studioReq(t, f, "PUT", "/studio/"+english+"/context", "cook", "", map[string]any{"screen": "planner", "language": "klingon"}); status != 204 {
		t.Fatal(status)
	}
	var stored string
	a.DB.QueryRow(ctx, `SELECT context::text FROM voice_projects WHERE id=$1`, english).Scan(&stored)
	if stored != `{"screen": "planner", "recipeId": "", "timeZone": "", "cookingStep": 0}` {
		t.Fatalf("context %s", stored)
	}
	// Two turns whose server died mid-way; one had proposed a deletion the user never saw.
	for _, p := range []string{french, english} {
		say(t, a, p, "Plan dinner")
		_, e := a.DB.Exec(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,through_seq,status,updated_at) SELECT $1,$2,'chat_'||$2,$1,max(seq),'running',now()-interval '6 minutes' FROM voice_events WHERE project_id=$2`, uuid.NewString(), p)
		if e != nil {
			t.Fatal(e)
		}
	}
	if _, e := a.DB.Exec(ctx, `UPDATE voice_projects SET pending='{"tool":"delete_recipe","args":{},"description":"Delete it"}',confirmed_revision=0 WHERE id=$1`, french); e != nil {
		t.Fatal(e)
	}
	if e := a.failStalledTurns(ctx); e != nil {
		t.Fatal(e)
	}
	for p, want := range map[string]string{french: interruptedReplies["fr"], english: interruptedReplies["en"]} {
		var status, reply, event string
		a.DB.QueryRow(ctx, `SELECT x.status,x.reply,e.content FROM voice_actions x JOIN voice_events e ON e.event_id='result_'||x.id WHERE x.project_id=$1`, p).Scan(&status, &reply, &event)
		if status != "failed" || reply != want || event != want {
			t.Fatalf("stalled turn: %s %q %q", status, reply, event)
		}
	}
	if pending, confirmed, _ := studioPending(t, a, french); pending != "" || confirmed != -1 {
		t.Fatalf("stalled turn kept its proposal: %s %d", pending, confirmed)
	}
}
