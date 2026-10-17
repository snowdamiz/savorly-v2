// Native storage has no backing store under Jest; the package ships an in-memory mock.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// expo-notifications loads Android native modules as it is imported, and jest-expo has no stand-ins
// for them, so on Android any test that reaches it through the store (push.ts) couldn't run. Tests
// get this inert version instead; the ones about notifications mock it themselves.
jest.mock('expo-notifications', () => {
  const nothing = () => Promise.resolve(null);
  const subscription = () => ({ remove: () => {} });
  return {
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    AndroidImportance: { MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 },
    AndroidNotificationVisibility: { PUBLIC: 1, PRIVATE: 0, SECRET: -1 },
    IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3 },
    SchedulableTriggerInputTypes: { DATE: 'date', TIME_INTERVAL: 'timeInterval' },
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(nothing),
    getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false, canAskAgain: true })),
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false, canAskAgain: true })),
    getDevicePushTokenAsync: jest.fn(nothing),
    getExpoPushTokenAsync: jest.fn(nothing),
    scheduleNotificationAsync: jest.fn(() => Promise.resolve('notification')),
    cancelScheduledNotificationAsync: jest.fn(nothing),
    addNotificationResponseReceivedListener: jest.fn(subscription),
    addPushTokenListener: jest.fn(subscription),
    getLastNotificationResponseAsync: jest.fn(nothing),
    clearLastNotificationResponseAsync: jest.fn(nothing),
  };
});

// lucide's React Native build is ES modules, which Jest doesn't load; icons draw nothing here.
jest.mock('../src/components/icons', () => {
  const icons = {};
  return new Proxy(
    {},
    {
      get: (_, name) =>
        typeof name === 'string' && /^[A-Z]/.test(name) ? (icons[name] ??= () => null) : undefined,
    },
  );
});
