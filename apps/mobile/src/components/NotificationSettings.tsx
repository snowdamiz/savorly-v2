import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Pressable, Text, View } from 'react-native';
import { Bell, Check } from './icons';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
  enablePush,
  openNotificationSettings,
  PushPermission,
  pushPermission,
  pushSupported,
  refreshPush,
} from '../lib/push';
import { useApp } from '../lib/store';
import { color, font, radius, s } from '../lib/theme';
import { NotificationPreferences } from '../lib/types';
import { SettingsRow } from './SettingsRow';
import { animate, Button, Dialog, Pill } from './ui';

type Kind = keyof NotificationPreferences;
const everything: NotificationPreferences = {
  follows: true,
  pantry: true,
  reviews: true,
  comments: true,
};

/** A setting that is on or off: the whole row is the switch. */
function SwitchRow({
  title,
  text,
  value,
  onChange,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: () => void;
}) {
  const on = useState(() => new Animated.Value(value ? 1 : 0))[0];
  useEffect(() => {
    animate(on, value ? 1 : 0, 180).start();
  }, [value, on]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={text}
      accessibilityState={{ checked: value }}
      aria-checked={value}
      onPress={onChange}
      style={[s.row, { gap: 14, minHeight: 56, paddingVertical: 8 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.body, { fontFamily: font.semibold }]}>{title}</Text>
        <Text style={s.small}>{text}</Text>
      </View>
      <View
        style={{
          width: 46,
          height: 28,
          borderRadius: radius.pill,
          padding: 2,
          borderWidth: 1,
          borderColor: value ? color.ink : color.outline,
          backgroundColor: value ? color.ink : color.subtle,
        }}
      >
        <Animated.View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: color.white,
            boxShadow: '0px 1px 3px rgba(0,0,0,0.25)',
            transform: [
              { translateX: on.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }) },
            ],
          }}
        />
      </View>
    </Pressable>
  );
}

/**
 * Which notifications the account gets, saved with the account. On a phone this is also where it
 * asks to show notifications: when the cook turns one on, or presses the button, never at launch.
 */
export function NotificationSettings() {
  const { t } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  // This phone's permission, once known; the web has none to ask for.
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [asking, setAsking] = useState(false);
  // Switches flip at once and settle when the server answers; the newest change of each wins.
  const [changes, setChanges] = useState<Partial<NotificationPreferences>>({});
  const latest = useRef<Partial<Record<Kind, number>>>({});
  const known = useRef<PushPermission | null>(null);
  const channel = t('Recipes and reminders');
  const signedIn = !!app.user;
  const check = useCallback(
    () =>
      void pushPermission().then((next) => {
        // Allowed in the phone's settings since the last look: register the phone now.
        if (next === 'granted' && known.current && known.current !== 'granted')
          void refreshPush(channel);
        known.current = next;
        setPermission(next);
      }),
    [channel],
  );
  useEffect(() => {
    if (!pushSupported || !signedIn) return;
    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => sub.remove();
  }, [check, signedIn]);
  if (!app.user) return null;
  const shown = { ...everything, ...app.user.preferences.notifications, ...changes };
  const turnOn = async () => {
    setAsking(true);
    const next = await enablePush(channel);
    known.current = next;
    setPermission(next);
    setAsking(false);
  };
  const toggle = async (kind: Kind) => {
    const value = shown[kind] === false;
    const n = (latest.current[kind] ?? 0) + 1;
    latest.current[kind] = n;
    setChanges((c) => ({ ...c, [kind]: value }));
    // Turning one on is the moment to ask, if this phone never has.
    if (value && pushSupported && (await pushPermission()) === 'undetermined') void turnOn();
    await app.act(async () => {
      await api('/me/preferences', { method: 'PATCH', body: { notifications: { [kind]: value } } });
      await app.refreshUser();
    });
    if (latest.current[kind] !== n) return;
    setChanges((c) => {
      const rest = { ...c };
      delete rest[kind];
      return rest;
    });
  };
  const kinds: { kind: Kind; title: string; text: string }[] = [
    {
      kind: 'follows',
      title: t('New recipes'),
      text: t('When a cook you follow shares a recipe'),
    },
    {
      kind: 'pantry',
      title: t('Pantry reminders'),
      text: t('When something in your pantry is about to expire'),
    },
    { kind: 'reviews', title: t('Reviews'), text: t('When someone reviews one of your recipes') },
    {
      kind: 'comments',
      title: t('Comments'),
      text: t('When someone comments on your recipes or replies to your reviews'),
    },
  ];
  return (
    <>
      <SettingsRow
        icon={Bell}
        title={t('Notifications')}
        text={
          permission === 'denied'
            ? t('Off in your phone’s settings')
            : t('New recipes, pantry reminders, reviews and comments')
        }
        onPress={() => setOpen(true)}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Notifications')}>
        {!pushSupported && (
          <Text style={s.muted}>
            {t('Savorly sends these to the phones where you use the app.')}
          </Text>
        )}
        {permission === 'granted' && (
          <Pill title={t('On for this phone')} icon={Check} tone="success" />
        )}
        {(permission === 'undetermined' || permission === 'unavailable') && (
          <View style={{ gap: 10 }}>
            <Text style={s.muted}>
              {permission === 'undetermined'
                ? t('Turn on notifications to get these on this phone.')
                : t('This phone couldn’t be set up for notifications. Try again later.')}
            </Text>
            <Button
              title={permission === 'undetermined' ? t('Turn on notifications') : t('Try again')}
              icon={Bell}
              busy={asking}
              onPress={() => void turnOn()}
            />
          </View>
        )}
        {permission === 'denied' && (
          <View style={{ gap: 10 }}>
            <Text style={s.muted}>
              {t('Notifications are off for Savorly in your phone’s settings.')}
            </Text>
            <Button
              title={t('Open settings')}
              variant="secondary"
              onPress={openNotificationSettings}
            />
          </View>
        )}
        <View>
          {kinds.map(({ kind, title, text }) => (
            <SwitchRow
              key={kind}
              title={title}
              text={text}
              value={shown[kind] !== false}
              onChange={() => void toggle(kind)}
            />
          ))}
        </View>
      </Dialog>
    </>
  );
}
