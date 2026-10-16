# Savorly

A cooking community for good recipes, everyday inspiration, and a little AI help. Built with **Expo / React Native + TypeScript, Go Fiber v3, PostgreSQL, Cloudflare Workers / R2, OpenRouter, and Seedance 2.5 through reAPI**.

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

- Recipe discovery, ingredient/text search, cuisine/diet/time filters, and creator profiles.
- Nine interface languages with automatic device/browser detection, a saved language choice in My kitchen, and localized dates and quantities. See [localization](docs/LOCALIZATION.md).
- Account registration/login/logout, Sign in with Apple (iOS, web) and Google (iOS, Android, web), secure persistent sessions, editable profiles, dietary preferences, password recovery integration, and account deletion. See [sign-in](docs/SIGN-IN.md).
- A first-launch welcome on phones (language, then join, sign in or look around) and a skippable kitchen setup for every new account: photo, name and username, food preferences, and cooks to follow.
- Profile photos taken with the camera or chosen from the library (cropped square and resized on the device), changed by tapping the photo in My kitchen, and an optional AI touch-up (GPT Image 2.5 Sunburst) that improves light, color and focus while keeping the person the same, with a before/after comparison. Uploaded recipe photos get the same touch-up, keeping the dish, plating and portions.
- Free, Plus and Pro plans sold through Stripe on the web, with per-member allowances and AI spend ceilings that keep every plan cash-flow positive, and no app-store commission. See [pricing](docs/PRICING.md).
- Recipe creation, editing, private drafts, device draft autosave, ingredient and instruction editors, optional uploaded photos/video, and AI disclosure.
- Serving scaling, ingredient checklists, guided cooking, step timers, spoken instructions, video playback, and recipe sharing.
- ElevenLabs v4 Turbo cooking narration through OpenRouter with streamed audio, shared caching, next-step preloading, and device-speech fallback. See [setup and playback details](docs/COOKING-NARRATION.md).
- Saved recipes and named cookbooks, follows, ratings/reviews, and content reports.
- An admin console for owners and appointed admins: a moderation queue, member management (suspension, complimentary plans, sign-out, deletion), every recipe and review, AI spend and jobs, an AI kill switch and budget overrides, a sign-up pause, site-wide announcements, and an audit log. See [admin console](docs/ADMIN.md).
- Weekly breakfast/lunch/dinner planner, recipe-to-grocery conversion, checked grocery lists, pantry quantities and expiry reminders, and pantry-to-recipe matching.
- A sous-chef built into the places you cook (home, recipe pages, cooking mode, the editor, pantry and planner) rather than a separate AI page: recipe drafts, one-tap adaptations, ingredient swaps, nutrition estimates, meal plans, cooking questions, cover photos, and Seedance video clips. Durable jobs, visible status/errors, editable results, idempotency, user quotas, and global spend reservations.
- A general sous-chef one tap away on every screen, by text, live voice, or photo: it knows the recipe and cooking step on screen, finds recipes and cooks, manages cookbooks, the planner, groceries, pantry, reviews and profile diets, creates, edits, publishes and deletes recipes (consequential actions need a yes), and drives the app itself: opening recipes, cooking steps, timers, pages and language. See [sous-chef setup and architecture](docs/RECIPE-STUDIO.md).
- Cloudflare Worker serving the web app with the Go API as a Container, R2 storage adapter, Cloudflare Email Service password resets, Neon-compatible migrations, Docker development database/object storage and API build, EAS build profiles, over-the-air app updates through EAS Update, and CI that deploys staging and ships the Android staging app from the `staging` branch.

Staging runs at [staging.savorly.cooking](https://staging.savorly.cooking) on Cloudflare and Neon, with paid plans off and unlimited free use for testers ([staging](docs/STAGING.md)). Production runs at [savorly.cooking](https://savorly.cooking), deployed from the `release` branch ([production](docs/PRODUCTION.md)). There is no app-store release yet; the remaining launch work is in [PRODUCTION.md](docs/PRODUCTION.md#before-a-public-launch).

## Project layout

```text
apps/mobile/                  Expo iOS / Android / web app
  src/components/             Shared UI, media player, recipe detail, cooking mode
  src/screens/                Discovery, kitchen, editor, profile/community
  src/lib/                    Typed API, session state, domain types, design tokens
services/api/
  cmd/server/                 Lifecycle and graceful shutdown
  internal/app/               Auth, validation, recipe/kitchen HTTP handlers, media, jobs
  internal/ai/                OpenRouter and reAPI adapters + contract tests
  internal/database/          Embedded versioned SQL migrations and fixture data
infra/cloudflare/             Worker + static assets deployment
infra/seaweedfs/              Local S3 access policy (Docker)
scripts/integration.py        Real API + Postgres integration checks
```

## Verify

```sh
npm run typecheck
npm --prefix apps/mobile run lint
npm test
# API and Expo must be running for these:
npm run test:integration
npm --prefix apps/mobile run test:e2e
npm run build
# All three JS/Hermes exports and the Worker/container build (nothing deployed):
cd apps/mobile && npx expo export --platform all && cd ../..
npm --prefix infra/cloudflare run build
```

Browser tests use installed Google Chrome locally and Playwright Chromium in CI. API integration tests create isolated accounts and remove them; run against a development database. Provider tests use local mock servers and do not spend money. `make check` additionally runs Go vet and the race detector.

`make setup` installs both the app and Worker dependencies; `npm run typecheck` checks both projects. Lint rejects warnings. Browser screenshots go to the ignored `test-results` directory.

For a checkout running on different ports, set `EXPO_PUBLIC_API_URL` when starting Expo and pass matching `TEST_WEB_URL` and `TEST_API_URL` to the browser tests. Set the API's `PORT` and `ALLOWED_ORIGINS` to match. For example, Expo on 8181 with the API on 8180 uses:

```sh
TEST_WEB_URL=http://localhost:8181 TEST_API_URL=http://localhost:8180 npm --prefix apps/mobile run test:e2e
TEST_API_URL=http://localhost:8180 npm run test:integration
```

Database and object-storage Go tests are opt-in: see the [current verification record](docs/VERIFICATION.md#local-checks-update--2026-10-15) for their environment and remaining upstream dependency diagnostics.

## Configuration and design decisions

- [Step-by-step provider and account setup](docs/ACCOUNTS.md)
- [R2 and local SeaweedFS storage](docs/STORAGE.md)
- [Plans, pricing and store rules](docs/PRICING.md)
- [Admin console and who can open it](docs/ADMIN.md)
- [Sign in with Apple and Google](docs/SIGN-IN.md)
- [Deployment and current launch limits](docs/DEPLOYMENT.md)
- [Staging deployment and Android test builds](docs/STAGING.md)
- [Production deployment and releases](docs/PRODUCTION.md)
- [Over-the-air app updates](docs/UPDATES.md)
- [AI provider choices, pricing, and reliability](docs/PROVIDERS.md)
- [Verification record](docs/VERIFICATION.md)

Passwords are bcrypt-hashed; opaque session tokens are hashed in Postgres. Browser cookies are HttpOnly, SameSite=Lax, and Secure in production. Every private mutation checks ownership. Cookie mutations require an allowlisted Origin. SQL values are parameterized. AI keys remain server-side; uploads reject active content and generation downloads block private-network addresses.

Developer fixtures use external Unsplash photographs and Pravatar sample avatars. Replace fixture photography/avatars with owned or appropriately licensed production assets. Recipe calories are approximate illustrative values, not verified nutritional analyses.
