import type React from 'react';
import { api } from '../api';

export type Provider = 'apple' | 'google';
/** A provider's ID token for the API; `code` and `name` come only from Apple. */
export type ProviderToken = { provider: Provider; token: string; code?: string; name?: string };
/**
 * What a sign-in is for: signing in, connecting it to this kitchen, confirming deletion, or
 * confirming a new password or email address for a kitchen without a password.
 */
export type SignInPurpose = 'signin' | 'connect' | 'delete' | 'password' | 'email';
export type SocialButtonsProps = {
  /** Limit to these providers, e.g. the ones a kitchen has connected. */
  only?: Provider[];
  /**
   * On the web, Google signs in by leaving the page, so its token comes back to the app as a
   * whole (googleRedirect.ts) rather than to onToken; this says what the app does with it.
   */
  purpose?: SignInPurpose;
  onToken: (token: ProviderToken) => void | Promise<void>;
  onError: (message: string) => void;
  /** Shown under the buttons, only when this platform has any. */
  children?: React.ReactNode;
};

// Every token must carry a nonce this server issued, so a stolen token can't be replayed.
export const issueNonce = () =>
  api<{ nonce: string }>('/auth/nonce', { method: 'POST' }).then((r) => r.nonce);
