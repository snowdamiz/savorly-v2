# Savorly in ChatGPT and Claude

People plan meals in general assistants now (Instacart already works inside ChatGPT, Gemini and
Claude), so Savorly should be the recipe source those assistants call rather than something they
replace. One MCP server at `https://savorly.cooking/mcp` serves both: anyone can search Savorly's
recipes and see them as cards in the chat, and a member who links their account can save recipes,
plan meals and fill the grocery list from there. It costs Savorly no AI: the assistant's own model
does the talking. Siri (App Intents) is a later phase.

Cooking always happens in Savorly. Every recipe comes with a **Cook it in Savorly** link, which
opens it in cooking mode, where hands-free guidance, cook-tested notes and verified cooks (and so
creator pay) are. The tools give an assistant a recipe's description, ingredients and equipment,
but never its method, so the chat can't become a free copy of the recipe.

Code: `services/api/internal/app/mcp.go` (the protocol), `mcp_tools.go` (the tools),
`assistant_card.html` (the recipe card), `oauth_server.go` (account linking), migration
`036_assistants.sql`; in the app `ConnectApp.tsx` (the consent page) and `ConnectedApps.tsx`.

## Adding Savorly

**ChatGPT:** in its settings, under Apps (with developer mode on while Savorly isn't in the
directory), add an app with `https://savorly.cooking/mcp` and OAuth as its authentication. ChatGPT reads the metadata below,
identifies itself with its client ID metadata document (`https://chatgpt.com/oauth/client.json`),
and asks the member to link Savorly the first time a tool needs the account.

**Claude:** Customize → Connectors → **Add custom connector**, with the same URL. Claude connects
without an account, so search works at once; when it first calls a tool that needs one, it shows a
**Connect** card in the conversation, and after the member signs in it repeats the call.
Claude Code: `claude mcp add --transport http savorly https://savorly.cooking/mcp`, then `/mcp` to
sign in.

Staging is `https://staging.savorly.cooking/mcp`. Locally, run the API (`make api`) and the web app
(`make web`) and use `http://localhost:8080/mcp`; the consent page then opens at
`http://localhost:8081/oauth/authorize`. A hosted assistant can't reach `localhost`: expose the API
through an HTTPS tunnel and set `MCP_ORIGIN` to the tunnel's address.

## Tools

| Tool                   | Needs       | What it does                                                                                                                                                                                                                                 |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_recipes`       | nothing     | Up to 8 published recipes by words or ingredients, cuisine, tag, time and sort, as cards. `cook_tested` keeps only cook-tested ones. With a linked account, leaves out what the member's diets and allergies avoid unless `include_avoided`. |
| `show_recipe`          | nothing     | One recipe as a card: description, ingredients, equipment, time, rating and the cook-tested line, plus how many steps it has. Not the steps.                                                                                                 |
| `save_recipe`          | `cookbooks` | Saves a recipe; one already saved stays in its cookbook.                                                                                                                                                                                     |
| `unsave_recipe`        | `cookbooks` | Takes a recipe out of the saved recipes and its cookbook.                                                                                                                                                                                    |
| `list_saved_recipes`   | `cookbooks` | The 50 newest saves, with the cookbook each is in.                                                                                                                                                                                           |
| `plan_meal`            | `planner`   | Puts a recipe on a day's breakfast, lunch or dinner, replacing what was there, and says what it replaced.                                                                                                                                    |
| `get_meal_plan`        | `planner`   | The plan from one day to another (up to 62 days; by default today and the next 6).                                                                                                                                                           |
| `add_groceries`        | `groceries` | Adds up to 40 items to the grocery list.                                                                                                                                                                                                     |
| `add_recipe_groceries` | `groceries` | Adds a recipe's ingredients, scaled and merged, leaving off what the pantry has and kitchen basics, and says which.                                                                                                                          |
| `get_grocery_list`     | `groceries` | What's still to buy and what's checked off.                                                                                                                                                                                                  |

Each tool runs the sous-chef's own tool call (`agent.go`), or the app's route it would call, as the
member or as a guest, so validation, ownership, the household's shared lists and the diet filter
are the app's. Every answer is a few lines of text for the model plus the same as
`structuredContent`, which each tool's `outputSchema` describes; recipes carry `url` (their page)
and `cookUrl` (`/recipes/<id>?cook=1`, which opens cooking mode at the first step, in the phone
app where it's installed, and records `recipe_open` with `from: "assistant"`). Every tool has
`readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` (always false: the tools
reach only Savorly). Searching and reading are read-only; `unsave_recipe` and `plan_meal` (which
replaces a planned meal) are marked destructive, so assistants confirm them.

`cook_tested` sends `cookTested=true` to `GET /recipes`, and the tool also keeps only recipes with
at least 5 verified cooks, so it holds on a server whose search doesn't filter yet.

## The recipe card

`search_recipes` and `show_recipe` name `ui://savorly/recipe-card-v1.html` in `_meta.ui.resourceUri`
(and ChatGPT's `openai/outputTemplate`), an [MCP App](https://modelcontextprotocol.io/extensions/apps/overview):
HTML the assistant shows in a sandboxed frame and fills in with the tool's structured result. One
recipe is its photo, title, one line of facts and **Cook it in Savorly**; several are quiet rows,
each opening its recipe the same way. The facts line is "Cook-tested · 214 cooks · usually 55 min"
for a cook-tested recipe, otherwise its time and cuisine. The card follows the host's theme and
colors, speaks the nine languages from the host's locale, opens links through the host
(`ui/open-link`, or ChatGPT's `openExternal`), and loads nothing but photos from the media hosts
(`_meta.ui.csp.resourceDomains`: the bucket's public URL and `MEDIA_HOSTS`). Change the card's URI
(`-v2`) when its HTML changes in a way an old cached copy would break.

Clients without MCP Apps show the text, which lists each recipe with its link.

## The protocol

`POST /mcp` takes one JSON-RPC message and answers one JSON object (never a stream; notifications
get `202`). It speaks every version since Streamable HTTP:

- **2026-07-28**, stateless: each request names its version and the client's capabilities in
  `_meta`, mirrored in the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers (Base64 in
  `=?base64?…?=` when needed). A mismatch is `400` with `-32020`, missing `_meta` `400` with
  `-32602`, another version `400` with `-32022` and the supported list, an unknown method `404`.
  `server/discover` describes the server. Answers carry `resultType` and the server's info in
  `_meta`. `Mcp-Session-Id` is ignored.
- **2025-11-25, 2025-06-18, 2025-03-26**: `initialize` agrees on a version and answers an
  `Mcp-Session-Id`, which later requests send with `MCP-Protocol-Version`. An unknown or ended
  session is `404`, and the client starts again; `DELETE /mcp` with the header ends one. Sessions
  live in `mcp_sessions` (hashed), hold only the version, and end after 30 idle days. A request
  with an earlier version header and no session is answered without one. 2025-03-26 batches work.

`GET /mcp` is `405`. A request from a browser page of another site is refused (`403`), as for the
rest of the API. Methods: `initialize`, `server/discover`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`, `resources/templates/list` and `prompts/list` (empty).

## Linking an account

Savorly is its own OAuth 2.1 authorization server (`oauth_server.go`), with the API as the issuer:

| Path                                                              | What                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource` (and `/mcp` after it) | The MCP server's metadata (RFC 9728): `resource` is `<site>/mcp`, the scopes, the issuer.                                                          |
| `GET /.well-known/oauth-authorization-server`                     | The issuer's metadata (RFC 8414): PKCE `S256` only, `iss` in responses (RFC 9207), client ID metadata documents, and `none` at the token endpoint. |
| `POST /oauth/register`                                            | Dynamic client registration (RFC 7591), for clients without a metadata document.                                                                   |
| `/oauth/authorize`                                                | The consent page, in the web app.                                                                                                                  |
| `POST /oauth/token`                                               | Codes and refresh tokens, form-encoded.                                                                                                            |
| `POST /oauth/revoke`                                              | Revocation (RFC 7009).                                                                                                                             |

An app identifies itself with a **client ID metadata document**, an HTTPS URL as its `client_id`
that the server reads (through the import's guard, public addresses only, 5 KB at most) and keeps
for a day, as ChatGPT and Claude do, or by **registering** (deprecated in MCP, kept for others).
Return addresses must be HTTPS or `http://localhost`/`127.0.0.1`; a loopback one matches on any
port, which Claude Code needs. An app from ChatGPT or Claude (its document is on `chatgpt.com`,
`claude.ai` or `claude.com`, or all its return addresses are) is shown as known; others get a
caution, and one that returns to this device a stronger one.

The consent page (`/oauth/authorize`, `ConnectApp.tsx`) asks the API about the request
(`GET /v1/oauth/authorize?<the request>`), asks a guest to sign in with any of the usual ways, and
shows the app, what it will be able to do (one line per scope), and where the member goes back
to. **Connect** or **Cancel** (closing is a no) posts the answer (`POST /v1/oauth/authorize`) and
sends the member back with a code, or `access_denied`, and `iss`. A request whose app or return
address can't be trusted is explained on the page and never redirected.

Scopes are `cookbooks` (saving), `planner` (the meal plan) and `groceries` (the list); a request
naming none of them asks for all three. Codes last 5 minutes and work once: presenting one again
ends the link it made. Access tokens last an hour, refresh tokens 90 days, and each refresh rotates
the refresh token. One presented again more than 10 seconds after its first use means two parties
hold it, so the whole link ends; within 10 seconds it's an app retrying, which gets tokens again.
Tokens are random and stored hashed, and they only open `/mcp`: they are never sessions, and
sessions never open `/mcp`. Each token is for one resource (RFC 8707) and refused elsewhere.

When a tool needs an account the request doesn't have, Claude and most clients get `401` with
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp",
scope="cookbooks planner groceries"` before the tool runs, and `403` with
`error="insufficient_scope"` when the link lacks the scope. ChatGPT's requests (they carry
`openai/` fields in `_meta`) instead get a tool error whose `_meta["mcp/www_authenticate"]` holds
that challenge, which ChatGPT shows as a sign-in. An invalid or expired token is always `401`
(`error="invalid_token"`), and the client refreshes.

**Connected apps** in Settings lists each link (`GET /v1/me/connected-apps`): the app, when it
was linked and last used, and **Disconnect** (`DELETE /v1/me/connected-apps/:id`), which stops its
tokens at once. A member who links the same app twice, say from two ChatGPT accounts, sees two
links.

## Limits and cleanup

`/mcp` and the OAuth endpoints aren't under the API's 300 requests a minute per address: an
assistant calls for all its users from a few addresses of its own. Instead `/mcp` allows 240 a
minute per linked account, and for guests 300 a minute per address and ChatGPT user
(`openai/subject`), within 1,200 per address; the token and revocation endpoints 600 a minute per
address and app; registration 30 a minute and discovery 600 a minute per address. The consent page
itself is under the API's limits, and answering it 30 times in 15 minutes per member.

The janitor deletes expired codes and tokens, links whose refresh token can no longer be used,
apps no one has linked for 30 days and that have no links, and sessions idle for 30 days.

## Deployment

The Worker sends `/mcp`, `/oauth/register`, `/oauth/token`, `/oauth/revoke` and the two OAuth
files under `/.well-known` to the API as they are (`isRootApiPath` in `infra/cloudflare/site.ts`);
`/oauth/authorize` stays with the app. In production the issuer and the resource are on `APP_URL`
(`https://savorly.cooking`); `MCP_ORIGIN` overrides it, and in development it's the API's own
address. Nothing else needs configuring.

## Left for the directories

Not done yet, and not testable from a development machine: connecting the deployed server from
ChatGPT and Claude, and the review each directory makes.

- **ChatGPT app directory:** a verified OpenAI developer organization, the app's name, icon,
  description and screenshots, the privacy policy and terms (`/privacy`, `/terms`), a test account
  with a linked kitchen for the reviewers, test prompts with their expected results, and the
  card's CSP and domain (`openai/widgetDomain` is the site) as declared. ChatGPT's tool review
  checks the annotations against what each tool does. Decide whether to verify ChatGPT's mTLS
  certificate (`mtls.prod.connectors.openai.com`) on `/mcp`.
- **Claude connector directory:** the submission form with the universal URL, CIMD as the
  authentication type, a test account, documentation for users (this page's "Adding Savorly"),
  and the privacy policy. Anthropic's traffic comes from `160.79.104.0/21`; Cloudflare must not
  challenge it on `/mcp`, `/oauth/*` or `/.well-known/*`.
- Both: watch the first weeks' `/mcp` traffic (the access log names `route=/mcp`) and raise the
  guest limits if the assistants' addresses reach them.
