import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSignInButton } from 'react-native-nitro-google-signin';
import { useApp } from '../lib/store';
import { Provider, SocialButtonsProps } from '../lib/auth/provider';
import { providerToken, socialProviders } from '../lib/auth/social';

// The stores' own branded buttons: Apple's is required on iOS, Google's carries its branding.
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
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={26}
          style={{ width: '100%', height: 50 }}
          onPress={() => void run('apple')}
        />
      )}
      {providers.includes('google') && (
        <GoogleSignInButton
          signInBehavior="none"
          size="wide"
          colorScheme="light"
          disabled={false}
          accessibilityLabel={tr('Continue with Google')}
          onPress={() => run('google')}
        />
      )}
      {children}
    </View>
  );
}
