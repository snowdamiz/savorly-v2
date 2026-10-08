import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import {
  GoogleOneTapSignIn,
  isCancelledResponse,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
} from 'react-native-nitro-google-signin';
import { Capabilities } from '../types';
import { issueNonce as nonce, Provider, ProviderToken } from './provider';

/** iOS offers Apple and Google (Apple Review 4.8 needs Apple wherever Google is); Android, Google. */
export function socialProviders(caps: Capabilities | null): Provider[] {
  const list: Provider[] = [];
  if (Platform.OS === 'ios' && caps?.appleSignIn) list.push('apple');
  if (caps?.googleSignIn && (Platform.OS === 'android' || caps.auth?.googleIosClientId))
    list.push('google');
  return list;
}

/** Runs the provider's own sign-in sheet; null when the person cancels. */
export async function providerToken(
  provider: Provider,
  caps: Capabilities,
): Promise<ProviderToken | null> {
  if (provider === 'apple') {
    try {
      const r = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: await nonce(),
      });
      if (!r.identityToken)
        throw new Error('Apple didn’t finish signing you in. Please try again.');
      // Apple shares the name only on the very first sign-in, and never in the token.
      const name = [r.fullName?.givenName, r.fullName?.familyName].filter(Boolean).join(' ');
      return { provider, token: r.identityToken, code: r.authorizationCode || undefined, name };
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return null;
      throw e;
    }
  }
  GoogleOneTapSignIn.configure({
    webClientId: caps.auth?.googleWebClientId || '',
    iosClientId: caps.auth?.googleIosClientId || null,
    nonce: await nonce(),
  });
  let r;
  if (Platform.OS === 'ios') {
    // On iOS, signIn() restores an earlier session without our nonce; ask interactively.
    r = await GoogleOneTapSignIn.presentExplicitSignIn();
  } else {
    await GoogleOneTapSignIn.checkPlayServices();
    r = await GoogleOneTapSignIn.signIn();
    if (isNoSavedCredentialFoundResponse(r)) r = await GoogleOneTapSignIn.createAccount();
    if (isNoSavedCredentialFoundResponse(r)) r = await GoogleOneTapSignIn.presentExplicitSignIn();
  }
  if (isCancelledResponse(r)) return null;
  if (!isSuccessResponse(r))
    throw new Error('Google didn’t finish signing you in. Please try again.');
  return { provider, token: r.data.idToken, name: r.data.user.name || undefined };
}
