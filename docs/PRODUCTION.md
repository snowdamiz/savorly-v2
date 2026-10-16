# Production

Production is Savorly at [savorly.cooking](https://savorly.cooking). Pushing to the `release` branch deploys it; the `staging` branch deploys [staging](STAGING.md).

| Piece                                     | Where                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app, `/api` gateway, Go API container | Cloudflare Worker `savorly` on `savorly.cooking` (top level of [wrangler.jsonc](../infra/cloudflare/wrangler.jsonc)); `www.savorly.cooking` redirects there   |
| Database                                  | Neon project `savorly-production` (PostgreSQL 17, `aws-us-east-1`); no fixture data (`SEED_DATA=false`)                                                       |
| Media                                     | R2 `savorly-media` at `media.savorly.cooking` (CORS for `https://savorly.cooking`) and `savorly-sources` (private)                                            |
| Email                                     | Cloudflare Email Service, `noreply@savorly.cooking` (shared with staging)                                                                                     |
| Android app                               | EAS profile `production`: "Savorly", `app.savorly.mobile`, a Play Store bundle (`.aab`); updates over the air on channel `production` ([updates](UPDATES.md)) |
| iOS app                                   | EAS profile `production`, `app.savorly.mobile`; needs the Apple Developer setup below                                                                         |

## Releasing

Release what is on `main` (already verified there and tried on staging with `git push origin main:staging`):

```sh
git push origin main:release
```

CI then verifies the commit again, deploys the backend and web app to `savorly.cooking` (the GitHub `production` environment; it waits for `/api/health`), and ships the Android app: an over-the-air update on the `production` channel, or a new production build on EAS when native code changed ([updates](UPDATES.md)). To undo a release, revert the change on `main` and push `main:release` again; `eas update:rollback` takes an update back sooner.

Backend settings live in Cloudflare as Worker secrets, uploaded from the git-ignored `.env.production` ([template](../.env.production.example)) by `npm run deploy:production`, which also deploys from your machine. CI deploys code only; deployments never delete secrets. Non-secret settings are the top-level `vars` in `wrangler.jsonc`.

## Set up

- Neon project `savorly-production`; R2 buckets `savorly-media` and `savorly-sources`, with CORS on media.
- Worker `savorly` with custom domains `savorly.cooking` and `www.savorly.cooking`, and no `workers.dev` URL.
- `media.savorly.cooking` attached to `savorly-media`: `wrangler r2 bucket domain add savorly-media --domain media.savorly.cooking --zone-id <savorly.cooking zone ID>` (the zone ID is on the domain's Overview page).
- GitHub variable `PRODUCTION_URL=https://savorly.cooking`; the `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EXPO_TOKEN` secrets are shared with staging.
- Paid plans are off (`PAID_PLANS=false`). With everyone on Free, `AI_FREE_DAILY_BUDGET_USD` ($5 a day) is the effective AI spend ceiling; `AI_DAILY_BUDGET_USD` is $25.

## Before a public launch

- **Stores:** create the Play Console app (`app.savorly.mobile`), upload the first production `.aab` to internal testing, and complete the store listing, Data safety, content rating and the account-deletion web page. New personal Play accounts need a 14-day closed test with 12 testers before production. For iOS, enroll in the Apple Developer Program, create the App Store Connect app, then build with `eas build --platform ios --profile production`. See [accounts](ACCOUNTS.md) sections 9 and 10.
- **Google sign-in:** add `https://savorly.cooking` to the Web client's JavaScript origins, and create an Android OAuth client for `app.savorly.mobile` with the SHA-1 of the production upload key (`eas credentials --platform android`, production profile, after the first production build) and later Play's app-signing key ([sign-in](SIGN-IN.md)).
- **Sign in with Apple:** fill the `APPLE_*` values in `.env.production` once the App ID, Services ID and key exist; leave them empty until then, since any value turns Apple sign-in on.
- **Separate production credentials:** `.env.production` started as a copy of staging's keys. Give production its own OpenRouter, OpenAI and reAPI keys with spending limits, and its own R2 token scoped to the two production buckets.
- **Backups:** check the restore window on your Neon plan.
- **Launch work** from [deployment](DEPLOYMENT.md#operational-limits-to-address-before-a-public-launch): privacy policy and terms, moderation workflow, R2 cleanup, and paid plans (`PAID_PLANS=true` with Stripe, [pricing](PRICING.md)).
