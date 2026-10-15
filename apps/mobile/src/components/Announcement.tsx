import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AlertTriangle, Megaphone, X } from 'lucide-react-native';
import { useI18n } from '../lib/i18n';
import { Announcement } from '../lib/types';
import { color, font, radius, shadow } from '../lib/theme';
import { FadeIn, IconButton, useChrome } from './ui';

const DISMISSED_KEY = 'savorly.announcement.dismissed';

// Written by an admin in one language, so the text itself is never translated.
export function AnnouncementCard({
  announcement,
  onDismiss,
}: {
  announcement: Announcement;
  onDismiss?: () => void;
}) {
  const { t: tr } = useI18n();
  const warning = announcement.tone === 'warning';
  const Icon = warning ? AlertTriangle : Megaphone;
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 18,
        paddingRight: onDismiss ? 8 : 18,
        paddingVertical: 10,
        minHeight: 56,
        borderRadius: radius.lg,
        backgroundColor: warning ? color.warningBg : color.ink,
        boxShadow: shadow.card,
      }}
    >
      <Icon size={18} color={warning ? color.warning : color.white} strokeWidth={2} />
      <Text
        style={{
          flex: 1,
          fontFamily: font.semibold,
          fontSize: 14,
          lineHeight: 20,
          color: warning ? color.ink : color.white,
        }}
      >
        {announcement.text}
      </Text>
      {onDismiss && (
        <IconButton
          icon={X}
          size={36}
          plain={warning}
          dark={!warning}
          label={tr('Dismiss announcement')}
          onPress={onDismiss}
        />
      )}
    </View>
  );
}

/** Floats over the top of every screen until dismissed; a new message shows again. */
export function AnnouncementBanner({ announcement }: { announcement?: Announcement | null }) {
  const { desktop, insets, gutter } = useChrome();
  // Unknown until storage answers, so a dismissed message never flashes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(DISMISSED_KEY)
      .then((v) => live && setDismissed(v ?? ''))
      .catch(() => live && setDismissed(''));
    return () => {
      live = false;
    };
  }, []);
  if (!announcement?.text || dismissed === null || dismissed === announcement.text) return null;
  const dismiss = () => {
    setDismissed(announcement.text);
    AsyncStorage.setItem(DISMISSED_KEY, announcement.text).catch(() => {});
  };
  return (
    <View
      style={{
        position: 'absolute',
        top: desktop ? insets.top + 84 + 12 : insets.top + 8,
        left: desktop ? 248 + gutter : 12,
        right: desktop ? gutter : 12,
        alignItems: 'center',
        pointerEvents: 'box-none',
      }}
    >
      <FadeIn offset={-12} style={{ width: '100%', maxWidth: 640 }}>
        <AnnouncementCard announcement={announcement} onDismiss={dismiss} />
      </FadeIn>
    </View>
  );
}
