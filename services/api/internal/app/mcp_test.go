package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

// modernRequest is a request as a 2026-07-28 client sends it: its version and capabilities in
// _meta, mirrored in headers with the method and the tool or resource.
func modernRequest(method string, params map[string]any) (map[string]any, map[string]string) {
	if params == nil {
		params = map[string]any{}
	}
	meta, _ := params["_meta"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
	}
	meta["io.modelcontextprotocol/protocolVersion"] = mcpModern
	meta["io.modelcontextprotocol/clientCapabilities"] = map[string]any{}
	params["_meta"] = meta
	header := map[string]string{"MCP-Protocol-Version": mcpModern, "Mcp-Method": method, "Accept": "application/json, text/event-stream"}
	if name, ok := params["name"].(string); ok {
		header["Mcp-Name"] = name
	}
	if uri, ok := params["uri"].(string); ok {
		header["Mcp-Name"] = uri
	}
	return map[string]any{"jsonrpc": "2.0", "id": 7, "method": method, "params": params}, header
}

// rpcAnswer is a JSON-RPC answer from /mcp.
type rpcAnswer struct {
	ID     json.RawMessage `json:"id"`
	Result map[string]any  `json:"result"`
	Error  *rpcError       `json:"error"`
}

func answerOf(t *testing.T, r reply) rpcAnswer {
	t.Helper()
	var out rpcAnswer
	if e := json.Unmarshal(r.body, &out); e != nil {
		t.Fatalf("not a JSON-RPC answer (%d): %s", r.status, r.body)
	}
	return out
}

// mcpTool calls a tool as a current client, as token's member ("" for nobody), and returns its
// result.
func mcpTool(t *testing.T, f *fiber.App, token, name string, args map[string]any) (map[string]any, reply) {
	t.Helper()
	body, header := modernRequest("tools/call", map[string]any{"name": name, "arguments": args})
	r := do(t, f, call{method: "POST", path: "/mcp", body: body, bearer: token, header: header})
	if r.status != 200 {
		return nil, r
	}
	a := answerOf(t, r)
	if a.Error != nil {
		t.Fatalf("%s: %+v", name, a.Error)
	}
	return a.Result, r
}

// toolText is a tool result's text and structured content; it fails on a tool error.
func toolText(t *testing.T, result map[string]any) (string, map[string]any) {
	t.Helper()
	if result["isError"] == true {
		t.Fatalf("tool error: %v", result["content"])
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	structured, _ := result["structuredContent"].(map[string]any)
	return text, structured
}

func TestMCPEarlierVersionsUseSessions(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	post := func(body any, header map[string]string) reply {
		return do(t, f, call{method: "POST", path: "/mcp", body: body, header: header})
	}
	r := post(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "claude-ai"}}}, nil)
	started := answerOf(t, r).Result
	session := r.header.Get("Mcp-Session-Id")
	if r.status != 200 || started["protocolVersion"] != "2025-06-18" || session == "" || started["instructions"] == "" {
		t.Fatalf("initialize: %d %v session %q", r.status, started, session)
	}
	caps := started["capabilities"].(map[string]any)
	if caps["tools"] == nil || caps["resources"] == nil || caps["extensions"].(map[string]any)["io.modelcontextprotocol/ui"] == nil {
		t.Fatalf("capabilities: %v", caps)
	}
	// A version it doesn't know is answered with its newest earlier one.
	r = post(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2024-11-05"}}, nil)
	if v := answerOf(t, r).Result["protocolVersion"]; v != "2025-11-25" {
		t.Fatalf("negotiated %v", v)
	}
	headers := map[string]string{"Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18"}
	if r = post(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, headers); r.status != 202 || len(r.body) != 0 {
		t.Fatalf("notification: %d %s", r.status, r.body)
	}
	r = post(map[string]any{"jsonrpc": "2.0", "id": "a", "method": "tools/list"}, headers)
	list := answerOf(t, r).Result["tools"].([]any)
	if len(list) != len(assistantTools) || string(answerOf(t, r).ID) != `"a"` || answerOf(t, r).Result["resultType"] != nil {
		t.Fatalf("tools/list: %s", r.body)
	}
	// The session alone carries the version for clients that don't repeat it.
	if r = post(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "ping"}, map[string]string{"Mcp-Session-Id": session}); r.status != 200 || answerOf(t, r).Error != nil {
		t.Fatalf("ping in the session: %d %s", r.status, r.body)
	}
	// Methods it doesn't have are JSON-RPC errors; 2025-03-26 clients may batch.
	if a := answerOf(t, post(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "sampling/createMessage"}, headers)); a.Error == nil || a.Error.Code != -32601 {
		t.Fatalf("unknown method: %+v", a)
	}
	r = post([]any{map[string]any{"jsonrpc": "2.0", "id": 4, "method": "ping"}, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "resources/list"}}, headers)
	var batch []rpcAnswer
	if e := json.Unmarshal(r.body, &batch); e != nil || len(batch) != 2 || batch[1].Result["resources"] == nil {
		t.Fatalf("batch: %s", r.body)
	}

	// Without a session or a version there's nothing to go on; an unsupported version is refused.
	if r = post(map[string]any{"jsonrpc": "2.0", "id": 6, "method": "tools/list"}, nil); r.status != 400 {
		t.Fatalf("no session: %d", r.status)
	}
	if r = post(map[string]any{"jsonrpc": "2.0", "id": 6, "method": "tools/list"}, map[string]string{"Mcp-Session-Id": session, "MCP-Protocol-Version": "1999-01-01"}); r.status != 400 || answerOf(t, r).Error.Code != -32022 {
		t.Fatalf("bad version: %d %s", r.status, r.body)
	}
	// Ending a session; afterwards it's not found, and the client starts again.
	if r = do(t, f, call{method: "DELETE", path: "/mcp", header: map[string]string{"Mcp-Session-Id": session}}); r.status != 204 {
		t.Fatalf("end: %d", r.status)
	}
	if r = post(map[string]any{"jsonrpc": "2.0", "id": 8, "method": "tools/list"}, headers); r.status != 404 {
		t.Fatalf("ended session: %d", r.status)
	}
	if r = do(t, f, call{method: "GET", path: "/mcp"}); r.status != 405 || !strings.Contains(r.header.Get("Allow"), "POST") {
		t.Fatalf("GET: %d %v", r.status, r.header)
	}
	if r = post(map[string]any{"jsonrpc": "1.0", "id": 9, "method": "ping"}, headers); r.status != 400 {
		t.Fatalf("not JSON-RPC 2.0: %d", r.status)
	}
	if r = do(t, f, call{method: "POST", path: "/mcp", rawBody: []byte("{"), header: headers}); r.status != 400 || answerOf(t, r).Error.Code != -32700 {
		t.Fatalf("unreadable: %d %s", r.status, r.body)
	}
	// Another site's page can't call it from a browser.
	if r = do(t, f, call{method: "POST", path: "/mcp", body: map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}, header: headers, origin: "https://evil.example.net"}); r.status != 403 {
		t.Fatalf("foreign origin: %d", r.status)
	}
}

func TestMCPCurrentVersionChecksEachRequest(t *testing.T) {
	f := accountsApp(nil, false)
	send := func(body map[string]any, header map[string]string) (reply, rpcAnswer) {
		r := do(t, f, call{method: "POST", path: "/mcp", body: body, header: header})
		return r, answerOf(t, r)
	}
	body, header := modernRequest("server/discover", nil)
	r, a := send(body, header)
	if r.status != 200 || a.Result["resultType"] != "complete" || a.Result["supportedVersions"].([]any)[0] != mcpModern || r.header.Get("Mcp-Session-Id") != "" {
		t.Fatalf("discover: %d %s", r.status, r.body)
	}
	if info := a.Result["_meta"].(map[string]any)["io.modelcontextprotocol/serverInfo"].(map[string]any); info["name"] != "savorly" {
		t.Fatalf("server info: %v", info)
	}
	cases := []struct {
		name   string
		change func(map[string]any, map[string]string)
		status int
		code   int
	}{
		{"no _meta", func(b map[string]any, h map[string]string) { delete(b["params"].(map[string]any), "_meta") }, 400, -32602},
		{"no capabilities", func(b map[string]any, h map[string]string) {
			delete(b["params"].(map[string]any)["_meta"].(map[string]any), "io.modelcontextprotocol/clientCapabilities")
		}, 400, -32602},
		{"version header differs", func(b map[string]any, h map[string]string) { h["MCP-Protocol-Version"] = "2025-11-25" }, 400, -32020},
		{"method header differs", func(b map[string]any, h map[string]string) { h["Mcp-Method"] = "tools/list" }, 400, -32020},
		{"name header differs", func(b map[string]any, h map[string]string) { h["Mcp-Name"] = "show_recipe" }, 400, -32020},
		{"unknown version", func(b map[string]any, h map[string]string) {
			b["params"].(map[string]any)["_meta"].(map[string]any)["io.modelcontextprotocol/protocolVersion"] = "2099-01-01"
			h["MCP-Protocol-Version"] = "2099-01-01"
		}, 400, -32022},
	}
	for _, c := range cases {
		body, header := modernRequest("tools/call", map[string]any{"name": "search_recipes", "arguments": map[string]any{}})
		c.change(body, header)
		r, a := send(body, header)
		if r.status != c.status || a.Error == nil || a.Error.Code != c.code {
			t.Errorf("%s: %d %s", c.name, r.status, r.body)
		}
		if c.code == -32022 && fmt.Sprint(a.Error.Data) == "" {
			t.Errorf("%s: no supported versions", c.name)
		}
	}
	body, header = modernRequest("tasks/list", nil)
	if r, a = send(body, header); r.status != 404 || a.Error.Code != -32601 {
		t.Fatalf("unknown method: %d %s", r.status, r.body)
	}
	// Names that aren't plain ASCII come base64-encoded.
	body, header = modernRequest("resources/read", map[string]any{"uri": mcpCardURI})
	header["Mcp-Name"] = "=?base64?" + base64.StdEncoding.EncodeToString([]byte(mcpCardURI)) + "?="
	r, a = send(body, header)
	if r.status != 200 {
		t.Fatalf("encoded name: %d %s", r.status, r.body)
	}
	content := a.Result["contents"].([]any)[0].(map[string]any)
	ui := content["_meta"].(map[string]any)["ui"].(map[string]any)
	if content["mimeType"] != mcpCardType || !strings.Contains(content["text"].(string), "ui/notifications/tool-result") || ui["prefersBorder"] != true || ui["csp"] == nil {
		t.Fatalf("card: %v", content["_meta"])
	}
	body, header = modernRequest("resources/read", map[string]any{"uri": "ui://savorly/other.html"})
	if _, a = send(body, header); a.Error == nil || a.Error.Code != -32602 {
		t.Fatalf("missing resource: %+v", a)
	}
	// Every tool says what it does to the member's data, and the two that show recipes show
	// the card.
	body, header = modernRequest("tools/list", nil)
	_, a = send(body, header)
	for _, raw := range a.Result["tools"].([]any) {
		d := raw.(map[string]any)
		notes := d["annotations"].(map[string]any)
		for _, hint := range []string{"readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"} {
			if _, ok := notes[hint].(bool); !ok {
				t.Errorf("%s: no %s", d["name"], hint)
			}
		}
		ui, _ := d["_meta"].(map[string]any)["ui"].(map[string]any)
		card := d["name"] == "search_recipes" || d["name"] == "show_recipe"
		if (ui != nil) != card || d["outputSchema"] == nil || d["securitySchemes"] == nil {
			t.Errorf("%s: %v", d["name"], d["_meta"])
		}
	}
}

func TestMCPToolsForGuestsAndLinkedMembers(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	ctx := context.Background()
	testUser(t, db, "mia")
	cook := member(t, db, "tool-user@example.test")
	publishRecipe(t, db, "mia", "lemon-pasta", func(r *RecipeInput) {
		r.Image = "https://images.example.com/lemon.jpg"
		r.Ingredients = []Ingredient{{Name: "Pasta", Amount: 200, Unit: "g", Category: "Pantry"}, {Name: "Lemon", Amount: 1, Category: "Produce"}, {Name: "Salt", Category: "Pantry"}}
		r.Steps = []Step{{Title: "Boil", Text: "Boil the pasta until al dente."}, {Title: "Toss", Text: "Toss with lemon zest and juice."}}
	})
	publishRecipe(t, db, "mia", "tomato-soup", func(r *RecipeInput) {
		r.Title, r.Description, r.Minutes = "Tomato soup", "A smooth soup of ripe tomatoes.", 35
		r.Ingredients = []Ingredient{{Name: "Tomatoes", Amount: 800, Unit: "g", Category: "Produce"}}
	})
	if _, e := db.Exec(ctx, `INSERT INTO recipe_cook_times(recipe_id,cooks,minutes) VALUES('lemon-pasta',12,25)`); e != nil {
		t.Fatal(e)
	}

	// Anyone can search and read recipes, with links to cook them in Savorly.
	result, _ := mcpTool(t, f, "", "search_recipes", map[string]any{"query": "pasta"})
	text, found := toolText(t, result)
	recipes := found["recipes"].([]any)
	first := recipes[0].(map[string]any)
	if len(recipes) != 1 || first["id"] != "lemon-pasta" || first["cookUrl"] != "http://localhost:8081/recipes/lemon-pasta?cook=1" || first["cookTested"] != true ||
		first["cookedMinutes"] != 25.0 || first["image"] != "https://images.example.com/lemon.jpg" || !strings.Contains(text, "cook-tested: 12 people") {
		t.Fatalf("search: %s\n%v", text, first)
	}
	result, _ = mcpTool(t, f, "", "search_recipes", map[string]any{"cook_tested": true})
	if _, found = toolText(t, result); len(found["recipes"].([]any)) != 1 {
		t.Fatalf("cook-tested only: %v", found)
	}
	result, _ = mcpTool(t, f, "", "show_recipe", map[string]any{"recipe_id": "lemon-pasta"})
	text, found = toolText(t, result)
	detail := found["recipe"].(map[string]any)
	if detail["stepCount"] != 2.0 || len(detail["ingredients"].([]any)) != 3 || !strings.Contains(text, "- 200 g Pasta") || !strings.Contains(text, "- Salt") {
		t.Fatalf("show: %s\n%v", text, detail)
	}
	// The method stays in Savorly.
	if strings.Contains(text, "al dente") || strings.Contains(string(jsonBytes(found)), "al dente") {
		t.Fatalf("the steps reached the chat: %s", text)
	}
	if result, _ = mcpTool(t, f, "", "show_recipe", map[string]any{"recipe_id": "nope"}); result["isError"] != true {
		t.Fatal("an unknown recipe showed")
	}

	// A tool that needs an account: Claude's request is refused so it links one; ChatGPT's gets a
	// result asking for it.
	_, r := mcpTool(t, f, "", "save_recipe", map[string]any{"recipe_id": "lemon-pasta"})
	challenge := r.header.Get("WWW-Authenticate")
	if r.status != 401 || !strings.Contains(challenge, `resource_metadata="http://example.com/.well-known/oauth-protected-resource/mcp"`) || !strings.Contains(challenge, `scope="cookbooks planner groceries"`) {
		t.Fatalf("anonymous save: %d %q", r.status, challenge)
	}
	body, header := modernRequest("tools/call", map[string]any{"name": "save_recipe", "arguments": map[string]any{"recipe_id": "lemon-pasta"}, "_meta": map[string]any{"openai/subject": "v1/abc"}})
	r = must(t, f, 200, call{method: "POST", path: "/mcp", body: body, header: header})
	asked := answerOf(t, r).Result
	if asked["isError"] != true || !strings.Contains(fmt.Sprint(asked["_meta"].(map[string]any)["mcp/www_authenticate"]), `error="insufficient_scope"`) {
		t.Fatalf("ChatGPT's anonymous save: %s", r.body)
	}
	// A token without the scope is asked to get it; one that doesn't work is refused.
	planner := linkedToken(t, db, cook, "planner")
	if _, r = mcpTool(t, f, planner, "save_recipe", map[string]any{"recipe_id": "lemon-pasta"}); r.status != 403 || !strings.Contains(r.header.Get("WWW-Authenticate"), `scope="planner cookbooks"`) {
		t.Fatalf("missing scope: %d %q", r.status, r.header.Get("WWW-Authenticate"))
	}
	if _, r = mcpTool(t, f, "svat_nope", "search_recipes", nil); r.status != 401 || !strings.Contains(r.header.Get("WWW-Authenticate"), `error="invalid_token"`) {
		t.Fatalf("bad token: %d %q", r.status, r.header.Get("WWW-Authenticate"))
	}

	// With the account linked: saving, the plan and the list, as the sous-chef does them.
	token := linkedToken(t, db, cook, "cookbooks", "planner", "groceries")
	if _, e := db.Exec(ctx, `UPDATE oauth_grants SET last_used_at=now()-interval '1 hour' WHERE user_id=$1`, cook); e != nil {
		t.Fatal(e)
	}
	result, _ = mcpTool(t, f, token, "save_recipe", map[string]any{"recipe_id": "lemon-pasta"})
	if text, _ = toolText(t, result); !strings.Contains(text, "Saved “Lemon pasta”") {
		t.Fatalf("save: %s", text)
	}
	mcpTool(t, f, token, "save_recipe", map[string]any{"recipe_id": "tomato-soup"})
	result, _ = mcpTool(t, f, token, "list_saved_recipes", nil)
	text, found = toolText(t, result)
	saved := found["recipes"].([]any)
	if found["total"] != 2.0 || saved[0].(map[string]any)["id"] != "tomato-soup" || !strings.Contains(text, "newest first") {
		t.Fatalf("saved: %s", text)
	}
	result, _ = mcpTool(t, f, token, "unsave_recipe", map[string]any{"recipe_id": "tomato-soup"})
	if _, found = toolText(t, result); found["saved"] != false || count(t, db, `SELECT count(*) FROM saves WHERE user_id=$1`, cook) != 1 {
		t.Fatalf("unsave: %v", found)
	}

	thursday := time.Now().UTC().AddDate(0, 0, 2).Format("2006-01-02")
	mcpTool(t, f, token, "plan_meal", map[string]any{"recipe_id": "tomato-soup", "day": thursday, "meal": "Dinner"})
	result, _ = mcpTool(t, f, token, "plan_meal", map[string]any{"recipe_id": "lemon-pasta", "day": thursday, "meal": "Dinner", "servings": 4})
	text, found = toolText(t, result)
	if found["servings"] != 4.0 || found["replaced"].(map[string]any)["id"] != "tomato-soup" || !strings.Contains(text, "replaces “Tomato soup”") || !strings.Contains(text, "?cook=1") {
		t.Fatalf("plan: %s %v", text, found)
	}
	if result, _ = mcpTool(t, f, token, "plan_meal", map[string]any{"recipe_id": "lemon-pasta", "day": "Thursday", "meal": "Dinner"}); result["isError"] != true {
		t.Fatal("planned on a day that isn't a date")
	}
	result, _ = mcpTool(t, f, token, "get_meal_plan", nil)
	text, found = toolText(t, result)
	meals := found["meals"].([]any)
	if len(meals) != 1 || meals[0].(map[string]any)["recipe"].(map[string]any)["title"] != "Lemon pasta" || !strings.Contains(text, "dinner: Lemon pasta, 4 servings") {
		t.Fatalf("plan read: %s", text)
	}

	result, _ = mcpTool(t, f, token, "add_groceries", map[string]any{"items": []any{map[string]any{"name": "Parmesan", "quantity": "50 g"}}})
	if _, found = toolText(t, result); found["added"] != 1.0 {
		t.Fatalf("add: %v", found)
	}
	result, _ = mcpTool(t, f, token, "add_recipe_groceries", map[string]any{"recipe_id": "lemon-pasta"})
	text, found = toolText(t, result)
	if found["added"] != 2.0 || !strings.Contains(fmt.Sprint(found["skipped"]), "Salt") {
		t.Fatalf("recipe groceries: %s %v", text, found)
	}
	result, _ = mcpTool(t, f, token, "get_grocery_list", nil)
	text, found = toolText(t, result)
	if items := found["items"].([]any); len(items) != 3 || !strings.Contains(text, "Parmesan (50 g)") {
		t.Fatalf("list: %s", text)
	}
	if result, _ = mcpTool(t, f, token, "add_groceries", map[string]any{"items": []any{}}); result["isError"] != true {
		t.Fatal("added nothing without an error")
	}

	// The link's last use shows in Connected apps.
	if n := count(t, db, `SELECT count(*) FROM oauth_grants WHERE user_id=$1 AND last_used_at>now()-interval '1 minute'`, cook); n != 1 {
		t.Fatalf("%d links touched", n)
	}
}

func TestMCPHasItsOwnRateLimits(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	// Above the API's 300 a minute per address, which an assistant's few addresses would use up:
	// ChatGPT's users count on their own.
	for i := range 400 {
		body, header := modernRequest("ping", map[string]any{"_meta": map[string]any{"openai/subject": fmt.Sprint("user-", i%2)}})
		if r := do(t, f, call{method: "POST", path: "/mcp", body: body, header: header, ip: "203.0.113.9"}); r.status != 200 {
			t.Fatalf("request %d: %d %s", i+1, r.status, r.body)
		}
	}
	body, header := modernRequest("ping", nil)
	// One linked member is limited on their own.
	cook := member(t, db, "busy@example.test")
	token := linkedToken(t, db, cook, "groceries")
	limited := 0
	for range 250 {
		if r := do(t, f, call{method: "POST", path: "/mcp", body: body, header: header, bearer: token, ip: "203.0.113.10"}); r.status == 429 {
			limited++
		}
	}
	if limited != 10 {
		t.Fatalf("%d of 250 limited", limited)
	}
}
