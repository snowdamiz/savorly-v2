import { useEffect } from 'react';
import { Platform } from 'react-native';
import { api, persistSession } from '../api';
import { useApp } from '../store';
import { issueNonce, SignInPurpose } from './provider';

// On the web, Google sign-in leaves for Google's own page and comes back, rather than using
// Google's embedded button and popup: privacy browsers such as Brave block that frame or the
// popup's handoff, which left a button that did nothing. The ID token returns in the URL fragment,
// which never reaches a server, and the API still requires the nonce it issued for it. Google must
// list `<site>/` among the web client's Authorized redirect URIs (docs/SIGN-IN.md).

type Pending = { state: string; purpose: SignInPurpose; back: string };
type Arrival = { purpose: SignInPurpose } & ({ token: string } | { error: string });
const KEY = 'savorly.google';

export async function continueWithGoogle(
  clientId: string,
  purpose: SignInPurpose,
  language: string,
) {
  const nonce = await issueNonce();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  // A deleted kitchen comes back to the front page rather than to My kitchen.
  const back = purpose === 'delete' ? '/' : location.pathname + location.search;
  sessionStorage.setItem(KEY, JSON.stringify({ state, purpose, back } satisfies Pending));
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${location.origin}/`,
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce,
    state,
    prompt: 'select_account',
    hl: language,
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
}

// Read on load, before anything else looks at the URL: the token leaves the address bar and the
// history, and the page returns to where the cook pressed the button.
let arrival: Arrival | null = null;
if (Platform.OS === 'web' && typeof window !== 'undefined' && location.hash.includes('state=')) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    sessionStorage.removeItem(KEY);
  } catch {}
  history.replaceState(null, '', pending?.back ?? location.pathname + location.search);
  // Only an answer to the request this tab sent counts, so a link can't sign you in to someone
  // else's kitchen.
  if (pending && fragment.get('state') === pending.state) {
    const token = fragment.get('id_token');
    arrival = token
      ? { purpose: pending.purpose, token }
      : { purpose: pending.purpose, error: fragment.get('error') || 'unknown' };
  }
}
function takeArrival() {
  const taken = arrival;
  arrival = null;
  return taken;
}

/** Finishes a Google sign-in that came back to the page, once the kitchen has loaded. */
export function useGoogleReturn() {
  const app = useApp();
  useEffect(() => {
    if (app.loading) return;
    const done = takeArrival();
    if (!done) return;
    if ('error' in done) {
      // Cancelling on Google's page isn't an error.
      if (done.error !== 'access_denied')
        app.notify('Google didn’t finish signing you in. Please try again.');
      return;
    }
    const body = { provider: 'google', token: done.token };
    if (done.purpose === 'delete')
      void app.act(async () => {
        await api('/me', { method: 'DELETE', body });
        await persistSession(null);
        await app.load();
      }, 'Your account has been deleted.');
    else
      void app.act(async () => {
        const result = await api<{ created?: boolean }>('/auth/oauth', { method: 'POST', body });
        await app.refreshUser();
        // A brand-new kitchen goes on to its setup, which does the welcoming.
        if (done.purpose === 'connect')
          app.notify('Connected. You can sign in with it from now on.');
        else if (!result.created) app.notify('Welcome to your kitchen.');
      });
  }, [app]);
}
