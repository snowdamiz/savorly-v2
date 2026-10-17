import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { AtSign, Check, X } from './icons';
import { api } from '../lib/api';
import { useRevealFocus } from '../lib/keyboard';
import { color, font, s } from '../lib/theme';

// The API's rule: 3–24 lowercase letters, digits, dots or underscores, starting and ending with a
// letter or digit, and no two dots in a row.
const pattern = /^[a-z0-9][a-z0-9._]{1,22}[a-z0-9]$/;
const valid = (h: string) => pattern.test(h) && !h.includes('..');
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
  const reveal = useRevealFocus();
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
          onFocus={() => {
            setFocused(true);
            reveal();
          }}
          onBlur={() => setFocused(false)}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          spellCheck={false}
          maxLength={24}
          // An example handle; each language's is valid as one (lowercase Latin letters and dots).
          placeholder={tr('yourname')}
          placeholderTextColor={color.soft}
          style={{
            flex: 1,
            alignSelf: 'stretch',
            fontFamily: font.medium,
            fontSize: 15,
            color: color.ink,
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
