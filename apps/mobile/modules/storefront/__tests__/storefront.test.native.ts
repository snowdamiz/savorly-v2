/// <reference types="jest" />
import { Platform } from 'react-native';

type Storefront = typeof import('..');
// The native module is looked up once when the module loads.
function load(native: { countryCode: () => Promise<string | null> } | null): Storefront {
  let storefront!: Storefront;
  jest.isolateModules(() => {
    jest.doMock('expo', () => ({ requireOptionalNativeModule: () => native }));
    storefront = require('..');
  });
  return storefront;
}

test(`${Platform.OS}: reports the App Store country only on iOS`, async () => {
  const native = { countryCode: jest.fn(() => Promise.resolve('USA')) };
  await expect(load(native).storefrontCountry()).resolves.toBe(
    Platform.OS === 'ios' ? 'USA' : null,
  );
});

test('unknown without the native module or when StoreKit fails', async () => {
  await expect(load(null).storefrontCountry()).resolves.toBeNull();
  const failing = { countryCode: jest.fn(() => Promise.reject(new Error('StoreKit'))) };
  await expect(load(failing).storefrontCountry()).resolves.toBeNull();
});
