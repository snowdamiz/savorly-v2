import type { PushPermission, PushTarget } from './push';

export type { PushPermission, PushTarget } from './push';

// The web app gets no push notifications: they go to the phones where the cook uses Savorly. The
// preferences that choose them are still set from the web (NotificationSettings).
export const pushSupported = false;

export async function pushPermission(): Promise<PushPermission> {
  return 'unavailable';
}

export async function enablePush(_channel: string): Promise<PushPermission> {
  return 'unavailable';
}

export async function refreshPush(_channel: string) {
  return false;
}

export async function unregisterPush() {}

export function pushTarget(_data: unknown): PushTarget | null {
  return null;
}

export function onPushTap(_open: (target: PushTarget) => void) {
  return () => {};
}

export function onPushTokenChange(_changed: () => void) {
  return () => {};
}

export function openNotificationSettings() {}
