package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// cookRecipe adds a published recipe of the given stated minutes and number of steps.
func cookRecipe(t *testing.T, db *pgxpool.Pool, author string, minutes, steps int) string {
	t.Helper()
	id := uuid.NewString()
	list := make([]string, steps)
	for i := range list {
		list[i] = fmt.Sprintf(`{"title":"Step %d","text":"Do step %d.","seconds":0}`, i+1, i+1)
	}
	_, e := db.Exec(context.Background(), `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published)
 VALUES($1,$2,'Braise','A recipe for testing cook sessions.','Italian',$3,2,'Easy','[{"name":"Lemon","amount":1,"unit":"","category":"Produce"}]',$4,true)`,
		id, author, minutes, "["+strings.Join(list, ",")+"]")
	if e != nil {
		t.Fatal(e)
	}
	return id
}

// startedAgo moves a session's start back, as if cooking began that many minutes ago.
func startedAgo(t *testing.T, db *pgxpool.Pool, session string, minutes int) {
	t.Helper()
	if _, e := db.Exec(context.Background(), `UPDATE cook_sessions SET started_at=now()-make_interval(mins=>$2) WHERE id=$1`, session, minutes); e != nil {
		t.Fatal(e)
	}
}

func TestCookSessionsVerifyOnlyPlausibleCooks(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	authorID, author := signedIn(t, db, "author@example.test", true)
	_, cook := signedIn(t, db, "cook@example.test", true)
	_, other := signedIn(t, db, "other@example.test", true)
	braise := cookRecipe(t, db, authorID, 30, 3) // at least 10 minutes
	quick := cookRecipe(t, db, authorID, 6, 2)   // at least the 3-minute floor
	draft := testRecipe(t, db, authorID, "Secret", false)
	start := func(tok, recipe string) string {
		t.Helper()
		out := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", tok, nil)
		id, _ := out["id"].(string)
		return id
	}
	finish := func(tok, session string, step int) map[string]any {
		t.Helper()
		return expect(t, f, 200, "PATCH", "/v1/cook-sessions/"+session, tok, map[string]any{"step": step, "finished": true})
	}

	// Guests record nothing; drafts can't be cooked by anyone but their author.
	expect(t, f, 401, "POST", "/v1/recipes/"+braise+"/cook-sessions", "", nil)
	expect(t, f, 404, "POST", "/v1/recipes/"+draft+"/cook-sessions", cook, nil)

	// Tapping straight through the steps isn't a cook.
	s := start(cook, braise)
	if got := expect(t, f, 200, "PATCH", "/v1/cook-sessions/"+s, cook, map[string]any{"step": 2}); got["stepReached"] != 2.0 || got["finishedAt"] != nil {
		t.Fatalf("progress: %v", got)
	}
	if got := finish(cook, s, 3); got["verified"] != false || got["finishedAt"] == nil {
		t.Fatalf("a two-second cook was verified: %v", got)
	}
	// A finished session doesn't change, so a retried finish answers the same.
	if got := finish(cook, s, 3); got["verified"] != false {
		t.Fatalf("retried finish: %v", got)
	}
	// Another member's session isn't theirs to touch.
	expect(t, f, 404, "PATCH", "/v1/cook-sessions/"+s, other, map[string]any{"step": 1})

	// Long enough and through to the last step: a verified cook, once a day per recipe.
	s = start(cook, braise)
	startedAgo(t, db, s, 12)
	if got := finish(cook, s, 3); got["verified"] != true {
		t.Fatalf("a 12-minute cook of a 30-minute recipe wasn't verified: %v", got)
	}
	s = start(cook, braise)
	startedAgo(t, db, s, 40)
	if got := finish(cook, s, 3); got["verified"] != false {
		t.Fatalf("a second verified cook of the same recipe on the same day: %v", got)
	}
	// Not reaching the last step doesn't count; the 3-minute floor does for a quick recipe.
	s = start(cook, quick)
	startedAgo(t, db, s, 5)
	if got := finish(cook, s, 1); got["verified"] != false {
		t.Fatalf("a cook that stopped at step 1 of 2 was verified: %v", got)
	}
	expect(t, f, 200, "PATCH", "/v1/cook-sessions/"+start(other, quick), other, map[string]any{"step": 2})
	s = start(other, quick)
	startedAgo(t, db, s, 2)
	if got := finish(other, s, 2); got["verified"] != false {
		t.Fatalf("a 2-minute cook beat the 3-minute floor: %v", got)
	}
	s = start(other, quick)
	startedAgo(t, db, s, 4)
	if got := finish(other, s, 2); got["verified"] != true {
		t.Fatalf("a 4-minute cook of a 6-minute recipe wasn't verified: %v", got)
	}

	// The author's own cooking never counts.
	s = start(author, braise)
	startedAgo(t, db, s, 30)
	if got := finish(author, s, 3); got["verified"] != false {
		t.Fatalf("an author's own cook was verified: %v", got)
	}

	// A session left open for a day is over.
	s = start(other, braise)
	startedAgo(t, db, s, 25*60)
	expect(t, f, 409, "PATCH", "/v1/cook-sessions/"+s, other, map[string]any{"step": 3, "finished": true})

	// Without paid plans nobody's plan brings the fund anything.
	var net int
	if e := db.QueryRow(context.Background(), `SELECT COALESCE(sum(net_cents),0) FROM cook_sessions`).Scan(&net); e != nil || net != 0 {
		t.Fatalf("net cents %d %v", net, e)
	}
}

func TestCookSessionsFinishedTogetherVerifyOnce(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	authorID, _ := signedIn(t, db, "author@example.test", true)
	_, cook := signedIn(t, db, "cook@example.test", true)
	recipe := cookRecipe(t, db, authorID, 9, 1)
	sessions := make([]string, 6)
	for i := range sessions {
		out := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", cook, nil)
		sessions[i], _ = out["id"].(string)
		startedAgo(t, db, sessions[i], 10)
	}
	var wg sync.WaitGroup
	failures := make(chan error, len(sessions))
	for _, s := range sessions {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest("PATCH", "/v1/cook-sessions/"+s, bytes.NewReader(jsonBytes(map[string]any{"step": 1, "finished": true})))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+cook)
			res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
			if e == nil && res.StatusCode != 200 {
				e = fmt.Errorf("finishing answered %d", res.StatusCode)
			}
			if e != nil {
				failures <- e
			}
		}()
	}
	wg.Wait()
	close(failures)
	for e := range failures {
		t.Error(e)
	}
	var verified, finished int
	if e := db.QueryRow(context.Background(), `SELECT count(*) FILTER (WHERE verified),count(*) FILTER (WHERE finished_at IS NOT NULL) FROM cook_sessions`).Scan(&verified, &finished); e != nil {
		t.Fatal(e)
	}
	if verified != 1 || finished != len(sessions) {
		t.Fatalf("%d verified and %d finished of %d sessions finished at once", verified, finished, len(sessions))
	}
}

func TestRealCookTimeIsTheMedianOfVerifiedCooks(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	authorID, _ := signedIn(t, db, "author@example.test", true)
	recipe := cookRecipe(t, db, authorID, 30, 2)
	cookTime := func() (any, any) {
		t.Helper()
		out := expect(t, f, 200, "GET", "/v1/recipes/"+recipe, "", nil)
		return out["verifiedCooks"], out["cookedMinutes"]
	}
	if n, minutes := cookTime(); n != 0.0 || minutes != nil {
		t.Fatalf("a new recipe: %v cooks, %v minutes", n, minutes)
	}
	for i, minutes := range []int{45, 12, 60} {
		_, tok := signedIn(t, db, fmt.Sprintf("cook%d@example.test", i), true)
		out := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", tok, nil)
		id, _ := out["id"].(string)
		startedAgo(t, db, id, minutes)
		expect(t, f, 200, "PATCH", "/v1/cook-sessions/"+id, tok, map[string]any{"step": 2, "finished": true})
		n, shown := cookTime()
		if n != float64(i+1) {
			t.Fatalf("after %d cooks: verifiedCooks %v", i+1, n)
		}
		// Two cooks aren't enough to say how long it takes.
		if i < 2 && shown != nil {
			t.Fatalf("after %d cooks the cook time already shows: %v", i+1, shown)
		}
		if i == 2 && shown != 45.0 {
			t.Fatalf("median of 45, 12 and 60 minutes: %v", shown)
		}
	}
	// Recipe lists carry it too.
	_, b := send(t, f, "GET", "/v1/recipes", "", nil)
	var list []map[string]any
	if e := json.Unmarshal(b, &list); e != nil || len(list) != 1 || list[0]["cookedMinutes"] != 45.0 {
		t.Fatalf("recipe list: %s", b)
	}
}

// Every recipe list carries the cook time, so it must be one key lookup.
func TestCookTimeIsAKeyLookup(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	_, e := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle) SELECT 'u'||n,'u'||n||'@example.test','!disabled','Cook','u'||n FROM generate_series(1,200) n;
INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published)
 SELECT 'r'||n,'u'||(1+n%200),'Dish '||n,'A dish for the plan test.','Italian',20,2,'Easy','[]','[]',true FROM generate_series(1,5000) n;
INSERT INTO recipe_cook_times(recipe_id,cooks,minutes) SELECT 'r'||n,n%9,20+n%40 FROM generate_series(1,5000) n;
ANALYZE users; ANALYZE recipes; ANALYZE recipe_cook_times;`)
	if e != nil {
		t.Fatal(e)
	}
	found, plan := planIndexes(t, db, `SELECT `+recipeJSON+recipeFrom+`WHERE r.id=$1`, "r2500")
	if !found["recipe_cook_times_pkey"] {
		t.Fatalf("the cook time isn't read by key:\n%s", plan)
	}
}
