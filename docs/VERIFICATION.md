# Verification record

Verified locally on October 2, 2026. These results describe the local implementation, not a public deployment or app-store certification.

| Check | Result |
| --- | --- |
| TypeScript strict type check | Passed |
| Go unit/provider contract tests | Passed |
| Go vet + race detector | Passed |
| Local S3 storage | Passed against SeaweedFS 4.48: signed PNG/MP4 uploads, public byte-for-byte reads, MIME, CORS, byte ranges, and denied anonymous writes/deletes/listing; media also survived a container restart |
| Postgres integration tests | 43 HTTP checks passed |
| Isolated-schema concurrency/recovery tests | Passed: idempotency, conflicting retry rejection, concurrent user quota, global budget across accounts, reset attempt lockout, session revocation, single-use reset codes |
| Playwright desktop/mobile browser tests | 2 scenarios passed; search/filter, recipe detail, serving scaling, cooking steps, registration, saves, groceries, meal planning, publishing, photo upload, MP4 upload, and video playback readiness |
| Expo Doctor | 21/21 checks passed |
| Expo SDK dependency validation | Passed |
| Expo production exports | Web, Android Hermes, and iOS Hermes bundles passed |
| Docker image | Built successfully; container booted, `/health` returned `ok`, and authenticated PNG/MP4 uploads round-tripped through SeaweedFS over the Docker network |
| Cloudflare Worker + static assets | Wrangler dry run passed; nothing published |
| Visual review | Desktop (1440 px) and mobile (390 px); mobile text wrapping and missing fixture image repaired |

Commands for isolated database tests:

```sh
cd services/api
TEST_DATABASE_URL='postgres://savorly:savorly_local_only@localhost:54329/savorly?sslmode=disable' go test -race ./...
```

Tests create a random schema and drop only that test schema. They do not insert paid-generation jobs into the running application's queue or call external providers. CI runs these checks with its own Postgres service and the pinned SeaweedFS container. See [storage verification](STORAGE.md#verification) for local object-store tests.

## What was not verified live

- Funded OpenRouter and reAPI generation: adapters are mock-server tested, but no keys or paid generation were used.
- Neon and Cloudflare R2: code and deployment contracts are present; no cloud credentials were supplied.
- Cloudflare email delivery: recovery state/security and the send request are tested against a local mock; actual delivery needs an onboarded domain and token.
- Signed native binaries and device behavior: iOS/Android JavaScript/Hermes exports passed; no Xcode/Gradle signed build, physical-device test, or store upload was performed.
- Production load, multi-region failover, and a complete external accessibility/security audit.

## Dependency audit

`npm audit fix` was applied without breaking upgrades. The current Expo dependency tree still reports 23 advisory entries (16 high, 7 moderate), stemming from three transitive packages: `braces`, `node-forge`, and an older `uuid` used by `xcode`. These paths primarily involve Metro/Expo build tooling and code-signing utilities. The registry's suggested automatic resolution downgrades Expo to SDK 44 and is not compatible with this project. No blanket force-downgrade was applied. Re-evaluate upstream fixes before production CI/signing; keep development servers private.

Authoritative advisories: [braces stack exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [node-forge signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [uuid bounds checking](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

See [deployment limitations and operational work](DEPLOYMENT.md) for the remaining launch checklist.

## Recipe studio update — 2026-10-03

- Go unit, provider-contract, isolated Postgres integration, and race checks pass, including chat clarification/build, publication review and fresh-response gating, long transcript preservation, idempotency, budget exhaustion, media revisions, manual-edit protection, and crash recovery.
- A real local SeaweedFS test uploads a source photo, verifies anonymous GET returns 403, reads it through authenticated S3 for vision, and verifies deletion through the cleanup outbox.
- Eight Playwright scenarios pass (six new recipe-studio flows plus the two existing smoke flows). New tests exercise chat/resume, automatic photo submission, one-tap voice with a mocked WebRTC peer, mute/device cleanup, unavailable-provider fallback, camera permission failure, and actual Expo Camera capture/retake with a synthetic Chromium camera. Provider responses are mocked; these are not funded AI runs.
- TypeScript passes. Lint has no errors; existing-screen React Compiler diagnostics remain visible as warnings rather than requiring an unrelated redesign refactor. New studio files retain the full lint rule set.
- Web, Android Hermes, and iOS Hermes exports pass. These are JavaScript bundles, not signed native builds.
- Expo Doctor now reports a remaining React Native Directory warning: `react-native-webrtc` is marked untested on New Architecture. The audio peer dependency is installed. The warning is not suppressed; verify the WebRTC native module with an Expo development build and physical devices before launch.
- No OpenAI key or funded OpenRouter/reAPI keys were available. Real GPT-Live voice quality/event ordering, vision accuracy, media generations, native hardware behavior, and cloud storage/deployment remain unverified. See [setup and architecture](RECIPE-STUDIO.md).
- The dependency audit currently reports 24 entries (17 high, 7 moderate), including the pre-existing Expo/toolchain advisories. No breaking force-upgrade was applied.
- Voice-session expiry/automatic renewal is covered by the mocked WebRTC browser test, including device release before reconnecting. The new studio, camera, entry component, and voice transport pass ESLint without warnings.
- Expo native config introspection confirms camera/microphone permission strings. Cloudflare Wrangler's final dry run passes with the exported assets and same-origin device permissions; nothing was deployed.
- The existing real HTTP/Postgres integration suite still passes all 43 checks after the studio migrations.

## Local checks update — 2026-10-15

This update supersedes the older lint, dependency and test-count notes above. Verification used an isolated local application database, the existing local Postgres/SeaweedFS services, and separate API/Expo ports (8180/8181). No external AI providers were called.

- App and Cloudflare Worker TypeScript checks pass. ESLint passes with **zero errors and warnings**, with the former React Compiler rule exceptions removed and `--max-warnings 0` enforced.
- Go vet, race tests, isolated-schema database tests, and public/private object-storage tests pass. The real HTTP integration script passes all **46 checks**, both against the host API and the built Docker container.
- All **53 Playwright tests** pass, including regressions for delayed search responses, automatic AI submission/idempotency and guest sign-in, discarded profile edits, and browser console diagnostics on desktop/mobile. The final icon change also passes the focused console regression.
- Web, Android Hermes and iOS Hermes exports pass. Native config introspection passes, including the Xcode UUID override. These are bundles/config checks, not signed native builds or physical-device tests.
- The Docker API image builds and boots with healthy `/health`. The Cloudflare Worker/container dry run passes via `npm --prefix infra/cloudflare run build`; it explicitly targets the default environment and does not publish.
- Expo SDK dependency validation passes after updating the compatible SDK 57 patches.

To include the opt-in Go suites with the checked-in local service configuration, start `make services`, then run from the repository root:

```sh
set -a
. ./.env
set +a
export TEST_DATABASE_URL="$DATABASE_URL"
export TEST_OBJECT_STORAGE=true
export TEST_S3_ENDPOINT="$S3_ENDPOINT"
make check
```

Use only a local development `.env` for this command: the public storage suite requires the local SeaweedFS endpoint. Tests create and drop isolated database schemas and clean up their test objects. The app and Expo must also be running for `npm run test:integration` and `npm --prefix apps/mobile run test:e2e`.

### Remaining upstream diagnostics

- `npm audit` reports **17 high-severity entries**, all propagated from `braces@3.0.3` and `node-forge@1.4.0`. Both published advisories still list no patched release: [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv). No forced Expo downgrade or audit suppression was applied. The Worker dependency audit is clean.
- Xcode's transitive UUID is pinned to the CommonJS-compatible `11.1.1`, removing its deprecation notice and all seven moderate audit entries. Xcode uses the compatible `uuid.v4()` API; Expo native config introspection validates the resolved dependency.
- A fresh install still reports the ESLint 9 deprecation notice. The current `eslint-plugin-react@7.37.5` and `eslint-plugin-import@2.32.0` shipped through Expo's lint configuration declare ESLint support through version 9; forcing ESLint 10 would violate those peer requirements. See [ESLint version support](https://eslint.org/version-support/).
- Expo Doctor passes **20/21 checks**. The remaining warning is React Native Directory marking `react-native-webrtc` untested on New Architecture. It remains visible pending native-device validation. Only `storefront` is excluded from directory lookup because it is this repository's own local Expo module, not a public package with directory metadata.

The execution environment supplied both `NO_COLOR` and `FORCE_COLOR`, which produces a Node warning in Playwright/Metro child processes. Final runs used `env -u NO_COLOR` to resolve that environment conflict; no warning filters were added to the app or tests.

## Performance and splash review — 2026-10-16

Reviewed startup, discovery/search, shared state refreshes, cookbook/planner/pantry mutations,
recipe/creator projections and their indexes, and recipe-to-grocery conversion. The following
regressions were reproduced before fixing the implementation:

| Work measured | Before | After |
| --- | --- | --- |
| Recipe-list requests on Home without a search | 2 | 1 |
| Requests per save/unsave, including the mutation | 3 | 2 |
| Requests per follow/unfollow, including the mutation | 5 | 3 |
| Requests to add recipe groceries, including the mutation | 3 | 2 |
| Grocery handler SQL calls for 1 / 20 / 80 ingredients | 4 / 23 / 83 | 2 / 2 / 2 |
| Rows examined per save/follower count in the selective fixture | 10,010 | 10 |

Home now enables server search only while displaying search results or Explore. Mutation handlers
refresh the affected library, kitchen or creator data; full refreshes remain for startup, reload,
recipe edits and assistant actions that can change several resources. Grocery insertion uses one
atomic `INSERT ... SELECT FROM unnest(...)`. Migration `014_social_count_indexes.sql` adds the
reverse lookup indexes missing from the user-first primary keys on saves and follows.

`services/api/internal/app/performance_test.go` counts SQL through a pgx tracer and checks real
Postgres `EXPLAIN ANALYZE` plans with 10 matching and 10,000 unrelated rows in each social table.
The grocery count includes its read and transaction commands, but excludes authentication
middleware. Tests also verify scaled quantities, ownership, invalid/private/missing recipes and
all-or-nothing insertion on a forced constraint failure. These are work-count improvements, not
claims about production latency.

The splash previously remounted between font, language and data loading. It also kept its hop and
blink loops alive after returning `null`. One overlay now stays mounted outside those loading
stages, measures its minimum duration from mounting, and unmounts its animated child after fading.
`apps/mobile/tests/splash.spec.ts` holds fonts and API responses independently, asserts that the
same splash DOM element remains fully opaque until data is released, then verifies dismissal
and zero further animation callbacks once page-entry animations settle. Both desktop and mobile
with reduced motion pass. Mobile splash and Home screenshots were also inspected.

Validation used an isolated local Postgres on port 55439, API on 8188, Expo on 8189, and the
existing local SeaweedFS service. No external AI providers were called.

- Both TypeScript projects and mobile ESLint pass with zero errors/warnings.
- `go test -race ./...` with `TEST_DATABASE_URL` and `go vet ./...` pass; opt-in public/private
  object-storage tests also pass. The final performance fixtures pass separately under `-race`.
- All 46 real HTTP integration checks pass.
- All 62 Playwright cases have passing results: the full run passed 60, then the two failed
  assertions were corrected and passed with `--last-failed`. The Google redirect expectation now
  respects `TEST_WEB_URL`; the grocery test checks the visible completed-item count rather than
  relying on React Native Web's unmapped `accessibilityState.checked` prop.
- `npx expo export --platform all` passes for web and iOS/Android Hermes. Native exports are
  compile checks; the splash transition has not been verified on a physical native device.

Focused regressions can be rerun with a local database and running Expo server:

```sh
cd services/api
TEST_DATABASE_URL='<local-postgres-url>' go test -race ./internal/app -run 'TestRecipeGroceriesConstant|TestSocialCounts' -v
cd ../../apps/mobile
TEST_WEB_URL=http://localhost:8189 npm run test:e2e -- tests/performance.spec.ts tests/splash.spec.ts
```

### Client render follow-up

The initial pass counted network and database work but did not measure React renders. A second
pass instrumented committed renders in the running development app with a 24-recipe Explore
grid. Both new regressions failed before the rendering changes and pass afterwards:

| Interaction | Before | After |
| --- | --- | --- |
| Save one recipe: recipe-card renders | 48 | 0 |
| Save one recipe: grid renders | 2 | 0 |
| Toast expires: recipe-card renders | 24 | 0 |
| Toast expires: Shell / Discover renders | 1 / 1 | 0 / 0 |

The shared app context previously included the transient toast message. Showing or clearing it
invalidated every app-context consumer. Notifications now have separate message and stable
dispatch contexts; only toast presenters subscribe to message changes. Recipe cards and grids
use React's default shallow memoization, and the recipe-opening callback is stable. Actual library
updates still reach bookmark controls; saving, unsaving and failed-save rollback remain tested.

`apps/mobile/tests/renderCounts.ts` uses the installed React DevTools backend's committed-render
flag and unchanged-child bailout rules. Positive controls assert that the probe observes initial
screen and card renders, then the tests assert zero unnecessary renders after interaction. They
also verify the bookmark label, toast dismissal and the correct recipe opening. This test helper
depends on React internals and must be reviewed when React is upgraded; production code has no
instrumentation. These are measured render counts on web, not native-device frame-rate claims.

After these changes, the complete Playwright suite passes **64/64 in one run** (2.8 minutes),
including sign-in, localization, recipe editing, failed-save rollback and both splash cases.
Both TypeScript projects, mobile ESLint and the production web export pass. The native export
and backend results above belong to the initial pass; this follow-up changes only client code.

## Web pages, operations and CI — 2026-10-16

Covers the Worker's new pages and headers, the container image, CI and the scripts. Checked on a
private Postgres container (not the development database), the local SeaweedFS, the API on 8094,
and `wrangler dev` on 8095; nothing was deployed and no AI provider was called.

- `npm --prefix infra/cloudflare test`: 18 Node tests of the pure helpers (escaping, JSON-LD,
  sitemap, robots, app-link files, CSP and its reports, settings fingerprints) pass, as do both
  TypeScript projects and mobile ESLint.
- The real `worker.ts` under `wrangler dev`, with the container binding proxied to the local API:
  recipe pages and `/?recipe=` links carry one title, the preview tags and valid JSON-LD; unknown
  recipes and a 6-second API answer the plain app after 4 seconds and fill the cache for the next
  request; the sitemap lists the home page and 12 recipes, is cached, and answers 503 when the API
  fails; `robots.txt`, the app-link files and their staging and unset forms, `/csp-report`, the
  analytics beacon, immutable caching of hashed assets, the www redirect and the cron warm-up behave
  as documented. The smoke and splash specs pass through it, and a browser visiting every page
  reported no CSP violations; a forced one reached `/csp-report` and the log.
- With the real container under `wrangler dev` (Docker): the warm-up leaves a container alone when
  its settings match, and restarts it gracefully (exit 0, healthy again) when they don't. Worker-only
  vars stay out of the container's environment.
- `npm run build` exports `public/` into `dist/` (index template, manifest, icons, legal pages)
  and preloads exactly the five fonts `useFonts` loads; with long-lived caching the browser reuses
  those preloads (5 font requests rather than 9). An export reuses Metro's cached transforms even
  when `EXPO_PUBLIC_API_URL` changes, which is why `deploy.sh` exports with `--clear`.
- The smoke and splash specs pass against the exported bundle served by `scripts/serve-dist.mjs`,
  as CI now runs them.
- `docker build services/api` produces the distroless image (nonroot, 28 MB); it starts against
  Postgres and its `HEALTHCHECK` reports healthy. `server -healthcheck` exits 0, or 1 with no server.
  `npm --prefix infra/cloudflare run build` and the staging dry run pass.
- `make check` with `TEST_DATABASE_URL` pointing at the private database runs every Go suite: none
  skip (35 do without the settings), and it stops with instructions when Postgres isn't answering.
- `govulncheck@v1.9.0` finds nothing reachable with Go 1.26.9, the patch CI now installs (Go 1.26.4
  reports 15 standard-library issues); golang.org/x/net v0.58.0 and x/crypto v0.57.0 have advisories
  the code doesn't call. `staticcheck@v0.8.2` passes, with ST1005 off for `internal/live` only.
  `actionlint@v1.7.12` passes the workflow, and both YAML files parse.
- `scripts/loadtest.mjs`: 20 users, 5 at a time, against the API image limited to a quarter CPU and
  1 GiB: sign-up p50 6.9 s (p95 8.6 s), sign-in 6.1 s, deletion 5.3 s, listing 114 ms, photo upload
  210 ms, all accounts deleted afterwards. One user at a time: about 0.7 s per sign-up or sign-in.

## Review implementation — 2026-10-16

Covers the changes made for [the October 16 review](REVIEW-2026-10-16.md). Checked against the
local Postgres (a `savorly_test` database for the Go suites and `savorly_review` for the running
API, never the development database), the local SeaweedFS, the API on 8097 and Expo on 8099.
Nothing was deployed, and no AI provider, Stripe, Turnstile or email service was called.

| Check | Result |
| --- | --- |
| `gofmt`, `go vet`, `go test -race ./...` with the database and storage suites | Passed (ai, app, database, live, narration) |
| `staticcheck@v0.8.2` | Passed |
| `govulncheck@v1.9.0` | Nothing reachable with Go 1.26.9, the patch CI and the image build use. Go 1.26.4 reports standard-library issues only, and `golang.org/x/crypto/openpgp`, which the API doesn't import, has an advisory with no fix |
| Migrations 015–023 | Applied in order to a database at 014 by the running API, and from scratch by every Go suite |
| Jest unit tests (`npm --prefix apps/mobile run test:unit`) | 72 suites, 612 tests, each run as iOS, Android and web |
| Both TypeScript projects, mobile ESLint | Passed, no warnings |
| Worker tests (`npm --prefix infra/cloudflare test`) | 21 passed |
| Playwright, Expo dev server | 207 of 207 (one run of 206, plus the one spec fixed after it), in Google Chrome. The smoke, splash, click-through and image specs also pass against the exported bundle served by `scripts/serve-dist.mjs` |
| `scripts/integration.py` | 60 checks passed |
| Web export (`npm run build`) | Main bundle 2.56 MB (665 KB gzipped), down from 4.95 MB (959 KB) before the icon and polyfill changes. The editor, recipe studio, onboarding, admin console and photo crop load as separate chunks, and the post-build step preloads the five fonts |
| iOS and Android Hermes exports | Passed (4.2 MB each) |
| `docker build services/api` | 32.1 MB distroless image running as nonroot, with its health check. It starts against the review database and answers `/health` and `/v1/recipes` |

- **Fixed sleeps are gone from the specs the review named.** `splash`, `performance`, `offline`,
  `telemetry`, `home` and `recipe-studio` now wait on conditions: the page's own timers
  (`tests/waits.ts`), animation frames stopping, React commits settling
  (`rendersSettle` in `tests/renderCounts.ts`), or what the page stored. Render counts are hard
  assertions. `smoke.spec.ts` takes its recipes from the API and checks that storage serves each
  upload rather than matching `localhost:8333`. `accounts.spec.ts` gives each test its own user.
  Each changed spec passed two or three repeated runs.
- **New specs cover the flows the review listed as untested:** password sign-in, the reset code,
  sign-out, account deletion, editing and deleting a recipe, a new cookbook, planner weeks, pantry
  dates, the review and report dialogs, admin member, recipe and operations actions, and offline
  retry. Writing them found that a wrong password on `DELETE /me` was a `401`, which signed the
  cook out; it is now a `403` like the other password checks.
- **Native components have Jest tests** (`SocialButtons`, `PhotoCrop`, `RecipeCamera`,
  `VideoPlayer`). They found that the camera kept asking for Settings after the permission was
  granted there on Android, and that a failed start's error stayed under a working camera; both are
  fixed. Jest also couldn't load the store on Android (expo-notifications' native modules); the
  shared setup now stubs it.
- **Later additions, each with tests:** the library comes paged (`GET /library?limit=24`, with
  `ownIds` and `publishedCount`), and My kitchen pages through the cook's recipes; recipe pages
  have a heading outline, and a desktop recipe page hides the screen under it from screen readers;
  photos show a blurred preview from their host while loading; steps can carry a short clip
  (migration 023); the last narrated recipes play from the device when the API can't be reached.
- **Layers over the page let clicks through on the web.** React Native Web drops an inline
  `pointerEvents: 'box-none'`, so the phone tab bar's strip and the desktop carousels' faded edges
  blocked the page under them. `tests/pass-through.spec.ts` fails on the old code and passes now.
- **Two phone bugs reported during the work.** A sheet's list (the language list, the sous-chef's
  history) couldn't be scrolled back up after a scroll: on iOS the sheet's drag gesture claimed
  the touch before the list could, so its content drag is now only enabled while the list is at its
  top. And the status bar's shadow could stay on a new page: a page change now resets the scroll
  value along with the scroll. Both are reasoned from the gesture library's iOS code and React
  Native's scroll events; the phone-sized web suite passes, but neither was tried on a device.
- **Not verified here:** push notifications on devices (FCM and APNs keys, a development build),
  app links on devices (`APPLE_TEAM_ID`, `ANDROID_CERT_SHA256`), Turnstile with real keys, R2 CORS,
  email delivery, Stripe, funded AI providers, and signed native builds.
