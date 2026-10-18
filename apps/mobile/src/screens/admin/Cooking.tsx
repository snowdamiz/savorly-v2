// The console's Cooking section (docs/ADMIN.md): how we'll know the cooking flywheel works, the
// creator fund's weekly report, the weekly cook-along and the founding creators who take turns in
// it. English only, like the rest of the console.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Award, CalendarDays, X } from '../../components/icons';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { AdminRecipe, CookAlongs, CookAlongWeek, CookingMetrics } from '../../lib/admin';
import { s } from '../../lib/theme';
import { Avatar, Button, Dialog, FoodImage, IconButton } from '../../components/ui';
import {
  Badge,
  Confirm,
  Grid,
  ListState,
  Loading,
  Nav,
  Notice,
  Panel,
  Row,
  Search,
  SectionLabel,
  Stat,
  useFormat,
  useLoad,
  useNav,
  usePaged,
  useRun,
  useSearch,
} from './parts';
import { FundWeeksReport } from './Fund';

const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–';
/** The Monday `weeks` weeks after `week` (YYYY-MM-DD, UTC). */
const addWeeks = (week: string, weeks: number) => {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  return d.toISOString().slice(0, 10);
};

export function Cooking() {
  return (
    <View style={{ gap: 16 }}>
      <Metrics />
      <FundWeeksReport />
      <CookAlongPanel />
    </View>
  );
}

/** Plan section 10's numbers, against the targets for the end of Phase 2. */
function Metrics() {
  const f = useFormat();
  const { locale } = useI18n();
  const { data, error } = useLoad<CookingMetrics>('/admin/cooking');
  if (!data) return <Loading error={error} />;
  const { cooksPerActive: c, finishRate, payingCooked, creatorsOver25, retention, aiCost } = data;
  const { cookTested, fixes } = data;
  const perActive = c.active > 0 ? c.cooks / c.active : 0;
  const month = (iso: string) =>
    new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  return (
    <Panel
      title="Is it working?"
      subtitle="Whether members cook in Savorly, not just browse. Targets are for the end of Phase 2; revise them after the first month of data. Sample cooks don't count."
    >
      <Grid min={220}>
        <Stat
          label="Verified cooks per active member"
          value={c.active > 0 ? perActive.toFixed(1) : '–'}
          note={`${f.number(c.cooks)} verified cooks by ${f.number(c.active)} members active in 30 days · target 3`}
          tone={c.active > 0 && perActive < 1 ? 'warning' : undefined}
        />
        <Stat
          label="Cooking-mode finish rate"
          value={percent(finishRate.finished, finishRate.started)}
          note={`${f.number(finishRate.finished)} of ${f.number(finishRate.started)} sessions started in 30 days reached the end · target 70%`}
        />
        <Stat
          label="Paying members who cooked"
          value={percent(payingCooked.cooked, payingCooked.paying)}
          note={`${f.number(payingCooked.cooked)} of ${f.number(payingCooked.paying)} paying members have a verified cook in ${month(payingCooked.month)} · target 80%`}
        />
        <Stat
          label="Creators earning over $25"
          value={f.number(creatorsOver25.creators)}
          note={
            creatorsOver25.month
              ? `in ${month(creatorsOver25.month)}, the last closed month · target 100`
              : 'No month has closed yet · target 100'
          }
        />
        <Stat
          label="Month-3 retention of paying members"
          value={percent(retention.retained, retention.cohort)}
          note={
            retention.cohort > 0
              ? `${f.number(retention.retained)} of ${f.number(retention.cohort)} who started paying 90 to 120 days ago still paid 90 days in`
              : `Not measured yet: nobody started paying 90 to 120 days ago${retention.recordedSince ? ` (recorded since ${f.date(retention.recordedSince)})` : ''}`
          }
        />
        <Stat
          label="AI cost per paying member"
          value={aiCost.perMember === null ? '–' : f.money(aiCost.perMember)}
          note={
            aiCost.shareOfCap === null
              ? 'No paying members yet · target under 40% of their plan’s cap'
              : `${Math.round(aiCost.shareOfCap * 100)}% of their plan’s cap on average in 30 days, households included · target under 40%`
          }
          tone={aiCost.shareOfCap !== null && aiCost.shareOfCap >= 0.4 ? 'warning' : undefined}
        />
        {cookTested && (
          <Stat
            label="Cook-tested recipes"
            value={f.number(cookTested.recipes)}
            note={`${f.number(cookTested.early)} more have 1 to 4 verified cooks · target 500`}
          />
        )}
        {fixes && (
          <Stat
            label="Fixes accepted"
            value={percent(fixes.accepted, fixes.suggested)}
            note={`${f.number(fixes.accepted)} of ${f.number(fixes.suggested)} suggestions in 90 days · target 1 in 4`}
          />
        )}
      </Grid>
    </Panel>
  );
}

/** The cook-along's weeks, who scheduled them, and the founding creators' rotation. */
function CookAlongPanel() {
  const nav = useNav();
  const f = useFormat();
  const { data, error } = useLoad<CookAlongs>('/admin/cook-alongs');
  const action = useRun();
  const [picking, setPicking] = useState<string | null>(null);
  const [clearing, setClearing] = useState<CookAlongWeek | null>(null);
  if (!data) return <Loading error={error} />;
  const byWeek = new Map(data.weeks.map((w) => [w.week, w]));
  const upcoming = Array.from({ length: 9 }, (_, i) => addWeeks(data.week, i));
  const past = data.weeks.filter((w) => w.week < data.week).reverse();
  const next = data.rotation.find((c) => c.id === data.next);
  const label = (week: string) =>
    `Week of ${f.day(week)}${week === data.week ? ' · this week' : ''}`;
  const schedule = async (week: string, recipe: { id: string; title: string }) => {
    const ok = await action.run(
      'schedule',
      () => api(`/admin/cook-alongs/${week}`, { method: 'PUT', body: { recipeId: recipe.id } }),
      `“${recipe.title}” is the cook-along for the week of ${f.day(week)}.`,
    );
    if (ok) setPicking(null);
  };
  const usable = (w?: CookAlongWeek) =>
    !!w?.recipe && w.recipe.published && !w.recipe.author.suspended;
  // The rotation gives the first open week to whoever is next; later ones aren't decided yet.
  const firstOpen = upcoming.find((week) => !usable(byWeek.get(week)));
  // Only the first open week is decided; the panel's subtitle says what happens to the rest.
  const openLine = (week: string) =>
    week !== firstOpen
      ? null
      : !next
        ? 'Open: no founding creator has a public recipe, so nothing will be featured.'
        : `Open: the rotation gives it to ${next.name || next.email}, with “${next.recipes[0].title}”, ${week === data.week ? 'within minutes' : 'when the week starts'}.`;
  const row = (week: string) => {
    const w = byWeek.get(week);
    const r = w?.recipe;
    const open = !usable(w);
    return (
      <Row
        key={week}
        leading={
          r ? (
            <FoodImage uri={r.image} style={{ width: 52, height: 52, borderRadius: 14 }} />
          ) : undefined
        }
        title={label(week)}
        badges={
          <>
            {data.announcedWeek === week && <Badge title="Announced" tone="success" />}
            {w?.automatic && <Badge title="Rotation" />}
            {r && open && <Badge title="Not public" tone="warning" />}
          </>
        }
        lines={[
          r
            ? `“${r.title}” by ${r.author.name || r.author.email}${r.author.founding ? ' · founding creator' : ''}`
            : w
              ? 'Its recipe was deleted.'
              : null,
          open && openLine(week),
          w &&
            [
              week <= data.week &&
                `${f.number(w.started)} started cooking it · ${f.number(w.cooks)} verified cooks`,
              !w.automatic && `Scheduled by ${w.scheduledBy || 'an admin who has left'}`,
            ]
              .filter(Boolean)
              .join(' · '),
        ]}
        right={
          <View style={[s.row, { gap: 4 }]}>
            <Button
              title={w ? 'Change' : 'Schedule'}
              label={`${w ? 'Change' : 'Schedule'} the week of ${f.day(week)}`}
              small
              variant="secondary"
              onPress={() => setPicking(week)}
            />
            {w && (
              <IconButton
                icon={X}
                label={`Clear the week of ${f.day(week)}`}
                plain
                size={36}
                onPress={() => setClearing(w)}
              />
            )}
          </View>
        }
      />
    );
  };
  return (
    <>
      <Panel
        title="Cook-along"
        subtitle="One recipe a week, Monday to Sunday (UTC): a card on Home, and a notification on Monday from 12:00 UTC, sent once a week. A week nobody schedules goes to the next founding creator in the rotation when it starts, with their most saved recipe that hasn't been featured yet."
      >
        {action.result && (
          <Notice tone={action.result.ok ? 'success' : 'error'} text={action.result.text} />
        )}
        {upcoming.map(row)}
        {past.length > 0 && (
          <>
            <SectionLabel>Past weeks</SectionLabel>
            {past.map((w) => (
              <Row
                key={w.week}
                title={label(w.week)}
                badges={w.automatic ? <Badge title="Rotation" /> : undefined}
                lines={[
                  w.recipe
                    ? `“${w.recipe.title}” by ${w.recipe.author.name || w.recipe.author.email}`
                    : 'Its recipe was deleted.',
                  `${f.number(w.started)} started cooking it · ${f.number(w.cooks)} verified cooks`,
                ]}
                onPress={w.recipe ? () => nav.recipe(w.recipe!.id) : undefined}
              />
            ))}
          </>
        )}
      </Panel>
      <Founders data={data} />
      {picking && (
        <CookAlongPicker
          week={picking}
          data={data}
          busy={action.busy === 'schedule'}
          result={action.result}
          onPick={(r) => void schedule(picking, r)}
          onClose={() => setPicking(null)}
        />
      )}
      <Confirm
        visible={!!clearing}
        title={clearing ? `Clear the week of ${f.day(clearing.week)}?` : ''}
        text={
          clearing?.week === data.week
            ? 'The rotation picks this week again at once. If it was already announced, nobody is notified again.'
            : 'The week goes back to the rotation, which picks it when the week starts.'
        }
        action="Clear the week"
        busy={action.busy === 'clear'}
        result={action.result}
        onConfirm={() =>
          void action
            .run(
              'clear',
              () => api(`/admin/cook-alongs/${clearing!.week}`, { method: 'DELETE' }),
              `The week of ${f.day(clearing!.week)} is back with the rotation.`,
            )
            .then((ok) => ok && setClearing(null))
        }
        onClose={() => setClearing(null)}
      />
    </>
  );
}

/** The founding creators in the order their turns come, each with the recipe their turn offers. */
function Founders({ data }: { data: CookAlongs }) {
  const nav = useNav();
  const f = useFormat();
  return (
    <Panel
      title="Founding creators"
      subtitle="They take turns in the cook-along: never featured first, then featured longest ago. Their profile and recipes say “Founding creator”. Mark someone from their record in Members."
      right={<Button title="Members" small variant="secondary" onPress={() => nav.go('members')} />}
    >
      {data.rotation.length === 0 ? (
        <Text style={s.muted}>No founding creators yet.</Text>
      ) : (
        data.rotation.map((c) => (
          <Row
            key={c.id}
            leading={<Avatar name={c.name} uri={c.avatar} size={44} />}
            title={c.name || c.email}
            label={`Open ${c.name || c.email}`}
            onPress={() => nav.member(c.id)}
            badges={
              data.next === c.id ? (
                <Badge title="Next" tone="dark" icon={CalendarDays} />
              ) : undefined
            }
            lines={[
              `${c.email} · since ${f.date(c.foundingAt)}`,
              [
                c.lastWeek ? `Last turn: the week of ${f.day(c.lastWeek)}` : 'Not featured yet',
                c.recipes.length
                  ? `their turn offers “${c.recipes[0].title}” (${f.number(c.recipes[0].saveCount)} saves)`
                  : 'no public recipe, so their turns are skipped',
              ].join(' · '),
            ]}
          />
        ))
      )}
    </Panel>
  );
}

/** Picks a week's recipe: the founding creators' first, or any public recipe. */
function CookAlongPicker({
  week,
  data,
  busy,
  result,
  onPick,
  onClose,
}: {
  week: string;
  data: CookAlongs;
  busy: boolean;
  result: { ok: boolean; text: string } | null;
  onPick: (r: { id: string; title: string }) => void;
  onClose: () => void;
}) {
  // The sheet is drawn outside the console's navigation, so it comes along.
  const nav = useNav();
  const f = useFormat();
  return (
    <Dialog visible onClose={onClose} title={`Cook-along for the week of ${f.day(week)}`}>
      <Nav.Provider value={nav}>
        <PickerBody data={data} busy={busy} result={result} onPick={onPick} />
      </Nav.Provider>
    </Dialog>
  );
}

function PickerBody({
  data,
  busy,
  result,
  onPick,
}: {
  data: CookAlongs;
  busy: boolean;
  result: { ok: boolean; text: string } | null;
  onPick: (r: { id: string; title: string }) => void;
}) {
  const f = useFormat();
  const search = useSearch();
  const list = usePaged<AdminRecipe>(
    `/admin/recipes?q=${encodeURIComponent(search.query)}&filter=published&sort=saves`,
  );
  const founders = data.rotation.filter((c) => c.recipes.length > 0);
  return (
    <View style={{ gap: 10, opacity: busy ? 0.6 : 1 }}>
      <Text style={s.muted}>
        Pick a public recipe. An appointed admin can’t feature their own recipe or another admin’s.
      </Text>
      {result && !result.ok && <Notice tone="error" text={result.text} />}
      {founders.map((c) => (
        <View key={c.id} style={{ gap: 8 }}>
          <SectionLabel>{`${c.name || c.email} · founding creator`}</SectionLabel>
          {c.recipes.map((r) => (
            <Row
              key={r.id}
              leading={
                <FoodImage uri={r.image} style={{ width: 44, height: 44, borderRadius: 12 }} />
              }
              title={r.title}
              label={`Feature ${r.title}`}
              badges={<Badge title="Founding" icon={Award} />}
              lines={[
                `${f.number(r.saveCount)} saves${r.featuredWeek ? ` · featured the week of ${f.day(r.featuredWeek)}` : ''}`,
              ]}
              onPress={() => onPick(r)}
            />
          ))}
        </View>
      ))}
      <SectionLabel>Any public recipe, most saved first</SectionLabel>
      <Search
        value={search.text}
        onChange={search.setText}
        placeholder="Search title, author, cuisine or ID"
      />
      {list.items
        .filter((r) => !r.author.suspended)
        .map((r) => (
          <Row
            key={r.id}
            leading={
              <FoodImage uri={r.image} style={{ width: 44, height: 44, borderRadius: 12 }} />
            }
            title={r.title}
            label={`Feature ${r.title}`}
            lines={[`by ${r.author.name} · ${f.number(r.saveCount)} saves`]}
            onPress={() => onPick(r)}
          />
        ))}
      <ListState
        shown={list.items.length}
        total={list.total}
        loading={list.loading}
        error={list.error}
        empty="No public recipe matches."
        onMore={list.more}
      />
    </View>
  );
}
