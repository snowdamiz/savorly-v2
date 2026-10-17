package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
)

func sessionTimes(t *testing.T, db *pgxpool.Pool, tok string) (expires, used time.Time) {
	t.Helper()
	if e := db.QueryRow(context.Background(), `SELECT expires_at,last_used_at FROM sessions WHERE token_hash=$1`, hashToken(tok)).Scan(&expires, &used); e != nil {
		t.Fatal(e)
	}
	return expires, used
}

// sessionState judges a session by the database's clock, as the API does.
func sessionState(t *testing.T, db *pgxpool.Pool, tok string) (renewed, justUsed bool) {
	t.Helper()
	if e := db.QueryRow(context.Background(), `SELECT expires_at>now()+interval '29 days',last_used_at>now()-interval '1 minute' FROM sessions WHERE token_hash=$1`, hashToken(tok)).Scan(&renewed, &justUsed); e != nil {
		t.Fatal(e)
	}
	return renewed, justUsed
}

func TestSessionsSlideForwardWhileUsed(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, true)
	ctx := context.Background()
	id := member(t, db, "slider@example.test")

	// Past half its life, a browser session is extended and its cookie set again.
	old := deviceSession(t, db, id, laptopUA, 10*24*time.Hour)
	if _, e := db.Exec(ctx, `UPDATE sessions SET last_used_at=now()-interval '1 hour' WHERE token_hash=$1`, hashToken(old)); e != nil {
		t.Fatal(e)
	}
	r := must(t, f, 200, call{method: "GET", path: "/v1/me", cookie: old})
	cookie := r.sessionCookie()
	if cookie == nil || cookie.Value != old || cookie.MaxAge != 30*86400 || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("renewed cookie: %+v", cookie)
	}
	if renewed, used := sessionState(t, db, old); !renewed || !used {
		t.Fatalf("not renewed: %v, last use recorded: %v", renewed, used)
	}

	// A young session that was just used is neither written nor re-sent.
	young := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	expires, used := sessionTimes(t, db, young)
	if r = must(t, f, 200, call{method: "GET", path: "/v1/me", cookie: young}); r.sessionCookie() != nil {
		t.Fatal("cookie re-sent for a young session")
	}
	if e2, u2 := sessionTimes(t, db, young); !e2.Equal(expires) || !u2.Equal(used) {
		t.Fatal("a fresh session was written on read")
	}
	// Used again after a while, it records the use but keeps its expiry.
	if _, e := db.Exec(ctx, `UPDATE sessions SET last_used_at=now()-interval '10 minutes',user_agent='' WHERE token_hash=$1`, hashToken(young)); e != nil {
		t.Fatal(e)
	}
	must(t, f, 200, call{method: "GET", path: "/v1/me", cookie: young, userAgent: phoneUA})
	if e2, _ := sessionTimes(t, db, young); !e2.Equal(expires) {
		t.Fatalf("touch moved the expiry: %v→%v", expires, e2)
	}
	if _, justUsed := sessionState(t, db, young); !justUsed {
		t.Fatal("use not recorded")
	}
	if n := count(t, db, `SELECT count(*) FROM sessions WHERE token_hash=$1 AND user_agent=$2`, hashToken(young), phoneUA); n != 1 {
		t.Fatal("device not recorded on use")
	}

	// Bearer sessions are extended on the server only.
	bearer := deviceSession(t, db, id, phoneUA, 2*24*time.Hour)
	if r = must(t, f, 200, call{method: "GET", path: "/v1/me", bearer: bearer}); r.sessionCookie() != nil {
		t.Fatal("cookie set for a bearer client")
	}
	if renewed, _ := sessionState(t, db, bearer); !renewed {
		t.Fatal("bearer session not renewed")
	}

	expired := deviceSession(t, db, id, phoneUA, -time.Minute)
	must(t, f, 401, call{method: "GET", path: "/v1/me", bearer: expired})
}

func TestMembersSeeAndSignOutTheirDevices(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	id := member(t, db, "devices@example.test")
	here := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	phone := deviceSession(t, db, id, phoneUA, 20*24*time.Hour)
	deviceSession(t, db, id, "okhttp/4.12.0", 20*24*time.Hour)
	deviceSession(t, db, id, phoneUA, -time.Hour) // expired: not listed
	stranger := member(t, db, "stranger@example.test")
	theirs := deviceSession(t, db, stranger, laptopUA, 20*24*time.Hour)

	list := func(tok string) []map[string]any {
		t.Helper()
		r := must(t, f, 200, call{method: "GET", path: "/v1/me/sessions", bearer: tok})
		if strings.Contains(string(r.body), hashToken(tok)) {
			t.Fatal("token hash exposed")
		}
		var out []map[string]any
		if e := json.Unmarshal(r.body, &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	devices := list(here)
	if len(devices) != 3 || devices[0]["current"] != true || devices[0]["client"] != "Chrome" || devices[0]["system"] != "macOS" || devices[0]["userAgent"] != laptopUA {
		t.Fatalf("devices: %v", devices)
	}
	for _, d := range devices[1:] {
		if d["current"] != false || d["id"] == "" || d["createdAt"] == nil || d["lastUsedAt"] == nil {
			t.Fatalf("device: %v", d)
		}
	}
	var phoneID string
	for _, d := range devices {
		if d["userAgent"] == phoneUA {
			phoneID = d["id"].(string)
		}
	}
	theirID := list(theirs)[0]["id"].(string)

	must(t, f, 404, call{method: "DELETE", path: "/v1/me/sessions/" + theirID, bearer: here})
	must(t, f, 204, call{method: "DELETE", path: "/v1/me/sessions/" + phoneID, bearer: here})
	must(t, f, 401, call{method: "GET", path: "/v1/me", bearer: phone})
	if r := must(t, f, 404, call{method: "DELETE", path: "/v1/me/sessions/" + phoneID, bearer: here}); r.message() == "" {
		t.Fatal("no message for a device already signed out")
	}
	if out := must(t, f, 200, call{method: "POST", path: "/v1/me/sessions/revoke-others", bearer: here}).object(t); out["revoked"] != float64(1) {
		t.Fatalf("revoke others: %v", out)
	}
	if devices = list(here); len(devices) != 1 || devices[0]["current"] != true {
		t.Fatalf("after revoking others: %v", devices)
	}
	must(t, f, 200, call{method: "GET", path: "/v1/me", bearer: theirs})

	// Signing this browser out by id also clears its cookie.
	hereID := devices[0]["id"].(string)
	r := must(t, f, 204, call{method: "DELETE", path: "/v1/me/sessions/" + hereID, cookie: here, origin: testOrigin})
	if c := r.sessionCookie(); c == nil || c.MaxAge >= 0 {
		t.Fatalf("cookie kept: %+v", c)
	}
	must(t, f, 401, call{method: "GET", path: "/v1/me", cookie: here})
}

func TestSessionAnswersGuestsWithoutAnError(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	if out := must(t, f, 200, call{method: "GET", path: "/v1/session"}).object(t); len(out) != 1 || out["user"] != nil {
		t.Fatalf("guest: %v", out)
	}
	if out := must(t, f, 200, call{method: "GET", path: "/v1/session", cookie: "not-a-session"}).object(t); out["user"] != nil {
		t.Fatalf("unknown token: %v", out)
	}
	id := member(t, db, "session@example.test")
	tok := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	var session struct{ User json.RawMessage }
	if e := json.Unmarshal(must(t, f, 200, call{method: "GET", path: "/v1/session", cookie: tok}).body, &session); e != nil {
		t.Fatal(e)
	}
	var fromSession, fromMe map[string]any
	_ = json.Unmarshal(session.User, &fromSession)
	_ = json.Unmarshal(must(t, f, 200, call{method: "GET", path: "/v1/me", cookie: tok}).body, &fromMe)
	if fromSession["id"] != id || fmt.Sprint(fromSession) != fmt.Sprint(fromMe) {
		t.Fatalf("session user %v differs from /me %v", fromSession, fromMe)
	}
	if _, e := db.Exec(context.Background(), `UPDATE users SET suspended_at=now() WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	if out := must(t, f, 200, call{method: "GET", path: "/v1/session", bearer: tok}).object(t); out["user"] != nil {
		t.Fatalf("suspended member: %v", out)
	}
}

func TestSignInAttemptsAreLimitedPerAccount(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	member(t, db, "target@example.test")
	n := 0
	login := func(email, password string) reply {
		t.Helper()
		n++ // a new address each time, as a distributed guess would come
		return do(t, f, call{method: "POST", path: "/v1/auth/login", ip: fmt.Sprintf("198.51.100.%d", n), body: fiber.Map{"email": email, "password": password}})
	}
	// Over-long passwords fail before bcrypt runs, which keeps this test quick; they count the same.
	tooLong := strings.Repeat("x", 73)
	for _, email := range []string{"Target@example.test", "nobody@example.test"} {
		for i := 0; i < loginAttempts; i++ {
			password := tooLong
			if i == 0 && email != "nobody@example.test" {
				password = "wrong-password"
			}
			if r := login(email, password); r.status != 401 {
				t.Fatalf("%s attempt %d: %d %s", email, i, r.status, r.body)
			}
		}
		r := login(email, testPassword)
		if r.status != 429 || r.message() != "Too many sign-in attempts. Please wait a few minutes and try again." {
			t.Fatalf("%s over the limit: %d %s", email, r.status, r.body)
		}
	}

	// A successful sign-in starts the count again.
	member(t, db, "typo@example.test")
	for i := 0; i < loginAttempts-1; i++ {
		login("typo@example.test", tooLong)
	}
	if r := login("typo@example.test", testPassword); r.status != 200 {
		t.Fatalf("correct password under the limit: %d", r.status)
	}
	for i := 0; i < loginAttempts-1; i++ {
		if r := login("typo@example.test", tooLong); r.status != 401 {
			t.Fatalf("count not reset: %d", r.status)
		}
	}
}

func TestAttemptCounterStaysBounded(t *testing.T) {
	var c attemptCounter
	for i := 0; i < maxTrackedKeys+500; i++ {
		c.hit(fmt.Sprint("cook", i, "@example.test"), 3, time.Hour)
	}
	if len(c.entries) > maxTrackedKeys {
		t.Fatalf("%d keys tracked", len(c.entries))
	}
	for i := 0; i < 3; i++ {
		if !c.hit("me@example.test", 3, time.Hour) {
			t.Fatalf("attempt %d refused", i)
		}
	}
	if c.hit("me@example.test", 3, time.Hour) {
		t.Fatal("fourth attempt allowed")
	}
	c.clear("me@example.test")
	if !c.hit("me@example.test", 3, time.Hour) {
		t.Fatal("not cleared")
	}
	if !c.hit("window@example.test", 1, time.Nanosecond) {
		t.Fatal("first attempt refused")
	}
	time.Sleep(time.Millisecond)
	if !c.hit("window@example.test", 1, time.Nanosecond) {
		t.Fatal("window never ends")
	}
}

// Each sign-in route has its own budget: running out on one leaves the others usable.
func TestAuthRoutesHaveSeparateLimits(t *testing.T) {
	f := New(nil, Config{Origins: []string{testOrigin}})
	bad := []byte("not json")
	for i := 0; i < 20; i++ {
		if r := do(t, f, call{method: "POST", path: "/v1/auth/login", rawBody: bad}); r.status != 400 {
			t.Fatalf("login %d: %d", i, r.status)
		}
	}
	if r := do(t, f, call{method: "POST", path: "/v1/auth/login", rawBody: bad}); r.status != 429 {
		t.Fatalf("login over its limit: %d", r.status)
	}
	for _, path := range []string{"/v1/auth/reset", "/v1/auth/oauth", "/v1/auth/register"} {
		if r := do(t, f, call{method: "POST", path: path, rawBody: bad}); r.status != 400 {
			t.Errorf("%s after login ran out: %d", path, r.status)
		}
	}
	// Reset emails get the tightest budget.
	for i := 0; i < 5; i++ {
		do(t, f, call{method: "POST", path: "/v1/auth/forgot", rawBody: bad})
	}
	if r := do(t, f, call{method: "POST", path: "/v1/auth/forgot", rawBody: bad}); r.status != 429 {
		t.Fatalf("forgot over its limit: %d", r.status)
	}
}
