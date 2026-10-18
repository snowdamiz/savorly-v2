import React, { useState } from 'react';
import { Text, View } from 'react-native';
import {
  Award,
  Ban,
  Crown,
  LogOut,
  MailCheck,
  PencilLine,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Undo2,
} from '../../components/icons';
import { api } from '../../lib/api';
import { AdminMember, AdminMemberDetail } from '../../lib/admin';
import { useApp } from '../../lib/store';
import { PlanID } from '../../lib/types';
import { color, s } from '../../lib/theme';
import { Avatar, Button, Dialog, Field, Segmented } from '../../components/ui';
import {
  Badge,
  Confirm,
  Facts,
  Filters,
  followUp,
  Grid,
  ListState,
  Loading,
  Meter,
  Notice,
  Row,
  Search,
  SectionLabel,
  useFormat,
  useLoad,
  useNav,
  usePaged,
  useRun,
  useSearch,
} from './parts';
import { MemberFund } from './Fund';

const filters = [
  { value: 'all', label: 'All' },
  { value: 'admins', label: 'Admins' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'unverified', label: 'Unverified' },
  { value: 'paid', label: 'Paid plans' },
  { value: 'reported', label: 'Reported' },
  { value: 'samples', label: 'Sample cooks' },
  { value: 'founding', label: 'Founding creators' },
] as const;
const sorts = [
  { value: 'newest', label: 'Newest' },
  { value: 'active', label: 'Last sign-in' },
  { value: 'spend', label: 'AI spend' },
  { value: 'recipes', label: 'Recipes' },
  { value: 'oldest', label: 'Oldest' },
] as const;
const planNames: Record<PlanID, string> = { free: 'Free', plus: 'Plus', pro: 'Pro' };

/** The badges that say who a member is, wherever they're listed. */
export function MemberBadges({ m }: { m: AdminMember }) {
  return (
    <>
      {m.owner && <Badge title="Owner" tone="dark" icon={Crown} />}
      {m.admin && !m.owner && <Badge title="Admin" tone="dark" icon={ShieldCheck} />}
      {m.suspendedAt && <Badge title="Suspended" tone="error" icon={Ban} />}
      {m.sample && <Badge title="Sample" />}
      {!!m.foundingCreatorAt && <Badge title="Founding creator" tone="dark" icon={Award} />}
      {!m.emailVerified && !m.sample && <Badge title="Unverified" tone="warning" />}
      {m.plan !== 'free' && (
        <Badge title={`${planNames[m.plan]}${m.comped ? ' · comp' : ''}`} tone="success" />
      )}
      {m.openReports > 0 && (
        <Badge
          title={`${m.openReports} open report${m.openReports === 1 ? '' : 's'}`}
          tone="warning"
        />
      )}
    </>
  );
}

export function Members() {
  const nav = useNav();
  const f = useFormat();
  const search = useSearch();
  const [filter, setFilter] = useState<(typeof filters)[number]['value']>('all');
  const [sort, setSort] = useState<(typeof sorts)[number]['value']>('newest');
  const list = usePaged<AdminMember>(
    `/admin/users?q=${encodeURIComponent(search.query)}&filter=${filter}&sort=${sort}`,
  );
  return (
    <View style={{ gap: 12 }}>
      <Search
        value={search.text}
        onChange={search.setText}
        placeholder="Search name, email, handle or ID"
      />
      <Filters options={[...filters]} value={filter} onChange={setFilter} />
      <Filters label="Sort" options={[...sorts]} value={sort} onChange={setSort} />
      <View style={{ gap: 8, opacity: list.loading && list.items.length ? 0.6 : 1 }}>
        {list.items.map((m) => (
          <Row
            key={m.id}
            onPress={() => nav.member(m.id)}
            label={`Open ${m.name}`}
            leading={<Avatar name={m.name} uri={m.avatar} size={44} />}
            title={m.name}
            badges={<MemberBadges m={m} />}
            lines={[
              m.email,
              `Joined ${f.date(m.createdAt)} · ${m.lastSignInAt ? `signed in ${f.ago(m.lastSignInAt)}` : 'no sign-ins on record'}`,
              `${m.publishedCount} of ${m.recipeCount} recipes published · ${f.money(m.spend30d)} AI spend in 30 days`,
            ]}
          />
        ))}
      </View>
      <ListState
        shown={list.items.length}
        total={list.total}
        loading={list.loading}
        error={list.error}
        empty="No members match."
        onMore={list.more}
      />
    </View>
  );
}

type Pending =
  'suspend' | 'unsuspend' | 'signout' | 'verify' | 'admin' | 'setup' | 'founding' | 'delete' | null;

export function MemberDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const app = useApp();
  const nav = useNav();
  const f = useFormat();
  const { data: m, error } = useLoad<AdminMemberDetail>(`/admin/users/${encodeURIComponent(id)}`);
  const action = useRun();
  const [confirm, setConfirm] = useState<Pending>(null);
  const [editing, setEditing] = useState(false);
  // A plan picked but not applied yet; it resets whenever the record reloads.
  const [choice, setChoice] = useState<{ from: AdminMemberDetail | null; plan: PlanID } | null>(
    null,
  );
  const plan = choice && choice.from === m ? choice.plan : m?.plan || 'free';
  const setPlan = (p: PlanID) => setChoice({ from: m, plan: p });
  const path = `/admin/users/${encodeURIComponent(id)}`;
  const me = m?.id === nav.me.id;
  // Mirrors the API's rules, which are what actually enforce them. An owner's address is
  // protected before it's verified too.
  const locked =
    !!m && ((m.owner && !me) || ((m.admin || m.ownerEmail) && !m.owner && !me && !nav.owner));
  const done = async (key: string, fn: () => Promise<unknown>, message: string) => {
    if (await action.run(key, fn, message)) setConfirm(null);
  };
  return (
    <>
      <Dialog visible onClose={onClose} title={m?.name || 'Member'}>
        {!m ? (
          <Loading error={error} />
        ) : (
          <>
            <View style={[s.row, { gap: 14 }]}>
              <Avatar name={m.name} uri={m.avatar} size={64} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text selectable style={s.h3}>
                  {m.email}
                </Text>
                <Text selectable style={s.small}>
                  @{m.handle}
                </Text>
                <View style={[s.wrap, { gap: 6 }]}>
                  <MemberBadges m={m} />
                </View>
              </View>
            </View>
            {m.suspendedAt && (
              <Notice
                tone="error"
                text={`Suspended ${f.dateTime(m.suspendedAt)}: ${m.suspendedReason}. They can't sign in, and their recipes, reviews and profile are hidden.`}
              />
            )}
            {action.result && (
              <Notice tone={action.result.ok ? 'success' : 'error'} text={action.result.text} />
            )}
            {!!m.bio && <Text style={s.muted}>{m.bio}</Text>}
            <Facts
              rows={[
                ['Joined', f.dateTime(m.createdAt)],
                [
                  'Last sign-in',
                  m.lastSignInAt
                    ? `${f.dateTime(m.lastSignInAt)} (${f.ago(m.lastSignInAt)})`
                    : 'No sessions on record',
                ],
                ['Signed in on', `${m.activeSessions} device${m.activeSessions === 1 ? '' : 's'}`],
                [
                  'Sign-in methods',
                  [
                    m.hasPassword && 'Password',
                    ...m.identities.map((p) => (p === 'apple' ? 'Apple' : 'Google')),
                  ]
                    .filter(Boolean)
                    .join(', ') || 'None',
                ],
                ['Email', m.emailVerified ? 'Verified' : 'Not verified'],
                [
                  'Plan',
                  `${planNames[m.plan]}${m.comped ? ' (complimentary)' : ''}${m.planStatus ? ` · ${m.planStatus}` : ''}${m.planInterval ? ` · ${m.planInterval}` : ''}${m.planRenewsAt ? ` · ${m.planCancels ? 'ends' : 'renews'} ${f.date(m.planRenewsAt)}` : ''}`,
                ],
                ...(m.planRefunds?.length
                  ? [
                      [
                        'Refunds',
                        m.planRefunds
                          .map(
                            (r) =>
                              `${r.currency === 'usd' ? f.money(r.amountCents / 100) : `${(r.amountCents / 100).toFixed(2)} ${r.currency.toUpperCase()}`} ${r.completedAt ? `refunded ${f.date(r.completedAt)}` : `under way since ${f.dateTime(r.createdAt)} (finished when the member asks again)`}`,
                          )
                          .join('; '),
                      ] as [string, string],
                    ]
                  : []),
                ...(m.stripeCustomerId
                  ? [['Stripe customer', m.stripeCustomerId] as [string, string]]
                  : []),
                ...(m.stripeSubscriptionId
                  ? [['Subscription', m.stripeSubscriptionId] as [string, string]]
                  : []),
                ...(m.preferences.diets.length || m.preferences.allergies.length
                  ? [
                      [
                        'Food',
                        [
                          ...m.preferences.diets,
                          ...m.preferences.allergies.map((a) => `allergic: ${a}`),
                        ].join(', '),
                      ] as [string, string],
                    ]
                  : []),
                ['Member ID', m.id],
              ]}
            />
            <SectionLabel>AI use, last 30 days</SectionLabel>
            {m.limits ? (
              <View style={{ gap: 12 }}>
                <Meter
                  label="Sous-chef turns"
                  used={m.usage.assistant}
                  limit={m.limits.assistant}
                  display={`${m.usage.assistant} of ${m.limits.assistant}`}
                />
                <Meter
                  label="Voice minutes"
                  used={m.usage.voiceSeconds / 60}
                  limit={m.limits.voiceMinutes}
                  display={`${Math.ceil(m.usage.voiceSeconds / 60)} of ${m.limits.voiceMinutes}`}
                />
                <Meter
                  label="AI photos"
                  used={m.usage.images}
                  limit={m.limits.images}
                  display={`${m.usage.images} of ${m.limits.images}`}
                />
                <Meter
                  label="AI videos"
                  used={m.usage.videos}
                  limit={m.limits.videos}
                  display={`${m.usage.videos} of ${m.limits.videos}`}
                />
                <Meter
                  label="Read-alouds"
                  used={m.usage.narration}
                  limit={m.limits.narration}
                  display={`${m.usage.narration} of ${m.limits.narration}`}
                />
                <Meter
                  label="Spend"
                  used={m.spend30d}
                  limit={m.limits.spendCap}
                  display={`${f.money(m.spend30d)} of ${f.money(m.limits.spendCap)}`}
                />
              </View>
            ) : (
              <Facts
                rows={[
                  ['Sous-chef turns', f.number(m.usage.assistant)],
                  ['Voice minutes', f.number(Math.ceil(m.usage.voiceSeconds / 60))],
                  ['AI photos', f.number(m.usage.images)],
                  ['AI videos', f.number(m.usage.videos)],
                  ['Read-alouds', f.number(m.usage.narration)],
                  ['Spend', `${f.money(m.spend30d)} (no plan limits while paid plans are off)`],
                ]}
              />
            )}
            <SectionLabel>Activity</SectionLabel>
            <Grid min={120}>
              {(
                [
                  ['Recipes', m.recipeCount],
                  ['Reviews', m.counts.reviews],
                  ['Saves', m.counts.saves],
                  ['Cookbooks', m.counts.cookbooks],
                  ['Followers', m.counts.followers],
                  ['Following', m.counts.following],
                  ['Chats', m.counts.conversations],
                  ['Planned meals', m.counts.mealPlans],
                  ['Pantry items', m.counts.pantry],
                  ['Reports filed', m.counts.reportsFiled],
                ] as const
              ).map(([label, n]) => (
                <View key={label} style={{ gap: 2 }}>
                  <Text style={[s.h3, { fontSize: 18 }]}>{f.number(n)}</Text>
                  <Text style={s.small}>{label}</Text>
                </View>
              ))}
            </Grid>
            {m.recipes.length > 0 && (
              <>
                <SectionLabel>{`Recipes (${m.recipeCount})`}</SectionLabel>
                {m.recipes.map((r) => (
                  <Row
                    key={r.id}
                    title={r.title}
                    onPress={() => nav.recipe(r.id)}
                    badges={
                      <>
                        {!r.published && <Badge title="Draft" />}
                        {r.aiGenerated && <Badge title="AI" />}
                        {r.openReports > 0 && (
                          <Badge title={`${r.openReports} reports`} tone="warning" />
                        )}
                      </>
                    }
                    lines={[f.date(r.createdAt)]}
                  />
                ))}
              </>
            )}
            {m.reviews.length > 0 && (
              <>
                <SectionLabel>Recent reviews</SectionLabel>
                {m.reviews.map((r) => (
                  <Row
                    key={r.id}
                    title={`${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} on “${r.recipe.title}”`}
                    onPress={() => nav.recipe(r.recipe.id)}
                    lines={[r.body, f.date(r.createdAt)]}
                  />
                ))}
              </>
            )}
            {m.jobs.length > 0 && (
              <>
                <SectionLabel>Recent AI jobs</SectionLabel>
                {m.jobs.map((j) => (
                  <Row
                    key={j.id}
                    title={j.kind}
                    onPress={() => nav.job(j.id)}
                    badges={
                      <Badge
                        title={j.status}
                        tone={
                          j.status === 'failed'
                            ? 'error'
                            : j.status === 'completed'
                              ? 'success'
                              : 'light'
                        }
                      />
                    }
                    lines={[`${f.dateTime(j.createdAt)} · ${f.money(j.cost)}`, j.error]}
                  />
                ))}
              </>
            )}
            {m.reportsFiled.length > 0 && (
              <>
                <SectionLabel>Reports they filed</SectionLabel>
                {m.reportsFiled.map((r) => (
                  <Row
                    key={r.id}
                    title={`“${r.recipe.title}”`}
                    onPress={() => nav.recipe(r.recipe.id)}
                    badges={<Badge title={r.status} />}
                    lines={[r.reason, f.date(r.createdAt)]}
                  />
                ))}
              </>
            )}
            <MemberFund id={m.id} name={m.name} locked={locked} nav={nav} />
            {m.history.length > 0 && (
              <>
                <SectionLabel>Admin history</SectionLabel>
                {m.history.map((h) => (
                  <Text key={h.id} style={s.small}>
                    {`${f.dateTime(h.createdAt)} · ${h.adminEmail}: ${h.summary}${followUp(h) ? `. Needs attention: ${followUp(h)}` : ''}`}
                  </Text>
                ))}
              </>
            )}
            <SectionLabel>Manage</SectionLabel>
            {locked ? (
              <Notice
                text={
                  m.owner
                    ? 'Owners are set by ADMIN_EMAILS and can’t be changed from the console.'
                    : m.admin
                      ? 'Only an owner can change another admin.'
                      : 'Only an owner can act on an address listed in ADMIN_EMAILS.'
                }
              />
            ) : (
              <View style={{ gap: 10 }}>
                <Button
                  title="Edit profile"
                  icon={PencilLine}
                  variant="secondary"
                  small
                  onPress={() => setEditing(true)}
                />
                {m.onboarded === false ? (
                  <Text style={s.small}>
                    Their kitchen setup is waiting for them the next time they open Savorly.
                  </Text>
                ) : (
                  <Button
                    title={me ? 'Restart my kitchen setup' : 'Restart kitchen setup'}
                    icon={RotateCcw}
                    variant="secondary"
                    small
                    onPress={() => setConfirm('setup')}
                  />
                )}
                {!me && (
                  <>
                    <View style={{ gap: 8 }}>
                      <Text style={s.small}>
                        Complimentary plan
                        {m.planInterval
                          ? ' (this member pays through Stripe; change it in the Stripe dashboard)'
                          : ''}
                      </Text>
                      <Segmented
                        value={plan}
                        onChange={setPlan}
                        options={(['free', 'plus', 'pro'] as const).map((p) => ({
                          value: p,
                          label: planNames[p],
                        }))}
                      />
                      {plan !== m.plan && (
                        <Button
                          title={`Switch to ${planNames[plan]}`}
                          small
                          busy={action.busy === 'plan'}
                          onPress={() =>
                            void action.run(
                              'plan',
                              () => api(`${path}/plan`, { method: 'PUT', body: { plan } }),
                              `${m.name} is now on ${planNames[plan]}.`,
                            )
                          }
                        />
                      )}
                    </View>
                    {!m.emailVerified && !m.ownerEmail && (
                      <Button
                        title="Mark email as verified"
                        icon={MailCheck}
                        variant="secondary"
                        small
                        onPress={() => setConfirm('verify')}
                      />
                    )}
                    <Button
                      title={
                        m.foundingCreatorAt ? 'Remove founding creator' : 'Make founding creator'
                      }
                      icon={Award}
                      variant="secondary"
                      small
                      onPress={() => setConfirm('founding')}
                    />
                    <Button
                      title="Sign out everywhere"
                      icon={LogOut}
                      variant="secondary"
                      small
                      onPress={() => setConfirm('signout')}
                    />
                    {nav.owner && !m.ownerEmail && !m.suspendedAt && (
                      <Button
                        title={m.admin ? 'Remove as admin' : 'Make admin'}
                        icon={m.admin ? ShieldOff : ShieldCheck}
                        variant="secondary"
                        small
                        onPress={() => setConfirm('admin')}
                      />
                    )}
                    {m.suspendedAt ? (
                      <Button
                        title="Lift suspension"
                        icon={Undo2}
                        variant="secondary"
                        small
                        onPress={() => setConfirm('unsuspend')}
                      />
                    ) : (
                      <Button
                        title="Suspend"
                        icon={Ban}
                        variant="secondary"
                        small
                        onPress={() => setConfirm('suspend')}
                      />
                    )}
                    <Button
                      title="Delete account"
                      icon={Trash2}
                      variant="secondary"
                      small
                      onPress={() => setConfirm('delete')}
                    />
                  </>
                )}
              </View>
            )}
          </>
        )}
      </Dialog>
      {/* Sheets open beside the record, never inside it: the sheet shows one page at a time. */}
      {m && (
        <>
          <EditMember member={m} visible={editing} onClose={() => setEditing(false)} />
          <Confirm
            visible={confirm === 'suspend'}
            title={`Suspend ${m.name}?`}
            text="They’re signed out everywhere and can’t sign back in. Their recipes, reviews and profile leave public view, queued AI work is cancelled, and any subscription stops charging. Nothing is deleted, and you can lift it later."
            action="Suspend"
            danger
            input={{
              label: 'Reason (only admins see it)',
              placeholder: 'Spam recipes, abusive reviews…',
              required: true,
            }}
            busy={action.busy === 'suspend'}
            result={action.result}
            onConfirm={(reason) =>
              void done(
                'suspend',
                () => api(`${path}/suspend`, { method: 'POST', body: { reason } }),
                `${m.name} is suspended.`,
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'unsuspend'}
            title={`Lift ${m.name}’s suspension?`}
            text="They can sign in again, and their recipes, reviews and profile return to public view."
            action="Lift suspension"
            busy={action.busy === 'unsuspend'}
            result={action.result}
            onConfirm={() =>
              void done(
                'unsuspend',
                () => api(`${path}/suspend`, { method: 'DELETE' }),
                `${m.name} can sign in again.`,
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'signout'}
            title="Sign out everywhere?"
            text={`Ends ${m.name}’s ${m.activeSessions} session${m.activeSessions === 1 ? '' : 's'} and any live voice conversation. They can sign straight back in.`}
            action="Sign out everywhere"
            busy={action.busy === 'signout'}
            result={action.result}
            onConfirm={() =>
              void done(
                'signout',
                () => api(`${path}/sign-out`, { method: 'POST' }),
                `${m.name} is signed out everywhere.`,
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'setup'}
            title={me ? 'Restart your kitchen setup?' : 'Restart kitchen setup?'}
            text={
              me
                ? 'The new-kitchen setup (photo, name and username, food preferences, cooks to follow, meeting the sous-chef) opens straight away, so you can try it. Your profile stays as it is; each step starts from what you have.'
                : `${m.name} sees the new-kitchen setup (photo, name and username, food preferences, cooks to follow, meeting the sous-chef) the next time they open Savorly. Their profile stays as it is until they save a step.`
            }
            action="Restart setup"
            busy={action.busy === 'setup'}
            result={action.result}
            onConfirm={() =>
              void action
                .run(
                  'setup',
                  () => api(`${path}/setup`, { method: 'POST' }),
                  me ? '' : `${m.name}’s kitchen setup will open next time.`,
                )
                .then(async (ok) => {
                  if (!ok) return;
                  setConfirm(null);
                  // Your own setup takes over the screen, so the record makes way for it.
                  if (me) {
                    onClose();
                    await app.refreshUser();
                  }
                })
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'founding'}
            title={
              m.foundingCreatorAt
                ? `Remove ${m.name} as a founding creator?`
                : `Make ${m.name} a founding creator?`
            }
            text={
              m.foundingCreatorAt
                ? 'The “Founding creator” mark leaves their profile and recipes, and they leave the cook-along’s rotation. Weeks already scheduled stay as they are.'
                : 'Their profile and recipes say “Founding creator”, and they join the cook-along’s rotation: a week nobody schedules can go to their most saved recipe.'
            }
            action={m.foundingCreatorAt ? 'Remove the mark' : 'Make founding creator'}
            busy={action.busy === 'founding'}
            result={action.result}
            onConfirm={() =>
              void done(
                'founding',
                () =>
                  api(`${path}/founding`, {
                    method: 'PUT',
                    body: { founding: !m.foundingCreatorAt },
                  }),
                m.foundingCreatorAt
                  ? `${m.name} is no longer a founding creator.`
                  : `${m.name} is a founding creator.`,
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'verify'}
            title="Mark this email as verified?"
            text={`Only do this if you know ${m.email} belongs to this member, for example after they wrote to you from it.`}
            action="Mark verified"
            busy={action.busy === 'verify'}
            result={action.result}
            onConfirm={() =>
              void done(
                'verify',
                () => api(`${path}/verify`, { method: 'POST' }),
                'Email marked as verified.',
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'admin'}
            title={m.admin ? `Remove ${m.name} as an admin?` : `Make ${m.name} an admin?`}
            text={
              m.admin
                ? 'They lose access to the admin console at once.'
                : 'Admins can moderate content, suspend and delete members, cancel AI jobs and change settings. Only owners appoint admins, and admins can’t act on owners or each other.'
            }
            action={m.admin ? 'Remove admin' : 'Make admin'}
            danger={!m.admin}
            busy={action.busy === 'admin'}
            result={action.result}
            onConfirm={() =>
              void done(
                'admin',
                () => api(`${path}/admin`, { method: 'PUT', body: { admin: !m.admin } }),
                m.admin ? `${m.name} is no longer an admin.` : `${m.name} is now an admin.`,
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'delete'}
            title={`Delete ${m.name}’s account?`}
            text={`This permanently deletes the account with its ${m.recipeCount} recipes, reviews, cookbooks and kitchen lists, cancels any subscription, and can’t be undone. If Stripe can’t confirm the cancellation, the audit log says what to finish there. Consider suspending instead.`}
            action="Delete permanently"
            danger
            input={{ label: `Type ${m.email} to confirm`, match: m.email }}
            busy={action.busy === 'delete'}
            result={action.result}
            onConfirm={(confirmText) =>
              void action
                .run(
                  'delete',
                  () => api(path, { method: 'DELETE', body: { confirm: confirmText } }),
                  'Account deleted.',
                )
                .then((ok) => ok && onClose())
            }
            onClose={() => setConfirm(null)}
          />
        </>
      )}
    </>
  );
}

function EditMember({
  member,
  visible,
  onClose,
}: {
  member: AdminMemberDetail;
  visible: boolean;
  onClose: () => void;
}) {
  const action = useRun();
  const [form, setForm] = useState({ name: '', handle: '', bio: '', avatar: '' });
  // Each opening starts from the member's current profile.
  const [shown, setShown] = useState(false);
  if (shown !== visible) {
    setShown(visible);
    if (visible)
      setForm({ name: member.name, handle: member.handle, bio: member.bio, avatar: member.avatar });
  }
  // Only what changed is sent, so a handle from before today's rules can stay as it is.
  const changes = Object.fromEntries(
    (Object.keys(form) as (keyof typeof form)[])
      .filter((k) => form[k] !== member[k])
      .map((k) => [k, form[k]]),
  );
  const set = (k: keyof typeof form) => (v: string) => setForm((x) => ({ ...x, [k]: v }));
  return (
    <Dialog visible={visible} onClose={onClose} title="Edit profile">
      <Text style={s.muted}>
        For clearing offensive names, bios or photos. The member isn’t notified.
      </Text>
      <Field label="Name" value={form.name} onChangeText={set('name')} maxLength={70} />
      <Field
        label="Handle"
        value={form.handle}
        onChangeText={set('handle')}
        autoCapitalize="none"
        maxLength={60}
      />
      <Field label="Bio" value={form.bio} onChangeText={set('bio')} multiline maxLength={1000} />
      <Field
        label="Photo URL"
        value={form.avatar}
        onChangeText={set('avatar')}
        autoCapitalize="none"
        placeholder="https://…"
      />
      {action.result && !action.result.ok && <Notice tone="error" text={action.result.text} />}
      <View style={[s.row, { gap: 8 }]}>
        <Button
          title="Clear bio and photo"
          variant="secondary"
          small
          onPress={() => setForm((x) => ({ ...x, bio: '', avatar: '' }))}
        />
      </View>
      <Button
        title="Save profile"
        disabled={!Object.keys(changes).length}
        busy={!!action.busy}
        onPress={() =>
          void action
            .run(
              'save',
              () =>
                api(`/admin/users/${encodeURIComponent(member.id)}`, {
                  method: 'PATCH',
                  body: changes,
                }),
              'Profile saved.',
            )
            .then((ok) => ok && onClose())
        }
      />
      <Text style={[s.small, { color: color.muted }]}>Changes are recorded in the audit log.</Text>
    </Dialog>
  );
}
