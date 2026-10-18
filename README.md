# Savorly

A cooking community for good recipes, everyday inspiration, and a little AI help. Built with **Expo / React Native + TypeScript, Go Fiber v3, PostgreSQL, Cloudflare Workers / R2, OpenRouter, and Seedance 2.0 Mini through reAPI**.

The interface follows a rounded monochrome visual system with Manrope typography, an editorial recipe feed, responsive desktop and mobile navigation, and food photography as the main color.

## Run locally

Prerequisites: Node 22.13+ (Node 22 LTS recommended), npm, Go 1.26+, Docker.

```sh
make setup
make services
# Separate terminals:
make api
make web
```

Open [Savorly at localhost:8081](http://localhost:8081). API health: [localhost:8080/health](http://localhost:8080/health). The local Postgres port is **54329**. SeaweedFS serves local media on **8333**, using the same S3 adapter as production R2.

`make setup` copies `.env.example` only if `.env` is missing. The API loads the repository `.env`. All external integrations default to disabled; you can browse the seeded test kitchen, create your own account, and use every non-AI kitchen feature locally. No seeded creator has a usable password.

To run the API in Docker: `docker compose --profile full up --build`. Run Expo separately. `docker compose down` keeps database and media volumes; use `down -v` only when intentionally erasing local data.

## What is implemented

- Recipe discovery from a server-ranked home feed, multilingual, accent-insensitive and typo-tolerant search over titles, ingredients and tags, cuisine/diet/time filters, a weighted "top rated", and creator profiles.
- Nine interface languages with automatic device/browser detection, a saved language choice in My kitchen, and localized dates and quantities. Recipes written in another language read in yours: translated by AI with one tap (or always, a saved preference), shared by every later reader, cooked and read aloud translated, and kept on the device for cooking offline. See [localization](docs/LOCALIZATION.md#recipes-in-your-language).
- Account registration/login/logout, Sign in with Apple (iOS, web) and Google (iOS, Android, web), sliding sessions with a device list and "sign out everywhere else", password and email changes, email verification, optional Cloudflare Turnstile on sign-up and password reset, editable profiles, dietary and measurement preferences, password recovery, a downloadable copy of your data (as files to keep, or one JSON file), and account deletion. See [sign-in](docs/SIGN-IN.md) and [accounts](docs/ACCOUNTS.md).
- A first-launch welcome on phones (language, then join, sign in or look around) and a skippable kitchen setup for every new account: photo, name and username, food preferences, cooks to follow, and a last step that introduces the sous-chef as the way to get help with, or simply do, anything in the app.
- Profile photos taken with the camera or chosen from the library (cropped square and resized on the device), changed by tapping the photo in My kitchen, and an optional AI touch-up (GPT Image 2.5 Sunburst) that improves light, color and focus while keeping the person the same, with a before/after comparison. Uploaded recipe photos get the same touch-up, keeping the dish, plating and portions.
- Free, Plus and Pro plans sold through Stripe on the web, with allowances and AI spend ceilings that keep every plan cash-flow positive, shared with everyone in the payer's household, and no app-store commission. See [pricing](docs/PRICING.md).
- Recipe creation, editing, private drafts, device draft autosave with restore, ingredient and instruction editors, step photos and short step clips (uploaded, or four-second AI clips made on request), a recipe language, direct-to-storage photo/video uploads with progress, import from a recipe link or a TikTok, Instagram, YouTube, Facebook or Pinterest post (its caption, or the recipe page it links to, crediting the creator; failed imports don't count against a plan), bulk imports of many links or pasted recipes read on the server (a page for Mealime's members before Mealime closes, and creators' own sites with their photos and permission; see [switching](docs/SWITCHING.md)), attribution for imports and adaptations, and AI disclosure.
- A creator fund: cooking mode records verified cooks (finished, long enough, once a day, never the author's own), recipes show how long cooks really take, and each month a share of every paying member's net revenue goes to the creators of the recipes that member cooked, with earnings in My kitchen and payouts through Stripe Connect Express. See [creator fund](docs/CREATOR-FUND.md).
- Cook-tested recipes: cooking mode records how long each step really takes and what cooks ask there, and a nightly pass turns it into each recipe's evidence ("Cook-tested · 214 cooks · usually 55 min (says 40)", "Most cooks needed 4 more minutes here", the questions cooks keep asking with answers, how many finish), an Explore filter and a boost in the feed, answers in cooking mode that know how other cooks did, and "Where cooks get stuck" for authors. Only from enough cooks that nobody's own numbers or words show, and a member can keep their cooking out. See [cook-tested recipes](docs/COOK-TESTED.md).
- Recipe fixes from cooks: a member who cooked a recipe through can suggest a checkable change (a step's time or heat, a note, a missing step, an amount, a swap that worked), prompted after a step ran over its timer or through the sous-chef; other cooks say "same for me", the author accepts as is or edited, declines with a reason, or undoes the latest, and accepted fixes credit their cooks ("Improved by 3 cooks"). See [recipe fixes](docs/RECIPE-FIXES.md).
- Your version of a recipe: changes a cook makes as they cook (told to the sous-chef, kept after a step ran long, or typed) apply over the recipe next time, marked and a tap from the original, while the author's own changes still arrive; kitchen notes ("my oven runs hot") apply to every recipe, and the sous-chef and hands-free answers know both. See [your version](docs/YOUR-VERSION.md).
- A whole-meal timeline: two to four recipes and a time to eat ("Cook together" from the planner's day or from saved recipes) become one timed plan worked out on the server without AI, backwards from the meal, with waiting steps overlapped, one hands-on task at a time, the oven at one heat and the burners the kitchen has, cook-tested step times where cooks measured them, and quiet warnings for what the kitchen can't do; then one cooking mode across all the dishes with a timer per dish, "I'm behind", hands-free commands, and a cook session per dish. Each step's hands-on and waiting time, oven and burners come from its cook, or are read from its words in the nine languages, or estimated once by the cheap model. See [meal timeline](docs/MEAL-TIMELINE.md).
- What a recipe needs besides its ingredients: authors list their pots, pans, appliances and tools in the editor (or fill the list from what the method mentions), and an equipment lexicon in the nine languages reads every method for the recipes without a list ("Dutch oven" is never an oven, "Ofenform" is a baking dish), so the recipe page's **You'll need** and cooking mode's first step show the cook's list, or what the method mentions, labelled as such. Imports read schema.org `tool`, the sous-chef reads and edits the list, and printing, translations and the page's schema.org data carry it. See [equipment](docs/API.md#equipment).
- Serving scaling, metric/imperial conversion with fractions, ingredient checklists, guided cooking that keeps the screen awake, step timers that alert in the background, spoken instructions in the recipe's language, video playback, printing on the web, offline access to recently opened and saved recipes, and recipe sharing.
- ElevenLabs v4 Turbo cooking narration through OpenRouter with streamed audio, shared caching, next-step preloading, the last recipes' recordings kept on the device for cooking offline, and device-speech fallback. See [setup and playback details](docs/COOKING-NARRATION.md).
- Family recipes in their own voice: record a relative talking a dish through (or choose a recording, or photograph a handwritten card, kept as the cover), and Savorly writes it down as a private recipe whose steps play what they said, beside narration in cooking mode. No voice is ever cloned; publishing one asks whether the person agreed, cookbooks can be shared with the household, and the recordings are kept twice and come with the export. See [family recipes](docs/FAMILY-RECIPES.md).
- Hands-free cooking that doesn't use live voice minutes: in cooking mode the device listens (on the device where the platform can) for free spoken commands in all nine languages (next or previous step, read the step, start, pause or resume the timer, stop, the ingredients, done) and for "Chef, …" questions, which the sous-chef answers aloud in a sentence or two, counted against a plan allowance. See [hands-free cooking](docs/HANDS-FREE.md).
- Saved recipes and named cookbooks (optionally public, with a shareable page), follows, ratings/reviews, comments with replies, "I cooked this" with a photo, recipe variations, push notifications (new recipes from cooks you follow, reviews and comments on yours, expiring pantry items), and content reports. See [notifications](docs/NOTIFICATIONS.md).
- An admin console for owners and appointed admins: a moderation queue, member management (suspension, complimentary plans, sign-out, deletion), every recipe and review, AI spend and jobs, an AI kill switch and budget overrides, a sign-up pause, site-wide announcements, and an audit log. See [admin console](docs/ADMIN.md).
- Weekly breakfast/lunch/dinner planner, recipe and whole-week grocery conversion that merges matching lines and leaves off what the pantry has, a household that shares the grocery list, the meal plan and the pantry (saying who added what, keeping members' private recipes private, staying up to date while open, and optionally sharing members' diets and allergies so recipes warn everyone), pantry quantities and expiry reminders, and pantry matching that knows what each ingredient is (cheddar covers cheese, "Zitronen" covers lemon juice), suggests what the pantry goes furthest toward using what expires first, and shops only what's missing. The list, or a recipe's ingredients, can be ordered through Instacart in the US and Canada (when a partner key is set; see [ordering groceries](docs/API.md#ordering-groceries)), and shared as text everywhere.
- Allergy and diet warnings: an ingredient lexicon in the app's nine languages reads every recipe's allergens (the EU's fourteen) and diet conflicts, so recipe pages and cards warn about what a member's diets and allergies leave out, Explore can hide those recipes, and the sous-chef leaves them out of its suggestions. See [allergens, diets and the pantry](docs/API.md#allergens-diets-and-the-pantry).
- A sous-chef built into the places you cook (home, recipe pages, cooking mode, the editor, pantry and planner) rather than a separate AI page: recipe drafts, one-tap adaptations, ingredient swaps, nutrition estimates, meal plans, cooking questions, cover photos, and AI clips of a recipe's steps on request. Durable jobs, visible status/errors, editable results, idempotency, user quotas, and global spend reservations.
- A general sous-chef one tap away on every screen, by text, live voice, or photo: it knows the recipe and cooking step on screen, finds recipes and cooks, manages cookbooks, the planner, groceries, pantry, reviews and profile diets, creates, edits, publishes and deletes recipes (consequential actions need a yes), and drives the app itself: opening recipes, cooking steps, timers, pages and language. See [sous-chef setup and architecture](docs/RECIPE-STUDIO.md).
- Cloudflare Worker serving the web app with the Go API as a Container, R2 storage adapter, Cloudflare Email Service password resets, Neon-compatible migrations, Docker development database/object storage and API build, EAS build profiles, over-the-air app updates through EAS Update, and CI that deploys staging and ships the Android staging app from the `staging` branch.
- Savorly in ChatGPT and Claude: one MCP server searches and shows recipes as cards for anyone, and with a linked account (OAuth 2.1, with Connected apps in My kitchen) saves recipes, plans meals and fills the grocery list. Cooking stays in Savorly: every recipe links to its cooking mode. See [assistants](docs/ASSISTANTS.md).
- Recipe pages with link previews and schema.org data, a sitemap and `robots.txt`, links that open the iOS and Android apps, an installable web app (manifest and icons), privacy, terms and account-deletion pages, a report-only Content-Security-Policy, and optional Cloudflare Web Analytics. See [web pages and app links](docs/DEPLOYMENT.md#web-pages-and-app-links).

Staging runs at [staging.savorly.cooking](https://staging.savorly.cooking) on Cloudflare and Neon, with paid plans off and unlimited free use for testers ([staging](docs/STAGING.md)). Production runs at [savorly.cooking](https://savorly.cooking), deployed from the `release` branch ([production](docs/PRODUCTION.md)). There is no app-store release yet; the remaining launch work is in [PRODUCTION.md](docs/PRODUCTION.md#before-a-public-launch).

## Project layout

```text
apps/mobile/                  Expo iOS / Android / web app (no Expo Router: App.tsx holds navigation)
  App.tsx                     App shell, screen state and links (src/lib/routes.ts), fonts, splash
  src/components/             Shared UI, recipe detail, cooking mode, sous-chef, sign-in, onboarding
  src/screens/                Discovery, kitchen, editor, profile; admin/ is the admin console
  src/lib/                    Typed API client, session state, domain types, design tokens
    auth/                     Apple and Google sign-in (Google's web redirect flow)
    i18n/                     Translator, language detection, and the nine message catalogs
    narration/                Cooking read-aloud players (native and .web twins)
    voice/                    Live voice over WebRTC (native and .web twins)
  modules/storefront/         Local Expo module: the iOS App Store storefront country
  locales/                    Native app name and permission strings per language
  public/                     Web index.html template, manifest, icons, legal pages
  tests/                      Playwright browser tests (web)
services/api/
  cmd/server/                 Startup, graceful shutdown, `server -healthcheck`
  internal/app/               Auth, validation, recipe/kitchen/billing/admin handlers, media, jobs, sous-chef
  internal/ai/                OpenRouter and reAPI adapters + contract tests
  internal/live/              OpenAI GPT-Live voice sessions
  internal/narration/         ElevenLabs narration through OpenRouter, streaming hub
  internal/database/          Embedded versioned SQL migrations and fixture data
infra/cloudflare/             Worker (site.ts helpers, worker.ts), wrangler.jsonc, the API container
infra/seaweedfs/              Local S3 access policy (Docker)
scripts/
  browser-tests.mjs           Runs the browser tests against Expo started from this checkout
  check-services.mjs          Stops `make check` early when Postgres or SeaweedFS isn't running
  deploy.sh                   Deploys staging or production (secrets, web export, Worker, API)
  integration.py              Real API + Postgres integration checks
  loadtest.mjs                Load test against a local API or staging (creates accounts)
  render-brand.mjs            Renders the logo, app icons, web icons and preview image
  serve-dist.mjs              Serves the exported web app like the Worker (browser tests)
  ship-app.mjs                Ships the Android app: an over-the-air update or an EAS build
  web-postbuild.mjs           Adds font preloads and the media preconnect to the web export
docs/                         Setup, deployment, operations, runbooks, design decisions
```

## Verify

```sh
make check            # typecheck, lint, Worker tests, go vet, and every Go test with -race
# API and Expo must be running for these:
npm run test:integration
npm --prefix apps/mobile run test:e2e
npm run build         # web export, then font preloads (scripts/web-postbuild.mjs)
# All three JS/Hermes exports and the Worker/container build (nothing deployed; needs Docker):
cd apps/mobile && npx expo export --platform all && cd ../..
npm --prefix infra/cloudflare run build
```

`make check` runs `npm run typecheck` (the app and the Worker), lint (which rejects warnings), the Worker's helper tests (`npm --prefix infra/cloudflare test`), `go vet`, and `go test -race` with the database and object-storage suites switched on against `make services`: `TEST_DATABASE_URL` defaults to the Compose Postgres and `TEST_S3_ENDPOINT` to SeaweedFS. Those tests use isolated schemas and their own objects, so the development data is safe; point them elsewhere with `make check TEST_DATABASE_URL=…`, and `make check` stops with instructions when the services aren't running. Plain `npm test` runs only `go test ./...` without those settings, so the database and storage suites skip themselves (35 tests today): a quick check, not the full one.

CI doesn't run the browser tests, which took most of its time. The pre-push hook (`.githooks/pre-push`, turned on by `make setup` or `make hooks`) runs them instead when a push brings app changes the remote doesn't have: `node scripts/browser-tests.mjs` starts Expo from the checkout on a free port from 8090 and runs every spec but `smoke.spec.ts`, which needs the real API. `git push --no-verify` or `SKIP_BROWSER_TESTS=1` skips them. Browser tests use Playwright's pinned Chromium once it is installed (`npx playwright install chromium`); until then they fall back to the installed Google Chrome. To check the production bundle, `npm run build` with `EXPO_PUBLIC_API_URL` set, then `node scripts/serve-dist.mjs` serves `apps/mobile/dist` on 8082 for `TEST_WEB_URL=http://localhost:8082 npm --prefix apps/mobile run test:e2e -- smoke.spec.ts splash.spec.ts`. API integration tests create isolated accounts and remove them; run against a development database. Provider tests use local mock servers and do not spend money. CI also runs `govulncheck`, `staticcheck` and an informational `npm audit`. See [contributing](CONTRIBUTING.md).

`make setup` installs both the app and Worker dependencies and turns on the pre-push hook. Browser screenshots go to the ignored `test-results` directory.

For a checkout running on different ports, set `EXPO_PUBLIC_API_URL` when starting Expo and pass matching `TEST_WEB_URL` and `TEST_API_URL` to the browser tests. Set the API's `PORT` and `ALLOWED_ORIGINS` to match. For example, Expo on 8181 with the API on 8180 uses:

```sh
TEST_WEB_URL=http://localhost:8181 TEST_API_URL=http://localhost:8180 npm --prefix apps/mobile run test:e2e
TEST_API_URL=http://localhost:8180 npm run test:integration
```

The [verification record](docs/VERIFICATION.md) has the latest results and the remaining upstream dependency diagnostics.

## Configuration and design decisions

- [Step-by-step provider and account setup](docs/ACCOUNTS.md)
- [R2 and local SeaweedFS storage](docs/STORAGE.md)
- [Plans, pricing and store rules](docs/PRICING.md)
- [Creator fund, verified cooks and payouts](docs/CREATOR-FUND.md)
- [Cook-tested recipes: step timing, questions and privacy](docs/COOK-TESTED.md)
- [Recipe fixes from cooks](docs/RECIPE-FIXES.md)
- [Your version of a recipe and kitchen notes](docs/YOUR-VERSION.md)
- [Family recipes in their own voice](docs/FAMILY-RECIPES.md)
- [Whole-meal timeline: step timing, the scheduler and cooking together](docs/MEAL-TIMELINE.md)
- [Admin console and who can open it](docs/ADMIN.md)
- [Savorly in ChatGPT and Claude](docs/ASSISTANTS.md)
- [Push notifications](docs/NOTIFICATIONS.md)
- [Sign in with Apple and Google](docs/SIGN-IN.md)
- [Deployment and current launch limits](docs/DEPLOYMENT.md)
- [Staging deployment and Android test builds](docs/STAGING.md)
- [Production deployment and releases](docs/PRODUCTION.md)
- [Over-the-air app updates](docs/UPDATES.md)
- [Runbooks: restores, secrets, rollbacks, release gating](docs/RUNBOOKS.md)
- [AI provider choices, pricing, and reliability](docs/PROVIDERS.md)
- [Verification record](docs/VERIFICATION.md)
- [Contributing](CONTRIBUTING.md) and [reporting security problems](SECURITY.md)

Passwords are bcrypt-hashed; opaque session tokens are hashed in Postgres. Browser cookies are HttpOnly, SameSite=Lax, and Secure in production. Every private mutation checks ownership. Cookie mutations require an allowlisted Origin. SQL values are parameterized. AI keys remain server-side; uploads reject active content and generation downloads block private-network addresses.

Developer fixtures use external Unsplash photographs and Pravatar sample avatars. Replace fixture photography/avatars with owned or appropriately licensed production assets. Recipe calories are approximate illustrative values, not verified nutritional analyses.

## License

No license has been chosen yet: the code is published for viewing, and all rights are reserved, so it may not be copied, modified or distributed without the owner's permission. Third-party components keep their own licenses (for example `apps/mobile/assets/LUCIDE-LICENSE.txt`).
