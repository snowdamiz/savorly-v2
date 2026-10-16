import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Whether this device has seen the first-launch welcome. Phones greet a first launch with
// language and sign-up choices; the web opens straight onto the recipes (often from a shared
// link), with the language taken from the browser. Unknown (null) until storage answers.
const KEY = 'savorly.welcomed';
let welcomed: boolean | null = Platform.OS === 'web' ? true : null;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
  welcomed = next;
  listeners.forEach((l) => l());
};
if (Platform.OS !== 'web')
  AsyncStorage.getItem(KEY)
    .then((v) => welcomed === null && set(v === '1'))
    .catch(() => welcomed === null && set(true));

export function useWelcomePending() {
  return (
    useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      () => welcomed,
      () => welcomed,
    ) === false
  );
}

export function finishWelcome() {
  if (welcomed === true) return;
  set(true);
  if (Platform.OS !== 'web') void AsyncStorage.setItem(KEY, '1').catch(() => {});
}

/** Shows the welcome again, as on a new device (also on the web, for this visit), to try it. */
export function replayWelcome() {
  set(false);
  if (Platform.OS !== 'web') void AsyncStorage.removeItem(KEY).catch(() => {});
}
