package app

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

// What a recipe needs besides its ingredients (032_recipe_equipment.sql): equipment, the pots,
// pans, appliances and tools its author lists, in their order and words; and equipmentDetected,
// what its method mentions, read with the equipment lexicon (equipment_lexicon.go) as English keys
// the app names in the reader's language. Many imported and older recipes have no list, and
// authors forget things, so the recipe page and cooking mode fall back on what the method
// mentions, and say so. Like the food index this reads words: it can miss a tool the method takes
// for granted, and the app never mixes what it found with what the author wrote.

const (
	// maxEquipment bounds a recipe's equipment list, and what detection reports.
	maxEquipment = 20
	// equipmentNameLength bounds one name on the list, in characters.
	equipmentNameLength = 60
	// equipmentVersion changes with the lexicon or the rules below; recipes read under another are
	// read again (indexEquipment).
	equipmentVersion = 3
)

// equipmentWords is folded text as the words an alias is matched against, English-style plurals
// folded as in ingredient names ("baking sheets" is a baking sheet).
func equipmentWords(folded string) []string {
	words := foodWords(folded)
	for i, w := range words {
		words[i] = singular(w)
	}
	return words
}

// equipmentPhrase is an alias as the lexicon keeps it.
func equipmentPhrase(alias string) string {
	return strings.Join(equipmentWords(foldFood(alias)), " ")
}

// equipmentLookup is the key a phrase names in a recipe written in language: an alias read only in
// that language first, then English ones for a recipe that doesn't say, then any.
func equipmentLookup(phrase, language string) (string, bool) {
	if key, ok := equipmentInLanguage[language][phrase]; ok {
		return key, true
	}
	if language == "" {
		if key, ok := equipmentInLanguage["en"][phrase]; ok {
			return key, true
		}
	}
	key, ok := equipmentAliases[phrase]
	return key, ok
}

// equipmentClause splits a method at the punctuation between sentences and phrases, so no alias
// is read across them ("…into the oven. Safe to say…").
var equipmentClause = regexp.MustCompile(`[.,;:!?()\[\]"“”„«»…。，、；：！？（）「」『』]+`)

// matchEquipment finds the equipment one text names, in order: at each word the longest alias,
// so a Dutch oven is never an oven and "oven-safe" no oven at all. German compounds are read by
// their head ("Gusseisenpfanne"), and runs of CJK script inside. Everyday tools read only on a
// cook's list are left out.
func matchEquipment(text, language string) []string { return matchEquipmentKeys(text, language, false) }

// nameEquipment is what one name on a cook's list names, for its icon: the first piece of
// equipment or everyday tool it names in the recipe's language, or else in English ("Large frying
// pan with a lid" is a frying pan, "Wooden spoon" a spoon); "" for none.
func nameEquipment(name, language string) string {
	for _, in := range []string{language, "en"} {
		if keys := matchEquipmentKeys(name, in, true); len(keys) > 0 {
			return keys[0]
		}
	}
	return ""
}

func matchEquipmentKeys(text, language string, lists bool) []string {
	var out []string
	add := func(key string) {
		if key != ignoredEquipment && (lists || !equipmentListOnly[key]) {
			out = append(out, key)
		}
	}
	for _, clause := range equipmentClause.Split(foldFood(text), -1) {
		words := equipmentWords(clause)
		for i := 0; i < len(words); {
			if r, _ := utf8.DecodeRuneInString(words[i]); cjk(r) {
				for _, key := range matchEquipmentCJK(words[i], language) {
					add(key)
				}
				i++
				continue
			}
			found := 0
			for n := min(equipmentLongest, len(words)-i); n > 0; n-- {
				if key, ok := equipmentLookup(strings.Join(words[i:i+n], " "), language); ok {
					add(key)
					found = n
					break
				}
			}
			if found == 0 && language == "de" {
				if key := germanEquipment(words[i]); key != "" {
					add(key)
				}
			}
			i += max(found, 1)
		}
	}
	return out
}

// germanEquipment reads a German compound that isn't an alias by its head, the longest alias it
// ends with ("Gusseisenpfanne": a frying pan, "Kontaktgrill": a grill), of at least four letters
// after at least three; "" when it has none.
func germanEquipment(w string) string {
	runes := []rune(w)
	for n := 3; n <= len(runes)-4; n++ {
		if key, ok := equipmentLookup(string(runes[n:]), "de"); ok {
			return key
		}
	}
	return ""
}

func matchEquipmentCJK(run, language string) []string {
	runes := []rune(run)
	var out []string
	for i := 0; i < len(runes); {
		found := 0
		for n := min(equipmentCJKLongest, len(runes)-i); n > 0; n-- {
			if key, ok := equipmentLookup(string(runes[i:i+n]), language); ok {
				out = append(out, key)
				found = n
				break
			}
		}
		i += max(found, 1)
	}
	return out
}

// detectEquipment is the equipment a method mentions, in its step titles and text, in the order it
// first does, at most maxEquipment of it.
func detectEquipment(steps []Step, language string) []string {
	found := []string{}
	seen := map[string]bool{}
	for _, st := range steps {
		for _, text := range []string{st.Title, st.Text} {
			for _, key := range matchEquipment(text, language) {
				if !seen[key] && len(found) < maxEquipment {
					seen[key] = true
					found = append(found, key)
				}
			}
		}
	}
	return found
}

// fitEquipment is an imported list as a recipe may hold it: names of up to equipmentNameLength
// characters, at most maxEquipment of them, without blanks or repeats. A page or a model may list
// more, or longer, than the editor allows; they're dropped rather than failing the import. nil
// stays nil, so a draft that named none keeps what is saved.
func fitEquipment(names []string) []string {
	if names == nil {
		return nil
	}
	out := []string{}
	for _, name := range cleanTags(names) {
		if utf8.RuneCountInString(name) <= equipmentNameLength && len(out) < maxEquipment {
			out = append(out, name)
		}
	}
	return out
}

func (a *App) equipmentRoutes(v fiber.Router) {
	v.Post("/recipes/equipment", a.requireAuth, a.methodEquipment)
}

// methodEquipment answers what a method mentions before it is saved, for the editor's "Add what
// the method mentions": {"steps":[{"title","text"}],"language"} answers {"equipment":[…]}, keys as
// equipmentDetected has them. Nothing is saved, and no AI is asked.
func (a *App) methodEquipment(c fiber.Ctx) error {
	var in struct {
		Steps    []struct{ Title, Text string } `json:"steps"`
		Language string                         `json:"language"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if len(in.Steps) > 40 {
		return fiber.NewError(400, "Add 1–80 ingredients and 1–40 steps.")
	}
	language, ok := recipeLanguage(in.Language)
	if !ok {
		return fiber.NewError(400, "Choose a supported recipe language.")
	}
	steps := make([]Step, len(in.Steps))
	for i, st := range in.Steps {
		steps[i] = Step{Title: clip(st.Title, 120), Text: clip(st.Text, 3000)}
	}
	return c.JSON(fiber.Map{"equipment": detectEquipment(steps, language)})
}

// indexRecipeEquipment reads what one recipe's method mentions, and what each name on its cook's
// list names (for its icon), from what is saved. A recipe changed in the meantime is left for the
// next write or pass, which reads the newer steps.
func indexRecipeEquipment(ctx context.Context, db recipeWriter, id string) error {
	var steps []Step
	var own []string
	var language, source string
	e := db.QueryRow(ctx, `SELECT steps,equipment,language,equipment_source FROM recipes WHERE id=$1`, id).Scan(&steps, &own, &language, &source)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	kinds := make([]string, len(own))
	for i, name := range own {
		kinds[i] = nameEquipment(name, language)
	}
	_, e = db.Exec(ctx, `UPDATE recipes SET equipment_detected=$2,equipment_kinds=$3,equipment_version=$4,equipment_indexed=$5 WHERE id=$1 AND equipment_source=$5 AND equipment=$6`,
		id, detectEquipment(steps, language), kinds, equipmentVersion, source, own)
	return e
}

// indexEquipment brings recipes up to the lexicon: those read under another equipmentVersion,
// never read, or changed by a write that didn't read them (the seed, another server version).
// Each recipe is its own statement, so a pass never holds a long transaction.
func indexEquipment(ctx context.Context, db *pgxpool.Pool) (indexed int, err error) {
	for _, query := range []string{
		`SELECT id FROM recipes WHERE equipment_indexed<>equipment_source ORDER BY id LIMIT $1`,
		`SELECT id FROM recipes WHERE equipment_version<>` + strconv.Itoa(equipmentVersion) + ` ORDER BY id LIMIT $1`,
	} {
		// A recipe that changes under every pass stops after a few rounds rather than looping; the
		// next pass takes it.
		for round := 0; round < 1000; round++ {
			ids, e := collectIDs(ctx, db, query, indexBatch)
			if e != nil {
				return indexed, e
			}
			for _, id := range ids {
				if e = indexRecipeEquipment(ctx, db, id); e != nil {
					return indexed, e
				}
			}
			indexed += len(ids)
			if len(ids) < indexBatch {
				break
			}
		}
	}
	return indexed, nil
}

// RunEquipmentIndex reads what needs it at start-up, then every ten minutes, for any write that
// didn't, and has the model guess what recipes without a list use, within the day's cap
// (equipment_guess.go). Replicas may overlap; reading is idempotent, and the model is asked under
// a lock.
func RunEquipmentIndex(ctx context.Context, db *pgxpool.Pool) {
	a := &App{DB: db, AI: ai.New(), Context: ctx}
	for {
		if n, e := indexEquipment(ctx, db); e != nil && ctx.Err() == nil {
			slog.Error("equipment index", "error", e)
		} else if n > 0 {
			slog.Info("equipment index", "indexed", n)
		}
		if a.AI.TextEnabled() {
			if n, e := a.guessEquipment(ctx); e != nil && ctx.Err() == nil {
				slog.Warn("equipment guesses", "error", e)
			} else if n > 0 {
				slog.Info("equipment guesses", "recipes", n)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Minute):
		}
	}
}

// equipmentShopURL is where the app's equipment cards look a piece up to buy it
// (EQUIPMENT_SHOP_URL): a store's search address with {query} where its name goes, such as an
// affiliate link that pays a commission, or "" without one, or for anything but https.
func equipmentShopURL() string {
	shop := strings.TrimSpace(os.Getenv("EQUIPMENT_SHOP_URL"))
	if !strings.HasPrefix(shop, "https://") || !strings.Contains(shop, "{query}") {
		return ""
	}
	return shop
}
