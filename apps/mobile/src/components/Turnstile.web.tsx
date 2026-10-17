import React, { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { color, s } from '../lib/theme';
import { TURNSTILE_SCRIPT, turnstileOptions, turnstileSize } from '../lib/turnstile';
import type { TurnstileProps } from './Turnstile';

type TurnstileApi = {
  render(container: HTMLElement, options: object): string | null | undefined;
  reset(widget: string): void;
  remove(widget: string): void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let script: Promise<TurnstileApi> | null = null;
function loadTurnstile() {
  script ??= new Promise<TurnstileApi>((resolve, reject) => {
    const element = document.createElement('script');
    element.src = `${TURNSTILE_SCRIPT}?render=explicit`;
    element.async = true;
    element.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile is missing'));
    element.onerror = () => {
      script = null;
      element.remove();
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(element);
  });
  return script;
}

// The page renders Cloudflare's widget into a node of its own, loading the script the first time.
export function Turnstile({ siteKey, round, onToken }: TurnstileProps) {
  const { t, language } = useI18n();
  const box = useRef<View>(null);
  const widget = useRef<string | null>(null);
  // Known once the form is measured.
  const [size, setSize] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const report = useEffectEvent(onToken);
  useEffect(() => {
    if (!size) return;
    let gone = false;
    loadTurnstile().then(
      (turnstile) => {
        const node = box.current as unknown as HTMLElement | null;
        if (gone || !node) return;
        setFailed(false);
        widget.current =
          turnstile.render(node, {
            ...turnstileOptions(siteKey, language, size),
            callback: (token: string) => {
              setFailed(false);
              report(token);
            },
            'expired-callback': () => report(''),
            'timeout-callback': () => report(''),
            'error-callback': () => {
              report('');
              setFailed(true);
            },
          }) ?? null;
      },
      () => {
        if (!gone) setFailed(true);
      },
    );
    return () => {
      gone = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
      report('');
    };
  }, [siteKey, language, size]);
  // A token works once, so each new round asks for a fresh one.
  useEffect(() => {
    if (round && widget.current) window.turnstile?.reset(widget.current);
  }, [round]);
  return (
    <View
      onLayout={(e) => setSize(turnstileSize(e.nativeEvent.layout.width))}
      style={{ alignSelf: 'stretch', gap: 6 }}
    >
      <View ref={box} style={{ alignItems: 'center' }} />
      {failed && (
        <Text accessibilityRole="alert" style={[s.small, { color: color.error }]}>
          {t('The security check couldn’t load. Check your connection and try again.')}
        </Text>
      )}
    </View>
  );
}
