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
	"log/slog"
	"savorly/api/internal/ai"
	"savorly/api/internal/live"
	"slices"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // Alpine images ship no zoneinfo; users' time zones must still resolve.
)

// purpose is what the app last opened the conversation for ("recipe" from Create a recipe).
// question is what the sous-chef waits for a yes to, which the app can answer with a tap: an
// action it proposed, or publishing the draft it just read back. turn is the reply on its
// way: what it is doing (step) and whether the member asked to stop it.
const projectJSON = `jsonb_build_object('id',p.id,'recipeId',p.recipe_id,'purpose',COALESCE(p.context->>'purpose',''),
 'question',` + questionSQL + `,
 'turn',(SELECT jsonb_build_object('step',a.progress,'stopping',a.cancel_requested) FROM voice_actions a WHERE a.project_id=p.id AND a.status IN ('queued','running') ORDER BY a.created_at LIMIT 1),
 'title',(SELECT left(content,60) FROM voice_events WHERE project_id=p.id AND role='user' ORDER BY seq LIMIT 1),'revision',p.revision,'status',p.status,'reply',p.reply,'error',p.error,'updatedAt',p.updated_at,
 'recipe',(SELECT ` + recipeJSON + recipeFrom + ` WHERE r.id=p.recipe_id),
 'voiceSession',(SELECT jsonb_build_object('id',id,'status',status) FROM voice_sessions WHERE project_id=p.id AND reserved_seconds>0 ORDER BY created_at DESC LIMIT 1),
 'busy',EXISTS(SELECT 1 FROM voice_actions WHERE project_id=p.id AND status IN ('queued','running')),
 'assets',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',v.kind,'status',j.status,'error',j.error,'url',j.result->>'url')) FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=p.id AND v.revision=p.revision),'[]'::jsonb))`

// questionSQL is the question waiting in voice_projects p, if any; seq identifies it.
const questionSQL = `CASE WHEN p.pending IS NOT NULL THEN jsonb_build_object('kind','action','seq',p.pending_seq,'description',p.pending->>'description')
 WHEN p.recipe_id IS NOT NULL AND p.confirmed_revision=p.revision AND p.status<>'published' THEN jsonb_build_object('kind','publish','seq',p.confirmation_seq) END`

func (a *App) studioList(c fiber.Ctx) error {
	return a.queryMany(c, `SELECT `+projectJSON+` FROM voice_projects p WHERE p.user_id=$1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 20`, userID(c))
}

// studioGet reads a conversation. With ?after=<seq> it also carries the events after it
// (events): the app reads a conversation and what's new in it with one request.
func (a *App) studioGet(c fiber.Ctx) error {
	if after := c.Query("after"); after != "" {
		seq, _ := strconv.Atoi(after)
		return a.queryOne(c, `SELECT `+projectJSON+`||jsonb_build_object('events',(SELECT COALESCE(jsonb_agg(ev.event ORDER BY ev.seq),'[]') FROM (`+studioEventsSQL+`) ev)) FROM voice_projects p WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`, c.Params("id"), userID(c), seq)
	}
	return a.queryOne(c, `SELECT `+projectJSON+` FROM voice_projects p WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`, c.Params("id"), userID(c))
}

// studioEventsSQL is conversation $1's events after seq $3, as its owner $2 sees them: up to
// 1,000, oldest first.
const studioEventsSQL = `SELECT e.seq,jsonb_build_object('seq',e.seq,'role',e.role,'content',e.content,'imageCount',jsonb_array_length(e.images),'actions',e.actions,'changed',e.changed,
 'effects',` + publicEffectsSQL + `,
 'failed',starts_with(e.event_id,'result_') AND EXISTS(SELECT 1 FROM voice_actions a WHERE a.id=substr(e.event_id,8) AND a.status='failed'),
 'recipes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'image',r.image,'minutes',r.minutes,'cuisine',r.cuisine) ORDER BY x.n),'[]') FROM jsonb_array_elements_text(e.recipes) WITH ORDINALITY x(id,n) JOIN recipes r ON r.id=x.id AND (r.published OR r.author_id=p.user_id) JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL)) event
 FROM voice_events e JOIN voice_projects p ON p.id=e.project_id WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL AND e.seq>$3 ORDER BY e.seq LIMIT 1000`

// maxConversations bounds each member's conversations. Past it, a new one erases the oldest
// that have been idle for 30 days, as deleting them would: the app lists only the 20 most
// recent, and their recipes and usage records stay. Only a member with this many active
// conversations is refused. Private source photos have a per-member cap as well.
const maxConversations, maxSourcePhotos = 200, 200

func (a *App) studioCreate(c fiber.Ctx) error {
	if !a.AI.TextEnabled() {
		return fiber.NewError(503, "Your sous-chef is not connected yet. The server needs an OpenRouter key.")
	}
	key := c.Get("Idempotency-Key")
	if _, e := uuid.Parse(key); e != nil {
		return fiber.NewError(400, "A UUID Idempotency-Key is required.")
	}
	ctx, owner := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return e
	}
	var replay bool
	var count int
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voice_projects WHERE id=$1),(SELECT count(*) FROM voice_projects WHERE user_id=$2 AND deleted_at IS NULL)`, key, owner).Scan(&replay, &count); e != nil {
		return e
	}
	if !replay && count >= maxConversations {
		var idle []string
		e = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(id),'{}') FROM (SELECT p.id FROM voice_projects p WHERE p.user_id=$1 AND p.deleted_at IS NULL AND p.updated_at<now()-interval '30 days'
 AND NOT EXISTS(SELECT 1 FROM voice_sessions s WHERE s.project_id=p.id AND s.status IN ('connecting','active','closing'))
 AND NOT EXISTS(SELECT 1 FROM voice_actions x WHERE x.project_id=p.id AND x.status IN ('queued','running'))
 ORDER BY p.updated_at LIMIT $2) x`, owner, count-maxConversations+1).Scan(&idle)
		if e == nil {
			e = eraseConversations(ctx, tx, idle)
		}
		if e != nil {
			return e
		}
		if count -= len(idle); count >= maxConversations {
			return fiber.NewError(409, "You've reached the limit of 200 sous-chef conversations. Delete older ones from the sous-chef history to start a new one.")
		}
	}
	if _, e = tx.Exec(ctx, `INSERT INTO voice_projects(id,user_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, key, owner); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return a.queryOne(c, `SELECT `+projectJSON+` FROM voice_projects p WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`, key, owner)
}

// studioDelete erases a conversation at once. Its shell (turns and voice sessions, which carry
// spend and allowance use) stays until purgeDeletedConversations, so deleting history doesn't
// give allowances back; recipes made in it stay.
func (a *App) studioDelete(c fiber.Ctx) error {
	ctx, owner := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return e
	}
	var found string
	if e = tx.QueryRow(ctx, `SELECT id FROM voice_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, c.Params("id"), owner).Scan(&found); errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "Item not found.")
	} else if e != nil {
		return e
	}
	// A live session still records transcripts, until it has closed.
	var open bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voice_sessions WHERE project_id=$1 AND status IN ('active','connecting','closing'))`, found).Scan(&open); e != nil {
		return e
	}
	if open {
		return fiber.NewError(409, "End the voice conversation before deleting its history.")
	}
	if e = eraseConversations(ctx, tx, []string{found}); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// eraseConversations deletes conversations' content at once: transcripts, private photos,
// media links, the assistant's replies, pending actions and what the app reported having
// open. What is left, a deleted shell with turns and voice sessions that carry spend and
// allowance use, stays until purgeDeletedConversations.
func eraseConversations(ctx context.Context, tx pgx.Tx, ids []string) error {
	for _, step := range []string{
		`DELETE FROM voice_events WHERE project_id=ANY($1)`,
		// A trigger queues each photo's object for deletion from the private bucket.
		`DELETE FROM voice_sources WHERE project_id=ANY($1)`,
		`DELETE FROM voice_assets WHERE project_id=ANY($1)`,
		// Queued turns never reached the provider. A running one keeps its reservation and,
		// failed here, doesn't write its answer back.
		`UPDATE voice_actions SET status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,estimated_cost=CASE WHEN status='queued' THEN 0 ELSE estimated_cost END,reply='',updated_at=now() WHERE project_id=ANY($1)`,
		`UPDATE voice_projects SET deleted_at=now(),recipe_id=NULL,reply='',error='',context='{}',pending=NULL,confirmed_revision=-1,updated_at=now() WHERE id=ANY($1)`,
	} {
		if _, e := tx.Exec(ctx, step, ids); e != nil {
			return e
		}
	}
	return nil
}

// purgeDeletedConversations removes deleted shells once their turns and voice sessions have
// left every 30-day accounting window.
func (a *App) purgeDeletedConversations(ctx context.Context) error {
	for {
		r, e := a.DB.Exec(ctx, `DELETE FROM voice_projects WHERE id IN (SELECT id FROM voice_projects WHERE deleted_at<now()-interval '35 days' LIMIT 500)`)
		if e != nil || r.RowsAffected() < 500 {
			return e
		}
	}
}
func (a *App) studioMessage(c fiber.Ctx) error {
	var in struct {
		Text   string   `json:"text"`
		Images []string `json:"images"`
		// A tap on the app's Yes or No for the question waiting at Question.
		Answer   string `json:"answer"`
		Question int64  `json:"question"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Text, 1, 24000) || len(in.Images) > 4 {
		return fiber.NewError(400, "Write a message of up to 24,000 characters and attach up to four images.")
	}
	if in.Answer != "" && in.Answer != "yes" && in.Answer != "no" {
		return fiber.NewError(400, "Answer yes or no.")
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
	if e = tx.QueryRow(ctx, `SELECT id FROM voice_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, project, owner).Scan(&found); errors.Is(e, pgx.ErrNoRows) {
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
	if in.Answer != "" {
		var asked bool
		if e = tx.QueryRow(ctx, `SELECT COALESCE((`+questionSQL+`)->>'seq'=$2::text,false) FROM voice_projects p WHERE p.id=$1`, project, strconv.FormatInt(in.Question, 10)).Scan(&asked); e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if !asked {
			return fiber.NewError(409, "That question has changed. Answer the latest one.")
		}
	}
	var seq int64
	if e = tx.QueryRow(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content,images) VALUES($1,$2,$3,'user',$4,$5) RETURNING seq`, project, session, key, in.Text, normalizedJSON(in.Images)).Scan(&seq); e != nil {
		return e
	}
	if e = a.enqueueVoiceAction(ctx, tx, owner, project, session, key, seq); e != nil {
		return e
	}
	if in.Answer != "" {
		if _, e = tx.Exec(ctx, `UPDATE voice_actions SET answer=$3,answer_seq=$4 WHERE session_id=$1 AND delegation_id=$2`, session, key, in.Answer, in.Question); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE voice_projects SET error='',updated_at=now() WHERE id=$1`, project); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	a.wake("studio")
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
	// The turn will see the same events (through seq), so it sends exactly this window.
	w, e := conversationWindow(ctx, tx, project, seq)
	if e != nil {
		return e
	}
	estimate := turnEstimate(w)
	if e := reserveGeneration(ctx, tx, owner, estimate); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO voice_actions(id,project_id,session_id,delegation_id,through_seq,estimated_cost) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,delegation_id) DO NOTHING`, uuid.NewString(), project, session, delegation, seq, estimate); e != nil {
		return e
	}
	return announce(ctx, tx, "studio")
}

// photoTokens bounds one photo's vision tokens. Photos reach the model at most photoSide
// pixels on their longest side, which current vision models read in a few thousand tokens.
const photoTokens = 8192

// turnEstimate reserves for what a turn sends, treating each byte as a token for long
// multilingual dictation: the windowed conversation and its photos, plus instructions, tool
// schemas and output, resent on every tool round. The worker settles it to the provider's
// reported cost.
func turnEstimate(w turnWindow) float64 {
	return max(.05, float64(w.Bytes+30000+len(w.Images)*photoTokens)*.00000075*ai.AgentSteps+.03)
}
func (a *App) studioImage(c fiber.Ctx) error {
	var exists bool
	if e := a.DB.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM voice_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL)`, c.Params("id"), userID(c)).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		return fiber.NewError(404, "Conversation not found.")
	}
	if a.Media.S3 == nil || a.Media.SourceBucket == "" {
		return fiber.NewError(503, "Private recipe photo storage is not connected yet.")
	}
	var count, total int
	if e := a.DB.QueryRow(c.Context(), `SELECT (SELECT count(*) FROM voice_sources WHERE project_id=$1),(SELECT count(*) FROM voice_sources s JOIN voice_projects p ON p.id=s.project_id WHERE p.user_id=$2)`, c.Params("id"), userID(c)).Scan(&count, &total); e != nil {
		return e
	}
	if count >= 20 {
		return fiber.NewError(400, "This conversation already has 20 recipe photos. Start another conversation for more.")
	}
	// Private photos stay until their conversation is deleted, so they're bounded per member too.
	if total >= maxSourcePhotos {
		return fiber.NewError(400, "You've reached the limit of 200 recipe photos kept in sous-chef conversations. Delete older conversations to add more.")
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
	if small, resized := fitPhoto(b); resized {
		b, mime, ext = small, "image/jpeg", ".jpg"
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
	// What a turn sees of the history (conversationWindow), and the last event it covers.
	Conversation []live.Message
	Images       []string
	Omitted      int
	Through      int64
}

// studioState is a conversation as a turn through the given event sees it (0: all of it).
func (a *App) studioState(ctx context.Context, project string, through int64) (studioState, error) {
	state, e := a.studioProject(ctx, project)
	if e != nil {
		return state, e
	}
	w, e := conversationWindow(ctx, a.DB, project, through)
	if e != nil {
		return state, e
	}
	state.Conversation, state.Images, state.Omitted, state.Through = w.Messages, w.Images, w.Omitted, w.Through
	return state, nil
}

// studioProject loads a conversation's owner, draft and media, without its history.
func (a *App) studioProject(ctx context.Context, project string) (studioState, error) {
	state := studioState{ID: project, Conversation: []live.Message{}, Images: []string{}}
	var raw []byte
	e := a.DB.QueryRow(ctx, `SELECT user_id,COALESCE(recipe_id,''),revision,confirmed_revision,status,(SELECT `+recipeJSON+recipeFrom+` WHERE r.id=p.recipe_id) FROM voice_projects p WHERE id=$1 AND deleted_at IS NULL`, project).Scan(&state.Owner, &state.RecipeID, &state.Revision, &state.Confirmed, &state.Status, &raw)
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
	e = a.DB.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',v.kind,'status',j.status,'error',j.error)),'[]'::jsonb) FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=$1 AND v.revision=$2`, project, state.Revision).Scan(&state.Assets)
	return state, e
}

// A turn sends the opening request and the newest messages that fit, with photos from the
// user's last two messages: re-sending all of a long conversation and every photo on every
// tool round costs more than it helps, and the draft keeps what was settled.
const windowMessages, windowBytes, windowPhotos = 40, 24000, 4

type turnWindow struct {
	Messages []live.Message
	Images   []string
	// Omitted counts the messages left out; Bytes is the text sent.
	Omitted, Bytes int
	Through        int64
}

type rowsQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func conversationWindow(ctx context.Context, q rowsQuerier, project string, through int64) (turnWindow, error) {
	w := turnWindow{Messages: []live.Message{}, Images: []string{}}
	// Consecutive events from one side (live transcripts arrive in fragments) are one message.
	rows, e := q.Query(ctx, `WITH e AS (
 SELECT seq,role,content,images,count(*) FILTER (WHERE role IS DISTINCT FROM prev) OVER (ORDER BY seq) n
 FROM (SELECT seq,role,content,images,lag(role) OVER (ORDER BY seq) prev FROM voice_events WHERE project_id=$1 AND ($2::bigint=0 OR seq<=$2)) x
), m AS (
 SELECT *,max(n) OVER () total,min(n) FILTER (WHERE role='user') OVER () opening FROM e
)
SELECT min(role),string_agg(content,'' ORDER BY seq),jsonb_agg(images ORDER BY seq),max(seq),min(total) FROM m WHERE n>total-$3 OR n=opening GROUP BY n ORDER BY n`, project, through, windowMessages)
	if e != nil {
		return w, e
	}
	type message struct {
		role, content string
		images        []string
	}
	list := []message{}
	total := 0
	for rows.Next() {
		var m message
		var images []byte
		if e = rows.Scan(&m.role, &m.content, &images, &w.Through, &total); e != nil {
			rows.Close()
			return w, e
		}
		var groups [][]string
		if e = json.Unmarshal(images, &groups); e != nil {
			rows.Close()
			return w, e
		}
		m.images = slices.Concat(groups...)
		list = append(list, m)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return w, e
	}
	// The newest message always goes, then older ones while they fit; the opening request
	// goes as well, outside the budget.
	opening := slices.IndexFunc(list, func(m message) bool { return m.role == "user" })
	keep := make([]bool, len(list))
	sent := 0
	for i := len(list) - 1; i >= 0; i-- {
		if i == opening {
			continue
		}
		if i < len(list)-1 && w.Bytes+len(list[i].content) > windowBytes {
			break
		}
		keep[i] = true
		sent++
		w.Bytes += len(list[i].content)
	}
	if opening >= 0 {
		keep[opening] = true
		sent++
		w.Bytes += len(list[opening].content)
	}
	// Photos stay with the user's last two messages even when a long message crowds their text out.
	users := 0
	for i := len(list) - 1; i >= 0 && users < 2; i-- {
		if list[i].role == "user" {
			users++
			if len(list[i].images) > 0 {
				w.Images = slices.Concat(list[i].images, w.Images)
			}
		}
	}
	w.Images = w.Images[max(0, len(w.Images)-windowPhotos):]
	for i, m := range list {
		if keep[i] {
			w.Messages = append(w.Messages, live.Message{Role: m.role, Content: m.content})
		}
	}
	w.Omitted = total - sent
	return w, nil
}
func (a *App) sourceData(ctx context.Context, project string, ids []string) ([]string, error) {
	data := []string{}
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
		// Photos stored before uploads were downscaled are shrunk on the way to the model.
		if small, resized := fitPhoto(b); resized {
			b, mime = small, "image/jpeg"
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
	return turnFailed
}

const turnFailed = "Your sous-chef couldn't finish that step. Your conversation is saved. Please try again."

// A failed turn that already changed data says so, so the next turn checks before repeating.
const turnFailedAfterChanges = "Your sous-chef couldn't finish that step, but some changes were already saved. Check them before asking again."

func (a *App) processVoiceAction(ctx context.Context, id, project string, through int64) {
	started := time.Now()
	turn, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	// The member can stop it (studioCancel) while it runs here.
	a.turns.Store(id, cancel)
	defer a.turns.Delete(id)
	state, e := a.studioState(turn, project, through)
	run := &agentRun{state: state, action: id, cancel: cancel}
	var data []string
	var input any
	if e == nil {
		// Text turns come from the conversation's own chat session; the rest from a live call.
		var session string
		e = a.DB.QueryRow(turn, `SELECT session_id FROM voice_actions WHERE id=$1`, id).Scan(&session)
		run.voice = session != "chat_"+project
	}
	if e == nil {
		data, e = a.sourceData(turn, project, state.Images)
	}
	if e == nil {
		input, e = a.agentInput(turn, state)
	}
	channel := map[bool]string{true: "voice", false: "text"}[run.voice]
	if in, ok := input.(fiber.Map); ok {
		in["channel"] = channel
	}
	run.trace = turnTrace{Model: a.AI.AgentModel, Channel: channel, Rounds: []traceRound{}}
	if e == nil {
		e = a.applyAnswer(turn, id, run, input)
	}
	// A turn that fails before reaching the model costs nothing and doesn't count.
	reply, cost, called := "", 0.0, false
	if e == nil {
		called = true
		tool := func(name string, args json.RawMessage) string {
			began := time.Now()
			out := a.agentTool(turn, run, name, args)
			run.trace.tool(name, time.Since(began), out)
			return out
		}
		reply, cost, e = a.AI.Agent(turn, input, data, agentTools, tool, ai.AgentHooks{Round: run.trace.round, Settled: screenOnly(run)})
	}
	if e == nil && reply == "" {
		e = errors.New("empty assistant reply")
	}
	if e != nil {
		var stopped bool
		_ = a.DB.QueryRow(context.WithoutCancel(ctx), `SELECT cancel_requested FROM voice_actions WHERE id=$1`, id).Scan(&stopped)
		switch {
		case stopped:
			reply = turnStopped
		case run.changed:
			reply = turnFailedAfterChanges
		default:
			slog.Warn("assistant turn failed", "action", id, "error", e)
			reply = publicError(e)
		}
	}
	run.trace.Ms = time.Since(started).Milliseconds()
	if e != nil {
		run.trace.Error = truncate(e.Error(), 300)
	}
	// The turn's own deadline (or the worker stopping) must not keep it from settling, or it
	// would stay running, refusing new messages, until the stalled-turn sweep.
	settle, done := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer done()
	if err := a.settleTurn(settle, id, project, run, truncate(reply, 12000), cost, e != nil, e != nil && !called); err != nil {
		slog.Error("settle assistant turn", "action", id, "error", err)
	}
}

// screenOnly ends a live call's turn after a round that only drove the screen, when the model
// already said what to tell the user: in app_action's say, or alongside the calls (models that
// write nothing beside a tool call still fill in its arguments). The voice model says it a model
// round sooner.
func screenOnly(run *agentRun) func(string) (string, bool) {
	calls, screen := run.calls, run.screen
	return func(content string) (string, bool) {
		only := run.calls > calls && run.calls-calls == run.screen-screen
		reply := run.say
		if reply == "" {
			reply = content
		}
		calls, screen, run.say = run.calls, run.screen, ""
		return reply, run.voice && only && reply != ""
	}
}

// applyAnswer carries out the member's tapped answer to the question waiting for it before the
// model replies, so a yes does what was described whatever the model makes of it. The model
// then only tells the member how it went (input.answered).
func (a *App) applyAnswer(ctx context.Context, id string, run *agentRun, input any) error {
	var answer string
	var question int64
	if e := a.DB.QueryRow(ctx, `SELECT answer,answer_seq FROM voice_actions WHERE id=$1`, id).Scan(&answer, &question); e != nil || answer == "" {
		return e
	}
	in, _ := input.(fiber.Map)
	if in == nil {
		return nil
	}
	var kind, description string
	var seq int64
	var raw []byte
	if e := a.DB.QueryRow(ctx, `SELECT COALESCE(q->>'kind',''),COALESCE((q->>'seq')::bigint,0),COALESCE(q->>'description',''),p.pending FROM voice_projects p,LATERAL (SELECT `+questionSQL+` q) x WHERE p.id=$1`, run.state.ID).Scan(&kind, &seq, &description, &raw); e != nil {
		return e
	}
	delete(in, "awaitingConfirmation")
	if kind == "" || seq != question {
		in["answered"] = fiber.Map{"answer": answer, "result": "That question had already changed, so nothing was done. Ask what the user would like now."}
		return nil
	}
	if kind == "publish" {
		description = "Publish the draft you just read back"
		if answer == "no" {
			_, e := a.DB.Exec(ctx, `UPDATE voice_projects SET confirmed_revision=-1 WHERE id=$1`, run.state.ID)
			in["answered"] = fiber.Map{"answer": answer, "action": description}
			return e
		}
		was, revision := run.state.Status, run.state.Revision
		result, e := a.applyDraftAction(ctx, run.state, "publish", nil, false)
		if e != nil {
			result = publicError(e)
		}
		run.reviewed = true
		a.refreshRun(ctx, run)
		a.noteDraft(run, "publish", was, revision)
		in["answered"] = fiber.Map{"answer": answer, "action": description, "result": result}
		return nil
	}
	if _, e := a.DB.Exec(ctx, `UPDATE voice_projects SET pending=NULL WHERE id=$1`, run.state.ID); e != nil {
		return e
	}
	if answer == "no" {
		in["answered"] = fiber.Map{"answer": answer, "action": description}
		return nil
	}
	var p struct {
		Tool string
		Args json.RawMessage
	}
	if json.Unmarshal(raw, &p) != nil {
		return errors.New("unreadable pending action")
	}
	run.approving = true
	result := a.agentTool(ctx, run, p.Tool, p.Args)
	run.approving = false
	in["answered"] = fiber.Map{"answer": answer, "action": description, "result": json.RawMessage(result)}
	return nil
}

// settleTurn keeps the reply durable and usable in text even if the microphone was closed,
// and settles the reservation to what the provider reported for the whole tool loop. A turn
// that never reached the provider (released) costs nothing and doesn't count as a turn.
func (a *App) settleTurn(ctx context.Context, id, project string, run *agentRun, reply string, cost float64, failed, released bool) error {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// A conversation deleted meanwhile keeps no answer; its turn was failed when it was erased.
	var kept bool
	if e = tx.QueryRow(ctx, `SELECT deleted_at IS NULL FROM voice_projects WHERE id=$1 FOR UPDATE`, project).Scan(&kept); e != nil || !kept {
		return e
	}
	status, message := "completed", ""
	if failed {
		status, message = "failed", reply
		cost = 0 // A partial run keeps its conservative reservation.
	}
	r, e := tx.Exec(ctx, `UPDATE voice_actions SET status=$2,reply=$3,estimated_cost=CASE WHEN $5 THEN 0 ELSE COALESCE(NULLIF($4::numeric,0),estimated_cost) END,trace=$6,updated_at=now() WHERE id=$1 AND status='running'`, id, status, reply, cost, released, jsonBytes(run.trace))
	if e != nil || r.RowsAffected() == 0 {
		return e // The stalled-turn sweep already answered for it.
	}
	// A failed turn's reply never showed what it read back or proposed, and the user's message
	// didn't answer an older one either: neither may be confirmed later. After a completed
	// turn, an answer to an intervening question is not approval of an older read-back, and a
	// proposed action stays open only for the user's very next reply.
	if failed || !run.reviewed {
		if _, e = tx.Exec(ctx, `UPDATE voice_projects SET confirmed_revision=-1 WHERE id=$1 AND ($2 OR (revision=$3 AND confirmation_seq<=$4))`, project, failed, run.state.Revision, run.state.Through); e != nil {
			return e
		}
	}
	if failed || !run.proposed {
		if _, e = tx.Exec(ctx, `UPDATE voice_projects SET pending=NULL WHERE id=$1`, project); e != nil {
			return e
		}
	}
	actions := jsonBytes(run.actions)
	if run.actions == nil {
		actions = []byte(`[]`)
	}
	effects := jsonBytes(run.effects)
	if run.effects == nil {
		effects = []byte(`[]`)
	}
	if _, e = tx.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content,recipes,actions,changed,effects) SELECT project_id,session_id,'result_'||id,'assistant',$2,$3,$4,$5,$6 FROM voice_actions WHERE id=$1 ON CONFLICT DO NOTHING`, id, reply, normalizedJSON(run.recipes), actions, run.changed || len(run.effects) > 0, effects); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE voice_projects SET reply=$2,error=$3,updated_at=now() WHERE id=$1`, project, reply, message); e != nil {
		return e
	}
	if run.finish {
		if _, e = tx.Exec(ctx, `UPDATE voice_sessions SET close_requested=true WHERE project_id=$1 AND status='active'`, project); e != nil {
			return e
		}
	}
	// A live call on another replica hears the reply as soon as this commits.
	if _, e = tx.Exec(ctx, `SELECT pg_notify($1,$2) FROM voice_sessions WHERE project_id=$3 AND status IN ('active','closing') LIMIT 1`, workChannel, replyPrefix+project, project); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	repliesReady(project)
	return nil
}

// agentInput is everything the assistant knows at the start of a turn.
func (a *App) agentInput(ctx context.Context, state studioState) (any, error) {
	var user json.RawMessage
	var view studioView
	var awaiting, units string
	e := a.DB.QueryRow(ctx, `SELECT jsonb_build_object('name',u.name,'bio',u.bio,'diets',u.preferences->'diets','allergies',u.preferences->'allergies'),p.context,COALESCE(p.pending->>'description',''),COALESCE(u.preferences->>'units','') FROM users u JOIN voice_projects p ON p.user_id=u.id WHERE p.id=$1`, state.ID).Scan(&user, &view, &awaiting, &units)
	if e != nil {
		return nil, e
	}
	loc, e := time.LoadLocation(view.TimeZone)
	if e != nil || view.TimeZone == "" {
		loc = time.UTC
	}
	screen := fiber.Map{"page": view.Screen}
	if view.Purpose == "recipe" {
		screen["purpose"] = "newRecipe"
	}
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
	now := time.Now().In(loc)
	input := fiber.Map{"now": now.Format("Monday 2006-01-02 15:04"), "timeZone": loc.String(), "user": user, "screen": screen, "conversation": state.Conversation, "draft": draft}
	if view.Language != "" {
		input["appLanguage"] = view.Language
	}
	if units != "" {
		input["units"] = units
	}
	// What the member's plan has left, so the assistant doesn't offer what would be refused.
	if paidPlans() {
		plan, e := planOf(ctx, a.DB, state.Owner)
		used, e2 := usageOf(ctx, a.DB, state.Owner)
		if e == nil && e2 == nil {
			input["allowances"] = fiber.Map{"plan": plan.ID, "sousChefTurnsLeft": max(0, plan.Assistant-used.Assistant), "photosLeft": max(0, plan.Images-used.Images), "videosLeft": max(0, plan.Videos-used.Videos), "photosPerMonth": plan.Images, "videosPerMonth": plan.Videos, "voiceMinutesLeft": max(0, plan.VoiceMinutes*60-used.VoiceSeconds) / 60}
		}
	}
	var kitchen, shown []byte
	if e = a.DB.QueryRow(ctx, kitchenGlanceSQL, state.Owner, now.Format("2006-01-02")).Scan(&kitchen); e != nil {
		return nil, e
	}
	input["kitchen"] = json.RawMessage(kitchen)
	if e = a.DB.QueryRow(ctx, shownRecipesSQL, state.ID, state.Owner, state.Through).Scan(&shown); e != nil {
		return nil, e
	}
	if string(shown) != "[]" {
		input["shownRecipes"] = json.RawMessage(shown)
	}
	if state.Omitted > 0 {
		input["earlierMessagesOmitted"] = state.Omitted
	}
	// The server's own words for what a yes would carry out, not the model's memory of them.
	if awaiting != "" {
		input["awaitingConfirmation"] = awaiting
	}
	if undone := a.undoneSummary(ctx, state.ID); len(undone) > 0 {
		input["undoneByUser"] = undone
	}
	return input, nil
}

// kitchenGlanceSQL is the member's ($1) week from their day $2: meals planned for the next
// seven days, groceries still to buy, the pantry with its quantities and dates (so a change to
// one item keeps the rest of it rather than guessing), and what is about to expire. get_kitchen
// has the rest, with ids.
var kitchenGlanceSQL = `SELECT jsonb_build_object(
 'planned',COALESCE((SELECT jsonb_agg(jsonb_build_object('day',p.day,'meal',p.meal,'recipe',r.title,'recipeId',r.id,'servings',p.servings) ORDER BY p.day,array_position(ARRAY['Breakfast','Lunch','Dinner'],p.meal))
   FROM meal_plans p JOIN recipes r ON r.id=p.recipe_id JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL WHERE ` + kitchenScope("p", 1) + ` AND p.day BETWEEN $2::date AND $2::date+6),'[]'),
 'toBuyCount',(SELECT count(*) FROM groceries g WHERE NOT g.checked AND ` + groceryScope(1) + `),
 'toBuy',COALESCE((SELECT jsonb_agg(name ORDER BY created_at,id) FROM (SELECT g.name,g.created_at,g.id FROM groceries g WHERE NOT g.checked AND ` + groceryScope(1) + ` ORDER BY g.created_at,g.id LIMIT 30) x),'[]'),
 'pantryCount',(SELECT count(*) FROM pantry k WHERE ` + kitchenScope("k", 1) + `),
 'pantry',COALESCE((SELECT jsonb_agg(item ORDER BY n) FROM (SELECT row_number() OVER (ORDER BY k.expires_on NULLS LAST,k.name) n,k.name||COALESCE(' ('||NULLIF(concat_ws(', ',NULLIF(k.quantity,''),'expires '||to_char(k.expires_on,'YYYY-MM-DD')),'')||')','') item FROM pantry k WHERE ` + kitchenScope("k", 1) + ` ORDER BY k.expires_on NULLS LAST,k.name LIMIT 40) x),'[]'),
 'expiringSoon',COALESCE((SELECT jsonb_agg(name||' ('||to_char(expires_on,'YYYY-MM-DD')||')' ORDER BY expires_on,name) FROM (SELECT k.name,k.expires_on FROM pantry k WHERE ` + kitchenScope("k", 1) + ` AND k.expires_on BETWEEN $2::date AND $2::date+3 ORDER BY k.expires_on,k.name LIMIT 10) x),'[]'))`

// shownRecipesSQL is the recipe cards conversation $1's replies through event $3 showed, newest
// first and each once, as the member ($2) may see them, so "the second one" resolves.
const shownRecipesSQL = `WITH cards AS (
 SELECT DISTINCT ON (x.id) x.id,e.seq,x.n FROM voice_events e CROSS JOIN LATERAL jsonb_array_elements_text(e.recipes) WITH ORDINALITY x(id,n)
 WHERE e.project_id=$1 AND e.role='assistant' AND jsonb_typeof(e.recipes)='array' AND ($3::bigint=0 OR e.seq<=$3) ORDER BY x.id,e.seq DESC
), recent AS (SELECT * FROM cards ORDER BY seq DESC,n LIMIT 12)
SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title) ORDER BY c.seq DESC,c.n),'[]') FROM recent c JOIN recipes r ON r.id=c.id AND (r.published OR r.author_id=$2) JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL`

// studioView is what the app reports the user has open. It is untrusted: the page is
// an allowlisted name and the recipe is shown only when the owner may see it.
type studioView struct {
	Screen      string `json:"screen"`
	RecipeID    string `json:"recipeId"`
	CookingStep int    `json:"cookingStep"`
	TimeZone    string `json:"timeZone"`
	// The app's interface language, for the few replies the server writes itself.
	Language string `json:"language,omitempty"`
	// Why the app opened the conversation, when it knows: "recipe" from Create a recipe, to add
	// a new recipe of the user's own.
	Purpose string `json:"purpose,omitempty"`
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
	if _, known := interruptedReplies[v.Language]; !known {
		v.Language = ""
	}
	if v.Purpose != "recipe" {
		v.Purpose = ""
	}
	r, e := a.DB.Exec(c.Context(), `UPDATE voice_projects SET context=$3 WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, c.Params("id"), userID(c), jsonBytes(v))
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
	e = tx.QueryRow(ctx, `SELECT revision,confirmed_revision,confirmation_seq,auto_media FROM voice_projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, state.ID).Scan(&revision, &confirmed, &confirmationSeq, &autoMedia)
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
		r.AIGenerated = true
		r.Published = false
		if state.RecipeID != "" && !fresh {
			// A draft write would take a live recipe offline without asking; changing a
			// published recipe goes through edit_recipe and the user's confirmation.
			var published, generated bool
			if e = tx.QueryRow(ctx, `SELECT published,ai_generated FROM recipes WHERE id=$1 AND author_id=$2`, state.RecipeID, state.Owner).Scan(&published, &generated); e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return "", e
			}
			if published {
				return "", fiber.NewError(409, "This recipe is published, so a draft can't replace it. Change it with edit_recipe, which asks the user first, or start a separate draft with new_recipe.")
			}
			if keep {
				// An adopted recipe keeps its own photos, video and authorship.
				r.Image, r.Video, r.AIGenerated = state.Recipe.Image, state.Recipe.Video, generated
			}
		}
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
		// What media is coming, and what the user can do next, follow once the media is queued.
		reply = fmt.Sprintf("Saved %s as a private draft for %d servings, taking about %d minutes.", r.Title, r.Servings, r.Minutes)
		if keep {
			reply = fmt.Sprintf("Saved %s as a private draft for %d servings, taking about %d minutes, keeping its photos and video. The user can make changes, ask for a read-back, or publish.", r.Title, r.Servings, r.Minutes)
		}
	} else if action == "review" || action == "publish" {
		if state.Recipe == nil {
			return "There's no saved draft yet. Ask for the recipe and save it first.", nil
		}
		answered := false
		if action == "publish" && confirmed == revision {
			if answered, e = answeredAfter(ctx, tx, state.ID, confirmationSeq, state.Through); e != nil {
				return "", e
			}
		}
		if answered {
			// An admin's unpublish holds the recipe private; say so instead of failing the turn.
			var held *fiber.Error
			if e = moderationHold(ctx, tx, state.RecipeID, state.Owner, true); errors.As(e, &held) && held.Code == 403 {
				return "This recipe can't be published: an admin took it out of public view, so it stays private until an admin restores it. Tell the user, and that they can contact Savorly support if they think this is a mistake. Edits to the private draft still work.", nil
			} else if e != nil {
				return "", e
			}
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
			equipment := ""
			if len(r.Equipment) > 0 {
				equipment = " Equipment: " + strings.Join(r.Equipment, ", ") + "."
			}
			reply = fmt.Sprintf("Here's the draft: %s, %d servings, %d minutes. Ingredients: %s.%s %s Shall I publish this version, or would you like changes?", r.Title, r.Servings, r.Minutes, strings.Join(names, ", "), equipment, strings.Join(directions, " "))
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
			return reply + " Its media needs attention: " + publicError(e) + draftNext, nil
		}
		if action == "retry_media" {
			reply = "The failed media is queued again. The recipe stays saved while it finishes."
		}
	}
	if action == "build" && !keep {
		note, e := a.draftMediaNote(ctx, state.ID, state.Revision)
		if e != nil {
			return "", e
		}
		reply += note + draftNext
	}
	return reply, nil
}

const draftNext = " The user can make changes, ask for a read-back, or publish."

// draftMediaNote says which of a draft's media is on its way, from the jobs that actually
// started for that revision: a plan without video, or a used-up allowance, gets no promise.
func (a *App) draftMediaNote(ctx context.Context, project string, revision int) (string, error) {
	rows, e := a.DB.Query(ctx, `SELECT v.kind,j.status,j.error FROM voice_assets v JOIN ai_jobs j ON j.id=v.job_id WHERE v.project_id=$1 AND v.revision=$2 ORDER BY v.kind`, project, revision)
	if e != nil {
		return "", e
	}
	defer rows.Close()
	coming, refused := []string{}, []string{}
	for rows.Next() {
		var kind, status, reason string
		if e = rows.Scan(&kind, &status, &reason); e != nil {
			return "", e
		}
		name := map[string]string{"image": "cover photo", "video": "short video"}[kind]
		if status == "failed" {
			refused = append(refused, fmt.Sprintf("No %s is being made: %s", name, reason))
		} else {
			coming = append(coming, name)
		}
	}
	if e = rows.Err(); e != nil {
		return "", e
	}
	note := ""
	switch len(coming) {
	case 1:
		note = fmt.Sprintf(" Its %s is being prepared.", coming[0])
	case 2:
		note = " Its cover photo and short video are being prepared."
	}
	for _, r := range refused {
		note += " " + strings.TrimSuffix(r, ".") + "."
	}
	if note == "" {
		note = " No AI photo or video is being made for it."
	}
	return note, nil
}

// answeredAfter reports whether the member spoke after hearing a question the turn that ended
// at since put to them, up to through. The answer must follow the reply that asked; in a live
// call it must also follow the start of the assistant reading that reply out, so words said
// while it was still working, or before it spoke, aren't taken as a yes.
func answeredAfter(ctx context.Context, q querier, project string, since, through int64) (bool, error) {
	var answered bool
	e := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voice_events u,
 (SELECT min(seq) r FROM voice_events WHERE project_id=$1 AND role='assistant' AND starts_with(event_id,'result_') AND seq>$2) asked
 WHERE u.project_id=$1 AND u.role='user' AND u.seq>asked.r AND u.seq<=$3
 AND (starts_with(u.session_id,'chat_') OR EXISTS(SELECT 1 FROM voice_events s WHERE s.project_id=$1 AND s.role='assistant' AND s.seq>asked.r AND s.seq<u.seq)))`, project, since, through).Scan(&answered)
	return answered, e
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
