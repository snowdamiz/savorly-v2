package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The push sender (docs/NOTIFICATIONS.md). Triggers (021_engagement.sql) write to
// notification_outbox whatever deserves a notification, whoever made the change; this loop turns
// each row into one message per recipient device, in the recipient's language, and sends the
// messages through Expo:
//   - a recipe's first publish: its author's followers (preferences.notifications.follows);
//   - a review or a comment on a recipe: its author, never for their own (reviews, comments);
//   - pantry items expiring within two days: their owner, once per item (pantry), from a pass
//     that runs once a day.
// Outbox rows and messages are claimed before they are worked on, so no two replicas send the
// same message; one whose send was cut off fails rather than risk arriving twice.

type notifier struct {
	db   *pgxpool.Pool
	expo *expoPush
}

var (
	// The sender looks for work every pushPace.base while it finds some, slowing to idle.
	pushPace = pacing{base: 2 * time.Second, idle: 30 * time.Second}
	// pantryHour is the UTC hour from which the day's pantry pass runs: mid-morning in the
	// Americas, afternoon in Europe, evening in Asia.
	pantryHour = 12
)

const (
	pushAttempts = 5
	// A retry waits pushRetry, then four times longer each time: 30 s, 2, 8 and 32 minutes.
	pushRetry   = 30 * time.Second
	pushStalled = 10 * time.Minute
	fanOutBatch = 20
	pushBatches = 5
)

// RunNotifications sends push notifications until ctx ends. With no registered devices it
// finds nothing to send.
func RunNotifications(ctx context.Context, db *pgxpool.Pool) {
	n := &notifier{db: db, expo: newExpoPush()}
	var checked, pantry time.Time
	pace(ctx, nil, pushPace, func() bool {
		found := n.fanOut(ctx)
		// Up to pushBatches requests a turn: a large following empties quickly, well within
		// Expo's 600 notifications a second.
		for range pushBatches {
			if !n.sendDue(ctx) {
				break
			}
			found = true
		}
		if time.Since(checked) >= 5*time.Minute {
			checked = time.Now()
			n.sweepStalled(ctx)
			n.checkReceipts(ctx)
		}
		if time.Since(pantry) >= 10*time.Minute {
			pantry = time.Now()
			if _, e := n.pantryPass(ctx); e != nil && ctx.Err() == nil {
				slog.Error("pantry reminders", "error", e)
			}
		}
		return found
	})
}

type outboxEvent struct {
	id                                  int64
	kind, actor, recipient, recipe, ref string
	detail                              []byte
}

type pushMessage struct {
	user, token, title, body string
	data                     []byte
}

// fanOut turns a batch of outbox rows into messages and reports whether there were any.
func (n *notifier) fanOut(ctx context.Context) bool {
	found, e := n.fanOutBatch(ctx)
	if e != nil && ctx.Err() == nil {
		slog.Error("notification fan-out", "error", e)
	}
	return found
}

func (n *notifier) fanOutBatch(ctx context.Context) (bool, error) {
	tx, e := n.db.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, `SELECT id,kind,COALESCE(actor_id,''),COALESCE(recipient_id,''),COALESCE(recipe_id,''),ref_id,detail
 FROM notification_outbox WHERE processed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, fanOutBatch)
	if e != nil {
		return false, e
	}
	events := []outboxEvent{}
	for rows.Next() {
		var ev outboxEvent
		if e = rows.Scan(&ev.id, &ev.kind, &ev.actor, &ev.recipient, &ev.recipe, &ev.ref, &ev.detail); e != nil {
			rows.Close()
			return false, e
		}
		events = append(events, ev)
	}
	rows.Close()
	if e = rows.Err(); e != nil || len(events) == 0 {
		return false, e
	}
	ids := make([]int64, 0, len(events))
	for _, ev := range events {
		ids = append(ids, ev.id)
		messages, e := composeMessages(ctx, tx, ev)
		if e != nil {
			return true, e
		}
		if len(messages) == 0 {
			continue
		}
		var users, tokens, titles, bodies, data []string
		for _, m := range messages {
			users, tokens, titles, bodies, data = append(users, m.user), append(tokens, m.token), append(titles, m.title), append(bodies, m.body), append(data, string(m.data))
		}
		if _, e = tx.Exec(ctx, `INSERT INTO push_messages(outbox_id,user_id,token,title,body,data)
 SELECT $1,u,t,ti,b,d::jsonb FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[]) AS x(u,t,ti,b,d) ON CONFLICT (outbox_id,token) DO NOTHING`,
			ev.id, users, tokens, titles, bodies, data); e != nil {
			return true, e
		}
	}
	// The messages carry the text now; the outbox keeps only what happened, for the limits on
	// review and comment notices.
	if _, e = tx.Exec(ctx, `UPDATE notification_outbox SET processed_at=now(),detail='{}' WHERE id=ANY($1)`, ids); e != nil {
		return true, e
	}
	return true, tx.Commit(ctx)
}

type pushRecipient struct{ user, token, language string }

func pushRecipients(ctx context.Context, q engagementDB, sql string, args ...any) ([]pushRecipient, error) {
	rows, e := q.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []pushRecipient{}
	for rows.Next() {
		var r pushRecipient
		if e = rows.Scan(&r.user, &r.token, &r.language); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// A member's devices, unless the member is suspended or turned this kind ($2) off.
const memberDevices = `SELECT t.user_id,t.token,COALESCE(u.preferences->>'language','') FROM users u JOIN push_tokens t ON t.user_id=u.id
 WHERE u.id=$1 AND u.suspended_at IS NULL AND (u.preferences->'notifications'->$2::text) IS DISTINCT FROM 'false'::jsonb ORDER BY t.token`

// composeMessages is what one outbox row says, to whom. What has gone since (an unpublished
// recipe, a suspended member) sends nothing.
func composeMessages(ctx context.Context, q engagementDB, ev outboxEvent) ([]pushMessage, error) {
	var detail struct {
		Rating int      `json:"rating"`
		Text   string   `json:"text"`
		Items  []string `json:"items"`
	}
	_ = json.Unmarshal(ev.detail, &detail)
	vars := noticeVars{Text: detail.Text, Rating: detail.Rating, Items: detail.Items}
	var recipients []pushRecipient
	var e error
	data := jsonBytes(map[string]string{"type": "recipe", "recipeId": ev.recipe})
	switch ev.kind {
	case "publish":
		e = q.QueryRow(ctx, `SELECT r.title,a.name FROM recipes r JOIN users a ON a.id=r.author_id AND a.suspended_at IS NULL WHERE r.id=$1 AND r.published`, ev.recipe).Scan(&vars.Title, &vars.Name)
		if e == nil {
			recipients, e = pushRecipients(ctx, q, `SELECT t.user_id,t.token,COALESCE(u.preferences->>'language','') FROM follows f
 JOIN users u ON u.id=f.user_id AND u.suspended_at IS NULL JOIN push_tokens t ON t.user_id=u.id
 WHERE f.creator_id=$1 AND f.user_id<>$1 AND (u.preferences->'notifications'->'follows') IS DISTINCT FROM 'false'::jsonb ORDER BY t.user_id,t.token`, ev.actor)
		}
	case "review", "comment":
		var author string
		e = q.QueryRow(ctx, `SELECT r.title,x.name,r.author_id FROM recipes r JOIN users x ON x.id=$2 AND x.suspended_at IS NULL
 WHERE r.id=$1 AND r.published AND r.author_id<>$2`, ev.recipe, ev.actor).Scan(&vars.Title, &vars.Name, &author)
		if e == nil {
			recipients, e = pushRecipients(ctx, q, memberDevices, author, ev.kind+"s")
		}
	case "reply":
		e = q.QueryRow(ctx, `SELECT r.title,x.name FROM recipes r JOIN users x ON x.id=r.author_id AND x.suspended_at IS NULL
 WHERE r.id=$1 AND r.published AND r.author_id=$2`, ev.recipe, ev.actor).Scan(&vars.Title, &vars.Name)
		if e == nil {
			recipients, e = pushRecipients(ctx, q, memberDevices, ev.recipient, "comments")
		}
	case "pantry":
		if len(vars.Items) > 0 {
			data = jsonBytes(map[string]string{"type": "pantry"})
			recipients, e = pushRecipients(ctx, q, memberDevices, ev.recipient, "pantry")
		}
	}
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	out := make([]pushMessage, 0, len(recipients))
	for _, r := range recipients {
		if r.user == ev.actor {
			continue // nobody hears about what they did themselves
		}
		title, body := notice(ev.kind, r.language, vars)
		out = append(out, pushMessage{user: r.user, token: r.token, title: title, body: body, data: data})
	}
	return out, nil
}

type noticeVars struct {
	Name, Title, Text string
	Rating            int
	Items             []string
}

// noticeText is one language's notifications: a title and a body for each kind, and how a
// list of pantry items is joined.
type noticeText struct {
	publish, review, comment, reply, pantry [2]string
	list                                    string
}

// noticeLanguages has the app's nine languages; any other language reads English. {name} is
// who acted, {title} the recipe, {stars} a review's rating, {text} what they wrote, and
// {items} the pantry items.
var noticeLanguages = map[string]noticeText{
	"en": {
		publish: [2]string{"New recipe from {name}", "{title}"},
		review:  [2]string{"{name} reviewed {title}", "{stars} “{text}”"},
		comment: [2]string{"{name} commented on {title}", "“{text}”"},
		reply:   [2]string{"{name} replied to your review", "“{text}”"},
		pantry:  [2]string{"Pantry reminder", "Use soon: {items}"},
		list:    ", ",
	},
	"fr": {
		publish: [2]string{"Nouvelle recette de {name}", "{title}"},
		review:  [2]string{"{name} a donné son avis sur {title}", "{stars} « {text} »"},
		comment: [2]string{"{name} a commenté {title}", "« {text} »"},
		reply:   [2]string{"{name} a répondu à votre avis", "« {text} »"},
		pantry:  [2]string{"Rappel du garde-manger", "À utiliser bientôt : {items}"},
		list:    ", ",
	},
	"de": {
		publish: [2]string{"Neues Rezept von {name}", "{title}"},
		review:  [2]string{"{name} hat {title} bewertet", "{stars} „{text}“"},
		comment: [2]string{"{name} hat {title} kommentiert", "„{text}“"},
		reply:   [2]string{"{name} hat auf deine Bewertung geantwortet", "„{text}“"},
		pantry:  [2]string{"Vorrats-Erinnerung", "Bald verbrauchen: {items}"},
		list:    ", ",
	},
	"ru": {
		publish: [2]string{"Новый рецепт от {name}", "{title}"},
		review:  [2]string{"Отзыв от {name} на «{title}»", "{stars} «{text}»"},
		comment: [2]string{"Комментарий от {name} к «{title}»", "«{text}»"},
		reply:   [2]string{"{name} ответил(а) на ваш отзыв", "«{text}»"},
		pantry:  [2]string{"Напоминание о продуктах", "Скоро истекает срок годности: {items}"},
		list:    ", ",
	},
	"es": {
		publish: [2]string{"Nueva receta de {name}", "{title}"},
		review:  [2]string{"{name} dejó una reseña de {title}", "{stars} «{text}»"},
		comment: [2]string{"{name} comentó en {title}", "«{text}»"},
		reply:   [2]string{"{name} respondió a tu reseña", "«{text}»"},
		pantry:  [2]string{"Recordatorio de la despensa", "Para usar pronto: {items}"},
		list:    ", ",
	},
	"it": {
		publish: [2]string{"Nuova ricetta di {name}", "{title}"},
		review:  [2]string{"{name} ha recensito {title}", "{stars} «{text}»"},
		comment: [2]string{"{name} ha commentato {title}", "«{text}»"},
		reply:   [2]string{"{name} ha risposto alla tua recensione", "«{text}»"},
		pantry:  [2]string{"Promemoria dispensa", "Da usare presto: {items}"},
		list:    ", ",
	},
	"pt": {
		publish: [2]string{"Nova receita de {name}", "{title}"},
		review:  [2]string{"{name} avaliou {title}", "{stars} “{text}”"},
		comment: [2]string{"{name} comentou em {title}", "“{text}”"},
		reply:   [2]string{"{name} respondeu à sua avaliação", "“{text}”"},
		pantry:  [2]string{"Lembrete da despensa", "Para usar logo: {items}"},
		list:    ", ",
	},
	"zh": {
		publish: [2]string{"{name}发布了新菜谱", "{title}"},
		review:  [2]string{"{name}评价了《{title}》", "{stars}“{text}”"},
		comment: [2]string{"{name}评论了《{title}》", "“{text}”"},
		reply:   [2]string{"{name}回复了你的评价", "“{text}”"},
		pantry:  [2]string{"食材提醒", "请尽快食用：{items}"},
		list:    "、",
	},
	"ja": {
		publish: [2]string{"{name}さんが新しいレシピを投稿しました", "{title}"},
		review:  [2]string{"{name}さんが「{title}」にレビューを書きました", "{stars}「{text}」"},
		comment: [2]string{"{name}さんが「{title}」にコメントしました", "「{text}」"},
		reply:   [2]string{"{name}さんがあなたのレビューに返信しました", "「{text}」"},
		pantry:  [2]string{"食材のお知らせ", "早めに使いましょう：{items}"},
		list:    "、",
	},
}

// notice is one notification's title and body in language (English when it isn't one of
// the nine).
func notice(kind, language string, v noticeVars) (title, body string) {
	texts, ok := noticeLanguages[language]
	if !ok {
		texts = noticeLanguages["en"]
	}
	var t [2]string
	switch kind {
	case "publish":
		t = texts.publish
	case "review":
		t = texts.review
	case "comment":
		t = texts.comment
	case "reply":
		t = texts.reply
	case "pantry":
		t = texts.pantry
	}
	rating := min(max(v.Rating, 0), 5)
	items := v.Items
	more := ""
	if len(items) > 5 {
		items, more = items[:5], " +"+strconv.Itoa(len(v.Items)-5)
	}
	r := strings.NewReplacer("{name}", truncate(v.Name, 40), "{title}", truncate(v.Title, 80), "{text}", truncate(strings.Join(strings.Fields(v.Text), " "), 120),
		"{stars}", strings.Repeat("★", rating)+strings.Repeat("☆", 5-rating), "{items}", strings.Join(items, texts.list)+more)
	return r.Replace(t[0]), r.Replace(t[1])
}

type claimedMessage struct {
	id                 int64
	token, title, body string
	data               []byte
	attempts           int
	stillTheirs        bool
}

// sendDue sends one batch of messages that are due and reports whether there was one.
func (n *notifier) sendDue(ctx context.Context) bool {
	claimed, e := n.claimMessages(ctx)
	if e != nil {
		if ctx.Err() == nil {
			slog.Error("claim push messages", "error", e)
		}
		return false
	}
	if len(claimed) == 0 {
		return false
	}
	n.deliver(ctx, claimed)
	return true
}

func (n *notifier) claimMessages(ctx context.Context) ([]claimedMessage, error) {
	rows, e := n.db.Query(ctx, `UPDATE push_messages m SET status='sending',claimed_at=now(),attempts=m.attempts+1
 WHERE m.id IN (SELECT id FROM push_messages WHERE status='queued' AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
 RETURNING m.id,m.token,m.title,m.body,m.data,m.attempts,EXISTS(SELECT 1 FROM push_tokens t WHERE t.token=m.token AND t.user_id=m.user_id)`, expoBatch)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []claimedMessage{}
	for rows.Next() {
		var m claimedMessage
		if e = rows.Scan(&m.id, &m.token, &m.title, &m.body, &m.data, &m.attempts, &m.stillTheirs); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

type pushOutcome struct {
	id                   int64
	status, ticket, note string
	delay                time.Duration
}

// retryLater queues a message again with backoff, or fails it after its last attempt.
func retryLater(m claimedMessage, why string) pushOutcome {
	if m.attempts >= pushAttempts {
		return pushOutcome{id: m.id, status: "failed", note: why}
	}
	return pushOutcome{id: m.id, status: "queued", note: why, delay: pushRetry << (2 * max(m.attempts-1, 0))}
}

func (n *notifier) deliver(ctx context.Context, claimed []claimedMessage) {
	var outcomes []pushOutcome
	var gone []string // tokens that no longer reach a device
	var batch []claimedMessage
	for _, m := range claimed {
		if !m.stillTheirs {
			// The device signed out, or someone else signed in on it, since the message was made.
			outcomes = append(outcomes, pushOutcome{id: m.id, status: "failed", note: "device no longer registered to the recipient"})
			continue
		}
		batch = append(batch, m)
	}
	if len(batch) > 0 {
		messages := make([]expoMessage, len(batch))
		for i, m := range batch {
			messages[i] = expoMessage{To: m.token, Title: m.title, Body: m.body, Data: m.data, Sound: "default"}
		}
		// A request under way finishes even while the server stops: cut off, Expo may have the
		// messages already, and a retry could deliver them twice.
		sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		tickets, e := n.expo.send(sendCtx, messages)
		cancel()
		var failure *expoFailure
		switch {
		case e == nil:
			for i, t := range tickets {
				m := batch[i]
				switch {
				case t.Status == "ok":
					outcomes = append(outcomes, pushOutcome{id: m.id, status: "sent", ticket: t.ID})
				case t.Details.Error == "DeviceNotRegistered":
					gone = append(gone, m.token)
					outcomes = append(outcomes, pushOutcome{id: m.id, status: "failed", note: "DeviceNotRegistered"})
				case t.Details.Error == "MessageRateExceeded":
					outcomes = append(outcomes, retryLater(m, "MessageRateExceeded"))
				default:
					outcomes = append(outcomes, pushOutcome{id: m.id, status: "failed", note: truncate(strings.TrimSpace(t.Details.Error+" "+t.Message), 300)})
				}
			}
		case errors.As(e, &failure) && !failure.Retry:
			slog.Error("push request refused", "status", failure.Status, "detail", failure.Detail)
			for _, m := range batch {
				outcomes = append(outcomes, pushOutcome{id: m.id, status: "failed", note: truncate(e.Error(), 300)})
			}
		default:
			slog.Warn("push request failed; retrying", "error", e)
			for _, m := range batch {
				outcomes = append(outcomes, retryLater(m, truncate(e.Error(), 300)))
			}
		}
	}
	n.finish(ctx, outcomes, gone)
}

// finish records outcomes, even while the server stops. Rows it can't record stay claimed,
// and sweepStalled fails them.
func (n *notifier) finish(ctx context.Context, outcomes []pushOutcome, gone []string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	var ids, delays []int64
	var statuses, tickets, notes []string
	for _, o := range outcomes {
		ids, delays = append(ids, o.id), append(delays, o.delay.Milliseconds())
		statuses, tickets, notes = append(statuses, o.status), append(tickets, o.ticket), append(notes, o.note)
	}
	if _, e := n.db.Exec(ctx, `UPDATE push_messages m SET status=x.status,ticket_id=x.ticket,error=x.note,
 sent_at=CASE WHEN x.status='sent' THEN now() END,next_attempt_at=now()+x.delay*interval '1 millisecond'
 FROM unnest($1::bigint[],$2::text[],$3::text[],$4::text[],$5::bigint[]) AS x(id,status,ticket,note,delay) WHERE m.id=x.id AND m.status='sending'`,
		ids, statuses, tickets, notes, delays); e != nil {
		slog.Error("record push outcomes", "error", e)
	}
	if len(gone) > 0 {
		if _, e := n.db.Exec(ctx, `DELETE FROM push_tokens WHERE token=ANY($1)`, gone); e != nil {
			slog.Error("forget unregistered devices", "error", e)
		}
	}
}

// sweepStalled fails messages a stopped server left claimed. Expo may have them already, so
// they are never sent again.
func (n *notifier) sweepStalled(ctx context.Context) {
	if _, e := n.db.Exec(ctx, `UPDATE push_messages SET status='failed',error='sending was interrupted; not retried'
 WHERE status='sending' AND claimed_at<now()-$1*interval '1 second'`, seconds(pushStalled)); e != nil && ctx.Err() == nil {
		slog.Error("push sweep", "error", e)
	}
}

// checkReceipts reads Expo's receipts for messages sent 15 minutes to a day ago (Expo keeps
// them for a day) and forgets the devices Apple or Google no longer deliver to.
func (n *notifier) checkReceipts(ctx context.Context) {
	rows, e := n.db.Query(ctx, `UPDATE push_messages m SET receipt_checked=true WHERE m.id IN (SELECT id FROM push_messages
 WHERE status='sent' AND NOT receipt_checked AND ticket_id<>'' AND sent_at<now()-interval '15 minutes' AND sent_at>now()-interval '23 hours'
 ORDER BY sent_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING m.id,m.ticket_id,m.token`, expoReceiptBatch)
	if e != nil {
		if ctx.Err() == nil {
			slog.Error("claim push receipts", "error", e)
		}
		return
	}
	type sent struct {
		id    int64
		token string
	}
	byTicket := map[string]sent{}
	var ids []int64
	var tickets []string
	for rows.Next() {
		var s sent
		var ticket string
		if rows.Scan(&s.id, &ticket, &s.token) == nil {
			byTicket[ticket] = s
			ids, tickets = append(ids, s.id), append(tickets, ticket)
		}
	}
	rows.Close()
	if len(tickets) == 0 {
		return
	}
	receipts, e := n.expo.receipts(ctx, tickets)
	if e != nil {
		// Try again on the next pass, while Expo still keeps them.
		if _, e2 := n.db.Exec(context.WithoutCancel(ctx), `UPDATE push_messages SET receipt_checked=false WHERE id=ANY($1)`, ids); e2 != nil {
			slog.Error("release push receipts", "error", e2)
		}
		if ctx.Err() == nil {
			slog.Warn("read push receipts", "error", e)
		}
		return
	}
	var gone []string
	var failedIDs []int64
	var notes []string
	for ticket, r := range receipts {
		s, ok := byTicket[ticket]
		if !ok || r.Status != "error" {
			continue
		}
		if r.Details.Error == "DeviceNotRegistered" {
			gone = append(gone, s.token)
		}
		failedIDs, notes = append(failedIDs, s.id), append(notes, truncate(strings.TrimSpace("receipt: "+r.Details.Error+" "+r.Message), 300))
	}
	if len(failedIDs) > 0 {
		if _, e = n.db.Exec(ctx, `UPDATE push_messages m SET error=x.note FROM unnest($1::bigint[],$2::text[]) AS x(id,note) WHERE m.id=x.id`, failedIDs, notes); e != nil {
			slog.Error("record push receipts", "error", e)
		}
	}
	if len(gone) > 0 {
		if _, e = n.db.Exec(ctx, `DELETE FROM push_tokens WHERE token=ANY($1)`, gone); e != nil {
			slog.Error("forget unregistered devices", "error", e)
		}
	}
}

// pantryPass reminds members, once a day from pantryHour UTC, of pantry items that expire
// today or in the next two days, mentioning each item once per expiry date. Whichever replica
// claims the day runs it. It reports how many members it reminded.
func (n *notifier) pantryPass(ctx context.Context) (int64, error) {
	tx, e := n.db.Begin(ctx)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback(ctx)
	var day time.Time
	e = tx.QueryRow(ctx, `INSERT INTO notification_runs(name,ran_on) SELECT 'pantry',(now() AT TIME ZONE 'UTC')::date WHERE extract(hour FROM now() AT TIME ZONE 'UTC')>=$1
 ON CONFLICT (name) DO UPDATE SET ran_on=excluded.ran_on WHERE notification_runs.ran_on<excluded.ran_on RETURNING ran_on`, pantryHour).Scan(&day)
	if errors.Is(e, pgx.ErrNoRows) {
		return 0, nil
	}
	if e != nil {
		return 0, e
	}
	r, e := tx.Exec(ctx, `WITH due AS (
  SELECT p.id,p.user_id,p.name,p.expires_on FROM pantry p JOIN users u ON u.id=p.user_id AND u.suspended_at IS NULL
  WHERE p.expires_on BETWEEN $1::date AND $1::date+2
   AND NOT EXISTS (SELECT 1 FROM pantry_reminders x WHERE x.pantry_id=p.id AND x.expires_on=p.expires_on)
   AND EXISTS (SELECT 1 FROM push_tokens t WHERE t.user_id=p.user_id)
   AND (u.preferences->'notifications'->'pantry') IS DISTINCT FROM 'false'::jsonb),
 noted AS (INSERT INTO pantry_reminders(pantry_id,expires_on) SELECT id,expires_on FROM due
  ON CONFLICT (pantry_id) DO UPDATE SET expires_on=excluded.expires_on,created_at=now())
INSERT INTO notification_outbox(kind,recipient_id,detail)
SELECT 'pantry',user_id,jsonb_build_object('items',jsonb_agg(name ORDER BY expires_on,name)) FROM due GROUP BY user_id`, day)
	if e != nil {
		return 0, e
	}
	return r.RowsAffected(), tx.Commit(ctx)
}
