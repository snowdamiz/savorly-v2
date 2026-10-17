import React from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { WEB_URL } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { color, font, s } from '../lib/theme';
import { Press } from './ui';

// The legal pages are static pages of the site (public/*.html, served by the Worker).
export const privacyUrl = () => `${WEB_URL}/privacy`;
export const termsUrl = () => `${WEB_URL}/terms`;
export const deletionUrl = () => `${WEB_URL}/account-deletion`;

/**
 * Props that make a pressable or text a link to a page outside the app. On the web it is a real
 * link that opens in a new tab (and can be copied or middle-clicked); the apps open the browser.
 */
export function externalLink(url: string): object {
  return Platform.OS === 'web'
    ? { href: url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } }
    : { onPress: () => void Linking.openURL(url).catch(() => {}) };
}

/** The privacy policy, the terms and the account-deletion page, at the foot of My kitchen. */
export function LegalLinks() {
  const { t } = useI18n();
  const links = [
    { url: privacyUrl(), title: t('Privacy policy') },
    { url: termsUrl(), title: t('Terms of use') },
    { url: deletionUrl(), title: t('Delete your account') },
  ];
  return (
    <View style={[s.wrap, { gap: 4, justifyContent: 'center' }]}>
      {links.map((link) => (
        <Press
          key={link.url}
          accessibilityRole="link"
          accessibilityLabel={link.title}
          {...externalLink(link.url)}
          scale={0.97}
          style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}
        >
          <Text style={[s.small, { color: color.muted, textDecorationLine: 'underline' }]}>
            {link.title}
          </Text>
        </Press>
      ))}
    </View>
  );
}

/** One sentence under the sign-up button, with the terms and the privacy policy as links. */
export function SignUpConsent() {
  const { t } = useI18n();
  const links: Record<string, { url: string; title: string }> = {
    '{{terms}}': { url: termsUrl(), title: t('Terms of use') },
    '{{privacy}}': { url: privacyUrl(), title: t('Privacy policy') },
  };
  // Translated whole, so each language puts the links where its sentence needs them.
  const sentence = t('By creating an account, you agree to the {{terms}} and the {{privacy}}.');
  return (
    <Text style={[s.small, { textAlign: 'center' }]}>
      {sentence.split(/(\{\{(?:terms|privacy)\}\})/).map((part, i) =>
        links[part] ? (
          <Text
            key={i}
            accessibilityRole="link"
            {...externalLink(links[part].url)}
            style={{ color: color.ink, fontFamily: font.bold, textDecorationLine: 'underline' }}
          >
            {links[part].title}
          </Text>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </Text>
  );
}
