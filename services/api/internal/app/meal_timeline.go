package app

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The whole-meal timeline (docs/MEAL-TIMELINE.md): two to four recipes and a time to eat become
// one timed plan, so everything is ready together. It's a small list-scheduling problem, solved
// here without AI: working backwards from the eating time, the longest dish first, waiting steps
// overlap, the cook does one hands-on thing at a time, the oven holds one heat at a time, and the
// burners in use stay within what the kitchen has. Each step's time is its cook-tested one once
// 5 cooks have measured it (docs/COOK-TESTED.md), else its timing (step_timing.go). What the
// kitchen can't do is a warning, never a step left out. A meal cooked together keeps one cook
// session per dish, so each dish counts as cooked (docs/CREATOR-FUND.md).

const (
	// The kitchen a member has unless they say: burners on the hob and ovens, and the most of each.
	defaultBurners, defaultOvens = 4, 1
	maxBurners, maxOvens         = 12, 3
	// How many recipes cook together.
	minMealDishes, maxMealDishes = 2, 4
	// How long an oven takes to heat, ahead of the step it's preheated for.
	preheatSeconds = 15 * 60
	// Oven heats this close, in °C, are one heat: a cook would bake both at either.
	sameHeat = 10
	// A step goes at most this much earlier than it would to keep the kitchen within what it has;
	// past that it stays where it fits the cook's hands, and the plan warns.
	kitchenSlack = 15 * 60
	// Cooked food that waits longer than this, because the cook's hands were busy elsewhere, is
	// warned about.
	standing = 15 * 60
	// A stretch without anything hands-on to do shows as free time from this long.
	freeSeconds = 5 * 60
)

// mealKitchen is what the kitchen has.
type mealKitchen struct {
	Burners int `json:"burners"`
	Ovens   int `json:"ovens"`
}

// mealStep is a step as the scheduler takes it: seconds hands-on, then waiting, and what it
// occupies all along.
type mealStep struct {
	active, wait, oven, burners int
}

func (s mealStep) seconds() int { return s.active + s.wait }

// preheat is a step that heats the oven and takes no time: it goes ahead of its dish's next oven
// step, by as long as the oven takes to heat, rather than where the recipe has it.
func (s mealStep) preheat() bool { return s.oven > 0 && s.active == 0 && s.wait == 0 }

// placedStep is a step of dish with its time, in seconds from the meal (negative: before it).
type placedStep struct {
	dish, step int
	mealStep
	start, end int
	// preheating is a preheat placed ahead of its oven step, for preheatSeconds.
	preheating bool
}

func (p placedStep) handsEnd() int { return p.start + p.active }

// mealWarning is something the kitchen can't do: two oven heats at once (heats), more burners
// than it has (needed, have), or food that waits because the cook's hands were busy (seconds).
// at is when it starts.
type mealWarning struct {
	kind         string
	at           int
	dishes       []int
	heats        []int
	needed, have int
	seconds      int
}

// mealSchedule is the plan: every step with its time, in the order they start, the free
// stretches between hands-on work, the warnings, and when cooking starts.
type mealSchedule struct {
	steps    []placedStep
	free     [][2]int
	warnings []mealWarning
	start    int
}

// scheduleMeal plans dishes (each its steps in order) to be ready together at 0. It places steps
// from the last back: of each dish's latest step not yet placed, the one whose hands-on part can
// end latest goes next, the longest dish first when they tie, at the latest time that keeps the
// cook's hands to one step at a time and the kitchen within what it has. Every step is placed.
func scheduleMeal(dishes [][]mealStep, kitchen mealKitchen) mealSchedule {
	kitchen.Burners, kitchen.Ovens = max(kitchen.Burners, 1), max(kitchen.Ovens, 1)
	// Each dish's chain: its steps but the preheats, which go ahead of the oven step after them.
	chains := make([][]int, len(dishes))
	preheats := map[[2]int][]int{}
	for d, steps := range dishes {
		for i, s := range steps {
			if s.preheat() {
				if j := slices.IndexFunc(steps[i+1:], func(n mealStep) bool { return n.oven > 0 && !n.preheat() }); j >= 0 {
					preheats[[2]int{d, i + 1 + j}] = append(preheats[[2]int{d, i + 1 + j}], i)
					continue
				}
			}
			chains[d] = append(chains[d], i)
		}
	}
	remaining, latest, next := make([]int, len(dishes)), make([]int, len(dishes)), make([]int, len(dishes))
	for d := range dishes {
		next[d] = len(chains[d]) - 1
		for _, i := range chains[d] {
			remaining[d] += dishes[d][i].seconds()
		}
	}
	var out mealSchedule
	for {
		best, end, hands, busy := -1, 0, 0, 0
		var conflicts []mealWarning
		for d := range dishes {
			if next[d] < 0 {
				continue
			}
			s := dishes[d][chains[d][next[d]]]
			e, h, c := placeStep(out.steps, d, s, latest[d], kitchen)
			// What decides is when the cook's hands would be done with it: hands-on work is laid
			// out back to back from the meal, and a waiting step's minute of hands goes where it
			// leaves room.
			b := e
			if s.active > 0 {
				b = e - s.wait
			}
			if best < 0 || b > busy || (b == busy && remaining[d] > remaining[best]) {
				best, end, hands, busy, conflicts = d, e, h, b, c
			}
		}
		if best < 0 {
			break
		}
		d, i := best, chains[best][next[best]]
		s := dishes[d][i]
		placed := placedStep{dish: d, step: i, mealStep: s, start: end - s.seconds(), end: end}
		out.steps = append(out.steps, placed)
		out.warnings = append(out.warnings, conflicts...)
		// Cooked food left waiting because the cook was busy elsewhere: the dish is ready early, or
		// what it waited for sits.
		if slide := latest[d] - hands; slide > standing && (s.wait > 0 || next[d] == len(chains[d])-1) {
			out.warnings = append(out.warnings, mealWarning{kind: "hands", at: hands, dishes: []int{d}, seconds: slide})
		}
		for _, p := range preheats[[2]int{d, i}] {
			heat := placedStep{dish: d, step: p, mealStep: dishes[d][p], start: placed.start - preheatSeconds, end: placed.start, preheating: true}
			out.warnings = append(out.warnings, kitchenConflicts(out.steps, d, heat.mealStep, heat.start, heat.end, kitchen)...)
			out.steps = append(out.steps, heat)
		}
		latest[d], remaining[d], next[d] = placed.start, remaining[d]-s.seconds(), next[d]-1
	}
	slices.SortStableFunc(out.steps, func(a, b placedStep) int {
		if a.start != b.start {
			return a.start - b.start
		}
		if a.end != b.end {
			return a.end - b.end
		}
		if a.dish != b.dish {
			return a.dish - b.dish
		}
		return a.step - b.step
	})
	for _, p := range out.steps {
		out.start = min(out.start, p.start)
	}
	out.free = freeTime(out.steps, out.start)
	out.warnings = mergeWarnings(out.warnings)
	return out
}

// placeStep finds when s, of dish, ends at the latest by latest: the latest end that keeps the
// cook's hands free for its hands-on part (hands), and the latest within kitchenSlack of that
// which also keeps the kitchen within what it has (end). When there's none, the step ends at
// hands and conflicts says what the kitchen can't do.
func placeStep(placed []placedStep, dish int, s mealStep, latest int, kitchen mealKitchen) (end, hands int, conflicts []mealWarning) {
	d := s.seconds()
	// The latest end is latest itself or one that ends this step's hands-on part where another
	// step's begins, or this step where another begins: as a step moves earlier, those are where
	// a clash ends.
	candidates := []int{latest}
	for _, p := range placed {
		if p.start < latest {
			candidates = append(candidates, p.start)
		}
		if e := p.start + d - s.active; s.active > 0 && p.active > 0 && e < latest {
			candidates = append(candidates, e)
		}
	}
	slices.Sort(candidates)
	slices.Reverse(candidates)
	candidates = slices.Compact(candidates)
	found := false
	for _, e := range candidates {
		if !handsFree(placed, s, e) {
			continue
		}
		if !found {
			hands, found = e, true
		}
		if e < hands-kitchenSlack {
			break
		}
		if len(kitchenConflicts(placed, dish, s, e-d, e, kitchen)) == 0 {
			return e, hands, nil
		}
	}
	if !found {
		// Before everything placed, the cook's hands are always free.
		hands = candidates[len(candidates)-1]
	}
	return hands, hands, kitchenConflicts(placed, dish, s, hands-d, hands, kitchen)
}

// handsFree reports whether s, ending at end, needs the cook's hands only while no other step
// does.
func handsFree(placed []placedStep, s mealStep, end int) bool {
	if s.active == 0 {
		return true
	}
	start := end - s.seconds()
	for _, p := range placed {
		if p.active > 0 && start < p.handsEnd() && p.start < start+s.active {
			return false
		}
	}
	return true
}

// kitchenConflicts is what the kitchen can't do if s, of dish, runs from start to end: more oven
// heats at once than it has ovens, or more burners than it has, at the first moment either
// happens.
func kitchenConflicts(placed []placedStep, dish int, s mealStep, start, end int, kitchen mealKitchen) []mealWarning {
	if end <= start || (s.oven == 0 && s.burners == 0) {
		return nil
	}
	// What runs at once can change only where a step starts.
	moments := []int{start}
	for _, p := range placed {
		if p.start > start && p.start < end {
			moments = append(moments, p.start)
		}
	}
	slices.Sort(moments)
	var out []mealWarning
	ovenWarned, burnersWarned := false, false
	for _, t := range moments {
		heats, dishes, burners, users := []int{s.oven}, []int{dish}, s.burners, []int{dish}
		for _, p := range placed {
			if p.start > t || p.end <= t || p.end <= p.start {
				continue
			}
			if p.oven > 0 && s.oven > 0 {
				heats, dishes = append(heats, p.oven), append(dishes, p.dish)
			}
			if p.burners > 0 && s.burners > 0 {
				burners, users = burners+p.burners, append(users, p.dish)
			}
		}
		if s.oven > 0 && !ovenWarned {
			if distinct := distinctHeats(heats); len(distinct) > kitchen.Ovens {
				out = append(out, mealWarning{kind: "oven", at: t, dishes: unique(dishes), heats: distinct})
				ovenWarned = true
			}
		}
		if s.burners > 0 && !burnersWarned && burners > kitchen.Burners {
			out = append(out, mealWarning{kind: "burners", at: t, dishes: unique(users), needed: burners, have: kitchen.Burners})
			burnersWarned = true
		}
	}
	return out
}

// distinctHeats is the oven heats a list holds, highest first, those within sameHeat of a
// higher one counting as it.
func distinctHeats(heats []int) []int {
	sorted := slices.Clone(heats)
	slices.Sort(sorted)
	slices.Reverse(sorted)
	var out []int
	for _, h := range sorted {
		if len(out) == 0 || out[len(out)-1]-h > sameHeat {
			out = append(out, h)
		}
	}
	return out
}

func unique(dishes []int) []int {
	out := slices.Clone(dishes)
	slices.Sort(out)
	return slices.Compact(out)
}

// freeTime is the stretches from start to the meal with nothing hands-on to do, of freeSeconds
// or more, in order.
func freeTime(steps []placedStep, start int) [][2]int {
	var busy [][2]int
	for _, p := range steps {
		if p.active > 0 {
			busy = append(busy, [2]int{p.start, p.handsEnd()})
		}
	}
	slices.SortFunc(busy, func(a, b [2]int) int { return a[0] - b[0] })
	var out [][2]int
	at := start
	for _, b := range append(busy, [2]int{0, 0}) {
		if b[0]-at >= freeSeconds {
			out = append(out, [2]int{at, b[0]})
		}
		at = max(at, b[1])
	}
	return out
}

// mergeWarnings keeps one warning of each kind for the same dishes, the earliest, in the order
// they come up.
func mergeWarnings(warnings []mealWarning) []mealWarning {
	seen := map[string]int{}
	var out []mealWarning
	for _, w := range warnings {
		key := w.kind
		for _, d := range w.dishes {
			key += "," + string(rune('0'+d))
		}
		if i, ok := seen[key]; ok {
			if w.at < out[i].at {
				out[i] = w
			}
			continue
		}
		seen[key] = len(out)
		out = append(out, w)
	}
	slices.SortStableFunc(out, func(a, b mealWarning) int { return a.at - b.at })
	return out
}

// roundMinutes rounds seconds to whole minutes, any time at all being at least one.
func roundMinutes(seconds int) int {
	if seconds <= 0 {
		return 0
	}
	return max(1, (seconds+30)/60) * 60
}

// mealStepOf is how the timeline takes a step with timing t: whole minutes, its cook-tested time
// (median, 0 for none) in place of the written one, more or less waiting for a waiting step.
func mealStepOf(t StepTiming, median int) (s mealStep, tested bool) {
	s = mealStep{active: t.Active, wait: t.Wait, oven: t.Oven, burners: t.Burners}
	if median > 0 && !s.preheat() {
		if s.wait > 0 && median > s.active {
			s.wait = median - s.active
		} else {
			s.active, s.wait = median, 0
		}
		tested = true
	}
	s.active, s.wait = roundMinutes(s.active), roundMinutes(s.wait)
	return s, tested
}

// mealDish is a recipe as the timeline reads it.
type mealDish struct {
	id, title, image, author string
	published                bool
	steps                    []Step
	timings                  []StepTiming
	medians                  []int
}

// loadMealDishes reads the recipes ids names, in that order, as viewer may cook them (published
// by a cook in good standing, or their own), with each step's timing and cook-tested median.
// Any other is 404.
func loadMealDishes(ctx context.Context, q engagementDB, ids []string, viewer string) ([]mealDish, error) {
	rows, e := q.Query(ctx, `SELECT r.id,r.title,r.image,r.author_id,r.published,r.steps,r.language,r.minutes,r.step_timing`+recipeFrom+
		`WHERE r.id=ANY($1) AND (r.published OR r.author_id=$2)`, ids, viewer)
	if e != nil {
		return nil, e
	}
	byID := map[string]*mealDish{}
	for rows.Next() {
		var d mealDish
		var language string
		var minutes int
		saved := map[string]timingEstimate{}
		if e = rows.Scan(&d.id, &d.title, &d.image, &d.author, &d.published, &d.steps, &language, &minutes, &saved); e != nil {
			rows.Close()
			return nil, e
		}
		d.timings = stepTimings(d.steps, language, minutes, saved)
		d.medians = make([]int, len(d.steps))
		byID[d.id] = &d
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	out := make([]mealDish, 0, len(ids))
	for _, id := range ids {
		d := byID[id]
		if d == nil {
			return nil, fiber.NewError(404, "Recipe not found.")
		}
		out = append(out, *d)
	}
	rows, e = q.Query(ctx, `SELECT recipe_id,step_key,median_seconds FROM recipe_step_stats WHERE recipe_id=ANY($1) AND sessions>=$2 AND median_seconds>0`, ids, stepStatsSessions)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var recipe, key string
		var median int
		if e = rows.Scan(&recipe, &key, &median); e != nil {
			return nil, e
		}
		for i := range out {
			if out[i].id != recipe {
				continue
			}
			for n, st := range out[i].steps {
				if cookStepKey(st.Text) == key {
					out[i].medians[n] = median
				}
			}
		}
	}
	return out, rows.Err()
}

func (a *App) mealRoutes(v fiber.Router) {
	v.Post("/meals/timeline", a.requireAuth, perUser(120, time.Hour), a.mealTimeline)
	v.Post("/meals/cook-sessions", a.requireAuth, perUser(30, time.Hour), a.startMeal)
}

// mealRecipes is the recipes of a meal request: 2 to 4 different ones.
func mealRecipes(ids []string) ([]string, error) {
	out := []string{}
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) < minMealDishes || len(out) > maxMealDishes || len(out) != len(ids) {
		return nil, fiber.NewError(400, "Choose 2 to 4 recipes to cook together.")
	}
	return out, nil
}

// eatingTime reads when the member wants to eat: an RFC 3339 time, or a local one
// ("2026-10-17T19:30") in their time zone, from 12 hours ago to 60 days ahead.
func eatingTime(at, zone string, now time.Time) (time.Time, error) {
	if zone == "" {
		zone = "UTC"
	}
	loc, e := time.LoadLocation(zone)
	if e != nil || zone == "Local" || len(zone) > 64 {
		return time.Time{}, fiber.NewError(400, "Choose a valid time zone.")
	}
	t, e := time.Parse(time.RFC3339, at)
	if e != nil {
		t, e = time.ParseInLocation("2006-01-02T15:04", at, loc)
	}
	if e != nil || t.Before(now.Add(-12*time.Hour)) || t.After(now.Add(60*24*time.Hour)) {
		return time.Time{}, fiber.NewError(400, "Choose when you'd like to eat.")
	}
	return t.In(loc).Truncate(time.Minute), nil
}

// The timeline as POST /meals/timeline answers it.
type (
	timelineReply struct {
		EatAt    time.Time         `json:"eatAt"`
		StartAt  time.Time         `json:"startAt"`
		Kitchen  mealKitchen       `json:"kitchen"`
		Dishes   []timelineDish    `json:"dishes"`
		Steps    []timelineStep    `json:"steps"`
		Free     []timelineSpan    `json:"free"`
		Warnings []timelineWarning `json:"warnings"`
	}
	timelineDish struct {
		RecipeID string    `json:"recipeId"`
		Title    string    `json:"title"`
		Image    string    `json:"image"`
		StartAt  time.Time `json:"startAt"`
		ReadyAt  time.Time `json:"readyAt"`
		// Some of its steps' times are estimates, or cook-tested.
		Estimated bool `json:"estimated"`
		Tested    bool `json:"tested"`
	}
	timelineStep struct {
		RecipeID  string    `json:"recipeId"`
		Step      int       `json:"step"`
		Title     string    `json:"title"`
		StartAt   time.Time `json:"startAt"`
		EndAt     time.Time `json:"endAt"`
		Active    int       `json:"active"`
		Wait      int       `json:"wait"`
		Oven      int       `json:"oven"`
		Burners   int       `json:"burners"`
		Preheat   bool      `json:"preheat"`
		Estimated bool      `json:"estimated"`
		Tested    bool      `json:"tested"`
	}
	timelineSpan struct {
		StartAt time.Time `json:"startAt"`
		EndAt   time.Time `json:"endAt"`
	}
	timelineWarning struct {
		Kind      string    `json:"kind"`
		At        time.Time `json:"at"`
		RecipeIDs []string  `json:"recipeIds"`
		Heats     []int     `json:"heats,omitempty"`
		Needed    int       `json:"needed,omitempty"`
		Have      int       `json:"have,omitempty"`
		Minutes   int       `json:"minutes,omitempty"`
	}
)

// timeline schedules dishes to be ready at eat, and answers it in eat's time zone.
func timeline(dishes []mealDish, eat time.Time, kitchen mealKitchen) timelineReply {
	steps := make([][]mealStep, len(dishes))
	tested := make([][]bool, len(dishes))
	for d, dish := range dishes {
		for i, t := range dish.timings {
			s, measured := mealStepOf(t, dish.medians[i])
			steps[d], tested[d] = append(steps[d], s), append(tested[d], measured)
		}
	}
	plan := scheduleMeal(steps, kitchen)
	at := func(seconds int) time.Time { return eat.Add(time.Duration(seconds) * time.Second) }
	reply := timelineReply{EatAt: eat, StartAt: at(plan.start), Kitchen: kitchen, Steps: []timelineStep{}, Free: []timelineSpan{}, Warnings: []timelineWarning{}}
	for _, dish := range dishes {
		reply.Dishes = append(reply.Dishes, timelineDish{RecipeID: dish.id, Title: dish.title, Image: dish.image, StartAt: eat, ReadyAt: eat})
	}
	for _, p := range plan.steps {
		dish := &reply.Dishes[p.dish]
		estimated := dishes[p.dish].timings[p.step].Estimated && !tested[p.dish][p.step]
		reply.Steps = append(reply.Steps, timelineStep{
			RecipeID: dish.RecipeID, Step: p.step + 1, Title: dishes[p.dish].steps[p.step].Title,
			StartAt: at(p.start), EndAt: at(p.end), Active: p.active, Wait: p.wait, Oven: p.oven, Burners: p.burners,
			Preheat: p.preheating || p.preheat(), Estimated: estimated, Tested: tested[p.dish][p.step],
		})
		if at(p.start).Before(dish.StartAt) {
			dish.StartAt = at(p.start)
		}
		dish.Estimated = dish.Estimated || estimated
		dish.Tested = dish.Tested || tested[p.dish][p.step]
	}
	// A dish is ready when its last step ends, which may be before the meal.
	for d := range dishes {
		last := len(dishes[d].steps) - 1
		for _, p := range plan.steps {
			if p.dish == d && p.step == last {
				reply.Dishes[d].ReadyAt = at(p.end)
			}
		}
	}
	for _, f := range plan.free {
		reply.Free = append(reply.Free, timelineSpan{StartAt: at(f[0]), EndAt: at(f[1])})
	}
	for _, w := range plan.warnings {
		out := timelineWarning{Kind: w.kind, At: at(w.at), RecipeIDs: []string{}, Heats: w.heats, Needed: w.needed, Have: w.have, Minutes: roundMinutes(w.seconds) / 60}
		for _, d := range w.dishes {
			out.RecipeIDs = append(out.RecipeIDs, dishes[d].id)
		}
		reply.Warnings = append(reply.Warnings, out)
	}
	return reply
}

// mealTimeline answers POST /meals/timeline: {"recipes", "eatAt", "timeZone", "kitchen"} with the
// plan to have them ready together at eatAt.
func (a *App) mealTimeline(c fiber.Ctx) error {
	var in struct {
		Recipes  []string     `json:"recipes"`
		EatAt    string       `json:"eatAt"`
		TimeZone string       `json:"timeZone"`
		Kitchen  *mealKitchen `json:"kitchen"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	ids, e := mealRecipes(in.Recipes)
	if e != nil {
		return e
	}
	eat, e := eatingTime(in.EatAt, in.TimeZone, time.Now())
	if e != nil {
		return e
	}
	kitchen := mealKitchen{Burners: defaultBurners, Ovens: defaultOvens}
	if in.Kitchen != nil {
		kitchen = *in.Kitchen
	}
	if kitchen.Burners < 1 || kitchen.Burners > maxBurners || kitchen.Ovens < 1 || kitchen.Ovens > maxOvens {
		return fiber.NewError(400, "Your kitchen can have 1–12 burners and 1–3 ovens.")
	}
	dishes, e := loadMealDishes(c.Context(), a.DB, ids, userID(c))
	if e != nil {
		return e
	}
	return c.JSON(timeline(dishes, eat, kitchen))
}

// startMeal answers POST /meals/cook-sessions: {"recipes"} starts a cook session for each dish
// of a meal cooked together, linked by the meal, as cooking mode does for one recipe. The
// member's own recipes get none, as they never count. It answers {"mealId", "sessions"}.
func (a *App) startMeal(c fiber.Ctx) error {
	var in struct {
		Recipes []string `json:"recipes"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	ids, e := mealRecipes(in.Recipes)
	if e != nil {
		return e
	}
	ctx, me, meal := c.Context(), userID(c), uuid.NewString()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	dishes, e := loadMealDishes(ctx, tx, ids, me)
	if e != nil {
		return e
	}
	sessions := []json.RawMessage{}
	for _, d := range dishes {
		if d.author == me || !d.published {
			continue
		}
		var b []byte
		e = tx.QueryRow(ctx, `WITH k AS (INSERT INTO cook_sessions(id,user_id,recipe_id,steps,meal_id)
 SELECT $1,$2,r.id,jsonb_array_length(r.steps),$4 FROM recipes r WHERE r.id=$3 RETURNING *)
SELECT `+cookSessionJSON+` FROM k`, uuid.NewString(), me, d.id, meal).Scan(&b)
		if errors.Is(e, pgx.ErrNoRows) {
			return fiber.NewError(404, "Recipe not found.")
		}
		if e != nil {
			return e
		}
		sessions = append(sessions, b)
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.Status(201).JSON(fiber.Map{"mealId": meal, "sessions": sessions})
}
