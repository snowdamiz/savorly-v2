import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Check, Minus } from 'lucide-react-native';
import { Overview as Data } from '../../lib/admin';
import { color, s } from '../../lib/theme';
import { Segmented } from '../../components/ui';
import {
  Bars,
  Columns,
  Facts,
  Grid,
  Loading,
  Meter,
  Notice,
  Panel,
  Stat,
  useFormat,
  useLoad,
  useNav,
} from './parts';

const metrics = [
  { value: 'signups', label: 'Sign-ups', unit: 'sign-ups' },
  { value: 'recipes', label: 'Recipes', unit: 'recipes' },
  { value: 'spend', label: 'AI spend', unit: 'AI spend' },
  { value: 'jobs', label: 'AI jobs', unit: 'AI jobs' },
] as const;
type Metric = (typeof metrics)[number]['value'];

export function Overview() {
  const nav = useNav();
  const f = useFormat();
  const { data, error } = useLoad<Data>('/admin/overview');
  const [metric, setMetric] = useState<Metric>('signups');
  if (!data) return <Loading error={error} />;
  const { stats, budget, system, settings } = data;
  const m = stats.members;
  const alerts: React.ReactNode[] = [];
  if (budget.paused)
    alerts.push(
      <Notice
        key="paused"
        tone="warning"
        text="All AI features are paused. Members see a maintenance message."
        action="Settings"
        onPress={() => nav.go('settings')}
      />,
    );
  if (settings.signupsPaused)
    alerts.push(
      <Notice
        key="signups"
        tone="warning"
        text="New sign-ups are paused."
        action="Settings"
        onPress={() => nav.go('settings')}
      />,
    );
  if (stats.reports.open)
    alerts.push(
      <Notice
        key="reports"
        tone="warning"
        text={`${stats.reports.recipes} reported recipe${stats.reports.recipes === 1 ? '' : 's'} waiting for review (${stats.reports.open} report${stats.reports.open === 1 ? '' : 's'}).`}
        action="Review"
        onPress={() => nav.go('reports')}
      />,
    );
  if (budget.daily > 0 && stats.spend.last24h >= budget.daily * 0.8)
    alerts.push(
      <Notice
        key="budget"
        tone={stats.spend.last24h >= budget.daily ? 'error' : 'warning'}
        text={`AI spend in the last 24 hours is ${f.money(stats.spend.last24h)} of the ${f.money(budget.daily)} daily budget.`}
        action="Budgets"
        onPress={() => nav.go('settings')}
      />,
    );
  if (stats.jobs.oldestQueuedSeconds > 300)
    alerts.push(
      <Notice
        key="queue"
        tone="warning"
        text={`An AI job has waited ${Math.round(stats.jobs.oldestQueuedSeconds / 60)} minutes in the queue. Check that the API's worker is running.`}
        action="Jobs"
        onPress={() => nav.go('ai')}
      />,
    );
  if (stats.jobs.failed24h + stats.assistant.failed24h > 0)
    alerts.push(
      <Notice
        key="failed"
        tone="info"
        text={`${stats.jobs.failed24h} AI job${stats.jobs.failed24h === 1 ? '' : 's'} and ${stats.assistant.failed24h} sous-chef turn${stats.assistant.failed24h === 1 ? '' : 's'} failed in the last 24 hours.`}
        action="Jobs"
        onPress={() => nav.go('ai')}
      />,
    );
  const chosen = metrics.find((x) => x.value === metric)!;
  const plans = stats.plans;
  const on = (v: boolean) =>
    v ? (
      <View style={[s.row, { gap: 6 }]}>
        <Check size={15} color={color.success} strokeWidth={2.4} />
        <Text style={[s.body, { fontSize: 14 }]}>Configured</Text>
      </View>
    ) : (
      <View style={[s.row, { gap: 6 }]}>
        <Minus size={15} color={color.soft} strokeWidth={2.4} />
        <Text style={[s.muted, { fontSize: 14 }]}>Not configured</Text>
      </View>
    );
  return (
    <View style={{ gap: 16 }}>
      {alerts.length > 0 && <View style={{ gap: 8 }}>{alerts}</View>}
      <Grid min={150}>
        <Stat
          label="Members"
          value={f.number(m.total)}
          note={`+${f.number(m.new7d)} this week · +${f.number(m.new24h)} today`}
          onPress={() => nav.go('members')}
        />
        <Stat
          label="Signed in this week"
          value={f.number(m.active7d)}
          note={`${f.number(m.new30d)} joined in 30 days`}
        />
        <Stat
          label="Published recipes"
          value={f.number(stats.recipes.published)}
          note={`+${f.number(stats.recipes.new7d)} this week · ${f.number(stats.recipes.drafts)} drafts`}
          onPress={() => nav.go('recipes')}
        />
        <Stat
          label="Open reports"
          value={f.number(stats.reports.open)}
          note={
            stats.reports.open
              ? `On ${stats.reports.recipes} recipe${stats.reports.recipes === 1 ? '' : 's'}`
              : 'Queue is clear'
          }
          tone={stats.reports.open ? 'warning' : undefined}
          onPress={() => nav.go('reports')}
        />
        <Stat
          label="AI spend, 24 hours"
          value={f.money(stats.spend.last24h)}
          note={`${f.money(stats.spend.last7d)} in 7 days · ${f.money(stats.spend.last30d)} in 30`}
          onPress={() => nav.go('ai')}
        />
        <Stat
          label="AI queue"
          value={f.number(
            stats.jobs.queued +
              stats.jobs.running +
              stats.jobs.processing +
              stats.assistant.queued +
              stats.assistant.running,
          )}
          note={`${stats.jobs.completed24h} done · ${stats.jobs.failed24h} failed today · ${stats.voiceLive} live voice`}
          onPress={() => nav.go('ai')}
        />
      </Grid>
      <Grid min={320}>
        <Panel
          title="AI budget, last 24 hours"
          subtitle={
            budget.paused
              ? 'Paused from Settings: every AI request is refused.'
              : 'Requests are refused once a budget is reached. Paying members add headroom.'
          }
        >
          <Meter
            label="Everyone"
            used={stats.spend.last24h}
            limit={budget.daily}
            display={`${f.money(stats.spend.last24h)} of ${f.money(budget.daily)}`}
          />
          <Meter
            label="Free members"
            used={stats.spend.free24h}
            limit={budget.freeDaily}
            display={`${f.money(stats.spend.free24h)} of ${f.money(budget.freeDaily)}`}
          />
          <Text style={s.small}>
            {`Base budgets ${f.money(budget.baseDaily)} and ${f.money(budget.baseFreeDaily)} for free members, plus ${f.money(budget.memberPaidShare + budget.memberFreeShare)} from paying members' plans.`}
          </Text>
        </Panel>
        <Panel
          title="AI spend by source, 30 days"
          subtitle="Reserved cost; provider invoices are authoritative."
        >
          <Bars
            format={f.money}
            rows={[
              { label: 'Sous-chef conversations', value: stats.spendBySource.assistant },
              { label: 'Photos and videos', value: stats.spendBySource.media },
              { label: 'One-shot tools (recipes, swaps, plans)', value: stats.spendBySource.tools },
              { label: 'Live voice', value: stats.spendBySource.voice },
              { label: 'Read-aloud narration', value: stats.spendBySource.narration },
            ]}
          />
        </Panel>
      </Grid>
      <Panel title="Last 30 days" subtitle="Days are in UTC.">
        <Segmented
          value={metric}
          onChange={setMetric}
          options={metrics.map((x) => ({ value: x.value, label: x.label }))}
        />
        <Columns
          unit={chosen.unit === 'AI spend' ? '' : chosen.unit}
          format={metric === 'spend' ? f.money : f.number}
          points={data.series.map((d) => ({ label: f.day(d.day), value: d[metric] }))}
        />
      </Panel>
      <Grid min={320}>
        <Panel title="Members">
          <Facts
            rows={[
              [
                'Plans',
                `${f.number(plans.free ?? 0)} Free · ${f.number(plans.plus ?? 0)} Plus · ${f.number(plans.pro ?? 0)} Pro`,
              ],
              ['Complimentary', `${f.number(stats.comped)} on a plan granted here`],
              ['Verified email', `${f.number(m.verified)} of ${f.number(m.total)}`],
              [
                'Sign-in',
                `${f.number(m.withPassword)} password · ${f.number(stats.identities.google ?? 0)} Google · ${f.number(stats.identities.apple ?? 0)} Apple`,
              ],
              ['Admins', f.number(m.admins)],
              ['Suspended', f.number(m.suspended)],
              ['Sample cooks', `${f.number(stats.samples)} from SEED_DATA, not counted above`],
            ]}
          />
        </Panel>
        <Panel title="Community">
          <Facts
            rows={[
              [
                'Reviews',
                `${f.number(stats.community.reviews)} (+${f.number(stats.community.reviews7d)} this week)`,
              ],
              ['Saves', f.number(stats.community.saves)],
              ['Follows', f.number(stats.community.follows)],
              ['Cookbooks', f.number(stats.community.cookbooks)],
              ['Planned meals', f.number(stats.community.mealPlans)],
              ['AI recipes', `${f.number(stats.recipes.aiGenerated)} marked AI-generated`],
              [
                'Sous-chef chats',
                `${f.number(stats.conversations.total)} (${f.number(stats.conversations.active7d)} active this week)`,
              ],
            ]}
          />
        </Panel>
      </Grid>
      <Panel
        title="System"
        subtitle="Which integrations the API has keys for. Secrets are never shown."
      >
        <Grid min={300}>
          <Facts
            rows={[
              ['Environment', system.environment],
              [
                'Database',
                `${f.bytes(stats.databaseBytes)} · schema ${stats.migration.replace('.sql', '')}`,
              ],
              ['Owners', system.owners.join(', ') || 'None'],
              [
                'Owner rule',
                system.ownersMustVerify
                  ? 'Owners need a verified email'
                  : 'Development: no verification needed',
              ],
              ['Paid plans', system.paidPlans ? 'On (PAID_PLANS)' : 'Off: everyone is unlimited'],
              ['Stripe billing', on(system.billing)],
              ['Media storage', on(system.media)],
              ['Email', on(system.email)],
            ]}
          />
          <Facts
            rows={[
              ['OpenRouter', on(system.textAI)],
              ['Video (reAPI)', on(system.videoAI)],
              ['Live voice', on(system.voiceAI)],
              ['Narration', on(system.narration)],
              ['Sign in with Google', on(system.googleSignIn)],
              ['Sign in with Apple', on(system.appleSignIn)],
              [
                'Models',
                Object.entries(system.models)
                  .filter(([, v]) => v)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n'),
              ],
            ]}
          />
        </Grid>
      </Panel>
    </View>
  );
}
