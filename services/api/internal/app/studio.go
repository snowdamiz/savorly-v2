package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"savorly/api/internal/ai"
	"savorly/api/internal/live"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // Alpine images ship no zoneinfo; users' time zones must still resolve.
)

const projectJSON = `jsonb_build_object('id',p.id,'recipeId',p.recipe_id,
 'title',(SELECT left(content,60) FROM voice_events WHERE project_id=p.id AND role='user' ORDER BY seq LIMIT 1),'revision',p.revision,'status',p.status,'reply',p.reply,'error',p.error,'updatedAt',p.updated_at,
 'recipe',(SELECT ` + recipeJSON + recipeFrom + ` WHERE r.id=p.recipe_id),
 'voiceSession',(SELECT jsonb_build_object('id',id,'status',status) FROM voice_sessions WHERE project_id=p.id AND reserved_seconds>0 ORDER BY created_at DESC LIMIT 1),
 'busy',EXISTS(SELECT 1 FROM voice_actions WHERE project_id=p.id AND status IN ('queued','running')),
 'assets',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',v.kind,'status',j.status,'error',j.error,'url',j.result->>'url')) FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=p.id AND v.revision=p.revision),'[]'::jsonb))`

func (a *App) studioList(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT `+projectJSON+` FROM voice_projects p WHERE p.user_id=$1 ORDER BY p.updated_at DESC LIMIT 20`, userID(c))
}
func (a *App) studioGet(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT `+projectJSON+` FROM voice_projects p WHERE p.id=$1 AND p.user_id=$2`, c.Params("id"), userID(c))
}
func (a *App) studioEvents(c fiber.Ctx) error {
	after, _ := strconv.Atoi(c.Query("after", "0"))
	return a.queryMany(c, `SELECT jsonb_build_object('seq',e.seq,'role',e.role,'content',e.content,'imageCount',jsonb_array_length(e.images),'actions',e.actions,
 'recipes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'image',r.image,'minutes',r.minutes,'cuisine',r.cuisine) ORDER BY x.n),'[]') FROM jsonb_array_elements_text(e.recipes) WITH ORDINALITY x(id,n) JOIN recipes r ON r.id=x.id AND (r.published OR r.author_id=p.user_id))) FROM voice_events e JOIN voice_projects p ON p.id=e.project_id WHERE p.id=$1 AND p.user_id=$2 AND e.seq>$3 ORDER BY e.seq LIMIT 1000`, c.Params("id"), userID(c), after)
}
func (a *App) studioCreate(c fiber.Ctx) error {
	if !a.AI.TextEnabled() {
		return fiber.NewError(503, "Your sous-chef is not connected yet. The server needs an OpenRouter key.")
	}
	key := c.Get("Idempotency-Key")
	if _, e := uuid.Parse(key); e != nil {
		return fiber.NewError(400, "A UUID Idempotency-Key is required.")
	}
	_, e := a.DB.Exec(c.Context(), `INSERT INTO voice_projects(id,user_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, key, userID(c))
	if e != nil {
		return e
	}
	return a.queryOne(c, `SELECT `+projectJSON+` FROM voice_projects p WHERE p.id=$1 AND p.user_id=$2`, key, userID(c))
}
func (a *App) studioDelete(c fiber.Ctx) error {
	var active bool
	e := a.DB.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM voice_sessions WHERE project_id=$1 AND user_id=$2 AND status IN ('active','connecting'))`, c.Params("id"), userID(c)).Scan(&active)
	if e != nil {
		return e
	}
	if active {
		return fiber.NewError(409, "End the voice conversation before deleting its history.")
	}
	return a.deleteOwned(c, "voice_projects", "user_id")
}
func (a *App) studioMessage(c fiber.Ctx) error {
	var in struct {
		Text   string   `json:"text"`
		Images []string `json:"images"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Text, 1, 24000) || len(in.Images) > 4 {
		return fiber.NewError(400, "Write a message of up to 24,000 characters and attach up to four images.")
	}
	key := c.Get("Idempotency-Key")
	if len(key) < 8 || len(key) > 100 {
		return fiber.NewError(400, "An Idempotency-Key is required.")
	}
	ctx := c.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	owner := userID(c)
	project := c.Params("id")
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return e
	}
	var found string
	if e = tx.QueryRow(ctx, `SELECT id FROM voice_projects WHERE id=$1 AND user_id=$2 FOR UPDATE`, project, owner).Scan(&found); errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Conversation not found.")
	} else if e != nil {
		return e
	}
	// Text mode uses the same durable event and delegation queue as speech.
	session := "chat_" + project
	if _, e = tx.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) VALUES($1,$2,$3,'closed',0,0,true,now()) ON CONFLICT DO NOTHING`, session, project, owner); e != nil {
		return e
	}
	var priorText string
	var priorImages []byte
	e = tx.QueryRow(ctx, `SELECT content,images FROM voice_events WHERE session_id=$1 AND event_id=$2`, session, key).Scan(&priorText, &priorImages)
	if e == nil {
		if priorText != in.Text || !sameImages(priorImages, in.Images) {
			return fiber.NewError(409, "This message key was already used.")
		}
		return c.Status(202).JSON(fiber.Map{"accepted": true})
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	for _, id := range in.Images {
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voice_sources WHERE id=$1 AND project_id=$2)`, id, project).Scan(&exists); e != nil {
			return e
		}
		if !exists {
			return fiber.NewError(400, "Recipe image not found in this conversation.")
		}
	}
	var busy bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voice_actions WHERE project_id=$1 AND status IN ('queued','running'))`, project).Scan(&busy); e != nil {
		return e
	}
	if busy {
		return fiber.NewError(409, "Your sous-chef is still working. Send your next message when the reply arrives.")
	}
	var seq int64
	if e = tx.QueryRow(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content,images) VALUES($1,$2,$3,'user',$4,$5) RETURNING seq`, project, session, key, in.Text, normalizedJSON(in.Images)).Scan(&seq); e != nil {
		return e
	}
	if e = a.enqueueVoiceAction(ctx, tx, owner, project, session, key, seq); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE voice_projects SET error='',updated_at=now() WHERE id=$1`, project); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.Status(202).JSON(fiber.Map{"accepted": true})
}
func normalizedJSON(images []string) []byte {
	if images == nil {
		images = []string{}
	}
	return jsonBytes(images)
}
func (a *App) enqueueVoiceAction(ctx context.Context, tx pgx.Tx, owner, project, session, delegation string, seq int64) error {
	var exists bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voice_actions WHERE session_id=$1 AND delegation_id=$2)`, session, delegation).Scan(&exists); e != nil {
		return e
	}
	if exists {
		return nil
	}
	if e := allowance(ctx, tx, owner, "assistant"); e != nil {
		return e
	}
	var textBytes, imageCount int64
	if e := tx.QueryRow(ctx, `SELECT COALESCE(sum(octet_length(content)),0),COALESCE(sum(jsonb_array_length(images)),0) FROM voice_events WHERE project_id=$1`, project).Scan(&textBytes, &imageCount); e != nil {
		return e
	}
	// Reserve using a deliberately high token bound for long multilingual dictation
	// and up to 32K vision tokens per source photo, plus tool/schema/output overhead,
	// resent on every tool round. The worker settles it to the provider's reported cost.
	estimate := max(.05, float64(textBytes+30000+imageCount*32768)*.00000075*ai.AgentSteps+.03)
	if e := reserveGeneration(ctx, tx, owner, estimate); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,through_seq,estimated_cost) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,delegation_id) DO NOTHING`, uuid.NewString(), project, session, delegation, seq, estimate)
	return e
}
func (a *App) studioImage(c fiber.Ctx) error {
	var exists bool
	if e := a.DB.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM voice_projects WHERE id=$1 AND user_id=$2)`, c.Params("id"), userID(c)).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		return fiber.NewError(404, "Conversation not found.")
	}
	if a.Media.S3 == nil || a.Media.SourceBucket == "" {
		return fiber.NewError(503, "Private recipe photo storage is not connected yet.")
	}
	var count int
	if e := a.DB.QueryRow(c.Context(), `SELECT count(*) FROM voice_sources WHERE project_id=$1`, c.Params("id")).Scan(&count); e != nil {
		return e
	}
	if count >= 20 {
		return fiber.NewError(400, "This conversation already has 20 recipe photos. Start another conversation for more.")
	}
	file, e := c.FormFile("file")
	if e != nil {
		return fiber.NewError(400, "Choose or take a recipe photo.")
	}
	if file.Size > 10*1024*1024 {
		return fiber.NewError(400, "Choose an image smaller than 10 MB.")
	}
	f, e := file.Open()
	if e != nil {
		return e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 10*1024*1024+1))
	if e != nil {
		return e
	}
	mime, ext := mediaType(b)
	if !strings.HasPrefix(mime, "image/") || len(b) > 10*1024*1024 {
		return fiber.NewError(400, "Use a JPEG, PNG, or WebP recipe photo smaller than 10 MB.")
	}
	if e = a.Media.ensureSourceBucket(c.Context(), a.Config.Production); e != nil {
		return e
	}
	id := uuid.NewString()
	key := "recipe-sources/" + userID(c) + "/" + id + ext
	// Sources are never returned as public URLs; vision reads through authenticated S3.
	_, e = a.Media.S3.PutObject(c.Context(), &s3.PutObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(key), Body: bytes.NewReader(b), ContentType: aws.String(mime), CacheControl: aws.String("private,no-store")})
	if e != nil {
		return e
	}
	_, e = a.DB.Exec(c.Context(), `INSERT INTO voice_sources(id,project_id,object_key,mime) VALUES($1,$2,$3,$4)`, id, c.Params("id"), key, mime)
	if e != nil {
		return e
	}
	return c.Status(201).JSON(fiber.Map{"id": id})
}

type studioState struct {
	Assets json.RawMessage

	ID, Owner, RecipeID, Status string
	Revision, Confirmed         int
	Recipe                      *RecipeInput
	Conversation                []live.Message
	Images                      []string
	Through                     int64
}

func (a *App) studioState(ctx context.Context, project string, through int64) (studioState, error) {
	state := studioState{ID: project, Conversation: []live.Message{}, Images: []string{}}
	var raw []byte
	e := a.DB.QueryRow(ctx, `SELECT user_id,COALESCE(recipe_id,''),revision,confirmed_revision,status,(SELECT `+recipeJSON+recipeFrom+` WHERE r.id=p.recipe_id) FROM voice_projects p WHERE id=$1`, project).Scan(&state.Owner, &state.RecipeID, &state.Revision, &state.Confirmed, &state.Status, &raw)
	if e != nil {
		return state, e
	}
	if len(raw) > 0 {
		var recipe RecipeInput
		if e = json.Unmarshal(raw, &recipe); e != nil {
			return state, e
		}
		state.Recipe = &recipe
	}
	if e = a.DB.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',v.kind,'status',j.status,'error',j.error)),'[]'::jsonb) FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=$1 AND v.revision=$2`, project, state.Revision).Scan(&state.Assets); e != nil {
		return state, e
	}
	rows, e := a.DB.Query(ctx, `SELECT seq,role,content,images FROM voice_events WHERE project_id=$1 AND ($2::bigint=0 OR seq<=$2) ORDER BY seq`, project, through)
	if e != nil {
		return state, e
	}
	defer rows.Close()
	for rows.Next() {
		var seq int64
		var role, content string
		var images []byte
		if e = rows.Scan(&seq, &role, &content, &images); e != nil {
			return state, e
		}
		state.Through = seq
		n := len(state.Conversation)
		if n > 0 && state.Conversation[n-1].Role == role {
			state.Conversation[n-1].Content += content
		} else {
			state.Conversation = append(state.Conversation, live.Message{Role: role, Content: content})
		}
		var ids []string
		if e = json.Unmarshal(images, &ids); e != nil {
			return state, e
		}
		state.Images = append(state.Images, ids...)
	}
	return state, rows.Err()
}
func (a *App) sourceData(ctx context.Context, project string, ids []string) ([]string, error) {
	data := []string{}
	// Previous images remain available for corrections, with a documented 20-photo project bound.
	for _, id := range ids {
		var key, mime string
		if e := a.DB.QueryRow(ctx, `SELECT object_key,mime FROM voice_sources WHERE id=$1 AND project_id=$2`, id, project).Scan(&key, &mime); e != nil {
			return nil, e
		}
		if a.Media.S3 == nil {
			return nil, errors.New("storage is not configured")
		}
		result, e := a.Media.S3.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(key)})
		if e != nil {
			return nil, e
		}
		b, e := io.ReadAll(io.LimitReader(result.Body, 10*1024*1024+1))
		result.Body.Close()
		if e != nil {
			return nil, e
		}
		if len(b) > 10*1024*1024 {
			return nil, errors.New("source image too large")
		}
		data = append(data, "data:"+mime+";base64,"+base64.StdEncoding.EncodeToString(b))
	}
	return data, nil
}
func publicError(e error) string {
	var f *fiber.Error
	if errors.As(e, &f) {
		return f.Message
	}
	return "Your sous-chef couldn't finish that step. Your conversation is saved. Please try again."
}
func (a *App) processVoiceAction(ctx context.Context, id, project string, through int64) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	state, e := a.studioState(ctx, project, through)
	run := &agentRun{state: state, through: through}
	var data []string
	var input any
	if e == nil {
		data, e = a.sourceData(ctx, project, state.Images)
	}
	if e == nil {
		input, e = a.agentInput(ctx, state)
	}
	reply, cost := "", 0.0
	if e == nil {
		reply, cost, e = a.AI.Agent(ctx, input, data, agentTools, func(name string, args json.RawMessage) string { return a.agentTool(ctx, run, name, args) })
	}
	if e == nil && reply == "" {
		e = errors.New("empty assistant reply")
	}
	if e == nil && !run.reviewed {
		// An answer to an intervening question is not approval of an older review.
		_, e = a.DB.Exec(ctx, `UPDATE voice_projects SET confirmed_revision=-1 WHERE id=$1 AND revision=$2 AND confirmation_seq<=$3`, project, run.state.Revision, run.state.Through)
	}
	if e == nil && !run.proposed {
		// Likewise, a proposed action only stays open for the user's very next reply.
		_, e = a.DB.Exec(ctx, `UPDATE voice_projects SET pending=NULL WHERE id=$1`, project)
	}
	if e != nil {
		reply = publicError(e)
		if run.changed {
			reply += " Some changes were already saved, so check before asking again."
		}
	}
	reply = truncate(reply, 12000)
	// Keep the reply durable and usable in text even if the microphone was closed.
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	status := "completed"
	message := ""
	if e != nil {
		status = "failed"
		message = reply
		cost = 0 // A partial run keeps its conservative reservation.
	}
	// Settle the reservation to what the provider reported for the whole tool loop.
	_, err = tx.Exec(ctx, `UPDATE voice_actions SET status=$2,reply=$3,estimated_cost=COALESCE(NULLIF($4::numeric,0),estimated_cost),updated_at=now() WHERE id=$1`, id, status, reply, cost)
	if err != nil {
		return
	}
	actions := jsonBytes(run.actions)
	if run.actions == nil {
		actions = []byte(`[]`)
	}
	_, err = tx.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content,recipes,actions) SELECT project_id,session_id,'result_'||id,'assistant',$2,$3,$4 FROM voice_actions WHERE id=$1 ON CONFLICT DO NOTHING`, id, reply, normalizedJSON(run.recipes), actions)
	if err != nil {
		return
	}
	_, err = tx.Exec(ctx, `UPDATE voice_projects SET reply=$2,error=$3,updated_at=now() WHERE id=$1`, project, reply, message)
	if err != nil {
		return
	}
	if run.finish {
		_, err = tx.Exec(ctx, `UPDATE voice_sessions SET close_requested=true WHERE project_id=$1 AND status='active'`, project)
		if err != nil {
			return
		}
	}
	_ = tx.Commit(ctx)
}

// agentInput is everything the assistant knows at the start of a turn.
func (a *App) agentInput(ctx context.Context, state studioState) (any, error) {
	var user json.RawMessage
	var view studioView
	e := a.DB.QueryRow(ctx, `SELECT jsonb_build_object('name',u.name,'bio',u.bio,'diets',u.preferences->'diets','allergies',u.preferences->'allergies'),p.context FROM users u JOIN voice_projects p ON p.user_id=u.id WHERE p.id=$1`, state.ID).Scan(&user, &view)
	if e != nil {
		return nil, e
	}
	loc, e := time.LoadLocation(view.TimeZone)
	if e != nil || view.TimeZone == "" {
		loc = time.UTC
	}
	screen := fiber.Map{"page": view.Screen}
	if view.RecipeID != "" {
		var b []byte
		if a.DB.QueryRow(ctx, `SELECT `+recipeJSON+recipeFrom+`WHERE r.id=$1 AND (r.published OR r.author_id=$2)`, view.RecipeID, state.Owner).Scan(&b) == nil {
			var r map[string]any
			_ = json.Unmarshal(b, &r)
			author, _ := r["author"].(map[string]any)
			r["mine"] = author["id"] == state.Owner
			slimRecipe(r, false)
			screen["openRecipe"] = r
			if view.CookingStep > 0 {
				screen["cookingStep"] = view.CookingStep
			}
		}
	}
	draft := any(nil)
	if state.Recipe != nil {
		draft = fiber.Map{"recipeId": state.RecipeID, "recipe": state.Recipe, "revision": state.Revision, "status": state.Status, "media": state.Assets}
	}
	return fiber.Map{"now": time.Now().In(loc).Format("Monday 2006-01-02 15:04"), "timeZone": loc.String(), "user": user, "screen": screen, "conversation": state.Conversation, "draft": draft}, nil
}

// studioView is what the app reports the user has open. It is untrusted: the page is
// an allowlisted name and the recipe is shown only when the owner may see it.
type studioView struct {
	Screen      string `json:"screen"`
	RecipeID    string `json:"recipeId"`
	CookingStep int    `json:"cookingStep"`
	TimeZone    string `json:"timeZone"`
}

var studioScreens = map[string]bool{"discover": true, "explore": true, "saved": true, "planner": true, "pantry": true, "profile": true, "create": true, "community": true}

func (a *App) studioContext(c fiber.Ctx) error {
	var v studioView
	if e := decode(c, &v); e != nil {
		return e
	}
	if !studioScreens[v.Screen] {
		v.Screen = ""
	}
	if len(v.RecipeID) > 100 {
		v.RecipeID = ""
	}
	if v.RecipeID == "" || v.CookingStep < 0 || v.CookingStep > 40 {
		v.CookingStep = 0
	}
	if _, e := time.LoadLocation(v.TimeZone); e != nil || v.TimeZone == "Local" || len(v.TimeZone) > 64 {
		v.TimeZone = ""
	}
	r, e := a.DB.Exec(c.Context(), `UPDATE voice_projects SET context=$3 WHERE id=$1 AND user_id=$2`, c.Params("id"), userID(c), jsonBytes(v))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "Conversation not found.")
	}
	return c.SendStatus(204)
}

// applyDraftAction runs one step on this conversation's recipe draft. The application,
// not the model, gates publication: a review must be followed by a fresh user reply on
// the same revision.
func (a *App) applyDraftAction(ctx context.Context, state studioState, action string, recipe *RecipeInput, fresh bool) (string, error) {
	if action != "build" && action != "review" && action != "publish" && action != "retry_media" {
		return "", errors.New("unknown recipe action")
	}
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	// Match lock order with ordinary generation requests and session creation.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, state.Owner); e != nil {
		return "", e
	}
	var revision, confirmed int
	var confirmationSeq int64
	var lastUser int64
	var autoMedia bool
	e = tx.QueryRow(ctx, `SELECT revision,confirmed_revision,confirmation_seq,auto_media FROM voice_projects WHERE id=$1 FOR UPDATE`, state.ID).Scan(&revision, &confirmed, &confirmationSeq, &autoMedia)
	if e != nil {
		return "", e
	}
	if e = tx.QueryRow(ctx, `SELECT COALESCE(max(seq),0) FROM voice_events WHERE project_id=$1 AND role='user'`, state.ID).Scan(&lastUser); e != nil {
		return "", e
	}
	if revision != state.Revision || lastUser > state.Through {
		return "I heard your update. Let me use the latest version before changing your recipe.", nil
	}
	reply := ""
	// A recipe adopted into the chat, or edited by hand, keeps its own photos and video.
	keep := action == "build" && !autoMedia && !fresh && state.Recipe != nil
	if action == "build" {
		if recipe == nil {
			return "", fiber.NewError(400, "Include the complete recipe.")
		}
		r := *recipe
		r.Image = ""
		r.Video = ""
		r.Photos = nil
		if keep {
			r.Image, r.Video = state.Recipe.Image, state.Recipe.Video
		}
		r.AIGenerated = true
		r.Published = false
		if e = r.Validate(); e != nil {
			return "", e
		}
		id := state.RecipeID
		if id == "" || fresh {
			pending, e := draftMediaPending(ctx, tx, state.ID, revision)
			if e != nil {
				return "", e
			}
			if pending && id != "" {
				return "", fiber.NewError(409, "The current draft's photo and video are still being made. Start the new recipe in a minute, or open a new chat.")
			}
			id = uuid.NewString()
		}
		if e = persistRecipe(ctx, tx, state.Owner, id, r, id == state.RecipeID); e != nil {
			return "", e
		}
		revision++
		if _, e = tx.Exec(ctx, `UPDATE voice_projects SET recipe_id=$2,revision=$3,confirmed_revision=-1,auto_media=$4,status='draft',error='',updated_at=now() WHERE id=$1`, state.ID, id, revision, !keep); e != nil {
			return "", e
		}
		// Saving text never depends on media availability or a remaining media allowance.
		state.Recipe = &r
		state.Revision = revision
		reply = fmt.Sprintf("Saved %s as a private draft for %d servings, taking about %d minutes. The cover photo and short video are being prepared. The user can make changes, ask for a read-back, or publish.", r.Title, r.Servings, r.Minutes)
		if keep {
			reply = fmt.Sprintf("Saved %s as a private draft for %d servings, taking about %d minutes, keeping its photos and video. The user can make changes, ask for a read-back, or publish.", r.Title, r.Servings, r.Minutes)
		}
	} else if action == "review" || action == "publish" {
		if state.Recipe == nil {
			return "There's no saved draft yet. Ask for the recipe and save it first.", nil
		}
		if action == "publish" && confirmed == revision && lastUser > confirmationSeq {
			_, e = tx.Exec(ctx, `UPDATE recipes SET published=true,updated_at=now() WHERE id=$1 AND author_id=$2`, state.RecipeID, state.Owner)
			if e == nil {
				_, e = tx.Exec(ctx, `UPDATE voice_projects SET status='published',confirmed_revision=-1 WHERE id=$1`, state.ID)
			}
			reply = "The recipe is published. Any media still being prepared will appear automatically."
		} else {
			_, e = tx.Exec(ctx, `UPDATE voice_projects SET confirmed_revision=revision,confirmation_seq=$2 WHERE id=$1`, state.ID, state.Through)
			r := state.Recipe
			names := []string{}
			for _, i := range r.Ingredients {
				names = append(names, fmt.Sprintf("%g %s %s", i.Amount, i.Unit, i.Name))
			}
			directions := []string{}
			for i, step := range r.Steps {
				directions = append(directions, fmt.Sprintf("Step %d: %s", i+1, step.Text))
			}
			reply = fmt.Sprintf("Here's the draft: %s, %d servings, %d minutes. Ingredients: %s. %s Shall I publish this version, or would you like changes?", r.Title, r.Servings, r.Minutes, strings.Join(names, ", "), strings.Join(directions, " "))
			if len(reply) > 10000 {
				reply = fmt.Sprintf("%s makes %d servings in %d minutes, with %d ingredients and %d steps. %s Shall I publish this version, or would you like changes?", r.Title, r.Servings, r.Minutes, len(r.Ingredients), len(r.Steps), truncate(r.Description, 700))
			}
		}
		if e != nil {
			return "", e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return "", e
	}
	if (action == "build" && !keep) || action == "retry_media" {
		redo := "missing"
		if action == "retry_media" {
			redo = "failed"
		}
		if e = a.queueStudioAssets(ctx, state, redo); e != nil {
			return "The recipe is saved, but its media needs attention: " + publicError(e), nil
		}
		if action == "retry_media" {
			reply = "The failed media is queued again. The recipe stays saved while it finishes."
		}
	}
	return reply, nil
}
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func sameImages(raw []byte, images []string) bool {
	var prior []string
	if json.Unmarshal(raw, &prior) != nil || len(prior) != len(images) {
		return false
	}
	for i := range prior {
		if prior[i] != images[i] {
			return false
		}
	}
	return true
}
