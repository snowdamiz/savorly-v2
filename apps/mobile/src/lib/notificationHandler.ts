import * as Notifications from 'expo-notifications';

// The app's one foreground handler: expo-notifications keeps only the last one set, so cooking
// timers (timerAlerts.ts) and push notifications (push.ts) share this module rather than each
// setting their own. Without a handler, nothing shows while Savorly is in front.
//
// Timer alerts scheduled by this run of the app stay quiet in front: cooking mode rings and speaks
// by itself. Push notifications, and anything else, show as usual.
const quiet = new Set<string>();

/** Keeps a notification this run scheduled from showing if it comes due while the app is open. */
export function keepQuietInForeground(id: string) {
  quiet.add(id);
}

/** Whether this run scheduled the notification and keeps it quiet in front. */
export const quietInForeground = (id: string) => quiet.has(id);

export function foregroundBehavior(id: string): Notifications.NotificationBehavior {
  const show = !quiet.has(id);
  return {
    shouldShowBanner: show,
    shouldShowList: show,
    shouldPlaySound: show,
    shouldSetBadge: false,
  };
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => foregroundBehavior(notification.request.identifier),
});
