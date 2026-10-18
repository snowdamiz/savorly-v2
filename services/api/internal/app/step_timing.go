package app

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

// How each step spends its time, for the meal timeline (meal_timeline.go, docs/MEAL-TIMELINE.md):
// hands-on and waiting seconds, the oven's heat and the burners. A step's cook can say it in the
// editor, and imports and the sous-chef's drafts fill it in as estimates; for every other step the
// server estimates it once per recipe, when the recipe is saved and by a pass for writes that
// didn't (041_meal_timeline.sql's step_timing). The estimate reads the step's words with a
// lexicon in the app's nine languages (step_timing_lexicon.go): "bake at 200 °C for 25 minutes"
// is 25 minutes in a 200 °C oven, a minute of it hands-on, and "let it rest 10 minutes" ten
// minutes of waiting. A step whose words give no time ("fry until golden") gets its share of
// the recipe's stated time, a guess the cheap model replaces once for published recipes, within
// a daily cap and the shared AI budget (step_timing_model.go). Every estimate is marked as one.

const (
	// timingVersion changes with the lexicon or the rules below; recipes read under another are
	// read again (indexTiming).
	timingVersion = 1
	// A step whose words give no time gets its share of what the recipe's time leaves, between
	// these.
	minGuessSeconds, maxGuessSeconds = 3 * 60, 20 * 60
	// The oven's heat when a recipe that bakes never says it, in °C.
	defaultOvenHeat = 180
	// A temperature below this is the food's ("until it reaches 74 °C"), not the oven's.
	minOvenReading = 90
	// Overnight, as a wait.
	overnightSeconds = 8 * 3600
	// The hands-on part of a waiting step: getting it in, covered or out.
	waitHands = 60
)

// Where an estimate came from: the step's words, its share of the recipe's time, or the model.
const (
	fromText  = "text"
	fromGuess = "guess"
	fromModel = "model"
)

// timingEstimate is the server's estimate of one step's timing, kept by step key.
type timingEstimate struct {
	StepTiming
	Source string `json:"source"`
}

// timingToken is one piece of a step's folded text: a number, a word, one character of Chinese
// or Japanese, a range dash, a degree sign (° or ℃ and ℉), or a break between phrases.
type timingToken struct {
	kind byte // 'n', 'w', 'c', 'r', 'd', 'C', 'F' or '.'
	text string
	num  float64
}

var (
	timingFullWidth = strings.NewReplacer("０", "0", "１", "1", "２", "2", "３", "3", "４", "4", "５", "5", "６", "6", "７", "7", "８", "8", "９", "9", "．", ".", "－", "-")
	timingVulgar    = map[rune]float64{'½': .5, '¼': .25, '¾': .75, '⅓': 1. / 3, '⅔': 2. / 3, '⅛': .125}
)

func timingDigit(r rune) bool { return r >= '0' && r <= '9' }

// timingTokens splits a step's text into the pieces the reader reads, folded like ingredient
// names: "1,5", "1½" and "1 1/2" are one number each, and "1h30" a number, a word and a number.
func timingTokens(text string) []timingToken {
	runes := []rune(foldFood(timingFullWidth.Replace(text)))
	var out []timingToken
	for i := 0; i < len(runes); {
		r := runes[i]
		switch {
		case timingDigit(r):
			j := i
			for j < len(runes) && timingDigit(runes[j]) {
				j++
			}
			if j+1 < len(runes) && (runes[j] == '.' || runes[j] == ',') && timingDigit(runes[j+1]) {
				for j++; j < len(runes) && timingDigit(runes[j]); j++ {
				}
			}
			n, _ := strconv.ParseFloat(strings.Replace(string(runes[i:j]), ",", ".", 1), 64)
			if j+1 < len(runes) && runes[j] == '/' && timingDigit(runes[j+1]) {
				k := j + 1
				for k < len(runes) && timingDigit(runes[k]) {
					k++
				}
				if d, _ := strconv.ParseFloat(string(runes[j+1:k]), 64); d > 0 {
					n, j = n/d, k
					// "1 1/2" is one and a half.
					if last := len(out) - 1; last >= 0 && out[last].kind == 'n' && i > 0 && runes[i-1] == ' ' {
						out[last].num += n
						i = j
						continue
					}
				}
			}
			if j < len(runes) && timingVulgar[runes[j]] > 0 {
				n += timingVulgar[runes[j]]
				j++
			}
			out = append(out, timingToken{kind: 'n', num: n})
			i = j
		case timingVulgar[r] > 0:
			out = append(out, timingToken{kind: 'n', num: timingVulgar[r]})
			i++
		case cjk(r):
			out = append(out, timingToken{kind: 'c', text: string(r)})
			i++
		case unicode.IsLetter(r):
			j := i
			for j < len(runes) && (unicode.IsLetter(runes[j]) || unicode.Is(unicode.Mn, runes[j])) && !cjk(runes[j]) {
				j++
			}
			out = append(out, timingToken{kind: 'w', text: string(runes[i:j])})
			i = j
		default:
			switch {
			case strings.ContainsRune("-–—~〜～", r):
				out = append(out, timingToken{kind: 'r'})
			case strings.ContainsRune("°º˚", r):
				out = append(out, timingToken{kind: 'd'})
			case r == '℃':
				out = append(out, timingToken{kind: 'C'})
			case r == '℉':
				out = append(out, timingToken{kind: 'F'})
			case strings.ContainsRune(".,;:!?()[]\"“”„«»…。，、；：！？（）「」『』\n", r):
				out = append(out, timingToken{kind: '.'})
			}
			i++
		}
	}
	return out
}

// timingWords reports whether word is on language's list (English for a recipe that doesn't say).
func timingWords(lists map[string][]string, language string, word string) bool {
	return slices.Contains(lists[timingLanguage(language)], word)
}

// timingLanguage is the language a recipe's words are read in: its own, or English.
func timingLanguage(language string) string {
	if language == "" {
		return "en"
	}
	return language
}

// timingKinds is the kinds of phrase the tokens hold (timingLexicon), within a clause: words in
// a row for spaced scripts (English ones also in the singular), a run for Chinese and Japanese.
func timingKinds(tokens []timingToken, language string) map[string]bool {
	found := map[string]bool{}
	english := timingLanguage(language) == "en"
	var words []string
	var run strings.Builder
	check := func() {
		cjkRun := run.String()
		for _, p := range timingPhrases {
			if found[p.kind] || (p.language != "" && p.language != timingLanguage(language)) {
				continue
			}
			if p.cjk != "" {
				found[p.kind] = strings.Contains(cjkRun, p.cjk)
				continue
			}
			for i := 0; i+len(p.words) <= len(words) && !found[p.kind]; i++ {
				match := true
				for k, w := range p.words {
					got := words[i+k]
					if english && got != w {
						got = singular(got)
					}
					if got != w && !(p.prefix[k] && strings.HasPrefix(words[i+k], w)) {
						match = false
						break
					}
				}
				found[p.kind] = match
			}
		}
		words = words[:0]
		run.Reset()
	}
	for _, t := range tokens {
		switch t.kind {
		case 'w':
			words = append(words, t.text)
		case 'c':
			run.WriteString(t.text)
		case '.':
			check()
		default:
			// Numbers and signs keep phrases apart.
			words = append(words, "#")
			run.WriteString(" ")
		}
	}
	check()
	return found
}

// timingNumberAt reads a number at tokens[i]: digits or a number word, a range ("20-25", "two or
// three": its longer end), an article or a half before a unit ("an hour", "half an hour"), "a
// few", or a number in Chinese or Japanese ("二十五"), with 半 for a half. It answers the number,
// where it ends, and whether it is one only before a unit.
func timingNumberAt(tokens []timingToken, i int, language string) (value float64, end int, needsUnit bool, ok bool) {
	language = timingLanguage(language)
	word := func(j int) string {
		if j < len(tokens) && tokens[j].kind == 'w' {
			return tokens[j].text
		}
		return ""
	}
	single := func(j int) (float64, int, bool) {
		if j >= len(tokens) {
			return 0, j, false
		}
		switch t := tokens[j]; t.kind {
		case 'n':
			return t.num, j + 1, true
		case 'w':
			n, ok := timingNumbers[language][t.text]
			if ok && n >= 20 && n < 100 {
				// "forty five", "vingt cinq"
				if units, more := timingNumbers[language][word(j+1)]; more && units < 10 {
					return n + units, j + 2, true
				}
			}
			return n, j + 1, ok
		case 'c':
			return cjkNumber(tokens, j)
		}
		return 0, j, false
	}
	t := tokens[i]
	switch {
	case t.kind == 'w' && timingWords(timingHalves, language, t.text):
		end = i + 1
		if timingWords(timingArticles, language, word(end)) {
			end++
		}
		return .5, end, true, true
	case t.kind == 'w' && timingWords(timingFew, language, t.text):
		end = i + 1
		if word(end) == "of" {
			end++
		}
		if t.text == "couple" || t.text == "пару" {
			return 2, end, true, true
		}
		return 3, end, true, true
	case t.kind == 'w' && timingWords(timingArticles, language, t.text):
		if next := word(i + 1); timingWords(timingHalves, language, next) {
			return .5, i + 2, true, true
		} else if timingWords(timingFew, language, next) {
			return timingNumberAt(tokens, i+1, language)
		}
		return 1, i + 1, true, true
	}
	value, end, ok = single(i)
	if !ok {
		return 0, i, false, false
	}
	// A range counts as its longer end: dinner late is worse than a side kept warm.
	if end < len(tokens) && (tokens[end].kind == 'r' || timingWords(timingRanges, language, word(end)) || (tokens[end].kind == 'c' && (tokens[end].text == "至" || tokens[end].text == "到"))) {
		if upper, after, more := single(end + 1); more && upper >= value {
			value, end = upper, after
		}
	}
	// "一个半小时": a number, 个, then a half.
	if end < len(tokens) && tokens[end].kind == 'c' && (tokens[end].text == "个" || tokens[end].text == "個") {
		end++
	}
	if end < len(tokens) && tokens[end].kind == 'c' && tokens[end].text == "半" {
		value, end = value+.5, end+1
	}
	return value, end, false, true
}

// cjkNumber reads a number written in Chinese or Japanese numerals at tokens[j]: 五, 十五,
// 二十五, 一百, a half (半), and "a few" (几, 数).
func cjkNumber(tokens []timingToken, j int) (float64, int, bool) {
	total, current, seen := 0.0, 0.0, false
	for ; j < len(tokens) && tokens[j].kind == 'c'; j++ {
		r := []rune(tokens[j].text)[0]
		n, ok := timingCJKNumerals[r]
		if !ok {
			break
		}
		seen = true
		switch {
		case r == '半':
			return total + current + .5, j + 1, true
		case n == 10 || n == 100:
			if current == 0 {
				current = 1
			}
			total += current * n
			current = 0
		default:
			current = n
		}
	}
	return total + current, j, seen
}

// timingUnitAt reads a unit of time at tokens[j], in seconds, and where it ends.
func timingUnitAt(tokens []timingToken, j int) (float64, int, bool) {
	if j >= len(tokens) {
		return 0, j, false
	}
	if t := tokens[j]; t.kind == 'w' {
		seconds, ok := timingUnits[t.text]
		return seconds, j + 1, ok
	}
	var run strings.Builder
	for k := j; k < len(tokens) && k < j+3 && tokens[k].kind == 'c'; k++ {
		run.WriteString(tokens[k].text)
	}
	for _, u := range timingCJKUnits {
		if strings.HasPrefix(run.String(), u.unit) {
			return u.seconds, j + len([]rune(u.unit)), true
		}
	}
	return 0, j, false
}

// timingSeconds adds up the times a step's tokens give: "25 minutes", "1 h 30", "an hour and a
// half", "20–25 Minuten" (its longer end), "полчаса", "1時間半", "二十分钟".
func timingSeconds(tokens []timingToken, language string) float64 {
	total := 0.0
	word := func(j int) string {
		if j < len(tokens) && tokens[j].kind == 'w' {
			return tokens[j].text
		}
		return ""
	}
	for i := 0; i < len(tokens); {
		if w := word(i); w != "" {
			if seconds, ok := timingWholeUnits[w]; ok {
				total += seconds
				i++
				continue
			}
			if timingBareUnits[w] && timingLanguage(language) == "ru" && (i == 0 || tokens[i-1].kind != 'n') {
				total += timingUnits[w]
				i++
				continue
			}
		}
		value, j, _, ok := timingNumberAt(tokens, i, language)
		if !ok {
			i++
			continue
		}
		unit, k, ok := timingUnitAt(tokens, j)
		if !ok {
			i++
			continue
		}
		seconds := value * unit
		// "an hour and a half", "1 heure et demie", "1時間半"
		h := k
		if timingWords(timingAnd, language, word(h)) {
			h++
		}
		if timingWords(timingArticles, language, word(h)) {
			h++
		}
		if timingWords(timingHalves, language, word(h)) {
			seconds, k = seconds+unit/2, h+1
		} else if k < len(tokens) && tokens[k].kind == 'c' && tokens[k].text == "半" {
			seconds, k = seconds+unit/2, k+1
		} else if unit == 3600 && k < len(tokens) && tokens[k].kind == 'n' && tokens[k].num < 60 {
			// "1h30", "1 hour 30": the minutes after the hours.
			if _, _, minutes := timingUnitAt(tokens, k+1); !minutes {
				seconds, k = seconds+tokens[k].num*60, k+1
			}
		}
		total += seconds
		i = k
	}
	return total
}

// timingHeats is the temperatures a step's tokens give, in °C: "200 °C", "400°F", "180 Grad",
// "200度", "gas mark 6", "thermostat 7". A bare "350 degrees" in English is Fahrenheit.
func timingHeats(tokens []timingToken, language string) []int {
	var out []int
	word := func(j int) string {
		if j < len(tokens) && tokens[j].kind == 'w' {
			return tokens[j].text
		}
		return ""
	}
	add := func(celsius float64) {
		out = append(out, int(math.Round(celsius/5))*5)
	}
	for i, t := range tokens {
		switch {
		case t.kind == 'w' && (t.text == "gas" || t.text == "thermostat" || t.text == "th"):
			j := i + 1
			if word(j) == "mark" {
				j++
			}
			if j < len(tokens) && tokens[j].kind == '.' {
				j++
			}
			if j < len(tokens) && tokens[j].kind == 'n' {
				if n := int(tokens[j].num); t.text == "gas" && timingGasMarks[n] > 0 {
					add(float64(timingGasMarks[n]))
				} else if t.text != "gas" && n >= 1 && n <= 10 {
					add(float64(n * 30))
				}
			}
			continue
		case t.kind != 'n':
			continue
		}
		v, j := t.num, i+1
		fahrenheit, read := false, false
		switch {
		case j < len(tokens) && tokens[j].kind == 'd':
			read = true
			if timingFahrenheit[word(j+1)] {
				fahrenheit = true
			} else if !timingCelsius[word(j+1)] {
				fahrenheit = timingLanguage(language) == "en" && v > 250
			}
		case j < len(tokens) && (tokens[j].kind == 'C' || tokens[j].kind == 'F'):
			read, fahrenheit = true, tokens[j].kind == 'F'
		case v >= minOvenReading && (timingCelsius[word(j)] || timingFahrenheit[word(j)]):
			read, fahrenheit = true, timingFahrenheit[word(j)]
		case timingDegrees[word(j)]:
			read = true
			if timingFahrenheit[word(j+1)] {
				fahrenheit = true
			} else if !timingCelsius[word(j+1)] {
				fahrenheit = timingLanguage(language) == "en" && v > 250
			}
		case j < len(tokens) && tokens[j].kind == 'c' && tokens[j].text == "度":
			read = true
		}
		if !read {
			continue
		}
		if fahrenheit {
			v = (v - 32) * 5 / 9
		}
		add(v)
	}
	return out
}

// stepReading is what a step's words say about its time.
type stepReading struct {
	seconds                   int
	heat                      int // the oven's, in °C; 0 when the step doesn't say
	oven, preheat, hob, waits bool
}

// readStep reads one step's title and text.
func readStep(st Step, language string) stepReading {
	text := st.Title + ". " + st.Text
	tokens := timingTokens(text)
	kinds := timingKinds(tokens, language)
	equipment := map[string]bool{}
	for _, key := range matchEquipment(text, language) {
		equipment[key] = true
	}
	seconds := timingSeconds(tokens, language)
	if kinds[timingNight] {
		seconds += overnightSeconds
	}
	if kinds[timingSide] {
		seconds *= 2
	}
	r := stepReading{seconds: int(math.Min(math.Round(seconds), maxStepSeconds))}
	for _, heat := range timingHeats(tokens, language) {
		if heat >= minOvenReading && heat <= maxOvenHeat {
			r.heat = max(r.heat, heat)
		}
	}
	r.preheat = kinds[timingPreheat]
	r.oven = r.preheat || ((equipment["oven"] || kinds[timingOven]) && !kinds[timingOut])
	vessel := equipment["pot"] || equipment["saucepan"] || equipment["frying pan"] || equipment["griddle"] || equipment["wok"] || equipment["dutch oven"] || equipment["steamer"]
	// A step that also uses the oven takes the hob only for a moment ("sear, then roast").
	r.hob = (kinds[timingHob] || vessel) && !r.oven
	r.waits = (kinds[timingWait] || r.oven || equipment["slow cooker"] || equipment["pressure cooker"] || equipment["rice cooker"] || equipment["steamer"] || equipment["air fryer"]) && !kinds[timingBusy]
	return r
}

// readTimings estimates every step's timing from its words, in order: what the text says, and
// for steps that give no time, their share of what the recipe's minutes leave once the steps that
// do (and those their cook timed) are counted. A step that only
// preheats the oven takes no time of its own (the timeline turns the oven on early enough).
func readTimings(steps []Step, language string, minutes int) []timingEstimate {
	readings := make([]stepReading, len(steps))
	heat := 0
	for i, st := range steps {
		readings[i] = readStep(st, language)
		if heat == 0 && readings[i].oven {
			heat = readings[i].heat
		}
	}
	if heat == 0 {
		heat = defaultOvenHeat
	}
	durations := make([]int, len(steps))
	known, unknown := 0, 0
	for i, st := range steps {
		r := readings[i]
		switch {
		case st.Timing != nil:
			// Its cook's time is part of the recipe's.
			known += st.Timing.Active + st.Timing.Wait
		case r.preheat && r.seconds == 0:
		case r.seconds > 0 || st.Seconds > 0:
			durations[i] = max(r.seconds, st.Seconds)
			known += durations[i]
		default:
			unknown++
		}
	}
	share := minGuessSeconds
	if unknown > 0 {
		share = min(max((minutes*60-known)/unknown, minGuessSeconds), maxGuessSeconds)
	}
	out := make([]timingEstimate, len(steps))
	for i := range steps {
		r := readings[i]
		e := timingEstimate{StepTiming: StepTiming{Estimated: true}, Source: fromText}
		ovenHeat := heat
		if r.heat > 0 {
			ovenHeat = r.heat
		}
		if r.preheat && r.seconds == 0 {
			e.Oven = ovenHeat
			out[i] = e
			continue
		}
		d := durations[i]
		if d == 0 {
			d, e.Source = share, fromGuess
		}
		if r.waits {
			e.Active = min(waitHands, d/2)
			e.Wait = d - e.Active
		} else {
			e.Active = d
		}
		if r.oven {
			e.Oven = ovenHeat
		}
		if r.hob {
			e.Burners = 1
		}
		out[i] = e
	}
	return out
}

// stepEstimates is what step_timing keeps for a recipe's steps, by step key: the steps' reading,
// except that a step its cook timed needs none, and the model's estimate stands for a step whose
// words still give no time. guessed reports whether a guess is left for the model.
func stepEstimates(steps []Step, language string, minutes int, saved map[string]timingEstimate) (out map[string]timingEstimate, guessed bool) {
	out = map[string]timingEstimate{}
	for i, e := range readTimings(steps, language, minutes) {
		if steps[i].Timing != nil {
			continue
		}
		key := cookStepKey(steps[i].Text)
		if old, ok := saved[key]; ok && e.Source == fromGuess && old.Source == fromModel {
			e = old
		}
		out[key] = e
		guessed = guessed || e.Source == fromGuess
	}
	return out, guessed
}

// stepTimings is every step's timing as the timeline uses it: its cook's, else the server's
// estimate kept for it, else a reading made now (a recipe saved since the pass last ran).
func stepTimings(steps []Step, language string, minutes int, saved map[string]timingEstimate) []StepTiming {
	read := readTimings(steps, language, minutes)
	out := make([]StepTiming, len(steps))
	for i, st := range steps {
		switch e, ok := saved[cookStepKey(st.Text)]; {
		case st.Timing != nil:
			out[i] = *st.Timing
		case ok:
			out[i] = e.StepTiming
			out[i].Estimated = true
		default:
			out[i] = read[i].StepTiming
		}
	}
	return out
}

// importTiming gives an imported recipe's steps the timing their words give, as estimates the
// author sees in the editor; steps whose words give no time are left to the server's estimate.
func importTiming(r *RecipeInput) {
	for i, e := range readTimings(r.Steps, r.Language, r.Minutes) {
		if r.Steps[i].Timing == nil && e.Source == fromText {
			t := e.StepTiming
			r.Steps[i].Timing = &t
		}
	}
}

// fitTiming holds timing a model wrote to what a step may have, rather than failing the recipe:
// times up to a day, an oven heat out of range dropped, up to 6 burners. It is the model's
// estimate, unless it is what the saved step with the same text already has (a draft that kept
// its cook's timing as it read it).
func fitTiming(steps, saved []Step) {
	own := map[string]StepTiming{}
	for _, st := range saved {
		if st.Timing != nil {
			own[strings.TrimSpace(st.Text)] = *st.Timing
		}
	}
	for i := range steps {
		t := steps[i].Timing
		if t == nil {
			continue
		}
		t.Active, t.Wait = min(max(t.Active, 0), maxStepSeconds), min(max(t.Wait, 0), maxStepSeconds)
		if t.Oven < minOvenHeat || t.Oven > maxOvenHeat {
			t.Oven = 0
		}
		t.Burners = min(max(t.Burners, 0), maxStepBurners)
		kept, ok := own[strings.TrimSpace(steps[i].Text)]
		t.Estimated = !ok || kept.Estimated || kept.Active != t.Active || kept.Wait != t.Wait || kept.Oven != t.Oven || kept.Burners != t.Burners
	}
}

// indexRecipeTiming estimates one recipe's steps from what is saved. A recipe changed in the
// meantime is left for the next write or pass, which reads the newer steps.
func indexRecipeTiming(ctx context.Context, db recipeWriter, id string) error {
	var steps []Step
	var language, source string
	var minutes int
	saved := map[string]timingEstimate{}
	e := db.QueryRow(ctx, `SELECT steps,language,minutes,step_timing,timing_source FROM recipes WHERE id=$1`, id).Scan(&steps, &language, &minutes, &saved, &source)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	estimates, guessed := stepEstimates(steps, language, minutes, saved)
	_, e = db.Exec(ctx, `UPDATE recipes SET step_timing=$2,timing_guessed=$3,timing_version=$4,timing_indexed=$5 WHERE id=$1 AND timing_source=$5`,
		id, jsonBytes(estimates), guessed, timingVersion, source)
	return e
}

// indexTiming brings recipes up to the lexicon: those read under another timingVersion, never
// read, or changed by a write that didn't read them (the seed, another server version). Each
// recipe is its own statement, so a pass never holds a long transaction.
func indexTiming(ctx context.Context, db *pgxpool.Pool) (indexed int, err error) {
	for _, query := range []string{
		`SELECT id FROM recipes WHERE timing_indexed<>timing_source ORDER BY id LIMIT $1`,
		`SELECT id FROM recipes WHERE timing_version<>` + strconv.Itoa(timingVersion) + ` ORDER BY id LIMIT $1`,
	} {
		// A recipe that changes under every pass stops after a few rounds rather than looping; the
		// next pass takes it.
		for round := 0; round < 1000; round++ {
			ids, e := collectIDs(ctx, db, query, indexBatch)
			if e != nil {
				return indexed, e
			}
			for _, id := range ids {
				if e = indexRecipeTiming(ctx, db, id); e != nil {
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

// RunStepTiming reads what needs it at start-up, then every ten minutes, for any write that
// didn't, and has the model improve published recipes' guesses within the day's cap. Replicas
// may overlap; reading is idempotent, and the model is asked under a lock.
func RunStepTiming(ctx context.Context, db *pgxpool.Pool) {
	a := &App{DB: db, AI: ai.New(), Context: ctx}
	for {
		if n, e := indexTiming(ctx, db); e != nil && ctx.Err() == nil {
			slog.Error("step timing index", "error", e)
		} else if n > 0 {
			slog.Info("step timing index", "indexed", n)
		}
		if a.AI.TextEnabled() {
			if n, e := a.estimateTimings(ctx); e != nil && ctx.Err() == nil {
				slog.Warn("step timing estimates", "error", e)
			} else if n > 0 {
				slog.Info("step timing estimates", "recipes", n)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Minute):
		}
	}
}
