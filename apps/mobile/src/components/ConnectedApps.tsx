import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Bot } from './icons';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, s } from '../lib/theme';
import { ConnectedApp } from '../lib/types';
import { ErrorNote, SettingsRow } from './SettingsRow';
import { Button, Dialog } from './ui';

/**
 * Connected apps in My kitchen: the assistants (ChatGPT, Claude) linked to this kitchen, when each
 * was linked and last used, and Disconnect, which stops it at once (docs/ASSISTANTS.md).
 */
export function ConnectedApps() {
  const { t } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  if (!app.user) return null;
  return (
    <>
      <SettingsRow
        icon={Bot}
        title={t('Connected apps')}
        text={t('Assistants that can use your kitchen')}
        onPress={() => setOpen(true)}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Connected apps')}>
        {open && <AppList />}
      </Dialog>
    </>
  );
}

function AppList() {
  const { t, locale } = useI18n();
  const app = useApp();
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(
    () =>
      api<ConnectedApp[]>('/me/connected-apps')
        .then((list) => {
          setApps(Array.isArray(list) ? list : []);
          setError('');
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // This year's dates without the year, as the rest of the app writes them.
  const day = (at: string) => {
    const date = new Date(at);
    return date.toLocaleDateString(
      locale,
      date.getFullYear() === new Date().getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { dateStyle: 'medium' },
    );
  };
  const disconnect = async (linked: ConnectedApp) => {
    setBusy(linked.id);
    await app.act(async () => {
      try {
        await api(`/me/connected-apps/${encodeURIComponent(linked.id)}`, { method: 'DELETE' });
      } catch (e) {
        // Already disconnected, from the assistant or another device: that's what was wanted.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      setApps((list) => list && list.filter((x) => x.id !== linked.id));
    }, 'That app is disconnected.');
    setBusy('');
  };
  if (error) return <ErrorNote message={t(error)} />;
  if (!apps) return <ActivityIndicator color={color.soft} />;
  if (!apps.length)
    return (
      <Text style={s.muted}>
        {t(
          'No apps are connected. Add Savorly in ChatGPT or Claude to plan meals and fill your grocery list from a chat.',
        )}
      </Text>
    );
  return (
    <View style={{ gap: 4 }}>
      {apps.map((linked) => (
        <View
          key={linked.id}
          style={[s.row, { gap: 12, paddingVertical: 6, minHeight: 52, flexWrap: 'wrap' }]}
        >
          <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
            <Text style={[s.h3, { fontSize: 15 }]}>
              {linked.verified || !linked.host ? linked.name : `${linked.name} · ${linked.host}`}
            </Text>
            <Text style={s.small}>
              {t('Connected {{connected}} · last used {{used}}', {
                connected: day(linked.connectedAt),
                used: day(linked.lastUsedAt),
              })}
            </Text>
          </View>
          <Button
            title={t('Disconnect')}
            label={t('Disconnect {{app}}', { app: linked.name })}
            variant="secondary"
            small
            busy={busy === linked.id}
            disabled={!!busy && busy !== linked.id}
            onPress={() => void disconnect(linked)}
          />
        </View>
      ))}
    </View>
  );
}
