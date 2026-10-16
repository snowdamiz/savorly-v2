# API conventions

Base path: `/v1`. Request/response bodies are JSON, except multipart uploads and successful `204` deletions. Errors have `{ "error": "A readable message" }`. Health is `GET /health`.

The browser authenticates with an HttpOnly session cookie and `credentials: include`. Native clients send `Authorization: Bearer <session-token>`. Tokens are returned by login/registration only for requests without an Origin header; browser code never receives them. Cookie mutations must have an allowed Origin header. All private lists and mutations are scoped to the authenticated account.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/forgot`, `/auth/reset` |
| Account | `GET /me`, `PATCH /me`, `DELETE /me` (requires current password), `POST /me/onboarded`, `GET /handles/:handle` |
| Recipes | `GET /recipes`, `GET /recipes/:id`, `POST /recipes`, `PUT /recipes/:id`, `DELETE /recipes/:id` |
| Reviews and reports | `GET /recipes/:id/reviews`, `PUT /recipes/:id/review`, `POST /recipes/:id/report` |
| Creators | `GET /creators`, `GET /creators/:id`, `PUT` or `DELETE /creators/:id/follow` |
| Cookbooks | `GET /library`, `POST /collections`, `DELETE /collections/:id`, `PUT` or `DELETE /recipes/:id/save` |
| Kitchen | `GET /kitchen`, `POST /planner`, `DELETE /planner/:id`, `POST /pantry`, `DELETE /pantry/:id` |
| Groceries | `POST /groceries`, `PATCH /groceries/:id`, `DELETE /groceries/:id`, `POST /recipes/:id/groceries` |
| Media | `POST /media` with multipart field `file`, `POST /media/touch-up` |
| AI | `GET /capabilities`, `GET /ai/jobs`, `GET /ai/jobs/:id`, `POST /ai/jobs` |
| Admin | `/admin/*` for admins only; see [admin console](ADMIN.md#api) |

## Usernames

A handle is 3–24 lowercase letters, digits, dots or underscores that starts and ends with a letter or digit, with no two dots in a row; a few names that would read as Savorly itself are reserved. New kitchens get one from their name (`alexrivera`, or `alexrivera42` when that's taken), and registration and a first Apple or Google sign-in answer `"created": true` so the app can offer to change it straight away.

`PATCH /me` takes an optional `handle` (a leading `@` and capitals are normalized). Left out or unchanged, the current handle stays, including older generated ones the rules above would reject. An invalid handle is `400`, a taken or reserved one `409`. `GET /handles/:handle` answers `{ "handle", "valid", "available" }` while someone types; their own handle counts as available.

## Kitchen setup

`GET /me` includes `onboarded`: `false` for a new kitchen until it finishes or skips its setup (photo, name and username, food preferences, cooks to follow, meeting the sous-chef), which the app shows on every platform and resumes after a restart. `POST /me/onboarded` marks it done and answers like `GET /me`. Kitchens from before the setup existed count as set up. A first Google sign-in starts the profile photo from the Google account's picture.

## Discovery

`GET /recipes?q=lemon&category=Italian&tag=Vegetarian&maxMinutes=30&sort=Quickest&limit=24&offset=0`

Parameters are optional. `limit` is bounded to 60; pagination uses `offset`. The supported sort labels are `For you` (newest), `Quickest`, and `Top rated`. A tag or cuisine must match a stored label. Public search never returns drafts. Recipe detail returns a draft only to its author.

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

Media is optional. Use a direct HTTPS image or video URL, or the URL returned by `/media`. The local development API also accepts localhost HTTP media. Ingredients and steps remain required even when a video is attached so the recipe can be searched, scaled, planned, and cooked accessibly.

## AI jobs

`POST /ai/jobs` takes `{ "kind": "recipe", "prompt": "Make a quick vegetarian dinner with chickpeas" }` and an `Idempotency-Key` header between 8 and 100 characters. A new request returns `202` and a job object; retrying the same payload with the same key returns the same job. Reusing a key for different input returns `409`. Unconfigured providers return `503`; exceeded quotas return `429`.

Kinds: `recipe`, `adapt`, `substitute`, `nutrition`, `plan`, `assistant`, `image`, `video`.

Poll `GET /ai/jobs` for the current account's latest 30 jobs, or `GET /ai/jobs/:id` for one. Status progresses from `queued` to `running`, optionally `processing` for video, and then `completed` or `failed`. Results contain `recipe`, `text`, or `url`. Generated recipes are editable private drafts; generation never publishes on the user's behalf.

`POST /media/touch-up` takes `{ "url", "kind": "avatar" | "dish" }` and an `Idempotency-Key`, and queues an AI retouch of a photo the member already has: one they uploaded or generated, or the profile photo they use now (such as their Google picture). It answers `202` with an `image` job whose `source` is that photo; the result's `url` is a new photo, and the original is left as it is. The image model gets the photo as a reference and is told to keep the subject exactly as it is while improving light, color and focus. It counts as an AI photo for plan allowances and reserves the same budget. Anything else is `400`.
