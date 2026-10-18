package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

// familyModels stands in for speech-to-text and the agent model: transcription answers heard,
// and each write-down answers written(). It counts the requests each gets.
type familyModels struct {
	mu                    sync.Mutex
	heard, written        string
	transcribed, writings int
	lastWriting           map[string]any
	url                   string
}

func newFamilyModels(t *testing.T) *familyModels {
	t.Helper()
	m := &familyModels{}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		m.mu.Lock()
		defer m.mu.Unlock()
		switch r.URL.Path {
		case "/audio/transcriptions":
			m.transcribed++
			_, _ = w.Write([]byte(m.heard))
		case "/chat/completions":
			m.writings++
			m.lastWriting = body
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": m.written}}}, "usage": map[string]any{"cost": 0.002}})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(s.Close)
	m.url = s.URL
	return m
}

// worker is an API worker whose providers are m.
func (m *familyModels) worker(db *pgxpool.Pool) *App {
	a := &App{DB: db, Media: NewMediaStore(), AI: ai.New()}
	a.AI.OpenRouterURL, a.AI.OpenRouterKey = m.url, "test-key"
	return a
}

func (m *familyModels) counts() (int, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.transcribed, m.writings
}

// m4a is a recording as the app keeps one: AAC in an MP4 container.
func m4a() []byte {
	return append([]byte("\x00\x00\x00\x1cftypM4A \x00\x00\x00\x00M4A isommp42"), bytes.Repeat([]byte{0}, 4000)...)
}

// uploadDirect sends data through the direct-upload path, as the app does, and answers its URL.
func uploadDirect(t *testing.T, f *fiber.App, tok, kind, mime string, data []byte) string {
	t.Helper()
	var p presigned
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/media/uploads", tok, fiber.Map{"kind": kind, "contentType": mime, "size": len(data)}), &p); e != nil {
		t.Fatal(e)
	}
	if res := putSigned(t, p, data, ""); res.StatusCode != 200 {
		t.Fatalf("upload: %d", res.StatusCode)
	}
	var done struct{ URL string }
	if e := json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/media/uploads/complete", tok, fiber.Map{"key": p.Key}), &done); e != nil || done.URL != p.URL {
		t.Fatalf("complete: %+v %v", done, e)
	}
	return done.URL
}

// runJob runs a queued job (from its JSON) on worker a.
func runJob(t *testing.T, a *App, owner string, job map[string]any) {
	t.Helper()
	id, _ := job["id"].(string)
	prompt, _ := job["prompt"].(string)
	source, _ := job["source"].(string)
	if id == "" {
		t.Fatalf("no job: %v", job)
	}
	a.processJob(context.Background(), id, owner, "recipe", prompt, source)
}

const nonnaHeard = `{"text":"Allora, salt the water well. Then the pasta goes in for nine minutes, stirring.","language":"italian","duration":12.5,
 "segments":[{"start":0,"end":4.2,"text":" Allora, salt the water well."},{"start":4.6,"end":8,"text":"Then the pasta goes in"},{"start":8,"end":12.5,"text":"for nine minutes, stirring."}],
 "usage":{"seconds":12.5,"cost":0.0004}}`

// nonnaWritten is the recipe the agent model writes down from nonnaHeard: two steps said in the
// recording, and one it had to add.
func nonnaWritten() string {
	return string(jsonBytes(map[string]any{"recipe": map[string]any{
		"title": "Nonna Rosa's pasta", "description": "Pasta the way Nonna Rosa makes it; the salt is estimated.", "cuisine": "Italian",
		"minutes": 20, "servings": 4, "difficulty": "Easy", "image": "https://cook.example/invented.jpg", "video": "", "tags": []string{}, "calories": 420,
		"ingredients": []any{map[string]any{"name": "Spaghetti", "amount": 400, "unit": "g", "category": "Pasta"}},
		"steps": []any{
			map[string]any{"title": "Salt the water", "text": "Salt the water well.", "seconds": 0, "segments": []int{0, 0}},
			map[string]any{"title": "Cook the pasta", "text": "Cook the pasta for nine minutes, stirring.", "seconds": 540, "segments": []int{1, 2}},
			map[string]any{"title": "Serve", "text": "Serve it hot.", "seconds": 0, "segments": []int{}},
		},
		"equipment": []string{"Large pot"}, "aiGenerated": true, "published": false,
	}}))
}

type familyRecipe struct {
	ID, Image, Language string
	Published           bool
	Steps               []struct {
		Title, Text string
		Voice       *StepVoice
	}
	Recordings []struct {
		ID, Speaker, URL string
		DurationMs       int
		Consented        bool
	}
}

func recipeOf(t *testing.T, f *fiber.App, tok, id string) familyRecipe {
	t.Helper()
	var r familyRecipe
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recipes/"+id, tok, nil), &r); e != nil {
		t.Fatal(e)
	}
	return r
}

// A relative's recording, uploaded like any other media, is kept twice and written down into a
// private recipe whose steps point at the stretches of it that say them. Edits keep those clips,
// publishing waits on the recorded person's agreement, writing it down again doesn't transcribe it
// again, the export lists it, and deleting it removes both copies.
func TestFamilyRecordingsBecomeRecipes(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "test-only-never-sent")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "other")
	f := recipesApp(db, false)
	cook, other := bearerFor(t, db, "cook"), bearerFor(t, db, "other")
	models := newFamilyModels(t)
	models.heard, models.written = nonnaHeard, nonnaWritten()
	worker := models.worker(db)

	// Recordings are uploads of their own kind, refused as recordings.
	for _, bad := range []fiber.Map{
		{"kind": "audio", "contentType": "video/mp4", "size": 100},
		{"kind": "audio", "contentType": "audio/mp4", "size": maxRecordingBytes + 1},
	} {
		if status, b := callAPI(t, f, "POST", "/v1/media/uploads", cook, bad); status != 400 {
			t.Fatalf("%v: %d %s", bad, status, b)
		}
	}
	// A file labelled as a recording that isn't one is refused and removed.
	var disguised presigned
	_ = json.Unmarshal(mustCall(t, f, 200, "POST", "/v1/media/uploads", cook, fiber.Map{"kind": "audio", "contentType": "audio/webm", "size": len(m4a())}), &disguised)
	putSigned(t, disguised, m4a(), "")
	if status, b := callAPI(t, f, "POST", "/v1/media/uploads/complete", cook, fiber.Map{"key": disguised.Key}); status != 400 || jsonObject(t, b)["error"] != wrongRecording {
		t.Fatalf("disguised recording: %d %s", status, b)
	}
	url := uploadDirect(t, f, cook, "audio", "audio/mp4", m4a())
	if !strings.HasSuffix(url, ".m4a") {
		t.Fatalf("recording upload %s", url)
	}
	for _, bad := range []struct {
		tok  string
		body fiber.Map
	}{
		{cook, fiber.Map{"url": url, "speaker": " "}},
		{cook, fiber.Map{"url": url, "speaker": "Nonna", "durationMs": 1000}},
		{cook, fiber.Map{"url": "https://cook.example/a.m4a", "speaker": "Nonna"}},
		{other, fiber.Map{"url": url, "speaker": "Nonna"}},
	} {
		if status, b := callAPI(t, f, "POST", "/v1/recordings", bad.tok, bad.body); status != 400 {
			t.Fatalf("%v: %d %s", bad.body, status, b)
		}
	}
	made := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/recordings", cook, fiber.Map{"url": url, "speaker": " Nonna \n Rosa ", "durationMs": 12000}))
	recording, _ := made["recording"].(map[string]any)
	job, _ := made["job"].(map[string]any)
	id, _ := recording["id"].(string)
	if recording["speaker"] != "Nonna Rosa" || recording["url"] != url || job["status"] != "queued" || job["kind"] != "recipe" ||
		!strings.HasPrefix(job["prompt"].(string), "Write down the recipe Nonna Rosa tells in a recording.") {
		t.Fatalf("recording: %v", made)
	}
	// Kept twice: the copy the app plays, and a private one.
	public, _ := storage.object("media/" + strings.TrimPrefix(url, "https://media.example.com/"))
	private, ok := storage.object("sources/recordings/cook/" + id + ".m4a")
	if !ok || !bytes.Equal(private.data, public.data) || private.mime != "audio/mp4" {
		t.Fatalf("private copy: %v %+v", ok, private.mime)
	}
	// An app retrying a lost answer gets the same recording.
	if again := jsonObject(t, mustCall(t, f, 200, "POST", "/v1/recordings", cook, fiber.Map{"url": url, "speaker": "Nonna Rosa", "durationMs": 12000})); again["recording"].(map[string]any)["id"] != id {
		t.Fatalf("retried: %v", again)
	}

	runJob(t, worker, "cook", job)
	done := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs/"+job["id"].(string), cook, nil))
	recipeID, _ := done["result"].(map[string]any)["recipeId"].(string)
	if done["status"] != "completed" || recipeID == "" {
		t.Fatalf("job: %v", done)
	}
	var settled float64
	if e := db.QueryRow(ctx, `SELECT estimated_cost::float8 FROM ai_jobs WHERE id=$1`, job["id"]).Scan(&settled); e != nil || settled < 0.0023 || settled > 0.0025 {
		t.Fatalf("settled at %v (%v)", settled, e)
	}
	written := models.lastWriting["messages"].([]any)[1].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(written, `"speaker":"Nonna Rosa"`) || !strings.Contains(written, `{"n":2,"text":"for nine minutes, stirring."}`) {
		t.Fatalf("written down from %s", written)
	}
	r := recipeOf(t, f, cook, recipeID)
	salt, cookPasta := &StepVoice{id, 0, 4500}, &StepVoice{id, 4300, 12500}
	if r.Published || r.Image != "" || r.Language != "it" || len(r.Steps) != 3 || *r.Steps[0].Voice != *salt || *r.Steps[1].Voice != *cookPasta || r.Steps[2].Voice != nil ||
		len(r.Recordings) != 1 || r.Recordings[0].Speaker != "Nonna Rosa" || r.Recordings[0].DurationMs != 12500 || r.Recordings[0].Consented {
		t.Fatalf("family recipe: %+v", r)
	}
	if status, _ := callAPI(t, f, "GET", "/v1/recipes/"+recipeID, other, nil); status != 404 {
		t.Fatalf("someone else opened a private family recipe: %d", status)
	}
	var listed []map[string]any
	_ = json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recordings", cook, nil), &listed)
	if len(listed) != 1 || listed[0]["recipe"].(map[string]any)["id"] != recipeID || listed[0]["job"].(map[string]any)["status"] != "completed" {
		t.Fatalf("recordings: %v", listed)
	}

	// An app that doesn't know voices keeps them; a step that names another recording, or none,
	// loses its clip.
	edit := func(steps []fiber.Map, published bool) (int, []byte) {
		in := validRecipe()
		body := jsonObject(t, jsonBytes(in))
		body["steps"], body["published"] = steps, published
		return callAPI(t, f, "PUT", "/v1/recipes/"+recipeID, cook, body)
	}
	steps := []fiber.Map{
		{"title": "Salt the water", "text": "Salt the water well.", "seconds": 0},
		{"title": "Cook the pasta", "text": "Cook it for nine minutes, stirring now and then.", "seconds": 540},
		{"title": "Serve", "text": "Serve it hot.", "seconds": 0, "voice": fiber.Map{"recording": uuid.NewString(), "startMs": 0, "endMs": 5000}},
	}
	if status, b := edit(steps, false); status != 200 {
		t.Fatalf("edit: %d %s", status, b)
	}
	if r = recipeOf(t, f, cook, recipeID); r.Steps[0].Voice == nil || *r.Steps[0].Voice != *salt || r.Steps[1].Voice == nil || *r.Steps[1].Voice != *cookPasta || r.Steps[2].Voice != nil {
		t.Fatalf("voices after an edit: %+v", r.Steps)
	}
	steps[0]["voice"], steps[1]["voice"] = nil, fiber.Map{"recording": id, "startMs": 4000, "endMs": 99000}
	if status, b := edit(steps, false); status != 200 {
		t.Fatalf("edit: %d %s", status, b)
	}
	if r = recipeOf(t, f, cook, recipeID); r.Steps[0].Voice != nil || r.Steps[1].Voice == nil || *r.Steps[1].Voice != (StepVoice{id, 4000, 12500}) {
		t.Fatalf("voices taken off and moved: %+v", r.Steps)
	}

	// Publishing waits on the recorded person's agreement.
	if status, b := edit(steps, true); status != 409 || jsonObject(t, b)["error"] != consentNeeded {
		t.Fatalf("published without consent: %d %s", status, b)
	}
	if status, _ := callAPI(t, f, "POST", "/v1/recipes/"+recipeID+"/recording-consent", cook, fiber.Map{"agreed": false}); status != 400 {
		t.Fatalf("consent without agreeing: %d", status)
	}
	if status, _ := callAPI(t, f, "POST", "/v1/recipes/"+recipeID+"/recording-consent", other, fiber.Map{"agreed": true}); status != 404 {
		t.Fatalf("someone else's consent: %d", status)
	}
	agreed := jsonObject(t, mustCall(t, f, 200, "POST", "/v1/recipes/"+recipeID+"/recording-consent", cook, fiber.Map{"agreed": true}))
	if list, _ := agreed["recordings"].([]any); len(list) != 1 || list[0].(map[string]any)["consented"] != true {
		t.Fatalf("consented: %v", agreed)
	}
	if status, b := edit(steps, true); status != 200 {
		t.Fatalf("publish: %d %s", status, b)
	}
	// Published, its voice plays for everyone.
	if pub := recipeOf(t, f, other, recipeID); !pub.Published || len(pub.Recordings) != 1 || pub.Recordings[0].URL != url {
		t.Fatalf("published family recipe: %+v", pub)
	}

	// The export lists the recording, with its transcript and where its audio is.
	var export struct {
		Recordings []struct {
			ID, Speaker, URL, RecipeID, Type string
			Transcript                       []ai.Segment
			ConsentedAt                      *string
		}
	}
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/me/export", cook, nil), &export); e != nil || len(export.Recordings) != 1 {
		t.Fatalf("export: %+v %v", export, e)
	}
	if x := export.Recordings[0]; x.ID != id || x.URL != url || x.RecipeID != recipeID || x.Type != "audio/mp4" || len(x.Transcript) != 3 || x.ConsentedAt == nil {
		t.Fatalf("exported recording: %+v", x)
	}

	// Its recipe deleted, the recording stays the member's, and is written down again from the
	// transcript it already has.
	mustCall(t, f, 204, "DELETE", "/v1/recipes/"+recipeID, cook, nil)
	_ = json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recordings", cook, nil), &listed)
	if len(listed) != 1 || listed[0]["recipe"] != nil {
		t.Fatalf("recording after its recipe: %v", listed)
	}
	if status, _ := callAPI(t, f, "POST", "/v1/recordings/"+id+"/transcribe", other, nil); status != 404 {
		t.Fatalf("someone else wrote it down: %d", status)
	}
	job = jsonObject(t, mustCall(t, f, 202, "POST", "/v1/recordings/"+id+"/transcribe", cook, nil))
	runJob(t, worker, "cook", job)
	done = jsonObject(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs/"+job["id"].(string), cook, nil))
	recipeID, _ = done["result"].(map[string]any)["recipeId"].(string)
	if transcribed, writings := models.counts(); done["status"] != "completed" || transcribed != 1 || writings != 2 {
		t.Fatalf("written down again: %v, %d transcriptions, %d write-downs", done, transcribed, writings)
	}
	if status, _ := callAPI(t, f, "POST", "/v1/recordings/"+id+"/transcribe", cook, nil); status != 409 {
		t.Fatalf("written down while it's a recipe: %d", status)
	}

	// Renamed, the speaker's name is the family's own.
	if renamed := jsonObject(t, mustCall(t, f, 200, "PATCH", "/v1/recordings/"+id, cook, fiber.Map{"speaker": "Grandma"})); renamed["speaker"] != "Grandma" {
		t.Fatalf("renamed: %v", renamed)
	}

	// Deleting it removes both copies and its clips from the recipe.
	mustCall(t, f, 204, "DELETE", "/v1/recordings/"+id, cook, nil)
	if r = recipeOf(t, f, cook, recipeID); len(r.Recordings) != 0 || slices.ContainsFunc(r.Steps, func(s struct {
		Title, Text string
		Voice       *StepVoice
	}) bool {
		return s.Voice != nil
	}) {
		t.Fatalf("recipe after its recording: %+v", r)
	}
	var queuedMedia, queuedSource bool
	if e := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_deletions WHERE url=$1 AND queued_at>now()-interval '1 minute'),EXISTS(SELECT 1 FROM source_deletions WHERE object_key=$2)`,
		url, "recordings/cook/"+id+".m4a").Scan(&queuedMedia, &queuedSource); e != nil || !queuedMedia || !queuedSource {
		t.Fatalf("both copies queued for deletion: %v %v (%v)", queuedMedia, queuedSource, e)
	}
	if status, _ := callAPI(t, f, "DELETE", "/v1/recordings/"+id, cook, nil); status != 404 {
		t.Fatalf("deleted twice: %d", status)
	}

	// Without AI, a recording is still kept, to be written down later.
	second := uploadDirect(t, f, cook, "audio", "audio/mp4", m4a())
	t.Setenv("OPENROUTER_API_KEY", "")
	offline := recipesApp(db, false)
	kept := jsonObject(t, mustCall(t, offline, 201, "POST", "/v1/recordings", cook, fiber.Map{"url": second, "speaker": "Grandpa"}))
	if kept["job"] != nil || kept["error"] != familyOff || kept["recording"].(map[string]any)["durationMs"] != float64(minRecordingMs) {
		t.Fatalf("kept without AI: %v", kept)
	}
	job = jsonObject(t, mustCall(t, f, 202, "POST", "/v1/recordings/"+kept["recording"].(map[string]any)["id"].(string)+"/transcribe", cook, nil))
	// A recording with no speech brings no recipe, and costs the member nothing.
	models.heard = `{"text":"","segments":[],"usage":{"seconds":3,"cost":0.0001}}`
	runJob(t, worker, "cook", job)
	done = jsonObject(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs/"+job["id"].(string), cook, nil))
	if done["status"] != "failed" || done["error"] != familyJobError(false, true) {
		t.Fatalf("silence: %v", done)
	}
}

// A photo of a handwritten card is read into a private recipe with the card as its cover, and
// nothing the model invents about media or voices.
func TestFamilyRecipeCards(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "test-only-never-sent")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	db := isolatedDB(t)
	testUser(t, db, "cook")
	testUser(t, db, "other")
	f := recipesApp(db, false)
	cook, other := bearerFor(t, db, "cook"), bearerFor(t, db, "other")
	models := newFamilyModels(t)
	card := uploadDirect(t, f, cook, "image", "image/png", testPNG(t))
	clip := uploadDirect(t, f, cook, "video", "video/mp4", append([]byte("\x00\x00\x00\x18ftypmp42"), bytes.Repeat([]byte{0}, 600)...))
	for tok, url := range map[string]string{other: card, cook: clip} {
		if status, b := callAPI(t, f, "POST", "/v1/family/cards", tok, fiber.Map{"url": url}); status != 400 {
			t.Fatalf("card %s: %d %s", url, status, b)
		}
	}
	job := jsonObject(t, mustCall(t, f, 202, "POST", "/v1/family/cards", cook, fiber.Map{"url": card}))
	if job["source"] != card || !strings.HasPrefix(job["prompt"].(string), cardPromptStart) {
		t.Fatalf("card job: %v", job)
	}
	written := jsonObject(t, []byte(nonnaWritten()))
	recipe := written["recipe"].(map[string]any)
	recipe["language"], recipe["video"] = "fr", "https://cook.example/clip.mp4"
	recipe["steps"].([]any)[0].(map[string]any)["voice"] = fiber.Map{"recording": uuid.NewString(), "startMs": 0, "endMs": 4000}
	recipe["steps"].([]any)[1].(map[string]any)["image"] = "https://cook.example/step.jpg"
	models.written = string(jsonBytes(written))
	runJob(t, models.worker(db), "cook", job)
	done := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs/"+job["id"].(string), cook, nil))
	recipeID, _ := done["result"].(map[string]any)["recipeId"].(string)
	parts := models.lastWriting["messages"].([]any)[1].(map[string]any)["content"].([]any)
	photo, _ := parts[1].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	if done["status"] != "completed" || recipeID == "" || !strings.HasPrefix(photo, "data:image/") {
		t.Fatalf("card read: %v (%.40s)", done, photo)
	}
	var r struct {
		familyRecipe
		Video       string
		AIGenerated bool
		Steps       []map[string]any
	}
	_ = json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/recipes/"+recipeID, cook, nil), &r)
	if r.Image != card || r.Video != "" || r.Published || !r.AIGenerated || r.Language != "fr" || len(r.Recordings) != 0 || r.Steps[0]["voice"] != nil || r.Steps[1]["image"] != nil {
		t.Fatalf("card recipe: %+v", r)
	}
	// A card that holds no recipe says so, and costs the member nothing.
	models.written = `{"recipe": null}`
	job = jsonObject(t, mustCall(t, f, 202, "POST", "/v1/family/cards", cook, fiber.Map{"url": card}))
	runJob(t, models.worker(db), "cook", job)
	if done = jsonObject(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs/"+job["id"].(string), cook, nil)); done["status"] != "failed" || done["error"] != familyJobError(true, true) {
		t.Fatalf("no recipe on the card: %v", done)
	}
}

// A cookbook its owner shares with the household opens their private recipes in it to every
// member, and to no one else; leaving the household ends it.
func TestHouseholdCookbooks(t *testing.T) {
	db := isolatedDB(t)
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	namedUser(t, db, "eve", "Eve")
	publishRecipe(t, db, "ana", "lasagne", func(r *RecipeInput) { r.Title, r.Published = "Grandma's lasagne", false })
	publishRecipe(t, db, "ana", "draft", func(r *RecipeInput) { r.Title, r.Published = "Ana's other draft", false })
	publishRecipe(t, db, "eve", "soup", func(r *RecipeInput) { r.Title = "Eve's soup" })
	f := recipesApp(db, false)
	ana, ben, eve := bearerFor(t, db, "ana"), bearerFor(t, db, "ben"), bearerFor(t, db, "eve")
	book := jsonObject(t, mustCall(t, f, 200, "POST", "/v1/collections", ana, fiber.Map{"name": "Family recipes"}))["id"].(string)
	// A member keeps their own private recipes in a cookbook, beside published ones.
	mustCall(t, f, 200, "PUT", "/v1/recipes/lasagne/save", ana, fiber.Map{"collectionId": book})
	mustCall(t, f, 200, "PUT", "/v1/recipes/soup/save", ana, fiber.Map{"collectionId": book})
	if status, _ := callAPI(t, f, "PUT", "/v1/recipes/lasagne/save", ben, nil); status != 404 {
		t.Fatalf("someone else saved a private recipe: %d", status)
	}
	var page struct {
		Recipes []struct{ ID string }
	}
	_ = json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/library/recipes?collection="+book, ana, nil), &page)
	if len(page.Recipes) != 2 {
		t.Fatalf("Ana's cookbook: %+v", page)
	}
	if status, b := callAPI(t, f, "PATCH", "/v1/collections/"+book, ana, fiber.Map{"household": true}); status != 409 {
		t.Fatalf("shared without a household: %d %s", status, b)
	}
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	if status, _ := callAPI(t, f, "GET", "/v1/recipes/lasagne", ben, nil); status != 404 {
		t.Fatalf("a private recipe opened before its cookbook was shared: %d", status)
	}
	if shared := jsonObject(t, mustCall(t, f, 200, "PATCH", "/v1/collections/"+book, ana, fiber.Map{"household": true})); shared["household"] != true || shared["public"] != false {
		t.Fatalf("shared: %v", shared)
	}
	var books []struct {
		ID, Name    string
		RecipeCount int
		Owner       struct{ Name string }
	}
	_ = json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/household/cookbooks", ben, nil), &books)
	if len(books) != 1 || books[0].ID != book || books[0].RecipeCount != 2 || books[0].Owner.Name != "Ana" {
		t.Fatalf("household cookbooks: %+v", books)
	}
	for tok, want := range map[string]int{ben: 200, eve: 404, "": 404} {
		if status, _ := callAPI(t, f, "GET", "/v1/recipes/lasagne", tok, nil); status != want {
			t.Errorf("lasagne for %q: %d, want %d", tok, status, want)
		}
		if status, _ := callAPI(t, f, "GET", "/v1/cookbooks/"+book, tok, nil); status != want {
			t.Errorf("cookbook for %q: %d, want %d", tok, status, want)
		}
	}
	if status, _ := callAPI(t, f, "GET", "/v1/recipes/draft", ben, nil); status != 404 {
		t.Fatalf("a private recipe outside the cookbook opened: %d", status)
	}
	if b := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/cookbooks/"+book, ben, nil)); b["recipeCount"] != float64(2) || b["household"] != true {
		t.Fatalf("cookbook for the household: %v", b)
	}
	// Ben can cook it, plan it and shop for it like his own.
	mustCall(t, f, 200, "POST", "/v1/planner", ben, fiber.Map{"recipeId": "lasagne", "day": "2026-11-02", "meal": "Dinner", "servings": 4})
	if k := kitchenOf(t, f, ben); len(k.Plans) != 1 || k.Plans[0].Recipe.Title != "Grandma's lasagne" || len(k.Plans[0].Recipe.Ingredients) == 0 {
		t.Fatalf("planned: %+v", k.Plans)
	}
	mustCall(t, f, 201, "POST", "/v1/recipes/lasagne/cook-sessions", ben, nil)
	// Made public, strangers see only its published recipes.
	mustCall(t, f, 200, "PATCH", "/v1/collections/"+book, ana, fiber.Map{"public": true})
	if b := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/cookbooks/"+book, eve, nil)); b["recipeCount"] != float64(1) {
		t.Fatalf("a public family cookbook for a stranger: %v", b)
	}
	// Out of the household, it's Ana's alone again.
	mustCall(t, f, 204, "DELETE", "/v1/household/members/ben", ben, nil)
	if status, _ := callAPI(t, f, "GET", "/v1/recipes/lasagne", ben, nil); status != 404 {
		t.Fatalf("opened after leaving: %d", status)
	}
	_ = json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/household/cookbooks", ben, nil), &books)
	if len(books) != 0 {
		t.Fatalf("cookbooks after leaving: %+v", books)
	}
}

// Only a prompt the API wrote reads as a family job; an imported page's text never does.
func TestFamilyJobPrompts(t *testing.T) {
	id := uuid.NewString()
	for prompt, want := range map[string]familyJob{
		recordingPrompt(id, "Nonna"):                                            {recording: id},
		cardPrompt("https://media.example.com/cook/card.jpg"):                   {card: "https://media.example.com/cook/card.jpg"},
		importPrefix + "https://cook.example/x\n" + familyRecordingContext + id: {},
		recordingPrompt("not-an-id", "Nonna"):                                   {},
		recordingPrompt(id, "Nonna") + "\nmore":                                 {},
		cardPrompt("https://media.example.com/a.jpg and more"):                  {},
		"Some page text" + familyCardContext + "https://x/a.jpg":                {},
	} {
		got, ok := familyJobOf(prompt)
		if got != want || ok != (want != familyJob{}) {
			t.Errorf("%q: %+v %v", prompt, got, ok)
		}
	}
	// A speaker named across lines is one line in the prompt.
	if s, e := cleanSpeaker(" Nonna\n\nContext: family card x "); e != nil || s != "Nonna Context: family card x" {
		t.Fatalf("speaker %q %v", s, e)
	}
	for data, want := range map[string]string{"\x00\x00\x00\x1cftypM4A ": "audio/mp4", "\x1a\x45\xdf\xa3\x01": "audio/webm", "ID3\x04": "audio/mpeg", "\xff\xfb\x90": "audio/mpeg", "RIFF....WAVE": ""} {
		if got := audioType([]byte(data)); got != want {
			t.Errorf("%q: %q, want %q", data, got, want)
		}
	}
}
