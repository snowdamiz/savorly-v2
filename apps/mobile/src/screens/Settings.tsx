import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { LogOut, Trash2, UserRound } from '../components/icons';
import { useI18n } from '../lib/i18n';
import { api, persistSession } from '../lib/api';
import { useApp } from '../lib/store';
import { Screen } from '../lib/types';
import { color, radius, s } from '../lib/theme';
import { Dialog, Field, PageHeading } from '../components/ui';
import { DangerButton } from '../components/DangerButton';
import { SettingsGroup, SettingsRow } from '../components/SettingsRow';
import { SocialButtons } from '../components/SocialButtons';
import { PlanSettings } from '../components/PlanSettings';
import { AccountSecurity } from '../components/AccountSecurity';
import { ConnectedApps } from '../components/ConnectedApps';
import { DataExport } from '../components/DataExport';
import { FoodPreferences } from '../components/FoodPreferences';
import { UnitSettings } from '../components/UnitSettings';
import { YourCooking } from '../components/YourVersion';
import { LanguageSettings } from '../components/LanguageSettings';
import { NotificationSettings } from '../components/NotificationSettings';
import { UpdateSettings } from '../components/AppUpdates';
import { LegalLinks } from '../components/Legal';
import { AdminPending } from './admin/AdminPending';

/**
 * Settings, apart from My kitchen's recipes and kitchen: the plan and the account, then food and
 * cooking, then this app, then signing out. Each group is one card of rows that open sheets.
 */
export function Settings({ navigate }: { navigate: (s: Screen) => void }) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [remove, setRemove] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const user = app.user;
  // Deleting also cancels any subscription; a kitchen without a password confirms by signing in.
  const deleteAccount = (body: object) => {
    setBusy(true);
    return app
      .act(async () => {
        await api('/me', { method: 'DELETE', body });
        await persistSession(null);
        setRemove(false);
        setPassword('');
        await app.load();
        navigate('discover');
      }, 'Your account has been deleted.')
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: 26, width: '100%', maxWidth: 640 }}>
      <PageHeading title={tr('Settings')} />
      <AdminPending />
      {user ? (
        <>
          {app.capabilities?.plans && <PlanSettings />}
          <SettingsGroup title={tr('Account')}>
            <AccountSecurity />
            <ConnectedApps />
            <DataExport />
          </SettingsGroup>
          <SettingsGroup title={tr('Food and cooking')}>
            <FoodPreferences />
            <UnitSettings />
            <YourCooking />
          </SettingsGroup>
        </>
      ) : (
        <SettingsGroup>
          <SettingsRow
            icon={UserRound}
            title={tr('Sign in or join')}
            text={tr('Join to save recipes, plan your week and share dishes of your own.')}
            onPress={() => app.setAuthOpen(true)}
          />
        </SettingsGroup>
      )}
      <SettingsGroup title={tr('App')}>
        <LanguageSettings />
        <NotificationSettings />
        <UpdateSettings />
      </SettingsGroup>
      {user && (
        <SettingsGroup>
          <SettingsRow
            icon={LogOut}
            title={tr('Sign out')}
            action
            onPress={() => void app.act(app.signOut)}
          />
          <SettingsRow
            icon={Trash2}
            title={tr('Delete my account')}
            danger
            action
            onPress={() => setRemove(true)}
          />
        </SettingsGroup>
      )}
      <LegalLinks />
      <Dialog visible={remove} onClose={() => setRemove(false)} title={tr('Delete your account?')}>
        <View style={{ backgroundColor: color.errorBg, borderRadius: radius.md, padding: 16 }}>
          <Text style={[s.body, { color: color.error }]}>
            {tr(
              'This permanently deletes your account, recipes, reviews and kitchen lists. It can’t be undone.',
            )}
          </Text>
        </View>
        {user?.hasPassword !== false ? (
          <>
            <Field
              label={tr('Your password')}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
            <DangerButton
              title={tr('Permanently delete my account')}
              busy={busy}
              disabled={!password}
              onPress={() => void deleteAccount({ password })}
            />
          </>
        ) : (
          <>
            <Text style={s.muted}>
              {tr('To confirm it’s you, sign in once more with the account you use for Savorly.')}
            </Text>
            <SocialButtons
              only={user.identities ?? []}
              purpose="delete"
              onError={app.notify}
              onToken={(t) => void deleteAccount({ provider: t.provider, token: t.token })}
            />
          </>
        )}
      </Dialog>
    </View>
  );
}
