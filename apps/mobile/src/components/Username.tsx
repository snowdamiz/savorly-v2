import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Text, TextInput, TextStyle, View } from 'react-native';
import { AtSign, Check, X } from 'lucide-react-native';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { color, font, s } from '../lib/theme';
import { Avatar, Button, Dialog } from './ui';

// The API's rule: 3–24 lowercase letters, digits, dots or underscores, starting and ending with a
// letter or digit, and no two dots in a row.
const pattern = /^[a-z0-9][a-z0-9._]{1,22}[a-z0-9]$/;
const valid = (h: string) => pattern.test(h) && !h.includes('..');
// The pill shows focus itself, so the browser's rectangular ring around the inner input goes.
const bare = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as unknown as TextStyle;
const clean = (v: string) =>
  v
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._]/g, '')
    .slice(0, 24);
type Verdict = 'available' | 'taken' | 'invalid' | 'unknown';
export type HandleState = 'same' | 'checking' | Verdict;

/** A username being edited, checked against the server as the cook pauses typing. */
export function useHandle(current: string) {
  const [base, setBase] = useState(current);
  const [value, setValue] = useState(current);
  // A new current handle (signed in, or saved) restarts the edit from it.
  if (base !== current) {
    setBase(current);
    setValue(current);
  }
  const [checked, setChecked] = useState<Partial<Record<string, Verdict>>>({});
  const pending = value !== current && valid(value) && !checked[value];
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const timer = setTimeout(() => {
      api<{ valid: boolean; available: boolean }>(`/handles/${encodeURIComponent(value)}`)
        .then((r) => (!r.valid ? 'invalid' : r.available ? 'available' : 'taken'))
        // Offline or rate-limited: let the cook try, and the save will say if it's taken.
        .catch((): Verdict => 'unknown')
        .then((result) => live && setChecked((m) => ({ ...m, [value]: result as Verdict })));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [pending, value]);
  const state: HandleState =
    value === current ? 'same' : !valid(value) ? 'invalid' : (checked[value] ?? 'checking');
  return {
    value,
    setValue: (v: string) => setValue(clean(v)),
    state,
    changed: value !== current,
    ready: state === 'same' || state === 'available' || state === 'unknown',
  };
}

export function HandleField({ handle }: { handle: ReturnType<typeof useHandle> }) {
  const { t: tr } = useI18n();
  const { state, value } = handle;
  const [focused, setFocused] = useState(false);
  const bad = state === 'taken' || (state === 'invalid' && value.length >= 3);
  const note =
    state === 'checking'
      ? tr('Checking…')
      : state === 'available'
        ? tr('@{{v0}} is available.', { v0: value })
        : state === 'taken'
          ? tr('That username is taken.')
          : state === 'unknown'
            ? tr('We’ll check it when you save.')
            : tr('Usernames use 3–24 lowercase letters, numbers, dots or underscores.');
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontFamily: font.semibold, fontSize: 13, color: color.muted }}>
        {tr('Username')}
      </Text>
      <View
        style={[
          s.input,
          s.row,
          { gap: 6, paddingVertical: 0 },
          focused && { borderColor: color.ink },
          bad && { borderColor: color.error },
          state === 'available' && { borderColor: color.success },
        ]}
      >
        <AtSign size={17} color={color.muted} strokeWidth={2} />
        <TextInput
          accessibilityLabel={tr('Username')}
          value={value}
          onChangeText={handle.setValue}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          spellCheck={false}
          maxLength={24}
          placeholder="yourname"
          placeholderTextColor={color.soft}
          style={{
            flex: 1,
            alignSelf: 'stretch',
            fontFamily: font.medium,
            fontSize: 15,
            color: color.ink,
            ...bare,
          }}
        />
        {state === 'checking' ? (
          <ActivityIndicator size="small" color={color.muted} />
        ) : state === 'available' ? (
          <Check size={18} color={color.success} strokeWidth={2.6} />
        ) : bad ? (
          <X size={18} color={color.error} strokeWidth={2.6} />
        ) : null}
      </View>
      <Text
        accessibilityLiveRegion="polite"
        style={[
          s.small,
          { fontFamily: font.medium },
          bad && { color: color.error },
          state === 'available' && { color: color.success },
        ]}
      >
        {note}
      </Text>
    </View>
  );
}

/** Saves a new username with the rest of the profile as it is (the API replaces it whole). */
export function useSaveHandle() {
  const app = useApp();
  return (handle: string) => {
    const u = app.user!;
    return api('/me', {
      method: 'PATCH',
      body: { name: u.name, bio: u.bio, avatar: u.avatar, preferences: u.preferences, handle },
    }).then(() => app.refreshUser());
  };
}

// A brand-new kitchen gets a suggested username; this is the moment to make it their own.
export function UsernamePrompt({ visible, onDone }: { visible: boolean; onDone: () => void }) {
  const { t: tr } = useI18n();
  const app = useApp();
  const handle = useHandle(app.user?.handle || '');
  const save = useSaveHandle();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const finish = async () => {
    setError('');
    if (!handle.changed) {
      app.notify(tr('Welcome to the table, @{{v0}}.', { v0: handle.value }));
      return onDone();
    }
    setBusy(true);
    try {
      await save(handle.value);
      app.notify(tr('Welcome to the table, @{{v0}}.', { v0: handle.value }));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog visible={visible} onClose={onDone}>
      <View style={{ gap: 16, paddingTop: 10 }}>
        <Avatar name={app.user?.name || ''} uri={app.user?.avatar} size={64} />
        <Text style={[s.h1, { paddingRight: 40 }]}>{tr('Pick your username')}</Text>
        <Text style={s.muted}>
          {tr(
            'It’s how other cooks find you and see your recipes. You can change it anytime in My kitchen.',
          )}
        </Text>
        <HandleField handle={handle} />
        {!!error && (
          <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
            {tr(error)}
          </Text>
        )}
        <Button
          title={handle.changed ? tr('Save username') : tr('Keep @{{v0}}', { v0: handle.value })}
          busy={busy}
          disabled={!handle.ready}
          large
          onPress={() => void finish()}
        />
      </View>
    </Dialog>
  );
}
