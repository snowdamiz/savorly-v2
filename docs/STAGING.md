# Staging

Staging is a full copy of Savorly for testing on real devices, at [staging.savorly.cooking](https://staging.savorly.cooking):

| Piece                                     | Where                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Web app, `/api` gateway, Go API container | Cloudflare Worker `savorly-staging` on `staging.savorly.cooking`, `env.staging` in [wrangler.jsonc](../infra/cloudflare/wrangler.jsonc) |
| Database                                  | Neon project `savorly-staging` (fixture recipes are seeded on startup)                                                                  |
| Media                                     | R2 buckets `savorly-staging-media` (public via r2.dev, CORS for the staging site) and `savorly-staging-sources` (private)               |
| Email                                     | Cloudflare Email Service on `savorly.cooking`, sending as `noreply@savorly.cooking`                                                     |
| Android app                               | EAS profile `staging`: "Savorly Staging", package `app.savorly.mobile.staging`, installs beside production                              |

Every push to the `staging` branch that passes verification redeploys the backend and queues an Android build ([ci.yml](../.github/workflows/ci.yml)). To put what is on `main` on staging:

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
   The `pub-….r2.dev` URL is `S3_PUBLIC_URL`. CORS allows `GET`/`HEAD` with `Range` from `https://staging.savorly.cooking`, exposing `ETag`, `Content-Length`, `Content-Range` and `Accept-Ranges`. Keep the sources bucket private.
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
    - Variable `STAGING_URL` = `https://staging.savorly.cooking`, so CI waits for `/api/health` after deploying.
11. **Install:** open the build on expo.dev on your phone (or scan its QR code), download the APK and allow installing from your browser when Android asks.

## Optional features

Add the key to `.env.staging` and run `npm run deploy:staging`; the app shows each feature once `/api/v1/capabilities` reports it.

| Feature                                         | Keys                                                                | From                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sous-chef, recipe generation, covers, narration | `OPENROUTER_API_KEY`                                                | openrouter.ai → Keys (set a spending limit)                                                                                                                                                                                                                 |
| Live voice                                      | `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`                               | platform.openai.com project with `gpt-live-1` access                                                                                                                                                                                                        |
| Recipe videos                                   | `REAPI_API_KEY`                                                     | reapi.ai → API Keys                                                                                                                                                                                                                                         |
| Google sign-in                                  | `GOOGLE_WEB_CLIENT_ID`                                              | Google Cloud OAuth **Web** client with JavaScript origin `https://staging.savorly.cooking` (no redirect URIs), plus an **Android** client for `app.savorly.mobile.staging` with the SHA-1 from `eas credentials --platform android` ([sign-in](SIGN-IN.md)) |
| Password reset email                            | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, `EMAIL_FROM` | Step 5 above ([accounts](ACCOUNTS.md#password-reset-email)). Workers Paid includes 3,000 emails a month                                                                                                                                                     |

Email/password accounts work without any of these.

## Things to know

- Secrets live in Cloudflare, uploaded from `.env.staging` by `npm run deploy:staging`. CI deploys code only, and deployments never delete secrets.
- The API container sleeps after 30 idle minutes; the next request waits a few seconds for it to start. Neon's free tier also suspends an idle database.
- `r2.dev` URLs are rate-limited and meant for development. Production media should use a custom domain such as `media.savorly.cooking`.
- `savorly.cooking` publishes DMARC `p=reject`: mail claiming to be from it is rejected unless Cloudflare Email Service sent it. Add any other sender (a mailbox provider, a newsletter tool) to SPF/DKIM before using it.
- Paid plans are off (`PAID_PLANS=false`): every tester has unlimited Free use, the app shows no plans or prices, and no Stripe keys are needed. The shared daily ceilings (`AI_FREE_DAILY_BUDGET_USD` and `AI_DAILY_BUDGET_USD`, $10 each) are the only spend guard; adjust them in `wrangler.jsonc`, or override them without a redeploy from the [admin console](ADMIN.md)'s Settings. With `REAPI_API_KEY` set, each sous-chef recipe also generates a video (about $1.50).
- The [admin console](ADMIN.md) opens for `yurlovandrew@gmail.com` once that account's email is verified, because staging runs in production mode. Sign in or connect Google with that address, reset the password (when email is configured), or set `email_verified` in Neon's SQL editor.
- Each push to `staging` uses one EAS build from your plan's quota. Builds are queued with `--no-wait`; their status is on expo.dev, not in the GitHub check.
