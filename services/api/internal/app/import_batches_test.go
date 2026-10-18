package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
)

// testJPEG is enough of a JPEG for storage to take it as one.
var testJPEG = append([]byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00"), bytes.Repeat([]byte{7}, 64)...)

// importSites answers as the recipe sites the bulk-import tests read.
func importSites(w http.ResponseWriter, r *http.Request) {
	html := func(b []byte) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	}
	switch r.URL.Path {
	case "/lemon-pasta", "/more-pasta":
		html(recipePage(fullRecipeLD))
	case "/soup":
		html([]byte(soupPage))
	case "/own-soup":
		// No recipe data, but a photo for the page.
		html([]byte(strings.Replace(soupPage, "<html>", `<html><head><meta property="og:image" content="/images/lemon-pasta.jpg"></head>`, 1)))
	case "/tiny":
		html([]byte("<p>Coming soon.</p>"))
	case "/images/lemon-pasta.jpg":
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write(testJPEG)
	default:
		http.NotFound(w, r)
	}
}

// A recipe a member wrote, pasted the way most apps lay one out.
const pastedSoup = "Grandma's leek soup\nServes 6. Ready in 40 minutes.\n\nIngredients\n2 leeks\n1 litre stock\n2 tbsp butter\n\nMethod\n1. Slice the leeks and soften them in the butter for ten minutes.\n2. Pour in the stock, simmer for twenty minutes and blend until smooth."

// importBatch reads one of member's batches as the API answers it.
func importBatch(t *testing.T, f *fiber.App, token, id string) (batch struct {
	ID, Purpose, Site string
	FinishedAt        *string
	Items             []struct {
		Position      int
		URL, Text     string
		Status, Error string
		Recipe        *struct{ ID, Title string }
	}
}) {
	t.Helper()
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/imports/"+id, token, nil), &batch); e != nil {
		t.Fatal(e)
	}
	return batch
}

// queuedBatchJobs are the recipe jobs bulk imports queued, by prompt.
func queuedBatchJobs(t *testing.T, db *pgxpool.Pool) map[string]string {
	t.Helper()
	rows, e := db.Query(context.Background(), `SELECT id,prompt FROM ai_jobs WHERE starts_with(request_key,$1) AND status='queued'`, batchJobKey)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	jobs := map[string]string{}
	for rows.Next() {
		var id, prompt string
		if e := rows.Scan(&id, &prompt); e != nil {
			t.Fatal(e)
		}
		jobs[prompt] = id
	}
	return jobs
}

func TestBulkImportsReadEveryLinkIntoAPrivateDraft(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "test-only-never-sent")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "other")
	asked := socialWeb(t, importSites)
	f := recipesApp(db, false)
	cook, other := bearerFor(t, db, "cook"), bearerFor(t, db, "other")

	// A link given twice is read once; Mealime's own recipes are refused at once, never fetched.
	started := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", cook, fiber.Map{
		"purpose": "mealime",
		"urls": []string{"https://cook.example/lemon-pasta", "cook.example/lemon-pasta#print", "https://cook.example/soup", "https://cook.example/tiny",
			"https://cook.example/missing", "https://www.mealime.com/recipes/lemony-chicken-orzo/1234", " "},
		"texts": []string{pastedSoup, "Mum's stew. Brown the beef, add the onions and the wine, and leave it in a low oven all afternoon."},
	}))
	id, _ := started["id"].(string)
	batch := importBatch(t, f, cook, id)
	statuses := func() []string {
		var out []string
		for _, it := range batch.Items {
			out = append(out, it.Status)
		}
		return out
	}
	if batch.Purpose != "mealime" || batch.FinishedAt != nil || len(batch.Items) != 7 ||
		!slices.Equal(statuses(), []string{"queued", "queued", "queued", "queued", "failed", "queued", "queued"}) || batch.Items[4].Error != mealimeRecipe ||
		batch.Items[5].Text != "Grandma's leek soup" || batch.Items[5].URL != "" || batch.Items[1].URL != "https://cook.example/soup" {
		t.Fatalf("started: %+v", batch)
	}

	// The loop reads each item: recipe data and laid-out text are saved at once, pages and text
	// without either go to the recipe model, and the rest say why they brought nothing.
	var reply string
	worker, _ := recipeModel(t, func() string { return reply })
	a := worker(&App{DB: db, Media: NewMediaStore()})
	if !a.advanceImports(ctx) {
		t.Fatal("the loop found nothing to do")
	}
	jobs := queuedBatchJobs(t, db)
	if len(jobs) != 2 {
		t.Fatalf("recipe jobs: %v", jobs)
	}
	var pageJob, textJob string
	for prompt, job := range jobs {
		switch {
		case strings.HasPrefix(prompt, importPrefix+"https://cook.example/soup\n"):
			pageJob = job
		case strings.HasPrefix(prompt, pastedPrefix) && strings.Contains(prompt, "Mum's stew"):
			textJob = job
		}
	}
	if pageJob == "" || textJob == "" {
		t.Fatalf("recipe jobs: %v", jobs)
	}
	reply = string(jsonBytes(map[string]any{"recipe": validRecipe()}))
	a.processJob(ctx, pageJob, "cook", "recipe", promptOf(t, db, pageJob), "")
	reply = `{"recipe": null}`
	a.processJob(ctx, textJob, "cook", "recipe", promptOf(t, db, textJob), "")
	a.advanceImports(ctx)

	batch = importBatch(t, f, cook, id)
	if !slices.Equal(statuses(), []string{"imported", "imported", "failed", "failed", "failed", "imported", "failed"}) || batch.FinishedAt == nil ||
		batch.Items[2].Error != noRecipeOnPage || batch.Items[3].Error != unopenedPage || batch.Items[6].Error != pastedNoRecipe ||
		batch.Items[0].Recipe == nil || batch.Items[0].Recipe.Title != "Lemon & ricotta pasta" || batch.Items[5].Recipe == nil {
		t.Fatalf("finished: %+v", batch)
	}
	// Each became a private draft: a page's credits it, the model's says it's AI-made, and what the
	// member wrote credits nothing.
	for _, want := range []struct {
		item          int
		source, title string
		ai            bool
	}{{0, "https://cook.example/lemon-pasta", "Lemon & ricotta pasta", false}, {1, "https://cook.example/soup", "Lemon pasta", true}, {5, "", "Grandma's leek soup", false}} {
		var source, title, author string
		var ai, published bool
		var servings int
		if e := db.QueryRow(ctx, `SELECT source_url,title,author_id,ai_generated,published,servings FROM recipes WHERE id=$1`, batch.Items[want.item].Recipe.ID).
			Scan(&source, &title, &author, &ai, &published, &servings); e != nil || source != want.source || title != want.title || author != "cook" || ai != want.ai || published {
			t.Errorf("item %d: %q %q %s ai=%v published=%v (%v)", want.item, source, title, author, ai, published, e)
		}
		if want.item == 5 && servings != 6 {
			t.Errorf("pasted servings: %d", servings)
		}
	}
	for _, link := range asked() {
		if strings.Contains(link, "mealime") {
			t.Errorf("fetched %s", link)
		}
	}
	// Only the page the model read counts against the member; the text it found nothing in doesn't.
	if u, e := usageOf(ctx, db, "cook"); e != nil || u.Assistant != 1 {
		t.Fatalf("usage: %+v %v", u, e)
	}
	// The sous-chef history leaves out a bulk import's jobs: their recipes are drafts already.
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/ai/jobs", cook, nil)); len(got) != 0 {
		t.Fatalf("history: %v", got)
	}

	// Batches are the member's own.
	mustCall(t, f, 404, "GET", "/v1/imports/"+id, other, nil)
	mustCall(t, f, 404, "POST", "/v1/imports/"+id+"/stop", other, nil)
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/imports", other, nil)); len(got) != 0 {
		t.Fatalf("someone else's list: %v", got)
	}
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/imports?purpose=mealime", cook, nil)); len(got) != 1 || got[0]["id"] != id {
		t.Fatalf("list: %v", got)
	}
	if got := jsonList(t, mustCall(t, f, 200, "GET", "/v1/imports?purpose=links", cook, nil)); len(got) != 0 {
		t.Fatalf("other purposes: %v", got)
	}
	// The export keeps what was imported, and the recipes the member wrote as they pasted them.
	var doc struct {
		Imports []struct {
			Purpose string
			Links   []struct{ URL, Status string }
			Texts   []struct{ Text, Status string }
		}
	}
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/me/export", cook, nil), &doc); e != nil || len(doc.Imports) != 1 || len(doc.Imports[0].Links) != 5 ||
		len(doc.Imports[0].Texts) != 2 || doc.Imports[0].Texts[0].Text != pastedSoup || doc.Imports[0].Links[4].Status != "failed" {
		t.Fatalf("export: %+v %v", doc, e)
	}
	// A deleted draft leaves its item without a recipe.
	mustCall(t, f, 204, "DELETE", "/v1/recipes/"+batch.Items[0].Recipe.ID, cook, nil)
	if batch = importBatch(t, f, cook, id); batch.Items[0].Recipe != nil || batch.Items[0].Status != "imported" {
		t.Fatalf("after deleting: %+v", batch.Items[0])
	}
}

func promptOf(t *testing.T, db *pgxpool.Pool, job string) string {
	t.Helper()
	var prompt string
	if e := db.QueryRow(context.Background(), `SELECT prompt FROM ai_jobs WHERE id=$1`, job).Scan(&prompt); e != nil {
		t.Fatal(e)
	}
	return prompt
}

// Without the recipe model, what the importer can't read by itself says so.
func TestBulkImportsWithoutTheModel(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	socialWeb(t, importSites)
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	id := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", cook, fiber.Map{"urls": []string{"https://cook.example/soup"}, "texts": []string{"Mum's stew, slow and rich."}}))["id"].(string)
	a := &App{DB: db, AI: ai.New()}
	a.advanceImports(ctx)
	batch := importBatch(t, f, cook, id)
	if batch.Purpose != "links" || batch.FinishedAt == nil || batch.Items[0].Error != unreadPage || batch.Items[1].Error != pastedUnread {
		t.Fatalf("batch: %+v", batch)
	}
	if n := count(t, db, `SELECT count(*) FROM ai_jobs`); n != 0 {
		t.Fatalf("%d jobs", n)
	}
}

func TestBulkImportLimits(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"cook", "careful", "busy", "keen"} {
		testUser(t, db, id)
	}
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	// Ten imports an hour per member, refused ones included, so the refusals take turns.
	members := []string{cook, bearerFor(t, db, "careful")}
	links := func(n int) []string {
		var out []string
		for i := range n {
			out = append(out, "https://cook.example/recipe-"+strings.Repeat("x", i+1))
		}
		return out
	}
	for i, c := range []struct {
		body    fiber.Map
		message string
	}{
		{fiber.Map{}, "Paste at least one recipe link."},
		{fiber.Map{"urls": []string{" ", ""}}, "Paste at least one recipe link."},
		{fiber.Map{"purpose": "everything", "urls": links(1)}, "Choose what kind of import this is."},
		{fiber.Map{"urls": []string{"https://cook.example/a", "not a link"}}, "Check the links: each one should be the full address of a recipe page."},
		{fiber.Map{"urls": []string{"ftp://cook.example/a"}}, "Check the links: each one should be the full address of a recipe page."},
		{fiber.Map{"urls": links(51)}, "Import up to 50 recipes at a time."},
		{fiber.Map{"urls": links(201)}, "Import up to 50 recipes at a time."},
		{fiber.Map{"texts": slices.Repeat([]string{pastedSoup}, 11)}, "Paste up to 10 recipes at a time."},
		{fiber.Map{"texts": []string{strings.Repeat("a", 12001)}}, "Paste one recipe of up to 12,000 characters at a time."},
		{fiber.Map{"purpose": "own_site", "urls": links(1)}, "Confirm that these recipes are your own and that Savorly may import them."},
		{fiber.Map{"purpose": "own_site", "ownRecipes": true, "urls": []string{"https://www.cook.example/a", "https://elsewhere.example/b"}}, "Import the recipes of one site at a time."},
		{fiber.Map{"purpose": "own_site", "ownRecipes": true, "urls": links(1), "texts": []string{pastedSoup}}, "Paste the links of the recipes on your site."},
	} {
		if status, b := callAPI(t, f, "POST", "/v1/imports", members[i%2], c.body); status != 400 || jsonObject(t, b)["error"] != c.message {
			t.Errorf("%v: %d %s, want %q", c.body, status, b, c.message)
		}
	}
	if n := count(t, db, `SELECT count(*) FROM import_batches`); n != 0 {
		t.Fatalf("refused imports left %d batches", n)
	}
	// An own site's links may differ in www.; the batch records the site and the permission.
	own := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", cook, fiber.Map{"purpose": "own_site", "ownRecipes": true,
		"urls": []string{"https://www.cook.example/a", "https://cook.example/b"}}))
	var statement string
	if e := db.QueryRow(ctx, `SELECT permission_statement FROM import_batches WHERE id=$1 AND permission_at IS NOT NULL`, own["id"]).Scan(&statement); e != nil ||
		own["site"] != "cook.example" || own["permissionAt"] == nil || !strings.Contains(statement, "my own site, cook.example.") {
		t.Fatalf("own site: %v %q %v", own, statement, e)
	}

	// Three unfinished batches at a time.
	busy := bearerFor(t, db, "busy")
	for range 3 {
		mustCall(t, f, 201, "POST", "/v1/imports", busy, fiber.Map{"urls": links(2)})
	}
	if status, b := callAPI(t, f, "POST", "/v1/imports", busy, fiber.Map{"urls": links(1)}); status != 429 ||
		jsonObject(t, b)["error"] != "Your earlier imports are still running. Start another once one of them has finished." {
		t.Fatalf("fourth batch: %d %s", status, b)
	}
	// A batch of links that could only be refused is finished at once, and doesn't hold a place.
	keen := bearerFor(t, db, "keen")
	refused := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", keen, fiber.Map{"purpose": "mealime", "urls": []string{"https://mealime.com/recipes/a/1"}}))
	if refused["finishedAt"] == nil {
		t.Fatalf("refused only: %v", refused)
	}
	// 200 links and recipes a day.
	if _, e := db.Exec(ctx, `INSERT INTO import_batches(id,user_id,purpose,finished_at) VALUES('earlier','keen','links',now());
 INSERT INTO import_items(batch_id,position,url,status) SELECT 'earlier',n,'https://cook.example/'||n,'imported' FROM generate_series(1,190) n`); e != nil {
		t.Fatal(e)
	}
	if status, b := callAPI(t, f, "POST", "/v1/imports", keen, fiber.Map{"urls": links(10)}); status != 429 ||
		jsonObject(t, b)["error"] != "That would be more than 200 recipes today. Import the rest tomorrow." {
		t.Fatalf("over the day's limit: %d %s", status, b)
	}
	mustCall(t, f, 201, "POST", "/v1/imports", keen, fiber.Map{"urls": links(9)})
}

func TestStoppingAndRecoveringImports(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	start := func(urls ...string) string {
		t.Helper()
		return jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", cook, fiber.Map{"urls": urls}))["id"].(string)
	}
	// Stopping leaves what still waits unread; one being read goes on.
	stopped := start("https://cook.example/a", "https://cook.example/b", "https://cook.example/c")
	if _, e := db.Exec(ctx, `UPDATE import_items SET status='reading' WHERE batch_id=$1 AND position=1`, stopped); e != nil {
		t.Fatal(e)
	}
	mustCall(t, f, 200, "POST", "/v1/imports/"+stopped+"/stop", cook, nil)
	batch := importBatch(t, f, cook, stopped)
	if batch.Items[0].Status != "reading" || batch.Items[1].Error != importStopped || batch.Items[2].Status != "failed" || batch.FinishedAt != nil {
		t.Fatalf("stopped: %+v", batch)
	}

	// An item whose reader went away goes back in line, until it has been tried three times.
	a := &App{DB: db, AI: ai.New()}
	if _, e := db.Exec(ctx, `UPDATE import_items SET updated_at=now()-interval '3 minutes',attempts=1 WHERE batch_id=$1 AND position=1`, stopped); e != nil {
		t.Fatal(e)
	}
	if !a.recoverImports(ctx) {
		t.Fatal("nothing recovered")
	}
	if batch = importBatch(t, f, cook, stopped); batch.Items[0].Status != "queued" || batch.FinishedAt != nil {
		t.Fatalf("recovered: %+v", batch)
	}
	if _, e := db.Exec(ctx, `UPDATE import_items SET status='reading',updated_at=now()-interval '3 minutes',attempts=3 WHERE batch_id=$1 AND position=1`, stopped); e != nil {
		t.Fatal(e)
	}
	a.recoverImports(ctx)
	if batch = importBatch(t, f, cook, stopped); batch.Items[0].Status != "failed" || batch.Items[0].Error != importInterrupted || batch.FinishedAt == nil {
		t.Fatalf("given up: %+v", batch)
	}
	// A reader still at work, or one waiting on the model, is left alone.
	waiting := start("https://cook.example/d", "https://cook.example/e")
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key) VALUES('job','cook','recipe','p','import-batch-x');
 UPDATE import_items SET status='reading',updated_at=now()-interval '3 minutes',job_id=CASE WHEN position=1 THEN 'job' END WHERE batch_id='`+waiting+`';
 UPDATE import_items SET updated_at=now() WHERE batch_id='`+waiting+`' AND position=2`); e != nil {
		t.Fatal(e)
	}
	if a.recoverImports(ctx) {
		t.Fatal("recovered a live reader")
	}
	// Stopping a batch with nothing waiting changes nothing.
	mustCall(t, f, 200, "POST", "/v1/imports/"+stopped+"/stop", cook, nil)
	mustCall(t, f, 404, "POST", "/v1/imports/nothing/stop", cook, nil)
}

// Batches take turns, so one member's 50 links don't hold up another's few, and a batch is read
// one link at a time.
func TestImportBatchesTakeTurns(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "first")
	testUser(t, db, "second")
	if _, e := db.Exec(ctx, `INSERT INTO import_batches(id,user_id,purpose,created_at) VALUES('a','first','links',now()-interval '1 minute'),('b','second','links',now());
 INSERT INTO import_items(batch_id,position,url) VALUES('a',1,'https://a.example/1'),('a',2,'https://a.example/2'),('a',3,'https://a.example/3'),('b',1,'https://b.example/1'),('b',2,'https://b.example/2')`); e != nil {
		t.Fatal(e)
	}
	a := &App{DB: db}
	claim := func() string {
		t.Helper()
		it, ok := a.claimImport(ctx)
		if !ok {
			return ""
		}
		return fmt.Sprint(it.batch, it.position)
	}
	done := func(item string) {
		t.Helper()
		if _, e := db.Exec(ctx, `UPDATE import_items SET status='imported' WHERE batch_id=$1 AND position=$2`, item[:1], int(item[1]-'0')); e != nil {
			t.Fatal(e)
		}
	}
	// While a's first link is being read, only b's can be taken.
	if got := []string{claim(), claim(), claim()}; !slices.Equal(got, []string{"a1", "b1", ""}) {
		t.Fatalf("claims: %v", got)
	}
	var order []string
	done("a1")
	done("b1")
	for item := claim(); item != ""; item = claim() {
		order = append(order, item)
		done(item)
	}
	if !slices.Equal(order, []string{"a2", "b2", "a3"}) {
		t.Fatalf("order: %v", order)
	}
}

// A recipe job that brings nothing never counts against the member, however it ended: failed by
// the stalled-job sweep, or finished with a recipe that couldn't be saved.
func TestImportJobsThatBringNothingDontCount(t *testing.T) {
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	estimate := ai.GenerationEstimate("recipe")
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,status,error,result,request_key,estimated_cost) VALUES
  ('swept','cook','recipe','p','failed',$1,'{}','import-batch-b-1',$2),
  ('unsaveable','cook','recipe','p','completed','','{"recipe":{"title":""}}','import-batch-b-2',$2)`, jobInterrupted, estimate); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO import_batches(id,user_id,purpose) VALUES('b','cook','links');
 INSERT INTO import_items(batch_id,position,url,status,job_id) VALUES('b',1,'https://cook.example/1','reading','swept'),('b',2,'https://cook.example/2','reading','unsaveable')`); e != nil {
		t.Fatal(e)
	}
	if u, e := usageOf(ctx, db, "cook"); e != nil || u.Assistant != 2 {
		t.Fatalf("before: %+v %v", u, e)
	}
	a := &App{DB: db, AI: ai.New()}
	if !a.settleImportJobs(ctx) {
		t.Fatal("nothing settled")
	}
	batch := importBatch(t, f, cook, "b")
	if batch.Items[0].Error != importInterrupted || batch.Items[1].Error != noRecipeOnPage || batch.FinishedAt == nil {
		t.Fatalf("batch: %+v", batch)
	}
	var shared float64
	if e := db.QueryRow(ctx, `SELECT COALESCE(sum(estimated_cost),0)::float8 FROM ai_usage WHERE user_id IS NULL AND kind='unread_import'`).Scan(&shared); e != nil || shared != 2*estimate {
		t.Fatalf("shared ledger: %v %v", shared, e)
	}
	if u, e := usageOf(ctx, db, "cook"); e != nil || u.Assistant != 0 || u.Spend != 0 {
		t.Fatalf("after: %+v %v", u, e)
	}
	// Settled once: another pass finds nothing.
	if a.settleImportJobs(ctx) {
		t.Fatal("settled twice")
	}
}

// A creator importing their own site keeps the photos their pages show, copied into their
// storage, and the permission they gave stays as long as their kitchen does.
func TestOwnSiteImportsKeepTheCreatorsPhotos(t *testing.T) {
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	t.Setenv("OPENROUTER_API_KEY", "")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "creator")
	socialWeb(t, importSites)
	f := recipesApp(db, false)
	creator := bearerFor(t, db, "creator")
	id := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", creator, fiber.Map{"purpose": "own_site", "ownRecipes": true,
		"urls": []string{"https://cook.example/lemon-pasta"}}))["id"].(string)
	// The same page brought in by an ordinary import keeps the photo's address instead.
	links := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", creator, fiber.Map{"urls": []string{"https://cook.example/more-pasta"}}))["id"].(string)
	a := &App{DB: db, AI: ai.New(), Media: NewMediaStore()}
	a.advanceImports(ctx)
	photo := func(batch string) (image, source string) {
		t.Helper()
		b := importBatch(t, f, creator, batch)
		if b.Items[0].Recipe == nil {
			t.Fatalf("not imported: %+v", b)
		}
		if e := db.QueryRow(ctx, `SELECT image,source_url FROM recipes WHERE id=$1`, b.Items[0].Recipe.ID).Scan(&image, &source); e != nil {
			t.Fatal(e)
		}
		return image, source
	}
	image, source := photo(id)
	stored, ok := storage.object("media/" + strings.TrimPrefix(image, "https://media.example.com/"))
	if !strings.HasPrefix(image, "https://media.example.com/creator/") || !ok || !bytes.Equal(stored.data, testJPEG) || source != "https://cook.example/lemon-pasta" {
		t.Fatalf("own recipe: %q %q (stored %v)", image, source, ok)
	}
	if image, _ = photo(links); image != "https://cook.example/images/lemon-pasta.jpg" {
		t.Fatalf("ordinary import's photo: %q", image)
	}

	// Finished imports go after 90 days; a creator's permission to import their site stays.
	if _, e := db.Exec(ctx, `UPDATE import_batches SET finished_at=now()-interval '91 days'`); e != nil {
		t.Fatal(e)
	}
	counts, e := runJanitor(ctx, db)
	if e != nil || counts["import_batches"] != 1 {
		t.Fatalf("janitor: %v %v", counts, e)
	}
	if left := jsonList(t, mustCall(t, f, 200, "GET", "/v1/imports", creator, nil)); len(left) != 1 || left[0]["id"] != id || left[0]["purpose"] != "own_site" {
		t.Fatalf("kept: %v", left)
	}
	var doc struct {
		Imports []struct {
			Site       string
			Permission struct{ Statement, AgreedAt string }
		}
	}
	if e := json.Unmarshal(mustCall(t, f, 200, "GET", "/v1/me/export", creator, nil), &doc); e != nil || len(doc.Imports) != 1 || doc.Imports[0].Site != "cook.example" ||
		!strings.HasPrefix(doc.Imports[0].Permission.Statement, "These recipes are my own") || doc.Imports[0].Permission.AgreedAt == "" {
		t.Fatalf("export: %+v %v", doc, e)
	}
	// Deleting the kitchen deletes its imports.
	if _, e := db.Exec(ctx, `DELETE FROM users WHERE id='creator'`); e != nil {
		t.Fatal(e)
	}
	if n := count(t, db, `SELECT count(*) FROM import_batches`) + count(t, db, `SELECT count(*) FROM import_items`); n != 0 {
		t.Fatalf("%d rows left", n)
	}
}

func TestSimilarRecipesForMealimesOwn(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "chef")
	for id, title := range map[string]string{"orzo": "Chicken orzo with spinach", "fajitas": "Sheet-pan chicken fajitas", "stew": "Beef and ale stew"} {
		publishRecipe(t, db, "chef", id, func(r *RecipeInput) { r.Title = title })
	}
	testRecipe(t, db, "chef", "Lemony chicken orzo, my draft", false)
	f := recipesApp(db, false)
	// No session needed; names repeat once, and each finds its own.
	got := jsonList(t, mustCall(t, f, 200, "POST", "/v1/imports/similar", "", fiber.Map{"names": []string{"Lemony Chicken Orzo", " sheet pan chicken fajitas ", "lemony chicken orzo", "Unicorn cake", ""}}))
	titles := func(i int) []string {
		var out []string
		for _, r := range got[i]["recipes"].([]any) {
			out = append(out, r.(map[string]any)["title"].(string))
		}
		return out
	}
	if len(got) != 3 || got[0]["name"] != "Lemony Chicken Orzo" || titles(0)[0] != "Chicken orzo with spinach" || slices.Contains(titles(0), "Lemony chicken orzo, my draft") ||
		titles(1)[0] != "Sheet-pan chicken fajitas" || len(titles(2)) != 0 {
		t.Fatalf("similar: %v", got)
	}
	for body, message := range map[string]string{`{}`: "Paste at least one recipe name.", `{"names":["","  "]}`: "Paste at least one recipe name."} {
		var in any
		_ = json.Unmarshal([]byte(body), &in)
		if status, b := callAPI(t, f, "POST", "/v1/imports/similar", "", in); status != 400 || jsonObject(t, b)["error"] != message {
			t.Errorf("%s: %d %s", body, status, b)
		}
	}
	var many []string
	for i := range 26 {
		many = append(many, "Dish "+strings.Repeat("x", i+1))
	}
	if status, _ := callAPI(t, f, "POST", "/v1/imports/similar", "", fiber.Map{"names": many}); status != 400 {
		t.Fatalf("26 names: %d", status)
	}
}

func TestSimilarSearchesEndWithWhatTheDishIs(t *testing.T) {
	for name, want := range map[string][]string{
		"Lemony Chicken Orzo":              {"Lemony Chicken Orzo", "Chicken Orzo", "Orzo", "Chicken", "Lemony"},
		"Easy beef stew":                   {"Easy beef stew", "stew", "beef"},
		"Tacos":                            {"Tacos"},
		"Quick & Easy Chicken with Pesto!": {"Quick & Easy Chicken with Pesto!", "Pesto", "Chicken"},
	} {
		if got := similarSearches(name); !slices.Equal(got, want) {
			t.Errorf("%q: %q, want %q", name, got, want)
		}
	}
}

func TestPastedRecipesLaidOutAsUsual(t *testing.T) {
	a := &App{}
	r, ok := a.pastedRecipe(pastedSoup)
	if !ok || r.Title != "Grandma's leek soup" || r.Servings != 6 || r.Minutes != 40 || len(r.Ingredients) != 3 || r.Ingredients[0].Name == "" || len(r.Steps) != 2 ||
		strings.HasPrefix(r.Steps[0].Text, "1.") || r.Description != "Serves 6. Ready in 40 minutes." || r.SourceURL != nil {
		t.Fatalf("pasted: %v %+v", ok, r)
	}
	// Markdown headings, sections and other languages read the same.
	for _, text := range []string{
		"# Pancakes\n\n## Ingredients\n- 200 g flour\n- 2 eggs\n- 300 ml milk\n\n**Method:**\nFor the batter:\n- Whisk everything together and rest it for 30 minutes.\n- Fry ladlefuls in a hot pan.",
		"Titel: Pfannkuchen\nZutaten\n200 g Mehl\n2 Eier\n300 ml Milch\nZubereitung\nAlles verrühren und 30 Minuten ruhen lassen.\nIn einer heißen Pfanne ausbacken.",
		"Crêpes\nIngrédients :\n200 g de farine\n2 œufs\nPréparation\nMélanger le tout et laisser reposer.\nCuire dans une poêle chaude.",
	} {
		r, ok := a.pastedRecipe(text)
		if !ok || len(r.Ingredients) < 2 || len(r.Steps) != 2 || strings.ContainsAny(r.Title, "#:") || r.Title == "" {
			t.Errorf("%q: %v %+v", text, ok, r)
		}
	}
	// Anything else goes to the model.
	for _, text := range []string{
		"Mum's stew. Brown the beef, add the onions and the wine, and leave it in a low oven all afternoon.",
		"Ingredients\n2 eggs\nMethod\nBoil them.",               // no title before the ingredients
		"Pancakes\nIngredients\n200 g flour\n2 eggs\nFry them.", // no method
	} {
		if _, ok := a.pastedRecipe(text); ok {
			t.Errorf("%q read by itself", text)
		}
	}
	if read := a.readPasted("Mum's stew, slow and rich."); read.recipe != nil || !strings.HasPrefix(read.prompt(), pastedPrefix+"\n\nContext: ") || !strings.HasSuffix(read.prompt(), "Mum's stew, slow and rich.") {
		t.Fatalf("for the model: %+v", read)
	}
}

// The worker's import loop sleeps until a batch starts, here or on another replica.
func TestTheImportLoopWakesForNewBatches(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	db := isolatedDB(t)
	testUser(t, db, "cook")
	socialWeb(t, importSites)
	old := importPace
	importPace = pacing{base: time.Hour, idle: time.Hour}
	t.Cleanup(func() { importPace = old })
	worker := &App{DB: db, AI: ai.New()}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		wg.Go(func() { worker.listenForWork(ctx) })
		wg.Go(func() { worker.runImports(ctx) })
		wg.Wait()
	}()
	defer func() { cancel(); <-done }()
	f := recipesApp(db, false)
	cook := bearerFor(t, db, "cook")
	finished := func(id string) bool {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			if importBatch(t, f, cook, id).FinishedAt != nil {
				return true
			}
		}
		return false
	}
	id := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", cook, fiber.Map{"urls": []string{"https://cook.example/lemon-pasta"}}))["id"].(string)
	if !finished(id) || importBatch(t, f, cook, id).Items[0].Status != "imported" {
		t.Fatal("the loop didn't read the batch")
	}
	// A batch another replica started arrives as a notification.
	if _, e := db.Exec(context.Background(), `INSERT INTO import_batches(id,user_id,purpose) VALUES('elsewhere','cook','links');
 INSERT INTO import_items(batch_id,position,url) VALUES('elsewhere',1,'https://cook.example/more-pasta');
 SELECT pg_notify('savorly_work','imports')`); e != nil {
		t.Fatal(e)
	}
	if !finished("elsewhere") {
		t.Fatal("the notification didn't wake the loop")
	}
}

// A creator's page without recipe data is read by the model, and keeps its photo too.
func TestOwnSiteRecipesTheModelReadsKeepTheirPhotos(t *testing.T) {
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	t.Setenv("OPENROUTER_API_KEY", "test-only-never-sent")
	t.Setenv("AI_DAILY_BUDGET_USD", "100")
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "creator")
	socialWeb(t, importSites)
	f := recipesApp(db, false)
	creator := bearerFor(t, db, "creator")
	id := jsonObject(t, mustCall(t, f, 201, "POST", "/v1/imports", creator, fiber.Map{"purpose": "own_site", "ownRecipes": true,
		"urls": []string{"https://cook.example/own-soup"}}))["id"].(string)
	worker, _ := recipeModel(t, func() string { return string(jsonBytes(map[string]any{"recipe": validRecipe()})) })
	a := worker(&App{DB: db, Media: NewMediaStore()})
	a.advanceImports(ctx)
	for _, job := range queuedBatchJobs(t, db) {
		a.processJob(ctx, job, "creator", "recipe", promptOf(t, db, job), "")
	}
	a.advanceImports(ctx)
	batch := importBatch(t, f, creator, id)
	if batch.Items[0].Recipe == nil {
		t.Fatalf("not imported: %+v", batch)
	}
	var image, source string
	if e := db.QueryRow(ctx, `SELECT image,source_url FROM recipes WHERE id=$1`, batch.Items[0].Recipe.ID).Scan(&image, &source); e != nil {
		t.Fatal(e)
	}
	if stored, ok := storage.object("media/" + strings.TrimPrefix(image, "https://media.example.com/")); !ok || !bytes.Equal(stored.data, testJPEG) || source != "https://cook.example/own-soup" {
		t.Fatalf("own recipe: %q %q (stored %v)", image, source, ok)
	}
}
