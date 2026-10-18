import React, { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { CircleStop, Mic, XCircle } from '../../components/icons';
import { api } from '../../lib/api';
import { AdminAI, AdminJob, AdminTurn } from '../../lib/admin';
import { AIKind } from '../../lib/types';
import { color, font, radius, s } from '../../lib/theme';
import { Avatar, Button, Dialog } from '../../components/ui';
import {
  Badge,
  Confirm,
  Facts,
  Filters,
  Grid,
  ListState,
  Loading,
  Notice,
  Panel,
  Row,
  Search,
  SectionLabel,
  Tone,
  useFormat,
  useLoad,
  useNav,
  usePaged,
  useRun,
  useSearch,
} from './parts';

const kindNames: Record<AIKind, string> = {
  recipe: 'Recipe draft',
  adapt: 'Adaptation',
  substitute: 'Substitution',
  nutrition: 'Nutrition',
  plan: 'Meal plan',
  assistant: 'Question',
  image: 'Photo',
  video: 'Video',
  clip: 'Step clip',
};
export const statusTone = (status: string): Tone =>
  status === 'failed'
    ? 'error'
    : status === 'completed'
      ? 'success'
      : status === 'queued'
        ? 'light'
        : 'warning';
const statuses = [
  { value: '', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed', label: 'Failed' },
  { value: 'completed', label: 'Completed' },
] as const;
const turnStatuses = [
  { value: '', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
  { value: 'completed', label: 'Completed' },
] as const;
const channels = [
  { value: '', label: 'Text and voice' },
  { value: 'text', label: 'Text' },
  { value: 'voice', label: 'Voice' },
] as const;
const seconds = (ms: number | null | undefined) =>
  ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
// What a turn did, as one line: how many model rounds, and the tools in the order it called them.
const turnSummary = (t: AdminTurn) =>
  [
    `${t.rounds} ${t.rounds === 1 ? 'round' : 'rounds'}`,
    t.tools.length ? t.tools.join(', ') : 'no tools',
    t.toolErrors ? `${t.toolErrors} tool ${t.toolErrors === 1 ? 'error' : 'errors'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
const kinds = [
  { value: '', label: 'Every tool' },
  ...Object.entries(kindNames).map(([value, label]) => ({ value, label })),
];

export function Operations() {
  const nav = useNav();
  const f = useFormat();
  const ai = useLoad<AdminAI>('/admin/ai');
  const search = useSearch();
  const [status, setStatus] = useState<(typeof statuses)[number]['value']>('');
  const [kind, setKind] = useState('');
  const jobs = usePaged<AdminJob>(
    `/admin/jobs?status=${status}&kind=${kind}&q=${encodeURIComponent(search.query)}`,
  );
  const turnSearch = useSearch();
  const [turnStatus, setTurnStatus] = useState<(typeof turnStatuses)[number]['value']>('');
  const [channel, setChannel] = useState<(typeof channels)[number]['value']>('');
  const turns = usePaged<AdminTurn>(
    `/admin/turns?status=${turnStatus}&channel=${channel}&q=${encodeURIComponent(turnSearch.query)}`,
  );
  const action = useRun();
  const [end, setEnd] = useState<AdminAI['voice'][number] | null>(null);
  const data = ai.data;
  return (
    <View style={{ gap: 16 }}>
      {!data ? (
        <Loading error={ai.error} />
      ) : (
        <>
          <Panel
            title="Live voice now"
            subtitle={`${data.voiceTotals.sessions} sessions and ${f.number(data.voiceTotals.minutes)} minutes in 30 days`}
          >
            {action.result && (
              <Notice tone={action.result.ok ? 'success' : 'error'} text={action.result.text} />
            )}
            {data.voice.length ? (
              data.voice.map((v) => (
                <Row
                  key={v.id}
                  leading={<Mic size={20} color={color.ink} />}
                  title={v.user.name}
                  badges={
                    <Badge
                      title={v.closeRequested ? 'Ending' : v.status}
                      tone={v.closeRequested ? 'light' : 'success'}
                    />
                  }
                  lines={[
                    v.user.email,
                    `Started ${f.ago(v.createdAt)} · ${Math.round(v.seconds / 60)} of ${Math.round(v.reservedSeconds / 60)} reserved minutes · heartbeat ${f.ago(v.heartbeatAt)}`,
                  ]}
                  onPress={() => nav.member(v.user.id)}
                  right={
                    !v.closeRequested && (
                      <Button
                        title="End"
                        icon={CircleStop}
                        small
                        variant="ghost"
                        label={`End ${v.user.name}’s voice session`}
                        onPress={() => setEnd(v)}
                      />
                    )
                  }
                />
              ))
            ) : (
              <Text style={s.muted}>No one is talking to the sous-chef right now.</Text>
            )}
          </Panel>
          <Grid min={320}>
            <Panel title="By tool, 30 days" subtitle="Jobs, failures and reserved spend.">
              <View style={{ gap: 0 }}>
                {[
                  ...data.kinds.map((k) => ({
                    label: kindNames[k.kind] || k.kind,
                    n: k.jobs,
                    failed: k.failed,
                    spend: k.spend,
                    unit: 'jobs',
                  })),
                  {
                    label: 'Sous-chef turns',
                    n: data.assistant.turns,
                    failed: data.assistant.failed,
                    spend: data.assistant.spend,
                    unit: 'turns',
                  },
                  {
                    label: 'Read-alouds',
                    n: data.narration.clips,
                    failed: 0,
                    spend: data.narration.spend,
                    unit: 'read-alouds',
                  },
                ].map((k, i) => (
                  <View
                    key={k.label}
                    style={{
                      gap: 2,
                      paddingVertical: 9,
                      borderTopWidth: i ? 1 : 0,
                      borderColor: color.subtle,
                    }}
                  >
                    <View style={[s.between, { gap: 10 }]}>
                      <Text style={[s.body, { flex: 1, fontSize: 14 }]}>{k.label}</Text>
                      <Text style={[s.h3, { fontSize: 14 }]}>{f.money(k.spend)}</Text>
                    </View>
                    <Text style={s.small}>
                      {`${f.number(k.n)} ${k.n === 1 ? k.unit.replace(/s$/, '') : k.unit}`}
                      {k.failed > 0 && (
                        <Text
                          style={{ color: color.error }}
                        >{` · ${f.number(k.failed)} failed`}</Text>
                      )}
                    </Text>
                  </View>
                ))}
              </View>
            </Panel>
            <Panel title="Top spenders, 30 days">
              {data.spenders.length ? (
                data.spenders.map((u) => (
                  <Row
                    key={u.id}
                    leading={<Avatar name={u.name} uri={u.avatar} size={36} />}
                    title={u.name}
                    lines={[u.email]}
                    onPress={() => nav.member(u.id)}
                    right={<Text style={[s.h3, { fontSize: 15 }]}>{f.money(u.spend)}</Text>}
                  />
                ))
              ) : (
                <Text style={s.muted}>No AI spend in the last 30 days.</Text>
              )}
            </Panel>
          </Grid>
        </>
      )}
      <View style={{ gap: 12 }}>
        <Text style={s.h2}>Sous-chef turns</Text>
        <Search
          value={turnSearch.text}
          onChange={turnSearch.setText}
          placeholder="Search member email, member ID or turn ID"
        />
        <Filters options={[...turnStatuses]} value={turnStatus} onChange={setTurnStatus} />
        <Filters options={[...channels]} value={channel} onChange={setChannel} />
        <View style={{ gap: 8, opacity: turns.loading && turns.items.length ? 0.6 : 1 }}>
          {turns.items.map((t) => (
            <Row
              key={t.id}
              title={`${t.channel === 'voice' ? 'Voice' : 'Chat'} turn · ${t.user.name}`}
              badges={<Badge title={t.status} tone={statusTone(t.status)} />}
              lines={[
                [t.user.email, f.dateTime(t.createdAt), seconds(t.ms), f.money(t.cost)]
                  .filter(Boolean)
                  .join(' · '),
                turnSummary(t),
              ]}
              onPress={() => nav.turn(t.id)}
            />
          ))}
        </View>
        <ListState
          shown={turns.items.length}
          total={turns.total}
          loading={turns.loading}
          error={turns.error}
          empty="No turns match."
          onMore={turns.more}
        />
      </View>
      <View style={{ gap: 12 }}>
        <Text style={s.h2}>AI jobs</Text>
        <Search
          value={search.text}
          onChange={search.setText}
          placeholder="Search member email, member ID or job ID"
        />
        <Filters options={[...statuses]} value={status} onChange={setStatus} />
        <Filters options={kinds} value={kind} onChange={setKind} />
        <View style={{ gap: 8, opacity: jobs.loading && jobs.items.length ? 0.6 : 1 }}>
          {jobs.items.map((j) => (
            <Row
              key={j.id}
              title={kindNames[j.kind] || j.kind}
              badges={<Badge title={j.status} tone={statusTone(j.status)} />}
              lines={[`${j.user.email} · ${f.dateTime(j.createdAt)} · ${f.money(j.cost)}`, j.error]}
              onPress={() => nav.job(j.id)}
            />
          ))}
        </View>
        <ListState
          shown={jobs.items.length}
          total={jobs.total}
          loading={jobs.loading}
          error={jobs.error}
          empty="No jobs match."
          onMore={jobs.more}
        />
        <Text style={s.small}>
          Sous-chef conversations run as turns, not jobs; their photos and videos appear here.
        </Text>
      </View>
      <Confirm
        visible={!!end}
        title="End this voice session?"
        text={
          end
            ? `${end.user.name}’s live conversation closes within a few seconds. The chat history is kept.`
            : ''
        }
        action="End session"
        danger
        busy={!!action.busy}
        result={action.result}
        onConfirm={() =>
          end &&
          void action
            .run(
              'end',
              () => api(`/admin/voice/${encodeURIComponent(end.id)}/end`, { method: 'POST' }),
              `Ending ${end.user.name}’s voice session.`,
            )
            .then((ok) => ok && setEnd(null))
        }
        onClose={() => setEnd(null)}
      />
    </View>
  );
}

/** One sous-chef turn: who asked and how, what it cost, each model round and tool, and its reply. */
export function TurnDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const nav = useNav();
  const f = useFormat();
  const { data: t, error } = useLoad<AdminTurn>(`/admin/turns/${encodeURIComponent(id)}`);
  const queued = t?.startedAt
    ? new Date(t.startedAt).getTime() - new Date(t.createdAt).getTime()
    : null;
  return (
    <Dialog
      visible
      onClose={onClose}
      title={t ? `${t.channel === 'voice' ? 'Voice' : 'Chat'} turn` : 'Sous-chef turn'}
    >
      {!t ? (
        <Loading error={error} />
      ) : (
        <>
          <View style={[s.wrap, { gap: 6 }]}>
            <Badge title={t.status} tone={statusTone(t.status)} />
          </View>
          {!!t.trace?.error && <Notice tone="error" text={t.trace.error} />}
          <Row
            title={t.user.name}
            lines={[t.user.email]}
            leading={<Avatar name={t.user.name} uri={t.user.avatar} size={36} />}
            onPress={() => nav.member(t.user.id)}
          />
          <Facts
            rows={[
              ['Asked', f.dateTime(t.createdAt)],
              ...(queued != null ? [['Waited', seconds(queued)] as [string, string]] : []),
              ...(t.ms != null ? [['Took', seconds(t.ms)] as [string, string]] : []),
              ['Cost', f.money(t.cost)],
              ...(t.model ? [['Model', t.model] as [string, string]] : []),
              ...(t.status === 'running' && t.step ? [['Doing', t.step] as [string, string]] : []),
              ['Conversation', t.project],
              ['Turn ID', t.id],
            ]}
          />
          {!!t.trace?.rounds.length && (
            <>
              <SectionLabel>Rounds</SectionLabel>
              {t.trace.rounds.map((r, i) => (
                <View key={i} style={{ gap: 4 }}>
                  <Text style={[s.h3, { fontSize: 14 }]}>
                    {`Round ${i + 1} · ${seconds(r.ms)} · ${f.money(r.cost)}`}
                  </Text>
                  {(r.tools || []).map((tool, j) => (
                    <Text key={j} style={[s.small, !!tool.error && { color: color.error }]}>
                      {`${tool.name} · ${seconds(tool.ms)}${tool.error ? ` · ${tool.error}` : ''}`}
                    </Text>
                  ))}
                  {!r.tools?.length && <Text style={s.small}>Answered in text.</Text>}
                </View>
              ))}
            </>
          )}
          {!!t.reply && (
            <>
              <SectionLabel>Reply</SectionLabel>
              <Text selectable style={s.muted}>
                {t.reply}
              </Text>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

export function JobDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const nav = useNav();
  const f = useFormat();
  const path = `/admin/jobs/${encodeURIComponent(id)}`;
  const { data: j, error } = useLoad<AdminJob>(path);
  const action = useRun();
  const [cancel, setCancel] = useState(false);
  const result = j?.result;
  return (
    <>
      <Dialog visible onClose={onClose} title={j ? `${kindNames[j.kind] || j.kind} job` : 'AI job'}>
        {!j ? (
          <Loading error={error} />
        ) : (
          <>
            <View style={[s.wrap, { gap: 6 }]}>
              <Badge title={j.status} tone={statusTone(j.status)} />
            </View>
            {action.result && (
              <Notice tone={action.result.ok ? 'success' : 'error'} text={action.result.text} />
            )}
            {!!j.error && <Notice tone="error" text={j.error} />}
            <Row
              title={j.user.name}
              lines={[j.user.email]}
              leading={<Avatar name={j.user.name} uri={j.user.avatar} size={36} />}
              onPress={() => nav.member(j.user.id)}
            />
            <Facts
              rows={[
                ['Created', f.dateTime(j.createdAt)],
                ['Last update', f.dateTime(j.updatedAt)],
                ['Reserved cost', f.money(j.cost)],
                ...(j.providerId ? [['Provider task', j.providerId] as [string, string]] : []),
                ['Job ID', j.id],
              ]}
            />
            <SectionLabel>Prompt</SectionLabel>
            <Text
              selectable
              style={{
                fontFamily: font.medium,
                fontSize: 13,
                lineHeight: 19,
                color: color.ink,
                backgroundColor: color.white,
                borderRadius: radius.sm,
                padding: 14,
              }}
            >
              {j.prompt}
            </Text>
            {result && (result.text || result.url || result.recipe) && (
              <>
                <SectionLabel>Result</SectionLabel>
                {result.recipe?.title && (
                  <Text style={s.h3}>{`Recipe: ${result.recipe.title}`}</Text>
                )}
                {result.url && (
                  <Text
                    accessibilityRole="link"
                    onPress={() => void Linking.openURL(result.url!)}
                    style={[s.body, { textDecorationLine: 'underline' }]}
                  >
                    {result.url}
                  </Text>
                )}
                {result.text && (
                  <Text selectable style={s.muted}>
                    {result.text.slice(0, 2000)}
                  </Text>
                )}
              </>
            )}
            {(j.status === 'queued' || j.status === 'processing') && (
              <Button
                title="Cancel job"
                icon={XCircle}
                variant="secondary"
                small
                onPress={() => setCancel(true)}
              />
            )}
          </>
        )}
      </Dialog>
      <Confirm
        visible={cancel}
        title="Cancel this job?"
        text={
          j?.status === 'processing'
            ? 'The provider already has this task and may still finish and bill it, so its reserved cost stays.'
            : 'It hasn’t reached a provider yet, so nothing is spent and its reservation is released.'
        }
        action="Cancel job"
        danger
        busy={!!action.busy}
        result={action.result}
        onConfirm={() =>
          void action
            .run('cancel', () => api(`${path}/cancel`, { method: 'POST' }), 'Job cancelled.')
            .then((ok) => ok && setCancel(false))
        }
        onClose={() => setCancel(false)}
      />
    </>
  );
}
