import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { api } from './api';
// The app's one foreground handler, which shows push notifications while Savorly is open.
import './notificationHandler';

/** Where a tapped notification leads. */
export type PushTarget =
  { type: 'recipe'; recipeId: string } | { type: 'pantry' } | { type: 'plan' };
/** Whether this device shows Savorly's notifications: not asked yet, allowed, refused, or can't. */
export type PushPermission = 'undetermined' | 'granted' | 'denied' | 'unavailable';

/** Phones get push notifications; the web twin does nothing. */
export const pushSupported = true;

// Pushes that name no channel arrive on Android's "default" one; creating it first gives it a
// name in the cook's language rather than Expo's English "Default".
const CHANNEL = 'default';
const STORED = 'savorly.pushToken';
let channelName = '';
// The token this app last gave the server, which signing out takes back.
let registered: string | null = null;
// The system's own token behind it, and how many registrations are under way: fetching the system
// token reports it to onPushTokenChange's listeners too, and that echo is no change.
let device = '';
let registering = 0;
const tokenText = (token: Notifications.DevicePushToken) =>
  typeof token.data === 'string' ? token.data : JSON.stringify(token.data);

async function ensureChannel(name: string) {
  if (Platform.OS !== 'android' || channelName === name) return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  channelName = name;
}

const allowed = (status: Notifications.NotificationPermissionsStatus) =>
  status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;

/** Whether this phone shows Savorly's notifications, without asking. */
export async function pushPermission(): Promise<PushPermission> {
  try {
    const status = await Notifications.getPermissionsAsync();
    if (allowed(status)) return 'granted';
    return status.status === 'undetermined' && status.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unavailable';
  }
}

// The Expo push token, which the server sends through Expo's push service, and which can change
// between launches (a reinstall, a restored backup), so it's registered again each time.
async function registerNow(channel: string) {
  await ensureChannel(channel);
  const devicePushToken = await Notifications.getDevicePushTokenAsync();
  device = tokenText(devicePushToken);
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId, devicePushToken });
  await api('/me/push-token', { method: 'PUT', body: { token, platform: Platform.OS } });
  registered = token;
  await AsyncStorage.setItem(STORED, token).catch(() => {});
}
// One at a time: iOS turns down a token request while another is pending.
let queue: Promise<void> = Promise.resolve();
function register(channel: string) {
  registering++;
  const next = queue
    .then(() => registerNow(channel))
    .finally(() => {
      registering--;
    });
  queue = next.catch(() => {});
  return next;
}

/**
 * Turns on notifications for this phone, asking the system first if it never has: call it when
 * the cook turns a notification on, never at launch. 'unavailable' means the phone couldn't be
 * registered (offline, or a build without push credentials).
 */
export async function enablePush(channel: string): Promise<PushPermission> {
  try {
    // Android 13 and later show the permission prompt only once the app has a channel.
    await ensureChannel(channel);
    let status = await Notifications.getPermissionsAsync();
    if (!allowed(status) && status.status === 'undetermined' && status.canAskAgain)
      status = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      });
    if (!allowed(status)) return 'denied';
    await register(channel);
    return 'granted';
  } catch {
    return 'unavailable';
  }
}

/** Registers this phone again when notifications are already allowed; never asks. */
export async function refreshPush(channel: string): Promise<boolean> {
  try {
    if ((await pushPermission()) !== 'granted') return false;
    await register(channel);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes this phone's token back from the account, so a signed-out phone stops getting its
 * notifications. Called while the session still exists; never throws, and gives up quickly.
 */
export async function unregisterPush() {
  try {
    const token = registered ?? (await AsyncStorage.getItem(STORED));
    registered = null;
    if (!token) return;
    await AsyncStorage.removeItem(STORED).catch(() => {});
    await api('/me/push-token', { method: 'DELETE', body: { token }, timeout: 5000 });
  } catch {}
}

/**
 * Where a notification's data leads: `{type: 'recipe', recipeId}`, `{type: 'pantry'}`, or
 * `{type: 'plan'}` for a renewal reminder.
 */
export function pushTarget(data: unknown): PushTarget | null {
  if (!data || typeof data !== 'object') return null;
  const { type, recipeId } = data as Record<string, unknown>;
  if (type === 'recipe' && typeof recipeId === 'string' && recipeId) return { type, recipeId };
  if (type === 'pantry' || type === 'plan') return { type };
  return null;
}

// A tap is followed once, whether it launched the app or arrived while it ran.
const followed = new Set<string>();

/**
 * Calls `open` with where a tapped notification leads: the one that opened the app, and each one
 * tapped while it runs. Cooking timers and other notifications lead nowhere. Returns the
 * unsubscribe.
 */
export function onPushTap(open: (target: PushTarget) => void) {
  let active = true;
  const follow = (response: Notifications.NotificationResponse | null) => {
    if (!active || response?.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { identifier, content } = response.notification.request;
    if (followed.has(identifier)) return;
    followed.add(identifier);
    const target = pushTarget(content.data);
    if (target) open(target);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(follow);
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      follow(response);
      if (response) return Notifications.clearLastNotificationResponseAsync();
    })
    .catch(() => {});
  return () => {
    active = false;
    subscription.remove();
  };
}

/**
 * Calls `changed` when the system replaces this phone's push token, which then needs registering
 * again. Returns the unsubscribe.
 */
export function onPushTokenChange(changed: () => void) {
  const subscription = Notifications.addPushTokenListener((token) => {
    // Every fetch of the token is reported here as well; registering again on those would loop.
    if (registering || tokenText(token) === device) return;
    changed();
  });
  return () => subscription.remove();
}

/** Savorly's page in the phone's settings, where refused notifications can be allowed again. */
export function openNotificationSettings() {
  void Linking.openSettings().catch(() => {});
}
