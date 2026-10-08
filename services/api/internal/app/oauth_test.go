package app

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/gofiber/fiber/v3"
)

// fakeProvider stands in for Apple or Google: it publishes a key set and signs ID tokens.
type fakeProvider struct {
	issuer string
	signer jose.Signer
	revoke []string
}

func newFakeProvider(t *testing.T, name string) *fakeProvider {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	p := &fakeProvider{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/keys":
			_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
		case "/auth/token":
			_ = json.NewEncoder(w).Encode(map[string]string{"refresh_token": "apple-refresh"})
		case "/auth/revoke":
			_ = r.ParseForm()
			p.revoke = append(p.revoke, r.PostForm.Get("token"))
		}
	}))
	t.Cleanup(server.Close)
	p.issuer = server.URL
	p.signer, _ = jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	old := oauthIssuers[name]
	oauthIssuers[name] = [2]string{server.URL, server.URL + "/keys"}
	t.Cleanup(func() { oauthIssuers[name] = old })
	return p
}
func (p *fakeProvider) token(t *testing.T, claims map[string]any) string {
	t.Helper()
	all := map[string]any{"iss": p.issuer, "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix()}
	for k, v := range claims {
		all[k] = v
	}
	raw, e := jwt.Signed(p.signer).Claims(all).Serialize()
	if e != nil {
		t.Fatal(e)
	}
	return raw
}

func TestSignInWithGoogleAndApple(t *testing.T) {
	db := isolatedDB(t)
	google := newFakeProvider(t, "google")
	apple := newFakeProvider(t, "apple")
	oldApple := appleEndpoint
	appleEndpoint = apple.issuer + "/auth"
	t.Cleanup(func() { appleEndpoint = oldApple })
	t.Setenv("GOOGLE_WEB_CLIENT_ID", "web-client")
	t.Setenv("APPLE_BUNDLE_ID", "app.savorly.mobile")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	t.Setenv("APPLE_TEAM_ID", "TEAM")
	t.Setenv("APPLE_KEY_ID", "KEY")
	t.Setenv("APPLE_PRIVATE_KEY", string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})))
	testUser(t, db, "existing")
	ctx := context.Background()

	a := &App{DB: db, Config: Config{Origins: []string{"http://localhost:8081"}}}
	f := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	f.Post("/nonce", a.authNonce)
	f.Post("/oauth", a.oauthSignIn)
	f.Post("/login", a.login)
	f.Delete("/me", a.requireAuth, a.deleteMe)
	call := func(method, path string, body any, bearer string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(jsonBytes(body)))
		req.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		res, e := f.Test(req, fiber.TestConfig{Timeout: 10 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	nonce := func() string {
		_, out := call("POST", "/nonce", nil, "")
		return out["nonce"].(string)
	}
	googleToken := func(sub, email, aud, n string) string {
		return google.token(t, map[string]any{"sub": sub, "email": email, "email_verified": true, "aud": aud, "nonce": n, "name": "Gina Cook"})
	}

	status, out := call("POST", "/oauth", map[string]string{"provider": "google", "token": googleToken("g-1", "gina@example.test", "web-client", nonce())}, "")
	session, _ := out["token"].(string)
	if status != 200 || session == "" {
		t.Fatalf("new Google account: %d %v", status, out)
	}
	var name string
	var verified bool
	db.QueryRow(ctx, `SELECT name,email_verified FROM users WHERE email='gina@example.test'`).Scan(&name, &verified)
	if name != "Gina Cook" || !verified {
		t.Fatalf("account fields: %q %v", name, verified)
	}
	if status, _ = call("POST", "/login", map[string]string{"email": "gina@example.test", "password": "!"}, ""); status != 401 {
		t.Fatal("password-less account accepted a password")
	}
	used := nonce()
	if status, _ = call("POST", "/oauth", map[string]string{"provider": "google", "token": googleToken("g-1", "gina@example.test", "web-client", used)}, ""); status != 200 {
		t.Fatalf("returning sign-in %d", status)
	}
	for name, token := range map[string]string{
		"reused nonce":   googleToken("g-1", "gina@example.test", "web-client", used),
		"unknown nonce":  googleToken("g-1", "gina@example.test", "web-client", "not-issued"),
		"other audience": googleToken("g-1", "gina@example.test", "someone-elses-app", nonce()),
		"tampered":       googleToken("g-1", "gina@example.test", "web-client", nonce()) + "x",
	} {
		if status, _ = call("POST", "/oauth", map[string]string{"provider": "google", "token": token}, ""); status != 401 {
			t.Errorf("%s accepted: %d", name, status)
		}
	}
	// Never merged by email: the existing password account must connect from its own session.
	status, out = call("POST", "/oauth", map[string]string{"provider": "google", "token": googleToken("g-2", "existing@example.test", "web-client", nonce())}, "")
	if message, _ := out["error"].(string); status != 409 || !strings.Contains(message, "connect Google") {
		t.Fatalf("silent merge: %d %v", status, out)
	}

	// Apple: first sign-in brings the name and an authorization code; email_verified is a string.
	appleToken := func(sub, n string) string {
		return apple.token(t, map[string]any{"sub": sub, "email": "relay@privaterelay.appleid.com", "email_verified": "true", "aud": "app.savorly.mobile", "nonce": n})
	}
	status, out = call("POST", "/oauth", map[string]string{"provider": "apple", "token": appleToken("a-1", nonce()), "code": "auth-code", "name": "Ana Apple"}, "")
	appleSession, _ := out["token"].(string)
	if status != 200 || appleSession == "" {
		t.Fatalf("new Apple account: %d %v", status, out)
	}
	// Connect Google to the Apple kitchen from its session, then refuse it for anyone else.
	if status, out = call("POST", "/oauth", map[string]string{"provider": "google", "token": googleToken("g-3", "ana@example.test", "web-client", nonce())}, appleSession); status != 200 || out["connected"] != "google" {
		t.Fatalf("connect: %d %v", status, out)
	}
	if status, _ = call("POST", "/oauth", map[string]string{"provider": "google", "token": googleToken("g-3", "ana@example.test", "web-client", nonce())}, session); status != 409 {
		t.Fatalf("identity moved between kitchens: %d", status)
	}

	// Deleting a password-less kitchen takes a fresh sign-in with one of its own providers.
	if status, _ = call("DELETE", "/me", map[string]string{"provider": "google", "token": googleToken("g-1", "gina@example.test", "web-client", nonce())}, appleSession); status != 401 {
		t.Fatalf("deleted with another kitchen's identity: %d", status)
	}
	if status, _ = call("DELETE", "/me", map[string]string{"provider": "apple", "token": appleToken("a-1", nonce())}, appleSession); status != 204 {
		t.Fatalf("delete %d", status)
	}
	var left int
	db.QueryRow(ctx, `SELECT count(*) FROM identities WHERE subject IN ('a-1','g-3')`).Scan(&left)
	if left != 0 || len(apple.revoke) != 1 || apple.revoke[0] != "apple-refresh" {
		t.Fatalf("identities %d, Apple revocations %v", left, apple.revoke)
	}
}
