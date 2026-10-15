# Set up Savorly's providers

Checked October 7, 2026 against the app and provider documentation. This is the setup guide for the intended Cloudflare deployment. No Fly.io or separate ElevenLabs account is needed.

Start with Cloudflare, OpenRouter, OpenAI, and Neon. Add reAPI when testing generated videos, Stripe when testing subscriptions, and the mobile/sign-in accounts when preparing native builds.

The Go API runs on Cloudflare Containers and password-reset email goes through Cloudflare Email Service (see [staging](STAGING.md) for a working deployment). Account creation alone will not deploy the app.

## Before starting

1. Savorly's domain is `savorly.cooking`, registered with Cloudflare: the app is `savorly.cooking`, staging is `staging.savorly.cooking`, public recipe media is `media.savorly.cooking`, and email goes out as `noreply@savorly.cooking`.
2. Confirm the permanent iOS bundle identifier and Android package name before registering native apps. Both are currently `app.savorly.mobile` in `apps/mobile/app.json`. The name must match Apple, Google, Expo, and store registrations.
3. For local testing, edit the existing repository-root `.env`; do not overwrite it with `.env.example`. The example file documents variable names, not real secrets. Keep local database/storage values if you want to continue using Docker locally.
4. Store production credentials in your password manager until the production deployment is ready, then install them as backend secrets. Store/build credentials belong in Wrangler/EAS or the relevant provider dashboard. Only explicitly public build settings below go in Expo.
5. After changing backend configuration locally, restart `npm run api` and reload the app. Rebuild native apps when changing native identifiers or the Google iOS URL scheme.

## 1. Cloudflare — domain, hosting, storage, and email

Open the [Cloudflare dashboard](https://dash.cloudflare.com/).

### Domain and hosting account

1. Create or select the account that will own Savorly. Copy its **Account ID** into your private setup notes.
2. Add your domain to Cloudflare DNS. Review the imported DNS records, including existing mail records, then change the nameservers at your registrar to the two Cloudflare supplies. Wait for the zone to become Active. If your domain already uses Cloudflare, keep its existing zone. See [DNS setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
3. Enable the **Workers Paid** plan when ready to use Containers and Email Sending. The domain's zone plan is separate; this does not require upgrading the domain to the Pro website plan. [Containers availability](https://developers.cloudflare.com/containers/).
4. For local deployment authentication, run `npx wrangler login` and approve access to the correct account. No API token is needed for this interactive login. Automated deployment can use a separately scoped deployment token later.
5. `savorly.cooking` (production) and `staging.savorly.cooking` (staging) are the Workers' custom domains, set as `routes` in `infra/cloudflare/wrangler.jsonc`; `wrangler deploy` creates their DNS records and certificates. Do not create an API hostname pointing at a nonexistent host.

`infra/cloudflare/worker.ts` runs the Go API as a Container behind `/api` and passes it the Worker's vars and secrets. This guide does not ask you to provision another container host.

### R2 media storage

1. In **Storage & databases → R2**, complete R2 activation/billing.
2. Create two buckets: `savorly-media` for published media and `savorly-sources` for private recipe imports. Use the same jurisdiction for both because the app has one S3 endpoint.
3. Open `savorly-media` → **Settings → Custom Domains → Add**, connect `media.savorly.cooking`, and wait for Active status. Keep `savorly-sources` private: no custom domain and no public `r2.dev` access.
4. In the R2 overview, open **Manage API Tokens**. Create an account token if your role allows it, otherwise a user token. Choose **Object Read & Write**, limited to these two buckets. Copy the **Access Key ID** and **Secret Access Key** when shown; the secret cannot be retrieved later. This credential is different from a Wrangler deployment token.
5. Copy the S3 endpoint displayed for the buckets. Use the jurisdiction-specific endpoint if applicable. These steps follow [R2 activation](https://developers.cloudflare.com/r2/get-started/), [custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), and [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/).

Set these **backend** values for production:

```dotenv
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
S3_BUCKET=savorly-media
S3_SOURCE_BUCKET=savorly-sources
S3_PUBLIC_URL=https://media.savorly.cooking
S3_FORCE_PATH_STYLE=true
```

In the public bucket's CORS settings, allow the actual web app origin. For this app's reads, use:

```json
[
  {
    "AllowedOrigins": ["https://savorly.cooking"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"]
  }
]
```

**Check:** after the API has these settings, upload a recipe photo in Savorly. Its URL should use `media.savorly.cooking`. Private source images must not have a public URL. See [storage configuration](STORAGE.md) for more detail.

### Password-reset email

1. Go to **Compute → Email Service → Email Sending → Onboard Domain**.
2. Choose your domain and review the SPF, DKIM, DMARC, and bounce-domain records Cloudflare proposes. Complete onboarding and wait for the domain to be ready to send.
3. Choose the sender, for example `noreply@savorly.cooking`.
4. Create a custom Cloudflare API token (**My Profile → API Tokens**) with **Account → Email Sending: Edit**, limited to this account. It is separate from the R2 and deployment tokens.
5. Set these **backend** values:

```dotenv
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID
CLOUDFLARE_EMAIL_API_TOKEN=YOUR_EMAIL_SENDING_TOKEN
EMAIL_FROM=noreply@savorly.cooking
```

`EMAIL_FROM` is a plain address on the onboarded domain. Restart the API, use Forgot password with an address you control, and confirm the 8-digit code arrives. Delivery failures are logged without recipient addresses; the app's response never reveals whether an account exists. [Cloudflare email setup](https://developers.cloudflare.com/email-service/get-started/send-emails/).

Sending needs Workers Paid, which includes 3,000 emails a month, then $0.35 per 1,000 ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/)). Sends to addresses verified in your Cloudflare account are free on any plan.

## 2. OpenRouter — text, images, and ElevenLabs narration

1. Sign in to [OpenRouter](https://openrouter.ai/), open **Credits**, and add a small balance for testing.
2. Open [API keys](https://openrouter.ai/settings/keys), create a regular inference key named `savorly-development`, and set a spending limit you are comfortable testing with. Keep a separate key for production. Do not use a Management API key for app requests.
3. Copy the key into the existing backend `.env`:

```dotenv
OPENROUTER_API_KEY=YOUR_OPENROUTER_KEY
```

4. Keep the existing model and voice settings:

```dotenv
OPENROUTER_TEXT_MODEL=openai/gpt-6-luna
OPENROUTER_RECIPE_MODEL=openai/gpt-6.1-sol
OPENROUTER_AGENT_MODEL=openai/gpt-6-luna
OPENROUTER_IMAGE_MODEL=openai/gpt-image-2.5-flare
OPENROUTER_TTS_VOICE=sarah
```

5. Restart the API. Ask a short sous-chef question, generate one cover image, and read aloud one saved cooking step. Check OpenRouter Activity for successful requests. These checks use credits.

**Done when:** all three work. The narration model is fixed in the server to `elevenlabs/eleven-v4-turbo`. No separate OpenAI image key, Google AI account, or ElevenLabs key is needed for these features. See [OpenRouter authentication](https://openrouter.ai/docs/api/reference/authentication) and [speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts).

## 3. OpenAI — GPT-Live conversations

1. Sign in to the [OpenAI API platform](https://platform.openai.com/), create/select a project named `Savorly`, and configure API billing. API billing is separate from a ChatGPT subscription.
2. In the project's **Limits / Model Usage**, confirm it can use `gpt-live-1`. If the model is unavailable, resolve access before expecting live conversation to work; a key alone does not prove access.
3. Open the project's **API Keys**, create a secret key for the backend, and save it. Copy the project ID from project settings if you want to select the project explicitly.
4. Add:

```dotenv
OPENAI_API_KEY=YOUR_OPENAI_PROJECT_KEY
OPENAI_PROJECT_ID=YOUR_PROJECT_ID
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_LIVE_VOICE=gleam
```

`OPENAI_PROJECT_ID` can stay blank for a project-scoped key. Configure usage alerts; OpenAI project budgets are soft alerts, not a guaranteed request cutoff. [Project/key instructions](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform).

5. Restart the API. With the OpenRouter key also configured, open live voice on HTTPS or localhost, allow the microphone, and have a short conversation. Try interrupting and asking it to look up a saved recipe. The OpenRouter key powers the backend agent; the OpenAI key powers live audio. [GPT-Live model](https://developers.openai.com/api/docs/models/gpt-live-1).

**Done when:** live audio connects, responds, and can invoke the app's agent. Native microphone/WebRTC behavior should also be checked in a development build.

## 4. Neon — production PostgreSQL

1. Sign in to [Neon](https://console.neon.tech/) and create a project named `savorly`. Choose PostgreSQL 17 to match local development and a region appropriate for the intended deployment/users.
2. Use the production branch/database shown in the project. Open **Connect**, select the database and role, and copy the PostgreSQL connection string. For the initial deployment, choose a **direct/non-pooled** connection; the Go app already maintains a pool of up to 12 connections.
3. Preserve the TLS parameters Neon supplies. Set the backend `DATABASE_URL` to that connection string. Do not paste the `psql` command wrapper into the variable.
4. In the production backend settings, also set:

```dotenv
APP_ENV=production
SEED_DATA=false
ALLOWED_ORIGINS=https://savorly.cooking
APP_URL=https://savorly.cooking
```

5. Choose the backup/restore retention appropriate for your Neon plan. On first API startup, the app applies its own SQL migrations; you do not need to paste schema files into Neon's SQL editor.

**Check:** once the backend is deployed, `/health` returns `{"status":"ok"}` and a new account/recipe remains after restarting the API. If testing Neon locally first, keep the local origin/environment settings instead of the production values above. Keep development data separate from production. [Neon connection instructions](https://neon.com/docs/connect/connect-from-any-app).

Neon remains because the existing app uses PostgreSQL. Cloudflare D1 is not a compatible connection-string replacement.

## 5. reAPI — generated recipe videos

1. Sign up at [reAPI](https://reapi.ai/).
2. Open **Dashboard → API Keys → Create new key**, name it for Savorly, and save the key when shown.
3. Add credits in the account and confirm access to Seedance 2.5 Eco.
4. Set:

```dotenv
REAPI_API_KEY=YOUR_REAPI_KEY
REAPI_VIDEO_MODEL=doubao-seedance-2.5-eco
```

5. Restart the API and generate one short recipe video with any account while paid plans are off. Once `PAID_PLANS=true`, only Pro includes video; a Pro test subscription can be created using Stripe's sandbox below. Media storage must also be working.

**Done when:** the job completes and the clip plays from your media storage. The test is a paid generation. You can leave this key blank until you need video generation. [reAPI quickstart](https://reapi.ai/docs/api/quickstart).

## 6. Stripe — subscriptions

Not needed while paid plans are off: until `PAID_PLANS=true`, everyone has unlimited Free use and Stripe keys are ignored ([pricing](PRICING.md)). Set `PAID_PLANS=true` along with the keys below when testing subscriptions.

Start in a Stripe sandbox/test environment; switch to live only after checkout and webhooks work.

1. Create a [Stripe account](https://dashboard.stripe.com/) and select a sandbox/test environment.
2. In **Product catalog**, create `Savorly Plus` and `Savorly Pro`. Give each two recurring USD prices matching the app:

| Product | Billing interval | Amount | Backend variable for the price ID |
| --- | --- | --- | --- |
| Savorly Plus | Monthly | $9.99 | `STRIPE_PRICE_PLUS_MONTHLY` |
| Savorly Plus | Yearly | $79.99 | `STRIPE_PRICE_PLUS_YEARLY` |
| Savorly Pro | Monthly | $19.99 | `STRIPE_PRICE_PRO_MONTHLY` |
| Savorly Pro | Yearly | $159.99 | `STRIPE_PRICE_PRO_YEARLY` |

3. Copy each `price_...` value, not the product's `prod_...` ID. Open the API keys page and copy the sandbox secret key into `STRIPE_SECRET_KEY`. The app uses hosted Checkout and does not need a publishable key in Expo. [Create products/prices](https://docs.stripe.com/products-prices/manage-prices).
4. In **Workbench → Webhooks**, create a webhook destination for your account using **snapshot events** and your public API URL. Through the current same-origin gateway it is `https://savorly.cooking/api/v1/billing/webhook`; with a separately mapped API origin it is `https://api.savorly.cooking/v1/billing/webhook`. Use only the URL that actually routes to the deployed backend.
5. Subscribe to these implemented events:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
```

6. Reveal the destination's signing secret and set `STRIPE_WEBHOOK_SECRET=whsec_...`. This is separate from the Stripe API key. For local testing, use Stripe CLI forwarding instead:

```sh
stripe login
stripe listen --forward-to localhost:8080/v1/billing/webhook
```

Use the signing secret printed by that CLI session while testing locally, and keep the listener running. Replace it with the deployed destination's secret for production. [Webhook setup](https://docs.stripe.com/webhooks).

7. In **Settings → Billing → Customer portal**, configure payment-method updates, invoices, cancellation, and subscription changes between the supported prices. Save the configuration; the app creates authenticated portal sessions itself. [Portal settings](https://docs.stripe.com/customer-management/activate-no-code-customer-portal).
8. Set `APP_URL` to the app URL used for this environment (for example `http://localhost:8081` locally). Keep `STRIPE_AUTOMATIC_TAX=false` until your Stripe Tax setup is complete.
9. From Savorly's web app, buy a sandbox subscription with a Stripe test payment method, verify the plan changes, open Manage plan, and test cancellation. Confirm webhook deliveries return 2xx. A test-mode Pro subscription permits testing video generation, but the AI provider calls themselves still spend real credits.
10. Before selling real subscriptions, complete Stripe's business/payout onboarding and repeat the product, price, webhook, and portal setup in live mode. Replace **all** test keys, price IDs, and webhook secrets together; they are environment-specific.

**Done when:** Checkout returns to the app, the plan updates through the webhook, and Manage plan works. Prices and allowances are defined in `services/api/internal/app/plans.go`; keep them aligned with Stripe. See [billing details](PRICING.md).

## 7. Expo / EAS — native builds

1. Create an [Expo account](https://expo.dev/signup). From the app directory, link this repository to an EAS project:

```sh
cd apps/mobile
npx eas-cli login
npx eas-cli init
npx eas-cli build:configure
```

Review the generated project ID/configuration. The repository already has `eas.json` profiles; keep `development`, `preview`, and `production`.

2. In the Expo project's **Environment variables**, set public `EXPO_PUBLIC_API_URL` for the environment you will build. With the same-origin gateway, use `https://savorly.cooking/api` (the client adds `/v1`); with a dedicated API domain use `https://api.savorly.cooking`. Do not append `/v1` yourself.
3. After creating the Google iOS OAuth client below, set `GOOGLE_IOS_URL_SCHEME` in the same build environment to its reversed client ID. This is a public build setting.
4. Let EAS generate/manage the Android keystore and Apple signing credentials when prompted, or provide existing credentials for an already released app. Start with an Android preview build:

```sh
npx eas-cli build --profile preview --platform android
```

5. Install it and test sign-in, microphone, playback, uploads, and camera. Native Google/Apple/WebRTC modules require a native build; Expo Go is not sufficient.
6. When store accounts and identifiers are ready, build store binaries:

```sh
npx eas-cli build --profile production --platform all
```

**Done when:** the installed build reaches the intended API. Do not place OpenRouter, OpenAI, R2, database, Stripe, or email secrets in EAS public variables. `EXPO_TOKEN` is optional for future automation, not needed for interactive login. [Build setup](https://docs.expo.dev/build/setup/) and [EAS environment variables](https://docs.expo.dev/eas/environment-variables/).

## 8. Google Cloud — Sign in with Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a Savorly project. Open **Google Auth Platform** and configure Branding: app name, support email, authorized domain, homepage, and privacy-policy URL. Set the audience for your intended users; add your test accounts if using Testing status. Login needs only `openid`, `email`, and `profile`.
2. Under **Clients**, create a **Web application** OAuth client. Add `https://savorly.cooking` as an Authorized JavaScript origin. For local development also add `http://localhost` and `http://localhost:8081`. This app uses the JavaScript callback flow, so it does not need a Google backend redirect URL.
3. Create an **iOS** OAuth client for the app's bundle ID. Copy its client ID and reversed URL scheme.
4. Create an **Android** OAuth client for the package name and the signing certificate's SHA-1. Register each certificate you actually use: development/preview, upload, and Play app signing. Use EAS credentials for build signing information and Play Console's App integrity page for Play's signing certificate. Multiple certificates generally mean separate Android OAuth client registrations.
5. Set on the backend:

```dotenv
GOOGLE_WEB_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
GOOGLE_IOS_CLIENT_ID=YOUR_IOS_CLIENT_ID.apps.googleusercontent.com
```

Set `GOOGLE_IOS_URL_SCHEME` in EAS, for example `com.googleusercontent.apps.YOUR_IOS_CLIENT_ID_PREFIX`. Use the exact reversed client ID Google supplies, not this placeholder.

6. Restart the API, rebuild native apps after scheme changes, and test each platform. Complete Google's production/branding verification steps shown in your console before public release. [Google Identity setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

**Done when:** Google login succeeds on web and the signed native builds. The backend verifies the **web client ID** as the token audience on all platforms. The Android client ID itself is not stored in `.env`, and this implementation does not use a Google client secret. iOS Google sign-in also requires the Apple sign-in configuration below.

## 9. Apple Developer / App Store Connect — Apple sign-in and iOS release

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/). In **Certificates, Identifiers & Profiles → Identifiers**, register/select the explicit App ID matching the iOS bundle ID and enable **Sign in with Apple** as a primary App ID.
2. For web sign-in, register a **Services ID**, for example `app.savorly.web`. Enable Sign in with Apple on it, associate the primary App ID, and add your web domain plus the exact HTTPS return URL, for example `https://savorly.cooking/auth/apple`. Localhost is not the production return URL. [Web sign-in setup](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/).
3. Under **Keys**, create a Sign in with Apple key associated with the primary App ID. Download its `.p8` file and record the Key ID and your Team ID. Keep a secure copy; the download is available only once. This app uses it for Apple's server operations, including revocation on account deletion. [Apple sign-in key](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key/).
4. Set these backend values to match your registrations:

```dotenv
APPLE_BUNDLE_ID=app.savorly.mobile
APPLE_SERVICES_ID=app.savorly.web
APPLE_REDIRECT_URI=https://savorly.cooking/auth/apple
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_KEY_ID=YOUR_KEY_ID
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY_CONTENT\n-----END PRIVATE KEY-----"
```

Use the full contents of the actual `.p8` key, not its filename. In a production secret editor use the full multiline PEM; in the local `.env`, quoted escaped newlines as above are supported.

5. Register your outgoing email domain/sender under **Services → Sign in with Apple for Email Communication** and complete its authentication checks. This lets reset emails reach users who choose Hide My Email once email delivery is wired up. [Private relay setup](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service/).
6. Restart the API and rebuild the iOS app with EAS. Test native Apple sign-in, web Apple sign-in, linking a provider, and account deletion using disposable test accounts.
7. In [App Store Connect](https://appstoreconnect.apple.com/), create the app using that Bundle ID, choose an internal SKU, and complete app information. Use EAS Submit for a production build, then TestFlight before App Review. Supply the required screenshots, support/privacy URLs, app privacy answers, review access, and release details.

**Done when:** Apple login works and a TestFlight build installs. An App Store Connect API key used for automated submission is separate from the Sign in with Apple `.p8` key; keep submission credentials in EAS, not the API `.env`. See [app sign-in behavior](SIGN-IN.md).

## 10. Google Play Console — Android release

1. Create a [Play Console developer account](https://play.google.com/console/signup), choose the correct personal/organization type, and complete identity/contact verification.
2. Create Savorly in the console. Use the same Android package name as the EAS build. Complete the store listing, privacy policy, Data safety, content rating, and app-access instructions. Add the required account-deletion web URL before release.
3. Build the Android **production** profile in EAS to obtain an `.aab`. Upload the first release manually to an internal test track, and enroll/configure Play App Signing as prompted. The preview `.apk` is for direct installation, not the store submission artifact.
4. Copy the **app-signing certificate SHA-1** from Play's App integrity settings and register it in the Google OAuth project above. It may differ from EAS's upload certificate.
5. For later automated submissions, create a Google service account, enable the Google Play Android Developer API in its Cloud project, grant that account the necessary app/release permissions in Play Console, and supply its JSON key to EAS Submit. Manual uploads do not need this service-account key. [EAS Android submission](https://docs.expo.dev/submit/android/).
6. Follow the testing requirements shown for your account. New personal accounts created after November 13, 2023 currently need a closed test with at least 12 testers opted in continuously for 14 days before applying for production access; internal testing alone does not satisfy that requirement. [Google's testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).

**Done when:** internal testers can install the Play build and sign in, and the account is eligible to request production release. The Play service-account JSON and Android keystore are build/submission credentials; do not add them to the backend `.env`.

## Final handoff and checks

Keep the credentials in the locations above. The non-secret information needed to finish deployment is: your chosen domains, Cloudflare Account ID, Neon region, Expo project/owner, app identifiers, and which optional features you configured.

Once the Cloudflare Containers and email changes are implemented, the remaining deployment work is to install backend secrets, deploy the API and web app, attach the app domain, and verify:

- `/health` against the API succeeds; through the same-origin gateway use `/api/health`.
- `/v1/capabilities` (or `/api/v1/capabilities`) reports the intended models/features. These flags detect configuration, not whether a key has credit or provider access.
- One real text, image, narration, live-voice, and optional video request works.
- R2 public media loads while private source objects remain private.
- Password recovery delivers mail, sandbox billing updates a plan, and enabled social sign-ins work.

This guide changes setup instructions only. No accounts were created, keys installed, purchases made, or deployments performed while writing it.
