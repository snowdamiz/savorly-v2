import { useEffect } from 'react';

/**
 * Keeps the screen on while the calling component is mounted, through the Screen Wake Lock API
 * where the browser has it. The browser drops the lock whenever the page is hidden, so it is asked
 * for again each time the page comes back.
 */
export function useScreenAwake() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let asking = false;
    let closed = false;
    const request = () => {
      if (closed || asking || document.visibilityState !== 'visible' || (lock && !lock.released))
        return;
      asking = true;
      navigator.wakeLock.request('screen').then(
        (sentinel) => {
          asking = false;
          if (closed) void sentinel.release().catch(() => {});
          else lock = sentinel;
        },
        // Refused (battery saver, a permissions policy): the screen may dim as it normally would.
        () => {
          asking = false;
        },
      );
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', request);
      void lock?.release().catch(() => {});
    };
  }, []);
}
