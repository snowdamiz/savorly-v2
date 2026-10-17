/// <reference types="jest" />
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleOneTapSignIn } from 'react-native-nitro-google-signin';
import type { Capabilities } from '../../types';
import { providerToken, socialProviders } from '../social';

jest.mock('../provider', () => ({ issueNonce: jest.fn(() => Promise.resolve('server-nonce')) }));
jest.mock('expo-apple-authentication', () => ({
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
jest.mock('react-native-nitro-google-signin', () => {
  const is = (type: string) => (response: { type: string }) => response.type === type;
  return {
    GoogleOneTapSignIn: {
      configure: jest.fn(),
      checkPlayServices: jest.fn(() => Promise.resolve()),
      signIn: jest.fn(),
      createAccount: jest.fn(),
      presentExplicitSignIn: jest.fn(),
    },
    isCancelledResponse: is('cancelled'),
    isNoSavedCredentialFoundResponse: is('noSavedCredentialFound'),
    isSuccessResponse: is('success'),
  };
});

const caps = (extra: Partial<Capabilities> = {}) =>
  ({
    appleSignIn: true,
    googleSignIn: true,
    auth: {
      googleWebClientId: 'web-client',
      googleIosClientId: 'ios-client',
      appleServicesId: '',
      appleRedirectUri: '',
    },
    ...extra,
  }) as Capabilities;
const google = jest.mocked(GoogleOneTapSignIn);
const success = { type: 'success', data: { idToken: 'google-id-token', user: { name: 'Ada' } } };

describe('which buttons show', () => {
  test('none before capabilities load', () => expect(socialProviders(null)).toEqual([]));
  if (Platform.OS === 'ios') {
    test('iOS offers Apple wherever it offers Google', () => {
      expect(socialProviders(caps())).toEqual(['apple', 'google']);
    });
    test('iOS hides Google until the server has an iOS client', () => {
      const noIos = caps({ auth: { ...caps().auth!, googleIosClientId: '' } });
      expect(socialProviders(noIos)).toEqual(['apple']);
    });
  } else {
    test('Android offers Google only', () => {
      expect(socialProviders(caps())).toEqual(['google']);
      expect(socialProviders(caps({ googleSignIn: false }))).toEqual([]);
    });
  }
});

describe('Apple', () => {
  test('returns the identity token, code and first-sign-in name, bound to a server nonce', async () => {
    jest.mocked(AppleAuthentication.signInAsync).mockResolvedValue({
      identityToken: 'apple-id-token',
      authorizationCode: 'apple-code',
      fullName: { givenName: 'Ada', familyName: 'Lovelace' },
    } as never);
    await expect(providerToken('apple', caps())).resolves.toEqual({
      provider: 'apple',
      token: 'apple-id-token',
      code: 'apple-code',
      name: 'Ada Lovelace',
    });
    expect(AppleAuthentication.signInAsync).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'server-nonce' }),
    );
  });
  test('a cancelled sheet is not an error', async () => {
    jest
      .mocked(AppleAuthentication.signInAsync)
      .mockRejectedValue(Object.assign(new Error('canceled'), { code: 'ERR_REQUEST_CANCELED' }));
    await expect(providerToken('apple', caps())).resolves.toBeNull();
  });
  test('a response without an identity token asks to try again', async () => {
    jest
      .mocked(AppleAuthentication.signInAsync)
      .mockResolvedValue({ identityToken: null } as never);
    await expect(providerToken('apple', caps())).rejects.toThrow(
      'Apple didn’t finish signing you in. Please try again.',
    );
  });
});

describe('Google', () => {
  test('configures the clients with a server nonce and returns the ID token', async () => {
    google.presentExplicitSignIn.mockResolvedValue(success as never);
    google.signIn.mockResolvedValue(success as never);
    await expect(providerToken('google', caps())).resolves.toEqual({
      provider: 'google',
      token: 'google-id-token',
      name: 'Ada',
    });
    expect(google.configure).toHaveBeenCalledWith({
      webClientId: 'web-client',
      iosClientId: 'ios-client',
      nonce: 'server-nonce',
    });
  });
  if (Platform.OS === 'ios') {
    test('iOS always asks interactively, so a restored session cannot skip the nonce', async () => {
      google.presentExplicitSignIn.mockResolvedValue(success as never);
      await providerToken('google', caps());
      expect(google.signIn).not.toHaveBeenCalled();
      expect(google.presentExplicitSignIn).toHaveBeenCalledTimes(1);
    });
  } else {
    test('Android falls back from saved credentials to sign-up to the explicit sheet', async () => {
      const none = { type: 'noSavedCredentialFound' };
      google.signIn.mockResolvedValue(none as never);
      google.createAccount.mockResolvedValue(none as never);
      google.presentExplicitSignIn.mockResolvedValue(success as never);
      await expect(providerToken('google', caps())).resolves.toMatchObject({
        token: 'google-id-token',
      });
      expect(google.checkPlayServices).toHaveBeenCalled();
      expect(google.createAccount).toHaveBeenCalled();
    });
  }
  test('cancelling returns null, other failures ask to try again', async () => {
    google.presentExplicitSignIn.mockResolvedValue({ type: 'cancelled' } as never);
    google.signIn.mockResolvedValue({ type: 'cancelled' } as never);
    await expect(providerToken('google', caps())).resolves.toBeNull();
    google.presentExplicitSignIn.mockResolvedValue({ type: 'error' } as never);
    google.signIn.mockResolvedValue({ type: 'error' } as never);
    await expect(providerToken('google', caps())).rejects.toThrow(
      'Google didn’t finish signing you in. Please try again.',
    );
  });
});
