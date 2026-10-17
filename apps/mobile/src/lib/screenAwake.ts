import { useEffect } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

let next = 0;
/** Keeps the screen on while the calling component is mounted, as cooking mode needs. */
export function useScreenAwake() {
  useEffect(() => {
    const tag = `savorly-awake-${++next}`;
    let active = true;
    void activateKeepAwakeAsync(tag)
      .then(() => {
        if (!active) void deactivateKeepAwake(tag).catch(() => {});
      })
      .catch(() => {});
    return () => {
      active = false;
      void deactivateKeepAwake(tag).catch(() => {});
    };
  }, []);
}
