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
