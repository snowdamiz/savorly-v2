package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/limiter"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Savorly as an OAuth 2.1 authorization server, so a member can link ChatGPT, Claude or another
// assistant to their kitchen for the MCP server (mcp.go; docs/ASSISTANTS.md). Apps name a client
// ID metadata document or register themselves (RFC 7591); the member says yes on a page of the
// web app (/oauth/authorize, which asks /v1/oauth/authorize); PKCE with S256 is required; codes
// work once; refresh tokens rotate, and one used twice ends the link. Tokens are random and
// stored hashed, like sessions, and they work only on /mcp: the API's own routes look for
// sessions, which these never are.

const (
	oauthCodeTTL    = 5 * time.Minute
	oauthAccessTTL  = time.Hour
	oauthRefreshTTL = 90 * 24 * time.Hour
	// A refresh token presented again this soon after its first use is an app retrying, or
	// refreshing twice at once, rather than a copy in other hands: it gets new tokens too.
	refreshReuseGrace = 10 * time.Second
	// A client ID metadata document is read again after this long.
	clientDocumentTTL = 24 * time.Hour
)

// oauthScopes are what an app can ask for, each a line on the consent page: saving recipes, the
// meal plan and the grocery list. Searching and reading recipes need none.
var oauthScopes = []string{"cookbooks", "planner", "groceries"}

// knownAssistantHosts are the assistants Savorly lists itself in. An app from one of them (its
// client ID metadata document, or every return address) shows as verified on the consent page;
// others get a caution.
var knownAssistantHosts = []string{"chatgpt.com", "claude.ai", "claude.com"}

// assistantServer serves the MCP server and its authorization server at the root, where the
// assistants look for them (the Worker sends these paths to the API). app.go registers them
// before the API's limit per address: an assistant calls for all its users from a few addresses
// of its own, so these routes have their own limits (mcp.go has /mcp's).
func (a *App) assistantServer(f *fiber.App) {
	discovery := rateLimit(600, time.Minute)
	f.Get("/.well-known/oauth-protected-resource", discovery, a.protectedResource)
	f.Get("/.well-known/oauth-protected-resource/mcp", discovery, a.protectedResource)
	f.Get("/.well-known/oauth-authorization-server", discovery, a.authorizationServer)
	f.Post("/oauth/register", rateLimit(30, time.Minute), oauthEndpoint(a.registerClient))
	f.Post("/oauth/token", perClient(600, time.Minute), oauthEndpoint(a.oauthToken))
	f.Post("/oauth/revoke", perClient(600, time.Minute), oauthEndpoint(a.oauthRevoke))
	f.Post("/mcp", a.mcp)
	f.Get("/mcp", mcpGet)
	f.Delete("/mcp", a.mcpEnd)
}

// assistantRoutes are the consent page's routes and My kitchen's Connected apps.
func (a *App) assistantRoutes(v fiber.Router) {
	v.Get("/oauth/authorize", rateLimit(60, time.Minute), a.consentRequest)
	v.Post("/oauth/authorize", a.requireAuth, perUser(30, 15*time.Minute), a.consentDecision)
	v.Get("/me/connected-apps", a.requireAuth, a.connectedApps)
	v.Delete("/me/connected-apps/:id", a.requireAuth, a.disconnectApp)
}

// perClient limits token and revocation requests per address and app, so the apps of one
// assistant's shared addresses don't use up each other's budget.
func perClient(max int, window time.Duration) fiber.Handler {
	return limiter.New(limiter.Config{Max: max, Expiration: window,
		KeyGenerator: func(c fiber.Ctx) string {
			id := ""
			if form, e := url.ParseQuery(string(c.Body())); e == nil {
				id = form.Get("client_id")
			}
			if id == "" {
				id, _, _ = basicCredentials(c)
			}
			return c.IP() + "|" + id
		},
		LimitReached: oauthEndpoint(func(c fiber.Ctx) error {
			return oauthError(429, "too_many_requests", "Too many requests. Please wait a moment and try again.")
		})})
}

// mcpOrigin is where /mcp, the OAuth endpoints and their metadata are served, and the issuer:
// MCP_ORIGIN, or in production the site itself (the Worker sends those paths to the API), or in
// development the API's own address.
func (a *App) mcpOrigin(c fiber.Ctx) string {
	if origin := strings.TrimRight(os.Getenv("MCP_ORIGIN"), "/"); origin != "" {
		return origin
	}
	if a.Config.Production {
		return appURL(a.Config)
	}
	return strings.TrimRight(c.BaseURL(), "/")
}

// mcpResource is the MCP server's canonical URI (RFC 8707): what tokens are for.
func (a *App) mcpResource(c fiber.Ctx) string { return a.mcpOrigin(c) + "/mcp" }

func (a *App) resourceMetadataURL(c fiber.Ctx) string {
	return a.mcpOrigin(c) + "/.well-known/oauth-protected-resource/mcp"
}

// sameResource compares resource URIs as RFC 3986 does: scheme and host ignore case, and a
// trailing slash doesn't make another server.
func sameResource(a, b string) bool {
	canonical := func(s string) string {
		u, e := url.Parse(strings.TrimSpace(s))
		if e != nil || u.Fragment != "" {
			return ""
		}
		u.Scheme, u.Host = strings.ToLower(u.Scheme), strings.ToLower(u.Host)
		u.Path = strings.TrimRight(u.Path, "/")
		return u.String()
	}
	x := canonical(a)
	return x != "" && x == canonical(b)
}

// publicMetadata answers a discovery document, which any page may read.
func publicMetadata(c fiber.Ctx, body fiber.Map) error {
	c.Set("Cache-Control", "public, max-age=3600")
	c.Set("Access-Control-Allow-Origin", "*")
	return c.JSON(body)
}

// protectedResource is the MCP server's metadata (RFC 9728), at the root and with /mcp after it.
func (a *App) protectedResource(c fiber.Ctx) error {
	site := appURL(a.Config)
	return publicMetadata(c, fiber.Map{
		"resource":                 a.mcpResource(c),
		"authorization_servers":    []string{a.mcpOrigin(c)},
		"scopes_supported":         oauthScopes,
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "Savorly",
		"resource_documentation":   site,
		"resource_policy_uri":      site + "/privacy",
		"resource_tos_uri":         site + "/terms",
	})
}

// authorizationServer is the authorization server's metadata (RFC 8414). The authorization
// endpoint is the web app's consent page; the rest are the API's.
func (a *App) authorizationServer(c fiber.Ctx) error {
	issuer, site := a.mcpOrigin(c), appURL(a.Config)
	// "none" is what Claude and ChatGPT look for before they use a client ID metadata document.
	methods := []string{"none", "client_secret_post", "client_secret_basic"}
	return publicMetadata(c, fiber.Map{
		"issuer":                                         issuer,
		"authorization_endpoint":                         site + "/oauth/authorize",
		"token_endpoint":                                 issuer + "/oauth/token",
		"registration_endpoint":                          issuer + "/oauth/register",
		"revocation_endpoint":                            issuer + "/oauth/revoke",
		"scopes_supported":                               oauthScopes,
		"response_types_supported":                       []string{"code"},
		"response_modes_supported":                       []string{"query"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"token_endpoint_auth_methods_supported":          methods,
		"revocation_endpoint_auth_methods_supported":     methods,
		"code_challenge_methods_supported":               []string{"S256"},
		"authorization_response_iss_parameter_supported": true,
		"client_id_metadata_document_supported":          true,
		"service_documentation":                          site,
		"op_policy_uri":                                  site + "/privacy",
		"op_tos_uri":                                     site + "/terms",
	})
}

// oauthClient is an app as stored.
type oauthClient struct {
	ID, Name, URI, AuthMethod, SecretHash string
	RedirectURIs                          []string
	MetadataDocument                      bool
}

// host is who the app is: for a client ID metadata document the site that serves it, which
// vouches for it, rather than the name it gives itself; otherwise where it sends members back.
func (o oauthClient) host() string {
	if o.MetadataDocument {
		return redirectHost(o.ID)
	}
	if len(o.RedirectURIs) > 0 {
		return redirectHost(o.RedirectURIs[0])
	}
	return ""
}

// verified reports whether the app comes from one of the assistants Savorly lists itself in.
func (o oauthClient) verified() bool {
	if o.MetadataDocument {
		return slices.Contains(knownAssistantHosts, o.host())
	}
	return knownApp(o.RedirectURIs)
}

// public is the app as the consent page and Connected apps show it.
func (o oauthClient) public() fiber.Map {
	return fiber.Map{"id": o.ID, "name": o.Name, "uri": o.URI, "host": o.host(), "verified": o.verified()}
}

// knownApp reports whether every return address is on one of the assistants Savorly lists
// itself in.
func knownApp(redirects []string) bool {
	for _, r := range redirects {
		u, e := url.Parse(r)
		if e != nil || u.Scheme != "https" || !slices.Contains(knownAssistantHosts, strings.ToLower(u.Hostname())) {
			return false
		}
	}
	return len(redirects) > 0
}

// validRedirect is a return address an app may register: absolute HTTPS, or HTTP on this
// machine (a native app's loopback), without a fragment or credentials. MCP's authorization
// rules allow nothing else.
func validRedirect(raw string) bool {
	if raw == "" || len(raw) > 2000 || strings.Contains(raw, "#") {
		return false
	}
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || u.Host == "" || u.Opaque != "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		return loopback(u.Hostname())
	}
	return false
}

func loopback(host string) bool { return host == "localhost" || host == "127.0.0.1" || host == "::1" }

// redirectAllowed reports whether an authorization request may return to redirect: one of the
// app's registered addresses exactly, or a loopback one on another port (RFC 8252, 7.3), since a
// native app such as Claude Code listens on whichever port is free.
func redirectAllowed(registered []string, redirect string) bool {
	if slices.Contains(registered, redirect) {
		return true
	}
	u, e := url.Parse(redirect)
	if e != nil || u.Scheme != "http" || !loopback(u.Hostname()) || u.User != nil || u.Fragment != "" {
		return false
	}
	for _, r := range registered {
		v, e := url.Parse(r)
		if e == nil && v.Scheme == "http" && v.Hostname() == u.Hostname() && v.EscapedPath() == u.EscapedPath() && v.RawQuery == u.RawQuery {
			return true
		}
	}
	return false
}

func redirectHost(raw string) string {
	u, e := url.Parse(raw)
	if e != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// cleanName is an app's self-chosen name made safe to show: one line, printable, short.
func cleanName(name string) string {
	name = strings.Join(strings.FieldsFunc(name, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	return name
}

// newSecret is a random token with a prefix that says what it is.
func newSecret(prefix string) (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return prefix + hex.EncodeToString(b), nil
}

const clientColumns = `id,name,uri,auth_method,secret_hash,redirect_uris,metadata_document`

func scanClient(row pgx.Row, more ...any) (oauthClient, error) {
	var o oauthClient
	e := row.Scan(append([]any{&o.ID, &o.Name, &o.URI, &o.AuthMethod, &o.SecretHash, &o.RedirectURIs, &o.MetadataDocument}, more...)...)
	return o, e
}

var errUnknownClient = errors.New("unknown client")

// findClient is the app a request names: a registered one, or one whose id is the address of its
// client ID metadata document, read the first time it's seen and, when fetch is set, again after
// a day. When the document can't be read again, the copy kept from before still counts.
func (a *App) findClient(ctx context.Context, id string, fetch bool) (oauthClient, error) {
	var fresh bool
	o, e := scanClient(a.DB.QueryRow(ctx, `SELECT `+clientColumns+` FROM oauth_clients WHERE id=$1`, id))
	known := e == nil
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return o, e
	}
	if known && o.MetadataDocument && fetch {
		if e = a.DB.QueryRow(ctx, `SELECT refreshed_at>now()-$2*interval '1 second' FROM oauth_clients WHERE id=$1`, id, seconds(clientDocumentTTL)).Scan(&fresh); e != nil {
			return o, e
		}
	}
	switch {
	case known && (!o.MetadataDocument || !fetch || fresh):
		return o, nil
	case !known && (!fetch || !metadataDocumentURL(id)):
		return o, errUnknownClient
	}
	read, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	doc, e := readClientDocument(read, id)
	if e != nil {
		if known {
			slog.Warn("client metadata document unavailable; using the kept copy", "client", id, "error", e)
			return o, nil
		}
		slog.Info("client metadata document refused", "client", id, "error", e)
		return o, errUnknownClient
	}
	_, e = a.DB.Exec(ctx, `INSERT INTO oauth_clients(id,name,uri,redirect_uris,metadata_document) VALUES($1,$2,$3,$4,true)
 ON CONFLICT(id) DO UPDATE SET name=excluded.name,uri=excluded.uri,redirect_uris=excluded.redirect_uris,refreshed_at=now() WHERE oauth_clients.metadata_document`, doc.ID, doc.Name, doc.URI, doc.RedirectURIs)
	return doc, e
}

// metadataDocumentURL reports whether a client id is the address of a client ID metadata
// document: HTTPS with a path, no fragment, credentials or dot segments.
func metadataDocumentURL(id string) bool {
	u, e := url.Parse(id)
	if e != nil || len(id) > 2000 || u.Scheme != "https" || u.Host == "" || u.User != nil || strings.Contains(id, "#") || u.Path == "" || u.Path == "/" {
		return false
	}
	segments := strings.Split(u.Path, "/")
	return !slices.Contains(segments, "..") && !slices.Contains(segments, ".")
}

// readClientDocument reads an app's client ID metadata document through the import's guard
// (public addresses only), and checks it names itself, its return addresses, and PKCE without a
// secret, the only way Savorly authenticates such an app.
func readClientDocument(ctx context.Context, id string) (oauthClient, error) {
	b, e := fetchJSON(ctx, id, 5<<10)
	if e != nil {
		return oauthClient{}, e
	}
	var doc struct {
		ClientID     string   `json:"client_id"`
		ClientName   string   `json:"client_name"`
		ClientURI    string   `json:"client_uri"`
		RedirectURIs []string `json:"redirect_uris"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
		AuthMethods  []string `json:"token_endpoint_auth_methods_supported"`
	}
	if e = json.Unmarshal(b, &doc); e != nil {
		return oauthClient{}, e
	}
	switch {
	case doc.ClientID != id:
		return oauthClient{}, errors.New("client_id doesn't match the document's address")
	case len(doc.RedirectURIs) == 0 || len(doc.RedirectURIs) > 20 || slices.ContainsFunc(doc.RedirectURIs, func(r string) bool { return !validRedirect(r) }):
		return oauthClient{}, errors.New("redirect_uris missing or not allowed")
	case len(doc.AuthMethods) > 0 && !slices.Contains(doc.AuthMethods, "none"), len(doc.AuthMethods) == 0 && doc.AuthMethod != "" && doc.AuthMethod != "none":
		return oauthClient{}, errors.New("the app needs a token endpoint authentication Savorly doesn't offer")
	}
	o := oauthClient{ID: id, Name: cleanName(doc.ClientName), URI: doc.ClientURI, AuthMethod: "none", RedirectURIs: doc.RedirectURIs, MetadataDocument: true}
	if o.Name == "" {
		o.Name = redirectHost(id)
	}
	if !strings.HasPrefix(o.URI, "https://") || len(o.URI) > 2000 {
		o.URI = ""
	}
	return o, nil
}

// registerClient is dynamic client registration (RFC 7591). An app that registers no
// token_endpoint_auth_method gets a secret, as the RFC's default (client_secret_basic) says.
func (a *App) registerClient(c fiber.Ctx) error {
	var in struct {
		RedirectURIs  []string `json:"redirect_uris"`
		ClientName    string   `json:"client_name"`
		ClientURI     string   `json:"client_uri"`
		GrantTypes    []string `json:"grant_types"`
		ResponseTypes []string `json:"response_types"`
		AuthMethod    *string  `json:"token_endpoint_auth_method"`
	}
	if e := json.Unmarshal(c.Body(), &in); e != nil {
		return oauthError(400, "invalid_client_metadata", "The body must be a JSON object of client metadata.")
	}
	if len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > 10 || slices.ContainsFunc(in.RedirectURIs, func(r string) bool { return !validRedirect(r) }) {
		return oauthError(400, "invalid_redirect_uri", "Give 1 to 10 redirect URIs, each HTTPS or http://localhost, without a fragment.")
	}
	if len(in.GrantTypes) == 0 {
		in.GrantTypes = []string{"authorization_code"}
	}
	if len(in.ResponseTypes) == 0 {
		in.ResponseTypes = []string{"code"}
	}
	for _, g := range in.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			return oauthError(400, "invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.")
		}
	}
	if !slices.Equal(in.ResponseTypes, []string{"code"}) {
		return oauthError(400, "invalid_client_metadata", "Only the code response type is supported.")
	}
	method := "client_secret_basic"
	if in.AuthMethod != nil {
		method = *in.AuthMethod
	}
	if method != "none" && method != "client_secret_post" && method != "client_secret_basic" {
		return oauthError(400, "invalid_client_metadata", "Use none, client_secret_post or client_secret_basic as token_endpoint_auth_method.")
	}
	name := cleanName(in.ClientName)
	if name == "" {
		name = redirectHost(in.RedirectURIs[0])
	}
	uri := in.ClientURI
	if !strings.HasPrefix(uri, "https://") || len(uri) > 2000 {
		uri = ""
	}
	id := uuid.NewString()
	var secret, secretHash string
	if method != "none" {
		var e error
		if secret, e = newSecret("svcs_"); e != nil {
			return e
		}
		secretHash = hashToken(secret)
	}
	var issued time.Time
	if e := a.DB.QueryRow(c.Context(), `INSERT INTO oauth_clients(id,name,uri,redirect_uris,auth_method,secret_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at`, id, name, uri, in.RedirectURIs, method, secretHash).Scan(&issued); e != nil {
		return e
	}
	out := fiber.Map{"client_id": id, "client_id_issued_at": issued.Unix(), "client_name": name, "redirect_uris": in.RedirectURIs,
		"grant_types": in.GrantTypes, "response_types": in.ResponseTypes, "token_endpoint_auth_method": method}
	if uri != "" {
		out["client_uri"] = uri
	}
	if secret != "" {
		out["client_secret"], out["client_secret_expires_at"] = secret, 0
	}
	c.Set("Cache-Control", "no-store")
	return c.Status(201).JSON(out)
}

// oauthFailure is an OAuth endpoint's refusal, which oauthEndpoint answers as OAuth does:
// {"error", "error_description"}.
type oauthFailure struct {
	status            int
	code, description string
}

func (e *oauthFailure) Error() string { return e.code + ": " + e.description }

func oauthError(status int, code, description string) error {
	return &oauthFailure{status, code, description}
}

// oauthEndpoint answers an OAuth endpoint's refusals in OAuth's form; other errors go to the
// API's error handler.
func oauthEndpoint(h fiber.Handler) fiber.Handler {
	return func(c fiber.Ctx) error {
		e := h(c)
		var refused *oauthFailure
		if errors.As(e, &refused) {
			c.Set("Cache-Control", "no-store")
			return c.Status(refused.status).JSON(fiber.Map{"error": refused.code, "error_description": refused.description})
		}
		return e
	}
}

// authRequest is a checked authorization request: the query of /oauth/authorize.
type authRequest struct {
	client                               oauthClient
	redirect, state, challenge, resource string
	scopes                               []string
}

var (
	errBadAuthLink    = fiber.NewError(400, "This link to connect an app isn't valid. Start again from the app you came from.")
	errUnknownApp     = fiber.NewError(400, "This app isn't registered with Savorly. Start again from the app you came from.")
	errUnknownReturn  = fiber.NewError(400, "This app's return address doesn't match the one it registered. Start again from the app you came from.")
	pkceChallengeForm = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pkceVerifierForm  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

// readAuthRequest checks an authorization request. When the app or its return address can't be
// trusted it fails with an error to show, never a redirect. Anything else wrong goes back to the
// app as an OAuth error at its return address (back), as RFC 6749 asks.
func (a *App) readAuthRequest(c fiber.Ctx, raw string) (req authRequest, back string, err error) {
	q, e := url.ParseQuery(raw)
	if e != nil {
		return req, "", errBadAuthLink
	}
	one := func(k string) (string, bool) { v := q[k]; return strings.Join(v, ""), len(v) <= 1 }
	id, ok := one("client_id")
	if !ok || id == "" {
		return req, "", errBadAuthLink
	}
	if req.client, e = a.findClient(c.Context(), id, true); errors.Is(e, errUnknownClient) {
		return req, "", errUnknownApp
	} else if e != nil {
		return req, "", e
	}
	redirect, ok := one("redirect_uri")
	if !ok {
		return req, "", errBadAuthLink
	}
	if redirect == "" && len(req.client.RedirectURIs) == 1 {
		redirect = req.client.RedirectURIs[0]
	}
	if !redirectAllowed(req.client.RedirectURIs, redirect) {
		return req, "", errUnknownReturn
	}
	req.redirect = redirect
	req.state, _ = one("state")
	refuse := func(code, description string) (authRequest, string, error) {
		return req, a.authResponse(c, req, url.Values{"error": {code}, "error_description": {description}}), nil
	}
	for _, k := range []string{"response_type", "code_challenge", "code_challenge_method", "scope", "state"} {
		if _, single := one(k); !single {
			return refuse("invalid_request", "The "+k+" parameter appears more than once.")
		}
	}
	if len(req.state) > 2000 {
		return refuse("invalid_request", "The state parameter is too long.")
	}
	if kind, _ := one("response_type"); kind != "code" {
		return refuse("unsupported_response_type", "Only the code response type is supported.")
	}
	req.challenge, _ = one("code_challenge")
	if method, _ := one("code_challenge_method"); method != "S256" || !pkceChallengeForm.MatchString(req.challenge) {
		return refuse("invalid_request", "PKCE with code_challenge_method S256 is required.")
	}
	scope, _ := one("scope")
	req.scopes = grantableScopes(scope)
	req.resource = a.mcpResource(c)
	if r := q["resource"]; len(r) > 1 || (len(r) == 1 && !sameResource(r[0], req.resource)) {
		return refuse("invalid_target", "Tokens can only be for "+req.resource+".")
	}
	return req, "", nil
}

// grantableScopes is the part of a requested scope Savorly knows. Asking for none of them (no
// scope, or only others such as offline_access or openid) asks for all three, which the consent
// page then lists.
func grantableScopes(scope string) []string {
	asked := strings.Fields(scope)
	out := []string{}
	for _, s := range oauthScopes {
		if slices.Contains(asked, s) {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return slices.Clone(oauthScopes)
	}
	return out
}

// authResponse is where an authorization request returns to the app: its return address with
// the answer, the state it sent, and who answered (iss, RFC 9207).
func (a *App) authResponse(c fiber.Ctx, req authRequest, answer url.Values) string {
	u, e := url.Parse(req.redirect)
	if e != nil {
		return req.redirect
	}
	q := u.Query()
	for k, v := range answer {
		q[k] = v
	}
	if req.state != "" {
		q.Set("state", req.state)
	}
	q.Set("iss", a.mcpOrigin(c))
	u.RawQuery = q.Encode()
	return u.String()
}

// consentRequest describes an authorization request for the consent page, or answers
// {"redirect"} when it can only go back to the app with an error. It needs no session: the page
// names the app while it asks the member to sign in.
func (a *App) consentRequest(c fiber.Ctx) error {
	req, back, e := a.readAuthRequest(c, string(c.Request().URI().QueryString()))
	if e != nil {
		return e
	}
	if back != "" {
		return c.JSON(fiber.Map{"redirect": back})
	}
	host := redirectHost(req.redirect)
	return c.JSON(fiber.Map{"client": req.client.public(), "redirectHost": host, "localhost": loopback(host), "scopes": req.scopes})
}

// consentDecision is the member's answer on the consent page: { "request": the authorization
// request's query, "approve" }. It answers { "redirect" } back to the app, with a code on a yes.
func (a *App) consentDecision(c fiber.Ctx) error {
	var in struct {
		Request string
		Approve bool
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	req, back, e := a.readAuthRequest(c, in.Request)
	if e != nil {
		return e
	}
	if back != "" {
		return c.JSON(fiber.Map{"redirect": back})
	}
	if !in.Approve {
		return c.JSON(fiber.Map{"redirect": a.authResponse(c, req, url.Values{"error": {"access_denied"}, "error_description": {"The member declined."}})})
	}
	code, e := newSecret("svac_")
	if e != nil {
		return e
	}
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	if _, e = tx.Exec(c.Context(), `INSERT INTO oauth_codes(code_hash,user_id,client_id,redirect_uri,code_challenge,scopes,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 second')`,
		hashToken(code), userID(c), req.client.ID, req.redirect, req.challenge, req.scopes, req.resource, seconds(oauthCodeTTL)); e != nil {
		return e
	}
	if _, e = tx.Exec(c.Context(), `UPDATE oauth_clients SET last_used_at=now() WHERE id=$1`, req.client.ID); e != nil {
		return e
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"redirect": a.authResponse(c, req, url.Values{"code": {code}})})
}

// oauthForm reads a token or revocation request: form-encoded, each parameter at most once.
func oauthForm(c fiber.Ctx) (url.Values, error) {
	if !strings.HasPrefix(strings.ToLower(c.Get("Content-Type")), "application/x-www-form-urlencoded") {
		return nil, oauthError(400, "invalid_request", "Send the request as application/x-www-form-urlencoded.")
	}
	form, e := url.ParseQuery(string(c.Body()))
	if e != nil {
		return nil, oauthError(400, "invalid_request", "The request body isn't valid form data.")
	}
	for k, v := range form {
		if len(v) > 1 {
			return nil, oauthError(400, "invalid_request", "The "+k+" parameter appears more than once.")
		}
	}
	return form, nil
}

// basicCredentials reads HTTP Basic client credentials; each part is form-encoded before the
// Basic encoding (RFC 6749, 2.3.1). present is false without a Basic header.
func basicCredentials(c fiber.Ctx) (user, pass string, present bool) {
	raw, ok := strings.CutPrefix(c.Get("Authorization"), "Basic ")
	if !ok {
		return "", "", false
	}
	pair, e := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	user, pass, found := strings.Cut(string(pair), ":")
	if e != nil || !found {
		return "", "", true
	}
	user, _ = url.QueryUnescape(user)
	pass, _ = url.QueryUnescape(pass)
	return user, pass, true
}

// authenticateClient is the app making a token or revocation request: client_id alone for a
// public app (PKCE proves the rest), or with its secret, in the body or as HTTP Basic.
func (a *App) authenticateClient(c fiber.Ctx, form url.Values) (oauthClient, error) {
	id, secret := form.Get("client_id"), form.Get("client_secret")
	user, pass, basic := basicCredentials(c)
	if basic {
		if user == "" {
			return oauthClient{}, oauthError(401, "invalid_client", "The client credentials aren't valid.")
		}
		if id != "" && id != user {
			return oauthClient{}, oauthError(400, "invalid_request", "The client_id doesn't match the credentials.")
		}
		id, secret = user, pass
	}
	refuse := func() (oauthClient, error) {
		if basic {
			c.Set("WWW-Authenticate", `Basic realm="Savorly"`)
		}
		return oauthClient{}, oauthError(401, "invalid_client", "The client isn't known, or its credentials are wrong.")
	}
	if id == "" {
		return refuse()
	}
	client, e := a.findClient(c.Context(), id, false)
	if errors.Is(e, errUnknownClient) {
		return refuse()
	}
	if e != nil {
		return client, e
	}
	if client.AuthMethod != "none" && (secret == "" || subtle.ConstantTimeCompare([]byte(hashToken(secret)), []byte(client.SecretHash)) != 1) {
		return refuse()
	}
	return client, nil
}

// oauthToken is the token endpoint: an authorization code for the first tokens, and a refresh
// token, rotated each time, for the next.
func (a *App) oauthToken(c fiber.Ctx) error {
	form, e := oauthForm(c)
	if e != nil {
		return e
	}
	client, e := a.authenticateClient(c, form)
	if e != nil {
		return e
	}
	switch form.Get("grant_type") {
	case "authorization_code":
		return a.redeemCode(c, client, form)
	case "refresh_token":
		return a.refreshTokens(c, client, form)
	case "":
		return oauthError(400, "invalid_request", "grant_type is required.")
	}
	return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.")
}

// pkceMatches checks a code verifier against the challenge sent with the authorization request.
func pkceMatches(verifier, challenge string) bool {
	if !pkceVerifierForm.MatchString(verifier) {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

// redeemCode trades an authorization code for the first tokens of a new link (a grant). The code
// is spent by the first attempt, right or wrong; presenting it again ends whatever it started. A
// member who links the same app twice, say from two accounts of the assistant, has two links.
func (a *App) redeemCode(c fiber.Ctx, client oauthClient, form url.Values) error {
	code, verifier := form.Get("code"), form.Get("code_verifier")
	if code == "" || verifier == "" {
		return oauthError(400, "invalid_request", "code and code_verifier are required.")
	}
	ctx := c.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var owner, clientID, redirect, challenge, resource string
	var scopes []string
	var live bool
	e = tx.QueryRow(ctx, `UPDATE oauth_codes o SET used_at=now() FROM users u WHERE o.code_hash=$1 AND o.used_at IS NULL AND u.id=o.user_id
 RETURNING o.user_id,o.client_id,o.redirect_uri,o.code_challenge,o.scopes,o.resource,o.expires_at>now() AND u.suspended_at IS NULL`, hashToken(code)).Scan(&owner, &clientID, &redirect, &challenge, &scopes, &resource, &live)
	if errors.Is(e, pgx.ErrNoRows) {
		// Unknown, or used before: whatever it started is revoked (OAuth 2.1, 4.1.3).
		if _, e = tx.Exec(ctx, `DELETE FROM oauth_grants WHERE id=(SELECT grant_id FROM oauth_codes WHERE code_hash=$1)`, hashToken(code)); e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		return oauthError(400, "invalid_grant", "This authorization code is invalid, expired or already used.")
	}
	if e != nil {
		return e
	}
	sent := form.Get("redirect_uri")
	redirectOK := sent == redirect || (sent == "" && slices.Equal(client.RedirectURIs, []string{redirect}))
	resourceOK := form.Get("resource") == "" || sameResource(form.Get("resource"), resource)
	problem := ""
	switch {
	case !live:
		problem = "This authorization code is invalid, expired or already used."
	case clientID != client.ID:
		problem = "This authorization code was issued to another client."
	case !redirectOK:
		problem = "redirect_uri doesn't match the authorization request."
	case !pkceMatches(verifier, challenge):
		problem = "The code_verifier doesn't match the code_challenge."
	case !resourceOK:
		problem = "resource doesn't match the authorization request."
	}
	if problem != "" {
		// The code stays spent.
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		return oauthError(400, "invalid_grant", problem)
	}
	grant := uuid.NewString()
	if _, e = tx.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,scopes,resource) VALUES($1,$2,$3,$4,$5)`, grant, owner, clientID, scopes, resource); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE oauth_codes SET grant_id=$2 WHERE code_hash=$1`, hashToken(code), grant); e != nil {
		return e
	}
	return a.issueTokens(c, tx, grant, scopes)
}

// issueTokens adds an access and a refresh token to a grant, commits, and answers them.
func (a *App) issueTokens(c fiber.Ctx, tx pgx.Tx, grant string, scopes []string) error {
	ctx := c.Context()
	access, e := newSecret("svat_")
	if e != nil {
		return e
	}
	refresh, e := newSecret("svrt_")
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO oauth_tokens(token_hash,grant_id,kind,expires_at) VALUES($1,$3,'access',now()+$4*interval '1 second'),($2,$3,'refresh',now()+$5*interval '1 second')`,
		hashToken(access), hashToken(refresh), grant, seconds(oauthAccessTTL), seconds(oauthRefreshTTL)); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	c.Set("Cache-Control", "no-store")
	c.Set("Pragma", "no-cache")
	return c.JSON(fiber.Map{"access_token": access, "token_type": "Bearer", "expires_in": int(oauthAccessTTL / time.Second), "refresh_token": refresh, "scope": strings.Join(scopes, " ")})
}

// refreshTokens rotates a refresh token. One presented a second time means two parties hold it,
// so the whole link ends and the member links the app again (OAuth 2.1, 4.3.1), unless the second
// time follows the first within refreshReuseGrace.
func (a *App) refreshTokens(c fiber.Ctx, client oauthClient, form url.Values) error {
	token := form.Get("refresh_token")
	if token == "" {
		return oauthError(400, "invalid_request", "refresh_token is required.")
	}
	ctx := c.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var grant, clientID, resource string
	var scopes []string
	var used, retry, live bool
	e = tx.QueryRow(ctx, `SELECT t.grant_id,t.used_at IS NOT NULL,COALESCE(t.used_at>now()-$2*interval '1 second',false),t.expires_at>now() AND u.suspended_at IS NULL,g.client_id,g.scopes,g.resource
 FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.user_id WHERE t.token_hash=$1 AND t.kind='refresh' FOR UPDATE OF t`, hashToken(token), seconds(refreshReuseGrace)).Scan(&grant, &used, &retry, &live, &clientID, &scopes, &resource)
	if errors.Is(e, pgx.ErrNoRows) || (e == nil && clientID != client.ID) {
		return oauthError(400, "invalid_grant", "This refresh token is invalid or was revoked.")
	}
	if e != nil {
		return e
	}
	if used && !retry {
		if _, e = tx.Exec(ctx, `DELETE FROM oauth_grants WHERE id=$1`, grant); e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		slog.Warn("refresh token reused; connected app disconnected", "grant", grant, "client", clientID)
		return oauthError(400, "invalid_grant", "This refresh token was already used, so the connection was ended to keep the account safe. Connect Savorly again.")
	}
	if !live {
		return oauthError(400, "invalid_grant", "This refresh token has expired. Connect Savorly again.")
	}
	if r := form.Get("resource"); r != "" && !sameResource(r, resource) {
		return oauthError(400, "invalid_target", "Tokens can only be for "+resource+".")
	}
	if s := form.Get("scope"); s != "" && slices.ContainsFunc(strings.Fields(s), func(x string) bool { return !slices.Contains(scopes, x) }) {
		return oauthError(400, "invalid_scope", "A refresh can't add scopes the member didn't grant.")
	}
	if _, e = tx.Exec(ctx, `UPDATE oauth_tokens SET used_at=COALESCE(used_at,now()) WHERE token_hash=$1`, hashToken(token)); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE oauth_grants SET last_used_at=now() WHERE id=$1`, grant); e != nil {
		return e
	}
	return a.issueTokens(c, tx, grant, scopes)
}

// oauthRevoke is token revocation (RFC 7009): a refresh token ends its whole link, an access
// token only itself. It answers 200 for tokens it doesn't know, or that are another app's.
func (a *App) oauthRevoke(c fiber.Ctx) error {
	form, e := oauthForm(c)
	if e != nil {
		return e
	}
	client, e := a.authenticateClient(c, form)
	if e != nil {
		return e
	}
	token := form.Get("token")
	if token == "" {
		return oauthError(400, "invalid_request", "token is required.")
	}
	_, e = a.DB.Exec(c.Context(), `WITH t AS (SELECT t.token_hash,t.grant_id,t.kind FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 AND g.client_id=$2),
 grants AS (DELETE FROM oauth_grants WHERE id IN (SELECT grant_id FROM t WHERE kind='refresh'))
 DELETE FROM oauth_tokens WHERE token_hash IN (SELECT token_hash FROM t WHERE kind='access')`, hashToken(token), client.ID)
	if e != nil {
		return e
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(fiber.Map{})
}

// connectedApps lists the apps the member has linked, newest first, for My kitchen.
func (a *App) connectedApps(c fiber.Ctx) error {
	rows, e := a.DB.Query(c.Context(), `SELECT g.id,o.id,o.name,o.redirect_uris,o.metadata_document,g.scopes,g.created_at,g.last_used_at FROM oauth_grants g JOIN oauth_clients o ON o.id=g.client_id
 WHERE g.user_id=$1 ORDER BY g.created_at DESC,g.id`, userID(c))
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []fiber.Map{}
	for rows.Next() {
		var id string
		var scopes []string
		var connected, used time.Time
		var o oauthClient
		if e = rows.Scan(&id, &o.ID, &o.Name, &o.RedirectURIs, &o.MetadataDocument, &scopes, &connected, &used); e != nil {
			return e
		}
		out = append(out, fiber.Map{"id": id, "name": o.Name, "host": o.host(), "verified": o.verified(), "scopes": scopes, "connectedAt": connected, "lastUsedAt": used})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return c.JSON(out)
}

// disconnectApp ends a link: its tokens stop working at once.
func (a *App) disconnectApp(c fiber.Ctx) error {
	r, e := a.DB.Exec(c.Context(), `DELETE FROM oauth_grants WHERE id=$1 AND user_id=$2`, c.Params("id"), userID(c))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(404, "This app is already disconnected.")
	}
	return c.SendStatus(204)
}

// assistantCaller is who an MCP request acts for: a member, through the grant their token
// belongs to, or nobody.
type assistantCaller struct {
	user, grant string
	scopes      []string
}

// mcpCaller reads an MCP request's access token. A request without one is anonymous; one with a
// token that doesn't work, or works for another server, gets problem to put in a 401. Only
// Savorly's own access tokens count: never a session token, or anything another server issued.
func (a *App) mcpCaller(c fiber.Ctx) (caller assistantCaller, problem string, err error) {
	header := c.Get("Authorization")
	if header == "" {
		return caller, "", nil
	}
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || strings.TrimSpace(token) == "" {
		return caller, "Send the access token as a Bearer token.", nil
	}
	var resource string
	var stale bool
	e := a.DB.QueryRow(c.Context(), `SELECT g.id,g.user_id,g.scopes,g.resource,g.last_used_at<now()-$2*interval '1 second' FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id
 JOIN users u ON u.id=g.user_id AND u.suspended_at IS NULL WHERE t.token_hash=$1 AND t.kind='access' AND t.expires_at>now()`, hashToken(strings.TrimSpace(token)), seconds(sessionTouchEvery)).
		Scan(&caller.grant, &caller.user, &caller.scopes, &resource, &stale)
	if errors.Is(e, pgx.ErrNoRows) {
		return assistantCaller{}, "The access token is invalid or has expired.", nil
	}
	if e != nil {
		return assistantCaller{}, "", e
	}
	if !sameResource(resource, a.mcpResource(c)) {
		return assistantCaller{}, "This access token is for another server.", nil
	}
	if stale {
		if _, e = a.DB.Exec(c.Context(), `UPDATE oauth_grants SET last_used_at=now() WHERE id=$1`, caller.grant); e != nil {
			slog.Warn("touch connected app", "error", e)
		}
	}
	return caller, "", nil
}
