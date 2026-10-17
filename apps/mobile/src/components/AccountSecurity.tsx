import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import {
  ArrowRight,
  Check,
  Globe,
  KeyRound,
  Laptop,
  LogOut,
  Mail,
  ShieldCheck,
  Smartphone,
  Tablet,
} from './icons';
import { api, ApiError } from '../lib/api';
import { Provider, ProviderToken } from '../lib/auth/provider';
import { clearGoogleConfirmation, googleConfirmation } from '../lib/auth/googleRedirect';
import { useFormRequest } from '../lib/formRequest';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, s } from '../lib/theme';
import { DeviceSession } from '../lib/types';
import { ErrorNote, SettingsRow } from './SettingsRow';
import { SocialButtons } from './SocialButtons';
import { Button, Dialog, Field, Pill } from './ui';

/** A fresh Apple or Google sign-in that confirms a kitchen without a password is yours. */
type Confirmation = { provider: Provider; token: string };
type Flow = 'password' | 'email';

const providerName = (p: Provider) => (p === 'apple' ? 'Apple' : 'Google');
// Registration's rule, which the server applies too (it counts bytes, so it has the last word).
const passwordFits = (p: string) => p.length >= 12 && p.length <= 72;
const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

/**
 * Account and security in My kitchen: the email address (changed with a code sent to the new one),
 * the password (changed, or set for a kitchen made with Apple or Google), and the devices signed in.
 */
export function AccountSecurity() {
  const { t } = useI18n();
  const app = useApp();
  // On the web, Google confirms by leaving the page; it comes back here, to the step that asked.
  const [back] = useState(googleConfirmation);
  const [open, setOpen] = useState(!!back);
  const [flow, setFlow] = useState<Flow | null>(back?.purpose ?? null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(
    back && { provider: 'google', token: back.token },
  );
  useEffect(() => {
    if (back) clearGoogleConfirmation();
  }, [back]);
  const user = app.user;
  if (!user) return null;
  const start = (next: Flow) => {
    setConfirmation(null);
    setFlow(next);
  };
  const done = () => {
    setFlow(null);
    setConfirmation(null);
  };
  const unverified = user.emailVerified === false;
  return (
    <>
      <SettingsRow
        icon={ShieldCheck}
        title={t('Account and security')}
        text={t('Email, password and signed-in devices')}
        onPress={() => setOpen(true)}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Account and security')}>
        <View style={{ gap: 10 }}>
          <Text style={s.label}>{t('Email address')}</Text>
          <View style={[s.row, { gap: 10, flexWrap: 'wrap' }]}>
            <Mail size={18} color={color.ink} />
            <Text style={[s.body, { flexShrink: 1 }]}>{user.email}</Text>
            {unverified && <Pill title={t('Not confirmed yet')} tone="warning" />}
          </View>
          {!!app.capabilities?.passwordRecovery && (
            <Button
              title={t('Change email')}
              label={t('Change your email address')}
              variant="secondary"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => start('email')}
            />
          )}
        </View>
        <View style={{ gap: 10 }}>
          <Text style={s.label}>{t('Password')}</Text>
          <Text style={s.muted}>
            {user.hasPassword === false
              ? t('Add a password to sign in with your email address as well.')
              : t('Changing it signs you out on your other devices.')}
          </Text>
          <Button
            title={user.hasPassword === false ? t('Set a password') : t('Change password')}
            icon={KeyRound}
            variant="secondary"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => start('password')}
          />
        </View>
        <Devices />
      </Dialog>
      {flow === 'password' && <PasswordDialog confirmation={confirmation} onClose={done} />}
      {flow === 'email' && <EmailDialog confirmation={confirmation} onClose={done} />}
    </>
  );
}

/**
 * Confirms a kitchen without a password by signing in again with its Apple or Google account.
 * Google on the web leaves the page and comes back (AccountSecurity picks it up).
 */
function ConfirmWithProvider({
  purpose,
  onConfirmed,
  onError,
}: {
  purpose: Flow;
  onConfirmed: (c: Confirmation) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const app = useApp();
  return (
    <>
      <Text style={s.muted}>
        {t('To confirm it’s you, sign in once more with the account you use for Savorly.')}
      </Text>
      <SocialButtons
        only={app.user?.identities ?? []}
        purpose={purpose}
        onError={onError}
        onToken={(token: ProviderToken) =>
          onConfirmed({ provider: token.provider, token: token.token })
        }
      />
    </>
  );
}

function Confirmed({ confirmation }: { confirmation: Confirmation }) {
  const { t } = useI18n();
  return (
    <Pill
      title={t('Confirmed with {{provider}}', { provider: providerName(confirmation.provider) })}
      icon={Check}
      tone="success"
    />
  );
}

function PasswordDialog({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const app = useApp();
  // A kitchen made with Apple or Google confirms with them instead of a current password.
  const setting = app.user?.hasPassword === false;
  const [confirmed, setConfirmed] = useState(confirmation);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const { busy, error, setError, run } = useFormRequest();
  const save = () =>
    run(
      async () => {
        if (!passwordFits(next)) throw new Error('Use a password of 12–72 characters.');
        if (next !== repeat) throw new Error('The new passwords don’t match.');
        await api('/me/password', {
          method: 'POST',
          body:
            setting && confirmed
              ? { newPassword: next, provider: confirmed.provider, token: confirmed.token }
              : { currentPassword: current, newPassword: next },
        });
        await app.refreshUser();
        onClose();
        app.notify(
          setting
            ? 'Password set. Your other devices were signed out.'
            : 'Password changed. Your other devices were signed out.',
        );
      },
      // A sign-in confirms one request; after a refusal it has to be done again.
      () => setting && setConfirmed(null),
    );
  return (
    <Dialog
      visible
      onClose={onClose}
      title={setting ? t('Set a password') : t('Change your password')}
    >
      {setting && !confirmed ? (
        <ConfirmWithProvider purpose="password" onConfirmed={setConfirmed} onError={setError} />
      ) : (
        <>
          {confirmed && <Confirmed confirmation={confirmed} />}
          {!setting && (
            <Field
              label={t('Current password')}
              value={current}
              onChangeText={setCurrent}
              secureTextEntry
              autoComplete="current-password"
            />
          )}
          <Field
            label={t('New password')}
            value={next}
            onChangeText={setNext}
            placeholder={t('At least 12 characters')}
            secureTextEntry
            autoComplete="new-password"
          />
          <Field
            label={t('Repeat the new password')}
            value={repeat}
            onChangeText={setRepeat}
            secureTextEntry
            autoComplete="new-password"
            onSubmitEditing={() => void save()}
          />
          <Text style={s.small}>
            {t('Your other devices are signed out, and this one stays signed in.')}
          </Text>
        </>
      )}
      {!!error && <ErrorNote message={t(error)} />}
      {(!setting || confirmed) && (
        <Button
          title={setting ? t('Set password') : t('Change password')}
          icon={Check}
          busy={busy}
          disabled={(!setting && !current) || !next || !repeat}
          onPress={() => void save()}
        />
      )}
    </Dialog>
  );
}

function EmailDialog({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const app = useApp();
  const viaProvider = app.user?.hasPassword === false;
  const [confirmed, setConfirmed] = useState(confirmation);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // The address the code went to; the dialog asks for the code once it is set.
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const { busy, error, setError, run } = useFormRequest();
  const send = (again: boolean) =>
    run(
      async () => {
        if (!looksLikeEmail(email)) throw new Error('Enter a valid email address.');
        const result = await api<{ ok: boolean; email?: string }>('/me/email', {
          method: 'POST',
          body:
            viaProvider && confirmed
              ? { email: email.trim(), provider: confirmed.provider, token: confirmed.token }
              : { email: email.trim(), password },
        });
        setSentTo(result?.email || email.trim());
        setCode('');
        setResent(again);
      },
      () => viaProvider && setConfirmed(null),
    );
  const confirm = () =>
    run(async () => {
      await api('/me/email/confirm', { method: 'POST', body: { code: code.trim() } });
      await app.refreshUser();
      onClose();
      app.notify('Your email address is changed.');
    });
  // A sign-in works once, so a kitchen without a password confirms again for a new code.
  const startOver = () => {
    setSentTo('');
    setCode('');
    setResent(false);
    setError('');
    if (viaProvider) setConfirmed(null);
  };
  if (sentTo)
    return (
      <Dialog visible onClose={onClose} title={t('Check your new inbox')}>
        <Text style={s.muted}>
          {t('Enter the 6-digit code we sent to {{email}}. It works for 15 minutes.', {
            email: sentTo,
          })}
        </Text>
        <Field
          label={t('Code from the email')}
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="123456"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          onSubmitEditing={() => void confirm()}
        />
        {resent && !error && (
          <Text style={s.small}>
            {t('A new code is on its way to {{email}}.', { email: sentTo })}
          </Text>
        )}
        {!!error && <ErrorNote message={t(error)} />}
        <Button
          title={t('Confirm the new address')}
          icon={Check}
          busy={busy}
          disabled={code.length !== 6}
          onPress={() => void confirm()}
        />
        <View style={[s.row, { flexWrap: 'wrap', justifyContent: 'center' }]}>
          <Button
            title={t('Send a new code')}
            variant="ghost"
            onPress={() => (viaProvider ? startOver() : void send(true))}
          />
          <Button title={t('Use a different address')} variant="ghost" onPress={startOver} />
        </View>
      </Dialog>
    );
  return (
    <Dialog visible onClose={onClose} title={t('Change your email address')}>
      {viaProvider && !confirmed ? (
        <ConfirmWithProvider purpose="email" onConfirmed={setConfirmed} onError={setError} />
      ) : (
        <>
          {confirmed && <Confirmed confirmation={confirmed} />}
          <Text style={s.muted}>
            {t(
              'We’ll send a code to the new address. Your email changes once you enter it, and your current address gets a note.',
            )}
          </Text>
          <Field
            label={t('New email address')}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          {!viaProvider && (
            <Field
              label={t('Your password')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              onSubmitEditing={() => void send(false)}
            />
          )}
        </>
      )}
      {!!error && <ErrorNote message={t(error)} />}
      {(!viaProvider || confirmed) && (
        <Button
          title={t('Send the code')}
          icon={ArrowRight}
          busy={busy}
          disabled={!email.trim() || (!viaProvider && !password)}
          onPress={() => void send(false)}
        />
      )}
    </Dialog>
  );
}

const deviceIcon = (system: string) =>
  system === 'iPhone' || system === 'Android' || system === 'iOS'
    ? Smartphone
    : system === 'iPad'
      ? Tablet
      : system
        ? Laptop
        : Globe;

/** Where this account is signed in, this device first; any other one can be signed out. */
function Devices() {
  const { t, locale } = useI18n();
  const app = useApp();
  // Each with whether it was used in the last few minutes, as of loading the list.
  const [devices, setDevices] = useState<(DeviceSession & { active: boolean })[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(
    () =>
      api<DeviceSession[]>('/me/sessions')
        .then((list) => {
          const now = Date.now();
          setDevices(
            (Array.isArray(list) ? list : []).map((d) => ({
              ...d,
              active: d.current || now - Date.parse(d.lastUsedAt) < 5 * 60 * 1000,
            })),
          );
          setError('');
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const name = (d: DeviceSession) => {
    const client = d.client === 'Savorly' ? t('Savorly app') : d.client;
    if (client && d.system) return t('{{client}} on {{system}}', { client, system: d.system });
    return client || d.system || t('Unknown device');
  };
  const used = (d: DeviceSession & { active: boolean }) =>
    d.active
      ? t('Active now')
      : t('Last used {{date}}', {
          date: new Date(d.lastUsedAt).toLocaleString(locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        });
  const signOut = async (d: DeviceSession) => {
    setBusy(d.id);
    const ok = await app.act(async () => {
      try {
        await api(`/me/sessions/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      } catch (e) {
        // Already signed out (it expired, or another device did it): that's what was wanted.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      setDevices((list) => list && list.filter((x) => x.id !== d.id));
    }, 'That device is signed out.');
    setBusy('');
    if (ok) void load();
  };
  const signOutOthers = async () => {
    setBusy('others');
    await app.act(async () => {
      await api<{ revoked: number }>('/me/sessions/revoke-others', { method: 'POST' });
      await load();
    }, 'You’re signed out everywhere else.');
    setBusy('');
  };
  const others = devices?.filter((d) => !d.current).length ?? 0;
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.label}>{t('Signed-in devices')}</Text>
      {!devices && !error && <ActivityIndicator color={color.soft} />}
      {!!error && <ErrorNote message={t(error)} />}
      {devices?.map((d) => {
        const Icon = deviceIcon(d.system);
        return (
          <View
            key={d.id}
            style={[s.row, { gap: 12, paddingVertical: 6, minHeight: 52, flexWrap: 'wrap' }]}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: color.bg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon size={18} color={color.ink} strokeWidth={1.9} />
            </View>
            <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
              <Text style={[s.h3, { fontSize: 15 }]}>{name(d)}</Text>
              <Text style={s.small}>{used(d)}</Text>
            </View>
            {d.current ? (
              <Pill title={t('This device')} icon={Check} tone="dark" />
            ) : (
              <Button
                title={t('Sign out')}
                label={t('Sign out {{device}}', { device: name(d) })}
                variant="secondary"
                busy={busy === d.id}
                disabled={!!busy && busy !== d.id}
                onPress={() => void signOut(d)}
              />
            )}
          </View>
        );
      })}
      {others > 0 && (
        <Button
          title={t('Sign out everywhere else')}
          icon={LogOut}
          variant="secondary"
          busy={busy === 'others'}
          disabled={!!busy && busy !== 'others'}
          onPress={() => void signOutOthers()}
        />
      )}
    </View>
  );
}
