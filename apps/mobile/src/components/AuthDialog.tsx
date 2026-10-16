import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { ArrowRight } from 'lucide-react-native';
import { useApp } from '../lib/store';
import { api, persistSession } from '../lib/api';
import { color, s } from '../lib/theme';
import { Button, Dialog, Field } from './ui';
import { SocialButtons } from './SocialButtons';
import { BrandMark } from './Brand';
import { ProviderToken } from '../lib/auth/provider';
type Signed = { token?: string; created?: boolean };
export function AuthDialog() {
  const { t: tr } = useI18n();
  const app = useApp();
  const [register, setRegister] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Each opening starts on the side it was opened for.
  const [opened, setOpened] = useState(app.authOpen);
  if (opened !== app.authOpen) {
    setOpened(app.authOpen);
    if (app.authOpen) {
      setRegister(app.authMode === 'register');
      setRecovery(false);
      setSent(false);
      setError('');
    }
  }
  // A brand-new kitchen goes on to its setup, which does the welcoming.
  const signedIn = async (result: Signed, greeting: string) => {
    if (result.token) await persistSession(result.token);
    await app.refreshUser();
    setPassword('');
    if (!result.created) app.notify(greeting);
    app.setAuthOpen(false);
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (recovery) {
        if (!sent) {
          await api('/auth/forgot', { method: 'POST', body: { email } });
          setSent(true);
        } else {
          await api('/auth/reset', { method: 'POST', body: { email, code, password } });
          setRecovery(false);
          setSent(false);
          setPassword('');
          app.notify('Your password is updated. Sign in to return to your kitchen.');
        }
        return;
      }
      const result = await api<Signed>(register ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: { name, email, password },
      });
      await signedIn(
        result,
        register ? 'Welcome to the table. Make yourself at home.' : 'Welcome back to your kitchen.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withProvider = async (t: ProviderToken) => {
    setError('');
    try {
      const result = await api<Signed>('/auth/oauth', { method: 'POST', body: t });
      await signedIn(result, 'Welcome to your kitchen.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <Dialog visible={app.authOpen} onClose={() => app.setAuthOpen(false)}>
        <View style={{ gap: 16 }}>
          <View
            style={{
              width: 56,
              height: 56,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <BrandMark size={42} />
          </View>
          <Text style={s.h1}>
            {recovery
              ? tr('Back to your kitchen.')
              : register
                ? tr('A seat at the table.')
                : tr('Back for seconds?')}
          </Text>
          <Text style={s.muted}>
            {recovery
              ? sent
                ? tr(
                    'If an account exists for this address, a reset code is on its way. Enter it below with a new password.',
                  )
                : tr('Enter your email and we’ll send a code to help you sign in again.')
              : register
                ? tr('Save the recipes you love. Share the dishes you make. Find your people.')
                : tr(
                    'Sign in to your cookbooks, your weekly plans, and a little kitchen inspiration.',
                  )}
          </Text>
          {!recovery && (
            <SocialButtons onToken={withProvider} onError={setError}>
              <Text style={[s.small, { textAlign: 'center' }]}>{tr('or use your email')}</Text>
            </SocialButtons>
          )}
          {register && !recovery && (
            <Field
              label={tr('Your name')}
              value={name}
              onChangeText={setName}
              placeholder={tr('What should we call you?')}
              autoComplete="name"
            />
          )}
          <Field
            label={tr('Email address')}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          {recovery && sent && (
            <Field
              label={tr('Reset code')}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={8}
              placeholder={tr('8-digit code')}
            />
          )}
          {(!recovery || sent) && (
            <Field
              label={tr('Password')}
              value={password}
              onChangeText={setPassword}
              placeholder={register ? tr('At least 12 characters') : tr('Your password')}
              secureTextEntry
              autoComplete={register ? 'new-password' : 'current-password'}
              onSubmitEditing={() => void submit()}
            />
          )}
          {!!error && (
            <View style={{ backgroundColor: color.errorBg, borderRadius: 16, padding: 14 }}>
              <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
                {tr(error)}
              </Text>
            </View>
          )}
          <Button
            title={
              recovery
                ? sent
                  ? tr('Set my new password')
                  : tr('Send a reset code')
                : register
                  ? tr('Create your kitchen')
                  : tr('Welcome back')
            }
            icon={ArrowRight}
            busy={busy}
            large
            onPress={() => void submit()}
          />
          {!register && !recovery && (
            <Button
              title={tr('Forgot your password?')}
              variant="ghost"
              onPress={() => {
                setRecovery(true);
                setError('');
              }}
            />
          )}
          <Button
            title={
              recovery
                ? tr('Back to sign in')
                : register
                  ? tr('Already at the table? Sign in')
                  : tr('New here? Create an account')
            }
            variant="ghost"
            onPress={() => {
              if (recovery) {
                setRecovery(false);
                setSent(false);
              } else setRegister(!register);
              setError('');
            }}
          />
          <Text style={[s.small, { textAlign: 'center', fontFamily: 'Manrope_500Medium' }]}>
            {tr('Your recipes and kitchen lists stay connected across your devices.')}
          </Text>
        </View>
      </Dialog>
    </>
  );
}
