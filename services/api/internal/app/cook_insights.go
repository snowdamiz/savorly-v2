package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

// Cook-tested recipes (docs/COOK-TESTED.md). Cooking mode records when each step is entered and
// left and when its timer runs, on the cook session it already keeps (cook_sessions.go), and the
// questions cooks ask hands-free or of the sous-chef are kept with their step. A nightly pass turns
// them into each recipe's numbers: how long each step really takes, where cooks give up, how many
// finish, and the questions cooks keep asking with an answer. Nobody's own numbers or words show:
// a step's numbers need 5 sessions, a question 3 cooks asking it, and a member can keep their
// cooking out of it altogether (preferences.shareCooking).

const (
	// cookTestedCooks verified cooks make a recipe cook-tested; fewer show as early.
	cookTestedCooks = 5
	// A step's numbers show once this many sessions spent usable time on it.
	stepStatsSessions = 5
	// "Finished by 9 in 10 who started" shows once this many sessions are over.
	finishRateSessions = 20
	// A question shows once this many cooks asked it (in the 90 days questions are kept).
	questionAskers = 3
	// Sessions with step events are read, and kept, for this long.
	cookInsightDays = 180
	// The latest sessions of a recipe a pass reads.
	cookInsightSample = 500
	// The most step events one session keeps, and one request sends.
	cookEventsPerSession, cookEventsPerRequest = 600, 50
	// A visit to a step shorter than this is a glance (reading ahead), not time spent on it.
	glanceMillis = 5_000
	// A visit longer than the step's timer and this is a phone left running: the session's time on
	// that step doesn't count.
	idleMillis = 30 * 60_000
)

// cookStepKey names a step by its text, so an edited step starts its numbers afresh while a
// recipe's other changes (a photo, the title, steps added elsewhere) keep them.
func cookStepKey(text string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.Join(strings.Fields(text), " "))))
	return hex.EncodeToString(sum[:8])
}

// cookInsightRoutes are cooking mode's step events, a recipe's insights and its author's view.
func (a *App) cookInsightRoutes(v fiber.Router) {
	v.Post("/cook-sessions/:id/events", a.requireAuth, perUser(120, time.Minute), a.recordCookEvents)
	v.Get("/recipes/:id/insights", a.recipeInsights)
	v.Get("/recipes/:id/insights/author", a.requireAuth, a.authorInsights)
	v.Patch("/recipes/:id/insights/questions/:question", a.requireAuth, a.updateStepQuestion)
}

// recordCookEvents keeps what cooking mode reports of a session's steps:
// {"events":[{"seq","kind","step","at"}]}, kind one of enter, leave, timer_start, timer_pause
// and timer_end, step 1-based, at the app's clock in milliseconds. It answers 204 whether or not
// it kept them: a session that is over, a member who keeps their cooking out, or a session
// already holding its share of events keep nothing, and the app has nothing to do about any of it.
func (a *App) recordCookEvents(c fiber.Ctx) error {
	var in struct {
		Events []struct {
			Seq  int    `json:"seq"`
			Kind string `json:"kind"`
			Step int    `json:"step"`
			At   int64  `json:"at"`
		} `json:"events"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if len(in.Events) == 0 || len(in.Events) > cookEventsPerRequest {
		return fiber.NewError(400, "Send between 1 and 50 cooking events.")
	}
	for _, ev := range in.Events {
		switch ev.Kind {
		case "enter", "leave", "timer_start", "timer_pause", "timer_end":
		default:
			return fiber.NewError(400, "Unknown cooking event.")
		}
		if ev.Seq < 0 || ev.Seq > 100000 || ev.Step < 1 || ev.Step > 100 || ev.At <= 0 {
			return fiber.NewError(400, "Invalid cooking event.")
		}
	}
	ctx, me := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var recipe string
	var steps, events int
	var open, sharing bool
	var raw []byte
	// A session takes late events for a few minutes after it finishes: the last step's leave.
	e = tx.QueryRow(ctx, `SELECT k.recipe_id,k.steps,k.events,k.started_at>now()-interval '24 hours' AND (k.finished_at IS NULL OR k.finished_at>now()-interval '10 minutes'),
 r.steps,COALESCE((u.preferences->>'shareCooking')::boolean,true)
 FROM cook_sessions k JOIN recipes r ON r.id=k.recipe_id JOIN users u ON u.id=k.user_id WHERE k.id=$1 AND k.user_id=$2 AND r.author_id<>k.user_id FOR UPDATE OF k`, c.Params("id"), me).
		Scan(&recipe, &steps, &events, &open, &raw, &sharing)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "This item could not be found.")
	}
	if e != nil {
		return e
	}
	if !open || !sharing || events >= cookEventsPerSession {
		return c.SendStatus(204)
	}
	var current []Step
	_ = json.Unmarshal(raw, &current)
	var seqs, numbers []int
	var kinds, keys []string
	var at []int64
	for _, ev := range in.Events {
		// Steps are the recipe's as it is now: one edited meanwhile names its new text.
		if ev.Step > len(current) || ev.Step > steps || len(seqs) >= cookEventsPerSession-events {
			continue
		}
		seqs, kinds, numbers, at = append(seqs, ev.Seq), append(kinds, ev.Kind), append(numbers, ev.Step), append(at, ev.At)
		keys = append(keys, cookStepKey(current[ev.Step-1].Text))
	}
	if len(seqs) == 0 {
		return c.SendStatus(204)
	}
	tag, e := tx.Exec(ctx, `INSERT INTO cook_step_events(session_id,seq,kind,step,step_key,at_ms)
 SELECT $1,s,k,n,y,t FROM unnest($2::int[],$3::text[],$4::int[],$5::text[],$6::bigint[]) AS x(s,k,n,y,t) ON CONFLICT DO NOTHING`, c.Params("id"), seqs, kinds, numbers, keys, at)
	if e != nil {
		return e
	}
	if tag.RowsAffected() > 0 {
		if _, e = tx.Exec(ctx, `UPDATE cook_sessions SET events=events+$2 WHERE id=$1`, c.Params("id"), tag.RowsAffected()); e != nil {
			return e
		}
		if e = insightsDue(ctx, tx, recipe); e != nil {
			return e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// insightsDue queues a recipe for the next nightly pass.
func insightsDue(ctx context.Context, db execer, recipe string) error {
	_, e := db.Exec(ctx, `INSERT INTO recipe_insights_due(recipe_id) VALUES($1) ON CONFLICT (recipe_id) DO UPDATE SET since=now()`, recipe)
	return e
}

// recordCookQuestion keeps what a cook asked at a step of someone else's published recipe, for
// the nightly pass to group with what others asked there. Nothing is kept for a member who keeps
// their cooking out, for the author's own recipe, or outside a step. It never fails the request
// it rides on: a question that can't be kept is only logged.
func recordCookQuestion(ctx context.Context, db recipeWriter, member, recipe string, step int, question, source string) {
	question = strings.Join(strings.Fields(question), " ")
	if step < 1 || !validText(question, 2, 500) {
		return
	}
	var text string
	e := db.QueryRow(ctx, `SELECT r.steps->($3::int-1)->>'text' FROM recipes r JOIN users u ON u.id=$2
 WHERE r.id=$1 AND r.published AND r.author_id<>$2 AND $3<=jsonb_array_length(r.steps) AND COALESCE((u.preferences->>'shareCooking')::boolean,true)`, recipe, member, step).Scan(&text)
	if errors.Is(e, pgx.ErrNoRows) {
		return
	}
	if e == nil {
		_, e = db.Exec(ctx, `INSERT INTO cook_questions(id,user_id,recipe_id,step,step_key,question,source) VALUES($1,$2,$3,$4,$5,$6,$7)`, uuid.NewString(), member, recipe, step, cookStepKey(text), question, source)
	}
	if e == nil {
		e = insightsDue(ctx, db, recipe)
	}
	if e != nil {
		slog.Warn("keep a cooking question", "recipe", recipe, "error", e)
	}
}

// stepNote is what a step's numbers tell cooks, when they tell them something: "longer", cooks
// needed Minutes more than the step's timer; "usual", a step without a timer usually takes
// Minutes.
type stepNote struct {
	Kind    string `json:"kind"`
	Minutes int    `json:"minutes"`
}

// noteFor is a step's note from its numbers, or nil. Running over the timer counts once it's at
// least 2 minutes and a quarter of the timer; a step without one says its usual time from 3
// minutes up, where knowing helps plan.
func noteFor(sessions, median, timer int) *stepNote {
	if sessions < stepStatsSessions {
		return nil
	}
	if timer > 0 {
		if extra := median - timer; extra >= 120 && 4*extra >= timer {
			return &stepNote{"longer", int(math.Round(float64(extra) / 60))}
		}
		return nil
	}
	if median >= 180 {
		return &stepNote{"usual", int(math.Round(float64(median) / 60))}
	}
	return nil
}

// stepQuestion is a question cooks keep asking at a step, with its answer. checked is the
// author's: they wrote or approved the answer. askers and hidden are for the author's view.
type stepQuestion struct {
	ID       string `json:"id"`
	Question string `json:"question"`
	Answer   string `json:"answer"`
	Checked  bool   `json:"checked"`
	Askers   int    `json:"askers,omitempty"`
	Hidden   bool   `json:"hidden,omitempty"`
}

// stepInsight is one step of a recipe's insights, by its place in the recipe as it is now.
type stepInsight struct {
	Step          int            `json:"step"`
	Sessions      int            `json:"sessions"`
	MedianSeconds int            `json:"medianSeconds,omitempty"`
	P75Seconds    int            `json:"p75Seconds,omitempty"`
	TimerSeconds  int            `json:"timerSeconds"`
	Note          *stepNote      `json:"note"`
	Questions     []stepQuestion `json:"questions"`
	// The author's view also has how many sessions that are over reached the step, and how many
	// of those stopped there.
	Entered *int `json:"entered,omitempty"`
	GaveUp  *int `json:"gaveUp,omitempty"`
}

// recipeInsight is a recipe's insights: its sessions that are over and how many finished, and
// its steps. finishRate shows from finishRateSessions sessions.
type recipeInsight struct {
	Sessions   int           `json:"sessions"`
	Finished   int           `json:"finished"`
	FinishRate *float64      `json:"finishRate"`
	Steps      []stepInsight `json:"steps"`
	ComputedAt *time.Time    `json:"computedAt"`
}

// loadInsights reads a recipe's insights against its steps as they are now. Cooks see a step's
// numbers from stepStatsSessions sessions and the questions questionAskers cooks asked that
// have an answer and aren't hidden; the author also sees how far cooks got, and hidden and
// unanswered questions, but never a number or a question from fewer cooks than that.
func loadInsights(ctx context.Context, db engagementDB, recipe string, steps []Step, author bool) (recipeInsight, error) {
	out := recipeInsight{Steps: []stepInsight{}}
	e := db.QueryRow(ctx, `SELECT sessions,finished,computed_at FROM recipe_insights WHERE recipe_id=$1`, recipe).Scan(&out.Sessions, &out.Finished, &out.ComputedAt)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	if out.Sessions >= finishRateSessions {
		rate := float64(out.Finished) / float64(out.Sessions)
		out.FinishRate = &rate
	}
	byKey := map[string]*stepInsight{}
	order := make([]*stepInsight, len(steps))
	for i, s := range steps {
		order[i] = &stepInsight{Step: i + 1, TimerSeconds: s.Seconds, Questions: []stepQuestion{}}
		if key := cookStepKey(s.Text); byKey[key] == nil {
			byKey[key] = order[i]
		}
	}
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	rows, e := db.Query(ctx, `SELECT step_key,sessions,median_seconds,p75_seconds,entered,gave_up FROM recipe_step_stats WHERE recipe_id=$1 AND step_key=ANY($2)`, recipe, keys)
	if e != nil {
		return out, e
	}
	for rows.Next() {
		var key string
		var sessions, median, p75, entered, gaveUp int
		if e = rows.Scan(&key, &sessions, &median, &p75, &entered, &gaveUp); e != nil {
			rows.Close()
			return out, e
		}
		s := byKey[key]
		if sessions >= stepStatsSessions {
			s.Sessions, s.MedianSeconds, s.P75Seconds = sessions, median, p75
			s.Note = noteFor(sessions, median, s.TimerSeconds)
		}
		if author && entered >= stepStatsSessions {
			s.Entered, s.GaveUp = &entered, &gaveUp
		}
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return out, e
	}
	rows, e = db.Query(ctx, `SELECT q.step_key,q.id,q.question,q.answer,q.answered_by='author',q.hidden,n.askers FROM recipe_step_questions q
 CROSS JOIN LATERAL (SELECT count(DISTINCT c.user_id)::int AS askers FROM cook_questions c WHERE c.cluster_id=q.id) n
 WHERE q.recipe_id=$1 AND q.step_key=ANY($2) AND n.askers>=$3 AND ($4 OR (NOT q.hidden AND q.answer<>''))
 ORDER BY n.askers DESC,q.created_at,q.id`, recipe, keys, questionAskers, author)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var q stepQuestion
		if e = rows.Scan(&key, &q.ID, &q.Question, &q.Answer, &q.Checked, &q.Hidden, &q.Askers); e != nil {
			return out, e
		}
		if !author {
			q.Askers, q.Hidden = 0, false
		}
		s := byKey[key]
		// Cooks see the two asked most at a step.
		if author || len(s.Questions) < 2 {
			s.Questions = append(s.Questions, q)
		}
	}
	if e = rows.Err(); e != nil {
		return out, e
	}
	for _, s := range order {
		// A step repeated word for word shares the first one's numbers and questions.
		if key := cookStepKey(steps[s.Step-1].Text); byKey[key] != s {
			shared := *byKey[key]
			shared.Step, shared.TimerSeconds = s.Step, s.TimerSeconds
			shared.Note = noteFor(shared.Sessions, shared.MedianSeconds, s.TimerSeconds)
			s = &shared
		}
		if author || s.Note != nil || len(s.Questions) > 0 {
			out.Steps = append(out.Steps, *s)
		}
	}
	return out, nil
}

// recipeInsights answers what cooks of a published recipe found (or of the member's own): its
// finish rate and its steps' notes and questions. Steps with nothing to say are left out.
func (a *App) recipeInsights(c fiber.Ctx) error {
	viewer, e := a.sessionUser(c)
	if e != nil {
		return e
	}
	var raw []byte
	e = a.DB.QueryRow(c.Context(), `SELECT r.steps`+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=$2)`, c.Params("id"), viewer).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Recipe not found.")
	}
	if e != nil {
		return e
	}
	var steps []Step
	_ = json.Unmarshal(raw, &steps)
	out, e := loadInsights(c.Context(), a.DB, c.Params("id"), steps, false)
	if e != nil {
		return e
	}
	return c.JSON(out)
}

// authorInsights is "Where cooks get stuck", for the recipe's author: every step with its
// numbers, how far cooks got, and the questions cooks keep asking, answered or not.
func (a *App) authorInsights(c fiber.Ctx) error {
	var raw []byte
	var cooks, minutes int
	e := a.DB.QueryRow(c.Context(), `SELECT r.steps,COALESCE(t.cooks,0),COALESCE(t.minutes,0) FROM recipes r LEFT JOIN recipe_cook_times t ON t.recipe_id=r.id WHERE r.id=$1 AND r.author_id=$2`, c.Params("id"), userID(c)).Scan(&raw, &cooks, &minutes)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Recipe not found or you are not its author.")
	}
	if e != nil {
		return e
	}
	var steps []Step
	_ = json.Unmarshal(raw, &steps)
	out, e := loadInsights(c.Context(), a.DB, c.Params("id"), steps, true)
	if e != nil {
		return e
	}
	var cooked any
	if cooks >= 3 {
		cooked = minutes
	}
	return c.JSON(fiber.Map{"verifiedCooks": cooks, "cookedMinutes": cooked, "sessions": out.Sessions, "finished": out.Finished, "finishRate": out.FinishRate, "computedAt": out.ComputedAt, "steps": out.Steps})
}

// updateStepQuestion is the author's say on a question cooks keep asking about their recipe:
// {"answer"} replaces its answer with theirs, {"approve": true} keeps the sous-chef's as theirs,
// and {"hidden"} hides it from cooks or shows it again.
func (a *App) updateStepQuestion(c fiber.Ctx) error {
	var in struct {
		Answer  *string `json:"answer"`
		Approve bool    `json:"approve"`
		Hidden  *bool   `json:"hidden"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	var answer any
	if in.Answer != nil {
		text := strings.TrimSpace(*in.Answer)
		if !validText(text, 2, 1000) {
			return fiber.NewError(400, "Write an answer of up to 1,000 characters.")
		}
		answer = text
	}
	var q stepQuestion
	e := a.DB.QueryRow(c.Context(), `UPDATE recipe_step_questions q SET answer=COALESCE($4,q.answer),
 answered_by=CASE WHEN $4::text IS NOT NULL OR ($5 AND q.answer<>'') THEN 'author' ELSE q.answered_by END,hidden=COALESCE($6,q.hidden),updated_at=now()
 FROM recipes r WHERE q.id=$2 AND q.recipe_id=$1 AND r.id=q.recipe_id AND r.author_id=$3
 RETURNING q.id,q.question,q.answer,q.answered_by='author',q.hidden`, c.Params("id"), c.Params("question"), userID(c), answer, in.Approve, in.Hidden).
		Scan(&q.ID, &q.Question, &q.Answer, &q.Checked, &q.Hidden)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Question not found.")
	}
	if e != nil {
		return e
	}
	return c.JSON(q)
}

// stepInsightLine is what a step's insights tell the sous-chef, for its answers in cooking mode:
// how long cooks really took there and what they keep asking. "" when there's nothing to tell.
func stepInsightLine(s stepInsight) string {
	parts := []string{}
	if s.Sessions >= stepStatsSessions {
		line := fmt.Sprintf("Other cooks' sessions here usually took about %s (a quarter took over %s)", duration(roundMinute(s.MedianSeconds)), duration(roundMinute(s.P75Seconds)))
		if s.TimerSeconds > 0 {
			line += ", though the step's timer says " + duration(s.TimerSeconds)
		}
		parts = append(parts, line+".")
	}
	for _, q := range s.Questions {
		parts = append(parts, "Cooks often ask here: “"+clip(q.Question, 200)+"” Answer: "+clip(q.Answer, 400))
	}
	if len(parts) == 0 {
		return ""
	}
	return "What other cooks found at this step (anonymous, from cooking in Savorly): " + strings.Join(parts, " ")
}

// roundMinute rounds seconds to a whole minute from a minute up.
func roundMinute(seconds int) int {
	if seconds < 60 {
		return seconds
	}
	return int(math.Round(float64(seconds)/60)) * 60
}

// stepInsightsFor is each step's line for the sous-chef (stepInsightLine), by 0-based step; a
// failure only leaves them out.
func stepInsightsFor(ctx context.Context, db engagementDB, recipe string, steps []Step) map[int]string {
	in, e := loadInsights(ctx, db, recipe, steps, false)
	if e != nil {
		slog.Warn("load a recipe's insights", "recipe", recipe, "error", e)
		return nil
	}
	lines := map[int]string{}
	for _, s := range in.Steps {
		if line := stepInsightLine(s); line != "" {
			lines[s.Step-1] = line
		}
	}
	return lines
}

// insightEvent is one step event as the pass reads it, in the session's order.
type insightEvent struct {
	kind, key string
	at        int64
}

// insightSession is one session as the pass reads it: whether it finished, whether it is over
// (finished, or a day old), and its events.
type insightSession struct {
	finished, over bool
	events         []insightEvent
}

// stepFold is what the sessions add up to for one step.
type stepFold struct {
	times                        []int
	entered, gaveUp, timerStarts int
}

// foldSessions adds up sessions step by step. A session's time on a step is the sum of its visits
// there (from entering it to entering another step or leaving), glances under glanceMillis left
// out; a session with a visit longer than the step's timer and idleMillis (timers, by step key)
// doesn't count for that step, nor does a visit that never ends. Sessions that are over count
// for entered, and for gaveUp at the last step they entered if they didn't finish. over and
// finished count the sessions that are over and those that finished.
func foldSessions(sessions []insightSession, timers map[string]int) (folds map[string]*stepFold, over, finished int) {
	folds = map[string]*stepFold{}
	fold := func(key string) *stepFold {
		if folds[key] == nil {
			folds[key] = &stepFold{}
		}
		return folds[key]
	}
	for _, s := range sessions {
		spent, idle, timed, entered := map[string]int64{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
		open, since, last := "", int64(0), ""
		close := func(at int64) {
			if open == "" {
				return
			}
			visit := at - since
			if visit > int64(timers[open])*1000+idleMillis || visit < 0 {
				idle[open] = true
			} else if visit >= glanceMillis {
				spent[open] += visit
			}
			open = ""
		}
		for _, ev := range s.events {
			switch ev.kind {
			case "enter":
				close(ev.at)
				open, since, last = ev.key, ev.at, ev.key
				entered[ev.key] = true
			case "leave":
				close(ev.at)
			case "timer_start":
				timed[ev.key] = true
			}
		}
		for key, ms := range spent {
			if !idle[key] && ms > 0 {
				f := fold(key)
				f.times = append(f.times, int((ms+500)/1000))
			}
		}
		for key := range timed {
			fold(key).timerStarts++
		}
		if !s.over {
			continue
		}
		over++
		if s.finished {
			finished++
		}
		for key := range entered {
			fold(key).entered++
		}
		if !s.finished && last != "" {
			fold(last).gaveUp++
		}
	}
	return folds, over, finished
}

// percentile is the p-th percentile of sorted times, interpolated like percentile_cont.
func percentile(sorted []int, p float64) int {
	if len(sorted) == 0 {
		return 0
	}
	at := p * float64(len(sorted)-1)
	lo := int(math.Floor(at))
	hi := min(lo+1, len(sorted)-1)
	return int(math.Round(float64(sorted[lo]) + (at-float64(lo))*float64(sorted[hi]-sorted[lo])))
}

// computeInsights recomputes a recipe's numbers from its latest sessions with step events in the
// insights window, others' only, by its steps as they are now: what each step key adds up to,
// and how many sessions are over and finished. Numbers of steps the recipe no longer has go.
// It reports whether sessions are still under way, so the recipe is read again next night.
func computeInsights(ctx context.Context, db engagementDB, recipe string) (pending bool, e error) {
	var raw []byte
	e = db.QueryRow(ctx, `SELECT steps FROM recipes WHERE id=$1`, recipe).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var steps []Step
	_ = json.Unmarshal(raw, &steps)
	timers, keys := map[string]int{}, []string{}
	for _, s := range steps {
		key := cookStepKey(s.Text)
		if _, seen := timers[key]; !seen {
			timers[key], keys = s.Seconds, append(keys, key)
		}
	}
	rows, e := db.Query(ctx, `SELECT k.id,k.finished_at IS NOT NULL,k.finished_at IS NOT NULL OR k.started_at<now()-interval '24 hours',e.kind,e.step_key,e.at_ms
 FROM (SELECT s.id,s.finished_at,s.started_at FROM cook_sessions s JOIN recipes r ON r.id=s.recipe_id
   WHERE s.recipe_id=$1 AND s.events>0 AND s.user_id<>r.author_id AND s.started_at>now()-make_interval(days=>$2) ORDER BY s.started_at DESC LIMIT $3) k
 JOIN cook_step_events e ON e.session_id=k.id ORDER BY k.started_at,k.id,e.seq`, recipe, cookInsightDays, cookInsightSample)
	if e != nil {
		return false, e
	}
	var sessions []insightSession
	current := ""
	for rows.Next() {
		var id string
		var ev insightEvent
		var finished, over bool
		if e = rows.Scan(&id, &finished, &over, &ev.kind, &ev.key, &ev.at); e != nil {
			rows.Close()
			return false, e
		}
		if id != current {
			current = id
			sessions = append(sessions, insightSession{finished: finished, over: over})
			pending = pending || !over
		}
		last := &sessions[len(sessions)-1]
		last.events = append(last.events, ev)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return false, e
	}
	folds, over, finished := foldSessions(sessions, timers)
	var stepKeys []string
	var counts, medians, p75s, entered, gaveUp, timed []int
	for _, key := range keys {
		f := folds[key]
		if f == nil {
			continue
		}
		slices.Sort(f.times)
		stepKeys = append(stepKeys, key)
		counts, medians, p75s = append(counts, len(f.times)), append(medians, percentile(f.times, 0.5)), append(p75s, percentile(f.times, 0.75))
		entered, gaveUp, timed = append(entered, f.entered), append(gaveUp, f.gaveUp), append(timed, f.timerStarts)
	}
	if _, e = db.Exec(ctx, `DELETE FROM recipe_step_stats WHERE recipe_id=$1 AND NOT step_key=ANY($2)`, recipe, stepKeys); e != nil {
		return false, e
	}
	if _, e = db.Exec(ctx, `INSERT INTO recipe_step_stats(recipe_id,step_key,sessions,median_seconds,p75_seconds,entered,gave_up,timer_starts)
 SELECT $1,k,n,m,p,x,g,t FROM unnest($2::text[],$3::int[],$4::int[],$5::int[],$6::int[],$7::int[],$8::int[]) AS u(k,n,m,p,x,g,t)
 ON CONFLICT (recipe_id,step_key) DO UPDATE SET sessions=excluded.sessions,median_seconds=excluded.median_seconds,p75_seconds=excluded.p75_seconds,
  entered=excluded.entered,gave_up=excluded.gave_up,timer_starts=excluded.timer_starts`, recipe, stepKeys, counts, medians, p75s, entered, gaveUp, timed); e != nil {
		return false, e
	}
	_, e = db.Exec(ctx, `INSERT INTO recipe_insights(recipe_id,sessions,finished) VALUES($1,$2,$3)
 ON CONFLICT (recipe_id) DO UPDATE SET sessions=excluded.sessions,finished=excluded.finished,computed_at=now()`, recipe, over, finished)
	return pending, e
}

// RunCookInsights runs the nightly pass: hourly checks, so a container that slept catches up,
// and one pass a UTC day from 03:00.
func RunCookInsights(ctx context.Context, db *pgxpool.Pool) {
	a := &App{DB: db, AI: ai.New(), Context: ctx}
	timer := time.NewTimer(3 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if _, e := a.runCookInsights(ctx, time.Now()); e != nil && ctx.Err() == nil {
				slog.Error("cook insights", "error", e)
			}
			timer.Reset(time.Hour)
		}
	}
}

// insightHour is the UTC hour from which a day's pass runs.
const insightHour = 3

// cookInsightQuestionRecipes is how many recipes' questions a pass groups with the model at most
// (COOK_INSIGHT_QUESTION_RECIPES), the most saved first: a cap on what a night can cost.
func cookInsightQuestionRecipes() int {
	if n, e := strconv.Atoi(os.Getenv("COOK_INSIGHT_QUESTION_RECIPES")); e == nil && n >= 0 {
		return n
	}
	return 200
}

// insightRun is what a pass did.
type insightRun struct{ recipes, grouped int }

// runCookInsights does the day's pass, once: it reads every recipe with something new, most
// saved first, then groups the new questions of the most saved of them. It reports nil when it
// isn't time, another replica holds the lock, or the day's pass already ran.
func (a *App) runCookInsights(ctx context.Context, now time.Time) (*insightRun, error) {
	now = now.UTC()
	if now.Hour() < insightHour {
		return nil, nil
	}
	conn, e := a.DB.Acquire(ctx)
	if e != nil {
		return nil, e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(7182331)`).Scan(&locked); e != nil || !locked {
		return nil, e
	}
	defer func() {
		if _, e := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(7182331)`); e != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	tag, e := conn.Exec(ctx, `INSERT INTO cook_insight_runs(day) VALUES($1) ON CONFLICT DO NOTHING`, now.Format("2006-01-02"))
	if e != nil || tag.RowsAffected() == 0 {
		return nil, e
	}
	run := &insightRun{}
	var start time.Time
	if e = conn.QueryRow(ctx, `SELECT now()`).Scan(&start); e != nil {
		return nil, e
	}
	rows, e := conn.Query(ctx, `SELECT d.recipe_id FROM recipe_insights_due d JOIN recipes r ON r.id=d.recipe_id
 ORDER BY (SELECT count(*) FROM saves s WHERE s.recipe_id=d.recipe_id) DESC,d.recipe_id`)
	if e != nil {
		return nil, e
	}
	var due []string
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		due = append(due, id)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	groups := cookInsightQuestionRecipes()
	for _, recipe := range due {
		if ctx.Err() != nil {
			return run, ctx.Err()
		}
		pending, e := computeInsights(ctx, conn, recipe)
		if e != nil {
			slog.Warn("compute a recipe's insights", "recipe", recipe, "error", e)
			continue
		}
		run.recipes++
		if a.AI.TextEnabled() && run.grouped < groups {
			grouped, e := a.groupQuestions(ctx, conn, recipe)
			if e != nil {
				slog.Warn("group a recipe's questions", "recipe", recipe, "error", e)
			}
			if grouped {
				run.grouped++
			}
		}
		// Done until something new comes, unless sessions are still under way: those are read
		// again tomorrow, once they're over.
		if pending {
			_, e = conn.Exec(ctx, `UPDATE recipe_insights_due SET since=now() WHERE recipe_id=$1`, recipe)
		} else {
			_, e = conn.Exec(ctx, `DELETE FROM recipe_insights_due WHERE recipe_id=$1 AND since<=$2`, recipe, start)
		}
		if e != nil {
			return run, e
		}
	}
	_, e = conn.Exec(ctx, `UPDATE cook_insight_runs SET finished_at=now(),recipes=$2,clustered=$3 WHERE day=$1`, now.Format("2006-01-02"), run.recipes, run.grouped)
	if run.recipes > 0 {
		slog.Info("cook insights", "recipes", run.recipes, "grouped", run.grouped)
	}
	return run, e
}

// Questions sent in one grouping: the newest of a step's, and of the whole recipe's.
const groupStepQuestions, groupRecipeQuestions = 40, 120

// groupQuestions groups a recipe's new questions with the model, at the steps it has now where
// enough cooks asked something to show (questionAskers): into the questions those steps show
// already, or new ones with their answers. Questions sent are marked read, grouped or not, so
// none is paid for twice. It reports whether it asked the model.
func (a *App) groupQuestions(ctx context.Context, db engagementDB, recipe string) (bool, error) {
	var title, language string
	var raw, ingredients []byte
	e := db.QueryRow(ctx, `SELECT title,language,steps,ingredients FROM recipes WHERE id=$1`, recipe).Scan(&title, &language, &raw, &ingredients)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var steps []Step
	_ = json.Unmarshal(raw, &steps)
	stepOf, keys := map[string]int{}, []string{}
	for i, s := range steps {
		if key := cookStepKey(s.Text); stepOf[key] == 0 {
			stepOf[key], keys = i+1, append(keys, key)
		}
	}
	// Unread questions at steps that enough cooks asked about, newest first, a step's share each.
	rows, e := db.Query(ctx, `WITH asked AS (SELECT step_key FROM cook_questions WHERE recipe_id=$1 AND step_key=ANY($2) AND created_at>now()-interval '90 days'
  GROUP BY step_key HAVING count(DISTINCT user_id)>=$3),
 unread AS (SELECT c.id,c.step_key,c.question,row_number() OVER (PARTITION BY c.step_key ORDER BY c.created_at DESC,c.id) AS n
  FROM cook_questions c WHERE c.recipe_id=$1 AND c.clustered_at IS NULL AND c.step_key IN (SELECT step_key FROM asked))
 SELECT id,step_key,question FROM unread WHERE n<=$4 ORDER BY n,id LIMIT $5`, recipe, keys, questionAskers, groupStepQuestions, groupRecipeQuestions)
	if e != nil {
		return false, e
	}
	byStep := map[string]*ai.QuestionStep{}
	var sent []string
	for rows.Next() {
		var id, key, text string
		if e = rows.Scan(&id, &key, &text); e != nil {
			rows.Close()
			return false, e
		}
		if byStep[key] == nil {
			n := stepOf[key]
			byStep[key] = &ai.QuestionStep{Step: n, Text: stepText(steps[n-1], 600), Known: []ai.KnownQuestion{}}
		}
		byStep[key].Asked = append(byStep[key].Asked, ai.AskedQuestion{ID: id, Text: clip(text, 300)})
		sent = append(sent, id)
	}
	rows.Close()
	if e = rows.Err(); e != nil || len(sent) == 0 {
		return false, e
	}
	stepKeys := make([]string, 0, len(byStep))
	for key := range byStep {
		stepKeys = append(stepKeys, key)
	}
	rows, e = db.Query(ctx, `SELECT id,step_key,question FROM recipe_step_questions WHERE recipe_id=$1 AND step_key=ANY($2) ORDER BY created_at,id`, recipe, stepKeys)
	if e != nil {
		return false, e
	}
	for rows.Next() {
		var k ai.KnownQuestion
		var key string
		if e = rows.Scan(&k.ID, &key, &k.Question); e != nil {
			rows.Close()
			return false, e
		}
		byStep[key].Known = append(byStep[key].Known, k)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return false, e
	}
	brief := &sceneRecipe{id: recipe, title: title, mine: true, steps: steps}
	_ = json.Unmarshal(ingredients, &brief.ingredients)
	q := ai.RecipeQuestions{Title: title, Language: language, Recipe: brief.text()}
	for _, key := range keys {
		if s := byStep[key]; s != nil {
			q.Steps = append(q.Steps, *s)
		}
	}
	usage, e := a.reserveQuestions(ctx, q.Estimate())
	if e != nil {
		return false, e
	}
	call, cancel := context.WithTimeout(ctx, 60*time.Second)
	grouped, cost, e := a.AI.GroupQuestions(call, q)
	cancel()
	var spent error
	if errors.Is(e, ai.ErrNotSent) {
		spent = releaseUsage(context.Background(), a.DB, usage)
	} else {
		spent = settleUsage(context.Background(), a.DB, usage, cost)
	}
	if spent != nil {
		slog.Warn("settle question grouping", "error", spent)
	}
	if errors.Is(e, ai.ErrNotSent) {
		return false, e
	}
	if e != nil {
		// Paid for, so these questions aren't sent again.
		_, me := db.Exec(ctx, `UPDATE cook_questions SET clustered_at=now() WHERE id=ANY($1)`, sent)
		return true, errors.Join(e, me)
	}
	keyOf := map[int]string{}
	for key, n := range stepOf {
		keyOf[n] = key
	}
	ids := map[string]string{}
	for _, n := range grouped.New {
		id := uuid.NewString()
		ids[n.Key] = id
		if _, e = db.Exec(ctx, `INSERT INTO recipe_step_questions(id,recipe_id,step_key,question,answer) VALUES($1,$2,$3,$4,$5)`, id, recipe, keyOf[n.Step], clip(n.Question, 300), clip(n.Answer, 1000)); e != nil {
			return true, e
		}
	}
	var asked, groups []string
	for _, g := range grouped.Assign {
		group := g.Group
		if id, ok := ids[group]; ok {
			group = id
		}
		asked, groups = append(asked, g.Question), append(groups, group)
	}
	_, e = db.Exec(ctx, `UPDATE cook_questions c SET clustered_at=now(),cluster_id=COALESCE(g.cluster,c.cluster_id)
 FROM unnest($1::text[]) AS s(id) LEFT JOIN unnest($2::text[],$3::text[]) AS g(id,cluster) ON g.id=s.id
 WHERE c.id=s.id AND c.recipe_id=$4`, sent, asked, groups, recipe)
	return true, e
}

// reserveQuestions commits a grouping's reservation against the shared budget, like a
// translation's: no member pays for it.
func (a *App) reserveQuestions(ctx context.Context, estimate float64) (int64, error) {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback(context.Background())
	if e = reserveShared(ctx, tx, estimate); e != nil {
		return 0, e
	}
	usage, e := recordUsage(ctx, tx, "", "cook_questions", estimate)
	if e == nil {
		e = tx.Commit(ctx)
	}
	return usage, e
}

// forgetCooking removes what a member's cooking added to recipes' insights, when they keep it
// out: their step events and questions. Their sessions stay what they are (verified cooks still
// count for cook times and the fund), and the recipes are read again next night.
func forgetCooking(ctx context.Context, db engagementDB, member string) error {
	if _, e := db.Exec(ctx, `INSERT INTO recipe_insights_due(recipe_id) SELECT DISTINCT recipe_id FROM cook_sessions WHERE user_id=$1 AND events>0
 UNION SELECT DISTINCT recipe_id FROM cook_questions WHERE user_id=$1 ON CONFLICT (recipe_id) DO UPDATE SET since=now()`, member); e != nil {
		return e
	}
	if _, e := db.Exec(ctx, `DELETE FROM cook_step_events e USING cook_sessions s WHERE e.session_id=s.id AND s.user_id=$1`, member); e != nil {
		return e
	}
	if _, e := db.Exec(ctx, `UPDATE cook_sessions SET events=0 WHERE user_id=$1 AND events>0`, member); e != nil {
		return e
	}
	_, e := db.Exec(ctx, `DELETE FROM cook_questions WHERE user_id=$1`, member)
	return e
}
