/// <reference types="jest" />
import React from 'react';
import { Platform, Text } from 'react-native';
import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import * as AppleAuthentication from 'expo-apple-authentication';
import type { ProviderToken, SocialButtonsProps } from '../../lib/auth/provider';
import { providerToken } from '../../lib/auth/social';
import { I18nProvider } from '../../lib/i18n';
import type { Capabilities } from '../../lib/types';
import { SocialButtons } from '../SocialButtons';

// The buttons read only the server's capabilities from the app's store.
let mockCapabilities: Capabilities | null = null;
jest.mock('../../lib/store', () => ({ useApp: () => ({ capabilities: mockCapabilities }) }));
// Which providers show is social.ts's own rule; the sign-in sheets behind the buttons are stubbed
// (social.test.native.ts covers them), as are the native and API modules social.ts loads.
jest.mock('../../lib/auth/social', () => ({
  ...jest.requireActual('../../lib/auth/social'),
  providerToken: jest.fn(),
}));
jest.mock('../../lib/auth/provider', () => ({ issueNonce: jest.fn() }));
jest.mock('react-native-nitro-google-signin', () => ({}));
jest.mock('expo-apple-authentication', () => ({ isAvailableAsync: jest.fn() }));

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
const signIn = jest.mocked(providerToken);
const appleAvailable = jest.mocked(AppleAuthentication.isAvailableAsync);

async function render(props: Partial<SocialButtonsProps> = {}) {
  const onToken = jest.fn<void | Promise<void>, [ProviderToken]>();
  const onError = jest.fn<void, [string]>();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <I18nProvider fallback={null}>
        <SocialButtons onToken={onToken} onError={onError} {...props}>
          <Text>or use your email</Text>
        </SocialButtons>
      </I18nProvider>,
    );
  });
  return { tree, onToken, onError };
}
const isHost = (node: ReactTestInstance) => typeof node.type === 'string';
// The buttons as a screen reader announces them, and the words on screen, top to bottom.
const buttons = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((node) => isHost(node) && node.props.accessibilityRole === 'button')
    .map((node) => node.props.accessibilityLabel as string);
const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((node) => node.props.children as string);
// A tap reaches the nearest onPress above the button's native view.
async function press(tree: ReactTestRenderer, label: string) {
  let node: ReactTestInstance | null = tree.root.find(
    (n) => isHost(n) && n.props.accessibilityLabel === label,
  );
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  await act(async () => node!.props.onPress());
}

beforeEach(() => {
  mockCapabilities = caps();
  appleAvailable.mockResolvedValue(true);
});

describe('which buttons show', () => {
  if (Platform.OS === 'ios') {
    test('iOS offers Apple above Google, with what goes under them last', async () => {
      const { tree } = await render();
      expect(buttons(tree)).toEqual(['Continue with Apple', 'Continue with Google']);
      expect(texts(tree)).toEqual([
        'Continue with Apple',
        'Continue with Google',
        'or use your email',
      ]);
    });
    test('iOS leaves Apple out on a device that can’t sign in with it', async () => {
      appleAvailable.mockResolvedValue(false);
      expect(buttons((await render()).tree)).toEqual(['Continue with Google']);
      appleAvailable.mockRejectedValue(new Error('unavailable'));
      expect(buttons((await render()).tree)).toEqual(['Continue with Google']);
    });
    test('iOS hides Google until the server has an iOS client', async () => {
      mockCapabilities = caps({ auth: { ...caps().auth!, googleIosClientId: '' } });
      expect(buttons((await render()).tree)).toEqual(['Continue with Apple']);
    });
  } else {
    test('Android offers Google only, with what goes under it last', async () => {
      const { tree } = await render();
      expect(buttons(tree)).toEqual(['Continue with Google']);
      expect(texts(tree)).toEqual(['Continue with Google', 'or use your email']);
    });
  }
  test('nothing at all, not even what goes under the buttons, without a provider', async () => {
    mockCapabilities = null;
    expect((await render()).tree.toJSON()).toBeNull();
    mockCapabilities = caps({ appleSignIn: false, googleSignIn: false });
    expect((await render()).tree.toJSON()).toBeNull();
  });
  test('`only` keeps just the providers asked for', async () => {
    expect(buttons((await render({ only: ['google'] })).tree)).toEqual(['Continue with Google']);
    const apple = (await render({ only: ['apple'] })).tree;
    // A kitchen connected only to Apple can't be confirmed with a provider on Android.
    if (Platform.OS === 'ios') expect(buttons(apple)).toEqual(['Continue with Apple']);
    else expect(apple.toJSON()).toBeNull();
  });
});

describe('signing in', () => {
  const google: ProviderToken = { provider: 'google', token: 'google-id-token', name: 'Ada' };
  test('Google’s token goes to onToken', async () => {
    signIn.mockResolvedValue(google);
    const { tree, onToken, onError } = await render();
    await press(tree, 'Continue with Google');
    expect(signIn).toHaveBeenCalledWith('google', mockCapabilities);
    expect(onToken).toHaveBeenCalledWith(google);
    expect(onError).not.toHaveBeenCalled();
  });
  if (Platform.OS === 'ios') {
    test('Apple’s token goes to onToken', async () => {
      const apple: ProviderToken = { provider: 'apple', token: 'apple-id-token', code: 'code' };
      signIn.mockResolvedValue(apple);
      const { tree, onToken } = await render();
      await press(tree, 'Continue with Apple');
      expect(signIn).toHaveBeenCalledWith('apple', mockCapabilities);
      expect(onToken).toHaveBeenCalledWith(apple);
    });
  }
  test('closing the sign-in sheet is neither a token nor an error', async () => {
    signIn.mockResolvedValue(null);
    const { tree, onToken, onError } = await render();
    await press(tree, 'Continue with Google');
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  test('a failed sign-in reports its message', async () => {
    signIn.mockRejectedValue(new Error('Google didn’t finish signing you in. Please try again.'));
    const { tree, onToken, onError } = await render();
    await press(tree, 'Continue with Google');
    expect(onError).toHaveBeenCalledWith('Google didn’t finish signing you in. Please try again.');
    expect(onToken).not.toHaveBeenCalled();
  });
  test('so does a token the app then refuses', async () => {
    signIn.mockResolvedValue(google);
    const { tree, onToken, onError } = await render();
    onToken.mockRejectedValue(new Error('This Google account is connected to another kitchen.'));
    await press(tree, 'Continue with Google');
    expect(onError).toHaveBeenCalledWith('This Google account is connected to another kitchen.');
  });
});
