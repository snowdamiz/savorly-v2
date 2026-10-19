# Over-the-air updates

The Android and iOS apps receive JavaScript, styling, translation and image changes over the air with [EAS Update](https://docs.expo.dev/eas-update/introduction/), without a new build or app-store review. Anything native still needs a build: adding or upgrading a library with native code, a config plugin or its options, native settings in `app.json`, `eas.json`, or the Expo SDK. The web app is unaffected; each deploy serves the latest export.

| Piece           | Where                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Channels        | Each profile in [eas.json](../apps/mobile/eas.json) has one: `staging`, `production`, `preview`, `development`. A build only receives updates published to its channel                     |
| Runtime version | `fingerprint` policy in [app.json](../apps/mobile/app.json): a hash of everything native. An update only reaches builds with the same hash, so it never runs against the wrong native code |
| Publishing      | [scripts/ship-app.mjs](../scripts/ship-app.mjs), run by CI on pushes to `staging` and `release` after the backend deploys ([ci.yml](../.github/workflows/ci.yml))                          |
| In the app      | [src/lib/updates.ts](../apps/mobile/src/lib/updates.ts) and [src/components/AppUpdates.tsx](../apps/mobile/src/components/AppUpdates.tsx)                                                  |

## How the app updates

1. At launch the app asks its channel for a newer update and downloads it in the background, without delaying startup. It asks again whenever it returns to the foreground (at most once a minute), since phones rarely relaunch an app.
2. Once downloaded, a banner says **A new version of Savorly is ready** with **Restart**. Without a restart, the update runs from the next launch.
3. **Settings → App updates** shows the running version: the date it was published, or **Installed version** for the code built into the app, plus the channel and the first characters of the update ID as listed on expo.dev. Tapping it checks now, or restarts into a downloaded update.

If an update crashes the app on launch, expo-updates goes back to the previous working update by itself. Development builds, Expo Go and the web load code from the bundler, so all of this is off there.

## Shipping

```sh
npm run ship-app:staging      # or ship-app:production; --dry-run only says which it would do
```

The script computes the profile's fingerprint for Android. If EAS has a build of that profile with the same runtime version (queued, building or finished), it publishes the current JavaScript as an update to the profile's channel. If not, the native code changed, and it queues a build instead (`--no-wait`; it appears on expo.dev). The first push after a native change therefore builds, and every JavaScript-only push after it updates.

Don't run `eas update` by hand for staging or production. It ignores a build profile's `env` in eas.json, so the bundle would call `http://localhost:8080`, and a staging update would get a different runtime version than staging builds. The script passes the profile's `env` on.

CI only ships Android, matching the builds. iOS builds would need the same, with `platform` set in the script.

The EAS CLI version is pinned: `eas-version` in [ci.yml](../.github/workflows/ci.yml) and `easCli` in the script (24.14.0, used by the commands on this page too). Bump them together.

## Rolling back

- **Fastest:** `npx eas-cli@24.14.0 update:rollback` in `apps/mobile`, then pick the update. It republishes the update before it, or the build's own code if there was none. Phones pick it up on their next check. `update:republish --group <id>` brings back a particular earlier update ([runbooks](RUNBOOKS.md#roll-back-a-release)).
- **Through git:** revert the change on `main` and push it to `staging` (or `release`) again. CI publishes the reverted code as a new update.

## Try it on staging

1. **Get a build with updates in it.** Builds made before EAS Update was set up never receive updates. Push `main` to `staging` (`git push origin main:staging`). The new fingerprint makes CI queue a staging build, or start one yourself with `npx eas-cli@24.14.0 build --platform android --profile staging` in `apps/mobile`.
2. **Install it** from the build page on expo.dev, over the old Savorly Staging. **Settings → App updates** reads **Installed version** and the `staging` channel.
3. **Change some JavaScript** (a string, a color), merge it to `main`, and push `main:staging` again. In the GitHub run, **Ship Android app** says it ships as an update; the update appears on expo.dev under **Updates**, on the `staging` branch.
4. **Open the app** (or bring it back to the foreground). Within a few seconds the banner offers **Restart**. Afterwards **App updates** shows the update's date and ID.

To publish from your machine instead of CI: `npm run ship-app:staging` (after `eas login`).

## Things to know

- `eas.json` is part of the fingerprint, so editing it, even just a URL in a profile's `env`, means the next push builds instead of updating.
- An update only replaces the JavaScript bundle and assets. A change that needs a new API endpoint is safe because CI deploys the backend first; one that needs a new native module or permission waits for a build because the fingerprint changes.
- Updates count against the EAS plan's update usage (monthly active users and bandwidth), not its build quota. Staging pushes now use a build only when native code changes.
