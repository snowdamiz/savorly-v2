import { useSyncExternalStore } from 'react';
import * as Speech from 'expo-speech';

/** Text for device speech, in the language (BCP-47) to read it in. */
export type Spoken = { text: string; language: string };

/** How long device speech might take to say parts, with room: past this it counts as done. */
export function speakingTime(parts: Spoken[]) {
  const chars = parts.reduce((n, part) => n + part.text.length, 0);
  // Japanese and Chinese say fewer characters a second.
  const slow = parts.some((part) => /^(ja|zh)/i.test(part.language));
  return Math.min(45_000, 1500 + chars * (slow ? 160 : 80));
}

/**
 * Speaks parts one after another with the device's voice, which is free and works offline.
 * `done` resolves when the last has been said, stopped or failed, or, since some browsers never
 * report the end, once it should have finished.
 */
export function say(parts: Spoken[]) {
  let over = false;
  let resolve = () => {};
  const done = new Promise<void>((r) => (resolve = r));
  const finish = () => {
    if (over) return;
    over = true;
    clearTimeout(guard);
    resolve();
  };
  const guard = setTimeout(finish, speakingTime(parts));
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    Speech.speak(part.text, {
      language: part.language,
      ...(last ? { onDone: finish, onStopped: finish, onError: finish } : {}),
    });
  });
  if (!parts.length) finish();
  return {
    done,
    cancel: () => {
      if (!over) void Speech.stop();
      finish();
    },
  };
}

// Whether a live sous-chef call is running (RecipeStudio reports it). Hands-free cooking pauses for
// the call, which needs the microphone and does the listening itself.
let liveCall = false;
const listeners = new Set<() => void>();
export function reportLiveCall(live: boolean) {
  if (live === liveCall) return;
  liveCall = live;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const useLiveCall = () =>
  useSyncExternalStore(
    subscribe,
    () => liveCall,
    () => liveCall,
  );
