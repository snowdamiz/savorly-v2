import { Platform } from 'react-native';

/**
 * Wraps a lazy import (`React.lazy(chunk(() => import('…')))`). On the web each such import is a
 * chunk of its own, and a deploy replaces the chunks, so a tab opened before one can't load a
 * chunk it hasn't loaded yet (the Worker answers 404): it reloads onto the new version instead,
 * at the same address, once a minute at most. Phones have every chunk in the app.
 */
export function chunk<T>(load: () => Promise<T>) {
  return () =>
    load().catch((error: unknown) => {
      if (Platform.OS === 'web' && typeof window !== 'undefined')
        try {
          const last = Number(window.sessionStorage.getItem('savorly.reloaded') || 0);
          if (Date.now() - last > 60_000) {
            window.sessionStorage.setItem('savorly.reloaded', String(Date.now()));
            window.location.reload();
            return new Promise<T>(() => {});
          }
        } catch {
          // Without storage the error page stands, rather than risking a reload loop.
        }
      throw error;
    });
}
