import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../lib/store';
import { issueNonce, Provider, ProviderToken, SocialButtonsProps } from '../lib/auth/provider';
import { color, radius } from '../lib/theme';
import { ProviderFace, providerButton } from './ProviderFace';
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

// Google's button stays the control (it is how Google hands back an ID token), drawn invisibly over
// the app's own face and stretched to its size, so the click, keyboard focus and screen-reader
// label are Google's while the look is ours. Hover and focus show through the wrapper.
let chromeStyled = false;
function styleGoogleChrome() {
  if (chromeStyled) return;
  chromeStyled = true;
  const sheet = document.createElement('style');
  sheet.textContent = `@media (hover:hover){[data-google-button]:hover{background-color:${color.bg}!important}}
[data-google-button]:focus-within{outline:2px solid ${color.ink};outline-offset:3px}`;
  document.head.appendChild(sheet);
}
// Fits Google's clickable button onto the host: its frame once loaded (less the margins Google pads
// it with), or the placeholder it draws until then.
function stretch(host: HTMLElement) {
  const inner = host.firstElementChild as HTMLElement | null;
  if (!inner) return;
  inner.style.transform = '';
  const origin = inner.getBoundingClientRect();
  const frame = inner.querySelector('iframe');
  let target: DOMRect | undefined;
  if (frame) {
    const r = frame.getBoundingClientRect();
    const m = getComputedStyle(frame);
    const dx = Math.max(0, -parseFloat(m.marginLeft) || 0);
    const dy = Math.max(0, -parseFloat(m.marginTop) || 0);
    if (r.width > dx * 2 && r.height > dy * 2)
      target = new DOMRect(r.x + dx, r.y + dy, r.width - dx * 2, r.height - dy * 2);
  }
  if (!target) {
    const placeholder = inner.querySelector<HTMLElement>('[style*="width"]') ?? inner;
    target = placeholder.getBoundingClientRect();
  }
  if (!target.width || !target.height) return;
  const sx = host.clientWidth / target.width;
  const sy = host.clientHeight / target.height;
  inner.style.transformOrigin = '0 0';
  inner.style.transform = `translate(${-(target.x - origin.x) * sx}px, ${-(target.y - origin.y) * sy}px) scale(${sx}, ${sy})`;
}

// The web offers both: Google Identity Services (see above), and Sign in with Apple JS in a popup.
export function SocialButtons({ only, onToken, onError, children }: SocialButtonsProps) {
  const { t: tr, language } = useI18n();
  const caps = useApp().capabilities;
  const auth = caps?.auth;
  const allowed = (p: Provider) => !only || only.includes(p);
  const google = caps?.googleSignIn && !!auth?.googleWebClientId && allowed('google');
  const apple =
    caps?.appleSignIn && !!auth?.appleServicesId && !!auth?.appleRedirectUri && allowed('apple');
  const frame = useRef<View>(null);
  const host = useRef<View>(null);
  const [width, setWidth] = useState(0);
  // Each nonce works once, so Google's button is re-armed after every attempt.
  const [attempt, setAttempt] = useState(0);
  const handlers = useRef({ onToken, onError });
  useEffect(() => {
    handlers.current = { onToken, onError };
  });
  const clientId = auth?.googleWebClientId;
  useEffect(() => {
    if (!google || !clientId || !width) return;
    let live = true;
    let watch: MutationObserver | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    void Promise.all([load('https://accounts.google.com/gsi/client'), issueNonce()])
      .then(([, nonce]) => {
        const el = host.current as unknown as HTMLElement | null;
        if (!live || !el || !window.google) return;
        styleGoogleChrome();
        (frame.current as unknown as HTMLElement | null)?.setAttribute('data-google-button', '');
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
          width: Math.min(400, width),
          locale: language,
        });
        // Google fills in its frame asynchronously, so it's fitted again as it arrives.
        stretch(el);
        watch = new MutationObserver(() => stretch(el));
        watch.observe(el, { childList: true, subtree: true });
        timers.push(...[150, 600, 1500].map((ms) => setTimeout(() => stretch(el), ms)));
      })
      .catch((e) => live && handlers.current.onError((e as Error).message));
    return () => {
      live = false;
      watch?.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [google, clientId, attempt, language, width]);
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
        <View
          ref={frame}
          onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
          style={[providerButton('google'), { cursor: 'pointer' }]}
        >
          <ProviderFace provider="google" title={tr('Continue with Google')} />
          <View
            ref={host}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: radius.pill,
              overflow: 'hidden',
              opacity: 0,
            }}
          />
        </View>
      )}
      {children}
    </View>
  );
}
