package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

// POST /recipes/import reads a recipe from a web page into a private draft for the editor;
// nothing is saved. Pages with schema.org Recipe data are mapped here; others go to the recipe
// model as an ordinary AI job.

const noRecipeOnPage = "We couldn’t find a recipe on that page."

const (
	// importPrefix starts an import job's prompt, followed by the page. The sous-chef history
	// shows a prompt's first line, and importedFrom reads the page back to credit the result.
	importPrefix = "Import the recipe on this web page: "
	// minPageText is less text than any recipe takes; a shorter page isn't worth a job.
	minPageText = 200
	// importTextLimit is how much page text a job sends the model.
	importTextLimit = 16000
)

// errNoRecipe marks an import job whose page had no recipe the model could read.
var errNoRecipe = errors.New("no recipe on the page")

func (a *App) importRecipe(c fiber.Ctx) error {
	var in struct{ URL string }
	if e := decode(c, &in); e != nil {
		return e
	}
	target, ok := importURL(in.URL)
	if !ok {
		return fiber.NewError(400, "Paste the full address of a recipe page.")
	}
	ctx, cancel := context.WithTimeout(c.Context(), 20*time.Second)
	defer cancel()
	page, e := fetchPage(ctx, target)
	if errors.Is(e, errNotPage) {
		return fiber.NewError(422, noRecipeOnPage)
	}
	if e != nil {
		slog.Info("recipe import: page unavailable", "host", hostOf(target), "error", e)
		return fiber.NewError(502, "We couldn’t open that page.")
	}
	at, e := url.Parse(page.URL)
	if e != nil {
		return fiber.NewError(502, "We couldn’t open that page.")
	}
	doc, source := readPage(page.HTML), sourceLink(at)
	if ld, ok := findRecipe(doc.LD); ok {
		if r, ok := a.structuredRecipe(ld, doc, at, source); ok {
			return c.JSON(fiber.Map{"method": "structured", "recipe": r})
		}
	}
	if utf8.RuneCountInString(doc.Text) < minPageText {
		return fiber.NewError(422, noRecipeOnPage)
	}
	if !a.AI.TextEnabled() {
		return fiber.NewError(503, "We couldn’t read a recipe from that page.")
	}
	// An ordinary recipe job, with its allowance and budget. Retrying with the same
	// Idempotency-Key gets the same job; without a key, every request is a new one.
	key := c.Get("Idempotency-Key")
	if key == "" {
		key = "import-" + uuid.NewString()
	}
	job, _, e := a.enqueueJob(c, key, "recipe", importPrompt(source, doc), "")
	if e != nil {
		return e
	}
	return c.Status(202).JSON(fiber.Map{"method": "ai", "job": json.RawMessage(job)})
}

// importURL reads the address a member pasted: http(s) with a host and no credentials, the
// scheme optional. Pages are only fetched over HTTPS, like everything from outside, so http
// becomes https.
func importURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 || strings.ContainsAny(raw, " \t\r\n") {
		return "", false
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, e := url.Parse(raw)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return "", false
	}
	if u.Scheme == "http" {
		u.Scheme, u.Host = "https", strings.TrimSuffix(u.Host, ":80")
	}
	u.Fragment, u.RawFragment = "", ""
	return u.String(), true
}

func hostOf(raw string) string {
	if u, e := url.Parse(raw); e == nil {
		return u.Hostname()
	}
	return ""
}

// sourceLink is how a recipe credits the page it came from: where it was read, without the
// fragment or tracking parameters, and within sourceUrl's 500 characters (dropping the query,
// then the path, when it isn't).
func sourceLink(page *url.URL) string {
	u := *page
	u.Fragment, u.RawFragment = "", ""
	if q := u.Query(); len(q) > 0 {
		tracking := false
		for k := range q {
			if l := strings.ToLower(k); strings.HasPrefix(l, "utm_") || l == "fbclid" || l == "gclid" || l == "mc_cid" || l == "mc_eid" {
				q.Del(k)
				tracking = true
			}
		}
		if tracking {
			u.RawQuery = q.Encode()
		}
	}
	for _, shorten := range []func(){func() {}, func() { u.RawQuery, u.ForceQuery = "", false }, func() { u.Path, u.RawPath = "/", "" }} {
		shorten()
		if s := u.String(); validSourceURL(s) {
			return s
		}
	}
	return ""
}

// structuredRecipe maps a page's schema.org Recipe to a draft that passes Validate, or reports
// that it holds too little to be one (no ingredients or no steps), which leaves the page to
// the recipe model.
func (a *App) structuredRecipe(ld ldRecipe, doc pageData, page *url.URL, source string) (RecipeInput, bool) {
	x := ld.Recipe
	r := RecipeInput{Photos: []string{}, Tags: []string{}, SourceURL: &source}
	ingredients := x["recipeIngredient"]
	if ingredients == nil {
		ingredients = x["ingredients"]
	}
	r.Ingredients = ldIngredients(ingredients)
	var drafts []draftStep
	ld.collectSteps(x["recipeInstructions"], "", 0, &drafts)
	r.Steps = a.recipeSteps(drafts, page)
	if len(r.Ingredients) == 0 || len(r.Steps) == 0 {
		return RecipeInput{}, false
	}
	host := strings.TrimPrefix(page.Hostname(), "www.")
	r.Title = clip(firstOf(ldText(x["name"]), doc.Title), 120)
	r.Description = clip(firstOf(described(ldText(x["description"])), described(doc.Description), "Imported from "+host+"."), 3000)
	r.Cuisine = "Other"
	cuisines := cleanTags(ldTexts(x["recipeCuisine"], true))
	if len(cuisines) > 0 && validText(cuisines[0], 2, 60) {
		r.Cuisine, cuisines = cuisines[0], cuisines[1:]
	}
	for _, t := range cleanTags(append(append(ldTexts(x["recipeCategory"], true), ldTexts(x["keywords"], true)...), cuisines...)) {
		if validText(t, 1, 40) && len(r.Tags) < 12 {
			r.Tags = append(r.Tags, t)
		}
	}
	r.Minutes = ldMinutes(x["totalTime"])
	if r.Minutes == 0 {
		r.Minutes = ldMinutes(x["prepTime"]) + ldMinutes(x["cookTime"])
	}
	if r.Minutes == 0 {
		seconds := 0
		for _, s := range r.Steps {
			seconds += s.Seconds
		}
		r.Minutes = int(math.Ceil(float64(seconds) / 60))
	}
	if r.Minutes == 0 {
		r.Minutes = 30
	}
	r.Minutes = min(r.Minutes, 1440)
	if r.Servings = int(math.Round(min(firstNumber(x["recipeYield"]), 100))); r.Servings < 1 {
		r.Servings = 4
	}
	if nutrition, ok := x["nutrition"].(map[string]any); ok {
		r.Calories = int(math.Round(min(firstNumber(nutrition["calories"]), 10000)))
	}
	r.Difficulty = difficultyOf(r.Minutes, len(r.Steps))
	r.Image = a.importedMedia(page, firstOf(ld.image(x["image"]), doc.Image))
	if language, ok := recipeLanguage(firstOf(ldText(x["inLanguage"]), doc.Lang)); ok {
		r.Language = language
	}
	if e := r.Validate(); e != nil {
		slog.Warn("recipe import: structured data didn't map to a recipe", "host", page.Hostname(), "error", e)
		return RecipeInput{}, false
	}
	return r, true
}

// described is s if it's long enough to describe a recipe, else "".
func described(s string) string {
	if validText(s, 10, math.MaxInt) {
		return s
	}
	return ""
}

func difficultyOf(minutes, steps int) string {
	switch {
	case minutes <= 30 && steps <= 6:
		return "Easy"
	case minutes > 120 || steps > 12:
		return "Advanced"
	}
	return "Medium"
}

// importedMedia resolves an image address from the page and keeps it only where a recipe may
// show it (allowedMedia): in production that's our storage or MEDIA_HOSTS, never the page's
// own site.
func (a *App) importedMedia(page *url.URL, raw string) string {
	if raw == "" {
		return ""
	}
	u, e := page.Parse(raw)
	if e != nil || !a.allowedMedia(u.String()) {
		return ""
	}
	return u.String()
}

// ldIngredients reads recipeIngredient: a list of lines, or one text with a line each.
// Headings such as "For the sauce:" aren't ingredients.
func ldIngredients(v any) []Ingredient {
	lines := ldTexts(v, false)
	if s, ok := v.(string); ok {
		lines = textLines(s)
	}
	out := []Ingredient{}
	for _, line := range lines {
		if strings.HasSuffix(line, ":") {
			continue
		}
		if in, ok := parseIngredient(line); ok && len(out) < 80 {
			out = append(out, in)
		}
	}
	return out
}

// draftStep is an instruction as a page gives it.
type draftStep struct {
	name, text, section, image string
	seconds                    int
}

// collectSteps flattens recipeInstructions in order: text, lists, HowToSteps (with any
// sub-steps) and HowToSections, whose name the steps inside them keep.
func (ld ldRecipe) collectSteps(v any, section string, depth int, out *[]draftStep) {
	if depth > 16 || len(*out) > 400 {
		return
	}
	switch x := v.(type) {
	case string:
		for _, line := range textLines(x) {
			*out = append(*out, draftStep{text: line, section: section})
		}
	case []any:
		for _, item := range x {
			ld.collectSteps(item, section, depth+1, out)
		}
	case map[string]any:
		if ldType(x["@type"], "HowToSection") || (x["itemListElement"] != nil && x["text"] == nil) {
			if name := ldText(x["name"]); name != "" && ldType(x["@type"], "HowToSection") {
				section = name
			}
			ld.collectSteps(x["itemListElement"], section, depth+1, out)
			return
		}
		name, text := ldText(x["name"]), ldText(x["text"])
		if text == "" {
			text = ldText(x["description"])
		}
		if text == "" {
			text, name = name, ""
		}
		if text != "" {
			d := draftStep{name: name, text: text, section: section, image: ld.image(x["image"])}
			for _, k := range []string{"timeRequired", "performTime", "totalTime"} {
				if m := ldMinutes(x[k]); m > 0 {
					d.seconds = m * 60
					break
				}
			}
			*out = append(*out, d)
		}
		if x["itemListElement"] != nil {
			ld.collectSteps(x["itemListElement"], section, depth+1, out)
		}
	}
}

var (
	// "1.", "2)" or "Step 3:" before a step: the app numbers steps itself.
	stepNumber = regexp.MustCompile(`(?i)^(?:step\s*)?\d+\s*[.):]\s+`)
	// A name that is only a number ("Step 2") says nothing a title should.
	numberedName = regexp.MustCompile(`(?i)^(?:step\s*)?\d+[.):]?$`)
	clauseEnd    = regexp.MustCompile(`[,;:!?(]|\.(?:\s|$)|\s[-–—]\s`)
)

// recipeSteps makes collected instructions a recipe's steps: without their numbers, crumbs too
// short to be a step joined to a neighbour, long ones split at sentences, at most 40 (the
// rest joins the last), each with a title and the timer its text gives.
func (a *App) recipeSteps(drafts []draftStep, page *url.URL) []Step {
	var kept []draftStep
	var carry draftStep
	for _, d := range drafts {
		d.text = strings.TrimSpace(carry.text + " " + stepNumber.ReplaceAllString(d.text, ""))
		d.seconds = max(d.seconds, carry.seconds)
		carry = draftStep{}
		if utf8.RuneCountInString(d.text) < 5 {
			if n := len(kept); n > 0 {
				kept[n-1].text += " " + d.text
				kept[n-1].seconds = max(kept[n-1].seconds, d.seconds)
			} else {
				carry = d
			}
			continue
		}
		for i, part := range splitText(d.text, 3000) {
			next := d
			next.text = part
			if i > 0 {
				next.name, next.image, next.seconds = "", "", 0
			}
			kept = append(kept, next)
		}
	}
	if len(kept) > 40 {
		rest := []string{}
		for _, d := range kept[39:] {
			rest = append(rest, d.text)
		}
		kept[39].text = clip(strings.Join(rest, " "), 3000)
		kept = kept[:40]
	}
	steps := []Step{}
	titled := map[string]bool{}
	for _, d := range kept {
		title := stepTitle(d.text)
		switch {
		case d.name != "" && d.name != d.text && utf8.RuneCountInString(d.name) <= 80 && !numberedName.MatchString(d.name):
			title = d.name
		case d.section != "" && !titled[d.section]:
			title = d.section
		}
		titled[d.section] = true
		seconds := d.seconds
		if seconds == 0 {
			seconds = stepSeconds(d.text)
		}
		steps = append(steps, Step{Title: clip(title, 120), Text: clip(d.text, 3000), Seconds: min(seconds, 86400), Image: a.importedMedia(page, d.image)})
	}
	return steps
}

// stepTitle names a step after the start of its text, the way the app's own steps read ("Cook
// the pasta"): its first clause, up to six words.
func stepTitle(text string) string {
	clause := text
	if loc := clauseEnd.FindStringIndex(text); loc != nil && loc[0] > 0 {
		clause = text[:loc[0]]
	}
	words := strings.Fields(clause)
	if len(words) > 6 {
		return strings.Join(words[:6], " ") + "…"
	}
	return strings.Join(words, " ")
}

// splitText cuts text into parts of at most n characters, at a sentence's end where it can.
func splitText(text string, n int) []string {
	var out []string
	for r := []rune(text); len(r) > n; r = []rune(text) {
		cut := n
		for i := n - 1; i > n/2; i-- {
			if strings.ContainsRune(".!?", r[i]) && r[i+1] == ' ' {
				cut = i + 1
				break
			}
		}
		out = append(out, strings.TrimSpace(string(r[:cut])))
		text = strings.TrimSpace(string(r[cut:]))
	}
	return append(out, text)
}

// importPrompt asks the recipe model for a page's own recipe. Its first line names the page;
// the instructions and the text follow "Context:", which the sous-chef history leaves out.
func importPrompt(source string, doc pageData) string {
	var b strings.Builder
	b.WriteString(importPrefix + source + "\n\nContext: Below is the text of that web page. Take its recipe as the page gives it, in the page's own language: the title, a description, every ingredient with its amount and unit, and every step, with a step's timer in seconds where the page gives a time. Add nothing the page doesn't say, apart from estimating the calories, the difficulty and the cuisine. If the page has no recipe, answer {\"recipe\": null}.\n\n")
	if doc.Title != "" {
		b.WriteString("Page title: " + doc.Title + "\n\n")
	}
	b.WriteString(pageExcerpt(doc.Text, importTextLimit))
	return b.String()
}

// pageExcerpt is up to n characters of a page's text. When the whole doesn't fit, it starts a
// little before the ingredients, since a long story often comes first.
func pageExcerpt(text string, n int) string {
	r := []rune(text)
	if len(r) <= n {
		return text
	}
	lower, start := strings.ToLower(text), -1
	for _, word := range []string{"ingredients", "ingrédients", "zutaten", "ingredienti", "ingredientes", "ingrediënten", "ингредиенты", "材料"} {
		if i := strings.Index(lower, word); i >= 0 && (start < 0 || i < start) {
			start = i
		}
	}
	from := 0
	if start > 0 {
		// strings.ToLower maps rune to rune, so rune positions in lower match text's.
		from = min(max(utf8.RuneCountInString(lower[:start])-min(1500, n/8), 0), len(r)-n)
	}
	return string(r[from : from+n])
}

// importedFrom is the page an import job's prompt names (importPrompt), or nil for any other
// prompt.
func importedFrom(prompt string) *string {
	line, _, _ := strings.Cut(prompt, "\n")
	source, ok := strings.CutPrefix(line, importPrefix)
	if !ok || source == "" || !validSourceURL(source) {
		return nil
	}
	return &source
}
