package app

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"savorly/api/internal/ai"
)

// What a recipe without its own equipment list likely uses, and at which steps
// (043_equipment_guess.sql). The lexicon reads only what a method names (equipment.go), and
// methods take most of it for granted: pasta cooked in boiling water needs a pot, "blend until
// smooth" a blender. So the cheap model guesses, once per version of a published recipe, the most
// saved first, at most equipmentGuessRecipes a day, naming only the lexicon's keys so the app
// names them in every language, and how big the pots, pans and dishes should be for its amounts.
// What the method names is added at the steps that name it. Recipes guessed under an older
// equipmentGuessVersion (045_equipment_sizes.sql) are asked again after the rest, keeping their
// guess until then. Every
// later cook shares a guess, so like a translation it counts against the shared free budget
// (reserveShared), as ai_usage kind equipment_guess. Without an OpenRouter key, or once the day's
// cap or budget is spent, recipes show what their method names, as before.

// equipmentUse is one piece of a guess: its key, the 1-based steps that use it, in order, and its
// size when the recipe needs one.
type equipmentUse struct {
	Key   string            `json:"key"`
	Steps []int             `json:"steps"`
	Size  *ai.EquipmentSize `json:"size,omitempty"`
}

// equipmentGuessVersion changes with what a guess holds; 1 added sizes.
const equipmentGuessVersion = 1

// equipmentGuessSQL is recipe r's guess as readers get it: only while the recipe has no list of
// its own and the guess is about its current steps; [] otherwise.
const equipmentGuessSQL = `CASE WHEN r.equipment='{}' AND r.equipment_asked=r.equipment_source THEN r.equipment_guess ELSE '[]' END`

// equipmentGuessLine is a guess for a model reading the recipe: "pot (at least 5 l; steps 2, 3);
// blender (step 1)".
func equipmentGuessLine(guess []equipmentUse) string {
	parts := make([]string, len(guess))
	for i, u := range guess {
		steps := make([]string, len(u.Steps))
		for j, n := range u.Steps {
			steps[j] = strconv.Itoa(n)
		}
		label := "steps "
		if len(steps) == 1 {
			label = "step "
		}
		size := ""
		switch s := u.Size; {
		case s == nil:
		case s.Liters > 0:
			size = "at least " + strconv.FormatFloat(s.Liters, 'f', -1, 64) + " l; "
		case s.LengthCm > 0:
			size = strconv.FormatFloat(s.Cm, 'f', -1, 64) + " × " + strconv.FormatFloat(s.LengthCm, 'f', -1, 64) + " cm; "
		case s.Cm > 0:
			size = strconv.FormatFloat(s.Cm, 'f', -1, 64) + " cm across; "
		}
		parts[i] = u.Key + " (" + size + label + strings.Join(steps, ", ") + ")"
	}
	return strings.Join(parts, "; ")
}

// equipmentGuessRecipes is how many recipes the model may guess about in a day at most
// (EQUIPMENT_GUESS_RECIPES): a cap on what guesses can cost.
func equipmentGuessRecipes() int {
	if n, e := strconv.Atoi(os.Getenv("EQUIPMENT_GUESS_RECIPES")); e == nil && n >= 0 {
		return n
	}
	return 200
}

// mergeEquipmentGuess is the model's guess with what each step names added at that step, in the
// order the method first uses each piece, at most maxEquipment of them.
func mergeEquipmentGuess(steps []Step, language string, model []ai.EquipmentGuess) []equipmentUse {
	out := []equipmentUse{}
	use := func(key string, step int, size *ai.EquipmentSize) {
		i := slices.IndexFunc(out, func(u equipmentUse) bool { return u.Key == key })
		if i < 0 {
			out = append(out, equipmentUse{Key: key, Size: size})
			i = len(out) - 1
		}
		if !slices.Contains(out[i].Steps, step) {
			out[i].Steps = append(out[i].Steps, step)
		}
	}
	for _, g := range model {
		for _, n := range g.Steps {
			use(g.Key, n, g.Size)
		}
	}
	for i, st := range steps {
		for _, key := range append(matchEquipment(st.Title, language), matchEquipment(st.Text, language)...) {
			use(key, i+1, nil)
		}
	}
	for i := range out {
		slices.Sort(out[i].Steps)
	}
	slices.SortStableFunc(out, func(a, b equipmentUse) int { return a.Steps[0] - b.Steps[0] })
	return out[:min(len(out), maxEquipment)]
}

// guessEquipment has the model guess about published recipes without a list that it hasn't been
// asked about at their current steps, and then those guessed under an older
// equipmentGuessVersion, within what's left of the day's cap, under a lock so replicas don't ask
// twice. It stops when the shared budget says no, and reports how many recipes it asked about.
func (a *App) guessEquipment(ctx context.Context) (int, error) {
	conn, e := a.DB.Acquire(ctx)
	if e != nil {
		return 0, e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(7182351)`).Scan(&locked); e != nil || !locked {
		return 0, e
	}
	defer func() {
		if _, e := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(7182351)`); e != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	var used int
	if e = conn.QueryRow(ctx, `SELECT count(*) FROM ai_usage WHERE kind='equipment_guess' AND created_at>now()-interval '24 hours'`).Scan(&used); e != nil {
		return 0, e
	}
	left := equipmentGuessRecipes() - used
	if left <= 0 {
		return 0, nil
	}
	ids, e := collectIDs(ctx, conn, `SELECT r.id FROM recipes r JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL
 WHERE r.published AND r.equipment='{}' AND (r.equipment_asked<>r.equipment_source OR r.equipment_guess_version<$2)
 ORDER BY r.equipment_asked<>r.equipment_source DESC,(SELECT count(*) FROM saves s WHERE s.recipe_id=r.id) DESC,r.id LIMIT $1`, left, equipmentGuessVersion)
	if e != nil {
		return 0, e
	}
	asked := 0
	for _, id := range ids {
		if ctx.Err() != nil {
			return asked, ctx.Err()
		}
		sent, e := a.guessRecipeEquipment(ctx, id)
		if sent {
			asked++
		}
		var budget *fiber.Error
		if errors.As(e, &budget) {
			// The day's budget is spent, or AI is paused: the rest wait for another pass.
			return asked, nil
		}
		if e != nil {
			slog.Warn("guess a recipe's equipment", "recipe", id, "error", e)
		}
	}
	return asked, nil
}

// guessRecipeEquipment asks the model about one recipe and keeps its guess. A recipe changed
// meanwhile keeps nothing, and is asked about again; one that got a list of its own needs no
// guess. It reports whether the model was asked (and so paid for).
func (a *App) guessRecipeEquipment(ctx context.Context, id string) (bool, error) {
	var title, language, source string
	var servings int
	var ingredients []Ingredient
	var steps []Step
	var own []string
	e := a.DB.QueryRow(ctx, `SELECT title,language,servings,ingredients,steps,equipment,equipment_source FROM recipes WHERE id=$1`, id).Scan(&title, &language, &servings, &ingredients, &steps, &own, &source)
	if e != nil {
		return false, e
	}
	keep := func(guess []equipmentUse) error {
		_, e := a.DB.Exec(ctx, `UPDATE recipes SET equipment_guess=$2,equipment_asked=$3,equipment_guess_version=$4 WHERE id=$1 AND equipment_source=$3`, id, jsonBytes(guess), source, equipmentGuessVersion)
		return e
	}
	if len(own) > 0 || len(steps) == 0 {
		return false, keep([]equipmentUse{})
	}
	// Sizes go by the amounts. A guess is about the steps (equipment_source), so one sized for
	// amounts changed since stays until the steps change too.
	request := ai.EquipmentRecipe{Title: title, Servings: servings, Keys: equipmentKeys}
	for _, in := range ingredients[:min(len(ingredients), 40)] {
		line := strings.TrimSpace(in.Name)
		if in.Amount > 0 {
			line = strings.TrimSpace(strconv.FormatFloat(in.Amount, 'f', -1, 64) + " " + in.Unit + " " + line)
		}
		request.Ingredients = append(request.Ingredients, clip(line, 120))
	}
	for i, st := range steps {
		request.Steps = append(request.Steps, ai.EquipmentStep{Step: i + 1, Text: stepText(st, 600)})
	}
	usage, e := a.reserveEquipmentGuess(ctx, request.Estimate())
	if e != nil {
		return false, e
	}
	call, cancel := context.WithTimeout(ctx, 60*time.Second)
	guess, cost, e := a.AI.GuessEquipment(call, request)
	cancel()
	var spent error
	if errors.Is(e, ai.ErrNotSent) {
		spent = releaseUsage(context.Background(), a.DB, usage)
	} else {
		spent = settleUsage(context.Background(), a.DB, usage, cost)
	}
	if spent != nil {
		slog.Warn("settle equipment guess", "error", spent)
	}
	if errors.Is(e, ai.ErrNotSent) {
		return false, e
	}
	if e != nil {
		// Paid for, so this version isn't sent again; the recipe shows what its method names.
		return true, errors.Join(e, keep([]equipmentUse{}))
	}
	return true, keep(mergeEquipmentGuess(steps, language, guess))
}

// reserveEquipmentGuess commits a guess's reservation against the shared budget, like a
// translation's: no member pays for it.
func (a *App) reserveEquipmentGuess(ctx context.Context, estimate float64) (int64, error) {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback(context.Background())
	if e = reserveShared(ctx, tx, estimate); e != nil {
		return 0, e
	}
	usage, e := recordUsage(ctx, tx, "", "equipment_guess", estimate)
	if e == nil {
		e = tx.Commit(ctx)
	}
	return usage, e
}
