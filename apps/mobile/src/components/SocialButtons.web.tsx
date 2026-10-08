import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useApp } from '../lib/store';
import { issueNonce, Provider, ProviderToken, SocialButtonsProps } from '../lib/auth/provider';
import { font } from '../lib/theme';
import { Press } from './ui';

type GoogleIdentity = {
  accounts: {
    id: {
      initialize(options: object): void;
      renderButton(el: HTMLElement, options: object): void;
    };
  };
};
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
    google?: GoogleIdentity;
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

// The web offers both: Google Identity Services draws its own button (that's how it hands
// back an ID token), and Sign in with Apple JS runs in a popup.
export function SocialButtons({ only, onToken, onError, children }: SocialButtonsProps) {
  const { t: tr, language } = useI18n();
  const caps = useApp().capabilities;
  const auth = caps?.auth;
  const allowed = (p: Provider) => !only || only.includes(p);
  const google = caps?.googleSignIn && !!auth?.googleWebClientId && allowed('google');
  const apple =
    caps?.appleSignIn && !!auth?.appleServicesId && !!auth?.appleRedirectUri && allowed('apple');
  const host = useRef<View>(null);
  // Each nonce works once, so Google's button is re-armed after every attempt.
  const [attempt, setAttempt] = useState(0);
  const handlers = useRef({ onToken, onError });
  useEffect(() => {
    handlers.current = { onToken, onError };
  });
  const clientId = auth?.googleWebClientId;
  useEffect(() => {
    if (!google || !clientId) return;
    let live = true;
    void Promise.all([load('https://accounts.google.com/gsi/client'), issueNonce()])
      .then(([, nonce]) => {
        const el = host.current as unknown as HTMLElement | null;
        if (!live || !el || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          nonce,
          ux_mode: 'popup',
          callback: (response: { credential: string }) => {
            void Promise.resolve(
              handlers.current.onToken({ provider: 'google', token: response.credential }),
            ).finally(() => setAttempt((n) => n + 1));
          },
        });
        el.replaceChildren();
        window.google.accounts.id.renderButton(el, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          width: 300,
          locale: language,
        });
      })
      .catch((e) => live && handlers.current.onError((e as Error).message));
    return () => {
      live = false;
    };
  }, [google, clientId, attempt, language]);
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
          style={{
            width: 300,
            height: 44,
            borderRadius: 22,
            backgroundColor: '#000',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Svg width={16} height={19} viewBox="0 0 814 1000">
            <Path
              fill="#fff"
              d="M788 341c-6 4-108 62-108 190 0 148 130 200 134 202-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-165-40c-77 0-104 41-166 41s-106-57-156-127C44 791 0 666 0 548c0-191 124-292 246-292 65 0 119 43 160 43 39 0 100-45 174-45 28 0 129 3 208 87zM555 159c31-36 52-87 52-138 0-7-1-14-2-20-50 2-109 33-145 75-28 32-55 83-55 135 0 8 1 15 2 18 3 1 8 1 13 1 45 0 101-30 135-71z"
            />
          </Svg>
          <Text style={{ color: '#fff', fontFamily: font.semibold, fontSize: 16 }}>
            {tr('Continue with Apple')}
          </Text>
        </Press>
      )}
      {google && <View ref={host} style={{ minHeight: 44, width: 300 }} />}
      {children}
    </View>
  );
}
