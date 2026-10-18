# Contributing

Savorly is one Expo app (`apps/mobile`: iOS, Android and web), one Go API (`services/api`) and
one Cloudflare Worker (`infra/cloudflare`). The [README](README.md) has the layout; `docs/` has
the details. The project has no open-source license yet, so ask before starting substantial work.

## Set up

You need Node 22.13 or newer (Node 22 LTS), npm, Go 1.26, Docker, and Python 3 for the HTTP
integration checks.

```sh
make setup      # npm ci for the app and the Worker, go mod download, .env, the pre-push hook
make services   # Postgres on 54329 and SeaweedFS (S3) on 8333, in Docker
make api        # the API on 8080 (its own terminal)
make web        # Expo for the web on 8081 (its own terminal)
```

Expo Go can't run the app on a phone: it has its own native code (WebRTC, Google sign-in, a
storefront module). Use a development build: `npx expo run:ios`/`run:android`, or
`npx eas-cli build --profile development`.

## Checks

CI ([ci.yml](.github/workflows/ci.yml)) runs all of these but the browser tests on every pull
request; run them before you open one:

```sh
make check                               # typecheck (app and Worker), lint, Worker tests, go vet, every Go test
npm run test:integration                 # HTTP checks against the running API (scripts/integration.py)
npm --prefix apps/mobile run test:e2e    # Playwright against Expo on 8081 and the API on 8080
npm run build                            # the web export, with font preloads (scripts/web-postbuild.mjs)
npm --prefix infra/cloudflare run build  # Worker and API image dry run; needs Docker, uploads nothing
```

- Lint runs with `--max-warnings 0`: a warning fails it.
- `make check` runs the Go database and object-storage suites against `make services`, and stops
  with instructions if those aren't running. Plain `npm test` runs only the Go tests that need
  neither (README).
- The browser tests run before a push instead of in CI: the pre-push hook (`make hooks`) runs
  `node scripts/browser-tests.mjs` when the push changes `apps/mobile`, against Expo started from
  the checkout, with spec files side by side on half the cores (`TEST_WORKERS` sets another
  number). `git push --no-verify` or `SKIP_BROWSER_TESTS=1` skips it.
- CI also runs `govulncheck` and `staticcheck` (versions pinned in ci.yml; run them in
  `services/api` with `go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...` and
  `go run honnef.co/go/tools/cmd/staticcheck@v0.8.2 ./...`) and an informational `npm audit`.
- Running on other ports: README, "Verify".

## Conventions

- **Every string in the app is translated.** Show text through `t()` from `useI18n()` and add each
  new key to all nine catalogs in `apps/mobile/src/lib/i18n/locales/`, keeping its `{{placeholders}}`.
  `tests/localization.spec.ts` fails when a `t()`/`tr()` literal in `App.tsx`, `src/components` or
  `src/screens` is missing from any catalog ([localization](docs/LOCALIZATION.md)).
- **Migrations only move forward.** A schema change is a new numbered file in
  `services/api/internal/database/migrations/`, applied at startup. Never edit one that has been
  merged.
- **Older apps keep calling the API.** Installed apps run their JavaScript until they update, and a
  native build changes only through the stores. Don't remove or rename routes, fields or accepted
  values a released app uses; add new ones beside them, and keep old links (`/?recipe=`,
  `/?page=`) working. CI deploys the backend before it ships the app, so new endpoints exist first.
- **Native changes need a new build.** Adding or upgrading a library with native code, a config
  plugin or its options, native settings in `app.json`/`app.config.js`, or `eas.json` changes the
  app's fingerprint: the next push to `staging` or `release` queues an EAS build instead of an
  over-the-air update ([updates](docs/UPDATES.md)). Mention it in the pull request.
- **Platform twins.** `Name.web.tsx` and `name.web.ts` replace `Name.tsx` and `name.ts` on the
  web (sign-in buttons, narration player, voice transport). Change both.
- **Expo packages.** Add them with `npx expo install <package>` so versions match the SDK, and
  upgrade the SDK as a whole.
- **Dependency updates are by hand** (there's no Dependabot): `npx expo install --check` for what
  the SDK manages, `npm outdated` in `apps/mobile` and `infra/cloudflare`, and `go list -u -m all`
  in `services/api`. CI's `govulncheck` and `npm audit` steps report vulnerable dependencies.
- **Secrets stay out of git.** Only the `.env*.example` files are committed. `EXPO_PUBLIC_*`
  values are built into the app, so they are public.
- **Docs follow the code.** Update `docs/` in the same pull request as the behaviour it describes.
- Formatting: Prettier (`.prettierrc.json`) for TypeScript, JavaScript and Markdown; `gofmt` for Go.

## Pull requests

Branch from `main` and keep each pull request to one change; the template has the checklist.
`main` only runs checks; `staging` and `release` deploy ([staging](docs/STAGING.md),
[production](docs/PRODUCTION.md)). Security problems go through [SECURITY.md](SECURITY.md), not
issues.
