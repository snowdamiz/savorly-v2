package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The test router answers as http://example.com, so that's the issuer and /mcp's resource.
const (
	testIssuer   = "http://example.com"
	testResource = testIssuer + "/mcp"
	claudeReturn = "https://claude.ai/api/mcp/auth_callback"
)

// pkce is a code verifier and its S256 challenge.
func pkce(seed string) (verifier, challenge string) {
	verifier = strings.Repeat(seed, 50)[:50]
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// oauthPost sends a form to an OAuth endpoint.
func oauthPost(t *testing.T, f *fiber.App, path string, form url.Values, header map[string]string) reply {
	t.Helper()
	h := map[string]string{"Content-Type": "application/x-www-form-urlencoded"}
	for k, v := range header {
		h[k] = v
	}
	return do(t, f, call{method: "POST", path: path, rawBody: []byte(form.Encode()), header: h})
}

// registerTestClient registers an app as Claude does (RFC 7591) and returns its client_id.
func registerTestClient(t *testing.T, f *fiber.App, body map[string]any) string {
	t.Helper()
	r := must(t, f, 201, call{method: "POST", path: "/oauth/register", body: body})
	id, _ := r.object(t)["client_id"].(string)
	if id == "" {
		t.Fatalf("no client_id: %s", r.body)
	}
	return id
}

// consent signs member in on the consent page and answers the authorization request, returning
// where the app is sent back to.
func consent(t *testing.T, f *fiber.App, session string, query url.Values, approve bool) *url.URL {
	t.Helper()
	r := must(t, f, 200, call{method: "POST", path: "/v1/oauth/authorize", bearer: session, body: map[string]any{"request": query.Encode(), "approve": approve}})
	back, e := url.Parse(r.object(t)["redirect"].(string))
	if e != nil {
		t.Fatal(e)
	}
	return back
}

func authorizeQuery(client, redirect, challenge string) url.Values {
	return url.Values{"client_id": {client}, "redirect_uri": {redirect}, "response_type": {"code"}, "code_challenge": {challenge},
		"code_challenge_method": {"S256"}, "state": {"st-1"}, "scope": {"cookbooks planner groceries"}, "resource": {testResource}}
}

// redeem trades a code for tokens.
func redeem(t *testing.T, f *fiber.App, client, code, verifier string) reply {
	t.Helper()
	return oauthPost(t, f, "/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"client_id": {client}, "redirect_uri": {claudeReturn}, "resource": {testResource}}, nil)
}

type tokens struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Scope   string `json:"scope"`
}

func tokensOf(t *testing.T, r reply) tokens {
	t.Helper()
	var out tokens
	if r.status != 200 || json.Unmarshal(r.body, &out) != nil || out.Access == "" || out.Refresh == "" {
		t.Fatalf("no tokens (%d): %s", r.status, r.body)
	}
	return out
}

// mcpWorks reports whether an access token can call a tool that needs a linked account.
func mcpWorks(t *testing.T, f *fiber.App, access string) bool {
	t.Helper()
	body, header := modernRequest("tools/call", map[string]any{"name": "get_grocery_list", "arguments": map[string]any{}})
	r := do(t, f, call{method: "POST", path: "/mcp", body: body, bearer: access, header: header})
	return r.status == 200
}

func TestAssistantDiscoveryDocuments(t *testing.T) {
	f := accountsApp(nil, false)
	for _, path := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"} {
		doc := must(t, f, 200, call{method: "GET", path: path}).object(t)
		if doc["resource"] != testResource || doc["authorization_servers"].([]any)[0] != testIssuer {
			t.Fatalf("%s: %v", path, doc)
		}
	}
	r := must(t, f, 200, call{method: "GET", path: "/.well-known/oauth-authorization-server"})
	doc := r.object(t)
	if doc["issuer"] != testIssuer || doc["token_endpoint"] != testIssuer+"/oauth/token" || doc["authorization_endpoint"] != "http://localhost:8081/oauth/authorize" {
		t.Fatalf("endpoints: %v", doc)
	}
	has := func(key, value string) bool { return slices.Contains(doc[key].([]any), any(value)) }
	// What Claude and ChatGPT check before linking: S256 PKCE, issuer in the response, and a
	// client ID metadata document with "none" at the token endpoint.
	if !has("code_challenge_methods_supported", "S256") || has("code_challenge_methods_supported", "plain") || doc["authorization_response_iss_parameter_supported"] != true ||
		doc["client_id_metadata_document_supported"] != true || !has("token_endpoint_auth_methods_supported", "none") {
		t.Fatalf("capabilities: %v", doc)
	}
	if r.header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("discovery isn't readable from other pages")
	}
}

func TestAssistantLinkingEndToEnd(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	member := member(t, db, "linker@example.test")
	session := bearerFor(t, db, member)
	client := registerTestClient(t, f, map[string]any{"client_name": "Claude", "redirect_uris": []string{claudeReturn}, "token_endpoint_auth_method": "none", "grant_types": []string{"authorization_code", "refresh_token"}})

	// The consent page asks about the request before the member signs in.
	verifier, challenge := pkce("a")
	query := authorizeQuery(client, claudeReturn, challenge)
	about := must(t, f, 200, call{method: "GET", path: "/v1/oauth/authorize?" + query.Encode()}).object(t)
	app := about["client"].(map[string]any)
	if app["name"] != "Claude" || app["verified"] != true || app["host"] != "claude.ai" || about["redirectHost"] != "claude.ai" || about["localhost"] != false || len(about["scopes"].([]any)) != 3 {
		t.Fatalf("described as %v", about)
	}
	// Signing in is needed to answer.
	if r := do(t, f, call{method: "POST", path: "/v1/oauth/authorize", body: map[string]any{"request": query.Encode(), "approve": true}}); r.status != 401 {
		t.Fatalf("answered without a session: %d", r.status)
	}

	// No: back to the app with access_denied, its state and the issuer.
	back := consent(t, f, session, query, false)
	if back.Query().Get("error") != "access_denied" || back.Query().Get("state") != "st-1" || back.Query().Get("iss") != testIssuer || back.Query().Has("code") {
		t.Fatalf("declined to %s", back)
	}

	// Yes: a code, which a wrong verifier spends without tokens.
	back = consent(t, f, session, query, true)
	if back.Host != "claude.ai" || back.Query().Get("state") != "st-1" || back.Query().Get("iss") != testIssuer {
		t.Fatalf("approved to %s", back)
	}
	wrong, _ := pkce("b")
	if r := redeem(t, f, client, back.Query().Get("code"), wrong); r.status != 400 || r.object(t)["error"] != "invalid_grant" {
		t.Fatalf("wrong verifier: %d %s", r.status, r.body)
	}
	if r := redeem(t, f, client, back.Query().Get("code"), verifier); r.status != 400 {
		t.Fatalf("a spent code worked: %s", r.body)
	}

	// A fresh code works once; presenting it again ends the link it made.
	code := consent(t, f, session, query, true).Query().Get("code")
	first := tokensOf(t, redeem(t, f, client, code, verifier))
	if first.Scope != "cookbooks planner groceries" || !mcpWorks(t, f, first.Access) {
		t.Fatalf("first tokens: %+v", first)
	}
	if r := redeem(t, f, client, code, verifier); r.status != 400 || mcpWorks(t, f, first.Access) {
		t.Fatal("a code used twice kept its link")
	}

	// Refresh tokens rotate. One retried at once still answers; one used again later ends the link.
	code = consent(t, f, session, query, true).Query().Get("code")
	linked := tokensOf(t, redeem(t, f, client, code, verifier))
	refresh := func(token string) reply {
		return oauthPost(t, f, "/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token}, "client_id": {client}}, nil)
	}
	next := tokensOf(t, refresh(linked.Refresh))
	if next.Refresh == linked.Refresh || !mcpWorks(t, f, next.Access) {
		t.Fatal("refresh didn't rotate")
	}
	retried := tokensOf(t, refresh(linked.Refresh))
	if !mcpWorks(t, f, retried.Access) {
		t.Fatal("an immediate retry ended the link")
	}
	if _, e := db.Exec(context.Background(), `UPDATE oauth_tokens SET used_at=now()-interval '1 minute' WHERE token_hash=$1`, hashToken(linked.Refresh)); e != nil {
		t.Fatal(e)
	}
	if r := refresh(linked.Refresh); r.status != 400 || r.object(t)["error"] != "invalid_grant" {
		t.Fatalf("reuse: %d %s", r.status, r.body)
	}
	if mcpWorks(t, f, next.Access) || refresh(next.Refresh).status != 400 {
		t.Fatal("a reused refresh token didn't end the link")
	}

	// Connected apps lists a link, and disconnecting it stops its tokens at once.
	code = consent(t, f, session, query, true).Query().Get("code")
	kept := tokensOf(t, redeem(t, f, client, code, verifier))
	var apps []map[string]any
	if e := json.Unmarshal(must(t, f, 200, call{method: "GET", path: "/v1/me/connected-apps", bearer: session}).body, &apps); e != nil || len(apps) != 1 {
		t.Fatalf("connected apps: %v %v", apps, e)
	}
	if apps[0]["name"] != "Claude" || apps[0]["host"] != "claude.ai" || apps[0]["verified"] != true || apps[0]["lastUsedAt"] == nil {
		t.Fatalf("listed as %v", apps[0])
	}
	must(t, f, 204, call{method: "DELETE", path: "/v1/me/connected-apps/" + apps[0]["id"].(string), bearer: session})
	if mcpWorks(t, f, kept.Access) || refresh(kept.Refresh).status != 400 {
		t.Fatal("disconnected tokens still work")
	}
	if r := do(t, f, call{method: "DELETE", path: "/v1/me/connected-apps/" + apps[0]["id"].(string), bearer: session}); r.status != 404 {
		t.Fatalf("second disconnect: %d", r.status)
	}

	// Tokens only open /mcp, and sessions never do.
	code = consent(t, f, session, query, true).Query().Get("code")
	last := tokensOf(t, redeem(t, f, client, code, verifier))
	if r := do(t, f, call{method: "GET", path: "/v1/me", bearer: last.Access}); r.status != 401 {
		t.Fatalf("an access token signed in to the app: %d", r.status)
	}
	if mcpWorks(t, f, session) {
		t.Fatal("a session token worked on /mcp")
	}

	// Revoking a refresh token ends its link.
	must(t, f, 200, oauthCall("/oauth/revoke", url.Values{"token": {last.Refresh}, "client_id": {client}}))
	if mcpWorks(t, f, last.Access) {
		t.Fatal("revoked link still works")
	}
}

// oauthCall is a form post as a call, for must.
func oauthCall(path string, form url.Values) call {
	return call{method: "POST", path: path, rawBody: []byte(form.Encode()), header: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}}
}

func TestAuthorizationRequestsAreChecked(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	session := bearerFor(t, db, member(t, db, "checker@example.test"))
	_, challenge := pkce("c")
	client := registerTestClient(t, f, map[string]any{"client_name": "Some\napp\t", "redirect_uris": []string{"https://app.example.org/callback"}, "token_endpoint_auth_method": "none"})
	describe := func(q url.Values) reply {
		return do(t, f, call{method: "GET", path: "/v1/oauth/authorize?" + q.Encode()})
	}

	// An unknown app or return address is never redirected to; the page explains.
	q := authorizeQuery("no-such-app", "https://app.example.org/callback", challenge)
	if r := describe(q); r.status != 400 || r.message() != "This app isn't registered with Savorly. Start again from the app you came from." {
		t.Fatalf("unknown app: %d %s", r.status, r.body)
	}
	q = authorizeQuery(client, "https://evil.example.net/callback", challenge)
	if r := describe(q); r.status != 400 || !strings.Contains(r.message(), "return address") {
		t.Fatalf("unknown return: %d %s", r.status, r.body)
	}
	// Other mistakes go back to the app as OAuth errors.
	q = authorizeQuery(client, "https://app.example.org/callback", challenge)
	q.Set("code_challenge_method", "plain")
	back, _ := url.Parse(must(t, f, 200, call{method: "GET", path: "/v1/oauth/authorize?" + q.Encode()}).object(t)["redirect"].(string))
	if back.Host != "app.example.org" || back.Query().Get("error") != "invalid_request" || back.Query().Get("iss") != testIssuer {
		t.Fatalf("plain PKCE: %s", back)
	}
	q = authorizeQuery(client, "https://app.example.org/callback", challenge)
	q.Set("resource", "https://other.example.com/mcp")
	back, _ = url.Parse(must(t, f, 200, call{method: "GET", path: "/v1/oauth/authorize?" + q.Encode()}).object(t)["redirect"].(string))
	if back.Query().Get("error") != "invalid_target" {
		t.Fatalf("another resource: %s", back)
	}
	// An app from elsewhere is named as it named itself, on one line, and not verified.
	q = authorizeQuery(client, "https://app.example.org/callback", challenge)
	q.Set("scope", "planner offline_access")
	about := describe(q).object(t)
	if app := about["client"].(map[string]any); app["name"] != "Some app" || app["verified"] != false || app["host"] != "app.example.org" {
		t.Fatalf("other app: %v", app)
	}
	if scopes := about["scopes"].([]any); len(scopes) != 1 || scopes[0] != "planner" {
		t.Fatalf("scopes: %v", scopes)
	}

	// A native app's loopback address matches on any port (Claude Code's).
	native := registerTestClient(t, f, map[string]any{"client_name": "Claude Code", "redirect_uris": []string{"http://localhost/callback", "http://127.0.0.1/callback"}, "token_endpoint_auth_method": "none"})
	q = authorizeQuery(native, "http://127.0.0.1:43117/callback", challenge)
	if about := describe(q).object(t); about["localhost"] != true || about["redirectHost"] != "127.0.0.1" {
		t.Fatalf("loopback: %v", about)
	}
	if back := consent(t, f, session, q, true); back.Host != "127.0.0.1:43117" || back.Query().Get("code") == "" {
		t.Fatalf("loopback return: %s", back)
	}
	if r := describe(authorizeQuery(native, "http://127.0.0.1:43117/other", challenge)); r.status != 400 {
		t.Fatal("another loopback path was accepted")
	}

	// Registration takes only what MCP's rules allow.
	for _, bad := range []map[string]any{
		{"redirect_uris": []string{"http://app.example.org/callback"}},
		{"redirect_uris": []string{"https://app.example.org/callback#x"}},
		{"redirect_uris": []string{"https://app.example.org/cb"}, "grant_types": []string{"client_credentials"}},
		{"redirect_uris": []string{"https://app.example.org/cb"}, "token_endpoint_auth_method": "private_key_jwt"},
		{},
	} {
		if r := do(t, f, call{method: "POST", path: "/oauth/register", body: bad}); r.status != 400 {
			t.Fatalf("registered %v: %d", bad, r.status)
		}
	}
}

func TestConfidentialClientsProveThemselves(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	session := bearerFor(t, db, member(t, db, "secret@example.test"))
	r := must(t, f, 201, call{method: "POST", path: "/oauth/register", body: map[string]any{"client_name": "Server app", "redirect_uris": []string{claudeReturn}}})
	out := r.object(t)
	client, secret := out["client_id"].(string), out["client_secret"].(string)
	if out["token_endpoint_auth_method"] != "client_secret_basic" || !strings.HasPrefix(secret, "svcs_") {
		t.Fatalf("registered as %v", out)
	}
	verifier, challenge := pkce("d")
	form := func() url.Values {
		code := consent(t, f, session, authorizeQuery(client, claudeReturn, challenge), true).Query().Get("code")
		return url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {claudeReturn}}
	}
	basic := func(user, pass string) map[string]string {
		return map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(url.QueryEscape(user)+":"+url.QueryEscape(pass)))}
	}
	if r := oauthPost(t, f, "/oauth/token", form(), basic(client, "svcs_wrong")); r.status != 401 || r.header.Get("WWW-Authenticate") == "" {
		t.Fatalf("wrong secret: %d %s", r.status, r.body)
	}
	missing := form()
	missing.Set("client_id", client)
	if r := oauthPost(t, f, "/oauth/token", missing, nil); r.status != 401 {
		t.Fatalf("no secret: %d", r.status)
	}
	tokensOf(t, oauthPost(t, f, "/oauth/token", form(), basic(client, secret)))
	posted := form()
	posted.Set("client_id", client)
	posted.Set("client_secret", secret)
	tokensOf(t, oauthPost(t, f, "/oauth/token", posted, nil))
	if r := oauthPost(t, f, "/oauth/token", url.Values{"grant_type": {"password"}, "client_id": {client}, "client_secret": {secret}}, nil); r.object(t)["error"] != "unsupported_grant_type" {
		t.Fatalf("password grant: %s", r.body)
	}
	if r := do(t, f, call{method: "POST", path: "/oauth/token", body: map[string]any{"grant_type": "refresh_token"}}); r.status != 400 || r.object(t)["error"] != "invalid_request" {
		t.Fatalf("JSON body: %d %s", r.status, r.body)
	}
}

func TestClientMetadataDocuments(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	session := bearerFor(t, db, member(t, db, "cimd@example.test"))
	const chatgpt = "https://chatgpt.com/oauth/client.json"
	asked := socialWeb(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth/client.json":
			_ = json.NewEncoder(w).Encode(map[string]any{"client_id": chatgpt, "client_name": "ChatGPT", "redirect_uris": []string{"https://chatgpt.com/connector_platform_oauth_redirect"},
				"token_endpoint_auth_method": "private_key_jwt", "token_endpoint_auth_methods_supported": []string{"private_key_jwt", "none"}})
		case "/claims-another.json":
			_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "https://chatgpt.com/oauth/client.json", "client_name": "ChatGPT", "redirect_uris": []string{"https://evil.example.net/cb"}})
		default:
			http.NotFound(w, r)
		}
	})
	_, challenge := pkce("e")
	q := authorizeQuery(chatgpt, "https://chatgpt.com/connector_platform_oauth_redirect", challenge)
	about := must(t, f, 200, call{method: "GET", path: "/v1/oauth/authorize?" + q.Encode()}).object(t)
	if app := about["client"].(map[string]any); app["name"] != "ChatGPT" || app["host"] != "chatgpt.com" || app["verified"] != true {
		t.Fatalf("ChatGPT: %v", app)
	}
	// Read once a day, not on every request.
	must(t, f, 200, call{method: "GET", path: "/v1/oauth/authorize?" + q.Encode()})
	if n := len(asked()); n != 1 {
		t.Fatalf("read the document %d times", n)
	}
	back := consent(t, f, session, q, true)
	verifier, _ := pkce("e")
	tokensOf(t, oauthPost(t, f, "/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {back.Query().Get("code")}, "code_verifier": {verifier},
		"client_id": {chatgpt}, "redirect_uri": {"https://chatgpt.com/connector_platform_oauth_redirect"}}, nil))

	// A document must name itself.
	q = authorizeQuery("https://chatgpt.com/claims-another.json", "https://evil.example.net/cb", challenge)
	if r := do(t, f, call{method: "GET", path: "/v1/oauth/authorize?" + q.Encode()}); r.status != 400 {
		t.Fatalf("a document naming another client: %d %s", r.status, r.body)
	}
	q = authorizeQuery("https://chatgpt.com/missing.json", "https://chatgpt.com/cb", challenge)
	if r := do(t, f, call{method: "GET", path: "/v1/oauth/authorize?" + q.Encode()}); r.status != 400 {
		t.Fatalf("a missing document: %d", r.status)
	}
}

// linkedToken links an app for user with scopes and returns an access token for it.
func linkedToken(t *testing.T, db *pgxpool.Pool, user string, scopes ...string) string {
	t.Helper()
	ctx := context.Background()
	client, grant, token := "client-"+uuid.NewString(), uuid.NewString(), "svat_test_"+uuid.NewString()
	if _, e := db.Exec(ctx, `INSERT INTO oauth_clients(id,name,redirect_uris) VALUES($1,'Claude',$2)`, client, []string{claudeReturn}); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,scopes,resource) VALUES($1,$2,$3,$4,$5)`, grant, user, client, scopes, testResource); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO oauth_tokens(token_hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')`, hashToken(token), grant); e != nil {
		t.Fatal(e)
	}
	return token
}

func TestJanitorForgetsSpentAssistantLinks(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	_, err := db.Exec(ctx, `
 INSERT INTO oauth_clients(id,name,redirect_uris,created_at) VALUES('idle','Idle','{https://a.example/cb}',now()-interval '40 days'),('used','Used','{https://b.example/cb}',now()-interval '40 days'),('new','New','{https://c.example/cb}',now());
 INSERT INTO oauth_grants(id,user_id,client_id,scopes,resource,created_at) VALUES('live','cook','used','{planner}','r',now()-interval '5 days'),('dead','cook','used','{planner}','r',now()-interval '5 days'),('young','cook','used','{planner}','r',now());
 INSERT INTO oauth_tokens(token_hash,grant_id,kind,expires_at,used_at) VALUES
  ('live-refresh','live','refresh',now()+interval '80 days',NULL),('old-refresh','live','refresh',now()+interval '1 day',now()-interval '1 hour'),
  ('dead-refresh','dead','refresh',now()+interval '1 day',now()-interval '1 hour'),('spent-access','live','access',now()-interval '1 minute',NULL);
 INSERT INTO oauth_codes(code_hash,user_id,client_id,redirect_uri,code_challenge,scopes,resource,expires_at) VALUES('old-code','cook','used','x','y','{planner}','r',now()-interval '1 minute'),('new-code','cook','used','x','y','{planner}','r',now()+interval '1 minute');
 INSERT INTO mcp_sessions(id_hash,protocol_version,last_used_at) VALUES('stale','2025-06-18',now()-interval '31 days'),('fresh','2025-06-18',now())`)
	if err != nil {
		t.Fatal(err)
	}
	counts, err := runJanitor(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	for task, n := range map[string]int64{"oauth_codes": 1, "oauth_tokens": 1, "oauth_grants": 1, "oauth_clients": 1, "mcp_sessions": 1} {
		if counts[task] != n {
			t.Errorf("%s: purged %d, want %d", task, counts[task], n)
		}
	}
	for query, want := range map[string][]string{
		`SELECT id FROM oauth_clients`:      {"new", "used"},
		`SELECT id FROM oauth_grants`:       {"live", "young"},
		`SELECT code_hash FROM oauth_codes`: {"new-code"},
		`SELECT id_hash FROM mcp_sessions`:  {"fresh"},
	} {
		var got []string
		if e := db.QueryRow(ctx, `SELECT COALESCE(array_agg(x ORDER BY x),'{}') FROM (`+query+`) q(x)`).Scan(&got); e != nil {
			t.Fatal(e)
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s: %v, want %v", query, got, want)
		}
	}
}
