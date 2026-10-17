# API conventions

Base path: `/v1`. Request/response bodies are JSON, except multipart uploads and successful `204` deletions. Errors have `{ "error": "A readable message", "requestId": "…" }`; the request id is also the `X-Request-Id` response header and appears in the API's access log, so support can find a failed request. Compressible responses over 200 bytes are gzip- or brotli-encoded when the client accepts it (narration audio never is). Health is `GET /health`.

The browser authenticates with an HttpOnly session cookie and `credentials: include`. Native clients send `Authorization: Bearer <session-token>`. Tokens are returned by login, registration and Apple/Google sign-in only for requests without an Origin header; browser code never receives them. Cookie mutations must have an allowed Origin header. All private lists and mutations are scoped to the authenticated account.

Older app builds stay installed for months, so the API only ever adds fields and routes; new behaviour on an existing route is opt-in through a parameter.

Every route allows 300 requests a minute per visitor address ([deployment](DEPLOYMENT.md#1-database-and-api) explains how the address is found behind a proxy). Request bodies other than `GET`, `HEAD` and `OPTIONS` are capped at 128 KiB (`413`), except `POST /media` and the sous-chef's image upload.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/forgot`, `/auth/reset`, `/auth/nonce`, `/auth/oauth`, `GET /session` |
| Account | `GET /me`, `PATCH /me`, `DELETE /me` (requires the current password, or a fresh Apple or Google sign-in for a kitchen without one), `POST /me/onboarded`, `GET /handles/:handle`, [`PATCH /me/preferences`](#preferences), [`PUT` or `DELETE /me/push-token`](#push-notifications) |
| Account security | `POST /me/password`, `POST /me/email`, `POST /me/email/confirm`, `POST /me/verify-email`, `POST /me/verify-email/resend`, `GET /me/sessions`, `DELETE /me/sessions/:id`, `POST /me/sessions/revoke-others` |
| Data export | `GET /me/export`, `POST /me/export-link`, `GET /export/:token` |
| Recipes | `GET /recipes`, `GET /recipes/:id`, `POST /recipes`, `PUT /recipes/:id`, `DELETE /recipes/:id`, `GET /recipes/:id/variations`, [`GET /recipes/:id/translation`](#recipe-translations), `POST /recipes/import`, `GET /feed`, `GET /sitemap` |
| Narration | `POST /recipes/:id/steps/:step/narration`, `GET /recipes/:id/steps/:step/narration/:key` |
| Reviews and reports | `GET /recipes/:id/reviews`, `PUT` or `DELETE /recipes/:id/review`, `PUT` or `DELETE /recipes/:id/reviews/:review/reply`, `POST /recipes/:id/report` |
| Comments and cooks | `GET` or `POST /recipes/:id/comments`, `DELETE /comments/:id`, `GET /recipes/:id/cooks`, `POST` or `DELETE /recipes/:id/cooked` |
| Creators | `GET /creators`, `GET /creators/:id`, `PUT` or `DELETE /creators/:id/follow`, `GET /creators/:id/cookbooks` |
| Cookbooks | `GET /library`, `GET /library/recipes`, `POST /collections`, `PATCH /collections/:id`, `DELETE /collections/:id`, `PUT` or `DELETE /recipes/:id/save`, `GET /cookbooks/:id` |
| Kitchen | `GET /kitchen`, `POST /planner`, `DELETE /planner/:id`, `POST /planner/groceries`, `POST /pantry`, `DELETE /pantry/:id` |
| Groceries | `POST /groceries`, `PATCH /groceries/:id`, `DELETE /groceries/:id`, `POST /recipes/:id/groceries`; a household's shared list for its members ([households](#households)) |
| Households | `GET` or `POST /household`, `POST /household/invite`, `POST /household/join`, `DELETE /household/members/:userId` |
| Analytics | `POST /events` (no session needed); admins: `GET /admin/insights` |
| Media | `POST /media/uploads`, `POST /media/uploads/complete`, `POST /media` with multipart field `file`, `POST /media/touch-up` |
| App errors | `POST /client-errors` |
| AI | `GET /capabilities`, `GET /ai/jobs`, `GET /ai/jobs/:id`, `POST /ai/jobs` |
| Sous-chef | `GET` or `POST /recipe-studio`, `GET` or `DELETE /recipe-studio/:id`, `POST /recipe-studio/:id/messages`, `PUT /recipe-studio/:id/context`, `POST /recipe-studio/:id/images`, `POST /recipe-studio/:id/undo`, `POST /recipe-studio/:id/cancel`, `POST /recipe-studio/:id/voice`, `DELETE /recipe-studio/voice/:session` |
| Billing | `GET /billing`, `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/webhook` (Stripe only) |
| Admin | `/admin/*` for admins only; see [admin console](ADMIN.md#api) |

## Usernames

A handle is 3–24 lowercase letters, digits, dots or underscores that starts and ends with a letter or digit, with no two dots in a row; a few names that would read as Savorly itself are reserved. New kitchens get one from their name (`alexrivera`, or `alexrivera42` when that's taken), and registration and a first Apple or Google sign-in answer `"created": true` so the app can offer to change it straight away.

`PATCH /me` takes an optional `handle` (a leading `@` and capitals are normalized). Left out or unchanged, the current handle stays, including older generated ones the rules above would reject. An invalid handle is `400`, a taken or reserved one `409`. `GET /handles/:handle` answers `{ "handle", "valid", "available" }` while someone types; their own handle counts as available.

## Kitchen setup

`GET /me` includes `onboarded`: `false` for a new kitchen until it finishes or skips its setup (photo, name and username, food preferences, cooks to follow, meeting the sous-chef), which the app shows on every platform and resumes after a restart. `POST /me/onboarded` marks it done and answers like `GET /me`. Kitchens from before the setup existed count as set up. A first Google sign-in starts the profile photo from the Google account's picture.

## Apple and Google sign-in

`POST /auth/nonce` takes no body and answers `{ "nonce" }`, single-use and valid for 10 minutes. The app hands it to Apple or Google and sends the resulting ID token to `POST /auth/oauth` as `{ "provider": "apple" | "google", "token", "code", "name" }`. `code` and `name` are optional: Apple's authorization code lets the server revoke Apple access when the account is deleted, and `name` names a new kitchen. Limits are per visitor address and per route: 60 nonces and 30 Apple/Google sign-ins per 15 minutes (see [accounts and security](#accounts-and-security) for the others). Past a limit is `429`.

Signed out, `/auth/oauth` starts a session like login (the cookie, plus `token` without an Origin header) and adds `"created": true` for a new kitchen. From a signed-in session it connects the provider to that kitchen instead and answers `{ "ok": true, "connected": "apple" | "google" }`. A provider the server isn't configured for is `503`; a token that fails verification, or a missing, used or expired nonce, is `401`. Connecting an identity that belongs to another kitchen is `409`, and so is a first Apple or Google sign-in whose email already has a kitchen (accounts are never merged by email). A new kitchen needs a verified provider email (`400`) and open sign-ups (`403`); a suspended account is also `403`.

`GET /me` lists connected `identities` and `hasPassword`. A kitchen without a password confirms `DELETE /me` with `{ "provider", "token" }` from a fresh sign-in (with a new nonce) instead of `password`. See [sign-in](SIGN-IN.md).

## Accounts and security

Sign-in routes have their own limits per visitor address: registration 20 an hour; login 20, password-reset requests 5, reset codes 10 and Apple/Google sign-ins 30 per 15 minutes. Login also allows 10 attempts per account per 15 minutes, answering `429` "Too many sign-in attempts…" whether or not the account exists; a successful login or a password reset clears it. A forgot-password request mails at most 5 codes an hour to one address and otherwise still answers `{ "ok": true }`.

When `TURNSTILE_SECRET_KEY` is set, `POST /auth/register` and `POST /auth/forgot` need a Cloudflare Turnstile `turnstileToken` in the body (`400` when missing or rejected, `503` when Cloudflare can't be reached); `/capabilities` reports the public `turnstileSiteKey` (`""` when the check is off). Turn it on only once the app versions people use send the token.

`GET /session` always answers `200` with `{ "user": <GET /me> | null }`, so a signed-out visitor causes no `401`s; apps use it at startup. Sessions last 30 days and slide: past half their life, any authenticated request extends them, and a cookie client gets the cookie again. `GET /me/sessions` lists the account's devices, this one first: `[{ "id", "createdAt", "lastUsedAt", "expiresAt", "userAgent", "client", "system", "current" }]`, where `client` is `Savorly` (the app) or a browser name and `system` names the device's system, each `""` when unknown. `DELETE /me/sessions/:id` signs one out (`204`, `404` for an unknown id) and `POST /me/sessions/revoke-others` signs out every other device (`{ "revoked": n }`).

`POST /me/password` takes `{ "currentPassword", "newPassword" }`, or `{ "newPassword", "provider", "token" }` with a fresh Apple or Google sign-in for a kitchen without a password, and answers like `GET /me`. The new password follows the registration rules (12–72 characters); other devices are signed out and pending reset codes cleared. A wrong password here, on the email routes below and on `DELETE /me`, is `403` rather than `401`, which apps treat as signed out.

`POST /me/email` takes `{ "email", "password" }` (or `{ "email", "provider", "token" }`), mails a six-digit code to the new address and answers `{ "ok": true, "email" }`; `POST /me/email/confirm` takes `{ "code" }` and answers like `GET /me` with the new, verified address. Registration mails a welcome with a 24-hour code: `POST /me/verify-email` takes `{ "code" }` and `POST /me/verify-email/resend` sends another. `GET /me` reports `emailVerified`. Codes last 15 minutes (24 hours for the welcome) and allow 5 tries; a wrong or expired code is `400`, a taken address `409`, a server without email `503`, and a failed delivery `502`. These routes work exactly when `/capabilities` reports `passwordRecovery`. With email configured, the account also gets a note when its password or email changes (to the old address), when a new device signs in, and when it is deleted.

`GET /me/export` downloads everything the account holds as JSON (`Content-Disposition: attachment`): `profile`, `preferences`, `plan`, `connectedProviders`, `recipes` (drafts included), `reviews`, `cookbooks`, `saves`, `following`, `mealPlans`, `groceries`, `pantry`, `studioConversations[].messages` and `aiJobs`; never password hashes, provider tokens or billing ids. A native app, which can't add its bearer token to a browser download, calls `POST /me/export-link` for `{ "url": "/v1/export/<token>", "expiresAt" }` and opens the API's base URL plus `url`; the link works once, for 10 minutes.

`POST /client-errors` (no session needed, 30 a minute per visitor, up to 16 KB) takes `{ "message", "stack", "componentStack", "platform", "appVersion", "url", "release" }` from the app's error handlers, writes one line to the API's log and answers `204`.

## Discovery

`GET /recipes?q=lemon&category=Italian&tag=Vegetarian&maxMinutes=30&sort=Quickest&limit=24&offset=0`

Parameters are optional. `limit` is bounded to 60; pagination uses `offset`. The supported sort labels are `For you` (newest), `Quickest`, and `Top rated`. Public search never returns drafts. Recipe detail returns a draft only to its author.

`q` matches each word as a prefix of words in the title, cuisine, tags, ingredient names and description, in any language and ignoring accents ("creme brulee" finds "Crème brûlée"), with English stemming on top, and tolerates typos in titles and ingredient names ("ricota"). Results are ranked by relevance; with `Quickest` or `Top rated`, the closest matches still come first. `Top rated` orders by a weighted rating, `(sum of ratings + 5 × site average) / (reviews + 5)`, so one five-star review doesn't outrank many good ones; recipes still show their plain average and `reviewCount`. `category` matches a cuisine ignoring case. `following=true` limits the list to cooks the account follows (`401` without a session). `GET /creators` takes `limit` (up to 100) and `offset`.

`GET /feed?limit=12` (1–24) builds the home screen in one request: `{ "hero": Recipe | null, "trending": [...], "quick": [...], "following": [...], "newest": [...] }`. Trending is the most saved in the last 7 days, quick is 30 minutes or less, and following is empty for guests; the hero isn't repeated, but a recipe can be both trending and quick. `GET /sitemap` lists `{ "recipes": [{ "id", "updatedAt" }], "creators": [{ "id", "handle", "updatedAt" }] }` for the Worker's sitemap, cached for an hour.

## Recipe shape

The shared Expo contract lives in `apps/mobile/src/lib/types.ts`; server validation is in `services/api/internal/app/models.go`.

```json
{
  "title": "Lemon toast",
  "description": "A simple little plate for a slow morning.",
  "cuisine": "American",
  "minutes": 10,
  "servings": 2,
  "difficulty": "Easy",
  "image": "",
  "video": "",
  "ingredients": [{ "name": "Sourdough", "amount": 2, "unit": "slices", "category": "Bakery" }],
  "steps": [{ "title": "Toast", "text": "Toast until golden and finish with your favorite toppings.", "seconds": 120 }],
  "tags": ["Vegetarian", "Breakfast"],
  "calories": 0,
  "aiGenerated": false,
  "published": true
}
```

`language` is optional: one of `en`, `fr`, `de`, `ru`, `es`, `it`, `pt`, `zh`, `ja` or empty (regional tags such as `pt-BR` are shortened), and leaving it out on an update keeps the saved one. Cuisines on the app's list are stored with its spelling ("italian" becomes "Italian"); others are trimmed and capitalized. Names, units, tags and step text are trimmed, and empty or repeated tags dropped.

Media is optional. Use the URL returned by an [upload](#uploads), or in production a URL on a host listed in `MEDIA_HOSTS`; profile photos may also be a Google account picture. Media a recipe already has stays allowed when it is edited. The local development API accepts any HTTPS URL and localhost HTTP media. Ingredients and steps remain required even when a video is attached so the recipe can be searched, scaled, planned, and cooked accessibly. Each step may also carry a photo and a short clip ([step media](#uploads)).

## Cookbooks, kitchen and groceries

`GET /library?limit=24` returns at most that many recipes (the most recently saved or written first) with `"hasMore"`; the ids, saves, cookbooks and follows stay complete, and without `limit` every recipe comes as before. Either way it also has `ownIds`, every recipe the member wrote (drafts too, newest first), and `publishedCount`, how many of them are published. The app asks for the newest 24 and pages through the rest. `GET /library/recipes?scope=saved|mine&collection=<id>&offset=0&limit=24` pages through saved or the account's own recipes as `{ "recipes", "hasMore" }`. `GET /kitchen?from=2026-10-12&to=2026-11-08` limits meal plans to that range of up to 62 days (`400` otherwise); groceries and pantry are always complete.

Grocery amounts are written with at most two decimals, and cups and spoons as fractions (⅓ cup). `POST /planner` and `POST /recipes/:id/groceries` take a published recipe or one of the account's own, published or not (`404` for anyone else's draft): plans are the account's alone, and a list only gets the ingredients. Adding a recipe's ingredients, or a week's with `POST /planner/groceries { "from", "to" }` (every planned meal in the range, scaled to its servings), merges each into an unchecked line with the same name and unit; both answer `{ "added", "merged" }`. `DELETE /recipes/:id/review` deletes the account's own review (`404` when there is none); an edited review keeps its `createdAt` and gets a new `updatedAt`. A recipe's author can answer each review on it: `PUT /recipes/:id/reviews/:review/reply` takes `{ "body" }` (2–1,000 characters) and answers `{ "reply": { "body", "repliedAt" } }`, sending again changes the answer, and `DELETE` on the same path removes it (`404` for anyone else, or when there is no answer). Reviews carry `reply`, the answer or `null`, and a new answer (not an edit) sends the reviewer a push notification under their comments setting.

## Uploads

`POST /media/uploads` takes `{ "kind": "image" | "video", "contentType", "size" }` (JPEG, PNG, WebP, MP4 or WebM, up to 50 MB; 60 an hour per account) and answers `{ "uploadUrl", "method": "PUT", "headers", "url", "key", "expiresAt" }`. The app PUTs the file to `uploadUrl` within 15 minutes, sending exactly `headers`, then calls `POST /media/uploads/complete { "key" }`, which checks the stored file and answers `{ "url" }` (`404` if the key isn't the account's or nothing arrived, `400` for a file that isn't what it said, which is deleted). Browsers need the bucket's CORS rules ([storage](STORAGE.md)). The older multipart `POST /media` still works and streams large files to storage; it allows 5 minutes for the body.

A step may have an `image`, a photo of that step, and a `video`, a short clip of it, under the same rules as the recipe's own photos and video (in production, our storage or `MEDIA_HOSTS`; media the recipe already has stays valid). Steps without one have no `image` or `video` key. On an update, a step that leaves either key out (as older apps and the sous-chef do) keeps the photo or clip of the saved step with the same text, or else of the step in the same place with the same title; `""` removes it.

Two optional fields link a recipe to where it came from. Leaving a field out (as older apps do) or sending `null` keeps a saved recipe's value; `""` removes it.

- `sourceUrl`: the page an imported recipe came from, an `http` or `https` address of up to 500 characters (`400` otherwise).
- `derivedFrom`: the id of the recipe this one adapts, which must be published or one of the author's own, and not the recipe itself (`400`). The link a recipe already has stays valid after its original is unpublished. The `{ id, title, author }` object recipe JSON carries is accepted and ignored, so a recipe can be sent back as it was loaded. Deleting the original removes the link, not the variation.

Recipe JSON also has `sourceUrl` (`""` for none), `derivedFrom` (`{ "id", "title", "author": { "id", "name", "handle" } }` while the original is published and its author in good standing, else `null`), and `variationCount` (published variations), `commentCount` and `cookedCount`. Like `reviewCount`, the counts include what suspended members wrote, which their lists leave out.

## Variations

`GET /recipes/:id/variations` lists up to 20 published recipes whose `derivedFrom` is this recipe, newest first, in the usual recipe shape.

## Recipe translations

`GET /recipes/:id/translation?language=fr` answers a recipe's text in one of the app's nine languages: `{ "language", "sourceLanguage", "title", "description", "ingredients": [{ "name" }], "steps": [{ "title", "text" }], "translatedAt" }`, with exactly the recipe's ingredients and steps, in its order. Amounts, units, timers, media, tags and cuisine aren't in it: they stay as the recipe has them, and the app lays the translated words over the recipe it shows. The recipe must be published, or the caller's own, by a cook in good standing (`404`), and `language` one of the nine (`400`). A recipe already written in that language answers with its own text and `translatedAt: null`, without AI.

A recipe is translated into a language once, by `OPENROUTER_TRANSLATION_MODEL` (GPT-6 Luna unless set), and the translation is kept for every later reader, guests included. It is kept under a digest of the recipe's text and language, so editing the recipe's text has the next reader's request translate it again; a translation of other text is never answered. The model gets the recipe as JSON data with rules never to follow instructions in it and to keep its shape; an answer with another number of ingredients or steps, a field left out, or text far longer than what it translates is refused.

Making a new translation needs a session (a guest gets `401` "Sign in to translate this recipe.") and text AI (`503`), and allows 30 a member an hour (`429`); reading one already made is free and open to everyone. Every reader shares it, so no member pays: it is reserved against the shared free daily budget, like free members' use (`429` when that or the day's budget is spent, `503` while AI is paused from the admin console), and settled to the cost OpenRouter reports. Requests for the same translation wait on one model call (up to 90 seconds), on one API process and, through a database lock, across replicas; four translations run at once per process (`503` "Translation is busy…" past that). A failed one is `502` ("We couldn’t translate this recipe. Please try again."), and for 30 seconds asking again answers the same rather than paying again; the app never repeats the request on its own. A translation nobody has read for 90 days is deleted, and deleting the recipe deletes its translations. `/capabilities` reports `recipeTranslation` and `translationModel`.

## Importing a recipe

`POST /recipes/import` takes `{ "url" }` and reads a recipe from that web page into a private draft for the editor; nothing is saved. It needs a session and allows 20 imports an hour per member. The address may be `http` or `https` (the scheme may be left out); pages are fetched over HTTPS from public addresses only, following up to four redirects, reading at most 3 MB of an HTML page.

- A page with schema.org `Recipe` data (JSON-LD) answers `200` with `{ "method": "structured", "recipe": <recipe input> }`: `published: false`, `aiGenerated: false`, and `sourceUrl` the page it ended at (without its fragment or tracking parameters). Ingredient lines become amounts, units and names; missing times, servings or descriptions are filled in. Its photos are kept only where a recipe may show them, so in production they're usually left out.
- Otherwise, with text AI on, it answers `202` with `{ "method": "ai", "job": <AI job> }`: an ordinary `recipe` job, under the same allowances and budgets as `POST /ai/jobs`, whose prompt holds the page's text. An `Idempotency-Key` header (8–100 characters) makes a retry answer the same job; without one, every request queues a new job. Poll `GET /ai/jobs/:id`; the finished `result.recipe` has the page as its `sourceUrl` and `aiGenerated: true`. A job that finds no recipe on the page fails with "We couldn’t find a recipe on that page."
- An address that isn't one is `400`; a page that can't be opened `502` ("We couldn’t open that page."); a page that isn't HTML, or has too little text to hold a recipe, `422` ("We couldn’t find a recipe on that page."); a page without recipe data while text AI is off `503` ("We couldn’t read a recipe from that page.").

## Comments

`GET /recipes/:id/comments?offset=&limit=` (up to 50, the default) lists a recipe's comments oldest first, as `{ "id", "body", "parentId", "createdAt", "updatedAt", "author": { "id", "name", "handle", "avatar" }, "canDelete" }`. Replies are in the same list, with the `parentId` of the comment they answer (`null` for a comment). The recipe must be published, or the caller's own; comments by suspended members, and the replies to them, are left out. `canDelete` is true for the caller's own comments and, for a recipe's author, every comment on it.

`POST /recipes/:id/comments` takes `{ "body", "parentId" }` (1–1,000 characters; `parentId` optional) and answers `201` with the comment. It needs a session and a published recipe (`404`), and allows 30 comments an hour per member. Replies are one level deep: replying to a reply answers the comment it replies to; a `parentId` that isn't a comment on this recipe is `404`. `DELETE /comments/:id` lets a comment's author, or the recipe's, remove it and its replies (`204`, else `404`). Admins remove comments with `DELETE /admin/comments/:id` ([admin console](ADMIN.md#api)).

## I cooked this

`POST /recipes/:id/cooked` takes `{ "photo", "note" }`, both optional, and answers `{ "cooked": true, "cookedCount" }`. There's one per member and published recipe (`404` otherwise): cooking it again moves it to the top and keeps whichever of `photo` and `note` it doesn't send. The photo follows the rules for recipe photos (`400`), and the note is up to 500 characters. `DELETE /recipes/:id/cooked` answers `204`. `GET /recipes/:id/cooks?limit=` (up to 30, the default; `offset` pages) lists who cooked a published recipe, most recent first, as `{ "id", "photo", "note", "createdAt", "author": { "id", "name", "handle", "avatar" } }`, leaving out suspended members. `GET /library` includes `cookedIds`.

## Shared cookbooks

Cookbooks are private until their owner shares them. `GET /library`'s `collections` have `public` and `description`. `PATCH /collections/:id` takes any of `{ "name", "public", "description" }` (a name of 1–60 characters, a description of up to 300) and answers `{ "id", "name", "public", "description" }`; what it doesn't send stays. Another member's cookbook is `404`, and a name the owner already uses `409`.

`GET /cookbooks/:id` needs no session and answers `{ "id", "name", "description", "public", "owner": <creator>, "recipeCount", "recipes", "hasMore" }` for a shared cookbook, or for its owner's own; anything else is `404`, as is a suspended owner's. It shows the published recipes of cooks in good standing, newest saved first; `limit` (up to 100, default 60) and `offset` page them. `GET /creators/:id/cookbooks` lists a cook's shared cookbooks that show any recipes, most recently added to first, as `{ "id", "name", "description", "recipeCount", "cover" }` (the photo of the newest pictured recipe, or `""`). The web app opens a cookbook at `/cookbooks/<id>`, and `GET /sitemap` lists shared cookbooks with recipes as `cookbooks: [{ "id", "updatedAt" }]`.

## AI jobs

`POST /ai/jobs` makes a photo or a short clip from a description (the editor's Create a cover photo and Create a short clip). It takes `{ "kind": "image", "prompt": "Overhead editorial shot of a lemon pasta" }`, where `kind` is `image` or `video`, and an `Idempotency-Key` header between 8 and 100 characters. A new request returns `202` and a job object; retrying the same payload with the same key returns the same job. Reusing a key for different input returns `409`. Any other kind is `400`: questions, twists, swaps, nutrition, meal plans and new recipes are the sous-chef's conversation, and a `recipe` job is made only by importing a page (above). Unconfigured providers return `503`; exceeded quotas return `429`.

Poll `GET /ai/jobs` for the current account's latest 30 jobs, or `GET /ai/jobs/:id` for one. Status progresses from `queued` to `running`, optionally `processing` for video, and then `completed` or `failed`. Results contain `url` (a photo or clip), or `recipe` for an import; jobs from before those moved to the sous-chef can hold `text`. Generated recipes are editable private drafts; generation never publishes on the user's behalf.

`POST /media/touch-up` takes `{ "url", "kind": "avatar" | "dish" }` and an `Idempotency-Key`, and queues an AI retouch of a photo the member already has: one they uploaded or generated, or the profile photo they use now (such as their Google picture). It answers `202` with an `image` job whose `source` is that photo; the result's `url` is a new photo, and the original is left as it is. The image model gets the photo as a reference and is told to keep the subject exactly as it is while improving light, color and focus. It counts as an AI photo for plan allowances and reserves the same budget. Anything else is `400`.

## Cooking narration

Both routes need a session and a recipe that is published or the caller's own; `:step` is the zero-based step index (0–99, else `400`), and a missing recipe or step is `404`. `POST /recipes/:id/steps/:step/narration` takes `{ "text" }`, which must equal the saved step text (`409` otherwise), and answers `{ "path", "model" }`, where `path` is the audio route relative to `/v1`. A blank step or one over 4,000 characters is `422` (use device speech), and `503` means narration is unconfigured or busy. An uncached step starts generating in the background, where plan allowances and AI budgets are checked, so a refusal shows up as a failed GET (`502`) rather than a `429`. A cook reading the recipe [translated](#recipe-translations) also sends `"language"`: `text` must then equal the step of the recipe's current translation into that language (`409` when there is none, or it is of an older version), the answered `path` ends in `?language=fr`, and the GET reads that step the same way. Without it, as older apps send, the recipe's own text is read.

`GET /recipes/:id/steps/:step/narration/:key` answers `audio/mpeg` and never starts a generation; a stale key (the step text, voice or model changed) is `404`. Cached audio supports a single byte range (`206`, or `416` for an invalid one). Audio still being generated on the same API process streams as it arrives, but a bounded range such as `bytes=0-1` waits for the whole file; otherwise, as when another replica is generating, the GET waits up to 26 seconds for the shared cache and then answers `504`. A failed generation is `502`. `/capabilities` reports `cookingNarration`; see [cooking narration](COOKING-NARRATION.md).

## Billing

Plans are sold only through Stripe Checkout on the web ([pricing](PRICING.md)). Every billing route except the webhook needs a session. Until `PAID_PLANS=true`, `GET /billing` is `404`; checkout, the portal and the webhook also need `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. `GET /billing` answers `{ "plan", "status", "interval", "renewsAt", "cancels", "usage", "plans", "checkout", "manage" }`: the plan in effect, the last 30 days' usage, the plan catalog, whether checkout is open, and whether this account can open the customer portal.

`POST /billing/checkout` takes `{ "plan": "plus" | "pro", "interval": "monthly" | "yearly" }` and answers `{ "url" }`, a Stripe Checkout page to open. It is `503` while billing is closed, `400` for `free` or a plan without a configured Stripe price, and `409` when the account already has a paid plan. `POST /billing/portal` answers `{ "url" }` for Stripe's customer portal, or `404` when the account has no Stripe customer or billing is closed. Both return to `APP_URL/?page=profile` (`&plan=welcome` after a completed checkout). Stripe errors are `502`.

`POST /billing/webhook` is for Stripe. It requires a `Stripe-Signature` header signed with `STRIPE_WEBHOOK_SECRET` (HMAC-SHA256, timestamp within five minutes; `400` otherwise), handles `checkout.session.completed` and `customer.subscription.created/updated/deleted/paused/resumed` by re-reading the subscription from Stripe, and answers `200` to other events. `DELETE /me` cancels the account's subscription first and stops if Stripe can't confirm.

## Sous-chef

Conversations live under `/recipe-studio`, need a session, and are visible only to their owner; the flow is described in [sous-chef](RECIPE-STUDIO.md#backend-and-persistence). `GET /recipe-studio` lists the 20 most recently updated. `POST /recipe-studio` takes a UUID `Idempotency-Key` that becomes the conversation's `id`, so a retry returns the same conversation; without an OpenRouter key it is `503`. A conversation has `id`, `recipeId`, `title`, `revision`, `status`, `reply`, `error`, `updatedAt`, `recipe`, `voiceSession`, `busy` (a turn is queued or running) and `assets` (the draft's photo and video jobs). `DELETE /recipe-studio/:id` answers `204`: the conversation's messages, photos and media links are erased at once, its usage stays counted for 35 days, and recipes made in it are kept; it is `409` while a voice call is open or closing. A member keeps up to 200 conversations: at the limit, the oldest ones idle for 30 days are deleted to make room, and `POST /recipe-studio` is `409` only when none are.

`POST /recipe-studio/:id/messages` takes `{ "text", "images" }` (1–24,000 characters; up to four image IDs uploaded to this conversation) and an `Idempotency-Key` of 8–100 characters, and answers `202` with `{ "accepted": true }`. Replaying a key with the same input answers the same; different input is `409`, as is a new message while a turn is queued or running. A used plan allowance or AI budget is `429`; AI paused from the admin console is `503`. Poll `GET /recipe-studio/:id?after=<seq>`: the conversation with its `events` after that `seq` (without `after` it has none), up to 1,000, oldest first, as `{ "seq", "role", "content", "imageCount", "actions", "recipes", "changed", "effects", "failed" }` (`changed`: the reply's turn changed the member's data, so the app should refresh its lists; `effects`: what it did, as receipts `{ "kind", "count", "title", "recipe", "page", "undoable", "undone" }`; `failed`: the turn failed or was stopped, and `content` is the server's own sentence); keep paging while a page is full.

`POST /recipe-studio/:id/undo` takes `{ "seq", "index" }`, a reply event and one of its `effects`, and takes it back as far as it still stands: groceries it added (and quantities it merged), a meal it planned (restoring what the slot held), a pantry item it set, a save or follow (either way), a cookbook it created, a check-off. It answers `{ "effects" }` with the receipt marked `undone`; one without `undoable` is `400`, one already undone `409`, and someone else's `404`. The next turn is told what was taken back.

A conversation's `turn` is the reply on its way, `{ "step", "stopping" }`, where `step` names what it is doing (`looking`, `checking`, `kitchen`, `saving`, `recipe`, `media`, or empty while it thinks). `POST /recipe-studio/:id/cancel` stops it: a queued turn never runs and costs nothing; a running one ends at once on the server running it, otherwise at its next step, keeping what it already did. Either way the reply is "Stopped. Your conversation is saved.", marked `failed`. With nothing running it answers `204`, otherwise `202`.

A conversation's `question` is what the sous-chef waits for a yes to: `{ "kind": "action", "seq", "description" }` for an action it proposed (deleting or publishing a recipe, a review, a report, a profile change, deleting a cookbook or several items), or `{ "kind": "publish", "seq" }` after it read back its draft; otherwise `null`. A message can answer it with a tap: `"answer": "yes" | "no"` and `"question": <seq>` beside its `text`. The server then carries out the action (or publishes the draft), or drops it, before the model replies; a `question` that is no longer waiting is `409`. A turn that fails before reaching the model costs nothing and doesn't count against the plan's sous-chef allowance.

`POST /recipe-studio/:id/images` takes multipart `file` (JPEG, PNG or WebP, up to 10 MB, 20 per conversation and 200 per member) and answers `201` with `{ "id" }`, a private source ID rather than a URL; photos over 1600 pixels are stored as smaller JPEGs, and without S3 storage it is `503`. `PUT /recipe-studio/:id/context` takes `{ "screen", "recipeId", "cookingStep", "timeZone", "language", "purpose" }` (`language` is one of the app's nine codes; the sous-chef answers in it when the reply comes from the server; `purpose` is `recipe` when the app opened the conversation from Create a recipe), drops invalid values, and answers `204`. Conversations carry the `purpose` they were last opened for (`""` otherwise). A voice session's status can be `closing` after its DELETE, which already frees the account's one call. `POST /recipe-studio/:id/voice` exchanges a WebRTC offer `{ "sdp" }` for `201` `{ "id", "sdp", "maxSeconds", "remainingSeconds", "model" }`: one call per account at a time (`409`), up to 30 minutes or the plan's remaining voice time (`429` under 15 seconds; `remainingSeconds` is that time when the call starts, so a call with `remainingSeconds` no more than `maxSeconds` ends with the plan's time instead of renewing), `502` if GPT-Live can't connect, and `503` unless `OPENAI_API_KEY` and `OPENROUTER_API_KEY` are both set. `DELETE /recipe-studio/voice/:session` asks that call to end (`204`). `/capabilities` reports `recipeChat`, `recipePhotos` and `voiceAI`.

## Households

A household shares one grocery list; each member is in at most one. `GET /household` answers `null`, or `{ "id", "name", "role": "owner" | "member", "members": [{ "id", "name", "handle", "avatar", "role" }] }` with the owner first, then by when each joined. `POST /household` takes `{ "name" }` (1–60 characters) and answers `201` with the household, its creator as owner; `POST /household/join` takes `{ "code" }` (any case, spaces and dashes ignored) and answers the household. Both move the member's own grocery list into the household's, and both are `409` for someone already in a household. A wrong, malformed or expired code is `400`, and a household of 20 members is full (`409`). Joining allows 10 tries an hour per member and 30 per address (`429`).

`POST /household/invite` answers `{ "code", "expiresAt" }`: eight characters from A–Z and 2–9, usable by anyone who has it for seven days. Any member can make one; a household keeps its ten newest codes. Codes are stored only as hashes.

`DELETE /household/members/:userId` answers `204`. A member's own id leaves; the owner can remove anyone else (`403` for other members, `404` for someone not in the household). When the owner leaves, the member who joined earliest becomes the owner, and the last one out dissolves the household and keeps its list. A member who leaves starts a list of their own; what they added stays on the household's. Deleting an account follows the same rules.

While someone is in a household, `GET /kitchen`'s `groceries`, every `/groceries` route, `POST /recipes/:id/groceries` and `POST /planner/groceries` work on the household's list: any member can add, check or delete any line, and recipes merge into it. Grocery lines carry `addedBy`: `{ "id", "name" }` of the member who added the line on a household's list, `null` on a personal one.

## Preferences

`GET /me` answers `preferences` with every key filled in: `diets`, `allergies`, `units` (`metric`, `imperial`, or `""` to follow the device), `language` (one of the nine app languages, or `""`), `notifications` (`follows`, `pantry`, `reviews`, `comments`, each `true` until turned off), and `translateRecipes` (`false` until turned on: recipes in other languages open [translated](#recipe-translations)). `PATCH /me/preferences` takes any of `{ "units", "language", "notifications": { "follows", "pantry", "reviews", "comments" }, "translateRecipes" }`, changes only what it is sent, and answers like `GET /me`; a language tag such as `pt-BR` is stored as `pt`. Other values are `400`. `PATCH /me` changes only `diets` and `allergies`, so the profile form keeps the rest.

`language` is also the language of push notifications.

## Push notifications

`PUT /me/push-token` takes `{ "token", "platform": "ios" | "android" }`, where `token` is the device's Expo push token (`ExponentPushToken[…]`), and answers `204`. The token belongs to the session that registered it: signing out, or the session ending or being revoked, stops that device's notifications, and a token registered by another account moves to it. A member keeps their ten most recently registered devices. `DELETE /me/push-token` takes `{ "token" }` and answers `204`.

Notifications go to the author's followers when a recipe is first published, to a recipe's author for a new review or comment (never their own), and to a member whose pantry items expire within two days (once per item, from a daily pass). Their text is in the recipient's `preferences.language`, and their `data` is `{ "type": "recipe", "recipeId" }` or `{ "type": "pantry" }`. Each kind has a switch in `preferences.notifications`. Sending, limits and setup: [push notifications](NOTIFICATIONS.md).

## Analytics

`POST /events` takes `{ "session", "events": [{ "name", "props", "at" }] }` and answers `204`. `session` is a random id the app makes at each launch (1–64 letters, digits, `-` or `_`); up to 50 events per request, 120 requests a minute per address; `at` is optional (ISO 8601; times in the future, or more than a week old, count as now). Names and their properties:

| Name | Props |
| --- | --- |
| `search` | `query` (stored trimmed, lowercase, at most 80 characters), `results` (a count) |
| `recipe_open` | `recipeId`, `from` (optional label) |
| `cook_start`, `share` | `recipeId` |
| `studio_start` | `mode` (label) |
| `onboarding_step` | `step` (label or number) |
| `onboarding_done` | `skipped` (boolean) |
| `import` | `method` (label) |

Labels are 1–40 letters, digits, `.`, `:`, `_` or `-`. Unknown names, unknown properties and malformed events are dropped and the rest stored, so a newer app loses only what the server doesn't know; a missing or invalid `session`, or more than 50 events, is `400`. A signed-in member's events carry their account, guests' don't; no IP address or user agent is stored. Events are deleted after 90 days, or with the account.

`GET /admin/insights?days=7|30` (admins; default 7, anything else `400`) answers `{ "days", "topSearches": [{ "query", "count" }], "zeroResultSearches": [{ "query", "count" }], "onboarding": [{ "step", "count" }], "events": [{ "name", "count" }] }`: the 20 most common searches and searches with no results, how many people (members, or launches for guests) reached each setup step, then `done` and `skipped` from `onboarding_done`, and every event's count. The admin console's Overview shows them.
