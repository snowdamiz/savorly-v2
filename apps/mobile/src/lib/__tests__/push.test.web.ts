/// <reference types="jest" />
import * as push from '../push';

// The web twin must never load expo-notifications, and does nothing: pushes go to phones.
jest.mock('expo-notifications', () => {
  throw new Error('expo-notifications loaded on the web');
});

test('the web gets no push notifications and asks for nothing', async () => {
  expect(push.pushSupported).toBe(false);
  await expect(push.pushPermission()).resolves.toBe('unavailable');
  await expect(push.enablePush('Recipes and reminders')).resolves.toBe('unavailable');
  await expect(push.refreshPush('Recipes and reminders')).resolves.toBe(false);
  await expect(push.unregisterPush()).resolves.toBeUndefined();
  expect(push.pushTarget({ type: 'pantry' })).toBeNull();
  const open = jest.fn();
  push.onPushTap(open)();
  push.onPushTokenChange(open)();
  push.openNotificationSettings();
  expect(open).not.toHaveBeenCalled();
});
