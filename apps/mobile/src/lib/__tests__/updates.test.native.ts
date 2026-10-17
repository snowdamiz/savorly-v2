/// <reference types="jest" />
import * as Updates from 'expo-updates';
import { checkForUpdate, updatesSupported } from '../updates';

jest.mock('expo-updates', () => ({
  isEnabled: true,
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(() => Promise.resolve({})),
}));

test('development builds run the bundler code, so updates are off', () => {
  expect(__DEV__).toBe(true);
  expect(updatesSupported).toBe(false);
});

test('downloads a newer update when the channel has one', async () => {
  jest.mocked(Updates.checkForUpdateAsync).mockResolvedValue({ isAvailable: true } as never);
  await expect(checkForUpdate()).resolves.toBe(true);
  expect(Updates.fetchUpdateAsync).toHaveBeenCalled();
});

test('does nothing more when already up to date', async () => {
  jest.mocked(Updates.checkForUpdateAsync).mockResolvedValue({ isAvailable: false } as never);
  await expect(checkForUpdate()).resolves.toBe(false);
  expect(Updates.fetchUpdateAsync).not.toHaveBeenCalled();
});
