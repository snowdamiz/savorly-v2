import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../lib/store';
import { continueWithGoogle } from '../lib/auth/googleRedirect';
import { issueNonce, Provider, ProviderToken, SocialButtonsProps } from '../lib/auth/provider';
import { ProviderFace, providerButton } from './ProviderFace';
import { Press } from './ui';

type AppleIdentity = {
  auth: {
    init(options: object): void;
    signIn(): Promise<{
      authorization: { id_token: string; code: string };
      user?: { name?: { firstName?: string; lastName?: string } };
    }>;
  };
};
declare global {
  interface Window {
    AppleID?: AppleIdentity;
  }
}

const scripts: Record<string, Promise<void>> = {};
function load(src: string) {
  scripts[src] ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      delete scripts[src];
      reject(new Error('Sign-in couldn’t load. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return scripts[src];
}

// The web offers both: Google by going to its own sign-in page and back (googleRedirect.ts), and
// Sign in with Apple JS in a popup.
export function SocialButtons({
  only,
  purpose = 'signin',
  onToken,
  onError,
  children,
}: SocialButtonsProps) {
  const { t: tr, language } = useI18n();
  const caps = useApp().capabilities;
  const auth = caps?.auth;
  const allowed = (p: Provider) => !only || only.includes(p);
  const google = caps?.googleSignIn && !!auth?.googleWebClientId && allowed('google');
  const apple =
    caps?.appleSignIn && !!auth?.appleServicesId && !!auth?.appleRedirectUri && allowed('apple');
  // Held while the page leaves for Google, so a second press doesn't start another sign-in, and
  // released if the browser's Back button restores this page from its cache.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const back = () => setLeaving(false);
    window.addEventListener('pageshow', back);
    return () => window.removeEventListener('pageshow', back);
  }, []);
  const signInWithGoogle = () => {
    setLeaving(true);
    continueWithGoogle(auth!.googleWebClientId!, purpose, language).catch((e) => {
      setLeaving(false);
      onError((e as Error).message);
    });
  };
  const signInWithApple = async () => {
    try {
      await load(
        'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js',
      );
      window.AppleID!.auth.init({
        clientId: auth!.appleServicesId,
        scope: 'name email',
        redirectURI: auth!.appleRedirectUri,
        nonce: await issueNonce(),
        usePopup: true,
      });
      const r = await window.AppleID!.auth.signIn();
      // Apple shares the name only on the very first sign-in, and never in the token.
      const name = [r.user?.name?.firstName, r.user?.name?.lastName].filter(Boolean).join(' ');
      const token: ProviderToken = {
        provider: 'apple',
        token: r.authorization.id_token,
        code: r.authorization.code,
        name,
      };
      await onToken(token);
    } catch (e) {
      const code = (e as { error?: string }).error;
      if (code === 'popup_closed_by_user' || code === 'user_cancelled_authorize') return;
      onError((e as Error).message || 'Apple didn’t finish signing you in. Please try again.');
    }
  };
  if (!google && !apple) return null;
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      {apple && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Continue with Apple')}
          onPress={() => void signInWithApple()}
          scale={0.97}
          style={providerButton('apple')}
        >
          <ProviderFace provider="apple" title={tr('Continue with Apple')} />
        </Press>
      )}
      {google && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Continue with Google')}
          accessibilityState={{ busy: leaving }}
          disabled={leaving}
          onPress={signInWithGoogle}
          scale={0.97}
          style={providerButton('google')}
        >
          <ProviderFace provider="google" title={tr('Continue with Google')} />
        </Press>
      )}
      {children}
    </View>
  );
}
