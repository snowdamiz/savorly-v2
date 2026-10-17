package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/gofiber/fiber/v3"
)

// Push notifications go through Expo's push service, which forwards them to Apple and Google
// (docs/NOTIFICATIONS.md). The app registers each device's Expo push token here; the sender
// (notifications_outbox.go) addresses messages to those tokens.

// An Expo push token, as expo-notifications' getExpoPushTokenAsync returns it.
var expoPushToken = regexp.MustCompile(`^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$`)

// devicesKept is how many devices a member can receive notifications on; registering another
// forgets the one seen longest ago.
const devicesKept = 10

// savePushToken registers this device. A token registered by someone else moves to this member
// (a shared device that changed hands), and it stops with this session.
func (a *App) savePushToken(c fiber.Ctx) error {
	var in struct{ Token, Platform string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if !expoPushToken.MatchString(in.Token) {
		return fiber.NewError(400, "Send this device's Expo push token.")
	}
	if in.Platform != "ios" && in.Platform != "android" {
		return fiber.NewError(400, "Choose iOS or Android.")
	}
	ctx, me := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `INSERT INTO push_tokens(token,user_id,session_hash,platform) VALUES($1,$2,$3,$4)
 ON CONFLICT (token) DO UPDATE SET user_id=excluded.user_id,session_hash=excluded.session_hash,platform=excluded.platform,last_seen_at=now()`,
		in.Token, me, hashToken(token(c)), in.Platform); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM push_tokens WHERE user_id=$1 AND token NOT IN (SELECT token FROM push_tokens WHERE user_id=$1 ORDER BY last_seen_at DESC,token LIMIT $2)`, me, devicesKept); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// deletePushToken stops notifications on this device, such as before signing out.
func (a *App) deletePushToken(c fiber.Ctx) error {
	var in struct{ Token string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if in.Token == "" {
		return fiber.NewError(400, "Send this device's Expo push token.")
	}
	if _, e := a.DB.Exec(c.Context(), `DELETE FROM push_tokens WHERE token=$1 AND user_id=$2`, in.Token, userID(c)); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// expoPush talks to Expo's push API. The access token is optional: Expo asks for one only
// once a project turns on enhanced push security.
type expoPush struct {
	base   string // the API's root; tests point it at a fake
	token  string
	client *http.Client
}

const expoPushAPI = "https://exp.host/--/api/v2/push"

func newExpoPush() *expoPush {
	return &expoPush{base: expoPushAPI, token: os.Getenv("EXPO_ACCESS_TOKEN"), client: &http.Client{Timeout: 30 * time.Second}}
}

// Expo takes at most 100 messages per request and 1,000 receipt ids.
const (
	expoBatch        = 100
	expoReceiptBatch = 1000
)

type expoMessage struct {
	To    string          `json:"to"`
	Title string          `json:"title"`
	Body  string          `json:"body"`
	Data  json.RawMessage `json:"data,omitempty"`
	Sound string          `json:"sound,omitempty"`
}

// expoTicket is Expo's answer for one message, or a receipt for one ticket.
type expoTicket struct {
	Status  string `json:"status"`
	ID      string `json:"id"`
	Message string `json:"message"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

// expoFailure is a request Expo didn't accept. Retry says whether trying later may work:
// Expo asks for retries with backoff after network errors, 429 and 5xx, and none otherwise.
type expoFailure struct {
	Status int
	Retry  bool
	Detail string
}

func (f *expoFailure) Error() string { return fmt.Sprintf("expo push: %d %s", f.Status, f.Detail) }

func (x *expoPush) post(ctx context.Context, path string, body any, out any) error {
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, x.base+path, bytes.NewReader(jsonBytes(body)))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if x.token != "" {
		req.Header.Set("Authorization", "Bearer "+x.token)
	}
	res, e := x.client.Do(req)
	if e != nil {
		return &expoFailure{Retry: true, Detail: e.Error()}
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if e != nil {
		return &expoFailure{Status: res.StatusCode, Retry: true, Detail: e.Error()}
	}
	if res.StatusCode != http.StatusOK {
		return &expoFailure{Status: res.StatusCode, Retry: res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500, Detail: truncate(string(b), 300)}
	}
	if e = json.Unmarshal(b, out); e != nil {
		return &expoFailure{Status: res.StatusCode, Detail: "unreadable answer: " + truncate(string(b), 300)}
	}
	return nil
}

// send pushes up to expoBatch messages and returns one ticket per message, in order.
func (x *expoPush) send(ctx context.Context, messages []expoMessage) ([]expoTicket, error) {
	var out struct {
		Data []expoTicket `json:"data"`
	}
	if e := x.post(ctx, "/send", messages, &out); e != nil {
		return nil, e
	}
	if len(out.Data) != len(messages) {
		return nil, &expoFailure{Status: http.StatusOK, Detail: fmt.Sprintf("%d tickets for %d messages", len(out.Data), len(messages))}
	}
	return out.Data, nil
}

// receipts reads what became of sent messages, by ticket id. Expo leaves out the ones it has
// no receipt for yet.
func (x *expoPush) receipts(ctx context.Context, ids []string) (map[string]expoTicket, error) {
	var out struct {
		Data map[string]expoTicket `json:"data"`
	}
	if e := x.post(ctx, "/getReceipts", fiber.Map{"ids": ids}, &out); e != nil {
		return nil, e
	}
	return out.Data, nil
}
