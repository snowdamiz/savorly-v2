import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useApp } from '../lib/store';
import { Provider, SocialButtonsProps } from '../lib/auth/provider';
import { providerToken, socialProviders } from '../lib/auth/social';
import { ProviderFace, providerButton } from './ProviderFace';
import { Press } from './ui';

// Both buttons are drawn in the app's pill and type while keeping each provider's branding: Apple's
// black button with its logo, Google's white one with the four-color mark.
export function SocialButtons({ only, onToken, onError, children }: SocialButtonsProps) {
  const { t: tr } = useI18n();
  const caps = useApp().capabilities;
  const providers = socialProviders(caps).filter((p) => !only || only.includes(p));
  const [appleReady, setAppleReady] = useState(false);
  useEffect(() => {
    void AppleAuthentication.isAvailableAsync()
      .then(setAppleReady)
      .catch(() => {});
  }, []);
  const run = async (provider: Provider) => {
    if (!caps) return;
    try {
      const token = await providerToken(provider, caps);
      if (token) await onToken(token);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  if (!providers.length) return null;
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      {providers.includes('apple') && appleReady && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Continue with Apple')}
          onPress={() => void run('apple')}
          scale={0.97}
          style={providerButton('apple')}
        >
          <ProviderFace provider="apple" title={tr('Continue with Apple')} />
        </Press>
      )}
      {providers.includes('google') && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Continue with Google')}
          onPress={() => void run('google')}
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
