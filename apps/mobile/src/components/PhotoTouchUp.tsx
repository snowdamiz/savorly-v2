import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Check, RotateCcw, Sparkles } from 'lucide-react-native';
import { useApp } from '../lib/store';
import { touchUpPhoto } from '../lib/photos';
import { haptic } from '../lib/haptics';
import { color, radius, s } from '../lib/theme';
import { Button, Dialog, FoodImage, Segmented } from './ui';
import { Working } from './ProfilePhoto';

/**
 * Touch up a recipe photo: the same dish with better light, color and focus. It runs only when
 * asked, and the cook compares it with the original before keeping either.
 */
export function PhotoTouchUp({
  uri,
  onClose,
  onUse,
}: {
  /** The photo to touch up; the sheet is open while it's set. */
  uri: string | null;
  onClose: () => void;
  onUse: (url: string) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [result, setResult] = useState('');
  const [showBefore, setShowBefore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Each photo starts fresh.
  const [opened, setOpened] = useState(uri);
  if (opened !== uri) {
    setOpened(uri);
    setResult('');
    setShowBefore(false);
    setBusy(false);
    setError('');
  }
  const live = useRef(false);
  useEffect(() => {
    live.current = !!uri;
    return () => {
      live.current = false;
    };
  }, [uri]);
  const run = async () => {
    if (!uri || busy || !app.requireUser()) return;
    haptic.tap();
    setBusy(true);
    setError('');
    try {
      const url = await touchUpPhoto(uri, 'dish', () => live.current);
      if (!url || !live.current) return;
      haptic.soft();
      setResult(url);
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const shown = result && !showBefore ? result : uri || '';
  return (
    <Dialog visible={!!uri} onClose={onClose} title={tr('Touch up with AI')}>
      <View>
        <FoodImage uri={shown} style={{ height: 260, borderRadius: radius.md }} />
        {busy && <Working touch radius={radius.md} />}
      </View>
      {busy ? (
        <Text accessibilityLiveRegion="polite" style={[s.small, { textAlign: 'center' }]}>
          {tr('Touching up your photo… This takes about half a minute.')}
        </Text>
      ) : result ? (
        <Segmented
          value={showBefore ? 'before' : 'after'}
          onChange={(v) => setShowBefore(v === 'before')}
          options={[
            { value: 'before', label: tr('Before') },
            { value: 'after', label: tr('Touched up') },
          ]}
        />
      ) : (
        <Text style={s.muted}>
          {tr('Better light, color and focus, with the same dish, plating and portions.')}
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
          {tr(error)}
        </Text>
      )}
      {result ? (
        <>
          <Button
            title={tr('Use touched-up photo')}
            icon={Check}
            large
            onPress={() => {
              onUse(result);
              onClose();
            }}
          />
          <Button title={tr('Keep the original')} variant="ghost" onPress={onClose} />
        </>
      ) : (
        <Button
          title={error ? tr('Try again') : tr('Touch up with AI')}
          icon={error ? RotateCcw : Sparkles}
          large
          busy={busy}
          onPress={() => void run()}
        />
      )}
    </Dialog>
  );
}
