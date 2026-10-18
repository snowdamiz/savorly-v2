package app

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestIngredientLines(t *testing.T) {
	for _, tc := range []struct {
		line, name, unit string
		amount           float64
	}{
		{"1 1/2 cups flour", "flour", "cups", 1.5},
		{"200 g pasta", "pasta", "g", 200},
		{"200g spaghetti", "spaghetti", "g", 200},
		{"½ tsp salt", "salt", "tsp", 0.5},
		{"1½ cups (360 ml) milk", "(360 ml) milk", "cups", 1.5},
		{"1 ½ tbsp honey", "honey", "tbsp", 1.5},
		{"1 1⁄2 tablespoons olive oil", "olive oil", "tablespoons", 1.5},
		{"1-1/2 cups sugar", "sugar", "cups", 1.5},
		{"2-3 cloves garlic", "garlic", "cloves", 2},
		{"2–3 cloves garlic, minced", "garlic, minced", "cloves", 2},
		{"1 to 2 tablespoons honey", "honey", "tablespoons", 1},
		{"1/2-1 cup water", "water", "cup", 0.5},
		{"salt to taste", "salt", "to taste", 0},
		{"Salt and pepper, to taste", "Salt and pepper", "to taste", 0},
		{"Olive oil, as needed", "Olive oil", "as needed", 0},
		{"2 large eggs", "large eggs", "", 2},
		{"2 tomatoes", "tomatoes", "", 2},
		{"3 Tbsp. butter", "butter", "Tbsp", 3},
		{"1 T sugar", "sugar", "tbsp", 1},
		{"1 t vanilla", "vanilla", "tsp", 1},
		{"2 cups of water", "water", "cups", 2},
		{"a pinch of nutmeg", "nutmeg", "pinch", 1},
		{"An onion", "An onion", "", 0},
		{"0,5 l Milch", "Milch", "l", 0.5},
		{"1,000 g flour", "flour", "g", 1000},
		{"1.5kg potatoes", "potatoes", "kg", 1.5},
		{"8 fl oz cream", "cream", "fl oz", 8},
		{"3 cloves", "cloves", "", 3},
		{"1 (14 oz) can tomatoes", "(14 oz) can tomatoes", "", 1},
		{"Freshly ground black pepper", "Freshly ground black pepper", "", 0},
		{"• 1 onion, chopped", "onion, chopped", "", 1},
		{"<b>2</b> eggs &amp; a yolk", "eggs & a yolk", "", 2},
	} {
		in, ok := parseIngredient(tc.line)
		if !ok || in.Name != tc.name || in.Unit != tc.unit || math.Abs(in.Amount-tc.amount) > 1e-9 {
			t.Errorf("%q: %+v %v, want %v %q %q", tc.line, in, ok, tc.amount, tc.unit, tc.name)
		}
	}
	if _, ok := parseIngredient("  <br> "); ok {
		t.Error("a blank line is an ingredient")
	}
	long := strings.Repeat("very ", 40) + "long ingredient"
	if in, _ := parseIngredient("2 " + long); utf8.RuneCountInString(in.Name) != 120 || !strings.HasSuffix(in.Name, "…") {
		t.Errorf("long name: %q", in.Name)
	}
}

func TestDurationsYieldsAndTimers(t *testing.T) {
	for in, want := range map[string]int{
		"PT1H30M": 90, "P0DT0H45M": 45, "PT45M": 45, "pt20m": 20, "PT0.5H": 30, "P1D": 1440, "PT90S": 2, "PT1H30M0S": 90,
		"PT0S": 0, "PT": 0, "": 0, "soon": 0, "1 hour 30 minutes": 90, "20 mins": 20,
	} {
		if got := ldMinutes(in); got != want {
			t.Errorf("duration %q: %d, want %d", in, got, want)
		}
	}
	for _, tc := range []struct {
		value any
		want  float64
	}{
		{"4", 4}, {"4 servings", 4}, {"Serves 4-6", 4}, {"Makes 24 cookies", 24}, {float64(6), 6},
		{[]any{"4", "4 servings"}, 4}, {[]any{"", "2 loaves"}, 2}, {"250 kcal", 250}, {"1,200 calories", 1200},
		{"312.5 kcal", 312.5}, {"some", 0}, {nil, 0},
	} {
		if got := firstNumber(tc.value); got != tc.want {
			t.Errorf("number in %v: %v, want %v", tc.value, got, tc.want)
		}
	}
	for text, want := range map[string]int{
		"Simmer for 10 minutes, stirring.":                  600,
		"Bake 25-30 minutes until golden.":                  1500,
		"Rest for 1 hour.":                                  3600,
		"Preheat the oven to 200°C.":                        0,
		"Let it sit 30 seconds, then flip it over":          30,
		"Faire cuire 12 minutes à feu doux.":                720,
		"Bei 180 Grad 40 Minuten backen.":                   2400,
		"Cook 5 to 7 mins, then simmer for 20 more minutes": 300,
	} {
		if got := stepSeconds(text); got != want {
			t.Errorf("timer in %q: %d, want %d", text, got, want)
		}
	}
	for text, want := range map[string]string{
		"Bring a large pot of salted water to a boil.":         "Bring a large pot of salted…",
		"Preheat the oven to 200°C.":                           "Preheat the oven to 200°C",
		"In a bowl, whisk the eggs.":                           "In a bowl",
		"Mix miso, soy sauce and honey.":                       "Mix miso",
		"Roast for 12–15 minutes, until done.":                 "Roast for 12–15 minutes",
		"Season with 1.5 tsp salt and serve.":                  "Season with 1.5 tsp salt and…",
		"Whisk (gently) - then fold":                           "Whisk",
		"Serve.":                                               "Serve",
		"(Optional) Garnish with herbs and a squeeze of lime.": "(Optional) Garnish with herbs and a…",
	} {
		if got := stepTitle(text); got != want {
			t.Errorf("title of %q: %q, want %q", text, got, want)
		}
	}
}

func TestFindRecipeInJSONLD(t *testing.T) {
	for name, blocks := range map[string][]string{
		"top level":           {`{"@context":"https://schema.org","@type":"Recipe","name":"Soup"}`},
		"in a list":           {`[{"@type":"WebSite"},{"@type":"Recipe","name":"Soup"}]`},
		"in a graph":          {`{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe","NewsArticle"],"name":"Soup"}]}`},
		"as a full IRI":       {`{"@type":"http://schema.org/Recipe","name":"Soup"}`},
		"prefixed":            {`{"@type":"schema:Recipe","name":"Soup"}`},
		"as a main entity":    {`{"@type":"WebPage","mainEntity":{"@type":"Recipe","name":"Soup"}}`},
		"after a broken one":  {`{"@type":"Recipe",`, `{"@type":"Recipe","name":"Soup"}`},
		"in a comment":        {"<!-- {\"@type\":\"Recipe\",\"name\":\"Soup\"} -->"},
		"escaped as HTML":     {`{&quot;@type&quot;:&quot;Recipe&quot;,&quot;name&quot;:&quot;Soup&quot;}`},
		"with raw line break": {"{\"@type\":\"Recipe\",\"name\":\"Soup\",\"description\":\"Line one\nline two\"};"},
	} {
		ld, ok := findRecipe(blocks)
		if !ok || ldText(ld.Recipe["name"]) != "Soup" {
			t.Errorf("%s: %v %v", name, ok, ld.Recipe)
		}
	}
	for name, blocks := range map[string][]string{
		"none":        nil,
		"other types": {`{"@type":"Article","name":"Not a recipe"}`, `[{"@type":"Recipes"}]`},
		"broken":      {`{"@type":"Recipe"`},
	} {
		if _, ok := findRecipe(blocks); ok {
			t.Errorf("%s: found a recipe", name)
		}
	}
	// Yoast-style references are followed to the image they name.
	ld, _ := findRecipe([]string{`{"@graph":[{"@type":"ImageObject","@id":"https://example.com/#primaryimage","url":"https://example.com/soup.jpg"},
	 {"@type":"Recipe","name":"Soup","image":{"@id":"https://example.com/#primaryimage"}}]}`})
	if got := ld.image(ld.Recipe["image"]); got != "https://example.com/soup.jpg" {
		t.Errorf("referenced image: %q", got)
	}
	for _, v := range []any{"https://a.example/1.jpg", []any{"https://a.example/1.jpg", "https://a.example/2.jpg"},
		map[string]any{"@type": "ImageObject", "url": "https://a.example/1.jpg"}, []any{map[string]any{"contentUrl": "https://a.example/1.jpg"}}} {
		if got := ld.image(v); got != "https://a.example/1.jpg" {
			t.Errorf("image %v: %q", v, got)
		}
	}
}

// recipePage is a page with the given JSON-LD, in the shapes recipe plugins write.
func recipePage(ld string) []byte {
	return []byte(`<!doctype html><html lang="en-GB"><head><title>Lemon pasta - A food blog</title>
<meta property="og:title" content="Lemon pasta">
<meta name="description" content="Bright, quick and creamy.">
<script type="application/ld+json">` + ld + `</script></head>
<body><nav>Home Recipes About</nav><main><h1>Lemon pasta</h1><p>A story about lemons.</p></main></body></html>`)
}

const fullRecipeLD = `{"@context":"https://schema.org","@graph":[{"@type":"WebPage","@id":"https://cook.example/lemon-pasta/"},{
 "@type":"Recipe","name":"Lemon &amp; ricotta pasta","description":"<p>A bright bowl of pasta with lemon and ricotta.</p>",
 "image":["/images/lemon-pasta.jpg","https://cook.example/images/lemon-pasta-wide.jpg"],
 "recipeYield":["4","4 servings"],"prepTime":"PT10M","cookTime":"PT15M",
 "recipeCategory":"Main course","recipeCuisine":["italian","Mediterranean"],"keywords":"pasta, lemon, quick dinner",
 "nutrition":{"@type":"NutritionInformation","calories":"520 kcal"},"inLanguage":"en-US",
 "recipeIngredient":["200 g spaghetti","1 lemon","100 g ricotta","salt to taste","For the topping:","2 tbsp parmesan"],
 "recipeInstructions":[
  {"@type":"HowToSection","name":"Cook the pasta","itemListElement":[
   {"@type":"HowToStep","text":"Bring a large pot of salted water to a boil and cook the spaghetti for 10 minutes.","image":"https://cook.example/step1.jpg"},
   {"@type":"HowToStep","name":"Save some water","text":"Keep a cup of the cooking water before you drain it."}]},
  {"@type":"HowToSection","name":"Make the sauce","itemListElement":[
   {"@type":"HowToStep","text":"1. Stir the ricotta with the lemon zest and juice."},
   {"@type":"HowToStep","text":"Mix."},
   {"@type":"HowToStep","name":"Toss","text":"Toss","timeRequired":"PT2M"}]}]}]}`

func TestStructuredRecipeMapping(t *testing.T) {
	a := &App{}
	page, _ := url.Parse("https://cook.example/lemon-pasta/?utm_source=x")
	doc := readPage(recipePage(fullRecipeLD))
	ld, ok := findRecipe(doc.LD)
	if !ok {
		t.Fatal("no recipe found")
	}
	r, ok := a.structuredRecipe(ld, doc, page, sourceLink(page))
	if !ok {
		t.Fatal("not mapped")
	}
	switch {
	case r.Title != "Lemon & ricotta pasta" || r.Description != "A bright bowl of pasta with lemon and ricotta.":
		t.Errorf("text: %q %q", r.Title, r.Description)
	case r.Cuisine != "Italian" || strings.Join(r.Tags, "|") != "Main course|pasta|lemon|quick dinner|Mediterranean":
		t.Errorf("cuisine %q tags %q", r.Cuisine, r.Tags)
	case r.Minutes != 25 || r.Servings != 4 || r.Calories != 520 || r.Difficulty != "Easy" || r.Language != "en":
		t.Errorf("numbers: %d min, %d servings, %d kcal, %s, %q", r.Minutes, r.Servings, r.Calories, r.Difficulty, r.Language)
	case r.Image != "https://cook.example/images/lemon-pasta.jpg":
		t.Errorf("image resolved against the page: %q", r.Image)
	case r.SourceURL == nil || *r.SourceURL != "https://cook.example/lemon-pasta/" || r.Published || r.AIGenerated:
		t.Errorf("source %v published %v ai %v", r.SourceURL, r.Published, r.AIGenerated)
	}
	if got := len(r.Ingredients); got != 5 || r.Ingredients[3] != (Ingredient{Name: "salt", Unit: "to taste"}) || r.Ingredients[4] != (Ingredient{Name: "parmesan", Amount: 2, Unit: "tbsp"}) {
		t.Errorf("ingredients: %+v", r.Ingredients)
	}
	// Steps whose words give a time get it as an estimate for the meal timeline.
	want := []Step{
		{Title: "Cook the pasta", Text: "Bring a large pot of salted water to a boil and cook the spaghetti for 10 minutes.", Seconds: 600, Image: "https://cook.example/step1.jpg", Timing: &StepTiming{Active: 60, Wait: 540, Burners: 1, Estimated: true}},
		{Title: "Save some water", Text: "Keep a cup of the cooking water before you drain it."},
		{Title: "Make the sauce", Text: "Stir the ricotta with the lemon zest and juice. Mix. Toss", Seconds: 120, Timing: &StepTiming{Active: 120, Estimated: true}},
	}
	if len(r.Steps) != len(want) {
		t.Fatalf("steps: %+v", r.Steps)
	}
	for i := range want {
		got, timing := r.Steps[i], r.Steps[i].Timing
		got.Timing = nil
		if expected := want[i]; got != (Step{Title: expected.Title, Text: expected.Text, Seconds: expected.Seconds, Image: expected.Image}) || (timing == nil) != (expected.Timing == nil) || (timing != nil && *timing != *expected.Timing) {
			t.Errorf("step %d: %+v %+v, want %+v %+v", i, got, timing, expected, expected.Timing)
		}
	}
	if e := r.Validate(); e != nil {
		t.Fatal(e)
	}

	// In production a recipe can't show the page's own photos (allowedMedia).
	prod := &App{Config: Config{Production: true}, Media: &MediaStore{BaseURL: "https://media.savorly.example"}}
	if r, ok := prod.structuredRecipe(ld, doc, page, sourceLink(page)); !ok || r.Image != "" || r.Steps[0].Image != "" {
		t.Errorf("production kept outside photos: %v %q %q", ok, r.Image, r.Steps[0].Image)
	}
}

func TestStructuredRecipeFillsAndTrims(t *testing.T) {
	a := &App{}
	page, _ := url.Parse("https://www.cook.example/x")
	steps := make([]string, 45)
	for i := range steps {
		steps[i] = `"Stir the pot for a while, number ` + string(rune('A'+i%26)) + `."`
	}
	ld := `{"@type":"Recipe","name":"` + strings.Repeat("Long title ", 20) + `","recipeIngredient":"2 eggs\n1 cup milk",
	 "recipeInstructions":[` + strings.Join(steps, ",") + `],"recipeYield":"500","keywords":["` + strings.Repeat("x", 41) + `","fine"]}`
	doc := readPage([]byte(`<html><body><script type="application/ld+json">` + ld + `</script></body></html>`))
	found, _ := findRecipe(doc.LD)
	r, ok := a.structuredRecipe(found, doc, page, sourceLink(page))
	if !ok {
		t.Fatal("not mapped")
	}
	switch {
	case utf8.RuneCountInString(r.Title) != 120 || r.Description != "Imported from cook.example." || r.Cuisine != "Other":
		t.Errorf("filled: %q %q %q", r.Title, r.Description, r.Cuisine)
	case r.Servings != 100 || r.Minutes != 30 || r.Difficulty != "Advanced" || len(r.Steps) != 40 || len(r.Ingredients) != 2:
		t.Errorf("limits: %d servings %d min %s %d steps %d ingredients", r.Servings, r.Minutes, r.Difficulty, len(r.Steps), len(r.Ingredients))
	case !strings.Contains(r.Steps[39].Text, "number S.") || strings.Join(r.Tags, "|") != "fine":
		t.Errorf("the rest joins the last step: %q; tags %q", r.Steps[39].Text, r.Tags)
	}
	// Recipe data without ingredients or steps leaves the page to the model.
	for _, ld := range []string{`{"@type":"Recipe","name":"Soup","recipeInstructions":"Cook it all."}`, `{"@type":"Recipe","name":"Soup","recipeIngredient":["1 leek"]}`} {
		doc := readPage(recipePage(ld))
		found, _ := findRecipe(doc.LD)
		if _, ok := a.structuredRecipe(found, doc, page, ""); ok {
			t.Errorf("mapped %s", ld)
		}
	}
	// Instructions in one text, a step per line.
	doc = readPage(recipePage(`{"@type":"Recipe","name":"Soup","recipeIngredient":["1 leek"],"recipeInstructions":"<p>Chop the leek.</p><p>Simmer it 20 minutes.</p>"}`))
	found, _ = findRecipe(doc.LD)
	if r, ok := a.structuredRecipe(found, doc, page, ""); !ok || len(r.Steps) != 2 || r.Steps[1].Seconds != 1200 || r.Minutes != 20 || r.Description != "Bright, quick and creamy." {
		t.Errorf("text instructions: %v %+v", ok, r)
	}
}

func TestReadPage(t *testing.T) {
	doc := readPage([]byte(`<html lang="fr"><head><title>Tarte</title><meta name="description" content="Une tarte.">
<script>var x = "<p>hidden</p>";</script><style>p{}</style></head><body>
<nav>Menu</nav><header>Site</header>
<article><h1>Tarte aux pommes</h1><ul><li>3 pommes</li><li>1 pâte</li></ul>` + strings.Repeat("<p>Étape suivante, bien mélanger.</p>", 20) + `
<div hidden>secret</div><span aria-hidden="true">icon</span><table><tr><td>200</td><td>g</td></tr></table></article>
<footer>Copyright</footer></body></html>`))
	if doc.Lang != "fr" || doc.Title != "Tarte" || doc.Description != "Une tarte." {
		t.Errorf("head: %+v", doc)
	}
	for _, hidden := range []string{"Menu", "Site", "Copyright", "hidden", "secret", "icon", "p{}"} {
		if strings.Contains(doc.Text, hidden) {
			t.Errorf("text has %q", hidden)
		}
	}
	if !strings.HasPrefix(doc.Text, "Tarte aux pommes\n3 pommes\n1 pâte\nÉtape suivante") || !strings.Contains(doc.Text, "200 g") {
		t.Errorf("text: %.200q", doc.Text)
	}
	if excerpt := pageExcerpt(strings.Repeat("story ", 5000)+"Ingredients: 2 eggs", 1000); utf8.RuneCountInString(excerpt) != 1000 || !strings.HasSuffix(excerpt, "Ingredients: 2 eggs") {
		t.Errorf("excerpt: %.80q…", excerpt)
	}
}

func TestImportAddresses(t *testing.T) {
	for in, want := range map[string]string{
		"https://cook.example/a?b=1#c":  "https://cook.example/a?b=1",
		"http://cook.example/a":         "https://cook.example/a",
		"http://cook.example:80/a":      "https://cook.example/a",
		"cook.example/recipes/soup":     "https://cook.example/recipes/soup",
		"  https://cook.example/soup  ": "https://cook.example/soup",
	} {
		if got, ok := importURL(in); !ok || got != want {
			t.Errorf("%q: %q %v, want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "ftp://cook.example/a", "javascript:alert(1)", "https://user:pass@cook.example/a", "https://", "not a url", "mailto:cook@example.com", "https://cook.example/" + strings.Repeat("a", 2100)} {
		if got, ok := importURL(in); ok {
			t.Errorf("%q: accepted as %q", in, got)
		}
	}
	link := func(raw string) string {
		u, _ := url.Parse(raw)
		return sourceLink(u)
	}
	for in, want := range map[string]string{
		"https://cook.example/soup?utm_source=x&utm_medium=y#top": "https://cook.example/soup",
		"https://cook.example/soup?id=4&fbclid=abc":               "https://cook.example/soup?id=4",
		"https://cook.example/soup?b=2&a=1":                       "https://cook.example/soup?b=2&a=1",
		"https://cook.example/soup?q=" + strings.Repeat("x", 600): "https://cook.example/soup",
		"https://cook.example/" + strings.Repeat("x", 600):        "https://cook.example/",
	} {
		if got := link(in); got != want {
			t.Errorf("source of %.60q: %q, want %q", in, got, want)
		}
	}
}

// fetchPage, like download, opens only public HTTPS pages, before connecting.
func TestFetchPageRefusesNonPublicTargets(t *testing.T) {
	ctx := context.Background()
	for _, source := range []string{"http://example.com/", "https://user:secret@example.com/", "https://example.com:8443/", "file:///etc/passwd"} {
		if _, e := fetchPage(ctx, source); e == nil || e.Error() != "invalid page URL" {
			t.Errorf("%s: %v", source, e)
		}
	}
	for _, source := range []string{"https://127.0.0.1/", "https://localhost/", "https://[::1]/", "https://10.0.0.8/", "https://169.254.169.254/latest/meta-data/"} {
		if _, e := fetchPage(ctx, source); e == nil || !strings.Contains(e.Error(), "media host is not public") {
			t.Errorf("%s: want the public-address guard, got %v", source, e)
		}
	}
}

func TestFetchPageReadsHTMLAsUTF8(t *testing.T) {
	big := strings.Repeat("a", pageLimit+100)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/moved":
			http.Redirect(w, r, "/cp1251", http.StatusFound)
		case "/cp1251":
			w.Header().Set("Content-Type", "text/html; charset=windows-1251")
			w.Write([]byte("<p>\xcf\xe5\xeb\xfc\xec\xe5\xed\xe8</p>")) // "Пельмени"
		case "/meta":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(`<meta charset="iso-8859-1"><p>cr` + "\xe8" + `me</p>`))
		case "/sniffed":
			w.Header()["Content-Type"] = nil
			w.Write([]byte("<!doctype html><p>caf\xc3\xa9</p>"))
		case "/big":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(big))
		case "/pdf":
			w.Header().Set("Content-Type", "application/pdf")
			w.Write([]byte("%PDF-1.7"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	old := pageClient
	pageClient = server.Client()
	t.Cleanup(func() { pageClient = old })
	ctx := context.Background()
	page, e := fetchPage(ctx, server.URL+"/moved")
	if e != nil || page.URL != server.URL+"/cp1251" || !strings.Contains(string(page.HTML), "Пельмени") {
		t.Fatalf("redirected windows-1251 page: %v %q %q", e, page.URL, page.HTML)
	}
	for path, want := range map[string]string{"/meta": "crème", "/sniffed": "café"} {
		if page, e := fetchPage(ctx, server.URL+path); e != nil || !strings.Contains(string(page.HTML), want) {
			t.Errorf("%s: %v %q", path, e, page.HTML)
		}
	}
	if page, e := fetchPage(ctx, server.URL+"/big"); e != nil || len(page.HTML) != pageLimit {
		t.Errorf("big page: %v %d bytes", e, len(page.HTML))
	}
	if _, e := fetchPage(ctx, server.URL+"/pdf"); e != errNotPage {
		t.Errorf("pdf: %v", e)
	}
	if _, e := fetchPage(ctx, server.URL+"/missing"); e == nil || e == errNotPage {
		t.Errorf("missing page: %v", e)
	}
}
