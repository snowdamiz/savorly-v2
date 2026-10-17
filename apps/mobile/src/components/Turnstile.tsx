import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { WEB_URL } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { color, s } from '../lib/theme';
import { turnstilePage, turnstileSize } from '../lib/turnstile';

export type TurnstileProps = {
  /** The public site key from /v1/capabilities. */
  siteKey: string;
  /** Each new number asks for a fresh token, since a token works for a single request. */
  round: number;
  /** The check's token, or '' while there is none: not passed yet, expired, or failed. */
  onToken: (token: string) => void;
};

type Message = { type?: string; token?: string; height?: number };

// The apps can't run Cloudflare's script themselves, so a small web view shows the widget on the
// site's own address (a site key accepts tokens only from the hostnames it lists) and posts the
// token back. It is a point tall until the widget needs the cook, then as tall as the widget.
export function Turnstile({ siteKey, round, onToken }: TurnstileProps) {
  const { t, language } = useI18n();
  const view = useRef<WebView>(null);
  // Known once the form is measured.
  const [size, setSize] = useState<string | null>(null);
  const [height, setHeight] = useState(0);
  const [failed, setFailed] = useState(false);
  const report = useEffectEvent(onToken);
  const html = useMemo(
    () => (size ? turnstilePage(siteKey, language, size) : ''),
    [siteKey, language, size],
  );
  // A new page starts a new check, and its token goes with the old one.
  useEffect(() => () => report(''), [html]);
  useEffect(() => {
    if (round)
      view.current?.injectJavaScript('window.resetChallenge&&window.resetChallenge();true;');
  }, [round]);
  const receive = (event: WebViewMessageEvent) => {
    let message: Message;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === 'token' && message.token) {
      setFailed(false);
      onToken(message.token);
    } else if (message.type === 'expired') onToken('');
    else if (message.type === 'error') {
      onToken('');
      setFailed(true);
    } else if (message.type === 'height' && typeof message.height === 'number')
      setHeight(Math.ceil(message.height));
  };
  return (
    <View
      onLayout={(e) => setSize(turnstileSize(e.nativeEvent.layout.width))}
      style={{ alignSelf: 'stretch', gap: 6 }}
    >
      {!!html && (
        <View style={{ height: Math.max(1, height) }}>
          <WebView
            ref={view}
            source={{ html, baseUrl: WEB_URL }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            thirdPartyCookiesEnabled
            scrollEnabled={false}
            setSupportMultipleWindows={false}
            onMessage={receive}
            // The widget's frames load inside; a link it shows opens in the browser instead.
            onShouldStartLoadWithRequest={(request) => {
              if (!request.isTopFrame || /^(about|data):/.test(request.url)) return true;
              if (request.url.startsWith(WEB_URL)) return true;
              void Linking.openURL(request.url).catch(() => {});
              return false;
            }}
            style={{ backgroundColor: 'transparent' }}
          />
        </View>
      )}
      {failed && (
        <Text accessibilityRole="alert" style={[s.small, { color: color.error }]}>
          {t('The security check couldn’t load. Check your connection and try again.')}
        </Text>
      )}
    </View>
  );
}
