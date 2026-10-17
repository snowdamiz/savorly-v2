import React, { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { useI18n } from '../lib/i18n';
import { ApiError } from '../lib/api';
import { useApp } from '../lib/store';
import { color, font } from '../lib/theme';
import { native } from './ui';

/**
 * Runs a request from inside a sheet and keeps its error there, where the cook is looking: the
 * app's toast sits under an open sheet. A 401 still goes through act(), which signs out and asks
 * to sign in again.
 */
export function useSheetAction() {
  const { act } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError('');
      try {
        await fn();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) void act(() => Promise.reject(e));
        else if ((e as Error | undefined)?.name !== 'AbortError') setError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [act],
  );
  return { busy, error, setError, run };
}

/** A sheet's error, in the reader's language: read aloud on the apps, a live region on the web. */
export function SheetError({ message }: { message: string }) {
  const { t: tr } = useI18n();
  const text = message ? tr(message) : '';
  useEffect(() => {
    if (native && text) AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
  return text ? (
    <Text
      accessibilityLiveRegion={native ? undefined : 'polite'}
      style={{ fontFamily: font.medium, fontSize: 14, lineHeight: 20, color: color.error }}
    >
      {text}
    </Text>
  ) : null;
}
