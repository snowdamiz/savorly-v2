# Deploy Savorly

The Expo app runs on iOS, Android, and web. Use Cloudflare wherever practical: Workers for the exported web app and gateway, R2 for media, Containers for the Go API, and Email Service for transactional email. Do not use Fly.io. Neon remains the production PostgreSQL provider for the existing schema and queries; Cloudflare D1 uses SQLite and would require a separate migration.

**Current implementation:** the Worker serves static assets and runs the Go API as a [Cloudflare Container](https://developers.cloudflare.com/containers/) behind `/api`, passing Worker vars and secrets to it as its environment. CI deploys the `staging` branch to [staging](STAGING.md) and the `release` branch to [production](PRODUCTION.md). Password-reset email goes through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/).

Follow the [step-by-step provider setup guide](ACCOUNTS.md) for dashboard actions, credentials, callback URLs, and verification before deployment.

## 1. Database and API

1. Create a Neon Postgres database. Put its TLS-enabled connection URL in `DATABASE_URL` (use `sslmode=require` or stronger certificate verification appropriate to the endpoint). The app's pgx pool is capped at 12 connections.
2. Copy `.env.example` to a private environment file and set `APP_ENV=production`, `SEED_DATA=false`, `ALLOWED_ORIGINS=https://savorly.cooking`.
3. `wrangler deploy` builds `services/api/Dockerfile` for `linux/amd64` (Docker must be running) and runs it as the `SavorlyApi` container: a single instance ([capacity](#capacity)), port 8080, sleeping after 30 idle minutes ([cold starts](#cold-starts)). The image is distroless and has a `HEALTHCHECK` that runs `server -healthcheck` (GET `/health`, which also pings the database) for Docker and Compose; Cloudflare starts and routes to the container by itself. Upload backend settings as Worker secrets (`wrangler secret put`, or `--secrets-file` as `scripts/deploy.sh` does); non-secret settings are `vars` in `infra/cloudflare/wrangler.jsonc`, and a secret can't share a var's name. Uploaded secrets stay until deleted: no deploy removes one, and neither does deleting its line from `.env.<environment>`; `npx wrangler secret delete NAME [--env staging]` in `infra/cloudflare` is the only way ([runbooks](RUNBOOKS.md#rotate-or-remove-a-secret)). Queued AI jobs interrupted when the container sleeps or restarts are marked failed by the recovery loop; video polling resumes on the next start. Requests that arrive while the container is starting wait up to 25 seconds for it; after that, and for any platform error, the Worker answers JSON 503 (`"starting": true` when the request never reached the API), and the app retries reads and unsent requests for up to two minutes, so starts and deploys show as loading rather than errors.
4. **Visitor addresses and rate limits.** The API limits requests per visitor address (300 a minute overall; 15 per 15 minutes shared by sign-up, sign-in, password reset and Apple/Google sign-in). Behind a proxy every request arrives from the proxy, so `TRUSTED_PROXY_HEADER` names a header that carries the visitor's address instead. On Cloudflare it is `X-Savorly-Client-IP`, a var in `wrangler.jsonc`: the Worker sets it from `CF-Connecting-IP` on every request, overwriting whatever the client sent, and the container has no public address, so nothing reaches the API around the Worker. Self-hosting behind another proxy, set it to a header that proxy always overwrites with a single address (nginx: `proxy_set_header X-Real-IP $remote_addr;` with `TRUSTED_PROXY_HEADER=X-Real-IP`), never one it appends to such as `X-Forwarded-For`, and only if clients can't reach the API except through the proxy, or they could choose their own address. Left empty, as in local development, the API uses the connecting address; behind a proxy that puts every visitor under one shared limit.
5. The API applies embedded, ordered, forward-only SQL migrations at startup inside an advisory-locked transaction. Migration names are recorded in `schema_migrations`. Add a new numbered SQL file for every schema change; do not edit applied migrations.
6. Backups are Neon's point-in-time restore; rehearse it with the [restore runbook](RUNBOOKS.md#restore-the-database). Do not enable fixture seeding on a public production database. Review and rotate credentials outside source control ([rotating secrets](RUNBOOKS.md#rotate-or-remove-a-secret)).

## 2. Cloudflare R2

Create a public media bucket and a separate private source-import bucket in the same jurisdiction. Give the server token object read/write access to both. Configure:

- `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_SOURCE_BUCKET`
- `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`
- `S3_PUBLIC_URL=https://<your-media-custom-domain>`

The app uploads straight to R2 with URLs the API signs, then confirms each file with the API, which checks its size and actual bytes; older app versions still post through the API. Uploads are capped at 50 MB. Allowed formats are JPEG, PNG, WebP, MP4, and WebM; SVG/HTML are rejected. The API uses random per-user object keys. R2 objects are public recipe media. Local development uses SeaweedFS through the same S3 adapter; no filesystem fallback is enabled in either environment. See [storage setup, CORS, and local persistence](STORAGE.md).

Account deletion deletes database records immediately. Uploaded files leave R2 about a day after nothing uses them any more (a replaced photo, a deleted recipe or account), and files that were uploaded but never used two weeks after upload; the API's janitor checks again before each deletion (`media_cleanup.go`).

## 3. Cloudflare web, gateway and API

```sh
# At repository root; uploads the secrets from .env.<environment> too
npm run deploy:staging            # or deploy:production (scripts/deploy.sh)
# By hand
EXPO_PUBLIC_API_URL=/api npm run build
cd infra/cloudflare && npm ci
npx wrangler deploy --dry-run
npx wrangler deploy --env=""      # production on savorly.cooking
```

Use Wrangler 4.151 or newer and a Workers Paid plan (Containers). `npm run build` exports the Expo app, then `scripts/web-postbuild.mjs` adds font preloads to its `index.html` and, with `EXPO_PUBLIC_MEDIA_ORIGIN` set, a preconnect to the media origin. `deploy.sh` sets that origin and exports with `--clear`: Metro otherwise reuses cached transforms that have an earlier build's `EXPO_PUBLIC_*` values inlined, so a local build for `localhost` could end up deployed. The Worker sends `/api/*` to the API container and serves other paths from static assets with SPA fallback, plus the pages in [web pages and app links](#web-pages-and-app-links). This keeps session cookies first-party. Each environment's custom domain is a `routes` entry in `wrangler.jsonc` (`savorly.cooking`, `staging.savorly.cooking`); list the same origin in the API's `ALLOWED_ORIGINS`.

`EXPO_PUBLIC_*` values are public build-time values. Never put provider, R2, database, or email secrets in Expo environment variables.

## 4. Native mobile

Set `EXPO_PUBLIC_API_URL` to the public HTTPS API origin (without `/v1`) in the EAS environment. Native clients store bearer sessions in Expo SecureStore. The browser uses HttpOnly cookies and does not store its session token in local storage.

```sh
cd apps/mobile
npx eas-cli login
npx eas-cli build:configure
npx eas-cli build --profile preview --platform android
npx eas-cli build --profile production --platform all
```

Supply your own Expo account, bundle identifier, store accounts, signing credentials, screenshots, privacy policy, support address, and store metadata. Default bundle identifiers are `app.savorly.mobile`; change these before the first store upload. Native source exports are not equivalent to a signed device build.

For a physical device on your local network, set `EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:8080`. Production media requires HTTPS. Local uploaded URLs are restricted to localhost by validation, so use an HTTPS development tunnel for physical-device media publishing and set `S3_PUBLIC_URL` to that object-store tunnel plus the bucket path (see [storage setup](STORAGE.md)).

## 5. AI and recovery

Set `OPENROUTER_API_KEY`, `REAPI_API_KEY`, and the task-specific model variables from `.env.example`. Full-duplex voice additionally requires `OPENAI_API_KEY`, `OPENAI_LIVE_MODEL=gpt-live-1`, and a project with GPT-Live access; `OPENROUTER_AGENT_MODEL` configures its backend tool/vision agent. Cooking narration also uses `OPENROUTER_API_KEY`, with optional `OPENROUTER_TTS_VOICE` (default `sarah`); no ElevenLabs account is required. Set provider-side hard spending limits before making keys available. Plans set per-member allowances and spend ceilings; tune `AI_FREE_DAILY_BUDGET_USD` and `AI_DAILY_BUDGET_USD` (see [pricing](PRICING.md)). Configure the sign-in providers from [sign-in](SIGN-IN.md). Paid plans stay off, with unlimited Free for everyone, until `PAID_PLANS=true` and Stripe is configured ([pricing](PRICING.md)). Drain pending AI jobs and restart the API after changing models. Check `/v1/capabilities` for the active model IDs. See [provider decisions](PROVIDERS.md).

For password recovery, onboard the sending domain in Cloudflare Email Service and set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN` (Email Sending: Edit) and `EMAIL_FROM` ([accounts](ACCOUNTS.md#password-reset-email)). The default local environment intentionally has no paid/external integrations enabled.

## Capacity

`getContainer(env.API)` always addresses the same named Durable Object, and each Durable Object runs one container, so the whole API is one container instance. `max_instances: 2` in `wrangler.jsonc` only caps how many instances may run at once; with one named instance the second is headroom, not capacity. Running several would mean spreading requests over named instances, after moving what lives in one process today: the rate limits, same-replica narration streaming and the job worker's assumptions.

Instance types (Wrangler 4.151): `lite` (1/16 vCPU, 256 MiB), **`basic`** (1/4 vCPU, 1 GiB, 4 GB disk; used now), `standard-1` (1/2 vCPU, 4 GiB), `standard-2` (1 vCPU, 6 GiB), `standard-3` (2 vCPU, 8 GiB) and `standard-4` (4 vCPU, 12 GiB). Containers are billed for the time they run, by vCPU, memory and disk ([pricing](https://developers.cloudflare.com/containers/pricing/)), so a bigger type costs more for every hour the container is awake.

What runs out first on `basic`:

- **Password hashing.** bcrypt at cost 12 runs on every sign-up, sign-in, password reset and password-confirmed deletion. In a local container limited like `basic` (`docker run --cpus 0.25 --memory 1g`), one took about 0.7 s on its own and 5–7 s each with five at once: roughly 1.4 a second for the whole service. A launch-day burst of sign-ups queues behind it, and the app gives up on a request after 30 s.
- **Memory.** The app now uploads photos and videos straight to R2 with presigned URLs, so they no longer pass through the API; the older multipart route streams large files from a temporary file. Touch-ups still read photos of up to 20 MB, sous-chef photos are decoded to be downscaled, and narration buffers audio of up to 8 MiB, all within 1 GiB.
- Everything else shares the same quarter of a CPU with the job and sous-chef worker loops.

Before a public launch, load-test sign-ups and uploads, and move to `standard-1` (twice the CPU, four times the memory) if they don't hold up. Longer term, revisit the password hash. bcrypt at cost 12 stays a sound choice for security, so this is only about CPU: argon2id with tuned parameters can be cheaper per sign-in at the same strength, but it needs memory per hash (which `basic` is short of) and a migration that rehashes each password at its next sign-in; a cost of 11 halves the work but weakens every hash. Neither is worth doing before the load test shows sign-ins are the bottleneck.

`scripts/loadtest.mjs` registers throwaway accounts, signs them in, lists recipes and optionally uploads a photo, a given number at a time; then it deletes the accounts and prints p50/p95/p99 latency and errors for each step. It creates real accounts, so it refuses `savorly.cooking` and needs `--yes` for any host that isn't local; uploaded files stay in the bucket.

```sh
# The API image sized like basic, trusting a per-user address header so the auth limit doesn't refuse most users
docker build -t savorly-api services/api
docker run --rm --cpus 0.25 --memory 1g -p 127.0.0.1:8090:8080 -e TRUSTED_PROXY_HEADER=X-Savorly-Client-IP \
  -e DATABASE_URL='postgres://savorly:savorly_local_only@host.docker.internal:54329/savorly?sslmode=disable' savorly-api
node scripts/loadtest.mjs --base http://localhost:8090 --users 20 --concurrency 5 --client-ip-header X-Savorly-Client-IP
# Staging, through Cloudflare: the auth limit applies to your address (15 per 15 minutes), so expect 429s past that
node scripts/loadtest.mjs --base https://staging.savorly.cooking/api --users 10 --concurrency 2 --yes
```

`--upload` adds a photo upload per user; the local container then also needs the `S3_*` settings from `.env.example`, with `host.docker.internal` in `S3_ENDPOINT`.

## Cold starts

The container sleeps after 30 idle minutes, and the next request waits for it to start (up to 25 seconds in the Worker, then the app keeps retrying). To spare daytime visitors that wait, the Worker's `scheduled()` handler requests `/health` from the container every 10 minutes from 07:00 to 22:50 UTC (`triggers.crons` in `wrangler.jsonc`, in both environments). That starts it if needed and keeps it awake until about 23:20 UTC; overnight it sleeps as before.

A running container keeps the secrets and vars it started with, and a deploy that doesn't change the API image leaves it running. So the warm-up also compares the current settings with a hash of those the container started with, and when they differ it stops the API (requests in flight get 10 seconds) and starts it again: new secrets and vars take effect within about 10 minutes during those hours, and otherwise when it next starts after 30 idle minutes. Settings only the Worker reads (`MOBILE_APP_ID`, `ANDROID_CERT_SHA256`, `CF_ANALYTICS_TOKEN`) aren't passed to the API and don't restart it; the log line is `restarting the API for changed settings`.

The trade-off is cost. The container then runs at least those 16 hours every day in each environment, where before it ran only while visited. `/health` pings the database, and while the container is awake its job loops still look for work every 30 seconds when idle (they back off from every second or two, and enqueued work wakes them at once), and the recovery sweeps run every minute, so the Neon compute stays awake for those hours too (Neon bills compute hours, and a free plan's allowance can run out). To spend less, turn staging's schedule off (`"crons": []` under `env.staging`; without an entry it inherits production's), shorten the window, or ping less often: anything under 30 minutes keeps it awake, and 10 leaves room for a missed run. Failed pings appear in Workers Logs as `warm-up ping failed`.

## Deploys and live sessions

`scripts/deploy.sh` deploys with `--containers-rollout gradual`, Wrangler's default, instead of `immediate`. A gradual rollout replaces instances in steps (`[10, 100]` percent here), so with several instances only some restart at a time. Savorly has one, and a step always covers at least one instance, so each deploy still replaces the API in one go: narration streams and live voice calls on it are cut (cooking falls back to device speech; a voice call has to be started again), and requests in between wait for the new container or get the Worker's 503, which the app retries.

How long a running request can finish is set by the old container's shutdown, not by the rollout mode: Cloudflare sends `SIGTERM` and waits up to 15 minutes before `SIGKILL`, and the API stops taking requests and gives those in flight 10 seconds (`cmd/server/main.go`). The new container starts only once the old one has exited, so a longer drain would also mean a longer gap for everyone else. `rollout_active_grace_period` doesn't help: it only spares instances that started recently. Deploy production outside busy cooking hours.

## Web pages and app links

Besides the app and `/api`, the Worker (`infra/cloudflare/worker.ts`; its helpers are in `site.ts`, tested by `npm test` there) answers:

| Path                                                                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/recipes/<id>`, and `/?recipe=<id>` from older links                     | The app, with the recipe's title, description, canonical link, Open Graph and Twitter card tags and a schema.org `Recipe` in JSON-LD, for search engines and link previews. The data comes from `GET /v1/recipes/:id` through the container, anonymously (published recipes only), cached for 5 minutes per Cloudflare location. The page waits at most 4 seconds for it, and otherwise, or for a missing recipe, is the plain app. Older links aren't redirected. |
| `/cookbooks/<id>`                                                         | The app, with a public cookbook's name, description, cook and first photo in the title, description, canonical link and preview tags, from `GET /v1/cookbooks/:id` in the same way. A private or missing cookbook is the plain app.                                                                                                                                                                                                                                |
| `/robots.txt`                                                             | Production: everything allowed, with the sitemap. Where `NOINDEX=true` (staging): nothing but `/.well-known/`.                                                                                                                                                                                                                                                                                                                                                     |
| `/sitemap.xml`                                                            | The home page, every published recipe and every public cookbook with its last change, from `GET /v1/sitemap`, cached for an hour. If the API fails it answers 503 with `Retry-After` rather than an empty sitemap. One file holds up to 50,000 URLs; creators join once they have pages of their own.                                                                                                                                                              |
| `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` | App links for the iOS and Android apps ([production](PRODUCTION.md#app-links), [staging](STAGING.md#app-links)); 404 until configured.                                                                                                                                                                                                                                                                                                                             |
| `/csp-report`                                                             | Where browsers report Content-Security-Policy violations. Each becomes one Workers Logs line, `{"message":"csp violation","directive":…,"blocked":…,"document":…}`.                                                                                                                                                                                                                                                                                                |
| `/privacy`, `/terms`, `/account-deletion`                                 | Static pages from `apps/mobile/public` (legal review pending), like `manifest.json`, the icons and `og-image.png`.                                                                                                                                                                                                                                                                                                                                                 |

Every response gets the security headers. HTML responses also get a `Content-Security-Policy-Report-Only` header built from what the app loads (the sources and why are in `contentSecurityPolicy` in `site.ts`), so nothing is blocked yet. Before enforcing it, watch Workers Logs for `csp violation` for a few weeks, staging first; allow what is legitimate, then rename the header in `worker.ts`. `img-src` still allows any `https:` image because older recipes and avatars can point at other sites; narrow it once media is limited to `S3_PUBLIC_URL`. Content-hashed bundles and assets (`/_expo/static/…`, `/assets/…`) are cached for a year, which also lets the browser reuse the preloaded fonts. A file missing from those paths is a `404`, not the app: a tab opened before a deploy then fails to load a screen's chunk cleanly and reloads onto the new version (`chunk()` in `apps/mobile/src/lib/chunk.ts`).

Every route loads `apps/mobile/public/index.html`, Expo's template with a description, theme colour, manifest, icons and default preview tags. Files in `apps/mobile/public` are copied into the export; `npm run brand -- --web` regenerates the icons and the preview image.

**Web analytics.** Cloudflare Web Analytics is cookieless and off by default. To turn it on for an environment: Cloudflare dashboard → Analytics & Logs → Web Analytics → Add a site, enter the hostname, choose the manual JavaScript snippet, and put the token from that snippet in `CF_ANALYTICS_TOKEN` in the environment's `vars` in `wrangler.jsonc`, then deploy. The Worker adds the beacon to every page, and the CSP allows it. Don't also turn on automatic setup for the site, or visits count twice. The privacy policy already mentions it.

## Operational limits to address before a public launch

- Reports are reviewed in the [admin console](ADMIN.md), which also suspends members and can pause AI or sign-ups. Make sure each owner in `ADMIN_EMAILS` has a verified email, and write a moderation policy for admins to apply.
- Rate limiting is in-process; use Cloudflare rate-limit rules for a shared multi-replica ingress limit. Do not blindly trust a forwarded IP header on a publicly reachable origin.
- Auth supports password accounts, recovery, Apple/Google sign-in, and email confirmation: a new kitchen gets a code to confirm its address (sign-up never waits on it) and sees a reminder until it does. Recovery, confirmation and the notification emails need a domain onboarded in Cloudflare Email Service.
- Media is limited to 50 MB direct MP4/WebM; adaptive video transcoding/Cloudflare Stream, captions, and long-form video processing are not implemented.
- Media nothing uses leaves R2 on its own: about a day after it stops being used, or two weeks after an upload that never was ([storage](STORAGE.md#when-uploaded-files-are-deleted)). The API logs every request with its id, and the app reports its JavaScript errors there as `client error` lines ([API](API.md)), but nothing alerts on them yet: set up alerts on those lines and on 5xx responses before launch. Stripe billing, app-store signing and a live provider generation smoke test also need launch configuration. Crashes in native code, outside JavaScript, need a crash-reporting service (Sentry supports Expo and Workers), which isn't set up. The privacy policy, terms and account-deletion pages exist but need legal review ([production](PRODUCTION.md#before-a-public-launch)).
- One `basic` container serves everything: read [capacity](#capacity) and load-test before launch.
- Sample recipes, fictional creator accounts, approximate nutrition, Unsplash images, and placeholder avatars are development fixtures; they are not a real live community.
