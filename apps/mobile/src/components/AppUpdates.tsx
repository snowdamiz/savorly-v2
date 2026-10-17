import React, { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import { ChevronRight, RefreshCw, X } from './icons';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, font, radius, s, shadow } from '../lib/theme';
import { checkForUpdate, updatesSupported, useForegroundUpdateChecks } from '../lib/updates';
import { FadeIn, IconButton, Press } from './ui';

function useRestart() {
  const app = useApp();
  return () =>
    void Updates.reloadAsync().catch(() =>
      app.notify('Couldn’t restart. Close and reopen Savorly to update.'),
    );
}

/**
 * Offers a restart once an update has downloaded; otherwise it runs from the next launch. The
 * message is the button, so it stays one short line on the narrowest phone in every language.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();
  const restart = useRestart();
  // A roll back to the build's own version has no update ID, hence the empty string.
  const pending = downloadedUpdate?.updateId ?? '';
  const [dismissed, setDismissed] = useState<string | null>(null);
  useForegroundUpdateChecks();
  if (!updatesSupported || !isUpdatePending || dismissed === pending) return null;
  return (
    <FadeIn offset={-12} style={{ maxWidth: '100%' }}>
      <View
        accessibilityRole="alert"
        style={[
          s.row,
          {
            gap: 2,
            padding: 4,
            borderRadius: radius.pill,
            backgroundColor: color.ink,
            borderWidth: 1,
            borderColor: color.glassBorder,
            boxShadow: shadow.float,
          },
        ]}
      >
        <Press
          accessibilityRole="button"
          accessibilityLabel={t('Restart to update')}
          onPress={restart}
          style={[
            s.row,
            { flexShrink: 1, gap: 9, minHeight: 36, paddingLeft: 12, paddingRight: 6 },
          ]}
        >
          <RefreshCw size={16} color={color.white} strokeWidth={2.2} />
          <Text
            style={{
              flexShrink: 1,
              fontFamily: font.semibold,
              fontSize: 14,
              lineHeight: 20,
              color: color.white,
            }}
          >
            {t('Restart to update')}
          </Text>
        </Press>
        <IconButton
          icon={X}
          size={34}
          dark
          label={t('Not now')}
          onPress={() => setDismissed(pending)}
        />
      </View>
    </FadeIn>
  );
}

/** Shows which update is running, and lets testers check without relaunching the app. */
export function UpdateSettings() {
  const { t, locale } = useI18n();
  const app = useApp();
  const { currentlyRunning, isChecking, isDownloading, isUpdatePending } = Updates.useUpdates();
  const restart = useRestart();
  if (!updatesSupported) return null;
  const busy = isChecking || isDownloading;
  const { createdAt, isEmbeddedLaunch, channel, updateId } = currentlyRunning;
  const status = isUpdatePending
    ? t('Update ready. Tap to restart.')
    : isDownloading
      ? t('Downloading an update…')
      : isChecking
        ? t('Checking for updates…')
        : isEmbeddedLaunch || !createdAt
          ? t('Installed version')
          : t('Updated {{date}}', {
              date: createdAt.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
            });
  const press = () => {
    if (isUpdatePending) return restart();
    if (busy) return;
    checkForUpdate()
      .then((found) => found || app.notify('You’re on the latest version.'))
      .catch(() => app.notify('Couldn’t check for updates. Try again later.'));
  };
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={t('App updates')}
      onPress={press}
      style={[s.card, s.row, { gap: 14, padding: 14 }]}
    >
      <RefreshCw size={24} color={color.ink} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.h3}>{t('App updates')}</Text>
        <Text style={s.small}>{status}</Text>
        {/* Channel and update ID, to match against the update list on expo.dev. */}
        <Text style={[s.small, { color: color.soft }]}>
          {[channel, updateId?.slice(0, 8)].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator color={color.soft} />
      ) : (
        <ChevronRight size={18} color={color.soft} />
      )}
    </Press>
  );
}
