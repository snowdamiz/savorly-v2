import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ArrowUpDown,
  Ban,
  Bot,
  Check,
  Eye,
  EyeOff,
  Film,
  Flag,
  Trash2,
  Undo2,
  UserRound,
} from '../../components/icons';
import { api } from '../../lib/api';
import { AdminRecipe, AdminRecipeDetail, Report } from '../../lib/admin';
import { Recipe } from '../../lib/types';
import { color, radius, s } from '../../lib/theme';
import { Avatar, Button, Dialog, FoodImage, Segmented, useChrome } from '../../components/ui';
import { SettingsGroup, SettingsRow } from '../../components/SettingsRow';
import {
  Badge,
  Choose,
  Confirm,
  Facts,
  Filters,
  ListBar,
  ListState,
  Loading,
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

const filters = [
  { value: 'all', label: 'All' },
  { value: 'published', label: 'Published' },
  { value: 'drafts', label: 'Drafts' },
  { value: 'reported', label: 'Reported' },
  { value: 'ai', label: 'AI-generated' },
  { value: 'suspended', label: 'Suspended authors' },
] as const;
const sorts = [
  { value: 'newest', label: 'Newest' },
  { value: 'updated', label: 'Recently edited' },
  { value: 'reports', label: 'Most reported' },
  { value: 'saves', label: 'Most saved' },
  { value: 'rating', label: 'Top rated' },
] as const;

export function Recipes() {
  const nav = useNav();
  const f = useFormat();
  const search = useSearch();
  const [filter, setFilter] = useState<(typeof filters)[number]['value']>('all');
  const [sort, setSort] = useState<(typeof sorts)[number]['value']>('newest');
  const list = usePaged<AdminRecipe>(
    `/admin/recipes?q=${encodeURIComponent(search.query)}&filter=${filter}&sort=${sort}`,
  );
  return (
    <View style={{ gap: 12 }}>
      <Search
        value={search.text}
        onChange={search.setText}
        placeholder="Search title, author, cuisine or ID"
      />
      <Filters options={[...filters]} value={filter} onChange={setFilter} />
      <ListBar total={list.total} loading={list.loading} noun={['recipe', 'recipes']}>
        <Choose
          title="Sort recipes"
          icon={ArrowUpDown}
          options={sorts}
          value={sort}
          onChange={setSort}
        />
      </ListBar>
      <View style={{ gap: 8, opacity: list.loading && list.items.length ? 0.6 : 1 }}>
        {list.items.map((r) => (
          <Row
            key={r.id}
            onPress={() => nav.recipe(r.id)}
            leading={
              <FoodImage uri={r.image} style={{ width: 56, height: 56, borderRadius: 14 }} />
            }
            title={r.title}
            badges={<RecipeBadges r={r} />}
            lines={[
              `${r.author.name} · ${r.author.email}`,
              `${r.cuisine} · ${f.date(r.createdAt)} · ${r.reviewCount ? `★ ${r.rating} (${r.reviewCount})` : 'No reviews'} · ${r.saveCount} saves`,
            ]}
          />
        ))}
      </View>
      <ListState
        shown={list.items.length}
        total={list.total}
        loading={list.loading}
        error={list.error}
        empty="No recipes match."
        onMore={list.more}
      />
    </View>
  );
}

function RecipeBadges({ r }: { r: AdminRecipe }) {
  return (
    <>
      {r.unpublishedByAdminAt ? (
        <Badge title="Unpublished by an admin" tone="warning" icon={EyeOff} />
      ) : (
        !r.published && <Badge title="Draft" icon={EyeOff} />
      )}
      {r.aiGenerated && <Badge title="AI" icon={Bot} />}
      {r.video && <Badge title="Video" icon={Film} />}
      {r.openReports > 0 && <Badge title={`${r.openReports} open`} tone="warning" icon={Flag} />}
      {r.author.suspended && <Badge title="Author suspended" tone="error" icon={Ban} />}
    </>
  );
}

export function ReportList({ reports }: { reports: Report[] }) {
  const f = useFormat();
  const nav = useNav();
  return (
    <View>
      {reports.map((p) => (
        <View
          key={p.id}
          style={{
            gap: 4,
            paddingVertical: 12,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: color.border,
          }}
        >
          <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
            <Text
              accessibilityRole="link"
              onPress={() => nav.member(p.reporter.id)}
              style={[s.small, { color: color.ink, textDecorationLine: 'underline' }]}
            >
              {p.reporter.name} ({p.reporter.email})
            </Text>
            <Text style={s.small}>{f.dateTime(p.createdAt)}</Text>
            {p.status !== 'open' && (
              <Badge title={p.status} tone={p.status === 'resolved' ? 'success' : 'light'} />
            )}
          </View>
          <Text selectable style={[s.body, { fontSize: 14, lineHeight: 20 }]}>
            {p.reason}
          </Text>
          {p.status !== 'open' && (
            <Text style={s.small}>
              {`${p.status === 'resolved' ? 'Resolved' : 'Dismissed'} by ${p.resolvedBy || 'a removed admin'}${p.resolvedAt ? ` on ${f.date(p.resolvedAt)}` : ''}${p.resolution ? `: ${p.resolution}` : ''}`}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

type Pending = 'dismiss' | 'unpublish' | 'restore' | 'delete' | null;

export function RecipeDialog({
  id,
  onClose,
  onView,
}: {
  id: string;
  onClose: () => void;
  onView: (r: Recipe) => void;
}) {
  const nav = useNav();
  const f = useFormat();
  const path = `/admin/recipes/${encodeURIComponent(id)}`;
  const { data: r, error } = useLoad<AdminRecipeDetail>(path);
  const action = useRun();
  const [confirm, setConfirm] = useState<Pending>(null);
  const [full, setFull] = useState(false);
  const [tab, setTab] = useState<'recipe' | 'moderation'>('recipe');
  const { compact } = useChrome();
  const open = r?.reports.filter((p) => p.status === 'open') || [];
  // The recipe says whether an admin's unpublish holds it; older APIs only had the audit log.
  const held =
    r?.unpublishedByAdminAt !== undefined
      ? !!r.unpublishedByAdminAt
      : !!r && !r.published && r.history[0]?.action === 'recipe.unpublish';
  const done = async (key: string, fn: () => Promise<unknown>, message: string) => {
    if (await action.run(key, fn, message)) setConfirm(null);
  };
  return (
    <>
      <Dialog visible onClose={onClose} title={r?.title || 'Recipe'}>
        {!r ? (
          <Loading error={error} />
        ) : (
          <>
            <View style={[s.wrap, { gap: 6 }]}>
              <Badge
                title={r.published ? 'Published' : held ? 'Unpublished by an admin' : 'Draft'}
                tone={r.published ? 'success' : held ? 'warning' : 'light'}
                icon={r.published ? Check : EyeOff}
              />
              {r.aiGenerated && <Badge title="AI-generated" icon={Bot} />}
              {open.length > 0 && (
                <Badge
                  title={`${open.length} open report${open.length === 1 ? '' : 's'}`}
                  tone="warning"
                  icon={Flag}
                />
              )}
              {r.authorSuspended && <Badge title="Author suspended" tone="error" icon={Ban} />}
            </View>
            {!!r.unpublishedByAdminAt && (
              <Notice
                tone="warning"
                text={`Unpublished ${f.dateTime(r.unpublishedByAdminAt)} by ${r.unpublishedBy || 'an admin'}; its author can’t publish it until it’s restored.`}
              />
            )}
            {action.result && (
              <Notice tone={action.result.ok ? 'success' : 'error'} text={action.result.text} />
            )}
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'recipe', label: 'Recipe' },
                { value: 'moderation', label: 'Moderation' },
              ]}
            />
            {tab === 'recipe' && (
              <>
                <FoodImage
                  uri={r.image}
                  style={{ height: compact ? 160 : 200, borderRadius: radius.md }}
                />
                <Row
                  leading={<Avatar name={r.author.name} uri={r.author.avatar} size={40} />}
                  title={r.author.name}
                  lines={[r.authorEmail]}
                  onPress={() => nav.member(r.author.id)}
                  right={<UserRound size={18} color={color.soft} />}
                />
                <Text selectable style={s.muted}>
                  {r.description}
                </Text>
                <Facts
                  rows={[
                    ['Cuisine', r.cuisine],
                    [
                      'Time and size',
                      `${r.minutes} min · serves ${r.servings} · ${r.difficulty}${r.calories ? ` · ${r.calories} kcal` : ''}`,
                    ],
                    ['Tags', r.tags.join(', ') || 'None'],
                    [
                      'Media',
                      `${r.image ? 'Cover' : 'No cover'} · ${r.photos?.length || 0} more photos · ${r.video ? 'video' : 'no video'}`,
                    ],
                    [
                      'Community',
                      `${r.reviewCount ? `★ ${r.rating} from ${r.reviewCount} reviews` : 'No reviews'} · ${r.saveCount} saves`,
                    ],
                    ['Created', f.dateTime(r.createdAt)],
                    ['Edited', f.dateTime(r.updatedAt)],
                    ['Sous-chef chats', `${r.conversations} linked`],
                    ['Recipe ID', r.id],
                  ]}
                />
                <View style={[s.wrap, { gap: 8 }]}>
                  <Button
                    title={
                      full
                        ? 'Hide ingredients and steps'
                        : `Show ${r.ingredients.length} ingredients and ${r.steps.length} steps`
                    }
                    variant="secondary"
                    small
                    onPress={() => setFull(!full)}
                  />
                  {r.published && (
                    <Button
                      title="View as members see it"
                      icon={Eye}
                      variant="secondary"
                      small
                      busy={action.busy === 'view'}
                      onPress={() =>
                        void action.run(
                          'view',
                          async () =>
                            onView(await api<Recipe>(`/recipes/${encodeURIComponent(r.id)}`)),
                          '',
                        )
                      }
                    />
                  )}
                </View>
                {full && (
                  <View style={{ gap: 10 }}>
                    <SectionLabel>Ingredients</SectionLabel>
                    {r.ingredients.map((i, n) => (
                      <Text key={n} selectable style={s.body}>
                        {`${i.amount ? `${i.amount} ` : ''}${i.unit ? `${i.unit} ` : ''}${i.name}`}
                      </Text>
                    ))}
                    <SectionLabel>Steps</SectionLabel>
                    {r.steps.map((step, n) => (
                      <View key={n} style={{ gap: 2 }}>
                        <Text style={s.h3}>{`${n + 1}. ${step.title}`}</Text>
                        <Text selectable style={s.muted}>
                          {step.text}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
            {tab === 'moderation' && (
              <>
                <SettingsGroup>
                  {open.length > 0 && (
                    <SettingsRow
                      icon={Check}
                      title="Dismiss reports"
                      text={`${open.length} open`}
                      onPress={() => setConfirm('dismiss')}
                    />
                  )}
                  {r.published && (
                    <SettingsRow
                      icon={EyeOff}
                      title="Unpublish"
                      text="Out of public view until an admin restores it"
                      onPress={() => setConfirm('unpublish')}
                    />
                  )}
                  {held && (
                    <SettingsRow
                      icon={Undo2}
                      title="Restore to public"
                      onPress={() => setConfirm('restore')}
                    />
                  )}
                  <SettingsRow
                    icon={Trash2}
                    title="Delete recipe"
                    danger
                    onPress={() => setConfirm('delete')}
                  />
                </SettingsGroup>
                <SectionLabel>{`Reports (${r.reports.length})`}</SectionLabel>
                {r.reports.length > 0 ? (
                  <ReportList reports={r.reports} />
                ) : (
                  <Text style={s.muted}>No one has reported it.</Text>
                )}
                {r.history.length > 0 && (
                  <>
                    <SectionLabel>Admin history</SectionLabel>
                    {r.history.map((h) => (
                      <Text key={h.id} style={s.small}>
                        {`${f.dateTime(h.createdAt)} · ${h.adminEmail}: ${h.summary}${h.detail.note ? ` (“${h.detail.note}”)` : ''}`}
                      </Text>
                    ))}
                  </>
                )}
              </>
            )}
          </>
        )}
      </Dialog>
      {r && (
        <>
          <Confirm
            visible={confirm === 'dismiss'}
            title={`Dismiss ${open.length} report${open.length === 1 ? '' : 's'}?`}
            text="The recipe stays as it is. Reporters aren’t notified; a new report reopens it."
            action="Dismiss"
            input={{ label: 'Note for other admins (optional)' }}
            busy={action.busy === 'dismiss'}
            result={action.result}
            onConfirm={(note) =>
              void done(
                'dismiss',
                () =>
                  api(`${path}/reports`, { method: 'POST', body: { status: 'dismissed', note } }),
                'Reports dismissed.',
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'unpublish'}
            title="Unpublish this recipe?"
            text="It leaves Discover, search and profiles at once. Its author can still see and edit it, but can’t publish it again until an admin restores it. Open reports are marked resolved."
            action="Unpublish"
            danger
            input={{
              label: 'Note for other admins (optional)',
              placeholder: 'Copied from another site…',
            }}
            busy={action.busy === 'unpublish'}
            result={action.result}
            onConfirm={(note) =>
              void done(
                'unpublish',
                () => api(`${path}/published`, { method: 'PUT', body: { published: false, note } }),
                'Recipe unpublished.',
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'restore'}
            title="Restore this recipe?"
            text="It returns to public view as it is now."
            action="Restore"
            busy={action.busy === 'restore'}
            result={action.result}
            onConfirm={() =>
              void done(
                'restore',
                () => api(`${path}/published`, { method: 'PUT', body: { published: true } }),
                'Recipe restored.',
              )
            }
            onClose={() => setConfirm(null)}
          />
          <Confirm
            visible={confirm === 'delete'}
            title="Delete this recipe permanently?"
            text={`“${r.title}” and its reviews, saves and reports are deleted for good. Unpublishing is reversible; this isn’t.`}
            action="Delete permanently"
            danger
            input={{ label: 'Note for other admins (optional)' }}
            busy={action.busy === 'delete'}
            result={action.result}
            onConfirm={(note) =>
              void action
                .run(
                  'delete',
                  () => api(path, { method: 'DELETE', body: { note } }),
                  'Recipe deleted.',
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
