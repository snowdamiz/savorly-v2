import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import * as Updates from 'expo-updates';

// Over-the-air updates (docs/UPDATES.md). Release builds check their EAS channel at launch and
// download in the background; the update runs from the next launch, or sooner when the cook
// taps Restart. Web, Expo Go and development builds run the bundler's code, so the API is off
// there (the web stub would otherwise report itself enabled).
export const updatesSupported = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled;

const FOREGROUND_CHECK_INTERVAL = 60_000;
let lastCheck = 0;

/** Downloads a newer update if the channel has one; resolves whether there was one. */
export async function checkForUpdate() {
  lastCheck = Date.now();
  const result = await Updates.checkForUpdateAsync();
  if (result.isAvailable) await Updates.fetchUpdateAsync();
  return result.isAvailable;
}

/** Phones rarely relaunch an app, so also check whenever it returns to the foreground. */
export function useForegroundUpdateChecks() {
  useEffect(() => {
    if (!updatesSupported) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastCheck > FOREGROUND_CHECK_INTERVAL) {
        checkForUpdate().catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);
}
