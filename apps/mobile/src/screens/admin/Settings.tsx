import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Hand, RotateCcw, Save } from 'lucide-react-native';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../lib/store';
import { replayWelcome } from '../../lib/welcome';
import { AdminSettings, AuditEntry, SettingsReply } from '../../lib/admin';
import { color, s } from '../../lib/theme';
import { Button, Field, Segmented } from '../../components/ui';
import { AnnouncementCard } from '../../components/Announcement';
import {
  Filters,
  ListState,
  Loading,
  Notice,
  Panel,
  Row,
  Search,
  Toggle,
  useFormat,
  useLoad,
  useNav,
  usePaged,
  useRun,
  useSearch,
} from './parts';

const announcementLimit = 280;
// Budgets are typed as text so an empty field can mean "use the server's default".
const budgetText = (v: number | null) => (v === null ? '' : String(v));
const parseBudget = (text: string): number | null | undefined => {
  if (!text.trim()) return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function Settings() {
  const f = useFormat();
  const { data, error } = useLoad<SettingsReply>('/admin/settings');
  const action = useRun();
  const [form, setForm] = useState<AdminSettings | null>(null);
  const [daily, setDaily] = useState('');
  const [free, setFree] = useState('');
  // The form starts again from what the server saved each time it loads.
  const [source, setSource] = useState<SettingsReply | null>(null);
  if (data && data !== source) {
    setSource(data);
    setForm(data.settings);
    setDaily(budgetText(data.settings.aiDailyBudgetUSD));
    setFree(budgetText(data.settings.aiFreeDailyBudgetUSD));
  }
  if (!data || !form) return <Loading error={error} />;
  const set = (patch: Partial<AdminSettings>) => setForm({ ...form, ...patch });
  const next: AdminSettings = {
    ...form,
    aiDailyBudgetUSD: parseBudget(daily) ?? null,
    aiFreeDailyBudgetUSD: parseBudget(free) ?? null,
  };
  const invalid = parseBudget(daily) === undefined || parseBudget(free) === undefined;
  const dirty = JSON.stringify(next) !== JSON.stringify(data.settings);
  return (
    <View style={{ gap: 16 }}>
      {action.result && (
        <Notice tone={action.result.ok ? 'success' : 'error'} text={action.result.text} />
      )}
      <Panel title="AI" subtitle="Takes effect on the next request, without a redeploy.">
        <Toggle
          label="Pause all AI features"
          text="The emergency stop. Every sous-chef message, photo, video, voice call and read-aloud is refused with a maintenance message until you turn it back on. Conversations and drafts are kept."
          value={form.aiPaused}
          onChange={(aiPaused) => set({ aiPaused })}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <View style={{ flexGrow: 1, flexBasis: 240 }}>
            <Field
              label="Daily AI budget for everyone (USD)"
              value={daily}
              onChangeText={setDaily}
              keyboardType="decimal-pad"
              placeholder={`Default: ${f.money(data.defaults.aiDailyBudgetUSD)}`}
            />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 240 }}>
            <Field
              label="Daily AI budget for free members (USD)"
              value={free}
              onChangeText={setFree}
              keyboardType="decimal-pad"
              placeholder={`Default: ${f.money(data.defaults.aiFreeDailyBudgetUSD)}`}
            />
          </View>
        </View>
        <Text style={s.small}>
          Leave a budget empty to use the server’s default (AI_DAILY_BUDGET_USD and
          AI_FREE_DAILY_BUDGET_USD). Paying members’ plans add headroom on top; 0 stops all AI
          spend.
        </Text>
        {invalid && (
          <Notice tone="error" text="Budgets are amounts in dollars, such as 10 or 7.50." />
        )}
      </Panel>
      <Panel title="Sign-ups">
        <Toggle
          label="Pause new sign-ups"
          text="New accounts, by email or with Apple or Google, are refused. Members already signed up can still sign in. Use it during a spam wave."
          value={form.signupsPaused}
          onChange={(signupsPaused) => set({ signupsPaused })}
        />
      </Panel>
      <Panel
        title="Announcement"
        subtitle="Shown at the top of the app to everyone, signed in or not, until they dismiss it."
      >
        <Field
          label={`Message (${form.announcement.length}/${announcementLimit})`}
          value={form.announcement}
          onChangeText={(announcement) => set({ announcement })}
          multiline
          maxLength={announcementLimit}
          placeholder="Savorly will be down for maintenance tonight from 22:00 to 22:30 UTC."
        />
        <Segmented
          value={form.announcementTone}
          onChange={(announcementTone) => set({ announcementTone })}
          options={[
            { value: 'info', label: 'Info' },
            { value: 'warning', label: 'Warning' },
          ]}
        />
        {!!form.announcement.trim() && (
          <View style={{ gap: 6 }}>
            <Text style={s.small}>Preview</Text>
            <AnnouncementCard
              announcement={{ text: form.announcement.trim(), tone: form.announcementTone }}
            />
          </View>
        )}
        <Text style={s.small}>
          Announcements aren’t translated: members see exactly what you write. Changing the text
          shows it again to people who dismissed the old one.
        </Text>
      </Panel>
      <View style={[s.between, { gap: 12, flexWrap: 'wrap' }]}>
        <Text style={[s.small, { flex: 1 }]}>
          {data.updatedAt
            ? `Last changed ${f.dateTime(data.updatedAt)} by ${data.updatedBy || 'a removed admin'}.`
            : 'Nothing has been changed here yet.'}
        </Text>
        <Button
          title="Save settings"
          icon={Save}
          disabled={!dirty || invalid}
          busy={!!action.busy}
          onPress={() =>
            void action.run(
              'save',
              () => api('/admin/settings', { method: 'PUT', body: next }),
              'Settings saved. They apply from the next request.',
            )
          }
        />
      </View>
      <OnboardingTests />
    </View>
  );
}

// Walks an admin through what a new member sees, without a new account or device.
function OnboardingTests() {
  const app = useApp();
  const nav = useNav();
  const action = useRun();
  return (
    <Panel
      title="Test onboarding"
      subtitle="Only for you, on this device. Nothing changes for anyone else."
    >
      {action.result && !action.result.ok && <Notice tone="error" text={action.result.text} />}
      <View style={{ gap: 8 }}>
        <Button
          title="Replay my kitchen setup"
          icon={RotateCcw}
          variant="secondary"
          small
          busy={action.busy === 'setup'}
          style={{ alignSelf: 'flex-start' }}
          onPress={() =>
            void action.run(
              'setup',
              async () => {
                try {
                  await api(`/admin/users/${encodeURIComponent(nav.me.id)}/setup`, {
                    method: 'POST',
                  });
                } catch (e) {
                  // Already waiting: just show it.
                  if (!(e instanceof ApiError && e.status === 409)) throw e;
                }
                await app.refreshUser();
              },
              '',
            )
          }
        />
        <Text style={s.small}>
          Opens the new-kitchen setup now: photo, name and username, food preferences, cooks to
          follow, meeting the sous-chef. Your profile stays as it is, and the restart is recorded in
          the audit log.
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <Button
          title="Replay the welcome"
          icon={Hand}
          variant="secondary"
          small
          busy={action.busy === 'welcome'}
          style={{ alignSelf: 'flex-start' }}
          onPress={() =>
            void action.run(
              'welcome',
              async () => {
                // Signed out first: while signed in, the welcome counts as already seen.
                await app.signOut();
                replayWelcome();
              },
              '',
            )
          }
        />
        <Text style={s.small}>
          Signs you out here and shows the first-launch welcome a new phone sees: language, then
          join, sign in or look around. Sign back in from it when you’re done.
        </Text>
      </View>
    </Panel>
  );
}

const types = [
  { value: '', label: 'Everything' },
  { value: 'user', label: 'Members' },
  { value: 'recipe', label: 'Recipes' },
  { value: 'review', label: 'Reviews' },
  { value: 'job', label: 'Jobs' },
  { value: 'voice', label: 'Voice' },
  { value: 'settings', label: 'Settings' },
] as const;

export function Audit() {
  const nav = useNav();
  const f = useFormat();
  const search = useSearch();
  const [type, setType] = useState<(typeof types)[number]['value']>('');
  const list = usePaged<AuditEntry>(
    `/admin/audit?q=${encodeURIComponent(search.query)}&type=${type}`,
  );
  const open = (e: AuditEntry) => {
    if (e.action.endsWith('.delete')) return undefined;
    if (e.targetType === 'user') return () => nav.member(e.targetId);
    if (e.targetType === 'recipe') return () => nav.recipe(e.targetId);
    if (e.targetType === 'job') return () => nav.job(e.targetId);
    if (e.targetType === 'settings') return () => nav.go('settings');
    return undefined;
  };
  const note = (e: AuditEntry) => {
    const d = e.detail as { note?: string; reason?: string };
    return d.reason || d.note;
  };
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.muted}>
        Every change made in this console, newest first. Entries can’t be edited or removed.
      </Text>
      <Search
        value={search.text}
        onChange={search.setText}
        placeholder="Search summaries, admin email or an ID"
      />
      <Filters options={[...types]} value={type} onChange={setType} />
      <View style={{ gap: 8, opacity: list.loading && list.items.length ? 0.6 : 1 }}>
        {list.items.map((e) => (
          <Row
            key={e.id}
            title={e.summary || e.action}
            lines={[
              note(e) && `“${note(e)}”`,
              `${e.adminEmail} · ${f.dateTime(e.createdAt)} · ${e.action}`,
            ]}
            onPress={open(e)}
          />
        ))}
      </View>
      <ListState
        shown={list.items.length}
        total={list.total}
        loading={list.loading}
        error={list.error}
        empty="No admin actions yet."
        onMore={list.more}
      />
      <Text style={[s.small, { color: color.muted }]}>
        The log is kept when admins, members or recipes are deleted.
      </Text>
    </View>
  );
}
