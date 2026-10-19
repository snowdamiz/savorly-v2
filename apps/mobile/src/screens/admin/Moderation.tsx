import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Ban, Check, EyeOff, Flag, Trash2 } from '../../components/icons';
import { api } from '../../lib/api';
import { AdminReview, ReportGroup, ReportStatus } from '../../lib/admin';
import { color, radius, s } from '../../lib/theme';
import { Button, FoodImage, Segmented } from '../../components/ui';
import { ReportList } from './Recipes';
import {
  Badge,
  Confirm,
  Filters,
  ListState,
  Notice,
  Row,
  Search,
  useFormat,
  useNav,
  usePaged,
  useRun,
  useSearch,
} from './parts';

type Pending = { kind: 'dismiss' | 'unpublish' | 'delete'; group: ReportGroup } | null;

/** Reported recipes, most-reported first, with the decisions an admin makes on them. */
export function Reports() {
  const nav = useNav();
  const f = useFormat();
  const [status, setStatus] = useState<ReportStatus>('open');
  const list = usePaged<ReportGroup>(`/admin/reports?status=${status}`);
  const action = useRun();
  const [pending, setPending] = useState<Pending>(null);
  const path = (g: ReportGroup) => `/admin/recipes/${encodeURIComponent(g.recipe.id)}`;
  const decide = async (fn: () => Promise<unknown>, message: string) => {
    if (await action.run('decide', fn, message)) setPending(null);
  };
  return (
    <View style={{ gap: 12 }}>
      <Segmented
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
          { value: 'dismissed', label: 'Dismissed' },
        ]}
      />
      {action.result?.ok && <Notice tone="success" text={action.result.text} />}
      <View style={{ gap: 12, opacity: list.loading && list.items.length ? 0.6 : 1 }}>
        {list.items.map((g) => (
          <View key={g.recipe.id} style={[s.card, { gap: 14 }]}>
            <View style={[s.row, { gap: 14, alignItems: 'flex-start' }]}>
              <FoodImage
                uri={g.recipe.image}
                style={{ width: 72, height: 72, borderRadius: radius.sm }}
              />
              <View style={{ flex: 1, gap: 4 }}>
                <Text
                  accessibilityRole="link"
                  onPress={() => nav.recipe(g.recipe.id)}
                  style={[s.h3, { textDecorationLine: 'underline' }]}
                >
                  {g.recipe.title}
                </Text>
                <Text
                  accessibilityRole="link"
                  onPress={() => nav.member(g.author.id)}
                  style={s.small}
                >
                  {`by ${g.author.name} (${g.author.email})`}
                </Text>
                <View style={[s.wrap, { gap: 6 }]}>
                  <Badge
                    title={`${g.count} report${g.count === 1 ? '' : 's'}`}
                    tone={status === 'open' ? 'warning' : 'light'}
                    icon={Flag}
                  />
                  {!g.recipe.published && <Badge title="Unpublished" icon={EyeOff} />}
                  {g.author.suspended && <Badge title="Author suspended" tone="error" icon={Ban} />}
                </View>
                <Text style={s.small}>{`Latest ${f.ago(g.latestAt)}`}</Text>
              </View>
            </View>
            <ReportList reports={g.reports} />
            {status === 'open' && (
              <View style={[s.wrap, { gap: 8 }]}>
                <Button
                  title="Dismiss"
                  icon={Check}
                  small
                  variant="secondary"
                  onPress={() => setPending({ kind: 'dismiss', group: g })}
                />
                {g.recipe.published && (
                  <Button
                    title="Unpublish"
                    icon={EyeOff}
                    small
                    variant="secondary"
                    onPress={() => setPending({ kind: 'unpublish', group: g })}
                  />
                )}
                <Button
                  title="Delete recipe"
                  icon={Trash2}
                  small
                  variant="secondary"
                  onPress={() => setPending({ kind: 'delete', group: g })}
                />
                <Button
                  title="Review author"
                  small
                  variant="ghost"
                  onPress={() => nav.member(g.author.id)}
                />
              </View>
            )}
          </View>
        ))}
      </View>
      <ListState
        shown={list.items.length}
        total={list.total}
        loading={list.loading}
        error={list.error}
        empty={
          status === 'open' ? 'Nothing to review. The queue is clear.' : `No ${status} reports.`
        }
        onMore={list.more}
      />
      <Confirm
        visible={pending?.kind === 'dismiss'}
        title="Dismiss these reports?"
        text="The recipe stays as it is. A new report reopens it."
        action="Dismiss"
        input={{ label: 'Note for other admins (optional)' }}
        busy={!!action.busy}
        result={action.result}
        onConfirm={(note) =>
          pending &&
          void decide(
            () =>
              api(`${path(pending.group)}/reports`, {
                method: 'POST',
                body: { status: 'dismissed', note },
              }),
            `Dismissed reports on “${pending.group.recipe.title}”.`,
          )
        }
        onClose={() => setPending(null)}
      />
      <Confirm
        visible={pending?.kind === 'unpublish'}
        title="Unpublish this recipe?"
        text="It leaves public view. Its author can still see it, but can’t publish it again until an admin restores it from the recipe. The reports are marked resolved."
        action="Unpublish"
        danger
        input={{ label: 'Note for other admins (optional)' }}
        busy={!!action.busy}
        result={action.result}
        onConfirm={(note) =>
          pending &&
          void decide(
            () =>
              api(`${path(pending.group)}/published`, {
                method: 'PUT',
                body: { published: false, note },
              }),
            `Unpublished “${pending.group.recipe.title}”.`,
          )
        }
        onClose={() => setPending(null)}
      />
      <Confirm
        visible={pending?.kind === 'delete'}
        title="Delete this recipe permanently?"
        text="The recipe and its reviews, saves and reports are deleted for good. The audit log keeps a record."
        action="Delete permanently"
        danger
        input={{ label: 'Note for other admins (optional)' }}
        busy={!!action.busy}
        result={action.result}
        onConfirm={(note) =>
          pending &&
          void decide(
            () => api(path(pending.group), { method: 'DELETE', body: { note } }),
            `Deleted “${pending.group.recipe.title}”.`,
          )
        }
        onClose={() => setPending(null)}
      />
    </View>
  );
}

const ratings = [
  { value: '0', label: 'All' },
  { value: '1', label: '1 star' },
  { value: '2', label: '2 stars' },
  { value: '3', label: '3 stars' },
  { value: '4', label: '4 stars' },
  { value: '5', label: '5 stars' },
] as const;

export function Reviews() {
  const nav = useNav();
  const f = useFormat();
  const search = useSearch();
  const [rating, setRating] = useState<(typeof ratings)[number]['value']>('0');
  const list = usePaged<AdminReview>(
    `/admin/reviews?q=${encodeURIComponent(search.query)}&rating=${rating}`,
  );
  const action = useRun();
  const [remove, setRemove] = useState<AdminReview | null>(null);
  return (
    <View style={{ gap: 12 }}>
      <Search
        value={search.text}
        onChange={search.setText}
        placeholder="Search review text, reviewer or recipe"
      />
      <Filters options={[...ratings]} value={rating} onChange={setRating} />
      {action.result?.ok && <Notice tone="success" text={action.result.text} />}
      <View style={{ gap: 8, opacity: list.loading && list.items.length ? 0.6 : 1 }}>
        {list.items.map((v) => (
          <Row
            key={v.id}
            title={`${'★'.repeat(v.rating)}${'☆'.repeat(5 - v.rating)}  ${v.author.name}`}
            badges={
              <>
                {v.author.suspended && <Badge title="Suspended" tone="error" icon={Ban} />}
                {!v.recipe.published && <Badge title="Recipe unpublished" />}
              </>
            }
            lines={[v.body, `on “${v.recipe.title}” · ${v.author.email} · ${f.date(v.createdAt)}`]}
            onPress={() => nav.recipe(v.recipe.id)}
            label={`Open the recipe ${v.recipe.title}`}
            actions={
              <Button
                title="Delete"
                small
                variant="ghost"
                icon={Trash2}
                label={`Delete ${v.author.name}’s review`}
                onPress={() => setRemove(v)}
              />
            }
          />
        ))}
      </View>
      <ListState
        shown={list.items.length}
        total={list.total}
        loading={list.loading}
        error={list.error}
        empty="No reviews match."
        onMore={list.more}
      />
      <Confirm
        visible={!!remove}
        title="Delete this review?"
        text={
          remove
            ? `“${remove.body.slice(0, 200)}” by ${remove.author.name}. Its rating stops counting toward the recipe. The audit log keeps the text.`
            : ''
        }
        action="Delete review"
        danger
        busy={!!action.busy}
        result={action.result}
        onConfirm={() =>
          remove &&
          void action
            .run(
              'delete',
              () => api(`/admin/reviews/${encodeURIComponent(remove.id)}`, { method: 'DELETE' }),
              'Review deleted.',
            )
            .then((ok) => ok && setRemove(null))
        }
        onClose={() => setRemove(null)}
      />
      <Text style={[s.small, { color: color.muted }]}>
        Reviews by suspended members are already hidden from recipes; delete only what shouldn’t
        come back.
      </Text>
    </View>
  );
}
