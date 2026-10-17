import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { Check, Sparkles } from './icons';
import { api } from '../lib/api';
import { canSellHere, openBilling } from '../lib/billing';
import { useApp } from '../lib/store';
import { Billing, PricePlan } from '../lib/types';
import { color, radius, s } from '../lib/theme';
import { Button, Pill, Segmented } from './ui';

const planNames = { free: 'Free', plus: 'Plus', pro: 'Pro' } as const;

function allowances(p: PricePlan) {
  return [
    { label: 'Sous-chef messages', limit: p.assistant, key: 'assistant' },
    { label: 'Live voice minutes', limit: p.voiceMinutes, key: 'voice' },
    { label: 'AI photos', limit: p.images, key: 'images' },
    { label: 'AI videos', limit: p.videos, key: 'videos' },
    { label: 'Natural-voice read-alouds', limit: p.narration, key: 'narration' },
    { label: 'Cooking questions', limit: p.cookQuestions ?? 0, key: 'cookQuestions' },
  ] as const;
}

// Plan status and usage show everywhere. Prices and checkout show only where store rules
// let the app sell on the web without a commission (lib/billing.ts).
export function PlanSettings() {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [sell, setSell] = useState(false);
  const [period, setPeriod] = useState<'monthly' | 'yearly'>('yearly');
  const [busy, setBusy] = useState('');
  const { refreshUser, notify } = app;
  const load = useCallback(
    () =>
      api<Billing>('/billing')
        // An older API has no plans; show nothing rather than a broken card.
        .then((b) => setBilling(Array.isArray(b?.plans) ? b : null))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void load();
    void canSellHere().then(setSell);
    // Checkout happens in the browser; pick up the result when the app comes back.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void Promise.all([load(), refreshUser().catch(() => {})]);
    });
    if (Platform.OS === 'web' && new URLSearchParams(window.location.search).get('plan')) {
      notify('Welcome to your new plan. Thank you for supporting Savorly!');
      window.history.replaceState({}, '', '/?page=profile');
    }
    return () => sub.remove();
  }, [load, refreshUser, notify]);
  if (!billing) return null;
  const current = billing.plans.find((p) => p.id === billing.plan) || billing.plans[0];
  const used = {
    assistant: billing.usage.assistant,
    voice: Math.ceil(billing.usage.voiceSeconds / 60),
    images: billing.usage.images,
    videos: billing.usage.videos,
    narration: billing.usage.narration,
    cookQuestions: billing.usage.cookQuestions ?? 0,
  };
  const money = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n);
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
  const go = async (path: string, body?: object) => {
    setBusy(path);
    await app.act(async () => {
      const { url } = await api<{ url: string }>(path, { method: 'POST', body: body || {} });
      await openBilling(url);
    });
    setBusy('');
  };
  return (
    <View style={[s.card, { gap: 14 }]}>
      <View style={[s.between, { gap: 10 }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.small}>{tr('Your plan')}</Text>
          <Text style={s.h2}>{tr(planNames[billing.plan])}</Text>
        </View>
        {billing.plan !== 'free' && (
          <Pill
            title={
              billing.status === 'past_due'
                ? tr('Payment needs attention')
                : billing.renewsAt
                  ? billing.cancels
                    ? tr('Ends {{v0}}', { v0: date(billing.renewsAt) })
                    : tr('Renews {{v0}}', { v0: date(billing.renewsAt) })
                  : tr('Active')
            }
            icon={Check}
          />
        )}
      </View>
      <View style={{ gap: 8 }}>
        {allowances(current)
          .filter((a) => a.limit > 0)
          .map((a) => (
            <View key={a.key} style={{ gap: 4 }}>
              <View style={s.between}>
                <Text style={s.body}>{tr(a.label)}</Text>
                <Text style={s.small}>
                  {tr('{{v0}} of {{v1}}', { v0: Math.min(used[a.key], a.limit), v1: a.limit })}
                </Text>
              </View>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: color.subtle }}>
                <View
                  style={{
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: color.ink,
                    width: `${Math.min(100, (100 * used[a.key]) / a.limit)}%`,
                  }}
                />
              </View>
            </View>
          ))}
        <Text style={s.small}>{tr('Allowances cover the last 30 days.')}</Text>
      </View>
      {sell && billing.checkout && billing.plan === 'free' && (
        <View style={{ gap: 12 }}>
          <Segmented
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'monthly', label: tr('Monthly') },
              { value: 'yearly', label: tr('Yearly') },
            ]}
          />
          {billing.plans
            .filter((p) => p.id !== 'free')
            .map((p) => {
              const price = period === 'yearly' ? p.yearlyUSD : p.monthlyUSD;
              const saving = Math.round(100 * (1 - p.yearlyUSD / (12 * p.monthlyUSD)));
              return (
                <View
                  key={p.id}
                  style={{
                    gap: 10,
                    padding: 16,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: color.border,
                  }}
                >
                  <View style={s.between}>
                    <Text style={s.h3}>{tr(planNames[p.id])}</Text>
                    <Text style={s.h3}>
                      {period === 'yearly'
                        ? tr('{{v0}} a year', { v0: money(price) })
                        : tr('{{v0}} a month', { v0: money(price) })}
                    </Text>
                  </View>
                  {period === 'yearly' && (
                    <Text style={s.small}>
                      {tr('{{v0}} a month, billed yearly · save {{v1}}%', {
                        v0: money(p.yearlyUSD / 12),
                        v1: saving,
                      })}
                    </Text>
                  )}
                  {allowances(p)
                    .filter((a) => a.limit > 0)
                    .map((a) => (
                      <View key={a.key} style={s.between}>
                        <Text style={s.muted}>{tr(a.label)}</Text>
                        <Text style={s.body}>{a.limit}</Text>
                      </View>
                    ))}
                  <Button
                    title={tr('Choose {{v0}}', { v0: tr(planNames[p.id]) })}
                    icon={Sparkles}
                    small
                    busy={busy === '/billing/checkout'}
                    onPress={() => void go('/billing/checkout', { plan: p.id, interval: period })}
                  />
                </View>
              );
            })}
          <Text style={s.small}>
            {tr('Secure checkout by Stripe opens in your browser. Cancel anytime.')}
          </Text>
        </View>
      )}
      {sell && billing.manage && (
        <Button
          title={tr('Manage plan')}
          variant="secondary"
          small
          busy={busy === '/billing/portal'}
          onPress={() => void go('/billing/portal')}
        />
      )}
    </View>
  );
}
