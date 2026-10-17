/** What a finished timer says when the page isn't in front, already in the cook's language. */
export type TimerAlert = {
  title: string;
  body: string;
  /** Used by Android's notification channels only. */
  channel: string;
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const shown = new Set<string>();
let next = 0;

/**
 * A browser page rings by itself, and keeps a timer's end on time even in a background tab. When
 * the page is hidden at the end and the visitor already allows notifications from Savorly (it never
 * asks), a system notification is shown as well. Resolves to the alert's id, or null.
 */
export async function scheduleTimerAlert(endAt: number, { title, body }: TimerAlert) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  const id = `timer-${++next}`;
  timers.set(
    id,
    setTimeout(
      () => {
        timers.delete(id);
        if (document.visibilityState !== 'hidden') return;
        try {
          new Notification(title, { body, tag: 'savorly-timer' });
          shown.add(id);
        } catch {
          // Android browsers only show notifications through a service worker.
        }
      },
      Math.max(0, endAt - Date.now()),
    ),
  );
  return id;
}

/** Calls off a scheduled timer alert: the timer was paused, reset, finished in the page, or left. */
export function cancelTimerAlert(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

/** Whether the browser showed this alert, because the page was hidden when the timer ended. */
export const announced = (id: string) => shown.has(id);
