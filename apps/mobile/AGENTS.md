# Savorly app: notes for AI assistants

This is the Expo app of the Savorly monorepo: iOS, Android and web from one codebase. The same
repository holds the Go API (`services/api`), the Cloudflare Worker that serves the web app and
runs the API (`infra/cloudflare`), scripts and docs. Read the root `README.md` and
`CONTRIBUTING.md` for the layout and the checks.

## Expo has changed: check the docs, not memory

The app uses Expo SDK 57, React Native 0.86, React 19.2 and TypeScript 6.0 (`package.json`). Expo
ships breaking changes every SDK release, so APIs you remember may be renamed, moved or removed.
Before writing code that touches an Expo, EAS or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`.
3. For anything else, fetch https://docs.expo.dev/llms.txt, an index of all Expo docs with
   corrections to common LLM misconceptions, and follow its links; don't answer from memory.

## Commands

The project uses **npm** (there is no bun or yarn lockfile). In `apps/mobile`:

```bash
npx expo install <package>  # add or upgrade a package at the SDK-compatible version
npm run web                 # Expo for the web on 8081; the API runs with `make api` (8080)
npm run typecheck           # tsc --noEmit
npm run lint                # expo lint --max-warnings 0: any warning fails
npm run test:unit           # Jest (jest-expo) unit tests, once each for iOS, Android and web
npm run test:e2e            # Playwright; needs Expo (8081) and the API (8080) running
npx expo-doctor             # dependency and config checks (the react-native-webrtc warning is known)
```

From the repository root: `make check` (both TypeScript projects, lint, the unit tests, the
Worker's tests, `go vet`, and every Go test including the database suites, against
`make services`), `npm run test:integration` (`scripts/integration.py` against a running API) and
`npm run build` (the web export plus `scripts/web-postbuild.mjs`). If `package.json` has a `test`
script, run it too. For other ports, set `EXPO_PUBLIC_API_URL` for Expo, `TEST_WEB_URL` and
`TEST_API_URL` for Playwright (`TEST_API_URL` also for `scripts/integration.py`), and the API's
`PORT` and `ALLOWED_ORIGINS`.

Run typecheck, lint and the tests that cover your change before calling a task done.

## Navigation: state in App.tsx, no Expo Router

- There is no `expo-router` and no `src/app/` directory. Navigation is React state in `App.tsx`:
  the current `screen` (see `screenNames`), the open recipe, the sheets, and `go()`, `open()` and
  `close()`.
- Addresses are parsed and built in `src/lib/routes.ts`: recipe pages are `/recipes/<id>`, public
  cookbooks `/cookbooks/<id>`, screens `/?page=<screen>`. Older `/?recipe=<id>` links are already
  shared, so keep reading them (the web app rewrites them to `/recipes/<id>`). Share links with
  `recipeUrl()` and `cookbookUrl()`.
- On the web, the address bar follows that state through `src/lib/webHistory.ts` (`pushPage`,
  `replacePage`, and `onPageBack`, the one `popstate` listener). Links that should open in a new
  tab use `linkTo()` and `pressedInApp()` with the `link` role.
- Native links arrive through `Linking` (`savorly://…`, and `https://savorly.cooking/recipes/<id>`
  or `/cookbooks/<id>` once a build has the app links) and go through the same handling in
  `App.tsx`.
- Screens that most visits never open (the editor, the recipe studio, onboarding, the admin
  console, the photo crop) load lazily: `React.lazy(chunk(() => import(…)))`, with `chunk()` from
  `src/lib/chunk.ts`, which reloads a web tab onto a newer deploy when one of its chunks is gone.
- Icons come from `src/components/icons.ts`, one module each; ESLint refuses the
  `lucide-react-native` barrel, which would put every icon in the web bundle.
- Dialogs and bottom sheets share one host: `SheetHost` and `Dialog` in `src/components/ui.tsx`.

## Every string is translated

- Show text through `t()` from `useI18n()` (`src/lib/i18n`); keys are the English text.
- Add each new key to all nine catalogs in `src/lib/i18n/locales/` (de, en, es, fr, it, ja, pt,
  ru, zh) with the same `{{placeholders}}`. `tests/localization.spec.ts` fails when a `t()` or
  `tr()` string literal in `App.tsx`, `src/components` or `src/screens` is missing from any
  catalog, or when the catalogs differ.
- Plurals use `count` with `_one`, `_few`, `_many` and `_other` keys. Translate whole sentences,
  not fragments, and never user content such as recipe text or names.
- The admin console (`src/screens/admin`) is English only. Native app names and permission prompts
  live in `locales/*.json`. See `docs/LOCALIZATION.md`.

## Platforms

- `Name.web.tsx` and `name.web.ts` replace `Name.tsx` and `name.ts` on the web: `SocialButtons`,
  `src/lib/narration/player`, `src/lib/voice/transport`. Change both sides.
- The web app is a single-page export (`app.json` `web.output: "single"`) that the Cloudflare
  Worker serves. `public/index.html` is the page template and the rest of `public/` (manifest,
  icons, legal pages) is served from the site root.
- Fonts (Manrope) load through `useFonts` in `App.tsx`; the web build preloads exactly the fonts
  listed there.

## The API

- The app calls the Go API through `api()` in `src/lib/api.ts` (`EXPO_PUBLIC_API_URL` + `/v1`):
  HttpOnly cookies on the web, a bearer token in SecureStore on phones. Shared types are in
  `src/lib/types.ts`, routes in `services/api/internal/app/app.go` and `docs/API.md`, validation in
  `services/api/internal/app/models.go`.
- Installed apps keep calling the API with older code. Never remove or rename routes, fields or
  accepted values a released app uses; add new ones beside them.
- Go side: Fiber v3 handlers on `*App`; errors as `fiber.NewError(status, "A readable message")`,
  which the API returns as `{ "error": … }`; parameterised SQL with pgx; every private query scoped
  to the signed-in user; schema changes as new numbered files in
  `services/api/internal/database/migrations/` (never edit one that shipped); `gofmt`, `go vet`
  and staticcheck. Database tests need `TEST_DATABASE_URL` (`make check` sets it).
- `EXPO_PUBLIC_*` values are built into the bundle, so they are public. Metro caches them with
  its transforms: after changing one, export with `--clear`.

## Native code, builds and updates

- `ios/` and `android/` are generated (Continuous Native Generation) and not committed. Configure
  native behaviour in `app.json`, `app.config.js` (the staging variant) and config plugins; never
  edit the generated folders.
- The runtime version is a fingerprint of everything native. Adding or upgrading a library with
  native code, a config plugin or its options, native settings in `app.json`/`app.config.js`, or
  `eas.json` means a new EAS build; JavaScript-only changes ship as over-the-air updates
  (`docs/UPDATES.md`). Say so when a change is native.
- Expo Go can't run this app (WebRTC, Google sign-in and the local `modules/storefront`). Use a
  development build: `npx expo run:ios|android`, or `npx eas-cli@24.14.0 build --profile development`.
- The EAS CLI is pinned to 24.14.0 (`scripts/ship-app.mjs`, `.github/workflows/ci.yml`). Don't
  run `eas update` by hand for staging or production; `scripts/ship-app.mjs` applies the build
  profile's environment.
- Prefer Expo modules to third-party libraries, and add packages with `npx expo install`.

## Tests

- `src/**/__tests__/*.test.ts(x)` and `modules/**/__tests__` are Jest unit tests (jest-expo
  projects for ios, android and web). `name.test.native.ts` and `name.test.web.ts` run on one
  side only. TypeScript 6 doesn't load `@types/jest` by itself, so each test file starts with
  `/// <reference types="jest" />`.
- `tests/*.spec.ts` are Playwright tests of the web app. Most mock the API with `page.route`;
  `smoke.spec.ts` uses the real API and the local S3 storage. CI also runs the smoke and splash
  specs against the exported bundle (`node scripts/serve-dist.mjs`, port 8082).
- CI runs Playwright in its own pinned Chromium, and local runs use it too once it's installed
  (`npx playwright install chromium`); until then they fall back to the installed Google Chrome,
  with a warning. `PLAYWRIGHT_CHANNEL` picks a browser explicitly.
- Wait on what the page does, not on fixed sleeps: `tests/waits.ts` (`afterPageTimers`,
  `stopsMoving`) and `rendersSettle` in `tests/renderCounts.ts`. `tests/mockApi.ts` is a shared
  in-memory API for new specs.
