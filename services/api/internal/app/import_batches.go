package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"savorly/api/internal/ai"
)

// Bulk imports (POST /imports): a member pastes many recipe links at once (on the page for
// Mealime's members, from Add a recipe, or as a creator bringing in their own site), or recipes
// they wrote as text, and the server reads each into a private draft that credits its page
// (sourceUrl). The import loop (runImports) reads each batch one link at a time through the link
// importer (import.go), a few batches at once, so leaving the page doesn't stop it and no site
// gets every link at once. What the importer reads for free (schema.org data, or text with
// Ingredients and Method headings) is saved at once; anything else becomes an ordinary recipe
// job, counted like a single import, and is saved when the job finishes. An item that brings no
// recipe never counts against the member's plan (failImport, releaseImportJob).

const (
	// maxBatchItems is the most links and pasted recipes one batch takes; maxBatchTexts the most
	// pasted recipes, each up to maxPastedText characters.
	maxBatchItems = 50
	maxBatchTexts = 10
	maxPastedText = 12000
	// importsPerDay is how many links and recipes a member may send in 24 hours, and openBatches
	// how many of their batches may be unfinished at once.
	importsPerDay = 200
	openBatches   = 3
	// batchJobKey starts the Idempotency-Key of an item's recipe job; a job finishing under one
	// wakes the import loop (finishJob, failImport).
	batchJobKey = "import-batch-"
	// importReaders is how many items, each of another batch, one process reads at once, and
	// importRounds how many rounds of them one pass of the loop reads.
	importReaders = 4
	importRounds  = 10
	// importStale is how long an item may be read without a job before the loop takes its reader
	// for gone (a server that stopped), and importAttempts how often an item is tried.
	importStale    = 2 * time.Minute
	importAttempts = 3
	// maxSimilarNames is how many recipe names POST /imports/similar looks up at once.
	maxSimilarNames = 25
	// maxOwnPhoto is the largest photo copied from a creator's own page.
	maxOwnPhoto = 20 << 20
)

// ownSitePermission is what a creator importing their own site agrees to; an own_site batch
// records it, naming the site, with the time.
const ownSitePermission = "These recipes are my own and published on my own site, %s. I give Savorly permission to import them into my Savorly kitchen, each linking back to its page."

// What an item that brought no recipe says, besides the importer's own refusals (import.go,
// import_social.go) and the job's (jobs.go). The app shows them through its catalogs.
const (
	// mealimeRecipe answers a link to one of Mealime's own recipes, which stay Mealime's; the
	// app offers similar Savorly recipes instead (POST /imports/similar).
	mealimeRecipe     = "This is one of Mealime’s own recipes, which stay with Mealime. Look for a similar Savorly recipe instead."
	importStopped     = "You stopped the import before this one was read."
	importUnsaved     = "We couldn’t save this recipe. Try importing it again."
	importInterrupted = "We couldn’t finish reading this one. Try importing it again."
	unreadPage        = "We couldn’t read a recipe from that page."
	unopenedPage      = "We couldn’t open that page."
)

var importPurposes = map[string]bool{"links": true, "mealime": true, "own_site": true}

// importRoutes registers bulk imports and the similar-recipe lookup.
func (a *App) importRoutes(v fiber.Router) {
	v.Post("/imports", a.requireAuth, perUser(10, time.Hour), a.startImport)
	v.Get("/imports", a.requireAuth, a.importBatches)
	v.Post("/imports/similar", rateLimit(10, time.Minute), a.similarRecipes)
	v.Get("/imports/:id", a.requireAuth, a.importBatch)
	v.Post("/imports/:id/stop", a.requireAuth, a.stopImport)
}

// batchJSON is batch b with its items in order: a pasted recipe shows its first line as text,
// and an imported one the draft it became while that still exists.
const batchJSON = `jsonb_build_object('id',b.id,'purpose',b.purpose,'site',b.site,'createdAt',b.created_at,'finishedAt',b.finished_at,'permissionAt',b.permission_at,
 'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('position',i.position,'url',i.url,'text',left(split_part(btrim(i.pasted),E'\n',1),80),'status',i.status,'error',i.error,
   'recipe',(SELECT jsonb_build_object('id',r.id,'title',r.title,'image',r.image) FROM recipes r WHERE r.id=i.recipe_id)) ORDER BY i.position)
   FROM import_items i WHERE i.batch_id=b.id),'[]'))`

// startImport queues a batch: urls (a link each; repeats are read once) and texts (a recipe
// each), for a purpose. An own_site batch takes links on one site and needs ownRecipes, the
// member's confirmation that the recipes are theirs, which the batch records.
func (a *App) startImport(c fiber.Ctx) error {
	var in struct {
		Purpose    string   `json:"purpose"`
		URLs       []string `json:"urls"`
		Texts      []string `json:"texts"`
		OwnRecipes bool     `json:"ownRecipes"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Purpose == "" {
		in.Purpose = "links"
	}
	if !importPurposes[in.Purpose] {
		return fiber.NewError(400, "Choose what kind of import this is.")
	}
	ownSite := in.Purpose == "own_site"
	if ownSite && !in.OwnRecipes {
		return fiber.NewError(400, "Confirm that these recipes are your own and that Savorly may import them.")
	}
	if len(in.URLs)+len(in.Texts) > 4*maxBatchItems {
		return fiber.NewError(400, "Import up to 50 recipes at a time.")
	}
	var urls, pasted, statuses, errs []string
	seen := map[string]bool{}
	site := ""
	for _, raw := range in.URLs {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		link, ok := importURL(raw)
		if !ok {
			return fiber.NewError(400, "Check the links: each one should be the full address of a recipe page.")
		}
		if ownSite {
			if site == "" {
				site = siteOf(link)
			} else if siteOf(link) != site {
				return fiber.NewError(400, "Import the recipes of one site at a time.")
			}
		}
		if seen[link] {
			continue
		}
		seen[link] = true
		status, message := "queued", ""
		if mealimeLink(link) {
			status, message = "failed", mealimeRecipe
		}
		urls, pasted, statuses, errs = append(urls, link), append(pasted, ""), append(statuses, status), append(errs, message)
	}
	texts := 0
	for _, raw := range in.Texts {
		text := strings.TrimSpace(raw)
		if text == "" {
			continue
		}
		if ownSite {
			return fiber.NewError(400, "Paste the links of the recipes on your site.")
		}
		if utf8.RuneCountInString(text) > maxPastedText {
			return fiber.NewError(400, "Paste one recipe of up to 12,000 characters at a time.")
		}
		texts++
		urls, pasted, statuses, errs = append(urls, ""), append(pasted, text), append(statuses, "queued"), append(errs, "")
	}
	switch {
	case len(urls) == 0:
		return fiber.NewError(400, "Paste at least one recipe link.")
	case len(urls) > maxBatchItems:
		return fiber.NewError(400, "Import up to 50 recipes at a time.")
	case texts > maxBatchTexts:
		return fiber.NewError(400, "Paste up to 10 recipes at a time.")
	}
	ctx, owner := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// One member's batches start one at a time, so two can't both slip under the limits.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('imports:'||$1,0))`, owner); e != nil {
		return e
	}
	var open, today int
	if e = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM import_batches WHERE user_id=$1 AND finished_at IS NULL),
 (SELECT count(*) FROM import_items i JOIN import_batches b ON b.id=i.batch_id WHERE b.user_id=$1 AND b.created_at>now()-interval '1 day')`, owner).Scan(&open, &today); e != nil {
		return e
	}
	if open >= openBatches {
		return fiber.NewError(429, "Your earlier imports are still running. Start another once one of them has finished.")
	}
	if today+len(urls) > importsPerDay {
		return fiber.NewError(429, "That would be more than 200 recipes today. Import the rest tomorrow.")
	}
	statement := ""
	if ownSite {
		statement = fmt.Sprintf(ownSitePermission, site)
	}
	id := uuid.NewString()
	if _, e = tx.Exec(ctx, `INSERT INTO import_batches(id,user_id,purpose,site,permission_statement,permission_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $5<>'' THEN now() END)`, id, owner, in.Purpose, site, statement); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO import_items(batch_id,position,url,pasted,status,error)
 SELECT $1,t.n,t.url,t.pasted,t.status,t.error FROM unnest($2::text[],$3::text[],$4::text[],$5::text[]) WITH ORDINALITY AS t(url,pasted,status,error,n)`, id, urls, pasted, statuses, errs); e != nil {
		return e
	}
	// A batch of links that could only be refused is finished already.
	if e = finishBatch(ctx, tx, id); e != nil {
		return e
	}
	if e = announce(ctx, tx, "imports"); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	a.wake("imports")
	c.Status(201)
	return a.queryOne(c, `SELECT `+batchJSON+` FROM import_batches b WHERE b.id=$1`, id)
}

// siteOf is the site a link is on: its host in lowercase, without "www.".
func siteOf(link string) string {
	return strings.TrimPrefix(strings.ToLower(hostOf(link)), "www.")
}

// mealimeLink reports whether link is on Mealime's site, whose recipes are Mealime's own.
func mealimeLink(link string) bool {
	host := siteOf(link)
	return host == "mealime.com" || strings.HasSuffix(host, ".mealime.com")
}

// importBatches lists the member's five latest batches, newest first; ?purpose= keeps one kind.
func (a *App) importBatches(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT `+batchJSON+` FROM import_batches b WHERE b.user_id=$1 AND ($2='' OR b.purpose=$2) ORDER BY b.created_at DESC,b.id LIMIT 5`, userID(c), c.Query("purpose"))
}

func (a *App) importBatch(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT `+batchJSON+` FROM import_batches b WHERE b.id=$1 AND b.user_id=$2`, c.Params("id"), userID(c))
}

// stopImport leaves the links of a batch that are still waiting unread; one being read finishes.
func (a *App) stopImport(c fiber.Ctx) error {
	ctx, id := c.Context(), c.Params("id")
	e := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		r, e := tx.Exec(ctx, `UPDATE import_items i SET status='failed',error=$3,updated_at=now() FROM import_batches b
 WHERE b.id=$1 AND b.user_id=$2 AND i.batch_id=b.id AND i.status='queued'`, id, userID(c), importStopped)
		if e != nil || r.RowsAffected() == 0 {
			return e
		}
		return finishBatch(ctx, tx, id)
	})
	if e != nil {
		return e
	}
	return a.importBatch(c)
}

// finishBatch marks a batch finished once none of its items waits or is being read.
func finishBatch(ctx context.Context, q recipeWriter, batch string) error {
	_, e := q.Exec(ctx, `UPDATE import_batches SET finished_at=now() WHERE id=$1 AND finished_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM import_items WHERE batch_id=$1 AND status IN ('queued','reading'))`, batch)
	return e
}

// importItem is a batch item being read, with its batch's member and purpose, and the photo an
// own_site page gave its recipe.
type importItem struct {
	batch                              string
	position                           int
	url, pasted, owner, purpose, image string
}

// runImports reads batch items while there are any, woken when a batch starts or a recipe job
// an item waits on finishes.
func (a *App) runImports(ctx context.Context) {
	pace(ctx, a.wakeups().imports, importPace, func() bool { return a.advanceImports(ctx) })
}

// advanceImports is one pass of the import loop: items whose recipe job finished are saved,
// items whose reader stopped go back in line, then up to importRounds rounds read up to
// importReaders waiting items at once, each of another batch. It reports whether it did
// anything.
func (a *App) advanceImports(ctx context.Context) bool {
	did := a.settleImportJobs(ctx)
	did = a.recoverImports(ctx) || did
	for range importRounds {
		var wg sync.WaitGroup
		n := 0
		for n < importReaders && ctx.Err() == nil {
			it, ok := a.claimImport(ctx)
			if !ok {
				break
			}
			n++
			wg.Go(func() { a.readImport(ctx, it) })
		}
		wg.Wait()
		if n == 0 {
			break
		}
		did = true
	}
	return did
}

// claimImport takes the next item to read: the first waiting one of the unfinished batch read
// longest ago (a new one first), skipping batches with an item being read. The batch's row lock
// keeps two readers, on any replica, from taking items of one batch at once.
func (a *App) claimImport(ctx context.Context) (importItem, bool) {
	var it importItem
	e := a.DB.QueryRow(ctx, `WITH batch AS (SELECT b.id FROM import_batches b WHERE b.finished_at IS NULL
   AND EXISTS(SELECT 1 FROM import_items q WHERE q.batch_id=b.id AND q.status='queued')
   AND NOT EXISTS(SELECT 1 FROM import_items r WHERE r.batch_id=b.id AND r.status='reading' AND r.job_id IS NULL)
   ORDER BY b.read_at NULLS FIRST,b.created_at,b.id FOR UPDATE SKIP LOCKED LIMIT 1),
 next AS (SELECT i.batch_id,i.position FROM import_items i JOIN batch ON batch.id=i.batch_id WHERE i.status='queued' ORDER BY i.position LIMIT 1),
 touched AS (UPDATE import_batches b SET read_at=now() FROM batch WHERE b.id=batch.id)
 UPDATE import_items i SET status='reading',attempts=i.attempts+1,updated_at=now() FROM next, import_batches b
 WHERE i.batch_id=next.batch_id AND i.position=next.position AND b.id=i.batch_id
 RETURNING i.batch_id,i.position,i.url,i.pasted,b.user_id,b.purpose`).Scan(&it.batch, &it.position, &it.url, &it.pasted, &it.owner, &it.purpose)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) && ctx.Err() == nil {
		slog.Error("claim import", "error", e)
	}
	return it, e == nil
}

// readImport reads one item: a recipe the importer reads by itself is saved now; anything else
// is queued for the recipe model, as a single import would be, and saved when that finishes.
func (a *App) readImport(parent context.Context, it importItem) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	var read importRead
	var e error
	if it.pasted != "" {
		read = a.readPasted(it.pasted)
	} else {
		read, e = a.readRecipePage(ctx, it.url)
	}
	if e != nil {
		a.failItem(parent, it, importFailure(it, e))
		return
	}
	if read.recipe != nil {
		r := *read.recipe
		if it.purpose == "own_site" {
			a.copyOwnPhoto(ctx, it.owner, &r, read.image)
		}
		a.saveImport(parent, it, r)
		return
	}
	if !a.AI.TextEnabled() {
		message := unreadPage
		if it.pasted != "" {
			message = pastedUnread
		}
		a.failItem(parent, it, message)
		return
	}
	b, _, e := a.enqueueJobFor(parent, it.owner, batchJobKey+it.batch+"-"+strconv.Itoa(it.position), "recipe", read.prompt(), "", ai.GenerationEstimate("recipe"))
	if e != nil {
		a.failItem(parent, it, importFailure(it, e))
		return
	}
	image := ""
	if it.purpose == "own_site" {
		image = read.image
	}
	var job struct{ ID string }
	if e = json.Unmarshal(b, &job); e == nil {
		_, e = a.DB.Exec(parent, `UPDATE import_items SET job_id=$3,image=$4,updated_at=now() WHERE batch_id=$1 AND position=$2 AND status='reading'`, it.batch, it.position, job.ID, image)
	}
	if e != nil && parent.Err() == nil {
		slog.Error("import job", "batch", it.batch, "position", it.position, "error", e)
	}
}

// importFailure is what a member reads about an item that failed with e: the importer's own
// words (its errors are written for them), else that the page couldn't be opened.
func importFailure(it importItem, e error) string {
	var fe *fiber.Error
	if errors.As(e, &fe) {
		return fe.Message
	}
	slog.Warn("import failed", "batch", it.batch, "position", it.position, "error", e)
	if it.pasted != "" {
		return importUnsaved
	}
	return unopenedPage
}

// copyOwnPhoto gives a creator's own recipe the photo their page shows, copied into their
// storage: they confirmed it's theirs, and a recipe may not show it from their site
// (importedMedia). Without storage, or when the copy fails, the recipe keeps what it had.
func (a *App) copyOwnPhoto(ctx context.Context, owner string, r *RecipeInput, photo string) {
	if photo == "" || a.Media == nil || a.Media.S3 == nil || a.Media.Own(owner, r.Image) {
		return
	}
	data, e := fetchPhoto(ctx, photo)
	var url string
	if e == nil {
		url, e = a.Media.Put(ctx, owner, data)
	}
	if e != nil {
		slog.Info("own recipe photo not copied", "host", hostOf(photo), "error", e)
		return
	}
	r.Image = url
}

// fetchPhoto downloads a photo from a creator's page through the importer's guard
// (importClient): HTTPS from public addresses, at most maxOwnPhoto bytes.
func fetchPhoto(ctx context.Context, source string) ([]byte, error) {
	client, done, e := importClient(source)
	if e != nil {
		return nil, e
	}
	defer done()
	req, e := importRequest(ctx, source, "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5", nil)
	if e != nil {
		return nil, e
	}
	res, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("photo status %d", res.StatusCode)
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, maxOwnPhoto+1))
	if e == nil && len(data) > maxOwnPhoto {
		e = fmt.Errorf("photo exceeds %d bytes", maxOwnPhoto)
	}
	return data, e
}

// keepShownMedia drops the media a recipe may not show (allowedMedia).
func (a *App) keepShownMedia(r *RecipeInput) {
	keep := func(u string) string {
		if a.allowedMedia(u) {
			return u
		}
		return ""
	}
	r.Image, r.Video = keep(r.Image), keep(r.Video)
	photos := []string{}
	for _, p := range r.Photos {
		if p = keep(p); p != "" {
			photos = append(photos, p)
		}
	}
	r.Photos = photos
	for i := range r.Steps {
		r.Steps[i].Image, r.Steps[i].Video = keep(r.Steps[i].Image), keep(r.Steps[i].Video)
	}
}

var errSettled = errors.New("import item already settled")

// saveImport saves an item's recipe as its member's private draft and marks the item imported,
// unless it was settled meanwhile (by another replica). It reports false when it recorded
// instead that the item brought no recipe.
func (a *App) saveImport(parent context.Context, it importItem, r RecipeInput) bool {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 15*time.Second)
	defer cancel()
	r.Published = false
	if it.pasted != "" {
		stripMedia(&r)
	} else {
		a.keepShownMedia(&r)
	}
	if e := r.Validate(); e != nil {
		message := noRecipeOnPage
		if it.pasted != "" {
			message = pastedNoRecipe
		}
		a.failItem(ctx, it, message)
		return false
	}
	id := uuid.NewString()
	e := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if e := persistRecipe(ctx, tx, it.owner, id, r, false); e != nil {
			return e
		}
		done, e := tx.Exec(ctx, `UPDATE import_items SET status='imported',recipe_id=$3,error='',updated_at=now() WHERE batch_id=$1 AND position=$2 AND status='reading'`, it.batch, it.position, id)
		if e != nil {
			return e
		}
		if done.RowsAffected() == 0 {
			return errSettled
		}
		return finishBatch(ctx, tx, it.batch)
	})
	if errors.Is(e, errSettled) {
		return true
	}
	if e != nil {
		slog.Error("save imported recipe", "batch", it.batch, "position", it.position, "error", e)
		a.failItem(ctx, it, importUnsaved)
		return false
	}
	return true
}

// failItem records why an item brought no recipe.
func (a *App) failItem(parent context.Context, it importItem, message string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
	defer cancel()
	e := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `UPDATE import_items SET status='failed',error=$3,updated_at=now() WHERE batch_id=$1 AND position=$2 AND status IN ('queued','reading')`, it.batch, it.position, message); e != nil {
			return e
		}
		return finishBatch(ctx, tx, it.batch)
	})
	if e != nil {
		slog.Error("save failed import item", "batch", it.batch, "position", it.position, "error", e)
	}
}

// settleImportJobs saves the recipes of items whose recipe job finished, or records why it
// brought none. A job that brought nothing never counts against the member: failImport released
// it already, and releaseImportJob does for one the stalled-job sweep failed, or whose recipe
// couldn't be saved.
func (a *App) settleImportJobs(ctx context.Context) bool {
	rows, e := a.DB.Query(ctx, `SELECT i.batch_id,i.position,i.url,i.pasted,b.user_id,b.purpose,i.image,j.id,j.status,j.result,j.error FROM import_items i
 JOIN import_batches b ON b.id=i.batch_id JOIN ai_jobs j ON j.id=i.job_id WHERE i.status='reading' AND j.status IN ('completed','failed') LIMIT 50`)
	if e != nil {
		if ctx.Err() == nil {
			slog.Error("settle import jobs", "error", e)
		}
		return false
	}
	type finished struct {
		item               importItem
		job, status, cause string
		result             []byte
	}
	var done []finished
	for rows.Next() {
		var f finished
		if e = rows.Scan(&f.item.batch, &f.item.position, &f.item.url, &f.item.pasted, &f.item.owner, &f.item.purpose, &f.item.image, &f.job, &f.status, &f.result, &f.cause); e == nil {
			done = append(done, f)
		}
	}
	rows.Close()
	for _, f := range done {
		var out struct {
			Recipe *RecipeInput `json:"recipe"`
		}
		if f.status == "completed" && json.Unmarshal(f.result, &out) == nil && out.Recipe != nil {
			r := *out.Recipe
			if f.item.purpose == "own_site" {
				photo, cancel := context.WithTimeout(ctx, 30*time.Second)
				a.copyOwnPhoto(photo, f.item.owner, &r, f.item.image)
				cancel()
			}
			if a.saveImport(ctx, f.item, r) {
				continue
			}
		} else {
			switch f.cause {
			case "":
				f.cause = unreadPage
			case jobInterrupted:
				f.cause = importInterrupted
			}
			a.failItem(ctx, f.item, f.cause)
		}
		if e := a.releaseImportJob(ctx, f.job); e != nil && ctx.Err() == nil {
			slog.Error("release import job", "job", f.job, "error", e)
		}
	}
	return len(done) > 0
}

// releaseImportJob takes back what a batch item's recipe job counted against its member once the
// item brought no recipe. As in failImport, what it may have cost moves to the shared ledger, so
// the day's budgets still count it.
func (a *App) releaseImportJob(parent context.Context, id string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
	defer cancel()
	return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		var reserved float64
		e := tx.QueryRow(ctx, `WITH job AS (SELECT id,estimated_cost FROM ai_jobs WHERE id=$1 AND estimated_cost>0 FOR UPDATE)
 UPDATE ai_jobs j SET estimated_cost=0,updated_at=now() FROM job WHERE j.id=job.id RETURNING job.estimated_cost::float8`, id).Scan(&reserved)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e == nil {
			_, e = recordUsage(ctx, tx, "", "unread_import", reserved)
		}
		return e
	})
}

// recoverImports puts back in line the items whose reader stopped without a word (a server that
// stopped mid-read), or gives up on them after importAttempts.
func (a *App) recoverImports(ctx context.Context) bool {
	rows, e := a.DB.Query(ctx, `UPDATE import_items SET status=CASE WHEN attempts<$2 THEN 'queued' ELSE 'failed' END,
 error=CASE WHEN attempts<$2 THEN '' ELSE $3 END,updated_at=now()
 WHERE status='reading' AND job_id IS NULL AND updated_at<now()-$1*interval '1 second' RETURNING batch_id`, importStale.Seconds(), importAttempts, importInterrupted)
	if e != nil {
		if ctx.Err() == nil {
			slog.Error("recover imports", "error", e)
		}
		return false
	}
	batches := map[string]bool{}
	for rows.Next() {
		var batch string
		if rows.Scan(&batch) == nil {
			batches[batch] = true
		}
	}
	rows.Close()
	for batch := range batches {
		if e = finishBatch(ctx, a.DB, batch); e != nil && ctx.Err() == nil {
			slog.Error("finish import batch", "batch", batch, "error", e)
		}
	}
	return len(batches) > 0
}

// importJobDone wakes the import loops, here and on other replicas, when a recipe job an item
// waits on has finished.
func (a *App) importJobDone(ctx context.Context) {
	if _, e := a.DB.Exec(ctx, `SELECT pg_notify($1,'imports')`, workChannel); e != nil {
		slog.Warn("announce finished import job", "error", e)
	}
	a.wake("imports")
}

// similarRecipes finds published Savorly recipes like each name a member pastes (the names of
// Mealime's own recipes, which can't come over): up to three a name, through the ordinary
// search, so no AI is involved. It needs no session, so the page for Mealime's members works
// before signing up.
func (a *App) similarRecipes(c fiber.Ctx) error {
	var in struct {
		Names []string `json:"names"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	names := cleanTags(in.Names)
	switch {
	case len(names) == 0:
		return fiber.NewError(400, "Paste at least one recipe name.")
	case len(names) > maxSimilarNames:
		return fiber.NewError(400, "Look up to 25 recipes at a time.")
	}
	out := make([]fiber.Map, 0, len(names))
	for _, name := range names {
		name = clip(name, 120)
		found, e := a.similarTo(c.Context(), name, 3)
		if e != nil {
			return e
		}
		out = append(out, fiber.Map{"name": name, "recipes": found})
	}
	return c.JSON(out)
}

// fillerWords say little about what a dish is.
var fillerWords = map[string]bool{"with": true, "and": true, "the": true, "of": true, "in": true, "on": true, "for": true, "or": true,
	"easy": true, "quick": true, "simple": true, "best": true, "my": true, "style": true, "homemade": true, "healthy": true, "classic": true}

// similarSearches are the searches for recipes like name, most alike first: the whole name, its
// last two words, then each word, last first, since a dish's name usually ends with what it is
// ("Lemony chicken orzo").
func similarSearches(name string) []string {
	var words []string
	for _, w := range searchWords(name) {
		if !fillerWords[strings.ToLower(w)] && utf8.RuneCountInString(w) > 2 {
			words = append(words, w)
		}
	}
	tries := []string{name}
	if len(words) > 2 {
		tries = append(tries, strings.Join(words[len(words)-2:], " "))
	}
	if len(words) > 1 {
		for i := len(words) - 1; i >= 0; i-- {
			tries = append(tries, words[i])
		}
	}
	return cleanTags(tries)
}

// similarTo is up to n published recipes like name (similarSearches), each once.
func (a *App) similarTo(ctx context.Context, name string, n int) ([]json.RawMessage, error) {
	found := []json.RawMessage{}
	seen := map[string]bool{}
	for _, text := range similarSearches(name) {
		if len(found) >= n {
			break
		}
		sql, args, ok := recipeQuery{Text: text, Limit: n}.build()
		if !ok {
			continue
		}
		rows, e := a.DB.Query(ctx, sql, args...)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var b []byte
			if e = rows.Scan(&b); e != nil {
				break
			}
			var r struct{ ID string }
			if json.Unmarshal(b, &r) == nil && !seen[r.ID] && len(found) < n {
				seen[r.ID] = true
				found = append(found, b)
			}
		}
		rows.Close()
		if e == nil {
			e = rows.Err()
		}
		if e != nil {
			return nil, e
		}
	}
	return found, nil
}
