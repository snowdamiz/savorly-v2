# Deploy Savorly

The Expo app runs on iOS, Android, and web. Use Cloudflare wherever practical: Workers for the exported web app and gateway, R2 for media, Containers for the Go API, and Email Service for transactional email. Do not use Fly.io. Neon remains the production PostgreSQL provider for the existing schema and queries; Cloudflare D1 uses SQLite and would require a separate migration.

**Current implementation:** the Worker serves static assets and runs the Go API as a [Cloudflare Container](https://developers.cloudflare.com/containers/) behind `/api`, passing Worker vars and secrets to it as its environment. CI deploys `main` to [staging](STAGING.md) and the `release` branch to [production](PRODUCTION.md). Password-reset email goes through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/).

Follow the [step-by-step provider setup guide](ACCOUNTS.md) for dashboard actions, credentials, callback URLs, and verification before deployment.

## 1. Database and API

1. Create a Neon Postgres database. Put its TLS-enabled connection URL in `DATABASE_URL` (use `sslmode=require` or stronger certificate verification appropriate to the endpoint). The app's pgx pool is capped at 12 connections.
2. Copy `.env.example` to a private environment file and set `APP_ENV=production`, `SEED_DATA=false`, `ALLOWED_ORIGINS=https://savorly.cooking`.
3. `wrangler deploy` builds `services/api/Dockerfile` for `linux/amd64` (Docker must be running) and runs it as the `SavorlyApi` container: one instance, port 8080, sleeping after 30 idle minutes. Upload backend settings as Worker secrets (`wrangler secret put`, or `--secrets-file` as `scripts/deploy.sh` does); non-secret settings are `vars` in `infra/cloudflare/wrangler.jsonc`. The Worker sets `X-Savorly-Client-IP` from `CF-Connecting-IP` and the API trusts it through `TRUSTED_PROXY_HEADER`, so rate limits apply per visitor. Queued AI jobs interrupted when the container sleeps or restarts are marked failed by the recovery loop; video polling resumes on the next start.
4. The API applies embedded, ordered, forward-only SQL migrations at startup inside an advisory-locked transaction. Migration names are recorded in `schema_migrations`. Add a new numbered SQL file for every schema change; do not edit applied migrations.
5. Schedule backups / point-in-time recovery through Neon. Do not enable fixture seeding on a public production database. Review and rotate credentials outside source control.

## 2. Cloudflare R2

Create a public media bucket and a separate private source-import bucket in the same jurisdiction. Give the server token object read/write access to both. Configure:

- `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_SOURCE_BUCKET`
- `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`
- `S3_PUBLIC_URL=https://<your-media-custom-domain>`

Uploads pass through the authenticated API, are capped at 50 MB, and are identified by actual file bytes. Allowed formats are JPEG, PNG, WebP, MP4, and WebM; SVG/HTML are rejected. The API uses random per-user object keys. R2 objects are public recipe media. Local development uses SeaweedFS through the same S3 adapter; no filesystem fallback is enabled in either environment. See [storage setup, CORS, and local persistence](STORAGE.md).

Account deletion deletes database records immediately. Object lifecycle cleanup is a separate operational task: configure a retention policy and run an orphan-object cleanup process before public launch if your deletion policy promises immediate removal of uploaded bytes. The current app does not purge previously uploaded R2 objects on account deletion.

## 3. Cloudflare web, gateway and API

```sh
# At repository root
EXPO_PUBLIC_API_URL=/api npm run build
cd infra/cloudflare && npm ci
npx wrangler deploy --dry-run
npx wrangler deploy --env=""      # production on savorly.cooking; or npm run deploy:production|staging from the root
```

Use Wrangler 4.151 or newer and a Workers Paid plan (Containers). The first command exports the Expo app. The Worker sends `/api/*` to the API container and serves other paths from static assets with SPA fallback. This keeps session cookies first-party. Each environment's custom domain is a `routes` entry in `wrangler.jsonc` (`savorly.cooking`, `staging.savorly.cooking`); list the same origin in the API's `ALLOWED_ORIGINS`.

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

## Operational limits to address before a public launch

- Report submission is implemented; moderation review currently happens through the `reports` table. Establish an operator workflow and policy. There is no dedicated moderator dashboard yet.
- Rate limiting is in-process; use Cloudflare rate-limit rules for a shared multi-replica ingress limit. Do not blindly trust a forwarded IP header on a publicly reachable origin.
- Auth supports password accounts, recovery, and Apple/Google sign-in. There is no separate signup email-verification flow; production recovery needs a domain onboarded in Cloudflare Email Service.
- Media is limited to 50 MB direct MP4/WebM; adaptive video transcoding/Cloudflare Stream, captions, and long-form video processing are not implemented.
- R2 cleanup, production alert delivery, legal documents, billing/subscriptions, app-store signing, and a live provider generation smoke test require launch configuration or further product work.
- Sample recipes, fictional creator accounts, approximate nutrition, Unsplash images, and placeholder avatars are development fixtures; they are not a real live community.
