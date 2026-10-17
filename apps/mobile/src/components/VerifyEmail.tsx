import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Check, MailCheck } from './icons';
import { api, ApiError } from '../lib/api';
import { useFormRequest } from '../lib/formRequest';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, radius, s } from '../lib/theme';
import { ErrorNote } from './SettingsRow';
import { Button, Dialog, Field } from './ui';

/**
 * Asks a new kitchen to confirm its email address with the 6-digit code sign-up sent, while the
 * address is unconfirmed and the server can send email.
 */
export function VerifyEmail() {
  const { t } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const { busy, error, setError, run } = useFormRequest();
  const user = app.user;
  if (!user || user.emailVerified !== false || !app.capabilities?.passwordRecovery) return null;
  const confirm = () =>
    run(async () => {
      await api('/me/verify-email', { method: 'POST', body: { code: code.trim() } });
      await app.refreshUser();
      setOpen(false);
      app.notify('Your email address is confirmed.');
    });
  const resend = () =>
    run(async () => {
      setResent(false);
      try {
        await api('/me/verify-email/resend', { method: 'POST' });
        setResent(true);
      } catch (e) {
        // Confirmed meanwhile, on another device: nothing left to do here.
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        await app.refreshUser();
        setOpen(false);
      }
    });
  return (
    <>
      <View
        style={{
          backgroundColor: color.warningBg,
          borderRadius: radius.lg,
          padding: 18,
          gap: 10,
        }}
      >
        <View style={[s.row, { gap: 10 }]}>
          <MailCheck size={20} color={color.warning} />
          <Text style={[s.h3, { flex: 1 }]}>{t('Confirm your email address')}</Text>
        </View>
        <Text style={[s.body, { fontSize: 14, lineHeight: 21 }]}>
          {t('We sent a 6-digit code to {{email}}. Enter it to confirm the address is yours.', {
            email: user.email,
          })}
        </Text>
        <Button
          title={t('Enter the code')}
          label={t('Enter the code to confirm your email address')}
          variant="secondary"
          style={{ alignSelf: 'flex-start' }}
          onPress={() => {
            setCode('');
            setResent(false);
            setError('');
            setOpen(true);
          }}
        />
      </View>
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Confirm your email address')}>
        <Text style={s.muted}>
          {t('Enter the 6-digit code we sent to {{email}}.', { email: user.email })}
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
            {t('A new code is on its way to {{email}}.', { email: user.email })}
          </Text>
        )}
        {!!error && <ErrorNote message={t(error)} />}
        <Button
          title={t('Confirm')}
          label={t('Confirm my email address')}
          icon={Check}
          busy={busy}
          disabled={code.length !== 6}
          onPress={() => void confirm()}
        />
        <Button title={t('Send a new code')} variant="ghost" onPress={() => void resend()} />
      </Dialog>
    </>
  );
}
