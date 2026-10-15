package app

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Sign in with Apple and Google. Tokens are checked against the providers' published keys,
// must carry a nonce this server issued, and identify people by subject, never by email.
// An email that already has an account is never merged silently: an attacker could have
// registered it first (a "pre-hijacking" attack), so linking happens only from a session
// that already proves the account's owner.

var oauthIssuers = map[string][2]string{ // provider: issuer, signing keys
	"apple":  {"https://appleid.apple.com", "https://appleid.apple.com/auth/keys"},
	"google": {"https://accounts.google.com", "https://www.googleapis.com/oauth2/v3/certs"},
}
var appleEndpoint = "https://appleid.apple.com/auth"

// Native Apple tokens carry the bundle ID, web ones the Services ID. Google tokens from
// every platform carry the web client ID.
func oauthAudiences(provider string) []string {
	ids := map[string][]string{
		"apple":  {os.Getenv("APPLE_BUNDLE_ID"), os.Getenv("APPLE_SERVICES_ID")},
		"google": {os.Getenv("GOOGLE_WEB_CLIENT_ID")},
	}[provider]
	return slices.DeleteFunc(ids, func(s string) bool { return s == "" })
}

func (a *App) verifier(provider string) *oidc.IDTokenVerifier {
	a.oidcOnce.Do(func() {
		a.verifiers = map[string]*oidc.IDTokenVerifier{}
		for name, p := range oauthIssuers {
			keys := oidc.NewRemoteKeySet(context.Background(), p[1])
			a.verifiers[name] = oidc.NewVerifier(p[0], keys, &oidc.Config{SkipClientIDCheck: true})
		}
	})
	return a.verifiers[provider]
}

func (a *App) authNonce(c fiber.Ctx) error {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return e
	}
	nonce := hex.EncodeToString(b)
	if _, e := a.DB.Exec(c.Context(), `DELETE FROM auth_nonces WHERE expires_at<now()`); e != nil {
		return e
	}
	if _, e := a.DB.Exec(c.Context(), `INSERT INTO auth_nonces(hash,expires_at) VALUES($1,now()+interval '10 minutes')`, hashToken(nonce)); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"nonce": nonce})
}

type providerIdentity struct {
	Provider, Subject, Email, Name, ClientID string
	EmailVerified                            bool
}

func (a *App) verifyIdentity(ctx context.Context, provider, raw string) (providerIdentity, error) {
	audiences := oauthAudiences(provider)
	if _, known := oauthIssuers[provider]; !known || len(audiences) == 0 {
		return providerIdentity{}, fiber.NewError(503, "That sign-in option isn't set up yet.")
	}
	tok, e := a.verifier(provider).Verify(ctx, raw)
	if e != nil {
		return providerIdentity{}, fiber.NewError(401, "That sign-in couldn't be verified. Please try again.")
	}
	id := providerIdentity{Provider: provider, Subject: tok.Subject}
	for _, aud := range tok.Audience {
		if slices.Contains(audiences, aud) {
			id.ClientID = aud
		}
	}
	var claims struct {
		Email, Name, Nonce string
		EmailVerified      json.RawMessage `json:"email_verified"` // Apple sends "true" as a string
	}
	if e = tok.Claims(&claims); e != nil || id.ClientID == "" || tok.Subject == "" {
		return providerIdentity{}, fiber.NewError(401, "That sign-in couldn't be verified. Please try again.")
	}
	r, e := a.DB.Exec(ctx, `DELETE FROM auth_nonces WHERE hash=$1 AND expires_at>now()`, hashToken(claims.Nonce))
	if e != nil {
		return providerIdentity{}, e
	}
	if claims.Nonce == "" || r.RowsAffected() == 0 {
		return providerIdentity{}, fiber.NewError(401, "That sign-in expired. Please try again.")
	}
	id.Email, id.Name = strings.ToLower(strings.TrimSpace(claims.Email)), claims.Name
	id.EmailVerified = string(claims.EmailVerified) == "true" || string(claims.EmailVerified) == `"true"`
	return id, nil
}

// signedInUser is the session's user when a request carries one, without requiring it.
func (a *App) signedInUser(c fiber.Ctx) string {
	var id string
	_ = a.DB.QueryRow(c.Context(), `SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()`, hashToken(token(c))).Scan(&id)
	return id
}

func providerName(p string) string {
	if p == "apple" {
		return "Apple"
	}
	return "Google"
}

func (a *App) oauthSignIn(c fiber.Ctx) error {
	var in struct{ Provider, Token, Code, Name string }
	if e := decode(c, &in); e != nil {
		return e
	}
	ctx := c.Context()
	id, e := a.verifyIdentity(ctx, in.Provider, in.Token)
	if e != nil {
		return e
	}
	current := a.signedInUser(c)
	var owner string
	e = a.DB.QueryRow(ctx, `SELECT user_id FROM identities WHERE provider=$1 AND subject=$2`, id.Provider, id.Subject).Scan(&owner)
	switch {
	case e == nil:
		if current != "" && current != owner {
			return fiber.NewError(409, "This "+providerName(id.Provider)+" account is already connected to a different Savorly kitchen.")
		}
	case !errors.Is(e, pgx.ErrNoRows):
		return e
	case current != "":
		owner = current
		if _, e = a.DB.Exec(ctx, `INSERT INTO identities(provider,subject,user_id,email) VALUES($1,$2,$3,$4)`, id.Provider, id.Subject, owner, id.Email); e != nil {
			return e
		}
	default:
		if owner, e = a.createProviderUser(ctx, id, in.Name); e != nil {
			return e
		}
	}
	// A provider that verified this same address proves the kitchen's email, as a reset code does.
	if id.EmailVerified && id.Email != "" {
		if _, e = a.DB.Exec(ctx, `UPDATE users SET email_verified=true WHERE id=$1 AND email=$2 AND NOT email_verified`, owner, id.Email); e != nil {
			return e
		}
	}
	if id.Provider == "apple" && in.Code != "" {
		// Kept only to revoke access when the account is deleted; sign-in works without it.
		if refresh, e := appleRefreshToken(ctx, id.ClientID, in.Code); e != nil {
			slog.Warn("apple code exchange", "error", e)
		} else if refresh != "" {
			_, _ = a.DB.Exec(ctx, `UPDATE identities SET refresh_token=$3,client_id=$4 WHERE provider=$1 AND subject=$2`, id.Provider, id.Subject, refresh, id.ClientID)
		}
	}
	if current != "" {
		return c.JSON(fiber.Map{"ok": true, "connected": id.Provider})
	}
	return a.session(c, owner)
}

func (a *App) createProviderUser(ctx context.Context, id providerIdentity, name string) (string, error) {
	if id.Email == "" || !id.EmailVerified {
		return "", fiber.NewError(400, "Your "+providerName(id.Provider)+" account needs a verified email to create a kitchen.")
	}
	if e := a.signupsOpen(ctx); e != nil {
		return "", e
	}
	var taken bool
	if e := a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE email=$1)`, id.Email).Scan(&taken); e != nil {
		return "", e
	}
	if taken {
		return "", fiber.NewError(409, "A kitchen already uses this email. Sign in with your password, then connect "+providerName(id.Provider)+" from My kitchen.")
	}
	name = strings.TrimSpace(name)
	if !validText(name, 2, 70) {
		name = strings.TrimSpace(id.Name)
	}
	if !validText(name, 2, 70) {
		name = "Savorly cook"
	}
	owner := uuid.NewString()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	// "!" is never a bcrypt hash: no password works until the owner sets one by email.
	if _, e = tx.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle,email_verified) VALUES($1,$2,'!',$3,$4,true)`, owner, id.Email, name, newHandle(name, owner)); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO identities(provider,subject,user_id,email) VALUES($1,$2,$3,$4)`, id.Provider, id.Subject, owner, id.Email); e != nil {
		return "", e
	}
	return owner, tx.Commit(ctx)
}

// appleClientSecret is the short-lived ES256 JWT Apple's token endpoints require. Empty
// when the team's Sign in with Apple key isn't configured.
func appleClientSecret(clientID string) (string, error) {
	team, keyID, raw := os.Getenv("APPLE_TEAM_ID"), os.Getenv("APPLE_KEY_ID"), os.Getenv("APPLE_PRIVATE_KEY")
	if team == "" || keyID == "" || raw == "" {
		return "", nil
	}
	block, _ := pem.Decode([]byte(strings.ReplaceAll(raw, `\n`, "\n")))
	if block == nil {
		return "", errors.New("APPLE_PRIVATE_KEY is not PEM")
	}
	parsed, e := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(*ecdsa.PrivateKey)
	if e != nil || !ok {
		return "", errors.New("APPLE_PRIVATE_KEY is not an EC key")
	}
	signer, e := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", keyID))
	if e != nil {
		return "", e
	}
	now := time.Now()
	return jwt.Signed(signer).Claims(jwt.Claims{Issuer: team, Subject: clientID, Audience: jwt.Audience{"https://appleid.apple.com"}, IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(now.Add(5 * time.Minute))}).Serialize()
}

func applePost(ctx context.Context, path string, form url.Values, out any) error {
	req, e := http.NewRequestWithContext(ctx, "POST", appleEndpoint+path, strings.NewReader(form.Encode()))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, e := stripeHTTP.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New("apple returned " + res.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func appleRefreshToken(ctx context.Context, clientID, code string) (string, error) {
	secret, e := appleClientSecret(clientID)
	if e != nil || secret == "" {
		return "", e
	}
	form := url.Values{"client_id": {clientID}, "client_secret": {secret}, "code": {code}, "grant_type": {"authorization_code"}}
	if clientID == os.Getenv("APPLE_SERVICES_ID") {
		form.Set("redirect_uri", os.Getenv("APPLE_REDIRECT_URI"))
	}
	var out struct {
		RefreshToken string `json:"refresh_token"`
	}
	e = applePost(ctx, "/token", form, &out)
	return out.RefreshToken, e
}

// revokeApple withdraws the app's Sign in with Apple access, as Apple asks of account deletion.
func (a *App) revokeApple(ctx context.Context, owner string) error {
	rows, e := a.DB.Query(ctx, `SELECT refresh_token,client_id FROM identities WHERE user_id=$1 AND provider='apple' AND refresh_token<>''`, owner)
	if e != nil {
		return e
	}
	type grant struct{ token, client string }
	grants := []grant{}
	for rows.Next() {
		var g grant
		if e = rows.Scan(&g.token, &g.client); e != nil {
			rows.Close()
			return e
		}
		grants = append(grants, g)
	}
	rows.Close()
	for _, g := range grants {
		secret, e := appleClientSecret(g.client)
		if e != nil {
			return e
		}
		if e = applePost(ctx, "/revoke", url.Values{"client_id": {g.client}, "client_secret": {secret}, "token": {g.token}, "token_type_hint": {"refresh_token"}}, nil); e != nil {
			return e
		}
	}
	return nil
}
