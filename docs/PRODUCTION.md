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

CI then verifies the commit again, deploys the backend and web app to `savorly.cooking` (the GitHub `production` environment; it waits for `/api/health`), and ships the Android app: an over-the-air update on the `production` channel, or a new production build on EAS when native code changed ([updates](UPDATES.md)). To undo a release, revert the change on `main` and push `main:release` again; `wrangler rollback` puts the previous Worker version back sooner, and `eas update:rollback` the previous app update ([runbooks](RUNBOOKS.md#roll-back-a-release)). Requiring an approval before production deploys is described in [release gating](RUNBOOKS.md#release-gating).

Backend settings live in Cloudflare as Worker secrets, uploaded from the git-ignored `.env.production` ([template](../.env.production.example)) by `npm run deploy:production`, which also deploys from your machine. CI deploys code only; deployments never delete secrets, so remove one with `npx wrangler secret delete NAME` in `infra/cloudflare` ([runbooks](RUNBOOKS.md#rotate-or-remove-a-secret)). Non-secret settings are the top-level `vars` in `wrangler.jsonc`.

## Set up

- Neon project `savorly-production`; R2 buckets `savorly-media` and `savorly-sources`, with CORS on media.
- Worker `savorly` with custom domains `savorly.cooking` and `www.savorly.cooking`, and no `workers.dev` URL.
- `media.savorly.cooking` attached to `savorly-media`: `wrangler r2 bucket domain add savorly-media --domain media.savorly.cooking --zone-id <savorly.cooking zone ID>` (the zone ID is on the domain's Overview page).
- GitHub variable `PRODUCTION_URL=https://savorly.cooking`, which the deploy needs (it fails without it, since the Android app ships only after `/api/health` answers); the `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EXPO_TOKEN` secrets are shared with staging. Optionally, a `MEDIA_ORIGIN` variable on the `production` environment overrides the media origin the web app preconnects to (`https://media.savorly.cooking` by default, `scripts/deploy.sh`).
- Paid plans are off (`PAID_PLANS=false`). With everyone on Free, `AI_FREE_DAILY_BUDGET_USD` ($5 a day) is the effective AI spend ceiling; `AI_DAILY_BUDGET_USD` is $25.
- The Worker keeps the API awake from 07:00 to 23:00 UTC and serves recipe preview pages, the sitemap and `robots.txt` ([deployment](DEPLOYMENT.md#web-pages-and-app-links)); turning on Cloudflare Web Analytics is one var, `CF_ANALYTICS_TOKEN`.

## App links

Recipe and public cookbook links (`https://savorly.cooking/recipes/<id>`, `/cookbooks/<id>`) open the installed app instead of the browser once both sides agree: the app declares the domain (`associatedDomains` and an Android `intentFilters` entry in `app.json`), and the site serves two files that name the app, which the Worker builds from settings.

- **iOS:** `/.well-known/apple-app-site-association` names `<Team ID>.app.savorly.mobile`. It is served once `APPLE_TEAM_ID` is set: the Apple Developer Team ID from developer.apple.com → Account → Membership details. It is already a line in `.env.production` for Sign in with Apple, and on its own it doesn't turn sign-in on, so fill it in and run `npm run deploy:production`. Don't also add it to `wrangler.jsonc`: a var can't share a secret's name. EAS enables the Associated Domains capability on the App ID during the next iOS build.
- **Android:** `/.well-known/assetlinks.json` lists the certificate fingerprints in `ANDROID_CERT_SHA256` (comma separated) in the top-level `vars` of `wrangler.jsonc`. It already holds the upload key's fingerprint, the EAS keystore that signs builds installed outside Play (`eas credentials --platform android`, production profile). Play re-signs the app, so once it's on Google Play also add the **app signing key** SHA-256 from Play Console → App integrity → App signing, comma separated. Deploy, then reinstall or wait for Android to re-verify.
- The native side changes the app's fingerprint, so it reaches phones with the next production build, not as an update. The app receives the link through `Linking`, like a `savorly://` link, and its URL handling in `App.tsx` opens the recipe or cookbook.
- Check the files with `curl -i https://savorly.cooking/.well-known/apple-app-site-association` (JSON, no redirect), Apple's cached copy at `https://app-site-association.cdn-apple.com/a/v1/savorly.cooking`, and `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://savorly.cooking&relation=delegate_permission/common.handle_all_urls`; on a phone, `adb shell pm get-app-links app.savorly.mobile` shows Android's verdict.

## Before a public launch

- **Stores:** create the Play Console app (`app.savorly.mobile`), upload the first production `.aab` to internal testing, and complete the store listing, Data safety, content rating and the account-deletion web page. New personal Play accounts need a 14-day closed test with 12 testers before production. For iOS, enroll in the Apple Developer Program, create the App Store Connect app, then build with `eas build --platform ios --profile production`. See [accounts](ACCOUNTS.md) sections 9 and 10.
- **Google sign-in:** add `https://savorly.cooking` to the Web client's JavaScript origins and `https://savorly.cooking/` to its redirect URIs, and create an Android OAuth client for `app.savorly.mobile` with the SHA-1 of the production upload key (`eas credentials --platform android`, production profile, after the first production build) and later Play's app-signing key ([sign-in](SIGN-IN.md)).
- **Sign in with Apple:** fill the `APPLE_*` values in `.env.production` once the App ID, Services ID and key exist; leave them empty until then, since any value turns Apple sign-in on.
- **Separate production credentials:** `.env.production` started as a copy of staging's keys. Give production its own OpenRouter, OpenAI and reAPI keys with spending limits, and its own R2 token scoped to the two production buckets.
- **Legal review (required).** `/privacy`, `/terms` and `/account-deletion` (`apps/mobile/public/*.html`) were written from what the code does, but they need a lawyer's review before launch. The HTML comment at the top of each page lists what is open: the operator's name and address, the governing law, retention periods to confirm (the Neon restore window, when uploaded files are deleted, the admin audit log), and a working `privacy@savorly.cooking` mailbox (for example Cloudflare Email Routing). Then use `https://savorly.cooking/privacy` as the store listings' privacy policy and `https://savorly.cooking/account-deletion` as Play's account-deletion URL (Play Console → App content → Data deletion), and link the pages from the app.
- **Backups:** check the restore window on your Neon plan and rehearse a restore ([runbook](RUNBOOKS.md#restore-the-database)).
- **Capacity:** load-test sign-ups and uploads on the `basic` container, or move to `standard-1` ([capacity](DEPLOYMENT.md#capacity)).
- **Release gating:** require a reviewer on the `production` environment and protect `release` and `staging` ([runbooks](RUNBOOKS.md#release-gating)), and turn on private vulnerability reporting for [SECURITY.md](../SECURITY.md) (GitHub → Settings → Advanced Security).
- **Launch work** from [deployment](DEPLOYMENT.md#operational-limits-to-address-before-a-public-launch): moderation workflow, R2 cleanup, and paid plans (`PAID_PLANS=true` with Stripe, [pricing](PRICING.md)).
