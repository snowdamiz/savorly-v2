package app

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Ingredient knowledge: what an ingredient line is (its key, which pantry matching and the
// grocery list use), what it is a kind of, what it is made from, and the allergen and diet
// groups it belongs to. The lexicon (food_lexicon.go) knows common ingredients in the app's nine
// languages; a name it doesn't know still matches by its own words. None of this is a safety
// guarantee, and the app says so wherever it shows a warning: names can't tell what a packet
// holds, and nothing here knows about cross-contact.

// foodVersion changes with the lexicon or the rules below. Recipes, pantry items and members'
// avoid lists indexed under another version are indexed again (indexFoods).
const foodVersion = 1

// foodGroups are the allergen and diet groups, by the ids the API and the app use: the EU's
// fourteen allergens (which include the US's nine), and what common diets leave out.
var foodGroups = []string{
	"milk", "egg", "fish", "shellfish", "mollusc", "treenut", "peanut", "gluten", "soy", "sesame",
	"celery", "mustard", "lupin", "sulphite",
	"meat", "pork", "poultry", "alcohol", "gelatin", "honey",
}

// dietGroups is what each diet the app offers (src/lib/profile.ts) leaves out. A diet that
// isn't about ingredients (high protein) leaves out nothing. Halal is only what an ingredient
// name can show: pork and alcohol, never how meat was slaughtered.
var dietGroups = map[string][]string{
	"vegetarian":  {"meat", "pork", "poultry", "fish", "shellfish", "mollusc", "gelatin"},
	"vegan":       {"meat", "pork", "poultry", "fish", "shellfish", "mollusc", "gelatin", "milk", "egg", "honey"},
	"pescatarian": {"meat", "pork", "poultry", "gelatin"},
	"gluten free": {"gluten"},
	"dairy free":  {"milk"},
	"nut free":    {"treenut", "peanut"},
	"halal":       {"pork", "alcohol"},
}

// animalGroups are what a "vegan" or "plant-based" product doesn't have, whatever it imitates.
var animalGroups = []string{"milk", "egg", "honey", "meat", "pork", "poultry", "fish", "shellfish", "mollusc", "gelatin"}

// staples are taken to be in every kitchen: pantry matching neither asks for them nor counts
// them, and shopping a recipe from the pantry leaves them off the list.
var staples = map[string]bool{"water": true, "salt": true, "pepper": true, "ice": true, "vegetable oil": true}

type foodEntry struct {
	key string
	// parents are what it is a kind of: a pantry's cheddar covers a recipe's cheese.
	parents []string
	// contains is what it's made from: soy sauce has soy and wheat. It counts for avoiding only,
	// since a pantry's soy sauce isn't a recipe's soy.
	contains []string
	// groups are its own groups; load adds those of everything above it and in it.
	groups []string
	// covers is the key and its ancestors (pantry matching); avoid adds what it's made from.
	covers, avoid []string
}

var (
	foodEntries  = map[string]*foodEntry{}
	foodAliases  = map[string]string{}   // normalized alias → key
	avoidAliases = map[string][]string{} // normalized allergy word → groups
	foodLongest  int                     // the most words in an alias
	cjkLongest   int                     // the most runes in an alias written without spaces
)

// Words that describe an ingredient's state or the amount rather than what it is. They are
// dropped before matching, from names and aliases alike.
var foodFiller = wordSet(`
fresh freshly chopped finely roughly coarsely diced sliced thinly thickly grated shredded large small medium big
extra virgin ripe raw peeled seeded deseeded pitted halved quartered softened melted cold warm room temperature frozen thawed dried dry canned tinned
organic unsalted plain whole boneless skinless lean optional divided packed heaping heaped level taste serving serve garnish good quality homemade
store bought sifted toasted beaten lightly cubed julienned trimmed rinsed drained washed cut into piece pieces about approximately approx plus more
needed for to the a an of some few very well firmly loosely at in with and or
de du des la le les l d au aux a et ou en pour environ facultatif emince emincee coupe coupee rape rapee gros grosse
petit petite petits petites moyen moyenne mur mure pele pelee fondu fondue ramolli
frisch gehackt gehackte fein grob gerieben geriebener gewurfelt geschnitten klein kleine grosse grosser mittel mittelgrosse reif getrocknet gemahlen
gemahlener geschalt weich geschmolzen zimmerwarm kalt kaltes tiefgekuhlt etwas ca etwa und oder von der die das ein eine einer zum servieren nach
geschmack prise
fresco fresca frescos frescas finamente cubos rodajas grande grandes pequeno pequena pequenos pequenas
mediano mediana maduro madura pelado pelada derretido derretida blando frio fria tibio congelado y o al el los las un una unos unas
para gusto cucharada
fresche freschi tritato tritata grattugiato grattugiata cubetti fette piccolo piccola piccoli medio media maturo matura pelati pelato 
 sciolto morbido freddo tiepido surgelato di del della dei delle e per servire facoltativo qb q b
 em fatias pequenos descascado derretida mole morno do da dos das ou opcional
свежий свежая свежее свежие мелко крупно нарезанный нарезанная нарезанные рубленый тертый тертая натертый большой большая большие маленький
маленькая средний средняя спелый спелые очищенный очищенные сушеный сушеные молотый молотая растопленное мягкое холодная холодный теплая теплый
замороженный по вкусу для подачи и или из с г гр шт ст ч л кг мл
适量 少许 少々 適量 大さじ 小さじ 个 克 片 根 勺
allergy allergic allergies intolerance intolerant allergie allergique allergies intolerant intolerante unvertraglichkeit allergisch alergia alergico
alergica intolerancia allergia allergico intolleranza intolleranze intolerancia alergico аллергия аллергии непереносимость 过敏 アレルギー
`)

// Words that cancel the next one ("sans gluten", "without eggs"), and words that do after the
// one they follow ("gluten-free"): both are dropped, and so are the groups the cancelled word
// names. German writes "glutenfrei" as one word.
var (
	foodWithout = wordSet(`without no non sans ohne sin senza sem без`)
	foodFree    = wordSet(`free`)
	foodVegan   = wordSet(`vegan vegane veganer veganes veganen vegano vegana veganos veganas веганский веганская веганское веганские ビーガン ヴィーガン 纯素`)
)

// Units, dropped from a name only right after a number ("2 cloves garlic"), since a clove
// alone is a spice.
var foodUnits = wordSet(`g gr gram grams kg ml l cl dl cup cups c tbsp tbs tablespoon tablespoons tsp teaspoon teaspoons oz ounce ounces lb lbs pound pounds
clove cloves slice slices pinch pinches handful handfuls sprig sprigs can cans tin tins piece pieces bunch bunches stick sticks pkg package
cuillere cuilleres cs cc tasse tasses el tl stuck becher prise cucharada cucharadas cucharadita cucharaditas taza tazas cucchiaio cucchiai
cucchiaino cucchiaini tazza colher colheres xicara xicaras стакан стакана ложка ложки ст ч зубчик зубчика зубчиков`)

func wordSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(s) {
		out[foldFood(w)] = true
	}
	return out
}

// foldFood lowercases and drops accents from Latin and Cyrillic letters ("crème" → "creme",
// "ё" → "е"), leaving kana and other scripts as they are: their marks change the word.
func foldFood(s string) string {
	s = strings.ToLower(norm.NFD.String(s))
	var b strings.Builder
	var prev rune
	for _, r := range s {
		if unicode.Is(unicode.Mn, r) && (unicode.Is(unicode.Latin, prev) || unicode.Is(unicode.Cyrillic, prev)) {
			continue
		}
		switch r {
		case 'ß':
			b.WriteString("ss")
		case 'œ':
			b.WriteString("oe")
		case 'æ':
			b.WriteString("ae")
		default:
			b.WriteRune(r)
		}
		prev = r
	}
	return norm.NFC.String(b.String())
}

// cjk is a script written without spaces between words, where aliases are found inside a run.
func cjk(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || r == 'ー'
}

// foodWords splits folded text into words: letters and digits for spaced scripts, and each run
// of CJK script as one word.
func foodWords(s string) []string {
	var words []string
	var cur strings.Builder
	curCJK := false
	flush := func() {
		if cur.Len() > 0 {
			words = append(words, cur.String())
			cur.Reset()
		}
	}
	for _, r := range s {
		switch {
		case cjk(r):
			if !curCJK {
				flush()
			}
			curCJK = true
			cur.WriteRune(r)
		case unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r):
			if curCJK {
				flush()
			}
			curCJK = false
			cur.WriteRune(r)
		default:
			flush()
			curCJK = false
		}
	}
	flush()
	return words
}

func isNumber(w string) bool {
	for _, r := range w {
		if !unicode.IsDigit(r) && !strings.ContainsRune("½¼¾⅓⅔⅛", r) {
			return false
		}
	}
	return w != ""
}

// singular takes an English-style plural off a word of Latin letters: berries → berry,
// tomatoes → tomato, peaches → peach, eggs → egg. Names and aliases go through it alike, so a
// French or Spanish plural ("tomates") folds the same way on both sides.
func singular(w string) string {
	if len(w) <= 3 || !isASCIIWord(w) {
		return w
	}
	switch {
	case strings.HasSuffix(w, "ies") && len(w) > 4:
		return w[:len(w)-3] + "y"
	case strings.HasSuffix(w, "oes"):
		return w[:len(w)-2]
	case strings.HasSuffix(w, "ches"), strings.HasSuffix(w, "shes"), strings.HasSuffix(w, "xes"):
		return w[:len(w)-2]
	case strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") && !strings.HasSuffix(w, "us") && !strings.HasSuffix(w, "is"):
		return w[:len(w)-1]
	}
	return w
}

func isASCIIWord(w string) bool {
	for i := 0; i < len(w); i++ {
		if c := w[i]; c < 'a' || c > 'z' {
			return false
		}
	}
	return true
}

// foodClean is a name as words to match: the part before any comma or note, without amounts,
// state words, or what "free"/"without" cancels, with plurals folded. suppressed holds the
// groups the cancelled words named, and vegan whether the line said it is a plant-based copy.
type foodClean struct {
	words      []string
	suppressed []string
	vegan      bool
}

func cleanFoodName(name string) foodClean {
	s := foldFood(name)
	// Notes in brackets, and what follows a comma, a dash or a semicolon, describe preparation.
	for _, pair := range [][2]string{{"(", ")"}, {"[", "]"}, {"（", "）"}} {
		for {
			i := strings.Index(s, pair[0])
			if i < 0 {
				break
			}
			j := strings.Index(s[i:], pair[1])
			if j < 0 {
				s = s[:i]
				break
			}
			s = s[:i] + " " + s[i+j+len(pair[1]):]
		}
	}
	for _, sep := range []string{",", ";", " - ", " – ", " — ", "、", "，"} {
		if i := strings.Index(s, sep); i > 0 {
			s = s[:i]
		}
	}
	raw := foodWords(s)
	var out foodClean
	for i := 0; i < len(raw); i++ {
		w := raw[i]
		switch {
		case isNumber(w):
			if i+1 < len(raw) && foodUnits[raw[i+1]] {
				i++
			}
			continue
		case foodWithout[w] && i+1 < len(raw):
			out.suppressed = append(out.suppressed, avoidGroupsOf(raw[i+1])...)
			i++
			continue
		case i+1 < len(raw) && foodFree[raw[i+1]]:
			out.suppressed = append(out.suppressed, avoidGroupsOf(w)...)
			i++
			continue
		case germanFree(w) != "":
			out.suppressed = append(out.suppressed, avoidGroupsOf(germanFree(w))...)
			continue
		case foodVegan[w]:
			out.vegan = true
			continue
		case w == "plant" && i+1 < len(raw) && raw[i+1] == "based":
			out.vegan = true
			i++
			continue
		case foodFiller[w]:
			continue
		}
		out.words = append(out.words, singular(w))
	}
	return out
}

// germanFree is what a German "-frei" word goes without ("glutenfreie" → "gluten"), or "".
func germanFree(w string) string {
	for _, suffix := range []string{"freien", "freier", "freies", "freie", "frei"} {
		if strings.HasSuffix(w, suffix) && len(w) > len(suffix)+2 {
			return strings.TrimSuffix(w, suffix)
		}
	}
	return ""
}

// avoidGroupsOf is the groups an allergy word names ("gluten", "lactose"), or else those of the
// ingredient it is ("eggs").
func avoidGroupsOf(w string) []string {
	w = singular(w)
	if g, ok := avoidAliases[w]; ok {
		return g
	}
	if key, ok := foodAliases[w]; ok {
		return foodEntries[key].groups
	}
	return nil
}

// foodMatch is an alias found in a name: its entry, and where it ends (in words), so the last
// one found is the name's head.
type foodMatch struct {
	entry *foodEntry
}

// matchFood finds the lexicon's aliases in the words, longest first from the left, so "peanut
// butter" is one match and never butter. In German, a compound word that isn't an alias ends
// with its head ("Vollmilch"), which is matched instead. CJK runs are searched inside.
func matchFood(words []string, language string) []foodMatch {
	var out []foodMatch
	for i := 0; i < len(words); {
		if r, _ := utf8.DecodeRuneInString(words[i]); cjk(r) {
			out = append(out, matchCJK(words[i])...)
			i++
			continue
		}
		found := 0
		for n := min(foodLongest, len(words)-i); n > 0; n-- {
			if key, ok := foodAliases[strings.Join(words[i:i+n], " ")]; ok {
				out = append(out, foodMatch{foodEntries[key]})
				found = n
				break
			}
		}
		if found == 0 && language == "de" {
			out = append(out, germanCompound(words[i])...)
		}
		i += max(found, 1)
	}
	return out
}

// germanCompound reads a German compound that isn't an alias by its parts: what it begins with
// ("Mandelblättchen": almonds) and its head, the longest alias it ends with ("Eierlikör":
// liqueur), which comes last so it is the name's key. Parts are at least four letters, after
// at least three.
func germanCompound(w string) []foodMatch {
	var out []foodMatch
	runes := []rune(w)
	for n := len(runes) - 3; n >= 4; n-- {
		if key, ok := foodAliases[string(runes[:n])]; ok {
			out = append(out, foodMatch{foodEntries[key]})
			break
		}
	}
	for n := 3; n <= len(runes)-4; n++ {
		if key, ok := foodAliases[string(runes[n:])]; ok {
			if len(out) == 0 || out[0].entry.key != key {
				out = append(out, foodMatch{foodEntries[key]})
			}
			break
		}
	}
	return out
}

func matchCJK(run string) []foodMatch {
	runes := []rune(run)
	var out []foodMatch
	for i := 0; i < len(runes); {
		found := 0
		for n := min(cjkLongest, len(runes)-i); n > 0; n-- {
			if key, ok := foodAliases[string(runes[i:i+n])]; ok {
				out = append(out, foodMatch{foodEntries[key]})
				found = n
				break
			}
		}
		i += max(found, 1)
	}
	return out
}

// ingredientFacts is what the index knows about one ingredient line.
type ingredientFacts struct {
	// Key names what it is: a lexicon key ("chicken stock"), or its own cleaned words.
	Key string `json:"key"`
	// Allergens are its allergen and diet groups.
	Allergens []string `json:"allergens"`
	// Terms are what an avoid list is matched against: the key, everything it is a kind of or
	// made from, and its words alone and in runs of up to three.
	Terms []string `json:"terms"`
}

// indexIngredient reads one ingredient line written in language ("" when unknown).
func indexIngredient(name, language string) ingredientFacts {
	clean := cleanFoodName(name)
	facts := ingredientFacts{Allergens: []string{}, Terms: []string{}}
	matches := matchFood(clean.words, language)
	groups := map[string]bool{}
	terms := map[string]bool{}
	for _, m := range matches {
		for _, g := range m.entry.groups {
			groups[g] = true
		}
		for _, k := range m.entry.avoid {
			terms[k] = true
		}
	}
	if len(matches) > 0 {
		facts.Key = matches[len(matches)-1].entry.key
	} else {
		facts.Key = strings.Join(clean.words, " ")
	}
	for _, g := range clean.suppressed {
		delete(groups, g)
	}
	if clean.vegan {
		for _, g := range animalGroups {
			delete(groups, g)
		}
	}
	for i := range clean.words {
		for n := 1; n <= 3 && i+n <= len(clean.words); n++ {
			terms[strings.Join(clean.words[i:i+n], " ")] = true
		}
	}
	if facts.Key != "" {
		terms[facts.Key] = true
	}
	for _, g := range foodGroups {
		if groups[g] {
			facts.Allergens = append(facts.Allergens, g)
		}
	}
	for t := range terms {
		facts.Terms = append(facts.Terms, t)
	}
	slices.Sort(facts.Terms)
	return facts
}

// recipeFood is a recipe's index: each ingredient's facts in order, and what the whole recipe
// has, for search filters and pantry matching.
type recipeFood struct {
	Ingredients []ingredientFacts
	Keys        []string // each ingredient's key, in order
	Allergens   []string
	Terms       []string
}

func indexRecipe(ingredients []Ingredient, language string) recipeFood {
	out := recipeFood{Ingredients: make([]ingredientFacts, 0, len(ingredients)), Keys: make([]string, 0, len(ingredients)), Allergens: []string{}, Terms: []string{}}
	groups, terms := map[string]bool{}, map[string]bool{}
	for _, in := range ingredients {
		f := indexIngredient(in.Name, language)
		out.Ingredients = append(out.Ingredients, f)
		out.Keys = append(out.Keys, f.Key)
		for _, g := range f.Allergens {
			groups[g] = true
		}
		for _, t := range f.Terms {
			terms[t] = true
		}
	}
	for _, g := range foodGroups {
		if groups[g] {
			out.Allergens = append(out.Allergens, g)
		}
	}
	for t := range terms {
		out.Terms = append(out.Terms, t)
	}
	slices.Sort(out.Terms)
	return out
}

// pantryCovers is what a pantry item lets a recipe skip: its key and everything it is a kind
// of, so cheddar covers cheese but cheese doesn't cover cheddar.
func pantryCovers(name, language string) []string {
	clean := cleanFoodName(name)
	matches := matchFood(clean.words, language)
	if len(matches) == 0 {
		if k := strings.Join(clean.words, " "); k != "" {
			return []string{k}
		}
		return []string{}
	}
	return slices.Clone(matches[len(matches)-1].entry.covers)
}

// avoidance is what a member leaves out, from their diets and allergies, with what they wrote
// for each so the app can say why: {"groups":{"peanut":["Peanuts"]},"terms":{"cilantro":["cilantro"]}}.
type avoidance struct {
	Groups map[string][]string `json:"groups"`
	Terms  map[string][]string `json:"terms"`
}

func avoidFor(diets, allergies []string) avoidance {
	out := avoidance{Groups: map[string][]string{}, Terms: map[string][]string{}}
	add := func(m map[string][]string, k, from string) {
		if !slices.Contains(m[k], from) {
			m[k] = append(m[k], from)
		}
	}
	for _, d := range diets {
		for _, g := range dietGroups[strings.Join(strings.Fields(strings.ReplaceAll(strings.ToLower(d), "-", " ")), " ")] {
			add(out.Groups, g, d)
		}
	}
	for _, a := range allergies {
		a = strings.TrimSpace(a)
		clean := cleanFoodName(a)
		phrase := strings.Join(clean.words, " ")
		if phrase == "" {
			continue
		}
		groups, terms := avoidWords(phrase, clean.words)
		for _, g := range groups {
			add(out.Groups, g, a)
		}
		for _, t := range terms {
			add(out.Terms, t, a)
		}
	}
	return out
}

// avoidWords reads one allergy as a member wrote it: a group ("shellfish", "lactose"), an
// ingredient ("cilantro", which also avoids what it goes by elsewhere), or a sentence with one
// in it ("allergic to peanuts", "花生过敏"). Anything else is avoided by its own words.
func avoidWords(phrase string, words []string) (groups, terms []string) {
	if g, ok := avoidAliases[phrase]; ok {
		return g, nil
	}
	if key, ok := foodAliases[phrase]; ok {
		if g, ok := avoidAliases[key]; ok {
			return g, nil
		}
		return nil, []string{key}
	}
	for _, w := range words {
		groups = append(groups, avoidAliases[w]...)
	}
	for _, m := range matchFood(words, "") {
		if g, ok := avoidAliases[m.entry.key]; ok {
			groups = append(groups, g...)
		} else {
			terms = append(terms, m.entry.key)
		}
	}
	if len(groups) == 0 && len(terms) == 0 {
		terms = []string{phrase}
	}
	return groups, terms
}

// groupList and termList are an avoid list's keys, for SQL array filters.
func (v avoidance) groupList() []string { return mapKeys(v.Groups) }
func (v avoidance) termList() []string  { return mapKeys(v.Terms) }

func mapKeys(m map[string][]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
