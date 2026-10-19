import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { Check, ChevronRight, RotateCcw, Sparkles } from './icons';
import { api } from '../lib/api';
import { canSellHere, openBilling } from '../lib/billing';
import { useApp } from '../lib/store';
import { Billing, PricePlan } from '../lib/types';
import { color, radius, s } from '../lib/theme';
import { DangerButton } from './DangerButton';
import { SheetError, useSheetAction } from './SheetAction';
import { Button, Dialog, Pill, Press, Segmented } from './ui';

const planNames = { free: 'Free', plus: 'Plus', pro: 'Pro' } as const;

function allowances(p: PricePlan) {
  return [
    { label: 'Sous-chef messages', limit: p.assistant, key: 'assistant' },
    { label: 'Live voice minutes', limit: p.voiceMinutes, key: 'voice' },
    { label: 'AI photos', limit: p.images, key: 'images' },
    { label: 'AI step clips', limit: p.videos, key: 'videos' },
    { label: 'Natural-voice read-alouds', limit: p.narration, key: 'narration' },
    { label: 'Cooking questions', limit: p.cookQuestions ?? 0, key: 'cookQuestions' },
  ] as const;
}

// Plan status and usage show everywhere. Prices and checkout show only where store rules
// let the app sell on the web without a commission (lib/billing.ts). A member's own plan is
// cancelled, kept or refunded here on every platform: those sell nothing, and Savorly bills every
// plan itself, so no app store has it (docs/PRICING.md#cancelling-renewals-and-refunds).
export function PlanSettings() {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [sell, setSell] = useState(false);
  const [period, setPeriod] = useState<'monthly' | 'yearly'>('yearly');
  const [busy, setBusy] = useState('');
  // Cancelling and refunding each ask once more before they happen.
  const [confirm, setConfirm] = useState<'cancel' | 'refund' | null>(null);
  const change = useSheetAction();
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
      window.history.replaceState({}, '', '/?page=settings');
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
  const frees = billing.usageFreesAt ?? {};
  const freesAt = {
    assistant: frees.assistant,
    voice: frees.voiceSeconds,
    images: frees.images,
    videos: frees.videos,
    narration: frees.narration,
    cookQuestions: frees.cookQuestions,
  };
  const money = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n);
  const cents = (n: number, currency = 'usd') => {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).format(n / 100);
    } catch {
      return `${(n / 100).toFixed(2)} ${currency.toUpperCase()}`;
    }
  };
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
  // Within the next 30 days, so the year goes without saying.
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const go = async (path: string, body?: object) => {
    setBusy(path);
    await app.act(async () => {
      const { url } = await api<{ url: string }>(path, { method: 'POST', body: body || {} });
      await openBilling(url);
    });
    setBusy('');
  };
  // The member's own subscription, which they cancel, keep and refund here.
  const own = !!billing.cancelable;
  const name = tr(planNames[billing.plan]);
  const gift = billing.plan !== 'free' && !billing.interval && !billing.sharedBy;
  const refund = own ? billing.refund : null;
  const refundAmount =
    refund?.amountCents != null ? cents(refund.amountCents, refund.currency) : '';
  const others = billing.sharedWith ?? 0;
  // Under the plan's name, one line says when it renews and for how much, or when it ends.
  const status =
    own && billing.renewsAt && billing.status !== 'past_due'
      ? billing.cancels
        ? tr('Ends {{date}} and won’t renew, so nothing more is charged.', {
            date: date(billing.renewsAt),
          })
        : billing.interval === 'yearly'
          ? tr('Renews {{date}} at {{price}} a year. We’ll remind you a week before.', {
              date: date(billing.renewsAt),
              price: money(current.yearlyUSD),
            })
          : tr('Renews {{date}} at {{price}} a month.', {
              date: date(billing.renewsAt),
              price: money(current.monthlyUSD),
            })
      : gift
        ? tr('Savorly gave you this plan, so there’s nothing to pay.')
        : '';
  const refundLine = !refund
    ? ''
    : refundAmount
      ? tr('Changed your mind? Get the full {{amount}} back until {{date}}.', {
          amount: refundAmount,
          date: date(refund.until),
        })
      : tr('Changed your mind? Get this year’s payment back in full until {{date}}.', {
          date: date(refund.until),
        });
  const keep = async () => {
    setBusy('/billing/resume');
    await app.act(
      async () => setBilling(await api<Billing>('/billing/resume', { method: 'POST', body: {} })),
      'Your plan will renew as before.',
    );
    setBusy('');
  };
  const cancel = () =>
    void change.run(async () => {
      setBilling(await api<Billing>('/billing/cancel', { method: 'POST', body: {} }));
      setConfirm(null);
      notify('Your plan won’t renew.');
    });
  const refundNow = () =>
    void change.run(async () => {
      setBilling(await api<Billing>('/billing/refund', { method: 'POST', body: {} }));
      setConfirm(null);
      notify('Refunded. You’re on Free now.');
      await refreshUser().catch(() => {});
    });
  const ask = (next: 'cancel' | 'refund') => {
    change.setError('');
    setConfirm(next);
  };
  return (
    <View style={[s.card, { gap: 14 }]}>
      <View style={[s.between, { gap: 10 }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.small}>{tr('Your plan')}</Text>
          <Text style={s.h2}>{name}</Text>
          {!!status && <Text style={s.small}>{status}</Text>}
        </View>
        {billing.plan !== 'free' &&
          !billing.sharedBy &&
          (!own || billing.status === 'past_due') && (
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
          .map((a) => {
            const back = used[a.key] >= a.limit ? freesAt[a.key] : null;
            return (
              <View key={a.key} style={{ gap: 4 }}>
                <View style={[s.between, { gap: 10 }]}>
                  <Text style={s.body}>{tr(a.label)}</Text>
                  <Text style={s.small}>
                    {back
                      ? tr('Used up · more from {{date}}', { date: day(back) })
                      : tr('{{v0}} of {{v1}} used', {
                          v0: Math.min(used[a.key], a.limit),
                          v1: a.limit,
                        })}
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
            );
          })}
        <Text style={s.small}>
          {billing.sharedBy
            ? tr(
                '{{v0}} shares this plan with your household. Allowances are for everyone on it and cover the last 30 days.',
                { v0: billing.sharedBy.name },
              )
            : billing.sharedWith
              ? tr('sharedPlanCount', { count: billing.sharedWith })
              : tr('Allowances cover the last 30 days.')}
        </Text>
      </View>
      {refund && (
        // One quiet line that opens the refund's sheet.
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Get a refund')}
          accessibilityHint={refundLine}
          onPress={() => ask('refund')}
          style={[s.row, { gap: 8 }]}
        >
          <Text style={[s.small, { flex: 1, color: color.ink }]}>{refundLine}</Text>
          <ChevronRight size={16} color={color.soft} />
        </Press>
      )}
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
      {(own || (sell && billing.manage)) && (
        <View style={[s.wrap, { gap: 10 }]}>
          {own &&
            (billing.cancels ? (
              <Button
                title={tr('Keep my plan')}
                icon={RotateCcw}
                small
                busy={busy === '/billing/resume'}
                onPress={() => void keep()}
                style={{ flexGrow: 1 }}
              />
            ) : (
              <Button
                title={tr('Cancel plan')}
                variant="secondary"
                small
                onPress={() => ask('cancel')}
                style={{ flexGrow: 1 }}
              />
            ))}
          {sell && billing.manage && (
            <Button
              title={tr('Manage plan')}
              variant="secondary"
              small
              busy={busy === '/billing/portal'}
              onPress={() => void go('/billing/portal')}
              style={{ flexGrow: 1 }}
            />
          )}
        </View>
      )}
      <Dialog
        visible={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        title={tr('Cancel your plan?')}
      >
        <Text style={s.body}>
          {billing.renewsAt
            ? tr(
                'You keep {{plan}} until {{date}}, and it won’t renew, so nothing more is charged. Then you’re on Free, and your recipes, cookbooks, plans and lists all stay.',
                { plan: name, date: date(billing.renewsAt) },
              )
            : tr(
                'You keep {{plan}} to the end of the time you paid for, and it won’t renew, so nothing more is charged. Then you’re on Free, and your recipes, cookbooks, plans and lists all stay.',
                { plan: name },
              )}
        </Text>
        {others > 0 && <Text style={s.body}>{tr('cancelSharedPlan', { count: others })}</Text>}
        {Platform.OS !== 'web' && (
          <Text style={s.small}>
            {Platform.OS === 'ios'
              ? tr('Savorly bills this plan itself, not the App Store, so you manage it here.')
              : tr('Savorly bills this plan itself, not Google Play, so you manage it here.')}
          </Text>
        )}
        <SheetError message={change.error} />
        <DangerButton title={tr('Cancel plan')} busy={change.busy} onPress={cancel} />
        <Button title={tr('Keep my plan')} variant="ghost" onPress={() => setConfirm(null)} />
      </Dialog>
      <Dialog
        visible={confirm === 'refund'}
        onClose={() => setConfirm(null)}
        title={
          refundAmount ? tr('Refund {{amount}}?', { amount: refundAmount }) : tr('Get a refund?')
        }
      >
        <Text style={s.body}>
          {refundAmount
            ? tr(
                'You get {{amount}} back the way you paid; banks usually show it within 5 to 10 days. Your {{plan}} plan ends now and you’re on Free straight away, and your recipes, cookbooks, plans and lists all stay.',
                { amount: refundAmount, plan: name },
              )
            : tr(
                'You get this year’s payment back the way you paid; banks usually show it within 5 to 10 days. Your {{plan}} plan ends now and you’re on Free straight away, and your recipes, cookbooks, plans and lists all stay.',
                { plan: name },
              )}
        </Text>
        {others > 0 && <Text style={s.body}>{tr('refundSharedPlan', { count: others })}</Text>}
        <SheetError message={change.error} />
        <DangerButton title={tr('Refund and end my plan')} busy={change.busy} onPress={refundNow} />
        <Button title={tr('Keep my plan')} variant="ghost" onPress={() => setConfirm(null)} />
      </Dialog>
    </View>
  );
}
