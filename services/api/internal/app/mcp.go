package app

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// Savorly's MCP server at /mcp, for ChatGPT, Claude and other assistants (docs/ASSISTANTS.md).
// Anyone can search and read recipes; with a linked account (oauth_server.go) an assistant also
// saves recipes, plans meals and fills the grocery list. The tools (mcp_tools.go) act through the
// sous-chef's own tool calls and the app's routes, so they check and do what the app does.
//
// It speaks the current protocol (2026-07-28: every request carries its version and the client's
// capabilities, mirrored in headers) and the earlier ones, which start a session with initialize
// and name it in Mcp-Session-Id afterwards. Every answer is one JSON object; nothing is sent
// unasked, so GET /mcp has no stream to open.

const (
	// mcpModern is the newest protocol version, stateless, with its version on every request.
	mcpModern        = "2026-07-28"
	mcpServerVersion = "1.0.0"
	mcpCardURI       = "ui://savorly/recipe-card-v1.html"
	mcpCardType      = "text/html;profile=mcp-app"
)

// mcpLegacyVersions are the earlier versions, newest first: a session per client, from initialize.
var mcpLegacyVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

func mcpVersions() []string { return append([]string{mcpModern}, mcpLegacyVersions...) }

func legacyVersion(v string) bool { return slices.Contains(mcpLegacyVersions, v) }

// assistantCard is the recipe card, an MCP App: the HTML the assistant shows in the chat for
// search_recipes and show_recipe, filled in with their structured results.
//
//go:embed assistant_card.html
var assistantCard string

var mcpCapabilities = fiber.Map{"tools": fiber.Map{}, "resources": fiber.Map{}, "extensions": fiber.Map{"io.modelcontextprotocol/ui": fiber.Map{}}}

// mcpInstructions are what the assistant's model reads about the server, its gist first.
const mcpInstructions = `Savorly is a recipe community whose recipes are cooked and timed by real cooks. Anyone can search and read them; saving recipes, the meal plan and the grocery list use the person's Savorly account, which a tool asks them to link when it needs it. Cooking happens in Savorly: when someone wants to cook a recipe, give them its cookUrl, which opens it in Savorly's hands-free cooking mode, rather than reciting a method. Cook-tested recipes were cooked by at least 5 people in Savorly, with how long they really took.
Days are YYYY-MM-DD in the person's own calendar; meals are Breakfast, Lunch or Dinner.`

// rpcMessage is one JSON-RPC message a client posts.
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// request reports whether the message wants an answer. Notifications, and a client's answers to
// a server of an earlier version, are only acknowledged.
func (m rpcMessage) request() bool {
	return m.Method != "" && len(m.ID) > 0 && string(m.ID) != "null"
}

// rpcParams is what a request's params may carry.
type rpcParams struct {
	Name            string                     `json:"name"`
	URI             string                     `json:"uri"`
	Arguments       json.RawMessage            `json:"arguments"`
	ProtocolVersion string                     `json:"protocolVersion"`
	ClientInfo      struct{ Name string }      `json:"clientInfo"`
	Meta            map[string]json.RawMessage `json:"_meta"`
}

func (m rpcMessage) params() rpcParams {
	var p rpcParams
	_ = json.Unmarshal(m.Params, &p)
	return p
}

// metaString is a text field of the request's _meta, or "".
func (p rpcParams) metaString(key string) string {
	var s string
	_ = json.Unmarshal(p.Meta[key], &s)
	return s
}

// fromChatGPT reports whether ChatGPT sent the request, which adds openai/ fields to _meta.
// ChatGPT offers to link an account when a tool's result asks for it (mcp/www_authenticate);
// other clients do when the request itself is refused with a 401.
func (p rpcParams) fromChatGPT() bool {
	for k := range p.Meta {
		if strings.HasPrefix(k, "openai/") {
			return true
		}
	}
	return false
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// rpcFailure refuses a whole request, with its HTTP status.
type rpcFailure struct {
	status int
	id     json.RawMessage
	err    rpcError
}

func (f *rpcFailure) send(c fiber.Ctx) error {
	return c.Status(f.status).JSON(rpcErrorBody(f.id, f.err))
}

// rpcErrorBody is a JSON-RPC error, without an id when the request's couldn't be read.
func rpcErrorBody(id json.RawMessage, e rpcError) fiber.Map {
	out := fiber.Map{"jsonrpc": "2.0", "error": e}
	if len(id) > 0 {
		out["id"] = id
	}
	return out
}

func rpcErrorAnswer(id json.RawMessage, code int, message string) json.RawMessage {
	return jsonBytes(rpcErrorBody(id, rpcError{Code: code, Message: message}))
}

func unsupportedVersion(id json.RawMessage, requested string) *rpcFailure {
	return &rpcFailure{400, id, rpcError{Code: -32022, Message: "Unsupported protocol version", Data: fiber.Map{"supported": mcpVersions(), "requested": requested}}}
}

// mcpExchange is how one POST to /mcp speaks: its protocol version, and whether that's the
// stateless current one.
type mcpExchange struct {
	version string
	modern  bool
}

// mcp answers a POST to /mcp: one JSON-RPC message, or for clients of 2025-03-26 a batch.
func (a *App) mcp(c fiber.Ctx) error {
	c.Set("Cache-Control", "no-store")
	messages, batch, failure := readMessages(c.Body())
	if failure != nil {
		return failure.send(c)
	}
	x, failure, e := a.mcpProtocol(c, messages, batch)
	if e != nil {
		return e
	}
	if failure != nil {
		return failure.send(c)
	}
	caller, problem, e := a.mcpCaller(c)
	if e != nil {
		return e
	}
	if problem != "" {
		return a.mcpChallenge(c, 401, "invalid_token", problem, oauthScopes)
	}
	if !a.mcpAllowed(c, caller, messages[0].params()) {
		c.Set("Retry-After", "60")
		return (&rpcFailure{429, messages[0].ID, rpcError{Code: -32600, Message: "Too many requests. Please wait a moment and try again."}}).send(c)
	}
	// Claude and most clients link an account when a request is refused with 401, or ask for
	// more when it's refused with 403, so a tool that needs one is refused before it runs.
	// ChatGPT's requests go on: the tool's result asks (callTool).
	for _, m := range messages {
		p := m.params()
		tool, ok := assistantToolNamed[p.Name]
		if m.Method != "tools/call" || !ok || tool.scope == "" || p.fromChatGPT() {
			continue
		}
		if caller.user == "" {
			return a.mcpChallenge(c, 401, "", "Link a Savorly account to use this tool.", oauthScopes)
		}
		if !slices.Contains(caller.scopes, tool.scope) {
			return a.mcpChallenge(c, 403, "insufficient_scope", "Savorly needs more access for this tool.", withScope(caller.scopes, tool.scope))
		}
	}
	answers, status := []json.RawMessage{}, 200
	for _, m := range messages {
		if m.request() {
			answer, s := a.mcpAnswer(c, x, caller, m)
			answers = append(answers, answer)
			status = s
		}
	}
	if len(answers) == 0 {
		c.Status(202)
		return nil
	}
	c.Set("Content-Type", "application/json")
	if batch {
		return c.Status(200).Send(jsonBytes(answers))
	}
	return c.Status(status).Send(answers[0])
}

// readMessages reads the body: one JSON-RPC message, or a batch of at most 20.
func readMessages(body []byte) (messages []rpcMessage, batch bool, failure *rpcFailure) {
	body = bytes.TrimSpace(body)
	unreadable := &rpcFailure{400, nil, rpcError{Code: -32700, Message: "Parse error: send one JSON-RPC message as JSON."}}
	if batch = len(body) > 0 && body[0] == '['; batch {
		if json.Unmarshal(body, &messages) != nil || len(messages) == 0 || len(messages) > 20 {
			return nil, true, unreadable
		}
	} else {
		var m rpcMessage
		if json.Unmarshal(body, &m) != nil {
			return nil, false, unreadable
		}
		messages = []rpcMessage{m}
	}
	for _, m := range messages {
		if m.JSONRPC != "2.0" || (m.Method == "" && len(m.ID) == 0) {
			return nil, batch, &rpcFailure{400, m.ID, rpcError{Code: -32600, Message: "Invalid request: send a JSON-RPC 2.0 request or notification."}}
		}
	}
	return messages, batch, nil
}

// mcpProtocol works out which protocol a POST speaks. initialize starts a session of an earlier
// version; a request with its version in _meta (or a current version header) is current; the rest
// belong to a session, or name an earlier version in MCP-Protocol-Version.
func (a *App) mcpProtocol(c fiber.Ctx, messages []rpcMessage, batch bool) (mcpExchange, *rpcFailure, error) {
	first := messages[0]
	p := first.params()
	header := strings.TrimSpace(c.Get("MCP-Protocol-Version"))
	stated := p.metaString("io.modelcontextprotocol/protocolVersion")
	session := c.Get("Mcp-Session-Id")
	switch {
	case !batch && first.Method == "initialize":
		version := p.ProtocolVersion
		if !legacyVersion(version) {
			version = mcpLegacyVersions[0]
		}
		return mcpExchange{version: version}, nil, nil
	case !batch && !legacyVersion(stated) && (stated != "" || (session == "" && header != "" && !legacyVersion(header))):
		// A current request ignores any session header.
		return mcpExchange{version: stated, modern: true}, modernCheck(c, first, p, header), nil
	}
	x := mcpExchange{version: header}
	if session != "" {
		var version string
		var stale bool
		e := a.DB.QueryRow(c.Context(), `SELECT protocol_version,last_used_at<now()-interval '1 hour' FROM mcp_sessions WHERE id_hash=$1`, hashToken(session)).Scan(&version, &stale)
		if errors.Is(e, pgx.ErrNoRows) {
			return x, &rpcFailure{404, first.ID, rpcError{Code: -32600, Message: "Session not found: start a new one with initialize."}}, nil
		}
		if e != nil {
			return x, nil, e
		}
		if stale {
			if _, e = a.DB.Exec(c.Context(), `UPDATE mcp_sessions SET last_used_at=now() WHERE id_hash=$1`, hashToken(session)); e != nil {
				slog.Warn("touch MCP session", "error", e)
			}
		}
		if x.version == "" {
			x.version = version
		}
	} else if x.version == "" {
		x.version = stated
	}
	if x.version == "" {
		return x, &rpcFailure{400, first.ID, rpcError{Code: -32600, Message: "Start with initialize, then send the Mcp-Session-Id and MCP-Protocol-Version headers it gives."}}, nil
	}
	if !legacyVersion(x.version) {
		return x, unsupportedVersion(first.ID, x.version), nil
	}
	return x, nil, nil
}

// modernCheck holds a current request to its rules: the version and the client's capabilities in
// _meta, and the headers that mirror the version, the method and the tool or resource asked for.
func modernCheck(c fiber.Ctx, m rpcMessage, p rpcParams, header string) *rpcFailure {
	if !m.request() {
		return nil
	}
	stated := p.metaString("io.modelcontextprotocol/protocolVersion")
	if stated == "" || len(p.Meta["io.modelcontextprotocol/clientCapabilities"]) == 0 {
		return &rpcFailure{400, m.ID, rpcError{Code: -32602, Message: "Invalid params: _meta needs io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities."}}
	}
	mismatch := func(what string) *rpcFailure {
		return &rpcFailure{400, m.ID, rpcError{Code: -32020, Message: "Header mismatch: " + what}}
	}
	if header != stated {
		return mismatch("MCP-Protocol-Version doesn't match _meta's protocolVersion.")
	}
	if stated != mcpModern {
		return unsupportedVersion(m.ID, stated)
	}
	if c.Get("Mcp-Method") != m.Method {
		return mismatch("Mcp-Method doesn't match the request's method.")
	}
	if want, named := map[string]string{"tools/call": p.Name, "resources/read": p.URI, "prompts/get": p.Name}[m.Method]; named {
		if got, ok := headerValue(c.Get("Mcp-Name")); !ok || got != want {
			return mismatch("Mcp-Name doesn't match the request's name or uri.")
		}
	}
	return nil
}

// headerValue is a mirrored header's value, decoded when it's in the =?base64?…?= form.
func headerValue(raw string) (string, bool) {
	if inner, ok := strings.CutPrefix(raw, "=?base64?"); ok {
		if inner, ok = strings.CutSuffix(inner, "?="); ok {
			b, e := base64.StdEncoding.DecodeString(inner)
			return string(b), e == nil
		}
	}
	return raw, raw != ""
}

// mcpAllowed counts a request against its limit: 240 a minute for each linked account's app,
// and for anonymous requests 300 a minute per address and ChatGPT user (openai/subject), within
// 1,200 per address. An assistant calls for all its users from a few addresses of its own.
func (a *App) mcpAllowed(c fiber.Ctx, caller assistantCaller, p rpcParams) bool {
	if caller.grant != "" {
		return a.throttles.assistants.hit("grant:"+caller.grant, 240, time.Minute)
	}
	ip := c.IP()
	return a.throttles.assistants.hit("ip:"+ip, 1200, time.Minute) && a.throttles.assistants.hit("anonymous:"+ip+"|"+p.metaString("openai/subject"), 300, time.Minute)
}

// withScope is the scopes a member granted plus one more, for asking again.
func withScope(granted []string, scope string) []string {
	out := slices.Clone(granted)
	if !slices.Contains(out, scope) {
		out = append(out, scope)
	}
	return out
}

// bearerChallenge is the WWW-Authenticate value that tells a client where to link the member's
// account (RFC 9728's resource_metadata) and with which scopes (RFC 6750). A request without a
// token gets no error code.
func (a *App) bearerChallenge(c fiber.Ctx, code, description string, scopes []string) string {
	parts := []string{`resource_metadata="` + a.resourceMetadataURL(c) + `"`, `scope="` + strings.Join(scopes, " ") + `"`}
	if code != "" {
		parts = append(parts, `error="`+code+`"`, `error_description="`+description+`"`)
	}
	return "Bearer " + strings.Join(parts, ", ")
}

// mcpChallenge refuses a request with a Bearer challenge, so the client links the account.
func (a *App) mcpChallenge(c fiber.Ctx, status int, code, description string, scopes []string) error {
	c.Set("WWW-Authenticate", a.bearerChallenge(c, code, description, scopes))
	c.Set("Cache-Control", "no-store")
	if code == "" {
		code = "unauthorized"
	}
	return c.Status(status).JSON(fiber.Map{"error": code, "error_description": description})
}

// mcpAnswer answers one request, with the HTTP status for a single one.
func (a *App) mcpAnswer(c fiber.Ctx, x mcpExchange, caller assistantCaller, m rpcMessage) (json.RawMessage, int) {
	var p rpcParams
	if len(m.Params) > 0 && json.Unmarshal(m.Params, &p) != nil {
		return rpcErrorAnswer(m.ID, -32602, "Invalid params: params must be an object."), 200
	}
	var result fiber.Map
	switch m.Method {
	case "initialize":
		session, e := a.startSession(c, x.version, p.ClientInfo.Name)
		if e != nil {
			slog.Error("start MCP session", "error", e)
			return rpcErrorAnswer(m.ID, -32603, "Internal error: please try again."), 500
		}
		c.Set("Mcp-Session-Id", session)
		result = fiber.Map{"protocolVersion": x.version, "capabilities": mcpCapabilities, "serverInfo": a.serverInfo(), "instructions": mcpInstructions}
	case "server/discover":
		result = fiber.Map{"supportedVersions": mcpVersions(), "capabilities": mcpCapabilities, "instructions": mcpInstructions, "ttlMs": 3600000, "cacheScope": "public"}
	case "ping":
		result = fiber.Map{}
	case "tools/list":
		result = fiber.Map{"tools": assistantToolList}
	case "tools/call":
		tool, ok := assistantToolNamed[p.Name]
		if !ok {
			return rpcErrorAnswer(m.ID, -32602, "Unknown tool: "+p.Name), 200
		}
		result = a.callTool(c, caller, tool, p)
	case "resources/list":
		result = fiber.Map{"resources": []fiber.Map{a.cardResource(false)}}
	case "resources/templates/list":
		result = fiber.Map{"resourceTemplates": []any{}}
	case "resources/read":
		if p.URI != mcpCardURI {
			// 2026-07-28 replaced -32002, which earlier versions use for a missing resource.
			code := -32002
			if x.modern {
				code = -32602
			}
			return rpcErrorAnswer(m.ID, code, "Resource not found: "+p.URI), 200
		}
		result = fiber.Map{"contents": []fiber.Map{a.cardResource(true)}}
	case "prompts/list":
		result = fiber.Map{"prompts": []any{}}
	default:
		status := 200
		if x.modern {
			status = 404
		}
		return rpcErrorAnswer(m.ID, -32601, "Method not found: "+m.Method), status
	}
	if x.modern {
		result["resultType"] = "complete"
		meta, _ := result["_meta"].(fiber.Map)
		if meta == nil {
			meta = fiber.Map{}
		}
		meta["io.modelcontextprotocol/serverInfo"] = a.serverInfo()
		result["_meta"] = meta
	}
	return jsonBytes(fiber.Map{"jsonrpc": "2.0", "id": m.ID, "result": result}), 200
}

// startSession begins a session of an earlier protocol version and returns its id.
func (a *App) startSession(c fiber.Ctx, version, client string) (string, error) {
	id, e := newSecret("svms_")
	if e != nil {
		return "", e
	}
	_, e = a.DB.Exec(c.Context(), `INSERT INTO mcp_sessions(id_hash,protocol_version,client_name) VALUES($1,$2,$3)`, hashToken(id), version, cleanName(client))
	return id, e
}

// mcpEnd is DELETE /mcp, which ends a session of an earlier protocol version.
func (a *App) mcpEnd(c fiber.Ctx) error {
	session := c.Get("Mcp-Session-Id")
	if session == "" {
		c.Set("Allow", "POST")
		return c.Status(405).JSON(rpcErrorBody(nil, rpcError{Code: -32600, Message: "Only a session started with initialize can be ended."}))
	}
	r, e := a.DB.Exec(c.Context(), `DELETE FROM mcp_sessions WHERE id_hash=$1`, hashToken(session))
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return c.Status(404).JSON(rpcErrorBody(nil, rpcError{Code: -32600, Message: "Session not found."}))
	}
	return c.SendStatus(204)
}

// mcpGet answers GET /mcp: the server sends nothing unasked, so there's no stream to open.
func mcpGet(c fiber.Ctx) error {
	c.Set("Allow", "POST, DELETE")
	return c.Status(405).JSON(rpcErrorBody(nil, rpcError{Code: -32600, Message: "Send MCP requests with POST."}))
}

func (a *App) serverInfo() fiber.Map {
	site := appURL(a.Config)
	return fiber.Map{"name": "savorly", "title": "Savorly", "version": mcpServerVersion, "websiteUrl": site,
		"icons": []fiber.Map{{"src": site + "/icons/icon-512.png", "mimeType": "image/png", "sizes": []string{"512x512"}}}}
}

// cardResource is the recipe card as resources/list names it, or with content its HTML for
// resources/read. The card may load photos from Savorly's media hosts and nothing else, and it
// opens links on the site, where "Cook it in Savorly" goes.
func (a *App) cardResource(content bool) fiber.Map {
	site := appURL(a.Config)
	media := a.mediaOrigins()
	meta := fiber.Map{
		"ui": fiber.Map{"prefersBorder": true, "csp": fiber.Map{"connectDomains": []string{}, "resourceDomains": media}},
		// ChatGPT's own names for the same, and the origin its review asks every app's card for.
		"openai/widgetDescription":   "A Savorly recipe card: photo, title, time, the cook-tested line, and a link that opens the recipe in Savorly's cooking mode.",
		"openai/widgetPrefersBorder": true,
		"openai/widgetCSP":           fiber.Map{"connect_domains": []string{}, "resource_domains": media, "redirect_domains": []string{site}},
		"openai/widgetDomain":        site,
	}
	out := fiber.Map{"uri": mcpCardURI, "mimeType": mcpCardType, "_meta": meta}
	if content {
		out["text"] = assistantCard
	} else {
		out["name"], out["title"] = "recipe-card", "Savorly recipe card"
		out["description"] = "Shows Savorly recipes in the chat, with a link to cook each one in Savorly."
	}
	return out
}

// mediaOrigins are where recipe photos are served from: the media bucket's public address and
// MEDIA_HOSTS, the hosts allowedMedia accepts.
func (a *App) mediaOrigins() []string {
	base := strings.TrimRight(Env("S3_PUBLIC_URL", ""), "/")
	if a.Media != nil && a.Media.BaseURL != "" {
		base = a.Media.BaseURL
	}
	out := []string{}
	if u, e := url.Parse(base); e == nil && u.Scheme != "" && u.Host != "" {
		out = append(out, u.Scheme+"://"+u.Host)
	}
	for _, h := range strings.Split(os.Getenv("MEDIA_HOSTS"), ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" && !slices.Contains(out, "https://"+h) {
			out = append(out, "https://"+h)
		}
	}
	return out
}
