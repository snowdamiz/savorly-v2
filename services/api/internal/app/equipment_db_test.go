package app

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

// equipmentOf is a recipe's equipment as GET /recipes/:id answers it.
type recipeEquipment struct {
	Equipment         []string `json:"equipment"`
	EquipmentDetected []string `json:"equipmentDetected"`
}

func equipmentOf(t *testing.T, b []byte) recipeEquipment {
	t.Helper()
	var r recipeEquipment
	if e := json.Unmarshal(b, &r); e != nil {
		t.Fatalf("%v: %s", e, b)
	}
	return r
}

// withEquipment is a recipe write as JSON, with equipment sent as given ([] included), or left out
// as older apps leave it when equipment is nil.
func withEquipment(r RecipeInput, equipment []string) map[string]any {
	body := map[string]any{}
	_ = json.Unmarshal(jsonBytes(r), &body)
	delete(body, "equipment")
	if equipment != nil {
		body["equipment"] = equipment
	}
	return body
}

func TestRecipeEquipmentIsKeptLikePhotos(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	token := bearerFor(t, db, "cook")
	in := validRecipe()
	in.Steps = []Step{
		{Title: "Boil", Text: "Bring a large pot of salted water to a boil and cook the pasta."},
		{Title: "Drain", Text: "Drain it in a colander."},
	}
	// Saved as the author writes it, trimmed, without blanks or repeats, and the method read too.
	r := equipmentOf(t, mustCall(t, f, 201, "POST", "/v1/recipes", token, withEquipment(in, []string{" Large pot ", "", "large pot", "Colander"})))
	if !slices.Equal(r.Equipment, []string{"Large pot", "Colander"}) || !slices.Equal(r.EquipmentDetected, []string{"pot", "colander"}) {
		t.Fatalf("created: %+v", r)
	}
	var id string
	if e := db.QueryRow(context.Background(), `SELECT id FROM recipes WHERE author_id='cook'`).Scan(&id); e != nil {
		t.Fatal(e)
	}
	// An app that doesn't know equipment keeps the list, and a changed method is read again in the
	// same save.
	in.Steps = append(in.Steps, Step{Title: "Finish", Text: "Toss in a frying pan and bake for 5 minutes."})
	r = equipmentOf(t, mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, token, withEquipment(in, nil)))
	if !slices.Equal(r.Equipment, []string{"Large pot", "Colander"}) || !slices.Equal(r.EquipmentDetected, []string{"pot", "colander", "frying pan", "oven"}) {
		t.Fatalf("kept: %+v", r)
	}
	r = equipmentOf(t, mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, token, withEquipment(in, []string{"Skillet", "Colander"})))
	if !slices.Equal(r.Equipment, []string{"Skillet", "Colander"}) {
		t.Fatalf("changed: %+v", r)
	}
	// [] clears it; what the method mentions stays.
	r = equipmentOf(t, mustCall(t, f, 200, "PUT", "/v1/recipes/"+id, token, withEquipment(in, []string{})))
	if r.Equipment == nil || len(r.Equipment) != 0 || len(r.EquipmentDetected) != 4 {
		t.Fatalf("cleared: %+v", r)
	}
	r = equipmentOf(t, mustCall(t, f, 200, "GET", "/v1/recipes/"+id, token, nil))
	if len(r.Equipment) != 0 || !slices.Equal(r.EquipmentDetected, []string{"pot", "colander", "frying pan", "oven"}) {
		t.Fatalf("read back: %+v", r)
	}
	many := make([]string, 21)
	for i := range many {
		many[i] = "Tool " + string(rune('A'+i))
	}
	for _, c := range []struct {
		equipment []string
		message   string
	}{{many, "List up to 20 pieces of equipment."}, {[]string{strings.Repeat("x", 61)}, "Name each piece of equipment in 60 characters or fewer."}} {
		status, b := callAPI(t, f, "PUT", "/v1/recipes/"+id, token, withEquipment(in, c.equipment))
		if status != 400 || !strings.Contains(string(b), c.message) {
			t.Errorf("%d %s", status, b)
		}
	}
	// A recipe made without a list has an empty one, never null.
	r = equipmentOf(t, mustCall(t, f, 201, "POST", "/v1/recipes", token, withEquipment(validRecipe(), nil)))
	if r.Equipment == nil || len(r.Equipment) != 0 || r.EquipmentDetected == nil {
		t.Fatalf("without a list: %+v", r)
	}
}

func TestIndexEquipmentCatchesUp(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	publishRecipe(t, db, "cook", "soup", nil)
	publishRecipe(t, db, "cook", "stale", func(r *RecipeInput) {
		r.Steps = []Step{{Title: "Blend", Text: "Blend it in a blender."}}
	})
	// A write that doesn't read the method (another server version, the seed, a hand edit), a
	// recipe from before equipment existed, and one read under an older lexicon.
	_, e := db.Exec(ctx, `UPDATE recipes SET steps='[{"title":"Simmer","text":"Simmer it in a Dutch oven.","seconds":0}]' WHERE id='soup';
 INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,language) VALUES('old','cook','Vieille soupe','Une soupe d’avant.','French',5,1,'Easy','[{"name":"Poireaux","amount":1,"unit":"","category":""}]','[{"title":"Cuire","text":"Cuire dans une casserole, puis mixer au mixeur plongeant."}]','fr');
 UPDATE recipes SET equipment_version=0 WHERE id='stale'`)
	if e != nil {
		t.Fatal(e)
	}
	n, e := indexEquipment(ctx, db)
	if e != nil {
		t.Fatal(e)
	}
	if n != 3 {
		t.Fatalf("read %d recipes, want 3", n)
	}
	detected := map[string][]string{}
	rows, e := db.Query(ctx, `SELECT id,equipment_detected FROM recipes`)
	if e != nil {
		t.Fatal(e)
	}
	for rows.Next() {
		var id string
		var keys []string
		if e = rows.Scan(&id, &keys); e != nil {
			t.Fatal(e)
		}
		detected[id] = keys
	}
	if !slices.Equal(detected["soup"], []string{"dutch oven"}) || !slices.Equal(detected["old"], []string{"saucepan", "immersion blender"}) || !slices.Equal(detected["stale"], []string{"blender"}) {
		t.Fatalf("detected %v", detected)
	}
	if n, e = indexEquipment(ctx, db); e != nil || n != 0 {
		t.Fatalf("second pass read %d: %v", n, e)
	}
}

func TestMethodEquipmentForTheEditor(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	token := bearerFor(t, db, "cook")
	body := fiber.Map{"language": "fr", "steps": []fiber.Map{{"title": "Four", "text": "Préchauffez le four."}, {"title": "Cuisson", "text": "Faites revenir dans une poêle, puis dans la poêle encore."}}}
	var out struct{ Equipment []string }
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/recipes/equipment", token, body), &out); e != nil || !slices.Equal(out.Equipment, []string{"oven", "frying pan"}) {
		t.Fatalf("detected %v %v", out.Equipment, e)
	}
	// Read as English, "four" is a number: only the pan is left. Nothing found is [].
	body["language"] = "en"
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/recipes/equipment", token, body), &out); e != nil || !slices.Equal(out.Equipment, []string{"frying pan"}) {
		t.Fatalf("in English %v %v", out.Equipment, e)
	}
	none := fiber.Map{"language": "", "steps": []fiber.Map{{"title": "Mix", "text": "Stir it all together."}}}
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/recipes/equipment", token, none), &out); e != nil || out.Equipment == nil || len(out.Equipment) != 0 {
		t.Fatalf("nothing: %v %v", out.Equipment, e)
	}
	mustCall(t, f, 401, "POST", "/v1/recipes/equipment", "", body)
	mustCall(t, f, 400, "POST", "/v1/recipes/equipment", token, fiber.Map{"language": "tlh", "steps": []fiber.Map{}})
	mustCall(t, f, 400, "POST", "/v1/recipes/equipment", token, fiber.Map{"steps": make([]fiber.Map, 41)})
	var saved int
	if e := db.QueryRow(context.Background(), `SELECT count(*) FROM recipes`).Scan(&saved); e != nil || saved != 0 {
		t.Fatalf("%d recipes saved: %v", saved, e)
	}
}

func TestEquipmentIsTranslatedWithTheRecipe(t *testing.T) {
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "5")
	t.Setenv("AI_DAILY_BUDGET_USD", "25")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "reader")
	frenchSoup(t, db, "cook", "soup", true)
	provider := newTranslator(t)
	_, f := translationServer(db, provider)
	reader := bearerFor(t, db, "reader")
	type translated struct {
		Equipment []string `json:"equipment"`
		Steps     []struct{ Text string }
	}
	read := func() translated {
		t.Helper()
		var out translated
		if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recipes/soup/translation?language=en", reader, nil), &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	// A recipe without a list translates as before, and its translation has none.
	if out := read(); out.Equipment != nil || provider.calls.Load() != 1 {
		t.Fatalf("without equipment: %+v, %d calls", out, provider.calls.Load())
	}
	// Listing equipment changes what is translated: the names are translated with the rest, one
	// for one.
	if _, e := db.Exec(ctx, `UPDATE recipes SET equipment='{Grande casserole,Mixeur plongeant}' WHERE id='soup'`); e != nil {
		t.Fatal(e)
	}
	out := read()
	if provider.calls.Load() != 2 || !slices.Equal(out.Equipment, []string{"[English] Grande casserole", "[English] Mixeur plongeant"}) || !strings.HasPrefix(out.Steps[0].Text, "[English] ") {
		t.Fatalf("with equipment: %+v, %d calls", out, provider.calls.Load())
	}
	// Read in its own language, it is the cook's list.
	var own translated
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recipes/soup/translation?language=fr", reader, nil), &own); e != nil || !slices.Equal(own.Equipment, []string{"Grande casserole", "Mixeur plongeant"}) {
		t.Fatalf("in French: %+v %v", own, e)
	}
}

// The sous-chef reads a recipe's equipment ("what pans do I need?") and changes the list as it
// changes others: the whole list when it means to, and what it leaves out stays.
func TestTheSousChefReadsAndEditsEquipment(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	mine := exampleVoiceRecipe()
	mine.AIGenerated = false
	mine.Equipment = []string{"Toaster"}
	mine.Steps = []Step{{Title: "Toast", Text: "Toast the bread in a dry frying pan until golden."}}
	if e := persistRecipe(ctx, a.DB, "cook", "mine", mine, false); e != nil {
		t.Fatal(e)
	}
	out := a.agentTool(ctx, agentTurn(t, a, p), "get_recipe", jsonBytes(map[string]any{"recipe_id": "mine"}))
	if !strings.Contains(out, `"equipment":["Toaster"]`) || !strings.Contains(out, `"equipmentDetected":["frying pan"]`) {
		t.Fatalf("get_recipe: %s", out)
	}
	out = a.agentTool(ctx, agentTurn(t, a, p), "edit_recipe", jsonBytes(map[string]any{"recipe_id": "mine", "changes": map[string]any{"equipment": []string{"Frying pan", "Butter knife"}}}))
	if !strings.Contains(out, "Saved") || !strings.Contains(out, "equipment") {
		t.Fatalf("edit_recipe: %s", out)
	}
	// An edit of something else, with the list sent empty as models do, keeps it.
	out = a.agentTool(ctx, agentTurn(t, a, p), "edit_recipe", jsonBytes(map[string]any{"recipe_id": "mine", "changes": map[string]any{"servings": 4, "equipment": []string{}}}))
	if !strings.Contains(out, "servings 2 → 4") || strings.Contains(out, "equipment") {
		t.Fatalf("second edit_recipe: %s", out)
	}
	if r, e := a.ownRecipe(ctx, "cook", "mine"); e != nil || !slices.Equal(r.Equipment, []string{"Frying pan", "Butter knife"}) {
		t.Fatalf("after the edits: %q %v", r.Equipment, e)
	}
}

func TestCookingQuestionsSeeTheEquipment(t *testing.T) {
	t.Setenv("PAID_PLANS", "")
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := cookKitchen(t)
	ctx := context.Background()
	if _, e := db.Exec(ctx, `UPDATE recipes SET equipment='{Large pot,Colander}' WHERE id='pasta'; UPDATE recipes SET equipment_detected='{pot}' WHERE id='draft'`); e != nil {
		t.Fatal(e)
	}
	chef := &fakeChef{cost: 0.0003}
	f := cookServer(db, chef.server(t).URL)
	if status, _ := askChef(t, f, "guest", "pasta", fiber.Map{"question": "What pans do I need?"}); status != 200 {
		t.Fatal(status)
	}
	if prompt := chef.lastPrompt(); !strings.Contains(prompt, "Equipment the cook lists: Large pot; Colander.") {
		t.Fatalf("the cook's list is missing:\n%s", prompt)
	}
	if status, _ := askChef(t, f, "owner", "draft", fiber.Map{"question": "What pans do I need?"}); status != 200 {
		t.Fatal(status)
	}
	if prompt := chef.lastPrompt(); !strings.Contains(prompt, "Equipment the method mentions: pot.") {
		t.Fatalf("what the method mentions is missing:\n%s", prompt)
	}
}

func TestExportCarriesEquipment(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	id := member(t, db, "cook@example.test")
	tok := deviceSession(t, db, id, phoneUA, 24*time.Hour)
	recipe := testRecipe(t, db, id, "Pasta with a list", false)
	if _, e := db.Exec(context.Background(), `UPDATE recipes SET equipment='{Large pot,Colander}' WHERE id=$1`, recipe); e != nil {
		t.Fatal(e)
	}
	var doc struct{ Recipes []recipeEquipment }
	if e := json.Unmarshal(must(t, f, 200, call{method: "GET", path: "/v1/me/export", bearer: tok}).body, &doc); e != nil {
		t.Fatal(e)
	}
	if len(doc.Recipes) != 1 || !slices.Equal(doc.Recipes[0].Equipment, []string{"Large pot", "Colander"}) {
		t.Fatalf("exported %+v", doc.Recipes)
	}
}
