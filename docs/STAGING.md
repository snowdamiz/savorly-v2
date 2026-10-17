# Staging

Staging is a full copy of Savorly for testing on real devices, at [staging.savorly.cooking](https://staging.savorly.cooking):

| Piece                                     | Where                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app, `/api` gateway, Go API container | Cloudflare Worker `savorly-staging` on `staging.savorly.cooking`, `env.staging` in [wrangler.jsonc](../infra/cloudflare/wrangler.jsonc)                                       |
| Database                                  | Neon project `savorly-staging` (fixture recipes are seeded on startup)                                                                                                        |
| Media                                     | R2 buckets `savorly-staging-media` (public via r2.dev, CORS for the staging site) and `savorly-staging-sources` (private)                                                     |
| Email                                     | Cloudflare Email Service on `savorly.cooking`, sending as `noreply@savorly.cooking`                                                                                           |
| Android app                               | EAS profile `staging`: "Savorly Staging", package `app.savorly.mobile.staging`, installs beside production; updates over the air on channel `staging` ([updates](UPDATES.md)) |

Every push to the `staging` branch that passes verification redeploys the backend, then ships the Android app ([ci.yml](../.github/workflows/ci.yml)): JavaScript-only changes reach installed staging apps as an over-the-air update, and native changes queue a new build ([updates](UPDATES.md)). To put what is on `main` on staging:

```sh
git push origin main:staging
```

Pushes to `main` only run verification. [Production](PRODUCTION.md) deploys from the `release` branch.

## One-time setup

1. **Log in** on your machine: `wrangler login`, `eas login`, `neonctl auth`. Docker must be running for deploys.
2. **Cloudflare dashboard:** subscribe to Workers Paid (Containers and Email Sending require it) and activate R2 under **Storage & databases → R2**. `savorly.cooking` is registered with Cloudflare, so its DNS is already there.
3. **R2 buckets** (done for this account):
   ```sh
   cd infra/cloudflare
   npx wrangler r2 bucket create savorly-staging-media
   npx wrangler r2 bucket create savorly-staging-sources
   npx wrangler r2 bucket dev-url enable savorly-staging-media
   npx wrangler r2 bucket cors set savorly-staging-media --file <rules>.json
   ```
   The `pub-….r2.dev` URL is `S3_PUBLIC_URL`. CORS allows `GET`, `HEAD` and the direct-upload `PUT` from `https://staging.savorly.cooking`, with the `Content-Type`, `Cache-Control` and `Range` headers, exposing `ETag`, `Content-Length`, `Content-Range` and `Accept-Ranges` ([storage](STORAGE.md)); `wrangler r2 bucket cors list savorly-staging-media` shows it. Keep the sources bucket private.
4. **R2 credentials:** R2 → **Manage API tokens** → Create → **Object Read & Write** on both staging buckets. Copy the Access Key ID, Secret Access Key (shown once) and the account's S3 endpoint.
5. **Email:** `wrangler email sending enable savorly.cooking` (done). It creates Cloudflare-managed (locked) DNS records: MX, SPF and DKIM on `cf-bounce`, DMARC on `_dmarc`. Create a token under **My Profile → API Tokens** with **Account → Email Sending: Edit** for `CLOUDFLARE_EMAIL_API_TOKEN`; the API sends through the REST API, so the dashboard's Workers binding and SMTP options aren't needed.
6. **Database:** create Neon project `savorly-staging` (PostgreSQL 17) and copy its direct (non-pooled) connection string. The API applies migrations at startup.
7. **Secrets:** `cp .env.staging.example .env.staging` and fill in the required section. Optional keys can be added later.
8. **Deploy:** `npm run deploy:staging`. Wrangler attaches `staging.savorly.cooking` and creates its certificate. The first container start can take a few minutes; then `https://staging.savorly.cooking/api/health` returns `{"status":"ok"}`.
9. **EAS project:** in `apps/mobile`, run `eas init`, then the first build interactively so EAS can create the staging keystore: `eas build --platform android --profile staging`.
10. **CI credentials** (GitHub → Settings → Secrets and variables → Actions):
    - Secret `CLOUDFLARE_API_TOKEN`: dashboard → My Profile → API Tokens → **Edit Cloudflare Workers** template, scoped to this account. Container deploys may additionally need **Account → Containers: Edit**; if CI reports an authentication error, add the permission it names.
    - Secret `CLOUDFLARE_ACCOUNT_ID`: shown by `wrangler whoami`.
    - Secret `EXPO_TOKEN`: expo.dev → Account settings → Access tokens.
    - Variable `STAGING_URL` = `https://staging.savorly.cooking`. The deploy fails without it: it waits for `/api/health` before the Android app ships.
    - Optional variable `MEDIA_ORIGIN` on the `staging` environment: the origin of `S3_PUBLIC_URL` (`https://pub-….r2.dev`), which the web app preconnects to.
11. **Install:** open the build on expo.dev on your phone (or scan its QR code), download the APK and allow installing from your browser when Android asks. Later pushes arrive as updates in the installed app; you only install again after a native change ([try it](UPDATES.md#try-it-on-staging)).

## Optional features

Add the key to `.env.staging` and run `npm run deploy:staging`; the app shows each feature once `/api/v1/capabilities` reports it. A running API keeps the settings it started with, so between 07:00 and 23:00 UTC that takes up to about 10 minutes, until the warm-up restarts it with the new ones ([cold starts](DEPLOYMENT.md#cold-starts)); at other times, until it next starts after 30 idle minutes.

| Feature                                         | Keys                                                                | From                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sous-chef, recipe generation, covers, narration | `OPENROUTER_API_KEY`                                                | openrouter.ai → Keys (set a spending limit)                                                                                                                                                                                                                                                  |
| Live voice                                      | `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`                               | platform.openai.com project with `gpt-live-1` access                                                                                                                                                                                                                                         |
| Recipe videos                                   | `REAPI_API_KEY`                                                     | reapi.ai → API Keys                                                                                                                                                                                                                                                                          |
| Google sign-in                                  | `GOOGLE_WEB_CLIENT_ID`                                              | Google Cloud OAuth **Web** client with JavaScript origin `https://staging.savorly.cooking` and redirect URI `https://staging.savorly.cooking/`, plus an **Android** client for `app.savorly.mobile.staging` with the SHA-1 from `eas credentials --platform android` ([sign-in](SIGN-IN.md)) |
| Password reset email                            | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, `EMAIL_FROM` | Step 5 above ([accounts](ACCOUNTS.md#password-reset-email)). Workers Paid includes 3,000 emails a month                                                                                                                                                                                      |

Email/password accounts work without any of these.

## App links

Staging builds open links to `https://staging.savorly.cooking/recipes/<id>` and `/cookbooks/<id>` (`app.config.js` gives the staging variant that domain), once the staging site serves the association files for `app.savorly.mobile.staging` (`MOBILE_APP_ID` under `env.staging` in `wrangler.jsonc`):

- **Android:** `ANDROID_CERT_SHA256` under `env.staging` `vars` in `wrangler.jsonc` holds the SHA-256 fingerprint of the staging keystore (`eas credentials --platform android`, staging profile, shows it); it takes effect with the next deploy. Staging APKs are signed with that key directly, so it is the only one needed. A new keystore needs its fingerprint here instead.
- **iOS** (once there are iOS staging builds): add the Apple Developer Team ID (developer.apple.com → Account → Membership details) as `APPLE_TEAM_ID` in `.env.staging` and deploy.
- The app-link settings change the native fingerprint, so the next push to `staging` builds instead of updating; install that build. `robots.txt` keeps search engines out of staging but lets Android's link verification read `/.well-known/`. Checks: [production](PRODUCTION.md#app-links), with the staging host and package.

## Things to know

- Secrets live in Cloudflare, uploaded from `.env.staging` by `npm run deploy:staging`. CI deploys code only, and deployments never delete secrets: removing a line from `.env.staging` leaves the secret in place, and `npx wrangler secret delete NAME --env staging` (in `infra/cloudflare`) is the only way to remove it ([runbooks](RUNBOOKS.md#rotate-or-remove-a-secret)).
- The API container sleeps after 30 idle minutes; the next request waits a few seconds for it to start. A cron trigger keeps it awake from 07:00 to 23:00 UTC, which keeps the Neon database awake then too; to save that cost, set `"triggers": { "crons": [] }` under `env.staging` in `wrangler.jsonc` (removing the entry would inherit production's schedule; [cold starts](DEPLOYMENT.md#cold-starts)). Neon's free tier suspends an idle database.
- `r2.dev` URLs are rate-limited and meant for development. Production media should use a custom domain such as `media.savorly.cooking`.
- `savorly.cooking` publishes DMARC `p=reject`: mail claiming to be from it is rejected unless Cloudflare Email Service sent it. Add any other sender (a mailbox provider, a newsletter tool) to SPF/DKIM before using it.
- Paid plans are off (`PAID_PLANS=false`): every tester has unlimited Free use, the app shows no plans or prices, and no Stripe keys are needed. The shared daily ceilings (`AI_FREE_DAILY_BUDGET_USD` and `AI_DAILY_BUDGET_USD`, $10 each) are the only spend guard; adjust them in `wrangler.jsonc`, or override them without a redeploy from the [admin console](ADMIN.md)'s Settings. With `REAPI_API_KEY` set, each sous-chef recipe also generates a video (about $1.50).
- The [admin console](ADMIN.md) opens for the addresses in `ADMIN_EMAILS` (set it in `.env.staging`; there is no default) once each account's email is verified, because staging runs in production mode. Sign in or connect Google with that address, reset the password (when email is configured), or set `email_verified` in Neon's SQL editor.
- A push to `staging` uses an EAS build from your plan's quota only when native code changed; otherwise it publishes an update. Builds are queued with `--no-wait`; their status is on expo.dev, not in the GitHub check.
