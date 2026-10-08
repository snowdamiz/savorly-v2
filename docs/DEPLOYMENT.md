# Deploy Savorly

The Expo app runs on iOS, Android, and web. Use Cloudflare wherever practical: Workers for the exported web app and gateway, R2 for media, Containers for the Go API, and Email Service for transactional email. Do not use Fly.io. Neon remains the production PostgreSQL provider for the existing schema and queries; Cloudflare D1 uses SQLite and would require a separate migration.

**Current implementation:** the Worker serves static assets and proxies to an external `API_ORIGIN`; it does not yet deploy or start the Go container. Password recovery still uses Resend. The [Cloudflare Containers](https://developers.cloudflare.com/containers/) deployment and [Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/) adapter are pending. The commands below deploy the current frontend/gateway only, not the intended complete Cloudflare backend.

Follow the [step-by-step provider setup guide](ACCOUNTS.md) for dashboard actions, credentials, callback URLs, and verification before deployment.

## 1. Database and API

1. Create a Neon Postgres database. Put its TLS-enabled connection URL in `DATABASE_URL` (use `sslmode=require` or stronger certificate verification appropriate to the endpoint). The app's pgx pool is capped at 12 connections.
2. Copy `.env.example` to a private environment file and set `APP_ENV=production`, `SEED_DATA=false`, `ALLOWED_ORIGINS=https://your-app-domain`.
3. Build the Go image for the intended Cloudflare Containers deployment: `docker build --platform linux/amd64 -t savorly-api services/api`. Before deployment, add the Worker/Durable Object container binding, environment secrets, port-8080 readiness checks at `/health`, and routing for HTTP, streamed audio, and WebSockets. Configure lifecycle handling so background jobs finish and queued work resumes after the container sleeps or restarts. These pieces are not present in `infra/cloudflare` yet. No additional hosting account is planned.
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

## 3. Cloudflare web and same-origin gateway

```sh
# At repository root
EXPO_PUBLIC_API_URL=/api npm run build
# Edit API_ORIGIN in infra/cloudflare/wrangler.jsonc to your HTTPS API origin.
wrangler deploy --dry-run --config infra/cloudflare/wrangler.jsonc
wrangler deploy --config infra/cloudflare/wrangler.jsonc
```

Use Wrangler 4.135 or newer. The first command exports the Expo app. The Worker sends `/api/*` to the Go origin and serves other paths from static assets with SPA fallback. This keeps session cookies first-party. Configure the deployed frontend URL in the API's origin allowlist, and attach a custom domain in Cloudflare if desired.

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

Set `OPENROUTER_API_KEY`, `REAPI_API_KEY`, and the task-specific model variables from `.env.example`. Full-duplex voice additionally requires `OPENAI_API_KEY`, `OPENAI_LIVE_MODEL=gpt-live-1`, and a project with GPT-Live access; `OPENROUTER_AGENT_MODEL` configures its backend tool/vision agent. Cooking narration also uses `OPENROUTER_API_KEY`, with optional `OPENROUTER_TTS_VOICE` (default `sarah`); no ElevenLabs account is required. Set provider-side hard spending limits before making keys available. Plans set per-member allowances and spend ceilings; tune `AI_FREE_DAILY_BUDGET_USD` and `AI_DAILY_BUDGET_USD` (see [pricing](PRICING.md)). Configure Stripe and the sign-in providers from [pricing](PRICING.md) and [sign-in](SIGN-IN.md). Drain pending AI jobs and restart the API after changing models. Check `/v1/capabilities` for the active model IDs. See [provider decisions](PROVIDERS.md).

For the intended password-recovery setup, onboard a domain in Cloudflare Email Service and use a scoped token with Email Sending: Edit for a REST adapter. That adapter is not implemented yet: the current code requires Resend's `RESEND_API_KEY` and `EMAIL_FROM`. Hold off on creating a Resend account if proceeding with the Cloudflare migration. The default local environment intentionally has no paid/external integrations enabled.

## Operational limits to address before a public launch

- Report submission is implemented; moderation review currently happens through the `reports` table. Establish an operator workflow and policy. There is no dedicated moderator dashboard yet.
- Rate limiting is in-process; use Cloudflare rate-limit rules for a shared multi-replica ingress limit. Do not blindly trust a forwarded IP header on a publicly reachable origin.
- Auth supports password accounts, recovery, and Apple/Google sign-in. There is no separate signup email-verification flow; production recovery needs email configuration, and the Cloudflare email adapter remains pending.
- Media is limited to 50 MB direct MP4/WebM; adaptive video transcoding/Cloudflare Stream, captions, and long-form video processing are not implemented.
- R2 cleanup, production alert delivery, legal documents, billing/subscriptions, app-store signing, and a live provider generation smoke test require launch configuration or further product work.
- Sample recipes, fictional creator accounts, approximate nutrition, Unsplash images, and placeholder avatars are development fixtures; they are not a real live community.
