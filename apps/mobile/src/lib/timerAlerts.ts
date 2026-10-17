import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { keepQuietInForeground, quietInForeground } from './notificationHandler';

/** What a finished timer says when the app isn't in front, already in the cook's language. */
export type TimerAlert = {
  title: string;
  body: string;
  /** Android's name for the timer channel, shown in the system settings. */
  channel: string;
};

const CHANNEL = 'cooking-timers';
// Cooking mode rings and speaks by itself, so a timer alert from this run of the app that comes due
// while Savorly is in front stays quiet (notificationHandler.ts holds the app's one handler).

let channelName = '';
let asked = false;
const granted = (status: Notifications.NotificationPermissionsStatus) =>
  status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
// Asked once, when the first timer starts. A refusal is final: the alert in the app still works.
async function allowed() {
  const current = await Notifications.getPermissionsAsync();
  if (granted(current)) return true;
  if (asked || current.status !== 'undetermined' || !current.canAskAgain) return false;
  asked = true;
  return granted(
    await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }),
  );
}

/**
 * Has the system announce a timer at `endAt`, which it does even while the app is in the background
 * or the phone is locked, when JavaScript timers stand still. Resolves to the alert's id, or null
 * when notifications aren't allowed (or the timer is about to end anyway).
 */
export async function scheduleTimerAlert(endAt: number, { title, body, channel }: TimerAlert) {
  try {
    if (endAt - Date.now() < 1000) return null;
    // Android shows its permission prompt only once the app has a channel to post to.
    if (Platform.OS === 'android' && channelName !== channel) {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: channel,
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 400, 250, 400],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      channelName = channel;
    }
    // The permission prompt can take a while to answer.
    if (!(await allowed()) || endAt - Date.now() < 1000) return null;
    const id = await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default', data: { kind: 'cooking-timer' } },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: endAt,
        channelId: CHANNEL,
      },
    });
    keepQuietInForeground(id);
    return id;
  } catch {
    return null;
  }
}

/** Calls off a scheduled timer alert: the timer was paused, reset, finished in the app, or left. */
export function cancelTimerAlert(id: string) {
  void Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
}

/** Whether the system announced this alert itself, which it does when the end comes while away. */
export const announced = (id: string) => quietInForeground(id);
