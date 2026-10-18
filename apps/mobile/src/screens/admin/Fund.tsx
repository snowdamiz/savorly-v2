// The creator fund in the admin console (docs/CREATOR-FUND.md): the monthly summary on the
// Overview, and a member's earnings and payouts in their record, with holding their payouts.
// English only, like the rest of the console.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '../../lib/api';
import { FundWeeks } from '../../lib/admin';
import { useI18n } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { s } from '../../lib/theme';
import { Button } from '../../components/ui';
import {
  AdminNav,
  Badge,
  Confirm,
  Facts,
  Grid,
  Nav,
  Notice,
  Panel,
  Row,
  SectionLabel,
  Stat,
  useFormat,
  useLoad,
  useNav,
  useRun,
} from './parts';

type FundMonth = {
  month: string;
  computedAt: string;
  sharePercent: number;
  poolCents: number;
  members: number;
  cooks: number;
  creators: number;
  paidCents: number;
};
type FundSummary = {
  enabled: boolean;
  sharePercent: number;
  minimumCents: number;
  current: {
    month: string;
    poolCents: number;
    members: number;
    cooks: number;
    creators: number;
    leaders: { id: string; name: string; email: string; estimateCents: number; cooks: number }[];
  };
  months: FundMonth[];
  unpaidCents: number;
  paidCents: number;
  payouts: { sending: number; failed7d: number; paid30dCents: number };
  accounts: { connected: number; enabled: number; held: number };
  /** Creators whose first payout is still waiting its 60 days. Missing from older APIs. */
  firstPayoutsWaiting?: number;
  /** This month's paid-cooks signals (fund_signals.go). Missing from older APIs. */
  flags?: {
    threshold: number;
    members: {
      id: string;
      name: string;
      email: string;
      cooks: number;
      cents: number;
      creator: { id: string; name: string; email: string };
    }[];
    /** Members whose verified cooks this month look tapped through. Missing from older APIs. */
    tapped?: { id: string; name: string; email: string; cooks: number }[];
    tappedThreshold?: number;
    creators: {
      id: string;
      name: string;
      email: string;
      estimateCents: number;
      flaggedCents: number;
      members: number;
    }[];
  };
};
type MemberEarnings = {
  month: string;
  account: {
    stripeAccountId: string | null;
    country: string;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    connectedAt: string;
    heldAt: string | null;
    heldReason: string;
    heldBy: string | null;
  } | null;
  cooks: number;
  cooked: number;
  estimateCents: number;
  balanceCents: number;
  paidCents: number;
  /** While their first payout is still waiting its 60 days, when it may go. */
  firstPayoutAt?: string | null;
  history: {
    month: string;
    amountCents: number;
    cooks: number;
    status: 'pending' | 'paid';
    paidAt: string | null;
  }[];
  payouts: {
    id: string;
    amountCents: number;
    status: 'sending' | 'paid' | 'failed';
    transferId: string;
    error: string;
    createdAt: string;
  }[];
};

function useMoney() {
  const f = useFormat();
  const { locale } = useI18n();
  return {
    ...f,
    cents: (n: number) => f.money(n / 100),
    month: (iso: string) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
  };
}

/** The Overview's fund panel, while CREATOR_FUND is on. */
export function CreatorFund() {
  const app = useApp();
  const nav = useNav();
  const f = useMoney();
  const { data, error } = useLoad<FundSummary>(
    app.capabilities?.creatorFund ? '/admin/fund' : null,
  );
  if (!app.capabilities?.creatorFund) return null;
  if (!data) return error ? <Notice tone="error" text={error} /> : null;
  const now = data.current;
  return (
    <Panel
      title="Creator fund"
      subtitle={`${data.sharePercent}% of each paying member's net revenue, split among the creators of the recipes they verified-cooked that month. Months close on the 1st (UTC); payouts go out from ${f.cents(data.minimumCents)}.`}
    >
      <Grid min={150}>
        <Stat
          label={`${f.month(now.month)} so far`}
          value={f.cents(now.poolCents)}
          note={`${f.number(now.members)} paying cooks · ${f.number(now.cooks)} cooks · ${f.number(now.creators)} creators`}
        />
        <Stat
          label="Waiting to be paid"
          value={f.cents(data.unpaidCents)}
          note={`${f.cents(data.paidCents)} paid in all${data.firstPayoutsWaiting ? ` · ${f.number(data.firstPayoutsWaiting)} first payout${data.firstPayoutsWaiting === 1 ? '' : 's'} waiting 60 days` : ''}`}
        />
        <Stat
          label="Payouts"
          value={f.cents(data.payouts.paid30dCents)}
          note={`paid in 30 days · ${data.payouts.sending} on their way · ${data.payouts.failed7d} failed this week`}
          tone={data.payouts.failed7d ? 'warning' : undefined}
        />
        <Stat
          label="Payout accounts"
          value={f.number(data.accounts.enabled)}
          note={`ready of ${f.number(data.accounts.connected)} connected · ${f.number(data.accounts.held)} held`}
        />
      </Grid>
      {now.leaders.length > 0 && (
        <>
          <SectionLabel>Leading creators this month</SectionLabel>
          {now.leaders.map((l) => (
            <Row
              key={l.id}
              title={l.name || l.email}
              lines={[`${l.email} · ${f.number(l.cooks)} paid cooks`]}
              right={<Text style={s.h3}>{f.cents(l.estimateCents)}</Text>}
              onPress={() => nav.member(l.id)}
            />
          ))}
        </>
      )}
      {data.flags && <PaidCooks flags={data.flags} />}
      <SectionLabel>Closed months</SectionLabel>
      {data.months.length === 0 ? (
        <Text style={s.muted}>No month has closed yet.</Text>
      ) : (
        <Facts
          rows={data.months.map((m) => [
            f.month(m.month),
            `${f.cents(m.poolCents)} to ${f.number(m.creators)} creators from ${f.number(m.members)} members' ${f.number(m.cooks)} cooks (${m.sharePercent}%) · ${f.cents(m.paidCents)} paid · closed ${f.dateTime(m.computedAt)}`,
          ])}
        />
      )}
      {!data.enabled && (
        <Notice tone="warning" text="CREATOR_FUND is off: nothing closes or pays out." />
      )}
    </Panel>
  );
}

/**
 * Paying members whose every verified cook this month went to one creator, and the creators most
 * of whose money comes from them: what a creator paying members to cook their recipes looks like.
 * Signals to look into, never holds.
 */
function PaidCooks({ flags }: { flags: NonNullable<FundSummary['flags']> }) {
  const nav = useNav();
  const f = useMoney();
  return (
    <>
      <SectionLabel>Paid-cooks signals</SectionLabel>
      <Text style={s.small}>
        {`Paying members whose ${flags.threshold} or more verified cooks this month all went to one creator. Plenty of members cook from one favourite; many of them on one creator is worth a look before holding their payouts.`}
      </Text>
      {flags.members.length === 0 ? (
        <Text style={s.muted}>Nobody this month.</Text>
      ) : (
        <>
          {flags.creators.map((c) => (
            <Row
              key={c.id}
              title={c.name || c.email}
              badges={<Badge title="Mostly from one-creator members" tone="warning" />}
              lines={[
                `${c.email} · ${f.cents(c.flaggedCents)} of ${f.cents(c.estimateCents)} this month from ${f.number(c.members)} such member${c.members === 1 ? '' : 's'}`,
              ]}
              onPress={() => nav.member(c.id)}
            />
          ))}
          {flags.members.map((m) => (
            <Row
              key={m.id}
              title={m.name || m.email}
              lines={[
                `${m.email} · ${f.number(m.cooks)} verified cooks, all of ${m.creator.name || m.creator.email}'s recipes · ${f.cents(m.cents)} to them`,
              ]}
              onPress={() => nav.member(m.id)}
            />
          ))}
        </>
      )}
      {!!flags.tapped?.length && (
        <>
          <Text style={s.small}>
            {`Members with ${flags.tappedThreshold ?? 2} or more verified cooks this month that lasted barely their minimum, every step taking the same time: what tapping through on a timer looks like.`}
          </Text>
          {flags.tapped.map((m) => (
            <Row
              key={m.id}
              title={m.name || m.email}
              badges={<Badge title="Tapped through" tone="warning" />}
              lines={[`${m.email} · ${f.number(m.cooks)} such cooks`]}
              onPress={() => nav.member(m.id)}
            />
          ))}
        </>
      )}
    </>
  );
}

/** The fund week by week (GET /admin/fund/weeks), while CREATOR_FUND is on. */
export function FundWeeksReport() {
  const app = useApp();
  const nav = useNav();
  const f = useMoney();
  const { data, error } = useLoad<FundWeeks>(
    app.capabilities?.creatorFund ? '/admin/fund/weeks' : null,
  );
  if (!app.capabilities?.creatorFund) return null;
  if (!data) return error ? <Notice tone="error" text={error} /> : null;
  return (
    <Panel
      title="Creator fund, week by week"
      subtitle={`Monday to Sunday (UTC). A paying member's ${data.sharePercent}% joins the month's pool with their first verified cook of the month, so a month's weeks add up to what it closes with.`}
    >
      {data.weeks.map((w) => (
        <Row
          key={w.week}
          title={`Week of ${f.day(w.week)}`}
          badges={
            <>
              {w.current && <Badge title="So far" />}
              {w.flaggedMembers > 0 && (
                <Badge
                  title={`${w.flaggedMembers} one-creator member${w.flaggedMembers === 1 ? '' : 's'}`}
                  tone="warning"
                />
              )}
            </>
          }
          lines={[
            `${f.cents(w.poolCents)} added to the pool · ${f.number(w.cooks)} verified cooks · ${f.number(w.payingMembers)} paying members cooked`,
            w.top.length > 0 &&
              `Most cooked by paying members: ${w.top.map((c) => `${c.name || c.email} (${f.number(c.cooks)})`).join(', ')}`,
            w.flaggedCreators.length > 0 &&
              `Mostly paid by one-creator members (${data.threshold}+ cooks): ${w.flaggedCreators.map((c) => c.name || c.email).join(', ')}`,
          ]}
          onPress={w.flaggedCreators.length ? () => nav.member(w.flaggedCreators[0].id) : undefined}
        />
      ))}
    </Panel>
  );
}

/** A member's side of the fund in their record, with holding and releasing their payouts. */
export function MemberFund({ nav, ...member }: MemberProps & { nav: AdminNav }) {
  // A record is drawn in the shared sheet, outside the console's navigation, so it comes along.
  return (
    <Nav.Provider value={nav}>
      <MemberFundRecord {...member} />
    </Nav.Provider>
  );
}

type MemberProps = { id: string; name: string; locked: boolean };
function MemberFundRecord({ id, name, locked }: MemberProps) {
  const app = useApp();
  const f = useMoney();
  const path = `/admin/users/${encodeURIComponent(id)}`;
  const { data } = useLoad<MemberEarnings>(
    app.capabilities?.creatorFund ? `${path}/earnings` : null,
  );
  const action = useRun();
  const [confirm, setConfirm] = useState<'hold' | 'release' | null>(null);
  if (!app.capabilities?.creatorFund || !data) return null;
  const a = data.account;
  const held = !!a?.heldAt;
  const hold = async (held: boolean, reason = '') => {
    const ok = await action.run(
      held ? 'hold' : 'release',
      () => api(`${path}/payouts-hold`, { method: 'PUT', body: { held, reason } }),
      held ? `${name}'s payouts are on hold.` : `${name}'s payouts are released.`,
    );
    if (ok) setConfirm(null);
  };
  return (
    <>
      <SectionLabel>Creator fund</SectionLabel>
      {held && a && (
        <Notice
          tone="warning"
          text={`Payouts held ${f.dateTime(a.heldAt!)} by ${a.heldBy || 'an admin'}: ${a.heldReason}. Earnings still add up; transfers wait.`}
        />
      )}
      <Facts
        rows={[
          [
            `${f.month(data.month)}`,
            `${f.number(data.cooks)} verified cooks of their recipes · ${f.cents(data.estimateCents)} so far · ${f.number(data.cooked)} cooks of others'`,
          ],
          ['Unpaid', f.cents(data.balanceCents)],
          ['Paid', f.cents(data.paidCents)],
          ...(data.firstPayoutAt
            ? [
                [
                  'First payout',
                  `Waits until ${f.dateTime(data.firstPayoutAt)}, 60 days after their first month closed`,
                ] as [string, string],
              ]
            : []),
          [
            'Payout account',
            !a?.stripeAccountId
              ? 'Not set up'
              : `${a.stripeAccountId} · ${a.country} · ${a.payoutsEnabled ? 'payouts on' : a.detailsSubmitted ? 'waiting for Stripe' : 'onboarding not finished'}`,
          ],
        ]}
      />
      {data.history.map((h) => (
        <Row
          key={h.month}
          title={`${f.month(h.month)}: ${f.cents(h.amountCents)}`}
          badges={<Badge title={h.status} tone={h.status === 'paid' ? 'success' : 'light'} />}
          lines={[
            `${f.number(h.cooks)} paid cooks${h.paidAt ? ` · paid ${f.date(h.paidAt)}` : ''}`,
          ]}
        />
      ))}
      {data.payouts.map((p) => (
        <Row
          key={p.id}
          title={`Payout of ${f.cents(p.amountCents)}`}
          badges={
            <Badge
              title={p.status}
              tone={p.status === 'paid' ? 'success' : p.status === 'failed' ? 'error' : 'light'}
            />
          }
          lines={[f.dateTime(p.createdAt), p.transferId, p.error]}
        />
      ))}
      {!locked && (
        <View style={{ alignItems: 'flex-start' }}>
          <Button
            title={held ? 'Release payouts' : 'Hold payouts'}
            variant="secondary"
            small
            onPress={() => setConfirm(held ? 'release' : 'hold')}
          />
        </View>
      )}
      <Confirm
        visible={confirm === 'hold'}
        title={`Hold ${name}'s payouts?`}
        text="Their earnings keep adding up, but no transfer goes out until the hold is released. They see that their payouts are on hold."
        action="Hold payouts"
        input={{ label: 'Why (only admins see it)', required: true }}
        busy={action.busy === 'hold'}
        result={action.result}
        onConfirm={(reason) => void hold(true, reason)}
        onClose={() => setConfirm(null)}
      />
      <Confirm
        visible={confirm === 'release'}
        title={`Release ${name}'s payouts?`}
        text="Their unpaid earnings go out with the next payout run once they reach the minimum."
        action="Release payouts"
        busy={action.busy === 'release'}
        result={action.result}
        onConfirm={() => void hold(false)}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
