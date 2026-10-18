package app

import (
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"

	"savorly/api/internal/ai"
)

func TestEquipmentLexiconLoadsCleanly(t *testing.T) {
	for _, p := range equipmentLexiconProblems {
		t.Error(p)
	}
	if len(equipmentKeys) < 35 || len(equipmentAliases) < 500 {
		t.Fatalf("lexicon looks short: %d keys, %d aliases", len(equipmentKeys), len(equipmentAliases))
	}
	for language := range equipmentInLanguage {
		if !recipeLanguages[language] {
			t.Errorf("aliases for %q, which isn't a recipe language", language)
		}
	}
}

// The app names every key in the reader's language; a key it doesn't know would show nothing.
func TestTheAppNamesEveryEquipmentKey(t *testing.T) {
	source, e := os.ReadFile("../../../../apps/mobile/src/components/Equipment.tsx")
	if os.IsNotExist(e) {
		t.Skip("the app isn't checked out beside the API")
	}
	if e != nil {
		t.Fatal(e)
	}
	for _, key := range equipmentKeys {
		if !strings.Contains(string(source), "case '"+key+"':") {
			t.Errorf("Equipment.tsx doesn't name %q", key)
		}
	}
}

func TestEquipmentInMethods(t *testing.T) {
	for _, c := range []struct {
		text, language string
		want           []string
	}{
		// Plain English, with plurals, verbs that only mean the tool, and the order of mention.
		{"Bring a large pot of salted water to a boil.", "en", []string{"pot"}},
		{"Preheat the oven to 200°C and line two baking sheets with parchment.", "en", []string{"oven", "sheet pan"}},
		{"Bake for 25 minutes, then cool in the tin.", "en", []string{"oven"}},
		{"Sift the flour, then whisk in the eggs.", "en", []string{"sieve", "whisk"}},
		{"Roll out the dough and cut out rounds.", "en", []string{"rolling pin"}},
		{"Blend until smooth with a stick blender.", "en", []string{"immersion blender"}},
		{"Pulse in a food processor, then pour into the blender.", "en", []string{"food processor", "blender"}},
		{"Knead with the dough hook of a stand mixer.", "en", []string{"stand mixer"}},
		{"Beat with an electric mixer until fluffy.", "en", []string{"hand mixer"}},
		{"Check with a meat thermometer: 74 °C.", "en", []string{"thermometer"}},
		{"Weigh everything on a kitchen scale.", "en", []string{"kitchen scale"}},
		{"Pound the spices in a mortar and pestle.", "en", []string{"mortar and pestle"}},
		{"Cook on high pressure in the Instant Pot for 8 minutes.", "en", []string{"pressure cooker"}},
		{"Air fry at 180°C for 12 minutes, shaking the basket.", "en", []string{"air fryer"}},
		{"Microwave for 30 seconds.", "en", []string{"microwave"}},
		{"Grease a 9-inch springform pan and a 12-cup muffin tin.", "en", []string{"cake pan", "muffin pan"}},
		{"Pour into a loaf pan, or a 9x13 baking dish.", "en", []string{"loaf pan", "baking dish"}},
		{"Thinly slice the fennel on a mandoline and grate the lemon zest.", "en", []string{"mandoline", "grater"}},
		{"Drain in a colander.", "en", []string{"colander"}},
		{"Steam in a bamboo steamer over a wok.", "en", []string{"steamer", "wok"}},
		// Longer phrases win: one item, or none.
		{"Brown the beef in a Dutch oven.", "en", []string{"dutch oven"}},
		{"Heat the oil in a large frying pan.", "en", []string{"frying pan"}},
		{"Use an oven-safe skillet.", "en", []string{"frying pan"}},
		{"Put the oven-proof dish in the microwave oven.", "en", []string{"baking dish", "microwave"}},
		{"Serve the pot roast with oven gloves on.", "en", nil},
		{"A no-bake cheesecake.", "en", nil},
		{"Toast on a grill pan, then finish on the grill.", "en", []string{"griddle", "grill"}},
		{"Whisk with the whisk attachment.", "en", []string{"whisk", "stand mixer"}},
		{"Cook in the slow cooker on low.", "en", []string{"slow cooker"}},
		{"Heat the pan.", "en", nil},
		// A pan the method says more about is one piece; a bare pan, or a verb that may be done by
		// hand, is left to the model's guess.
		{"Toast the pine nuts in a dry pan until fragrant.", "en", []string{"frying pan"}},
		{"Bring a large pan of salted water to the boil.", "en", []string{"saucepan"}},
		{"Pan-fry the gnocchi, then pan-sear the scallops.", "en", []string{"frying pan"}},
		{"Keep the stock warm in a second pan.", "en", nil},
		{"Grease and line the pan, then deglaze with the pan juices.", "en", nil},
		{"Blend until smooth. Drain the pasta and toast the bread.", "en", nil},
		{"Cook the linguine in salted boiling water.", "en", nil},
		// A sentence ends an alias: the oven is still an oven here.
		{"Put it in the oven. Safe travels.", "en", []string{"oven"}},
		// Words that are equipment only in their own language.
		{"Mix four eggs with the casserole.", "en", nil},
		{"Préchauffez le four à 180 °C.", "fr", []string{"oven"}},
		{"Faites revenir dans une poêle, puis passez au mixeur plongeant.", "fr", []string{"frying pan", "immersion blender"}},
		{"Versez dans une casserole et râpez le fromage avec une râpe.", "fr", []string{"saucepan", "grater"}},
		{"Enfournez la cocotte.", "fr", []string{"oven", "dutch oven"}},
		{"Faites cuire à la cocotte-minute.", "fr", []string{"pressure cooker"}},
		{"Ajoutez un pot de yaourt.", "fr", nil},
		{"Fouettez au batteur électrique, puis versez dans un moule à cake.", "fr", []string{"hand mixer", "loaf pan"}},
		{"Faites chauffer au four à micro-ondes.", "fr", []string{"microwave"}},
		{"Den Backofen auf 180 °C Ober- und Unterhitze vorheizen.", "de", []string{"oven"}},
		{"In einer Pfanne anbraten, dann in die Auflaufform geben.", "de", []string{"frying pan", "baking dish"}},
		{"Die Ofenform ist keine Form für den Ofen.", "de", []string{"baking dish", "oven"}},
		{"Mit dem Stabmixer pürieren, dann im Mixer fein mixen.", "de", []string{"immersion blender", "blender"}},
		{"Den Teig mit der Küchenmaschine kneten und ausrollen.", "de", []string{"stand mixer", "rolling pin"}},
		{"In der Gusseisenpfanne braten und durch ein Sieb streichen.", "de", []string{"frying pan", "sieve"}},
		{"Mit dem Handmixer aufschlagen.", "de", []string{"hand mixer"}},
		{"Die Gräte entfernen.", "de", nil},
		{"Calienta el aceite en una sartén y hornea en el horno.", "es", []string{"frying pan", "oven"}},
		{"Bate con unas varillas y pasa por un colador.", "es", []string{"whisk", "sieve"}},
		{"Cocina en la olla a presión.", "es", []string{"pressure cooker"}},
		{"Tritura con la licuadora y cuela en el escurridor.", "es", []string{"blender", "colander"}},
		{"Añade la panela rallada.", "es", nil},
		{"Cuoci in padella e poi inforna nella pirofila.", "it", []string{"frying pan", "oven", "baking dish"}},
		{"Monta con le fruste elettriche e stendi col mattarello.", "it", []string{"hand mixer", "rolling pin"}},
		{"Fodera la teglia con carta forno.", "it", []string{"baking dish"}},
		{"Aqueça a frigideira e leve ao forno em uma assadeira.", "pt", []string{"frying pan", "oven", "baking dish"}},
		{"Bata no liquidificador e cozinhe na panela de pressão.", "pt", []string{"blender", "pressure cooker"}},
		{"Use o mixer para bater a sopa na panela.", "pt", []string{"immersion blender", "pot"}},
		{"Разогрейте духовку. Обжарьте на сковороде.", "ru", []string{"oven", "frying pan"}},
		{"Взбейте миксером, натрите сыр на тёрке.", "ru", []string{"hand mixer", "grater"}},
		{"Готовьте в мультиварке или в кастрюле.", "ru", []string{"slow cooker", "pot"}},
		{"Измельчите погружным блендером.", "ru", []string{"immersion blender"}},
		{"把烤箱预热到180度，用平底锅煎一下。", "zh", []string{"oven", "frying pan"}},
		{"用电动打蛋器打发，放入空气炸锅。", "zh", []string{"hand mixer", "air fryer"}},
		{"フライパンに油を熱し、オーブンで焼く。", "ja", []string{"frying pan", "oven"}},
		{"電子レンジで温め、ハンドミキサーで泡立てる。", "ja", []string{"microwave", "hand mixer"}},
		{"オレンジをアレンジして、よく混ざるまで混ぜる。", "ja", nil},
		{"鍋に湯を沸かし、ザルにあげる。", "ja", []string{"pot", "colander"}},
		// A recipe that doesn't say its language reads English.
		{"Beat with a mixer, then bake.", "", []string{"hand mixer", "oven"}},
	} {
		got := detectEquipment([]Step{{Text: c.text}}, c.language)
		if !slices.Equal(got, c.want) {
			t.Errorf("%q (%s): %q, want %q", c.text, c.language, got, c.want)
		}
	}
}

func TestDetectEquipment(t *testing.T) {
	steps := []Step{
		{Title: "Boil", Text: "Bring a pot of water to a boil and cook the pasta."},
		{Title: "Drain", Text: "Drain the pasta in a colander, then return it to the pot."},
		{Title: "In the oven", Text: "Spread on a baking sheet and bake for 10 minutes."},
	}
	if got := detectEquipment(steps, "en"); !slices.Equal(got, []string{"pot", "colander", "oven", "sheet pan"}) {
		t.Fatalf("detected %q", got)
	}
	if got := detectEquipment([]Step{{Title: "Mix", Text: "Stir everything together."}}, "en"); got == nil || len(got) != 0 {
		t.Fatalf("nothing should be [], got %#v", got)
	}
	// Never more than a recipe lists.
	var many []Step
	for range 5 {
		many = append(many, Step{Title: "All of it", Text: strings.Join(equipmentKeys, ", ")})
	}
	if got := detectEquipment(many, "en"); len(got) != maxEquipment {
		t.Fatalf("detected %d", len(got))
	}
}

func TestFitEquipment(t *testing.T) {
	if fitEquipment(nil) != nil {
		t.Fatal("nil should stay nil")
	}
	long := strings.Repeat("x", 61)
	got := fitEquipment([]string{" Large pot ", "large pot", "", long, "Blender"})
	if !slices.Equal(got, []string{"Large pot", "Blender"}) {
		t.Fatalf("fitted %q", got)
	}
	var names []string
	for i := range 25 {
		names = append(names, "Tool "+string(rune('A'+i)))
	}
	if got := fitEquipment(names); len(got) != maxEquipment || got[19] != "Tool T" {
		t.Fatalf("fitted %d: %q", len(got), got)
	}
}

func TestRecipeEquipmentValidation(t *testing.T) {
	r := validRecipe()
	r.Equipment = []string{"  Large pot ", "", "large POT", "Blender"}
	if e := r.Validate(); e != nil || !slices.Equal(r.Equipment, []string{"Large pot", "Blender"}) {
		t.Fatalf("cleaned %q: %v", r.Equipment, e)
	}
	r.Equipment = []string{strings.Repeat("é", 61)}
	if e := r.Validate(); e == nil || !strings.Contains(e.Error(), "60 characters") {
		t.Fatalf("a long name: %v", e)
	}
	r.Equipment = nil
	for i := range 21 {
		r.Equipment = append(r.Equipment, "Tool "+string(rune('A'+i)))
	}
	if e := r.Validate(); e == nil || !strings.Contains(e.Error(), "up to 20") {
		t.Fatalf("21 pieces: %v", e)
	}
	// Left out, it stays nil (keep what is saved); [] clears.
	r.Equipment = nil
	if e := r.Validate(); e != nil || r.Equipment != nil {
		t.Fatalf("nil: %v %v", r.Equipment, e)
	}
	r.Equipment = []string{" "}
	if e := r.Validate(); e != nil || r.Equipment == nil || len(r.Equipment) != 0 {
		t.Fatalf("blank: %#v %v", r.Equipment, e)
	}
}

// schema.org gives a Recipe the tool of a HowTo: HowToTool items or names, or one text.
func TestStructuredImportReadsTools(t *testing.T) {
	a := &App{}
	page, _ := url.Parse("https://cook.example/soup")
	for _, c := range []struct {
		tool string
		want []string
	}{
		{`[{"@type":"HowToTool","name":"Large pot"},{"@type":"HowToTool","name":"Immersion blender","requiredQuantity":1},"Ladle","large pot"]`, []string{"Large pot", "Immersion blender", "Ladle"}},
		{`{"@type":"HowToTool","name":"Dutch oven"}`, []string{"Dutch oven"}},
		{`"Large pot, blender\nLadle"`, []string{"Large pot", "blender", "Ladle"}},
		{`[{"@type":"HowToTool","name":"` + strings.Repeat("x", 61) + `"},"Pot"]`, []string{"Pot"}},
		{`null`, []string{}},
	} {
		ld := `{"@type":"Recipe","name":"Soup","recipeIngredient":["1 leek"],"recipeInstructions":"Simmer the leek in a pot.","tool":` + c.tool + `}`
		doc := readPage(recipePage(ld))
		found, _ := findRecipe(doc.LD)
		r, ok := a.structuredRecipe(found, doc, page, sourceLink(page))
		if !ok || r.Equipment == nil || !slices.Equal(r.Equipment, c.want) {
			t.Errorf("tool %s: %v %q", c.tool, ok, r.Equipment)
		}
	}
	var many []string
	for i := range 25 {
		many = append(many, `"Tool `+string(rune('A'+i))+`"`)
	}
	doc := readPage(recipePage(`{"@type":"Recipe","name":"Soup","recipeIngredient":["1 leek"],"recipeInstructions":"Simmer it.","tool":[` + strings.Join(many, ",") + `]}`))
	found, _ := findRecipe(doc.LD)
	if r, ok := a.structuredRecipe(found, doc, page, sourceLink(page)); !ok || len(r.Equipment) != maxEquipment {
		t.Fatalf("25 tools: %v %d", ok, len(r.Equipment))
	}
}

// A hands-free question's recipe brief names the equipment within the budget it always had.
func TestCookQuestionsWithEquipmentStayBounded(t *testing.T) {
	long := strings.Repeat("🍝", 3000)
	r := &sceneRecipe{title: long, author: long, servings: 4, minutes: 30}
	for range 100 {
		r.ingredients = append(r.ingredients, Ingredient{Name: long, Amount: 1.5, Unit: long})
		r.steps = append(r.steps, Step{Title: long, Text: long, Seconds: 90})
	}
	for range maxEquipment {
		r.equipment = append(r.equipment, strings.Repeat("🍝", equipmentNameLength))
	}
	q := ai.CookQuestion{Recipe: r.text(), Step: cookStep(r, 50), Question: strings.Repeat("🍝", 300), Language: "Japanese"}
	if !strings.Contains(q.Recipe, "Equipment the cook lists: 🍝") || q.Bytes() > ai.CookQuestionMaxPromptBytes {
		t.Fatalf("%d bytes:\n%.400s", q.Bytes(), q.Recipe)
	}
	r.equipment, r.detected = nil, []string{"pot", "colander"}
	if text := r.text(); !strings.Contains(text, "Equipment the method mentions: pot; colander.") {
		t.Fatalf("detected:\n%.400s", text)
	}
}
