/// <reference types="jest" />

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve(null)),
  getPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted', canAskAgain: true }),
  ),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('timer-1')),
  cancelScheduledNotificationAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('../api', () => ({ api: jest.fn(() => Promise.resolve()) }));

type Notifications = typeof import('expo-notifications');
type Handler = Parameters<Notifications['setNotificationHandler']>[0];

// Cooking timers and push notifications load in either order; the app keeps one handler.
function load(order: 'timers first' | 'push first') {
  let notifications!: jest.Mocked<Notifications>;
  let timers!: typeof import('../timerAlerts');
  jest.isolateModules(() => {
    notifications = require('expo-notifications');
    if (order === 'push first') require('../push');
    timers = require('../timerAlerts');
    require('../push');
  });
  return { notifications, timers };
}
const shown = async (handler: Handler, identifier: string) => {
  const behavior = await handler!.handleNotification({
    request: { identifier, content: {}, trigger: null },
    date: Date.now(),
  } as never);
  return [behavior.shouldShowBanner, behavior.shouldShowList, behavior.shouldPlaySound];
};

for (const order of ['timers first', 'push first'] as const)
  test(`one handler (${order}): this run's timer alerts stay quiet in front, pushes show`, async () => {
    const { notifications, timers } = load(order);
    expect(notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = notifications.setNotificationHandler.mock.calls[0][0];
    const id = await timers.scheduleTimerAlert(Date.now() + 60000, {
      title: 'Timer done',
      body: 'Step 2',
      channel: 'Cooking timers',
    });
    expect(id).toBe('timer-1');
    expect(timers.announced('timer-1')).toBe(true);
    expect(await shown(handler, 'timer-1')).toEqual([false, false, false]);
    // A push notification, or a timer from an earlier run, shows as usual.
    expect(await shown(handler, 'push-from-expo')).toEqual([true, true, true]);
    expect(timers.announced('push-from-expo')).toBe(false);
    const behavior = await handler!.handleNotification({
      request: { identifier: 'push-from-expo' },
    } as never);
    expect(behavior.shouldSetBadge).toBe(false);
  });
