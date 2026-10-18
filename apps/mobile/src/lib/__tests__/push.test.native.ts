/// <reference types="jest" />
import { Platform } from 'react-native';

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve(null)),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(() => Promise.resolve({ type: 'ios', data: 'device-1' })),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(() => Promise.resolve(null)),
  clearLastNotificationResponseAsync: jest.fn(() => Promise.resolve()),
  addPushTokenListener: jest.fn(),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'project-1' } } } },
}));
jest.mock('../api', () => ({ api: jest.fn(() => Promise.resolve()) }));

type Push = typeof import('../push');
type Notifications = typeof import('expo-notifications');
type Storage = typeof import('@react-native-async-storage/async-storage').default;
// The registered token and the taps already followed live in module state, so each test starts
// from a fresh module, as a new launch of the app would.
function load() {
  let push!: Push;
  let notifications!: jest.Mocked<Notifications>;
  let api!: jest.Mock;
  let storage!: Storage;
  jest.isolateModules(() => {
    push = require('../push');
    notifications = require('expo-notifications');
    api = require('../api').api;
    // The package's Jest mock is a CommonJS module, which `import` reads as its default.
    const stored = require('@react-native-async-storage/async-storage');
    storage = stored.default ?? stored;
  });
  return { push, notifications, api, storage };
}
const status = (granted: boolean, state: string, canAskAgain = true) =>
  ({ granted, status: state, canAskAgain, expires: 'never' }) as never;
const response = (identifier: string, data: unknown, action?: string) =>
  ({
    actionIdentifier: action ?? 'expo.modules.notifications.actions.DEFAULT',
    notification: { request: { identifier, content: { data } } },
  }) as never;
const TOKEN = 'ExponentPushToken[abc]';

test('asks only when turned on, then registers the Expo token for this platform', async () => {
  const { push, notifications, api } = load();
  notifications.getPermissionsAsync.mockResolvedValue(status(false, 'undetermined'));
  notifications.requestPermissionsAsync.mockResolvedValue(status(true, 'granted'));
  notifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
  await expect(push.enablePush('Recipes and reminders')).resolves.toBe('granted');
  expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  // The system token is fetched once and handed over, so Expo doesn't fetch (and report) it again.
  expect(notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
  expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
    projectId: 'project-1',
    devicePushToken: { type: 'ios', data: 'device-1' },
  });
  expect(api).toHaveBeenCalledWith('/me/push-token', {
    method: 'PUT',
    body: { token: TOKEN, platform: Platform.OS },
  });
  if (Platform.OS === 'android') {
    // Android 13 shows the prompt only once a channel exists: the default one, in the cook's words.
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', {
      name: 'Recipes and reminders',
      importance: 3,
    });
    expect(notifications.setNotificationChannelAsync.mock.invocationCallOrder[0]).toBeLessThan(
      notifications.requestPermissionsAsync.mock.invocationCallOrder[0],
    );
  } else expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
});

test('a refusal is final: nothing is asked again or registered', async () => {
  const { push, notifications, api } = load();
  notifications.getPermissionsAsync.mockResolvedValue(status(false, 'denied', false));
  await expect(push.enablePush('Recipes and reminders')).resolves.toBe('denied');
  await expect(push.pushPermission()).resolves.toBe('denied');
  expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});

test('a phone that can’t get a token reports it rather than failing', async () => {
  const { push, notifications, api } = load();
  notifications.getPermissionsAsync.mockResolvedValue(status(true, 'granted'));
  notifications.getExpoPushTokenAsync.mockRejectedValue(new Error('No Firebase configuration'));
  await expect(push.enablePush('Recipes and reminders')).resolves.toBe('unavailable');
  expect(api).not.toHaveBeenCalled();
});

test('re-registering at launch never asks, and registers once allowed', async () => {
  const { push, notifications, api } = load();
  notifications.getPermissionsAsync.mockResolvedValue(status(false, 'undetermined'));
  await expect(push.refreshPush('Recipes and reminders')).resolves.toBe(false);
  expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  notifications.getPermissionsAsync.mockResolvedValue(status(true, 'granted'));
  notifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
  await expect(push.refreshPush('Recipes and reminders')).resolves.toBe(true);
  expect(api).toHaveBeenCalledWith('/me/push-token', {
    method: 'PUT',
    body: { token: TOKEN, platform: Platform.OS },
  });
});

test('signing out takes the registered token back once, and never throws', async () => {
  const { push, notifications, api } = load();
  notifications.getPermissionsAsync.mockResolvedValue(status(true, 'granted'));
  notifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
  await push.refreshPush('Recipes and reminders');
  api.mockClear();
  api.mockRejectedValueOnce(new Error('offline'));
  await expect(push.unregisterPush()).resolves.toBeUndefined();
  expect(api).toHaveBeenCalledWith('/me/push-token', {
    method: 'DELETE',
    body: { token: TOKEN },
    timeout: 5000,
  });
  api.mockClear();
  await push.unregisterPush();
  expect(api).not.toHaveBeenCalled();
});

test('a relaunched app still knows which token to take back', async () => {
  const { push, api, storage } = load();
  await storage.setItem('savorly.pushToken', 'ExponentPushToken[from-last-launch]');
  await push.unregisterPush();
  expect(api).toHaveBeenCalledWith('/me/push-token', {
    method: 'DELETE',
    body: { token: 'ExponentPushToken[from-last-launch]' },
    timeout: 5000,
  });
  await expect(storage.getItem('savorly.pushToken')).resolves.toBeNull();
});

test('reads where a notification leads, and nothing else', () => {
  const { push } = load();
  expect(push.pushTarget({ type: 'recipe', recipeId: 'lemon-pasta' })).toEqual({
    type: 'recipe',
    recipeId: 'lemon-pasta',
  });
  expect(push.pushTarget({ type: 'pantry' })).toEqual({ type: 'pantry' });
  expect(push.pushTarget({ type: 'plan' })).toEqual({ type: 'plan' });
  for (const data of [
    null,
    undefined,
    'recipe',
    { type: 'recipe' },
    { type: 'recipe', recipeId: 7 },
    { kind: 'cooking-timer' },
    { type: 'video' },
  ])
    expect(push.pushTarget(data)).toBeNull();
});

test('follows the tap that opened the app once, then live taps; not dismissals or timers', async () => {
  const { push, notifications } = load();
  let listener: (r: unknown) => void = () => {};
  const remove = jest.fn();
  notifications.addNotificationResponseReceivedListener.mockImplementation((l) => {
    listener = l as never;
    return { remove } as never;
  });
  notifications.getLastNotificationResponseAsync.mockResolvedValue(
    response('launch', { type: 'recipe', recipeId: 'lemon-pasta' }),
  );
  const open = jest.fn();
  const stop = push.onPushTap(open);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(open).toHaveBeenCalledWith({ type: 'recipe', recipeId: 'lemon-pasta' });
  expect(notifications.clearLastNotificationResponseAsync).toHaveBeenCalled();
  // The same tap reported again by the listener is not followed twice.
  listener(response('launch', { type: 'recipe', recipeId: 'lemon-pasta' }));
  listener(response('expiring', { type: 'pantry' }));
  listener(response('dismissed', { type: 'pantry' }, 'expo.modules.notifications.actions.DISMISS'));
  listener(response('timer', { kind: 'cooking-timer' }));
  expect(open.mock.calls).toEqual([
    [{ type: 'recipe', recipeId: 'lemon-pasta' }],
    [{ type: 'pantry' }],
  ]);
  stop();
  expect(remove).toHaveBeenCalled();
  listener(response('late', { type: 'pantry' }));
  expect(open).toHaveBeenCalledTimes(2);
});

test('a new system token is registered again, but not the echo of fetching it', async () => {
  const { push, notifications, api } = load();
  let listener: (token: { type: string; data: string }) => void = () => {};
  const remove = jest.fn();
  notifications.addPushTokenListener.mockImplementation((l) => {
    listener = l as never;
    return { remove } as never;
  });
  const changed = jest.fn();
  const stop = push.onPushTokenChange(changed);
  notifications.getPermissionsAsync.mockResolvedValue(status(true, 'granted'));
  notifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
  // Fetching the system token reports it to listeners too, while registering and after.
  let release!: () => void;
  api.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
  const registering = push.refreshPush('Recipes and reminders');
  await new Promise((resolve) => setTimeout(resolve, 0));
  listener({ type: 'ios', data: 'device-1' });
  listener({ type: 'ios', data: 'device-0' });
  release();
  await registering;
  listener({ type: 'ios', data: 'device-1' });
  expect(changed).not.toHaveBeenCalled();
  // A token the system replaced on its own is news.
  listener({ type: 'ios', data: 'device-2' });
  expect(changed).toHaveBeenCalledTimes(1);
  stop();
  expect(remove).toHaveBeenCalled();
});

test('registrations run one at a time', async () => {
  const { push, notifications, api } = load();
  notifications.getPermissionsAsync.mockResolvedValue(status(true, 'granted'));
  notifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
  let release!: () => void;
  api.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
  const first = push.refreshPush('Recipes and reminders');
  const second = push.refreshPush('Recipes and reminders');
  await new Promise((resolve) => setTimeout(resolve, 0));
  // iOS turns down a second token request while the first is pending, so it waits its turn.
  expect(notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
  release();
  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  expect(notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(2);
});
