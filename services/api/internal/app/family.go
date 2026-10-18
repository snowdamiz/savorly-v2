package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"savorly/api/internal/ai"
)

// Family recipes in their own voice (docs/FAMILY-RECIPES.md). A member records a relative talking
// through a dish with the device's microphone and uploads it like any other media (uploads.go,
// kind "audio"). POST /recordings keeps it twice, in the public media bucket the app plays from and
// in the private source bucket, and queues an import job: speech-to-text hears it in timed
// segments, the agent model writes the transcript down in the importer's recipe schema, and the
// worker saves it as a private recipe whose steps each point at the stretch of the recording that
// says them (steps[].voice). The API image has no ffmpeg to cut compressed audio, so a recording is
// stored once and a step's clip is a start and end the player keeps to. A photo of a handwritten
// card is read the same way, the card kept as the cover. Clips only ever play what the person said:
// nothing makes speech in their voice. Publishing a recipe with a recording needs the member to
// confirm that the person agreed, and a cookbook its owner shares with the household opens their
// private recipes in it to every member.

const (
	// maxRecordingBytes is what one speech-to-text request takes; half an hour of speech at the
	// app's 64 kb/s is under 15 MB.
	maxRecordingBytes = 25 << 20
	minRecordingMs    = 3_000
	maxRecordingMs    = 30 * 60_000
	// maxRecordings bounds what one member keeps.
	maxRecordings = 200
	// clipPadding widens a step's clip either side, so no word is cut; minClipMs is the shortest
	// stretch worth a play button.
	clipPadding = 300
	minClipMs   = 1_000
	// recordingBytesPerSecond guesses the length of a recording the app couldn't time (a picked
	// file): the app records at 64 kb/s.
	recordingBytesPerSecond = 8_000
)

// recordingFormats is what speech-to-text calls each kind of recording.
var recordingFormats = map[string]string{"audio/mp4": "m4a", "audio/webm": "webm", "audio/mpeg": "mp3"}

const (
	familyOff         = "Writing down family recipes isn’t available right now. Your recording is saved; try again later."
	cardsOff          = "Reading recipe cards isn’t available right now."
	recordingNotFound = "Recording not found."
	familyFailed      = "The recipe couldn’t be written down. Your recording is saved; please try again."
	// consentNeeded refuses publishing a recipe whose recorded person's agreement isn't confirmed.
	consentNeeded = "Before publishing, confirm that the person you recorded agreed to share their voice."
)

// StepVoice is where a recording says a step: the recording, and a start and end in milliseconds.
type StepVoice struct {
	Recording string `json:"recording"`
	StartMs   int    `json:"startMs"`
	EndMs     int    `json:"endMs"`
}

// recordingJSON is a recording (alias x) as its member sees it, with the recipe it became and the
// latest job writing it down.
const recordingJSON = `jsonb_build_object('id',x.id,'speaker',x.speaker,'url',x.url,'durationMs',x.duration_ms,'language',x.language,
 'consentedAt',x.consent_at,'createdAt',x.created_at,
 'recipe',(SELECT jsonb_build_object('id',r.id,'title',r.title,'published',r.published) FROM recipes r WHERE r.id=x.recipe_id),
 'job',(SELECT jsonb_build_object('id',j.id,'status',j.status,'error',j.error) FROM ai_jobs j WHERE j.id=x.job_id))`

// recipeRecordingsJSON is recipe r's recordings, as recipeJSON carries them: what the app plays.
const recipeRecordingsJSON = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'speaker',x.speaker,'url',x.url,'durationMs',x.duration_ms,
 'consented',x.consent_at IS NOT NULL) ORDER BY x.created_at,x.id),'[]') FROM recordings x WHERE x.recipe_id=r.id)`

func (a *App) familyRoutes(v fiber.Router) {
	v.Get("/recordings", a.requireAuth, a.recordings)
	v.Post("/recordings", a.requireAuth, a.createRecording)
	v.Patch("/recordings/:id", a.requireAuth, a.updateRecording)
	v.Delete("/recordings/:id", a.requireAuth, a.deleteRecording)
	v.Post("/recordings/:id/transcribe", a.requireAuth, a.transcribeRecording)
	v.Post("/family/cards", a.requireAuth, a.readCard)
	v.Post("/recipes/:id/recording-consent", a.requireAuth, a.recordingConsent)
	v.Get("/household/cookbooks", a.requireAuth, a.householdCookbooks)
}

// recordings lists the member's recordings, newest first: those not written down yet (or whose
// recipe was deleted) as well as those that are recipes.
func (a *App) recordings(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT `+recordingJSON+` FROM recordings x WHERE x.user_id=$1 ORDER BY x.created_at DESC,x.id LIMIT $2`, userID(c), maxRecordings)
}

// cleanSpeaker is whose voice a recording is, on one line.
func cleanSpeaker(s string) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if !validText(s, 1, 60) {
		return "", fiber.NewError(400, "Say whose voice this is, in up to 60 characters.")
	}
	return s, nil
}

// createRecording keeps an uploaded recording ({ url, speaker, durationMs }) and queues writing it
// down: 201 with { recording, job }. job is null, with error saying why, when it can't be written
// down now (AI off, or the plan's allowance used); the recording is kept either way, for later.
// durationMs may be 0 for a file the app couldn't time; its size stands in until speech-to-text
// says.
func (a *App) createRecording(c fiber.Ctx) error {
	var in struct {
		URL        string `json:"url"`
		Speaker    string `json:"speaker"`
		DurationMs int    `json:"durationMs"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	speaker, e := cleanSpeaker(in.Speaker)
	if e != nil {
		return e
	}
	if in.DurationMs != 0 && (in.DurationMs < minRecordingMs || in.DurationMs > maxRecordingMs) {
		return fiber.NewError(400, "Record between 3 seconds and 30 minutes.")
	}
	if a.Media == nil || a.Media.S3 == nil || a.Media.BaseURL == "" || a.Media.SourceBucket == "" {
		return fiber.NewError(503, "Media storage has not been configured.")
	}
	ctx, owner := c.Context(), userID(c)
	key, mime, ok := a.recordingUpload(owner, in.URL)
	if !ok {
		return fiber.NewError(400, "Upload the recording to Savorly first.")
	}
	// An app retrying a lost answer gets the recording it already made.
	var id string
	e = a.DB.QueryRow(ctx, `SELECT id FROM recordings WHERE url=$1 AND user_id=$2`, in.URL, owner).Scan(&id)
	if e == nil {
		return a.sendRecording(c, 200, id, nil, "")
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	var kept int
	if e = a.DB.QueryRow(ctx, `SELECT count(*) FROM recordings WHERE user_id=$1`, owner).Scan(&kept); e != nil {
		return e
	}
	if kept >= maxRecordings {
		return fiber.NewError(409, "You’ve kept 200 family recordings. Delete one to record another.")
	}
	audio, e := a.readUpload(ctx, key, mime)
	if e != nil {
		return e
	}
	if in.DurationMs == 0 {
		in.DurationMs = min(max(len(audio)/recordingBytesPerSecond*1000, minRecordingMs), maxRecordingMs)
	}
	// The private copy, which only the API reads: if the public one is ever lost, this one isn't.
	id = uuid.NewString()
	source := "recordings/" + owner + "/" + id + path.Ext(key)
	if e = a.Media.ensureSourceBucket(ctx, a.Config.Production); e != nil {
		return e
	}
	if _, e = a.Media.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(source), Body: bytes.NewReader(audio),
		ContentLength: aws.Int64(int64(len(audio))), ContentType: aws.String(mime), CacheControl: aws.String("private,no-store")}); e != nil {
		return e
	}
	if _, e = a.DB.Exec(ctx, `INSERT INTO recordings(id,user_id,speaker,url,source_key,mime,bytes,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		id, owner, speaker, in.URL, source, mime, len(audio), in.DurationMs); e != nil {
		// Nothing points at the private copy now.
		if _, d := a.DB.Exec(context.WithoutCancel(ctx), `INSERT INTO source_deletions(object_key) VALUES($1) ON CONFLICT DO NOTHING`, source); d != nil {
			slog.Warn("queue an unsaved recording's copy", "error", d)
		}
		if pgCode(e) == "23505" {
			return fiber.NewError(409, "This recording is already saved.")
		}
		return e
	}
	job, e := a.queueRecording(c, id, speaker, in.DurationMs)
	return a.sendRecording(c, 201, id, job, jobRefusal(e))
}

// jobRefusal is e's message when it's one the member should read (an allowance or budget, AI off),
// "" for none; an unexpected error is logged.
func jobRefusal(e error) string {
	var fe *fiber.Error
	if e == nil {
		return ""
	}
	if errors.As(e, &fe) {
		return fe.Message
	}
	slog.Error("queue a family recipe", "error", e)
	return familyFailed
}

func (a *App) sendRecording(c fiber.Ctx, status int, id string, job []byte, refused string) error {
	var b []byte
	if e := a.DB.QueryRow(c.Context(), `SELECT `+recordingJSON+` FROM recordings x WHERE x.id=$1`, id).Scan(&b); e != nil {
		return e
	}
	out := fiber.Map{"recording": json.RawMessage(b), "job": nil}
	if job != nil {
		out["job"] = json.RawMessage(job)
	}
	if refused != "" {
		out["error"] = refused
	}
	return c.Status(status).JSON(out)
}

// recordingUpload is the storage key and type of a recording owner uploaded directly, or false.
func (a *App) recordingUpload(owner, url string) (key, mime string, ok bool) {
	key, ok = strings.CutPrefix(url, a.Media.BaseURL+"/")
	name, mine := strings.CutPrefix(key, uploadPrefix(owner))
	if !ok || !mine || !uploadName.MatchString(name) {
		return "", "", false
	}
	for m, ext := range uploadTypes["audio"] {
		if ext == path.Ext(name) {
			return key, m, true
		}
	}
	return "", "", false
}

// readUpload reads a recording from the media bucket, checking that its bytes are what its name
// says.
func (a *App) readUpload(ctx context.Context, key, mime string) ([]byte, error) {
	out, e := a.Media.S3.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(a.Media.Bucket), Key: aws.String(key)})
	if storageNotFound(e) {
		return nil, fiber.NewError(400, "Upload the recording to Savorly first.")
	}
	if e != nil {
		return nil, e
	}
	defer out.Body.Close()
	audio, e := io.ReadAll(io.LimitReader(out.Body, maxRecordingBytes+1))
	if e != nil {
		return nil, e
	}
	if len(audio) > maxRecordingBytes {
		return nil, fiber.NewError(400, "Choose a recording smaller than 25 MB.")
	}
	if audioType(audio) != mime {
		return nil, fiber.NewError(400, wrongRecording)
	}
	return audio, nil
}

// queueRecording queues the job that writes recording id down, reserving for its length, and
// notes it on the recording.
func (a *App) queueRecording(c fiber.Ctx, id, speaker string, durationMs int) ([]byte, error) {
	if !a.AI.TextEnabled() {
		return nil, fiber.NewError(503, familyOff)
	}
	key := c.Get("Idempotency-Key")
	if key == "" {
		key = "family-" + uuid.NewString()
	}
	job, _, e := a.enqueueEstimated(c, key, "recipe", recordingPrompt(id, speaker), "", ai.RecordingEstimate(float64(durationMs)/1000))
	if e != nil {
		return nil, e
	}
	var queued struct{ ID string }
	if e = json.Unmarshal(job, &queued); e != nil {
		return nil, e
	}
	_, e = a.DB.Exec(c.Context(), `UPDATE recordings SET job_id=$2 WHERE id=$1`, id, queued.ID)
	return job, e
}

// transcribeRecording writes down again a recording that isn't a recipe (its job failed, AI was
// off, or its recipe was deleted): 202 with the job, or 200 with the one still running.
func (a *App) transcribeRecording(c fiber.Ctx) error {
	var speaker, status string
	var duration int
	var attached bool
	e := a.DB.QueryRow(c.Context(), `SELECT x.speaker,x.duration_ms,x.recipe_id IS NOT NULL,COALESCE(j.status,'') FROM recordings x LEFT JOIN ai_jobs j ON j.id=x.job_id
 WHERE x.id=$1 AND x.user_id=$2`, c.Params("id"), userID(c)).Scan(&speaker, &duration, &attached, &status)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, recordingNotFound)
	}
	if e != nil {
		return e
	}
	if attached {
		return fiber.NewError(409, "This recording is already a recipe.")
	}
	if inFlight(status) {
		return a.queryOne(c, `SELECT `+jobJSON+` FROM ai_jobs WHERE id=(SELECT job_id FROM recordings WHERE id=$1)`, c.Params("id"))
	}
	job, e := a.queueRecording(c, c.Params("id"), speaker, duration)
	if e != nil {
		return e
	}
	return c.Status(202).Type("json").Send(job)
}

// updateRecording renames whose voice a recording is ({ speaker }), as the family calls them.
func (a *App) updateRecording(c fiber.Ctx) error {
	var in struct {
		Speaker string `json:"speaker"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	speaker, e := cleanSpeaker(in.Speaker)
	if e != nil {
		return e
	}
	var b []byte
	e = a.DB.QueryRow(c.Context(), `UPDATE recordings x SET speaker=$3 WHERE x.id=$1 AND x.user_id=$2 RETURNING `+recordingJSON, c.Params("id"), userID(c), speaker).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, recordingNotFound)
	}
	if e != nil {
		return e
	}
	return c.Type("json").Send(b)
}

// deleteRecording deletes a recording, both copies of it (the trigger in 037_family_recipes.sql),
// and its clips from its recipe's steps.
func (a *App) deleteRecording(c fiber.Ctx) error {
	ctx := c.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var recipe *string
	e = tx.QueryRow(ctx, `DELETE FROM recordings WHERE id=$1 AND user_id=$2 RETURNING recipe_id`, c.Params("id"), userID(c)).Scan(&recipe)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, recordingNotFound)
	}
	if e != nil {
		return e
	}
	if recipe != nil {
		if _, e = tx.Exec(ctx, `UPDATE recipes SET steps=(SELECT COALESCE(jsonb_agg(CASE WHEN s->'voice'->>'recording'=$2 THEN s-'voice' ELSE s END ORDER BY n),'[]')
 FROM jsonb_array_elements(steps) WITH ORDINALITY x(s,n)),updated_at=now() WHERE id=$1`, *recipe, c.Params("id")); e != nil {
			return e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// readCard queues reading a photo of a recipe card the member uploaded ({ url }) into a private
// recipe with the card as its cover: 202 with the job.
func (a *App) readCard(c fiber.Ctx) error {
	var in struct {
		URL string `json:"url"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	owner := userID(c)
	if ext := path.Ext(in.URL); a.Media == nil || !a.Media.Own(owner, in.URL) || (ext != ".jpg" && ext != ".png" && ext != ".webp") {
		return fiber.NewError(400, "Upload a photo of the card first.")
	}
	if !a.AI.TextEnabled() {
		return fiber.NewError(503, cardsOff)
	}
	key := c.Get("Idempotency-Key")
	if key == "" {
		key = "card-" + uuid.NewString()
	}
	// The card is the job's source too, so storage keeps it while the job is in the member's history.
	job, queued, e := a.enqueueEstimated(c, key, "recipe", cardPrompt(in.URL), in.URL, ai.CardEstimate())
	if e != nil {
		return e
	}
	if queued {
		c.Status(202)
	}
	return c.Type("json").Send(job)
}

// recordingConsent records that the person in the recipe's recordings agreed to their voice being
// published, as confirmed by its author ({ agreed: true }), and answers the recordings.
func (a *App) recordingConsent(c fiber.Ctx) error {
	var in struct {
		Agreed bool `json:"agreed"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if !in.Agreed {
		return fiber.NewError(400, "Confirm that the person you recorded agreed.")
	}
	ctx, id, me := c.Context(), c.Params("id"), userID(c)
	var mine bool
	if e := a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recipes WHERE id=$1 AND author_id=$2)`, id, me).Scan(&mine); e != nil {
		return e
	}
	if !mine {
		return fiber.NewError(404, "Recipe not found.")
	}
	if _, e := a.DB.Exec(ctx, `UPDATE recordings SET consent_by=$2,consent_at=now() WHERE recipe_id=$1 AND consent_at IS NULL`, id, me); e != nil {
		return e
	}
	return a.queryOne(c, `SELECT jsonb_build_object('recordings',`+recipeRecordingsJSON+`) FROM recipes r WHERE r.id=$1`, id)
}

// recordingConsentHold refuses a write that would publish a recipe with a recording whose
// person's agreement its author hasn't confirmed. Like moderationHold, it runs inside the write's
// transaction, before writing.
func recordingConsentHold(ctx context.Context, q querier, recipe, author string, publish bool) error {
	if !publish {
		return nil
	}
	var waiting bool
	if e := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recordings WHERE recipe_id=$1 AND user_id=$2 AND consent_at IS NULL)`, recipe, author).Scan(&waiting); e != nil {
		return e
	}
	if waiting {
		return fiber.NewError(409, consentNeeded)
	}
	return nil
}

// keepStepVoices gives steps that didn't name a voice the voice of the saved step with the same
// text, or else of the step in the same place with the same title, as keepStepMedia does for
// photos and clips: an app or the sous-chef that doesn't know voices never drops them.
func keepStepVoices(steps, saved []Step) {
	byText := map[string]*StepVoice{}
	for _, s := range saved {
		if s.Voice != nil {
			byText[strings.TrimSpace(s.Text)] = s.Voice
		}
	}
	for i := range steps {
		if steps[i].voiceSet {
			continue
		}
		if v, ok := byText[strings.TrimSpace(steps[i].Text)]; ok {
			steps[i].Voice = v
		} else if i < len(saved) && saved[i].Voice != nil && strings.EqualFold(strings.TrimSpace(saved[i].Title), strings.TrimSpace(steps[i].Title)) {
			steps[i].Voice = saved[i].Voice
		}
	}
}

// fitStepVoices keeps a step's voice only when it's a stretch of one of recipe's own recordings,
// within it and long enough to play; any other is dropped, so a copied step never plays someone
// else's recording.
func fitStepVoices(ctx context.Context, q recipeWriter, recipe string, steps []Step) error {
	voiced := false
	for _, s := range steps {
		voiced = voiced || s.Voice != nil
	}
	if !voiced {
		return nil
	}
	var ids []string
	var lengths []int32
	if e := q.QueryRow(ctx, `SELECT COALESCE(array_agg(id),'{}'),COALESCE(array_agg(duration_ms),'{}') FROM recordings WHERE recipe_id=$1`, recipe).Scan(&ids, &lengths); e != nil {
		return e
	}
	duration := map[string]int{}
	for i, id := range ids {
		duration[id] = int(lengths[i])
	}
	for i := range steps {
		v := steps[i].Voice
		if v == nil {
			continue
		}
		length, ok := duration[v.Recording]
		fitted := StepVoice{Recording: v.Recording, StartMs: max(v.StartMs, 0), EndMs: min(v.EndMs, length)}
		if !ok || fitted.EndMs-fitted.StartMs < minClipMs {
			steps[i].Voice = nil
		} else {
			steps[i].Voice = &fitted
		}
	}
	return nil
}

// Family jobs are import jobs (kind recipe) whose prompt names what to write down after
// "Context:", which the sous-chef history leaves out: its first line is what the member sees.
const (
	recordingPromptStart   = "Write down the recipe "
	cardPromptStart        = "Read the recipe on a family recipe card."
	familyRecordingContext = "\n\nContext: family recording "
	familyCardContext      = "\n\nContext: family card "
)

func recordingPrompt(id, speaker string) string {
	return recordingPromptStart + speaker + " tells in a recording." + familyRecordingContext + id
}

func cardPrompt(url string) string {
	return cardPromptStart + familyCardContext + url
}

// familyJob is what a family job writes down: a recording (its id) or a card (its photo's URL).
type familyJob struct{ recording, card string }

// familyJobOf reads a family job's prompt, which only the API writes (users can't queue recipe
// jobs with a prompt of their own). It must start as one does and end with what it names, so an
// imported page's text can never read as one.
func familyJobOf(prompt string) (familyJob, bool) {
	if i := strings.LastIndex(prompt, familyRecordingContext); i >= 0 && strings.HasPrefix(prompt, recordingPromptStart) {
		if id := prompt[i+len(familyRecordingContext):]; uuid.Validate(id) == nil {
			return familyJob{recording: id}, true
		}
	}
	if url, ok := strings.CutPrefix(prompt, cardPromptStart+familyCardContext); ok && url != "" && !strings.ContainsAny(url, " \t\r\n") {
		return familyJob{card: url}, true
	}
	return familyJob{}, false
}

// errJobEnded is a family job that an admin's cancellation, or the stalled-job sweep, ended while
// it ran: its outcome stands, and the recipe isn't saved.
var errJobEnded = errors.New("the job ended while it ran")

// processFamilyJob writes a recording or card down and saves the recipe, completing the job in the
// same transaction. Like any import, one that brings no recipe never counts against the member
// (failImport).
func (a *App) processFamilyJob(parent context.Context, id, owner string, job familyJob) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Minute)
	defer cancel()
	var w written
	var err error
	if job.card != "" {
		w, err = a.writeDownCard(ctx, owner, job.card)
	} else {
		w, err = a.writeDownRecording(ctx, owner, job.recording)
	}
	if err == nil {
		err = a.saveFamilyRecipe(parent, id, owner, job, w)
	}
	if err == nil || errors.Is(err, errJobEnded) {
		return
	}
	slog.Error("family recipe failed", "job", id, "error", err)
	message := familyJobError(job.card != "", errors.Is(err, errNoRecipe))
	if parent.Err() != nil {
		message = jobInterrupted // The worker is stopping.
	}
	a.failImport(parent, id, message, w.called)
}

// familyJobError is what a family job that brought no recipe tells the member: about a card or a
// recording, and whether it held no recipe or something else went wrong.
// l10n: shown to members
func familyJobError(card, noRecipe bool) string {
	switch {
	case card && noRecipe:
		return "We couldn’t read a recipe on that card. Try a sharper photo in good light."
	case card:
		return "The card couldn’t be read. Please try again."
	case noRecipe:
		return "We couldn’t find a recipe in that recording. You can record it again, or write it down yourself."
	}
	return familyFailed
}

// written is a recipe a family job wrote down, with what it cost.
type written struct {
	recipe RecipeInput
	// The recording's length, from what speech-to-text heard when it said.
	durationMs int
	// called says the provider was asked; spent is what it reported, unless a request reported
	// nothing (unknown), when the reservation stands.
	called, unknown bool
	spent           float64
}

// note adds a provider request's reported cost.
func (w *written) note(cost float64) {
	w.called = true
	if cost > 0 {
		w.spent += cost
	} else {
		w.unknown = true
	}
}

func (a *App) writeDownRecording(ctx context.Context, owner, id string) (written, error) {
	var w written
	var speaker, url, source, mime, language string
	var segments []ai.Segment
	var attached bool
	e := a.DB.QueryRow(ctx, `SELECT speaker,url,source_key,mime,duration_ms,transcript,language,recipe_id IS NOT NULL FROM recordings WHERE id=$1 AND user_id=$2`, id, owner).
		Scan(&speaker, &url, &source, &mime, &w.durationMs, &segments, &language, &attached)
	if e != nil {
		return w, e
	}
	if attached {
		return w, errors.New("the recording is already a recipe")
	}
	if !a.AI.TextEnabled() {
		return w, errors.New("text AI is not configured")
	}
	heard := ai.Transcript{Segments: segments, Language: language}
	// A recording heard before (its recipe failed, or was deleted) isn't transcribed again.
	if len(heard.Segments) == 0 {
		audio, e := a.recordingAudio(ctx, source, url)
		if e != nil {
			return w, e
		}
		var cost float64
		heard, cost, e = a.AI.Transcribe(ctx, audio, recordingFormats[mime], "")
		if !errors.Is(e, ai.ErrNotSent) {
			w.note(cost)
		}
		if e != nil {
			if len(heard.Segments) == 0 && heard.Text == "" && !errors.Is(e, ai.ErrNotSent) && cost > 0 {
				e = errors.Join(errNoRecipe, e)
			}
			return w, e
		}
		// The provider's length is the recording's; without one, it runs at least to its last word.
		if heard.Duration > 0 {
			w.durationMs = int(math.Ceil(heard.Duration * 1000))
		}
		w.durationMs = max(w.durationMs, int(math.Ceil(heard.Segments[len(heard.Segments)-1].End*1000)))
		if _, e = a.DB.Exec(ctx, `UPDATE recordings SET transcript=$2,language=$3,duration_ms=$4 WHERE id=$1`, id, jsonBytes(heard.Segments), heard.Language, w.durationMs); e != nil {
			return w, e
		}
	}
	raw, cost, e := a.AI.FamilyRecipe(ctx, heard, speaker)
	w.note(cost)
	if e != nil {
		return w, e
	}
	var out struct {
		Recipe *struct {
			RecipeInput
			Steps []ai.FamilyStep `json:"steps"`
		} `json:"recipe"`
	}
	if e = json.Unmarshal(raw, &out); e != nil || out.Recipe == nil {
		return w, errors.Join(errNoRecipe, e)
	}
	w.recipe = out.Recipe.RecipeInput
	w.recipe.Steps = make([]Step, len(out.Recipe.Steps))
	for i, s := range out.Recipe.Steps {
		w.recipe.Steps[i] = Step{Title: s.Title, Text: s.Text, Seconds: s.Seconds, Voice: clipOf(id, s, heard.Segments, w.durationMs)}
	}
	if w.recipe.Language == "" {
		w.recipe.Language = heard.Language
	}
	return w, finishWritten(&w.recipe, "")
}

// recordingAudio reads a recording to transcribe: the private copy, else the public one.
func (a *App) recordingAudio(ctx context.Context, source, url string) ([]byte, error) {
	if a.Media == nil || a.Media.S3 == nil {
		return nil, fiber.NewError(503, "Media storage has not been configured.")
	}
	in := &s3.GetObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(source)}
	out, e := a.Media.S3.GetObject(ctx, in)
	if storageNotFound(e) {
		slog.Warn("a recording's private copy is missing", "key", source)
		in = &s3.GetObjectInput{Bucket: aws.String(a.Media.Bucket), Key: aws.String(strings.TrimPrefix(url, a.Media.BaseURL+"/"))}
		out, e = a.Media.S3.GetObject(ctx, in)
	}
	if e != nil {
		return nil, e
	}
	defer out.Body.Close()
	return io.ReadAll(io.LimitReader(out.Body, maxRecordingBytes))
}

// clipOf is the stretch of a recording that the transcript segments step names say, padded a
// little either side so no word is cut, within the recording; nil when they aren't segments of
// it, or say too little to play.
func clipOf(recording string, step ai.FamilyStep, heard []ai.Segment, durationMs int) *StepVoice {
	first, last, ok := step.Span()
	if !ok || last >= len(heard) {
		return nil
	}
	v := StepVoice{Recording: recording, StartMs: max(int(heard[first].Start*1000)-clipPadding, 0),
		EndMs: min(int(math.Ceil(heard[last].End*1000))+clipPadding, durationMs)}
	if v.EndMs-v.StartMs < minClipMs {
		return nil
	}
	return &v
}

func (a *App) writeDownCard(ctx context.Context, owner, url string) (written, error) {
	var w written
	if !a.AI.TextEnabled() {
		return w, errors.New("text AI is not configured")
	}
	photo, e := a.Media.Read(ctx, owner, url, 20<<20)
	if e != nil {
		return w, e
	}
	mime, _ := mediaType(photo)
	if !strings.HasPrefix(mime, "image/") {
		return w, errors.New("the card is not a supported photo")
	}
	if small, resized := fitPhoto(photo); resized {
		photo, mime = small, "image/jpeg"
	}
	raw, cost, e := a.AI.CardRecipe(ctx, "data:"+mime+";base64,"+base64.StdEncoding.EncodeToString(photo))
	w.note(cost)
	if e != nil {
		return w, e
	}
	var out struct {
		Recipe *RecipeInput `json:"recipe"`
	}
	if e = json.Unmarshal(raw, &out); e != nil || out.Recipe == nil {
		return w, errors.Join(errNoRecipe, e)
	}
	w.recipe = *out.Recipe
	for i := range w.recipe.Steps {
		w.recipe.Steps[i].Voice = nil
	}
	return w, finishWritten(&w.recipe, url)
}

// finishWritten makes what a model wrote down a private recipe of the member's own: AI-written,
// with no media but the cover (a card's photo, or none), crediting no page or original.
func finishWritten(r *RecipeInput, cover string) error {
	r.AIGenerated, r.Published = true, false
	r.SourceURL, r.DerivedFrom = nil, RecipeRef{}
	r.Image, r.Video, r.Photos = cover, "", []string{}
	for i := range r.Steps {
		r.Steps[i].Image, r.Steps[i].Video = "", ""
	}
	r.Equipment = fitEquipment(r.Equipment)
	if _, ok := recipeLanguage(r.Language); !ok {
		r.Language = ""
	}
	if e := r.Validate(); e != nil {
		return errors.Join(errNoRecipe, e)
	}
	return nil
}

// saveFamilyRecipe saves a written-down recipe as the member's private recipe, gives it its
// recording, and completes the job with { recipeId, title }, settling the job's reservation to
// what the provider reported, all at once.
func (a *App) saveFamilyRecipe(parent context.Context, job, owner string, family familyJob, w written) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 15*time.Second)
	defer cancel()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var status string
	if e = tx.QueryRow(ctx, `SELECT status FROM ai_jobs WHERE id=$1 FOR UPDATE`, job).Scan(&status); e != nil {
		return e
	}
	if !inFlight(status) {
		return errJobEnded
	}
	id := uuid.NewString()
	if family.recording != "" {
		// Its steps' voices must find the recording on the recipe (fitStepVoices); the reference is
		// checked when the transaction commits, by when the recipe exists.
		r, e := tx.Exec(ctx, `UPDATE recordings SET recipe_id=$2,duration_ms=$3 WHERE id=$1 AND user_id=$4 AND recipe_id IS NULL`, family.recording, id, w.durationMs, owner)
		if e != nil {
			return e
		}
		if r.RowsAffected() == 0 {
			return errors.New("the recording is gone or already a recipe")
		}
	}
	if e = persistRecipe(ctx, tx, owner, id, w.recipe, false); e != nil {
		return e
	}
	spent := w.spent
	if w.unknown {
		spent = 0
	}
	if _, e = tx.Exec(ctx, `UPDATE ai_jobs SET status='completed',result=$2,error='',estimated_cost=COALESCE(NULLIF($3::numeric,0),estimated_cost),updated_at=now() WHERE id=$1`,
		job, jsonBytes(fiber.Map{"recipeId": id, "title": w.recipe.Title}), spent); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

// sameHouseholdSQL is whether members a and b (SQL expressions) share a household.
func sameHouseholdSQL(a, b string) string {
	return `EXISTS(SELECT 1 FROM household_members ha JOIN household_members hb ON hb.household_id=ha.household_id WHERE ha.user_id=` + a + ` AND hb.user_id=` + b + `)`
}

// visibleRecipeSQL is whether member viewer (a SQL expression; an empty string for a guest) may
// open recipe r (an alias): published, their own, or a private one its author keeps in a cookbook
// they share with the viewer's household. Sharing never makes anything public.
func visibleRecipeSQL(r, viewer string) string {
	return `(` + r + `.published OR ` + r + `.author_id=` + viewer + ` OR EXISTS(SELECT 1 FROM saves fs JOIN collections fk ON fk.id=fs.collection_id AND fk.household AND fk.user_id=fs.user_id
 WHERE fs.recipe_id=` + r + `.id AND fs.user_id=` + r + `.author_id AND ` + sameHouseholdSQL(r+".author_id", viewer) + `))`
}

// householdCookbooks lists the cookbooks the member's household shares, theirs included, most
// recently added to first, each with its owner, what it holds for them and the photo of its newest
// pictured recipe as its cover; [] outside a household.
func (a *App) householdCookbooks(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT jsonb_build_object('id',b.id,'name',b.name,'description',b.description,'recipeCount',x.n,'cover',COALESCE(x.cover,''),
 'owner',jsonb_build_object('id',o.id,'name',o.name,'handle',o.handle,'avatar',o.avatar))
 FROM collections b JOIN users o ON o.id=b.user_id AND o.suspended_at IS NULL
 CROSS JOIN LATERAL (SELECT count(*) AS n,max(l.created_at) AS last,(array_agg(l.image ORDER BY l.created_at DESC,l.recipe_id DESC) FILTER (WHERE l.image<>''))[1] AS cover
   FROM (`+cookbookRecipesFor("$1")+`) l) x
 WHERE b.household AND `+sameHouseholdSQL("b.user_id", "$1")+` ORDER BY x.last DESC NULLS LAST,b.name,b.id LIMIT 100`, userID(c))
}
