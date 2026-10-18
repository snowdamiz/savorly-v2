import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Text, View } from 'react-native';
import { Bookmark, CalendarDays, LucideIcon, ShieldAlert, ShoppingBasket } from './icons';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, s } from '../lib/theme';
import { AssistantScope, ConnectRequest } from '../lib/types';
import { ErrorNote } from './SettingsRow';
import { Button, Dialog } from './ui';

const scopeIcons: Record<AssistantScope, LucideIcon> = {
  cookbooks: Bookmark,
  planner: CalendarDays,
  groceries: ShoppingBasket,
};

/**
 * The page where ChatGPT, Claude or another assistant asks to connect to the member's kitchen
 * (/oauth/authorize, docs/ASSISTANTS.md): what it may do, where the member goes back to, and a
 * yes or no that sends them there. A guest signs in first.
 */
export function ConnectApp({ query, onDone }: { query: string; onDone: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const [request, setRequest] = useState<ConnectRequest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'yes' | 'no' | ''>('');
  // Where the member is being sent back to, once they are: '' when it isn't known.
  const [leaving, setLeaving] = useState<string | null>(null);
  const leave = useCallback(
    (url: string, host: string) => {
      setLeaving(host);
      if (Platform.OS === 'web') window.location.assign(url);
      else {
        void Linking.openURL(url);
        onDone();
      }
    },
    [onDone],
  );
  useEffect(() => {
    let live = true;
    api<ConnectRequest>(`/oauth/authorize?${query}`)
      .then((r) => {
        if (!live) return;
        if (r.redirect) leave(r.redirect, '');
        else setRequest(r);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [query, leave]);
  const asking = request?.client ? request : null;
  const name = asking?.client.name ?? '';
  const answer = async (approve: boolean) => {
    setBusy(approve ? 'yes' : 'no');
    setError('');
    try {
      const r = await api<{ redirect: string }>('/oauth/authorize', {
        method: 'POST',
        body: { request: query, approve },
      });
      leave(r.redirect, asking?.redirectHost ?? '');
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  };
  // Closing is a no, so the assistant isn't left waiting; a guest just stays in Savorly.
  const close = () => {
    if (busy || leaving !== null) return;
    if (asking && app.user) void answer(false);
    else onDone();
  };
  const caution = !asking
    ? ''
    : asking.localhost
      ? t('This app runs on this device. Connect it only if you started it yourself.')
      : !asking.client.verified
        ? t('Savorly doesn’t know {{host}}. Connect only apps you trust.', {
            host: asking.client.host,
          })
        : '';
  return (
    <Dialog
      // The sign-in dialog takes its place until the member is in.
      visible={!app.authOpen}
      onClose={close}
      title={name ? t('Connect {{app}} to Savorly', { app: name }) : t('Connect an app')}
    >
      {leaving !== null ? (
        <View style={[s.row, { gap: 10 }]}>
          <ActivityIndicator color={color.soft} />
          <Text style={s.muted}>
            {leaving ? t('Taking you back to {{host}}…', { host: leaving }) : t('Taking you back…')}
          </Text>
        </View>
      ) : error && !asking ? (
        <ErrorNote message={t(error)} />
      ) : !asking ? (
        <ActivityIndicator color={color.soft} />
      ) : !app.user ? (
        <>
          <Text style={s.muted}>
            {t('Sign in to choose what {{app}} can do in your kitchen.', { app: name })}
          </Text>
          <Button title={t('Sign in')} onPress={() => app.setAuthOpen(true)} />
        </>
      ) : (
        <>
          <View style={{ gap: 12 }}>
            <Text style={s.label}>{t('{{app}} will be able to', { app: name })}</Text>
            {asking.scopes.map((scope) => {
              const Icon = scopeIcons[scope];
              return (
                <View key={scope} style={[s.row, { gap: 12 }]}>
                  <Icon size={18} color={color.ink} strokeWidth={1.9} />
                  <Text style={[s.body, { flex: 1 }]}>
                    {
                      {
                        cookbooks: t('Save recipes and see what you saved'),
                        planner: t('Plan meals and read your meal plan'),
                        groceries: t('Add to your grocery list and read it'),
                      }[scope]
                    }
                  </Text>
                </View>
              );
            })}
          </View>
          {!!caution && (
            <View style={[s.row, { gap: 8, alignItems: 'flex-start' }]}>
              <ShieldAlert size={16} color={color.warning} strokeWidth={2} />
              <Text style={[s.small, { flex: 1, color: color.warning }]}>{caution}</Text>
            </View>
          )}
          <Text style={s.small}>
            {t('You’ll go back to {{host}}. You can disconnect it in My kitchen at any time.', {
              host: asking.redirectHost,
            })}
          </Text>
          {!!error && <ErrorNote message={t(error)} />}
          <View style={{ gap: 8 }}>
            <Button
              title={t('Connect')}
              busy={busy === 'yes'}
              disabled={!!busy}
              onPress={() => void answer(true)}
            />
            <Button
              title={t('Cancel')}
              variant="ghost"
              busy={busy === 'no'}
              disabled={!!busy}
              onPress={() => void answer(false)}
            />
          </View>
        </>
      )}
    </Dialog>
  );
}
