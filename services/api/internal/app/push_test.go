package app

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fakeExpo stands in for Expo's push API: it records what it is sent and answers every message
// with an ok ticket, unless reply says otherwise.
type fakeExpo struct {
	*httptest.Server
	mu       sync.Mutex
	requests [][]expoMessage
	headers  []http.Header
	// reply answers one /send request; a nil body means an ok ticket for every message.
	reply    func(messages []expoMessage) (int, any)
	receipts map[string]expoTicket
	asked    [][]string
	delay    time.Duration
}

func newFakeExpo(t *testing.T) *fakeExpo {
	t.Helper()
	x := &fakeExpo{receipts: map[string]expoTicket{}}
	x.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(x.delay)
		x.mu.Lock()
		defer x.mu.Unlock()
		x.headers = append(x.headers, r.Header.Clone())
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/send":
			var messages []expoMessage
			if json.NewDecoder(r.Body).Decode(&messages) != nil {
				w.WriteHeader(400)
				return
			}
			x.requests = append(x.requests, messages)
			status, body := 200, any(nil)
			if x.reply != nil {
				status, body = x.reply(messages)
			}
			if body == nil {
				tickets := []expoTicket{}
				for _, m := range messages {
					tickets = append(tickets, expoTicket{Status: "ok", ID: "ticket-" + m.To})
				}
				body = map[string]any{"data": tickets}
			}
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(body)
		case "/getReceipts":
			var in struct{ IDs []string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			x.asked = append(x.asked, in.IDs)
			out := map[string]expoTicket{}
			for _, id := range in.IDs {
				if receipt, ok := x.receipts[id]; ok {
					out[id] = receipt
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": out})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(x.Close)
	return x
}

func (x *fakeExpo) notifier(db *pgxpool.Pool) *notifier {
	return &notifier{db: db, expo: &expoPush{base: x.URL, token: "test-access-token", client: x.Client()}}
}

// sent is every message Expo was sent, by token.
func (x *fakeExpo) sent() map[string][]expoMessage {
	x.mu.Lock()
	defer x.mu.Unlock()
	out := map[string][]expoMessage{}
	for _, r := range x.requests {
		for _, m := range r {
			out[m.To] = append(out[m.To], m)
		}
	}
	return out
}

func (x *fakeExpo) requestSizes() []int {
	x.mu.Lock()
	defer x.mu.Unlock()
	sizes := []int{}
	for _, r := range x.requests {
		sizes = append(sizes, len(r))
	}
	return sizes
}

// drain fans out everything waiting and sends whatever is due.
func drain(t *testing.T, n *notifier) {
	t.Helper()
	ctx := context.Background()
	for n.fanOut(ctx) {
	}
	for n.sendDue(ctx) {
	}
}

func deviceToken(user string) string { return "ExponentPushToken[" + user + "]" }

// payload is a message's data.
func payload(m expoMessage) map[string]string {
	out := map[string]string{}
	_ = json.Unmarshal(m.Data, &out)
	return out
}

func registerDevice(t *testing.T, db *pgxpool.Pool, user string) {
	t.Helper()
	if _, e := db.Exec(context.Background(), `INSERT INTO push_tokens(token,user_id,platform) VALUES($1,$2,'ios')`, deviceToken(user), user); e != nil {
		t.Fatal(e)
	}
}

func setPreferences(t *testing.T, db *pgxpool.Pool, user, prefs string) {
	t.Helper()
	if _, e := db.Exec(context.Background(), `UPDATE users SET preferences=preferences||$2::jsonb WHERE id=$1`, user, prefs); e != nil {
		t.Fatal(e)
	}
}

func followCook(t *testing.T, db *pgxpool.Pool, fan, cook string) {
	t.Helper()
	if _, e := db.Exec(context.Background(), `INSERT INTO follows(user_id,creator_id) VALUES($1,$2)`, fan, cook); e != nil {
		t.Fatal(e)
	}
}

func messageStates(t *testing.T, db *pgxpool.Pool) map[string]string {
	t.Helper()
	rows, e := db.Query(context.Background(), `SELECT token,status||'/'||attempts FROM push_messages ORDER BY id`)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var token, state string
		if e = rows.Scan(&token, &state); e != nil {
			t.Fatal(e)
		}
		out[token] = state
	}
	return out
}

func TestPushTokensFollowTheirDevice(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "ana")
	testUser(t, db, "ben")
	f := recipesApp(db, false)
	ana, ben := bearerFor(t, db, "ana"), bearerFor(t, db, "ben")
	device := map[string]string{"token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "platform": "ios"}
	owner := func() string {
		t.Helper()
		var user string
		_ = db.QueryRow(context.Background(), `SELECT COALESCE((SELECT user_id FROM push_tokens WHERE token=$1),'')`, device["token"]).Scan(&user)
		return user
	}
	for _, bad := range []map[string]string{{}, {"token": "abc", "platform": "ios"}, {"token": device["token"], "platform": "web"}, {"token": "ExponentPushToken[]", "platform": "android"}} {
		if status, b := callAPI(t, f, "PUT", "/v1/me/push-token", ana, bad); status != 400 {
			t.Errorf("%v: %d %s", bad, status, b)
		}
	}
	if status, b := callAPI(t, f, "PUT", "/v1/me/push-token", ana, device); status != 204 {
		t.Fatalf("register: %d %s", status, b)
	}
	if n := count(t, db, `SELECT count(*) FROM push_tokens WHERE user_id='ana' AND platform='ios' AND session_hash=$1`, hashToken(ana)); n != 1 {
		t.Fatalf("registered %d", n)
	}
	// The newest member to register a device gets its notifications.
	if status, _ := callAPI(t, f, "PUT", "/v1/me/push-token", ben, map[string]string{"token": device["token"], "platform": "android"}); status != 204 || owner() != "ben" {
		t.Fatalf("moved device: %d %s", status, owner())
	}
	if status, _ := callAPI(t, f, "DELETE", "/v1/me/push-token", ana, map[string]string{"token": device["token"]}); status != 204 || owner() != "ben" {
		t.Fatalf("someone else's device was forgotten: %d %s", status, owner())
	}
	if status, _ := callAPI(t, f, "DELETE", "/v1/me/push-token", ben, map[string]string{"token": device["token"]}); status != 204 || owner() != "" {
		t.Fatalf("forget: %d %s", status, owner())
	}
	// Signing out stops the device's notifications.
	callAPI(t, f, "PUT", "/v1/me/push-token", ana, device)
	if status, _ := callAPI(t, f, "POST", "/v1/auth/logout", ana, nil); status != 204 || owner() != "" {
		t.Fatalf("after sign-out: %d %q", status, owner())
	}
	// Each member keeps their ten most recently registered devices.
	for i := range 12 {
		if status, b := callAPI(t, f, "PUT", "/v1/me/push-token", ben, map[string]string{"token": fmt.Sprintf("ExponentPushToken[device%02d]", i), "platform": "android"}); status != 204 {
			t.Fatalf("device %d: %d %s", i, status, b)
		}
	}
	if n := count(t, db, `SELECT count(*) FROM push_tokens WHERE user_id='ben' AND token NOT IN ('ExponentPushToken[device00]','ExponentPushToken[device01]')`); n != 10 {
		t.Fatalf("kept %d devices", n)
	}
}

func TestNotificationTriggers(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, u := range []string{"chef", "fan", "critic"} {
		testUser(t, db, u)
	}
	outbox := func() []string {
		t.Helper()
		rows, e := db.Query(ctx, `SELECT kind||':'||COALESCE(recipe_id,'')||':'||COALESCE(actor_id,'')||CASE WHEN processed_at IS NULL THEN '' ELSE ':done' END FROM notification_outbox ORDER BY id`)
		if e != nil {
			t.Fatal(e)
		}
		defer rows.Close()
		out := []string{}
		for rows.Next() {
			var s string
			if e = rows.Scan(&s); e != nil {
				t.Fatal(e)
			}
			out = append(out, s)
		}
		return out
	}
	expectOutbox := func(want ...string) {
		t.Helper()
		if got := outbox(); !slices.Equal(got, want) {
			t.Fatalf("outbox:\n%q\nwant\n%q", got, want)
		}
	}
	// A recipe is announced the first time it is published, whoever writes it.
	publishRecipe(t, db, "chef", "draft", func(r *RecipeInput) { r.Published = false })
	expectOutbox()
	for _, published := range []bool{true, false, true} {
		if _, e := db.Exec(ctx, `UPDATE recipes SET published=$1 WHERE id='draft'`, published); e != nil {
			t.Fatal(e)
		}
	}
	publishRecipe(t, db, "chef", "tart", nil)
	expectOutbox("publish:draft:chef", "publish:tart:chef")

	// A review tells the author once a day per reviewer; their own never.
	review := func(user, id string) {
		t.Helper()
		if _, e := db.Exec(ctx, `INSERT INTO reviews(id,user_id,recipe_id,rating,body) VALUES($1,$2,'tart',5,'Lovely.')`, id, user); e != nil {
			t.Fatal(e)
		}
	}
	detail := func(want string) {
		t.Helper()
		var got string
		if e := db.QueryRow(ctx, `SELECT detail::text FROM notification_outbox WHERE kind='review' ORDER BY id DESC LIMIT 1`).Scan(&got); e != nil || got != want {
			t.Fatalf("review detail %s %v, want %s", got, e, want)
		}
	}
	review("fan", "r1")
	detail(`{"text": "Lovely.", "rating": 5}`)
	if _, e := db.Exec(ctx, `DELETE FROM reviews WHERE id='r1'`); e != nil {
		t.Fatal(e)
	}
	// Withdrawn, it keeps no text.
	detail(`{}`)
	review("fan", "r2")
	review("chef", "r3")
	expectOutbox("publish:draft:chef", "publish:tart:chef", "review:tart:fan:done")
	// A review deleted before it was sent tells no one; one written later does.
	review("critic", "r4")
	expectOutbox("publish:draft:chef", "publish:tart:chef", "review:tart:fan:done", "review:tart:critic")
	if _, e := db.Exec(ctx, `UPDATE notification_outbox SET created_at=created_at-interval '2 days' WHERE kind='review'; DELETE FROM reviews WHERE id IN ('r2','r4')`); e != nil {
		t.Fatal(e)
	}
	review("fan", "r5")
	expectOutbox("publish:draft:chef", "publish:tart:chef", "review:tart:fan:done", "review:tart:critic:done", "review:tart:fan")

	// Comments (018_social.sql) tell the author once an hour per commenter; their own never.
	comments := commentsFor(t, db)
	if _, e := db.Exec(ctx, `DELETE FROM notification_outbox`); e != nil {
		t.Fatal(e)
	}
	first := comments.add("fan", "tart", "Can I use limes?")
	comments.add("fan", "tart", "Never mind, I did.")
	comments.add("chef", "tart", "Of course!")
	expectOutbox("comment:tart:fan")
	comments.remove("chef", first)
	expectOutbox("comment:tart:fan:done")
}

// commentHelper writes comments through the API that 018_social.sql adds, or, before that
// migration exists, into a stand-in table with this migration's triggers attached.
type commentHelper struct {
	add    func(user, recipe, body string) string
	remove func(user, id string)
}

func commentsFor(t *testing.T, db *pgxpool.Pool) commentHelper {
	t.Helper()
	ctx := context.Background()
	var exists bool
	if e := db.QueryRow(ctx, `SELECT to_regclass(format('%I.comments',current_schema())) IS NOT NULL`).Scan(&exists); e != nil {
		t.Fatal(e)
	}
	if exists {
		f := recipesApp(db, false)
		tokens := map[string]string{}
		session := func(user string) string {
			if tokens[user] == "" {
				tokens[user] = bearerFor(t, db, user)
			}
			return tokens[user]
		}
		return commentHelper{
			add: func(user, recipe, body string) string {
				t.Helper()
				status, b := callAPI(t, f, "POST", "/v1/recipes/"+recipe+"/comments", session(user), map[string]string{"body": body})
				var c struct{ ID string }
				if status != 201 || json.Unmarshal(b, &c) != nil {
					t.Fatalf("comment: %d %s", status, b)
				}
				return c.ID
			},
			remove: func(user, id string) {
				t.Helper()
				if status, b := callAPI(t, f, "DELETE", "/v1/comments/"+id, session(user), nil); status != 204 {
					t.Fatalf("delete comment: %d %s", status, b)
				}
			},
		}
	}
	if _, e := db.Exec(ctx, `CREATE TABLE comments(id text PRIMARY KEY, recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id text, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
 SELECT attach_social_triggers()`); e != nil {
		t.Fatal(e)
	}
	return commentHelper{
		add: func(user, recipe, body string) string {
			t.Helper()
			id := uuid.NewString()
			if _, e := db.Exec(ctx, `INSERT INTO comments(id,recipe_id,user_id,body) VALUES($1,$2,$3,$4)`, id, recipe, user, body); e != nil {
				t.Fatal(e)
			}
			return id
		},
		remove: func(_, id string) {
			t.Helper()
			if _, e := db.Exec(ctx, `DELETE FROM comments WHERE id=$1`, id); e != nil {
				t.Fatal(e)
			}
		},
	}
}

func TestPushReachesFollowersInTheirLanguage(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "chef", "Ana")
	fans := []string{"fan_en", "fan_fr", "fan_ja", "fan_ru", "fan_xx", "fan_off"}
	for _, u := range append(fans, "stranger") {
		namedUser(t, db, u, "Fan")
		registerDevice(t, db, u)
	}
	for _, u := range fans {
		followCook(t, db, u, "chef")
	}
	registerDevice(t, db, "chef")
	setPreferences(t, db, "fan_fr", `{"language":"fr"}`)
	setPreferences(t, db, "fan_ja", `{"language":"ja"}`)
	setPreferences(t, db, "fan_ru", `{"language":"ru"}`)
	setPreferences(t, db, "fan_xx", `{"language":"xx"}`)
	setPreferences(t, db, "fan_off", `{"language":"fr","notifications":{"follows":false}}`)
	expo := newFakeExpo(t)
	n := expo.notifier(db)
	drain(t, n)
	if len(expo.requestSizes()) != 0 {
		t.Fatal("sent something with nothing to say")
	}
	publishRecipe(t, db, "chef", "tart", func(r *RecipeInput) { r.Title = "Lemon tart" })
	drain(t, n)
	sent := expo.sent()
	want := map[string]string{
		deviceToken("fan_en"): "New recipe from Ana",
		deviceToken("fan_xx"): "New recipe from Ana",
		deviceToken("fan_fr"): "Nouvelle recette de Ana",
		deviceToken("fan_ja"): "Anaさんが新しいレシピを投稿しました",
		deviceToken("fan_ru"): "Новый рецепт от Ana",
	}
	if len(sent) != len(want) {
		t.Fatalf("sent to %d devices: %v", len(sent), sent)
	}
	for token, title := range want {
		m := sent[token]
		if len(m) != 1 || m[0].Title != title || m[0].Body != "Lemon tart" || m[0].Sound != "default" || !maps.Equal(payload(m[0]), map[string]string{"type": "recipe", "recipeId": "tart"}) {
			t.Errorf("%s: %+v", token, m)
		}
	}
	if auth := expo.headers[0].Get("Authorization"); auth != "Bearer test-access-token" {
		t.Errorf("authorization %q", auth)
	}
	if n := count(t, db, `SELECT count(*) FROM push_messages WHERE status='sent' AND ticket_id LIKE 'ticket-%' AND sent_at IS NOT NULL`); n != 5 {
		t.Fatalf("%d messages recorded as sent", n)
	}
	// Published again, a recipe isn't announced again.
	if _, e := db.Exec(ctx, `UPDATE recipes SET published=false WHERE id='tart'; UPDATE recipes SET published=true WHERE id='tart'`); e != nil {
		t.Fatal(e)
	}
	drain(t, n)
	if got := len(expo.requestSizes()); got != 1 {
		t.Fatalf("%d requests after republishing", got)
	}
}

func TestPushTicketErrorsAndRetries(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "chef", "Ana")
	for _, u := range []string{"ok", "gone", "busy", "big"} {
		testUser(t, db, u)
		registerDevice(t, db, u)
		followCook(t, db, u, "chef")
	}
	expo := newFakeExpo(t)
	n := expo.notifier(db)
	busy := 0
	expo.reply = func(messages []expoMessage) (int, any) {
		tickets := []expoTicket{}
		for _, m := range messages {
			var t expoTicket
			switch m.To {
			case deviceToken("gone"):
				t.Status, t.Message, t.Details.Error = "error", "not a registered push notification recipient", "DeviceNotRegistered"
			case deviceToken("busy"):
				if busy++; busy == 1 {
					t.Status, t.Details.Error = "error", "MessageRateExceeded"
				} else {
					t.Status, t.ID = "ok", "ticket-busy"
				}
			case deviceToken("big"):
				t.Status, t.Message, t.Details.Error = "error", "Message too big", "MessageTooBig"
			default:
				t.Status, t.ID = "ok", "ticket-"+m.To
			}
			tickets = append(tickets, t)
		}
		return 200, map[string]any{"data": tickets}
	}
	publishRecipe(t, db, "chef", "tart", nil)
	drain(t, n)
	want := map[string]string{deviceToken("ok"): "sent/1", deviceToken("gone"): "failed/1", deviceToken("busy"): "queued/1", deviceToken("big"): "failed/1"}
	if got := messageStates(t, db); !maps.Equal(got, want) {
		t.Fatalf("after the first send: %v", got)
	}
	// Expo says the device is gone: it is forgotten.
	if n := count(t, db, `SELECT count(*) FROM push_tokens WHERE token=$1`, deviceToken("gone")); n != 0 {
		t.Fatal("an unregistered device was kept")
	}
	var wait float64
	if e := db.QueryRow(ctx, `SELECT extract(epoch FROM next_attempt_at-now()) FROM push_messages WHERE token=$1`, deviceToken("busy")).Scan(&wait); e != nil || wait < 25 || wait > 35 {
		t.Fatalf("first retry in %v s: %v", wait, e)
	}
	// Not yet due, then due.
	drain(t, n)
	if _, e := db.Exec(ctx, `UPDATE push_messages SET next_attempt_at=now() WHERE status='queued'`); e != nil {
		t.Fatal(e)
	}
	drain(t, n)
	if got := messageStates(t, db)[deviceToken("busy")]; got != "sent/2" {
		t.Fatalf("retried message: %s", got)
	}
	if got := len(expo.sent()[deviceToken("busy")]); got != 2 {
		t.Fatalf("busy device got %d sends", got)
	}

	// A refused request (Expo answers 5xx) is retried with longer waits, then given up.
	expo.reply = func([]expoMessage) (int, any) {
		return 503, map[string]any{"errors": []map[string]string{{"code": "INTERNAL", "message": "down"}}}
	}
	publishRecipe(t, db, "chef", "pie", nil)
	waits := []float64{}
	for range pushAttempts {
		drain(t, n)
		var w float64
		if e := db.QueryRow(ctx, `SELECT extract(epoch FROM next_attempt_at-now()) FROM push_messages WHERE token=$1 AND outbox_id=(SELECT max(id) FROM notification_outbox)`, deviceToken("ok")).Scan(&w); e != nil {
			t.Fatal(e)
		}
		waits = append(waits, w)
		if _, e := db.Exec(ctx, `UPDATE push_messages SET next_attempt_at=now() WHERE status='queued'`); e != nil {
			t.Fatal(e)
		}
	}
	for i, want := range []float64{30, 120, 480, 1920} {
		if waits[i] < want-5 || waits[i] > want+5 {
			t.Fatalf("waits %v", waits)
		}
	}
	if n := count(t, db, `SELECT count(*) FROM push_messages WHERE outbox_id=(SELECT max(id) FROM notification_outbox) AND status='failed' AND attempts=$1`, pushAttempts); n != 3 {
		t.Fatalf("%d messages gave up after %d attempts: %v", n, pushAttempts, messageStates(t, db))
	}
	// A request Expo rejects as malformed isn't retried.
	expo.reply = func([]expoMessage) (int, any) {
		return 400, map[string]any{"errors": []map[string]string{{"code": "PUSH_TOO_MANY_EXPERIENCE_IDS", "message": "mixed projects"}}}
	}
	publishRecipe(t, db, "chef", "cake", nil)
	drain(t, n)
	if n := count(t, db, `SELECT count(*) FROM push_messages WHERE outbox_id=(SELECT max(id) FROM notification_outbox) AND status='failed' AND attempts=1 AND error LIKE '%400%'`); n != 3 {
		t.Fatalf("rejected request: %v", messageStates(t, db))
	}
}

func TestPushSendsInBatchesAndNeverTwice(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "chef", "Ana")
	if _, e := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle) SELECT 'fan'||n,'fan'||n||'@example.test','!disabled','Fan','fan'||n FROM generate_series(1,230) n;
 INSERT INTO follows(user_id,creator_id) SELECT 'fan'||n,'chef' FROM generate_series(1,230) n;
 INSERT INTO push_tokens(token,user_id,platform) SELECT 'ExponentPushToken[fan'||n||']','fan'||n,'android' FROM generate_series(1,230) n`); e != nil {
		t.Fatal(e)
	}
	expo := newFakeExpo(t)
	expo.delay = 30 * time.Millisecond
	publishRecipe(t, db, "chef", "tart", nil)
	one, two := expo.notifier(db), expo.notifier(db)
	for one.fanOut(ctx) {
	}
	if n := count(t, db, `SELECT count(*) FROM push_messages`); n != 230 {
		t.Fatalf("%d messages for 230 followers", n)
	}
	// Two senders (two replicas) work through the queue at once.
	var wg sync.WaitGroup
	for _, s := range []*notifier{one, two} {
		wg.Go(func() {
			for s.sendDue(ctx) {
			}
		})
	}
	wg.Wait()
	sizes := expo.requestSizes()
	total := 0
	for _, size := range sizes {
		if size > expoBatch {
			t.Fatalf("a request of %d messages", size)
		}
		total += size
	}
	sent := expo.sent()
	if total != 230 || len(sent) != 230 {
		t.Fatalf("%d messages in %v to %d devices", total, sizes, len(sent))
	}
	for token, m := range sent {
		if len(m) != 1 {
			t.Fatalf("%s got %d copies", token, len(m))
		}
	}
	if n := count(t, db, `SELECT count(*) FROM push_messages WHERE status='sent'`); n != 230 {
		t.Fatalf("%d recorded as sent", n)
	}
}

func TestPushSweepsReceiptsAndMovedDevices(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "chef", "Ana")
	for _, u := range []string{"fan", "fan2", "stranger"} {
		testUser(t, db, u)
	}
	followCook(t, db, "fan", "chef")
	followCook(t, db, "fan2", "chef")
	registerDevice(t, db, "fan")
	registerDevice(t, db, "fan2")
	expo := newFakeExpo(t)
	n := expo.notifier(db)
	publishRecipe(t, db, "chef", "tart", nil)
	for n.fanOut(ctx) {
	}
	// Someone else signs in on fan2's phone before the message goes; a stopped server left
	// fan's message claimed.
	if _, e := db.Exec(ctx, `UPDATE push_tokens SET user_id='stranger' WHERE token=$1`, deviceToken("fan2")); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE push_messages SET status='sending',claimed_at=now()-interval '20 minutes' WHERE token=$1`, deviceToken("fan")); e != nil {
		t.Fatal(e)
	}
	drain(t, n)
	n.sweepStalled(ctx)
	if len(expo.sent()) != 0 {
		t.Fatalf("sent %v", expo.sent())
	}
	if got := messageStates(t, db); !maps.Equal(got, map[string]string{deviceToken("fan"): "failed/0", deviceToken("fan2"): "failed/1"}) {
		t.Fatalf("states %v", got)
	}

	// Receipts: Apple says fan's phone is gone, a quarter of an hour later.
	publishRecipe(t, db, "chef", "pie", nil)
	drain(t, n)
	expo.receipts["ticket-"+deviceToken("fan")] = expoTicket{Status: "error", Message: "gone", Details: struct {
		Error string `json:"error"`
	}{"DeviceNotRegistered"}}
	n.checkReceipts(ctx)
	if len(expo.asked) != 0 {
		t.Fatal("asked for receipts before Expo has them")
	}
	if _, e := db.Exec(ctx, `UPDATE push_messages SET sent_at=now()-interval '20 minutes' WHERE status='sent'`); e != nil {
		t.Fatal(e)
	}
	n.checkReceipts(ctx)
	if len(expo.asked) != 1 || !slices.Contains(expo.asked[0], "ticket-"+deviceToken("fan")) {
		t.Fatalf("asked %v", expo.asked)
	}
	if n := count(t, db, `SELECT count(*) FROM push_tokens WHERE token=$1`, deviceToken("fan")); n != 0 {
		t.Fatal("a device Apple dropped was kept")
	}
	if n := count(t, db, `SELECT count(*) FROM push_messages WHERE receipt_checked AND error LIKE 'receipt: DeviceNotRegistered%'`); n != 1 {
		t.Fatalf("receipt not recorded: %v", messageStates(t, db))
	}
	n.checkReceipts(ctx)
	if len(expo.asked) != 1 {
		t.Fatal("asked for the same receipts twice")
	}
}

func TestReviewAndCommentNoticesGoToTheAuthor(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "chef", "Ana")
	namedUser(t, db, "critic", "Ben")
	namedUser(t, db, "fan", "Cleo")
	for _, u := range []string{"chef", "critic", "fan"} {
		registerDevice(t, db, u)
	}
	setPreferences(t, db, "chef", `{"language":"de"}`)
	publishRecipe(t, db, "chef", "tart", func(r *RecipeInput) { r.Title = "Lemon tart" })
	expo := newFakeExpo(t)
	n := expo.notifier(db)
	drain(t, n) // the publish: nobody follows
	f := recipesApp(db, false)
	if status, b := callAPI(t, f, "PUT", "/v1/recipes/tart/review", bearerFor(t, db, "critic"), map[string]any{"rating": 4, "body": "Lovely tart,\n very lemony."}); status != 200 {
		t.Fatalf("review: %d %s", status, b)
	}
	comments := commentsFor(t, db)
	comments.add("fan", "tart", "Can I use limes?")
	comments.add("chef", "tart", "Of course!")
	drain(t, n)
	sent := expo.sent()
	if len(sent) != 1 || len(sent[deviceToken("chef")]) != 2 {
		t.Fatalf("sent %v", sent)
	}
	got := []string{}
	for _, m := range sent[deviceToken("chef")] {
		got = append(got, m.Title+" | "+m.Body+" | "+payload(m)["type"]+" "+payload(m)["recipeId"])
	}
	slices.Sort(got)
	want := []string{
		"Ben hat Lemon tart bewertet | ★★★★☆ „Lovely tart, very lemony.“ | recipe tart",
		"Cleo hat Lemon tart kommentiert | „Can I use limes?“ | recipe tart",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("notices:\n%q\nwant\n%q", got, want)
	}
	// Turned off, they stop.
	setPreferences(t, db, "chef", `{"notifications":{"reviews":false,"comments":false}}`)
	if _, e := db.Exec(ctx, `INSERT INTO reviews(id,user_id,recipe_id,rating,body) VALUES('r2','fan','tart',5,'Yum.')`); e != nil {
		t.Fatal(e)
	}
	comments.add("critic", "tart", "Agreed.")
	drain(t, n)
	if got := len(expo.sent()[deviceToken("chef")]); got != 2 {
		t.Fatalf("%d notices after turning them off", got)
	}
}

func TestPantryRemindersOncePerItem(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	hour := pantryHour
	t.Cleanup(func() { pantryHour = hour })
	pantryHour = 0
	for _, u := range []string{"cook", "quiet", "offline"} {
		testUser(t, db, u)
	}
	registerDevice(t, db, "cook")
	registerDevice(t, db, "quiet")
	setPreferences(t, db, "cook", `{"language":"es"}`)
	setPreferences(t, db, "quiet", `{"notifications":{"pantry":false}}`)
	if _, e := db.Exec(ctx, `INSERT INTO pantry(id,user_id,name,expires_on) VALUES
 ('p1','cook','milk',(now() AT TIME ZONE 'UTC')::date),('p2','cook','eggs',(now() AT TIME ZONE 'UTC')::date+2),
 ('p3','cook','rice',(now() AT TIME ZONE 'UTC')::date+3),('p4','cook','old bread',(now() AT TIME ZONE 'UTC')::date-1),('p5','cook','salt',NULL),
 ('p6','quiet','yogurt',(now() AT TIME ZONE 'UTC')::date),('p7','offline','cheese',(now() AT TIME ZONE 'UTC')::date)`); e != nil {
		t.Fatal(e)
	}
	expo := newFakeExpo(t)
	n := expo.notifier(db)
	pass := func(want int64) {
		t.Helper()
		got, e := n.pantryPass(ctx)
		if e != nil || got != want {
			t.Fatalf("pantry pass reminded %d (%v), want %d", got, e, want)
		}
		drain(t, n)
	}
	pass(1)
	m := expo.sent()[deviceToken("cook")]
	if len(expo.sent()) != 1 || len(m) != 1 || m[0].Title != "Recordatorio de la despensa" || m[0].Body != "Para usar pronto: milk, eggs" || !maps.Equal(payload(m[0]), map[string]string{"type": "pantry"}) {
		t.Fatalf("reminders %v", expo.sent())
	}
	// Once a day.
	pass(0)
	// The next day mentions only what is new: a later expiry for milk and rice coming due.
	if _, e := db.Exec(ctx, `UPDATE notification_runs SET ran_on=ran_on-1; UPDATE pantry SET expires_on=expires_on+1 WHERE id IN ('p1');
 UPDATE pantry SET expires_on=expires_on-1 WHERE id='p3'`); e != nil {
		t.Fatal(e)
	}
	pass(1)
	if m = expo.sent()[deviceToken("cook")]; len(m) != 2 || m[1].Body != "Para usar pronto: milk, rice" {
		t.Fatalf("second day %v", m)
	}
	// Not before the hour.
	if _, e := db.Exec(ctx, `UPDATE notification_runs SET ran_on=ran_on-1`); e != nil {
		t.Fatal(e)
	}
	pantryHour = 24
	pass(0)
}

func TestNoticeTexts(t *testing.T) {
	v := noticeVars{Name: "Ana", Title: "Lemon tart", Text: "So  good\nreally", Rating: 4, Items: []string{"milk", "eggs"}}
	for language := range recipeLanguages {
		texts, ok := noticeLanguages[language]
		if !ok {
			t.Fatalf("no notifications in %s", language)
		}
		for _, kind := range []string{"publish", "review", "comment", "pantry"} {
			title, body := notice(kind, language, v)
			if title == "" || body == "" || strings.Contains(title+body, "{") {
				t.Errorf("%s %s: %q %q", language, kind, title, body)
			}
			switch kind {
			case "publish":
				if !strings.Contains(title, "Ana") || body != "Lemon tart" {
					t.Errorf("%s publish: %q %q", language, title, body)
				}
			case "review", "comment":
				if !strings.Contains(title, "Ana") || !strings.Contains(title, "Lemon tart") || !strings.Contains(body, "So good really") {
					t.Errorf("%s %s: %q %q", language, kind, title, body)
				}
				if kind == "review" && !strings.Contains(body, "★★★★☆") {
					t.Errorf("%s review stars: %q", language, body)
				}
			case "pantry":
				if !strings.Contains(body, "milk"+texts.list+"eggs") {
					t.Errorf("%s pantry: %q", language, body)
				}
			}
		}
	}
	if title, _ := notice("publish", "xx", v); title != "New recipe from Ana" {
		t.Errorf("unknown language: %q", title)
	}
	v.Items = []string{"a", "b", "c", "d", "e", "f", "g"}
	if _, body := notice("pantry", "en", v); body != "Use soon: a, b, c, d, e +2" {
		t.Errorf("long pantry list: %q", body)
	}
	v.Rating, v.Text = 9, strings.Repeat("ab ", 100)
	if _, body := notice("review", "en", v); !strings.HasPrefix(body, "★★★★★ “") || !strings.HasSuffix(body, "…”") {
		t.Errorf("long review: %q", body)
	}
}
