package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

// fakeChef stands in for OpenRouter: it answers every question with answer and reports cost,
// keeping each prompt it was sent. A status other than 200 fails the call.
type fakeChef struct {
	calls   atomic.Int32
	mu      sync.Mutex
	prompts []string
	status  int
	cost    float64
}

func (f *fakeChef) server(t *testing.T) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		var body struct {
			Messages []map[string]string `json:"messages"`
			Tools    any                 `json:"tools"`
		}
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil || len(body.Messages) != 2 || body.Tools != nil {
			t.Errorf("a cooking question is one plain chat request: %v %+v", e, body)
		}
		f.mu.Lock()
		f.prompts = append(f.prompts, body.Messages[len(body.Messages)-1]["content"])
		f.mu.Unlock()
		if f.status != 0 && f.status != 200 {
			w.WriteHeader(f.status)
			return
		}
		w.Write(jsonBytes(fiber.Map{"choices": []fiber.Map{{"message": fiber.Map{"content": "About nine minutes, until it's al dente."}}}, "usage": fiber.Map{"cost": f.cost}}))
	}))
	t.Cleanup(s.Close)
	return s
}

func (f *fakeChef) lastPrompt() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.prompts) == 0 {
		return ""
	}
	return f.prompts[len(f.prompts)-1]
}

func cookServer(db *pgxpool.Pool, provider string) *fiber.App {
	a := &App{DB: db, AI: ai.New()}
	a.AI.OpenRouterURL, a.AI.OpenRouterKey = provider, "test-only-never-sent"
	if provider == "" {
		a.AI.OpenRouterKey = ""
	}
	f := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	f.Use(func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return c.Next() })
	f.Post("/recipes/:id/ask", a.askCook)
	return f
}

// askChef posts a question as user and returns the status and the answer or error message.
func askChef(t *testing.T, f *fiber.App, user, recipe string, in fiber.Map) (int, string) {
	t.Helper()
	req := httptest.NewRequest("POST", "/recipes/"+recipe+"/ask", bytes.NewReader(jsonBytes(in)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Test-User", user)
	res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	var out struct{ Answer, Error string }
	_ = json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode == 200 {
		return 200, out.Answer
	}
	return res.StatusCode, out.Error
}

// cookKitchen has a published pasta and a private draft by "owner", a published recipe by a
// suspended cook, and a second member, "guest".
func cookKitchen(t *testing.T) *pgxpool.Pool {
	db := isolatedDB(t)
	for _, id := range []string{"owner", "guest", "banned"} {
		testUser(t, db, id)
	}
	ctx := context.Background()
	steps := `[{"title":"Boil","text":"Boil the spaghetti in salted water.","seconds":540},{"title":"Toss","text":"Toss it with the sauce.","seconds":0}]`
	for _, r := range []struct {
		id, author string
		published  bool
	}{{"pasta", "owner", true}, {"draft", "owner", false}, {"hidden", "banned", true}} {
		if _, e := db.Exec(ctx, `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published) VALUES($1,$2,'Spaghetti al pomodoro','Quick','Italian',20,2,'Easy','[{"name":"Spaghetti","amount":200,"unit":"g","category":"Pantry"}]',$3,$4)`, r.id, r.author, steps, r.published); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := db.Exec(ctx, `UPDATE users SET suspended_at=now() WHERE id='banned'`); e != nil {
		t.Fatal(e)
	}
	return db
}

func cookUsage(t *testing.T, db *pgxpool.Pool, user string) (rows int, cost float64) {
	t.Helper()
	if e := db.QueryRow(context.Background(), `SELECT count(*),COALESCE(sum(estimated_cost),0)::float8 FROM ai_usage WHERE user_id=$1 AND kind='cook_question'`, user).Scan(&rows, &cost); e != nil {
		t.Fatal(e)
	}
	return rows, cost
}

func TestCookQuestionsAnswerFromTheRecipeTheCookMaySee(t *testing.T) {
	t.Setenv("PAID_PLANS", "")
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := cookKitchen(t)
	chef := &fakeChef{cost: 0.0003}
	f := cookServer(db, chef.server(t).URL)

	status, answer := askChef(t, f, "guest", "pasta", fiber.Map{"question": " how long do I   boil it? ", "step": 1, "language": "fr"})
	if status != 200 || answer != "About nine minutes, until it's al dente." {
		t.Fatalf("answer %d %q", status, answer)
	}
	prompt := chef.lastPrompt()
	for _, part := range []string{"Answer in French.", "Spaghetti al pomodoro", "200 g Spaghetti", "on step 1 of 2: Boil: Boil the spaghetti in salted water. (timer 9 min)", "The cook asks: how long do I boil it?"} {
		if !strings.Contains(prompt, part) {
			t.Errorf("the question lost %q:\n%s", part, prompt)
		}
	}
	// Settled to what OpenRouter reported, below the reservation.
	if rows, cost := cookUsage(t, db, "guest"); rows != 1 || cost != 0.0003 {
		t.Fatalf("ledger %d rows, $%v", rows, cost)
	}

	// No step (or one past the end) and an unknown language: the recipe alone, in English.
	if status, _ = askChef(t, f, "guest", "pasta", fiber.Map{"question": "Can I use penne?", "step": 7, "language": "xx"}); status != 200 {
		t.Fatal(status)
	}
	if prompt = chef.lastPrompt(); !strings.Contains(prompt, "Answer in English.") || strings.Contains(prompt, "The cook is on step") {
		t.Fatalf("prompt without a step:\n%s", prompt)
	}

	// A private draft answers only its cook; a suspended cook's recipe answers no one.
	for _, c := range []struct {
		user, recipe string
		status       int
	}{{"guest", "draft", 404}, {"owner", "draft", 200}, {"guest", "hidden", 404}, {"guest", "missing", 404}} {
		if status, message := askChef(t, f, c.user, c.recipe, fiber.Map{"question": "Is it done?", "step": 2}); status != c.status || (status == 404 && message != "Recipe not found.") {
			t.Errorf("%s asking about %s: %d %s", c.user, c.recipe, status, message)
		}
	}
	for _, in := range []fiber.Map{{"question": "?"}, {"question": strings.Repeat("why ", 80)}, {"question": "Is it done?", "step": -1}, {"question": "Is it done?", "step": 101}} {
		if status, _ := askChef(t, f, "guest", "pasta", in); status != 400 {
			t.Errorf("%v: %d", in, status)
		}
	}
	if calls := chef.calls.Load(); calls != 3 {
		t.Fatalf("provider called %d times, want only the three answered questions", calls)
	}
}

func TestCookQuestionsKeepToThePlan(t *testing.T) {
	t.Setenv("PAID_PLANS", "true")
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := cookKitchen(t)
	free := plans[0]
	t.Cleanup(func() { plans[0] = free })
	plans[0].CookQuestions = 2
	chef := &fakeChef{cost: 0.0002}
	f := cookServer(db, chef.server(t).URL)
	question := fiber.Map{"question": "How salty should the water be?", "step": 1, "language": "en"}

	// Six at once with two left: the member's lock lets exactly two through.
	var wg sync.WaitGroup
	var answered, refused atomic.Int32
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			switch status, message := askChef(t, f, "guest", "pasta", question); {
			case status == 200:
				answered.Add(1)
			case status == 429 && message == "You've used your plan's cooking questions for the last 30 days.":
				refused.Add(1)
			default:
				t.Errorf("unexpected %d %s", status, message)
			}
		}()
	}
	wg.Wait()
	if answered.Load() != 2 || refused.Load() != 4 || chef.calls.Load() != 2 {
		t.Fatalf("answered %d, refused %d, provider calls %d", answered.Load(), refused.Load(), chef.calls.Load())
	}
	if used, e := usageOf(context.Background(), db, "guest"); e != nil || used.CookQuestions != 2 {
		t.Fatalf("usage %+v %v", used, e)
	}

	// A plan without questions says so; the spend ceiling still applies inside the allowance.
	plans[0].CookQuestions = 0
	if status, message := askChef(t, f, "owner", "pasta", question); status != 429 || message != "Your plan doesn't include cooking questions." {
		t.Fatalf("excluded: %d %s", status, message)
	}
	plans[0].CookQuestions, plans[0].SpendCap = 100, 0.0001
	if status, message := askChef(t, f, "owner", "pasta", question); status != 429 || !strings.HasPrefix(message, "You've used your plan's AI allowance") {
		t.Fatalf("spend cap: %d %s", status, message)
	}
	if rows, _ := cookUsage(t, db, "owner"); rows != 0 || chef.calls.Load() != 2 {
		t.Fatalf("refused questions reserved %d rows or reached the provider", rows)
	}
}

func TestCookQuestionsWithoutPlansAreUnlimitedButBudgeted(t *testing.T) {
	t.Setenv("PAID_PLANS", "")
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := cookKitchen(t)
	chef := &fakeChef{cost: 0.0002}
	f := cookServer(db, chef.server(t).URL)
	question := fiber.Map{"question": "Can I make it ahead?", "language": "en"}
	for range 40 {
		if status, message := askChef(t, f, "guest", "pasta", question); status != 200 {
			t.Fatalf("an unlimited member was refused: %d %s", status, message)
		}
	}
	// The daily circuit breaker still stops spend, before the provider is called.
	t.Setenv("AI_DAILY_BUDGET_USD", "0")
	if status, message := askChef(t, f, "guest", "pasta", question); status != 429 || !strings.HasPrefix(message, "Today's AI budget is reached.") {
		t.Fatalf("budget: %d %s", status, message)
	}
	if rows, _ := cookUsage(t, db, "guest"); rows != 40 || chef.calls.Load() != 40 {
		t.Fatalf("%d rows, %d calls", rows, chef.calls.Load())
	}
}

func TestCookQuestionFailuresKeepTheirReservation(t *testing.T) {
	t.Setenv("PAID_PLANS", "")
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := cookKitchen(t)
	chef := &fakeChef{status: 500}
	f := cookServer(db, chef.server(t).URL)
	if status, message := askChef(t, f, "guest", "pasta", fiber.Map{"question": "Is it done?"}); status != 502 || message != "The chef couldn't answer just now. Please try again." {
		t.Fatalf("failure: %d %s", status, message)
	}
	// The provider may have billed it, so the conservative reservation stands.
	if rows, cost := cookUsage(t, db, "guest"); rows != 1 || cost <= 0 || cost > 0.002 {
		t.Fatalf("ledger %d rows, $%v", rows, cost)
	}
	// Without OpenRouter, questions are off and nothing is reserved.
	if status, message := askChef(t, cookServer(db, ""), "guest", "pasta", fiber.Map{"question": "Is it done?"}); status != 503 || message != "Cooking questions aren't set up on this server." {
		t.Fatalf("unconfigured: %d %s", status, message)
	}
	if rows, _ := cookUsage(t, db, "guest"); rows != 1 {
		t.Fatalf("%d rows", rows)
	}
}

// The longest prompt a question can send stays inside the bound its reservation assumes.
func TestCookQuestionPromptsStayBounded(t *testing.T) {
	// Four bytes a character, the most UTF-8 takes.
	long := strings.Repeat("🍝", 3000)
	r := &sceneRecipe{title: long, author: long, servings: 4, minutes: 30}
	for range 100 {
		r.ingredients = append(r.ingredients, Ingredient{Name: long, Amount: 1.5, Unit: long})
		r.steps = append(r.steps, Step{Title: long, Text: long, Seconds: 90})
	}
	q := ai.CookQuestion{Recipe: r.text(), Step: cookStep(r, 50), Question: strings.Repeat("🍝", 300), Language: "Japanese"}
	t.Logf("the longest question sends %d bytes", q.Bytes())
	if q.Bytes() > ai.CookQuestionMaxPromptBytes {
		t.Fatalf("a question can send %d bytes, over the %d documented", q.Bytes(), ai.CookQuestionMaxPromptBytes)
	}
}
