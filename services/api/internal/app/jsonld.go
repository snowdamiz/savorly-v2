package app

import (
	"bytes"
	"encoding/json"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// What an import reads from a web page: schema.org Recipe data (JSON-LD) when the page has it,
// and otherwise its visible text for the recipe model.

// pageData is what readPage finds on a page.
type pageData struct {
	LD          []string // the JSON-LD blocks
	Lang        string   // <html lang>
	Title       string   // og:title, else <title>
	Description string   // og:description, else the meta description
	Image       string   // og:image
	Text        string   // the visible text, a line per block
}

// maxDepth bounds how deep an import follows a page's elements.
const maxDepth = 256

// hiddenElements hold nothing a reader sees, or nothing of a recipe.
var hiddenElements = map[atom.Atom]bool{atom.Head: true, atom.Script: true, atom.Style: true, atom.Noscript: true,
	atom.Template: true, atom.Svg: true, atom.Math: true, atom.Iframe: true, atom.Object: true, atom.Canvas: true,
	atom.Nav: true, atom.Footer: true, atom.Aside: true, atom.Form: true, atom.Button: true, atom.Select: true,
	atom.Textarea: true, atom.Dialog: true}

// blockElements start a line of their own.
var blockElements = map[atom.Atom]bool{atom.P: true, atom.Div: true, atom.Br: true, atom.Li: true, atom.H1: true,
	atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true, atom.Tr: true, atom.Section: true,
	atom.Article: true, atom.Header: true, atom.Main: true, atom.Ul: true, atom.Ol: true, atom.Dl: true, atom.Dt: true,
	atom.Dd: true, atom.Table: true, atom.Blockquote: true, atom.Figure: true, atom.Figcaption: true, atom.Pre: true,
	atom.Hr: true, atom.Details: true, atom.Summary: true, atom.Address: true}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// readPage parses a page (UTF-8) for an import.
func readPage(doc []byte) pageData {
	var p pageData
	root, e := html.Parse(bytes.NewReader(doc))
	if e != nil {
		return p
	}
	var title, ogTitle, description, ogDescription string
	body := root
	var regions []*html.Node
	var walk func(n *html.Node, depth int)
	walk = func(n *html.Node, depth int) {
		if depth > maxDepth {
			return
		}
		if n.Type == html.ElementNode {
			switch n.DataAtom {
			case atom.Html:
				p.Lang = attr(n, "lang")
			case atom.Title:
				if title == "" {
					title = plainText(childText(n))
				}
			case atom.Meta:
				key := attr(n, "property")
				if key == "" {
					key = attr(n, "name")
				}
				content := strings.TrimSpace(attr(n, "content"))
				switch strings.ToLower(key) {
				case "og:title":
					ogTitle = plainText(content)
				case "og:description":
					ogDescription = plainText(content)
				case "description":
					description = plainText(content)
				case "og:image", "og:image:url", "og:image:secure_url":
					if p.Image == "" {
						p.Image = content
					}
				}
			case atom.Script:
				if t := strings.ToLower(strings.TrimSpace(attr(n, "type"))); strings.HasPrefix(t, "application/ld+json") {
					p.LD = append(p.LD, childText(n))
				}
			case atom.Body:
				body = n
			case atom.Main, atom.Article:
				if len(regions) < 20 {
					regions = append(regions, n)
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, depth+1)
		}
	}
	walk(root, 0)
	p.Title, p.Description = firstOf(ogTitle, title), firstOf(ogDescription, description)
	// Pages keep their recipe in <main> or an <article>, away from menus and comments.
	for _, n := range regions {
		if text := visibleText(n); utf8.RuneCountInString(text) >= 500 && len(text) > len(p.Text) {
			p.Text = text
		}
	}
	if p.Text == "" {
		p.Text = visibleText(body)
	}
	return p
}

// firstOf is the first of its arguments that isn't "".
func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func childText(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			b.WriteString(c.Data)
		}
	}
	return b.String()
}

// visibleText is the text a reader sees in n, a line per block, up to a few times what an
// import sends the model.
func visibleText(n *html.Node) string {
	var b strings.Builder
	var walk func(n *html.Node, depth int)
	walk = func(n *html.Node, depth int) {
		if depth > maxDepth || b.Len() > 8*importTextLimit {
			return
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
			return
		}
		if n.Type == html.ElementNode && (hiddenElements[n.DataAtom] || attr(n, "aria-hidden") == "true" || slices.ContainsFunc(n.Attr, func(a html.Attribute) bool { return a.Key == "hidden" })) {
			return
		}
		sep := ""
		if n.Type == html.ElementNode {
			if blockElements[n.DataAtom] {
				sep = "\n"
			} else if n.DataAtom == atom.Td || n.DataAtom == atom.Th {
				sep = " "
			}
		}
		b.WriteString(sep)
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, depth+1)
		}
		b.WriteString(sep)
	}
	walk(n, 0)
	var lines []string
	for line := range strings.SplitSeq(b.String(), "\n") {
		if l := strings.Join(strings.Fields(line), " "); l != "" {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n")
}

// ldRecipe is a page's schema.org Recipe, with every JSON-LD item that has an @id, so that a
// reference such as "image": {"@id": "…#primaryimage"} can be followed.
type ldRecipe struct {
	Recipe map[string]any
	ByID   map[string]map[string]any
}

// findRecipe returns the first schema.org Recipe in a page's JSON-LD: at the top of a block, in
// a list or an @graph, or inside another item (a WebPage's mainEntity, say).
func findRecipe(blocks []string) (ldRecipe, bool) {
	ld := ldRecipe{ByID: map[string]map[string]any{}}
	for _, block := range blocks {
		var v any
		// Some pages escape their JSON-LD as if it were HTML (&quot;).
		if json.Unmarshal(ldJSON(block), &v) != nil && json.Unmarshal(ldJSON(html.UnescapeString(block)), &v) != nil {
			continue
		}
		var walk func(v any, depth int)
		walk = func(v any, depth int) {
			if depth > 16 {
				return
			}
			switch x := v.(type) {
			case []any:
				for _, item := range x {
					walk(item, depth+1)
				}
			case map[string]any:
				if id, ok := x["@id"].(string); ok && len(x) > 1 {
					ld.ByID[id] = x
				}
				if ld.Recipe == nil && ldType(x["@type"], "Recipe") {
					ld.Recipe = x
				}
				for _, k := range slices.Sorted(maps.Keys(x)) {
					walk(x[k], depth+1)
				}
			}
		}
		walk(v, 0)
	}
	return ld, ld.Recipe != nil
}

// ldJSON tidies what pages get wrong in JSON-LD: a comment or CDATA wrapper, a trailing
// semicolon, and raw line breaks or tabs inside strings.
func ldJSON(s string) []byte {
	s = strings.TrimSpace(s)
	for _, wrap := range [][2]string{{"<!--", "-->"}, {"//<![CDATA[", "//]]>"}, {"<![CDATA[", "]]>"}} {
		s = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(s, wrap[0]), wrap[1]))
	}
	s = strings.TrimSuffix(s, ";")
	return []byte(strings.Map(func(r rune) rune {
		if r < 0x20 {
			return ' '
		}
		return r
	}, s))
}

// ldType reports whether a JSON-LD @type (a string or a list) names the type, written as
// "Recipe", "schema:Recipe" or "https://schema.org/Recipe".
func ldType(v any, name string) bool {
	switch t := v.(type) {
	case string:
		if i := strings.LastIndexAny(t, "/:#"); i >= 0 {
			t = t[i+1:]
		}
		return strings.EqualFold(strings.TrimSpace(t), name)
	case []any:
		return slices.ContainsFunc(t, func(x any) bool { return ldType(x, name) })
	}
	return false
}

// ldText is a JSON-LD value as plain text. A list gives its first text, and an object its
// @value, text or name.
func ldText(v any) string {
	switch x := v.(type) {
	case string:
		return plainText(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case []any:
		for _, item := range x {
			if s := ldText(item); s != "" {
				return s
			}
		}
	case map[string]any:
		for _, k := range []string{"@value", "text", "name"} {
			if s := ldText(x[k]); s != "" {
				return s
			}
		}
	}
	return ""
}

// ldTexts is every text in a value. Keywords and categories often come as one
// comma-separated string, which split breaks up.
func ldTexts(v any, split bool) []string {
	var out []string
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			out = append(out, ldTexts(item, split)...)
		}
	default:
		s := ldText(x)
		if !split {
			return append(out, s)
		}
		for part := range strings.SplitSeq(s, ",") {
			out = append(out, strings.TrimSpace(part))
		}
	}
	return out
}

// image is the first image address in an image value: a URL, an ImageObject, a reference to
// one, or a list of those.
func (ld ldRecipe) image(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case []any:
		for _, item := range x {
			if s := ld.image(item); s != "" {
				return s
			}
		}
	case map[string]any:
		node := x
		if id, ok := x["@id"].(string); ok && x["url"] == nil && x["contentUrl"] == nil && ld.ByID[id] != nil {
			node = ld.ByID[id]
		}
		for _, k := range []string{"url", "contentUrl"} {
			if s, ok := node[k].(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
}

var (
	// Tags that end a line of text: breaks, paragraphs, list items and headings.
	lineTags = regexp.MustCompile(`(?i)<br\s*/?>|</(?:p|li|div|h[1-6])\s*>`)
	anyTag   = regexp.MustCompile(`</?[a-zA-Z][^>]*>`)
)

// plainText is markup as one line of text: tags stripped, entities decoded (twice, for pages
// that escape them twice), spaces collapsed.
func plainText(s string) string {
	s = anyTag.ReplaceAllString(s, " ")
	for range 2 {
		if !strings.Contains(s, "&") {
			break
		}
		s = html.UnescapeString(s)
	}
	return strings.Join(strings.Fields(s), " ")
}

// textLines is markup as its lines of text, without blank ones.
func textLines(s string) []string {
	var out []string
	for line := range strings.SplitSeq(lineTags.ReplaceAllString(s, "\n"), "\n") {
		if l := plainText(line); l != "" {
			out = append(out, l)
		}
	}
	return out
}

var isoDuration = regexp.MustCompile(`(?i)^P(?:(\d+(?:[.,]\d+)?)Y)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$`)

// ldMinutes reads a duration as whole minutes, rounded up: ISO 8601 ("PT1H30M", "P0DT45M",
// "PT0.5H") or, as some pages write it, words ("1 hour 30 minutes"). 0 when there's none.
func ldMinutes(v any) int {
	s := strings.TrimSpace(ldText(v))
	m := isoDuration.FindStringSubmatch(s)
	if m == nil || len(s) < 3 {
		return int(math.Ceil(float64(spokenSeconds(s)) / 60))
	}
	total := 0.0
	for i, minutes := range []float64{525600, 43200, 10080, 1440, 60, 1, 1. / 60} {
		if m[i+1] != "" {
			n, _ := strconv.ParseFloat(strings.Replace(m[i+1], ",", ".", 1), 64)
			total += n * minutes
		}
	}
	if total <= 0 || total > 1e6 {
		return 0
	}
	return int(math.Ceil(total - 1e-9))
}

// A time in words: a number or a range ("5-10", "5 to 10", whose first number counts) and a
// unit, in English and the app's other European languages.
var spokenTime = regexp.MustCompile(`(?i)(\d+(?:[.,]\d+)?)(?:\s*(?:-|–|—|to|bis|à|a)\s*\d+(?:[.,]\d+)?)?\s*(hours?|hrs?|stunden?|heures?|ore|ora|horas?|minutes?|mins?|minuten?|minuti|minutos?|seconds?|secs?|sekunden?|secondes?|secondi|segundos?)\b`)

// spokenSeconds adds up the times written in s ("1 hour 30 minutes"), in seconds; 0 for none,
// or for more than a day.
func spokenSeconds(s string) int {
	total := 0.0
	for _, m := range spokenTime.FindAllStringSubmatch(s, -1) {
		n, _ := strconv.ParseFloat(strings.Replace(m[1], ",", ".", 1), 64)
		switch unit := strings.ToLower(m[2]); {
		case strings.HasPrefix(unit, "h") || strings.HasPrefix(unit, "st") || strings.HasPrefix(unit, "or"):
			total += n * 3600
		case strings.HasPrefix(unit, "m"):
			total += n * 60
		default:
			total += n
		}
	}
	if total > 86400 {
		return 0
	}
	return int(math.Round(total))
}

// stepSeconds is a step's timer: the first time its text gives ("Simmer for 10 minutes").
func stepSeconds(text string) int {
	return spokenSeconds(spokenTime.FindString(text))
}

// number reads a number as pages write it: "1.5", "1,5", or "1,200" with a thousands comma.
func number(s string) float64 {
	if whole, rest, ok := strings.Cut(s, ","); ok {
		if len(rest) == 3 && whole != "0" {
			s = whole + rest
		} else {
			s = whole + "." + rest
		}
	}
	n, _ := strconv.ParseFloat(s, 64)
	return n
}

var firstNumberPattern = regexp.MustCompile(`\d+(?:[.,]\d+)?`)

// firstNumber is the first number in a yield or a calorie count ("4 servings", "Serves 4-6",
// "250 kcal", 6, ["4", "4 servings"]); 0 when there's none.
func firstNumber(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case []any:
		for _, item := range x {
			if n := firstNumber(item); n > 0 {
				return n
			}
		}
		return 0
	}
	return number(firstNumberPattern.FindString(ldText(v)))
}

// Fraction glyphs and their values.
var fractionGlyphs = map[rune]float64{'¼': 1. / 4, '½': 1. / 2, '¾': 3. / 4, '⅓': 1. / 3, '⅔': 2. / 3, '⅛': 1. / 8, '⅜': 3. / 8,
	'⅝': 5. / 8, '⅞': 7. / 8, '⅕': 1. / 5, '⅖': 2. / 5, '⅗': 3. / 5, '⅘': 4. / 5, '⅙': 1. / 6, '⅚': 5. / 6}

const glyphClass = `[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]`

// An amount: a whole number and a fraction ("1 1/2", "1½", "1 ½"), a fraction ("1/2", "½"),
// or a number ("2", "1.5", "0,5").
const amountSyntax = `\d+\s+\d+\s*[/⁄]\s*\d+|\d+\s*[/⁄]\s*\d+|\d+(?:[.,]\d+)?\s*` + glyphClass + `|\d+(?:[.,]\d+)?|` + glyphClass

// A line's leading amount, or range of amounts ("2-3", "1 to 2"), and what follows it.
var leadingAmount = regexp.MustCompile(`^(` + amountSyntax + `)(?:\s*(-|–|—|to)\s*(` + amountSyntax + `))?\s*(.*)$`)

// amountValue reads one amount matched by amountSyntax.
func amountValue(s string) float64 {
	s = strings.TrimSpace(s)
	total := 0.0
	if r, size := utf8.DecodeLastRuneInString(s); fractionGlyphs[r] > 0 {
		total, s = fractionGlyphs[r], strings.TrimSpace(s[:len(s)-size])
	}
	whole, fraction := s, ""
	if i := strings.IndexAny(s, "/⁄"); i >= 0 {
		whole, fraction = "", s
		if j := strings.LastIndex(strings.TrimSpace(s[:i]), " "); j >= 0 {
			whole, fraction = s[:j], s[j+1:]
		}
	}
	if fraction != "" {
		parts := strings.FieldsFunc(fraction, func(r rune) bool { return r == '/' || r == '⁄' || r == ' ' })
		if len(parts) != 2 {
			return 0
		}
		n, d := number(parts[0]), number(parts[1])
		if d == 0 {
			return 0
		}
		total += n / d
	}
	if whole = strings.TrimSpace(whole); whole != "" {
		total += number(whole)
	}
	return total
}

// Units an ingredient line may name after its amount (as written, lowercase, without a dot).
var ingredientUnits = func() map[string]bool {
	m := map[string]bool{}
	for u := range strings.FieldsSeq(`cup cups c tablespoon tablespoons tbsp tbsps tbs tbl teaspoon teaspoons tsp tsps
	 g gram grams gramm gr kg kilo kilos kilogram kilograms mg ml milliliter milliliters millilitre millilitres cl dl l liter
	 liters litre litres oz ounce ounces lb lbs pound pounds pint pints pt quart quarts qt gallon gallons gal clove cloves slice
	 slices pinch pinches dash dashes handful handfuls sprig sprigs can cans tin tins jar jars package packages pkg packet
	 packets bunch bunches stick sticks piece pieces pc pcs head heads stalk stalks leaf leaves ball balls knob bottle bottles
	 bag bags drop drops el tl msp prise`) {
		m[u] = true
	}
	return m
}()

var (
	fluidOunces = regexp.MustCompile(`(?i)^(fl\.?\s*oz\.?|fluid\s+ounces?)(?:\s+|$)`)
	firstWord   = regexp.MustCompile(`^([\p{L}]+\.?),?(?:\s+|$)`)
	articleUnit = regexp.MustCompile(`(?i)^an?\s+`)
	ofPrefix    = regexp.MustCompile(`(?i)^of\s+`)
	toTaste     = regexp.MustCompile(`(?i)^(.+?),?\s+(to taste|as needed|as required)$`)
)

// unitOf reads the unit at the start of rest, returning it as written (T and t become tbsp
// and tsp, which a lowercase reading would confuse) and what follows.
func unitOf(rest string) (unit, after string) {
	if m := fluidOunces.FindStringSubmatch(rest); m != nil {
		return "fl oz", strings.TrimSpace(rest[len(m[0]):])
	}
	m := firstWord.FindStringSubmatch(rest)
	if m == nil {
		return "", rest
	}
	word := strings.TrimSuffix(m[1], ".")
	switch {
	case word == "T":
		word = "tbsp"
	case word == "t":
		word = "tsp"
	case !ingredientUnits[strings.ToLower(word)]:
		return "", rest
	}
	return word, strings.TrimSpace(rest[len(m[0]):])
}

// parseIngredient reads an ingredient line ("1 1/2 cups flour", "200 g pasta", "½ tsp salt",
// "2-3 cloves garlic", "salt to taste") into an amount, a unit and a name. A range keeps its
// first amount; a line without one keeps its words as the name.
func parseIngredient(line string) (Ingredient, bool) {
	line = strings.TrimLeft(plainText(line), "•·*-–▢□☐ ")
	if line == "" {
		return Ingredient{}, false
	}
	var in Ingredient
	rest := line
	if m := leadingAmount.FindStringSubmatch(line); m != nil {
		in.Amount = amountValue(m[1])
		// "1-1/2" is how some pages write one and a half, not a range.
		if m[2] == "-" && !strings.ContainsAny(m[1], "/⁄ ") && strings.ContainsAny(m[3], "/⁄") && !strings.Contains(strings.TrimSpace(m[3]), " ") {
			if f := amountValue(m[3]); f < 1 {
				in.Amount += f
			}
		}
		rest = m[4]
	} else if m := articleUnit.FindString(line); m != "" {
		// "a pinch of salt": an article counts as one, but only before a unit.
		if unit, _ := unitOf(line[len(m):]); unit != "" {
			in.Amount, rest = 1, line[len(m):]
		}
	}
	if in.Amount > 0 {
		in.Unit, rest = unitOf(rest)
		rest = ofPrefix.ReplaceAllString(rest, "")
	} else if m := toTaste.FindStringSubmatch(line); m != nil {
		in.Unit, rest = strings.ToLower(m[2]), m[1]
	}
	in.Name = strings.TrimSpace(rest)
	switch {
	case in.Name == "" && in.Unit != "":
		// "3 cloves": the unit was the ingredient.
		in.Name, in.Unit = in.Unit, ""
	case in.Name == "" || in.Amount > 100000:
		in = Ingredient{Name: line}
	}
	in.Name = clip(in.Name, 120)
	return in, true
}

// clip shortens s to at most n characters, ending it with "…" when it cuts.
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
