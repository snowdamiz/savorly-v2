import type React from 'react';
import { api } from '../api';

export type Provider = 'apple' | 'google';
/** A provider's ID token for the API; `code` and `name` come only from Apple. */
export type ProviderToken = { provider: Provider; token: string; code?: string; name?: string };
export type SocialButtonsProps = {
  /** Limit to these providers, e.g. the ones a kitchen has connected. */
  only?: Provider[];
  onToken: (token: ProviderToken) => void | Promise<void>;
  onError: (message: string) => void;
  /** Shown under the buttons, only when this platform has any. */
  children?: React.ReactNode;
};

// Every token must carry a nonce this server issued, so a stolen token can't be replayed.
export const issueNonce = () =>
  api<{ nonce: string }>('/auth/nonce', { method: 'POST' }).then((r) => r.nonce);
