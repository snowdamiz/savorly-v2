package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

const (
	testOrigin   = "http://localhost:8081"
	testIPHeader = "X-Test-Client-IP"
	phoneUA      = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
	laptopUA     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

// accountsApp is the real router; the proxy header lets tests choose the client IP, so per-IP
// limits don't bleed between cases.
func accountsApp(db *pgxpool.Pool, production bool) *fiber.App {
	return NewWithContext(context.Background(), db, Config{Production: production, Origins: []string{testOrigin}, ProxyHeader: testIPHeader})
}

type call struct {
	method, path              string
	body                      any
	bearer, cookie, origin    string
	userAgent, ip             string
	header                    map[string]string
	rawBody                   []byte
	skipJSONContentTypeHeader bool
}

type reply struct {
	status int
	header http.Header
	body   []byte
}

func (r reply) object(t *testing.T) map[string]any {
	t.Helper()
	out := map[string]any{}
	if e := json.Unmarshal(r.body, &out); e != nil {
		t.Fatalf("not a JSON object (%d): %s", r.status, r.body)
	}
	return out
}

func (r reply) message() string {
	var out struct{ Error string }
	_ = json.Unmarshal(r.body, &out)
	return out.Error
}

// sessionCookie is the savorly_session cookie the response sets, if any.
func (r reply) sessionCookie() *http.Cookie {
	for _, c := range (&http.Response{Header: r.header}).Cookies() {
		if c.Name == "savorly_session" {
			return c
		}
	}
	return nil
}

func do(t *testing.T, f *fiber.App, c call) reply {
	t.Helper()
	var body io.Reader
	switch {
	case c.rawBody != nil:
		body = bytes.NewReader(c.rawBody)
	case c.body != nil:
		body = bytes.NewReader(jsonBytes(c.body))
	}
	req := httptest.NewRequest(c.method, c.path, body)
	if body != nil && !c.skipJSONContentTypeHeader {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	if c.cookie != "" {
		req.AddCookie(&http.Cookie{Name: "savorly_session", Value: c.cookie})
	}
	if c.origin != "" {
		req.Header.Set("Origin", c.origin)
	}
	if c.userAgent != "" {
		req.Header.Set("User-Agent", c.userAgent)
	}
	if c.ip != "" {
		req.Header.Set(testIPHeader, c.ip)
	}
	for k, v := range c.header {
		req.Header.Set(k, v)
	}
	res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, res.Header, b}
}

// must fails unless the request answers with status.
func must(t *testing.T, f *fiber.App, status int, c call) reply {
	t.Helper()
	r := do(t, f, c)
	if r.status != status {
		t.Fatalf("%s %s: want %d, got %d: %s", c.method, c.path, status, r.status, r.body)
	}
	return r
}

// member creates an account that signs in with testPassword.
func member(t *testing.T, db *pgxpool.Pool, email string) string {
	t.Helper()
	id := uuid.NewString()
	hash, _ := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.MinCost)
	if _, e := db.Exec(context.Background(), `INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,'Test cook',$1)`, id, email, string(hash)); e != nil {
		t.Fatal(e)
	}
	return id
}

// deviceSession signs a member in from a device and returns its token. Like the API, it times
// sessions by the database's clock.
func deviceSession(t *testing.T, db *pgxpool.Pool, user, ua string, expiresIn time.Duration) string {
	t.Helper()
	tok := uuid.NewString()
	if _, e := db.Exec(context.Background(), `INSERT INTO sessions(token_hash,user_id,expires_at,user_agent) VALUES($1,$2,now()+$3*interval '1 second',$4)`, hashToken(tok), user, seconds(expiresIn), ua); e != nil {
		t.Fatal(e)
	}
	return tok
}

func count(t *testing.T, db *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if e := db.QueryRow(context.Background(), sql, args...).Scan(&n); e != nil {
		t.Fatal(e)
	}
	return n
}

type sentMail struct{ To, Subject, Text string }

// mailbox stands in for Cloudflare Email Service and keeps what was sent.
type mailbox struct {
	mu   sync.Mutex
	mail []sentMail
	fail bool
}

func newMailbox(t *testing.T) *mailbox {
	t.Helper()
	m := &mailbox{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			To            []string
			Subject, Text string
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.fail {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"success":false}`))
			return
		}
		m.mail = append(m.mail, sentMail{strings.Join(in.To, ","), in.Subject, in.Text})
		_, _ = w.Write([]byte(`{"success":true,"result":{"delivered":["x"]}}`))
	}))
	t.Cleanup(server.Close)
	old := cloudflareAPI
	cloudflareAPI = server.URL
	t.Cleanup(func() { cloudflareAPI = old })
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "acct-1")
	t.Setenv("CLOUDFLARE_EMAIL_API_TOKEN", "email-token")
	t.Setenv("EMAIL_FROM", "noreply@savorly.test")
	// Registered last, so it runs first: nothing may still be sending once the fake is gone.
	t.Cleanup(pendingLetters.Wait)
	return m
}

// to returns what was sent to addr, after waiting for notifications in flight.
func (m *mailbox) to(addr string) []sentMail {
	pendingLetters.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []sentMail{}
	for _, s := range m.mail {
		if s.To == addr {
			out = append(out, s)
		}
	}
	return out
}

func (m *mailbox) failing(fail bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fail = fail
}

var sixDigitCode = regexp.MustCompile(`\b\d{6}\b`)

// lastCode is the code in the latest email to addr.
func (m *mailbox) lastCode(t *testing.T, addr string) string {
	t.Helper()
	mail := m.to(addr)
	if len(mail) == 0 {
		t.Fatalf("no email to %s", addr)
	}
	code := sixDigitCode.FindString(mail[len(mail)-1].Text)
	if code == "" {
		t.Fatalf("no code in %q", mail[len(mail)-1].Text)
	}
	return code
}

func TestChangePasswordRevokesOtherDevicesAndTellsTheOwner(t *testing.T) {
	db := isolatedDB(t)
	mail := newMailbox(t)
	f := accountsApp(db, false)
	id := member(t, db, "cook@example.test")
	here := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	deviceSession(t, db, id, phoneUA, 20*24*time.Hour)
	path := "/v1/me/password"
	changed := func() int {
		n := 0
		for _, m := range mail.to("cook@example.test") {
			if strings.Contains(m.Subject, "password was changed") {
				n++
			}
		}
		return n
	}

	if r := must(t, f, 403, call{method: "POST", path: path, bearer: here, body: fiber.Map{"currentPassword": "not-my-password", "newPassword": "a-brand-new-password"}}); r.message() != "Password is incorrect." {
		t.Fatalf("wrong current password: %s", r.body)
	}
	must(t, f, 400, call{method: "POST", path: path, bearer: here, body: fiber.Map{"currentPassword": testPassword, "newPassword": "too-short"}})
	must(t, f, 400, call{method: "POST", path: path, bearer: here, body: fiber.Map{"currentPassword": testPassword, "newPassword": strings.Repeat("x", 73)}})
	if n := count(t, db, `SELECT count(*) FROM sessions WHERE user_id=$1`, id); n != 2 {
		t.Fatalf("a refused change signed devices out: %d sessions", n)
	}
	if n := changed(); n != 0 {
		t.Fatalf("refused change sent %d notifications", n)
	}

	me := must(t, f, 200, call{method: "POST", path: path, bearer: here, body: fiber.Map{"currentPassword": testPassword, "newPassword": "a-brand-new-password"}}).object(t)
	if me["id"] != id || me["hasPassword"] != true {
		t.Fatalf("profile after change: %v", me)
	}
	if n := count(t, db, `SELECT count(*) FROM sessions WHERE user_id=$1`, id); n != 1 {
		t.Fatalf("other devices stayed signed in: %d sessions", n)
	}
	must(t, f, 200, call{method: "GET", path: "/v1/me", bearer: here})
	must(t, f, 200, call{method: "POST", path: "/v1/auth/login", userAgent: laptopUA, body: fiber.Map{"email": "cook@example.test", "password": "a-brand-new-password"}})
	if n := changed(); n != 1 {
		t.Fatalf("%d notifications: %v", n, mail.to("cook@example.test"))
	}
}

func TestSetFirstPasswordWithAFreshProviderSignIn(t *testing.T) {
	db := isolatedDB(t)
	google := newFakeProvider(t, "google")
	t.Setenv("GOOGLE_WEB_CLIENT_ID", "web-client")
	f := accountsApp(db, false)
	ctx := context.Background()
	id := uuid.NewString()
	if _, e := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle,email_verified) VALUES($1,'gina@example.test','!','Gina',$1,true)`, id); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO identities(provider,subject,user_id,email) VALUES('google','g-1',$1,'gina@example.test')`, id); e != nil {
		t.Fatal(e)
	}
	tok := deviceSession(t, db, id, phoneUA, 20*24*time.Hour)
	nonce := func() string {
		return must(t, f, 200, call{method: "POST", path: "/v1/auth/nonce"}).object(t)["nonce"].(string)
	}
	googleToken := func(sub string) string {
		return google.token(t, map[string]any{"sub": sub, "email": "gina@example.test", "email_verified": true, "aud": "web-client", "nonce": nonce()})
	}
	path := "/v1/me/password"
	must(t, f, 400, call{method: "POST", path: path, bearer: tok, body: fiber.Map{"newPassword": "a-first-password-here"}})
	// Another Google account proves nothing about this one, and must not sign the member out.
	if r := must(t, f, 403, call{method: "POST", path: path, bearer: tok, body: fiber.Map{"newPassword": "a-first-password-here", "provider": "google", "token": googleToken("g-other")}}); !strings.Contains(r.message(), "Apple or Google") {
		t.Fatalf("someone else's identity: %s", r.body)
	}
	me := must(t, f, 200, call{method: "POST", path: path, bearer: tok, body: fiber.Map{"newPassword": "a-first-password-here", "provider": "google", "token": googleToken("g-1")}}).object(t)
	if me["hasPassword"] != true {
		t.Fatalf("password not set: %v", me)
	}
	must(t, f, 200, call{method: "POST", path: "/v1/auth/login", body: fiber.Map{"email": "gina@example.test", "password": "a-first-password-here"}})
}

func TestEmailChangeNeedsTheCodeSentToTheNewAddress(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	id := member(t, db, "old@example.test")
	member(t, db, "taken@example.test")
	tok := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	change := func(tok string, body fiber.Map) call {
		return call{method: "POST", path: "/v1/me/email", bearer: tok, body: body}
	}
	confirm := func(tok, code string) call {
		return call{method: "POST", path: "/v1/me/email/confirm", bearer: tok, body: fiber.Map{"code": code}}
	}
	// Each case below gets its own member, since requests are limited per member.
	fresh := func(email string) (string, string) {
		id := member(t, db, email)
		return id, deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	}

	if r := must(t, f, 503, change(tok, fiber.Map{"email": "new@example.test", "password": testPassword})); r.message() == "" {
		t.Fatal("no message without email delivery")
	}
	mail := newMailbox(t)
	must(t, f, 400, change(tok, fiber.Map{"email": "not an address", "password": testPassword}))
	must(t, f, 403, change(tok, fiber.Map{"email": "new@example.test", "password": "wrong-password"}))
	must(t, f, 400, change(tok, fiber.Map{"email": "Old@Example.test", "password": testPassword}))
	if r := must(t, f, 409, change(tok, fiber.Map{"email": "taken@example.test", "password": testPassword})); r.message() != "An account with that email already exists." {
		t.Fatalf("taken address: %s", r.body)
	}
	if out := must(t, f, 200, change(tok, fiber.Map{"email": " New@Example.test", "password": testPassword})).object(t); out["email"] != "new@example.test" {
		t.Fatalf("pending address: %v", out)
	}
	code := mail.lastCode(t, "new@example.test")
	must(t, f, 400, confirm(tok, "12345"))
	wrong := "000000"
	if code == wrong {
		wrong = "111111"
	}
	must(t, f, 400, confirm(tok, wrong))
	me := must(t, f, 200, confirm(tok, code)).object(t)
	if me["email"] != "new@example.test" || me["emailVerified"] != true {
		t.Fatalf("after confirming: %v", me)
	}
	if old := mail.to("old@example.test"); len(old) != 1 || !strings.Contains(old[0].Text, "new@example.test") {
		t.Fatalf("old address not told: %v", old)
	}
	must(t, f, 400, confirm(tok, code))
	must(t, f, 200, call{method: "POST", path: "/v1/auth/login", body: fiber.Map{"email": "new@example.test", "password": testPassword}})

	// Five wrong guesses spend a code.
	_, guesser := fresh("guesser@example.test")
	must(t, f, 200, change(guesser, fiber.Map{"email": "guessed@example.test", "password": testPassword}))
	code = mail.lastCode(t, "guessed@example.test")
	for i := 0; i < 5; i++ {
		guess := "99999" + string(rune('0'+i))
		if guess == code {
			guess = "888888"
		}
		must(t, f, 400, confirm(guesser, guess))
	}
	must(t, f, 400, confirm(guesser, code))

	// Someone else claims the address between the code and its use.
	_, racer := fresh("racer@example.test")
	must(t, f, 200, change(racer, fiber.Map{"email": "race@example.test", "password": testPassword}))
	code = mail.lastCode(t, "race@example.test")
	member(t, db, "race@example.test")
	if r := must(t, f, 409, confirm(racer, code)); r.message() != "An account with that email already exists." {
		t.Fatalf("raced address: %s", r.body)
	}

	// A code that can't be delivered is reported, and leaves nothing to confirm.
	bouncerID, bouncer := fresh("bouncer@example.test")
	mail.failing(true)
	must(t, f, 502, change(bouncer, fiber.Map{"email": "bounce@example.test", "password": testPassword}))
	if n := count(t, db, `SELECT count(*) FROM email_codes WHERE user_id=$1 AND purpose='change'`, bouncerID); n != 0 {
		t.Fatalf("undeliverable code kept: %d", n)
	}
}

func TestSignUpSendsAVerificationCode(t *testing.T) {
	db := isolatedDB(t)
	mail := newMailbox(t)
	f := accountsApp(db, false)
	r := must(t, f, 200, call{method: "POST", path: "/v1/auth/register", body: fiber.Map{"name": "Vera Cook", "email": "vera@example.test", "password": "a-long-enough-password"}})
	tok, _ := r.object(t)["token"].(string)
	if tok == "" {
		t.Fatalf("no session: %s", r.body)
	}
	welcome := mail.to("vera@example.test")
	if len(welcome) != 1 || welcome[0].Subject != "Welcome to Savorly" {
		t.Fatalf("welcome: %v", welcome)
	}
	if strings.Contains(welcome[0].Text, "Vera") {
		t.Fatal("letters must not quote what the member typed")
	}
	code := mail.lastCode(t, "vera@example.test")
	if me := must(t, f, 200, call{method: "GET", path: "/v1/me", bearer: tok}).object(t); me["emailVerified"] != false {
		t.Fatalf("verified before the code: %v", me)
	}
	verify := func(code string) call {
		return call{method: "POST", path: "/v1/me/verify-email", bearer: tok, body: fiber.Map{"code": code}}
	}
	must(t, f, 400, verify("abcdef"))
	if me := must(t, f, 200, verify(code)).object(t); me["emailVerified"] != true {
		t.Fatalf("not verified: %v", me)
	}
	if r := must(t, f, 409, call{method: "POST", path: "/v1/me/verify-email/resend", bearer: tok}); r.message() != "Your email address is already confirmed." {
		t.Fatalf("resend when verified: %s", r.body)
	}

	// Resending replaces the code and is limited per member.
	id := member(t, db, "unverified@example.test")
	other := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	resend := call{method: "POST", path: "/v1/me/verify-email/resend", bearer: other}
	must(t, f, 200, resend)
	first := mail.lastCode(t, "unverified@example.test")
	must(t, f, 200, resend)
	second := mail.lastCode(t, "unverified@example.test")
	if first != second {
		must(t, f, 400, call{method: "POST", path: "/v1/me/verify-email", bearer: other, body: fiber.Map{"code": first}})
	}
	for i := 0; i < 3; i++ {
		must(t, f, 200, resend)
	}
	must(t, f, 429, resend)

	// Failed delivery never blocks a sign-up.
	mail.failing(true)
	must(t, f, 200, call{method: "POST", path: "/v1/auth/register", body: fiber.Map{"name": "Nell Cook", "email": "nell@example.test", "password": "a-long-enough-password"}})
}

func TestNewDeviceSignInsAreReported(t *testing.T) {
	db := isolatedDB(t)
	mail := newMailbox(t)
	f := accountsApp(db, false)
	signInMails := func(email string) int {
		n := 0
		for _, m := range mail.to(email) {
			if strings.HasPrefix(m.Subject, "New sign-in") {
				n++
			}
		}
		return n
	}
	must(t, f, 200, call{method: "POST", path: "/v1/auth/register", userAgent: laptopUA, body: fiber.Map{"name": "New Cook", "email": "new@example.test", "password": "a-long-enough-password"}})
	if n := signInMails("new@example.test"); n != 0 {
		t.Fatalf("sign-up reported as a new device: %d", n)
	}

	email := "devices@example.test"
	deviceSession(t, db, member(t, db, email), laptopUA, 20*24*time.Hour)
	login := func(ua string) {
		t.Helper()
		must(t, f, 200, call{method: "POST", path: "/v1/auth/login", userAgent: ua, body: fiber.Map{"email": email, "password": testPassword}})
	}
	newSignIns := func() int { return signInMails(email) }
	login(laptopUA)
	if n := newSignIns(); n != 0 {
		t.Fatalf("a known device reported: %d", n)
	}
	login(phoneUA)
	mine := mail.to(email)
	if n := newSignIns(); n != 1 || !strings.Contains(mine[len(mine)-1].Text, "Safari on iPhone") {
		t.Fatalf("new device: %d %v", n, mine)
	}
	// With no other device signed in, there is no one to warn.
	if _, e := db.Exec(context.Background(), `DELETE FROM sessions`); e != nil {
		t.Fatal(e)
	}
	login("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")
	if n := newSignIns(); n != 1 {
		t.Fatalf("first device reported: %d", n)
	}
}

func TestDeletingAnAccountConfirmsAndClearsTheCookie(t *testing.T) {
	db := isolatedDB(t)
	mail := newMailbox(t)
	f := accountsApp(db, true)
	id := member(t, db, "leaving@example.test")
	tok := deviceSession(t, db, id, laptopUA, 20*24*time.Hour)
	// A wrong password is a 403, not a 401, so the app doesn't take it for a lost session.
	if r := must(t, f, 403, call{method: "DELETE", path: "/v1/me", cookie: tok, origin: testOrigin, body: fiber.Map{"password": "wrong-password"}}); r.message() != "Password is incorrect." {
		t.Fatalf("wrong password: %s", r.body)
	}
	if len(mail.to("leaving@example.test")) != 0 {
		t.Fatal("confirmation sent before the account was deleted")
	}
	r := must(t, f, 204, call{method: "DELETE", path: "/v1/me", cookie: tok, origin: testOrigin, body: fiber.Map{"password": testPassword}})
	cookie := r.sessionCookie()
	if cookie == nil || cookie.MaxAge >= 0 || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Fatalf("cookie not cleared like logout: %+v", cookie)
	}
	if n := count(t, db, `SELECT count(*) FROM users WHERE id=$1`, id); n != 0 {
		t.Fatal("account kept")
	}
	if sent := mail.to("leaving@example.test"); len(sent) != 1 || !strings.Contains(sent[0].Subject, "deleted") {
		t.Fatalf("confirmation: %v", sent)
	}
}

func TestLetters(t *testing.T) {
	for kind := letterWelcome; kind <= letterAccountDeleted; kind++ {
		l := compose(kind, "xx", letterData{Code: "123456", OldEmail: "a@example.test", NewEmail: "b@example.test", Device: "Chrome on macOS", When: time.Now()})
		if l.Subject == "" || l.Text == "" {
			t.Errorf("letter %d is empty", kind)
		}
	}
	for ua, want := range map[string]string{
		phoneUA:  "Safari on iPhone",
		laptopUA: "Chrome on macOS",
		"Savorly/12 CFNetwork/1568.100.1 Darwin/24.0.0": "the Savorly app on iOS",
		"okhttp/4.12.0": "the Savorly app on Android",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0": "Edge on Windows",
		"": "an unrecognized device",
	} {
		if got := deviceLabel(ua); got != want {
			t.Errorf("deviceLabel(%q) = %q, want %q", ua, got, want)
		}
	}
}
