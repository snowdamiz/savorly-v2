import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { RefreshCw, WifiOff } from './icons';
import { useI18n } from '../lib/i18n';
import { color, font, maxFontScale, radius, s, shadow } from '../lib/theme';
import { FadeIn, Press } from './ui';

/**
 * Shown while the kitchen on screen is the copy this device kept (src/lib/offline.ts), because the
 * API couldn't be reached. Recipes open and cook from it; trying again keeps it on screen until
 * the real kitchen arrives.
 */
export function OfflineBanner({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <FadeIn offset={-12} style={{ maxWidth: '100%' }}>
      <View
        accessibilityRole="alert"
        style={[
          s.row,
          {
            gap: 10,
            padding: 4,
            paddingLeft: 14,
            borderRadius: radius.pill,
            backgroundColor: color.ink,
            borderWidth: 1,
            borderColor: color.glassBorder,
            boxShadow: shadow.float,
          },
        ]}
      >
        <WifiOff size={16} color={color.white} strokeWidth={2.2} />
        <Text
          style={{
            flexShrink: 1,
            fontFamily: font.semibold,
            fontSize: 14,
            lineHeight: 20,
            color: color.white,
          }}
        >
          {t('You’re offline. Showing what’s saved on this device.')}
        </Text>
        <Press
          accessibilityRole="button"
          accessibilityLabel={t('Try again')}
          accessibilityState={{ busy }}
          onPress={onRetry}
          style={[
            s.row,
            {
              gap: 6,
              minHeight: 36,
              paddingHorizontal: 14,
              borderRadius: radius.pill,
              backgroundColor: color.white,
            },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={color.ink} />
          ) : (
            <RefreshCw size={14} color={color.ink} strokeWidth={2.4} />
          )}
          <Text
            maxFontSizeMultiplier={maxFontScale}
            style={{ fontFamily: font.bold, fontSize: 13, color: color.ink }}
          >
            {t('Try again')}
          </Text>
        </Press>
      </View>
    </FadeIn>
  );
}
