## What and why

<!-- What changes for cooks (or for us), and why. Link the issue or review item. -->

## Checks

<!-- CI runs these too (.github/workflows/ci.yml), except the browser tests, which the pre-push hook runs; tick what you ran locally. -->

- [ ] `make check`: typecheck, lint (no warnings), Worker tests, `go vet`, every Go test
- [ ] `npm run test:integration` and `npm --prefix apps/mobile run test:e2e` with the API and Expo running
- [ ] `npm run build`, and `npm --prefix infra/cloudflare run build` for Worker, wrangler or Dockerfile changes
- [ ] New or changed UI text is in all nine catalogs (`apps/mobile/src/lib/i18n/locales/`)
- [ ] Tried on a phone-sized and a desktop-sized screen, if the UI changed

## Compatibility and release

- [ ] Apps already installed keep working: no removed or renamed routes, fields or values they use
- [ ] Schema changes are a new migration; none edited
- [ ] Native change (library, config plugin, `app.json`/`app.config.js`, `eas.json`)? It needs a new build, not an over-the-air update: say so here
- [ ] New settings are in the `.env*.example` files or `wrangler.jsonc`, and in the docs
- [ ] Docs updated
