import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { api } from '../lib/api';
import { openBilling } from '../lib/billing';
import { countryName, deviceRegion, Earnings, regionOf } from '../lib/creatorFund';
import { useApp } from '../lib/store';
import { color, font, s } from '../lib/theme';
import { Check, HandCoins } from './icons';
import { Button, Chip, Dialog, Pill } from './ui';

/**
 * My kitchen's "Creator earnings" for cooks with published recipes while the creator fund is on
 * (docs/CREATOR-FUND.md): this month's verified cooks of their recipes and what they've earned
 * so far, what's waiting and paid, past months, and payouts through Stripe Connect. Setting up
 * payouts opens Stripe in the browser. It's not a purchase, and nothing here is sold, so it shows
 * on every platform (docs/PRICING.md).
 */
export function CreatorEarnings() {
  const { t: tr, locale } = useI18n();
  const { notify, act } = useApp();
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [country, setCountry] = useState(() => deviceRegion() || regionOf(locale));
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set while Stripe is open in the browser, so coming back re-reads the payout account.
  const away = useRef(false);
  const load = useCallback(
    (refresh = false) =>
      api<Earnings>(`/me/earnings${refresh ? '?refresh=true' : ''}`)
        // An older API, or one with the fund off, shows nothing rather than a broken card.
        .then((e) => setEarnings(Array.isArray(e?.history) ? e : null))
        .catch(() => {}),
    [],
  );
  // Stripe's onboarding, or its dashboard once onboarding is done, in the browser.
  const onboard = useCallback(
    (body: object) =>
      act(async () => {
        const { url } = await api<{ url: string }>('/me/payouts/onboarding', {
          method: 'POST',
          body,
        });
        away.current = true;
        await openBilling(url);
      }),
    [act],
  );
  const setUp = async (body: object) => {
    setBusy(true);
    await onboard(body);
    setBusy(false);
  };
  useEffect(() => {
    // Stripe sends the web back here when onboarding ends (done) or its link expired (refresh).
    const back =
      Platform.OS === 'web' ? new URLSearchParams(window.location.search).get('payouts') : null;
    if (back) window.history.replaceState({}, '', '/?page=profile');
    if (back === 'refresh') void onboard({});
    void load(back === 'done');
    if (back === 'done') notify('Thanks. Payouts start once Stripe has checked your details.');
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !away.current) return;
      away.current = false;
      void load(true);
    });
    return () => sub.remove();
  }, [load, onboard, notify]);
  if (!earnings) return null;
  const money = (cents: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100);
  const month = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const payouts = earnings.payouts;
  const supported = earnings.countries.includes(country);
  return (
    <View style={[s.card, { gap: 14 }]}>
      <View style={[s.row, { gap: 12, alignItems: 'flex-start' }]}>
        <View style={styles.badge}>
          <HandCoins size={18} color={color.ink} strokeWidth={1.9} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text role="heading" aria-level={2} style={s.h3}>
            {tr('Creator earnings')}
          </Text>
          <Text style={s.muted}>
            {tr(
              'Each month, {{percent}}% of what members pay goes to the cooks whose recipes they actually cooked.',
              { percent: earnings.sharePercent },
            )}
          </Text>
        </View>
      </View>
      <View style={[s.row, { alignItems: 'stretch' }]}>
        {[
          {
            value: String(earnings.cooks),
            label: tr('verifiedCooksThisMonth', { count: earnings.cooks }),
          },
          { value: money(earnings.estimateCents), label: tr('Estimated this month') },
        ].map((x, i) => (
          <View key={i} style={[styles.figure, i > 0 && styles.divided]}>
            <Text style={[s.h1, { fontSize: 24 }]}>{x.value}</Text>
            <Text style={s.small}>{x.label}</Text>
          </View>
        ))}
      </View>
      <View style={{ gap: 6 }}>
        <View style={s.between}>
          <Text style={s.body}>{tr('Waiting to be paid')}</Text>
          <Text style={[s.body, { fontFamily: font.semibold }]}>
            {money(earnings.balanceCents)}
          </Text>
        </View>
        <View style={s.between}>
          <Text style={s.body}>{tr('Paid so far')}</Text>
          <Text style={[s.body, { fontFamily: font.semibold }]}>{money(earnings.paidCents)}</Text>
        </View>
        <Text style={s.small}>
          {tr('Each month is added up once it ends. Payouts go out once you have {{amount}}.', {
            amount: money(earnings.minimumCents),
          })}
        </Text>
        {!!earnings.firstPayoutAt && (
          <Text style={s.small}>
            {tr(
              'Your first payout can go out from {{date}}, once members’ payments have cleared.',
              {
                date: new Date(earnings.firstPayoutAt).toLocaleDateString(locale, {
                  dateStyle: 'long',
                }),
              },
            )}
          </Text>
        )}
      </View>
      {earnings.history.length > 0 && (
        <View style={{ gap: 2 }}>
          {earnings.history.map((h, i) => (
            <View key={h.month} style={[s.between, styles.line, i > 0 && styles.ruled]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.body}>{month(h.month)}</Text>
                <Text style={s.small}>{tr('paidCookCount', { count: h.cooks })}</Text>
              </View>
              <Text style={[s.body, { fontFamily: font.semibold }]}>{money(h.amountCents)}</Text>
              <Pill
                title={h.status === 'paid' ? tr('Paid') : tr('Pending')}
                icon={h.status === 'paid' ? Check : undefined}
                tone={h.status === 'paid' ? 'success' : 'light'}
              />
            </View>
          ))}
        </View>
      )}
      {payouts.held ? (
        <Text style={[s.body, { color: color.warning }]}>
          {tr('Your payouts are on hold. Contact Savorly support if you think this is a mistake.')}
        </Text>
      ) : payouts.enabled ? (
        <View style={[s.between, { gap: 10 }]}>
          <Pill title={tr('Payouts are on')} icon={Check} tone="success" />
          <Button
            title={tr('Manage payouts')}
            variant="secondary"
            small
            busy={busy}
            onPress={() => void setUp({})}
          />
        </View>
      ) : payouts.connected ? (
        <View style={{ gap: 10 }}>
          <Text style={s.muted}>{tr('Finish setting up payouts with Stripe to get paid.')}</Text>
          <Button
            title={tr('Finish setting up payouts')}
            busy={busy}
            onPress={() => void setUp({})}
          />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <View style={[s.between, { gap: 10 }]}>
            <Text style={[s.body, { flex: 1 }]}>
              {country
                ? tr('Payouts to {{country}}', { country: countryName(country, locale) })
                : tr('Where should payouts go?')}
            </Text>
            <Button
              title={country ? tr('Change') : tr('Choose your country')}
              variant="ghost"
              small
              onPress={() => setChoosing(true)}
            />
          </View>
          {!!country && !supported && (
            <Text style={[s.small, { color: color.warning }]}>
              {tr(
                "Stripe can't send payouts to your country yet, so payouts aren't available there.",
              )}
            </Text>
          )}
          <Button
            title={tr('Set up payouts')}
            icon={HandCoins}
            busy={busy}
            disabled={!supported}
            onPress={() => void setUp({ country })}
          />
          <Text style={s.small}>
            {tr('Stripe pays creators out. Setup opens in your browser.')}
          </Text>
        </View>
      )}
      <Dialog
        visible={choosing}
        onClose={() => setChoosing(false)}
        title={tr('Where should payouts go?')}
      >
        <Text style={s.muted}>
          {tr(
            'Choose the country of the bank account you’ll be paid in. It can’t be changed later.',
          )}
        </Text>
        <View style={[s.wrap, { gap: 8 }]}>
          {[...earnings.countries]
            .sort((a, b) => countryName(a, locale).localeCompare(countryName(b, locale), locale))
            .map((code) => (
              <Chip
                key={code}
                title={countryName(code, locale)}
                active={code === country}
                onPress={() => {
                  setCountry(code);
                  setChoosing(false);
                }}
              />
            ))}
        </View>
        <Text style={s.small}>
          {tr('Not listed? Stripe can’t send payouts there yet. Your earnings keep adding up.')}
        </Text>
      </Dialog>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  figure: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: 4 },
  divided: { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  line: { gap: 10, paddingVertical: 8 },
  ruled: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
});
