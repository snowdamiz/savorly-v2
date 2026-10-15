# API conventions

Base path: `/v1`. Request/response bodies are JSON, except multipart uploads and successful `204` deletions. Errors have `{ "error": "A readable message" }`. Health is `GET /health`.

The browser authenticates with an HttpOnly session cookie and `credentials: include`. Native clients send `Authorization: Bearer <session-token>`. Tokens are returned by login/registration only for requests without an Origin header; browser code never receives them. Cookie mutations must have an allowed Origin header. All private lists and mutations are scoped to the authenticated account.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/forgot`, `/auth/reset` |
| Account | `GET /me`, `PATCH /me`, `DELETE /me` (requires current password) |
| Recipes | `GET /recipes`, `GET /recipes/:id`, `POST /recipes`, `PUT /recipes/:id`, `DELETE /recipes/:id` |
| Reviews and reports | `GET /recipes/:id/reviews`, `PUT /recipes/:id/review`, `POST /recipes/:id/report` |
| Creators | `GET /creators`, `GET /creators/:id`, `PUT` or `DELETE /creators/:id/follow` |
| Cookbooks | `GET /library`, `POST /collections`, `DELETE /collections/:id`, `PUT` or `DELETE /recipes/:id/save` |
| Kitchen | `GET /kitchen`, `POST /planner`, `DELETE /planner/:id`, `POST /pantry`, `DELETE /pantry/:id` |
| Groceries | `POST /groceries`, `PATCH /groceries/:id`, `DELETE /groceries/:id`, `POST /recipes/:id/groceries` |
| Media | `POST /media` with multipart field `file` |
| AI | `GET /capabilities`, `GET /ai/jobs`, `POST /ai/jobs` |
| Admin | `/admin/*` for admins only; see [admin console](ADMIN.md#api) |

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

Poll `GET /ai/jobs` for the current account's latest 30 jobs. Status progresses from `queued` to `running`, optionally `processing` for video, and then `completed` or `failed`. Results contain `recipe`, `text`, or `url`. Generated recipes are editable private drafts; generation never publishes on the user's behalf.
