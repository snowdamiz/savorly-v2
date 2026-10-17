import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Globe,
  Leaf,
  Pencil,
  Plus,
  Share2,
  ShoppingBasket,
  Trash2,
  X,
} from '../components/icons';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import { GroceryMerge, Kitchen, PantryMatch, Plan, Recipe, Screen } from '../lib/types';
import { joinNames } from '../lib/food';
import { useShelf } from '../lib/shelf';
import { color, font, maxFontScale, radius, s } from '../lib/theme';
import {
  Button,
  CheckRow,
  Chip,
  Dialog,
  Empty,
  Field,
  FoodImage,
  IconButton,
  PageHeading,
  Pill,
  SearchBar,
  SectionTitle,
  Segmented,
  useChrome,
} from '../components/ui';
import { RecipeGrid, RecipeRow } from '../components/RecipeCard';
import { AskCard } from '../components/SousChef';
import { DatePicker } from '../components/DatePicker';
import { CookbookSettings, useShareCookbook } from '../components/CookbookSettings';
import { DangerButton } from '../components/DangerButton';
import {
  AddedBy,
  HouseholdEntry,
  HouseholdSheet,
  useHousehold,
} from '../components/HouseholdSheet';
import {
  daysBetween,
  firstDayOfWeek,
  formatDay,
  localDate,
  parseDay,
  weekDays,
} from '../lib/utils';
import { foodIcon } from '../lib/icons';
export { DangerButton };
const meals = ['Breakfast', 'Lunch', 'Dinner'];
export function SignInKitchen({
  title,
  text,
  icon,
}: {
  title: string;
  text: string;
  icon?: typeof BookOpen;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  return (
    <Empty
      title={title}
      text={text}
      icon={icon}
      action={() => app.setAuthOpen(true)}
      actionTitle={tr('Sign in or join')}
    />
  );
}
function HeadingAction({
  title,
  icon,
  onPress,
}: {
  title: string;
  icon: typeof Plus;
  onPress: () => void;
}) {
  const { desktop } = useChrome();
  return desktop ? (
    <Button title={title} icon={icon} small onPress={onPress} />
  ) : (
    <IconButton icon={icon} label={title} selected onPress={onPress} />
  );
}
export function Cookbooks({
  onOpen,
  navigate,
}: {
  onOpen: (r: Recipe) => void;
  navigate: (s: Screen) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const { compact, gutter } = useChrome();
  const [active, setActive] = useState('all');
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [remove, setRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const share = useShareCookbook();
  const selected = app.library.collections.find((c) => c.id === active);
  const shelf = useShelf(active);
  const { recipes } = shelf;
  return (
    <View style={{ gap: 22 }}>
      <PageHeading
        title={tr('Saved')}
        subtitle={tr('Your favorites, and the ones you’ll make next.')}
      >
        <HeadingAction
          title={tr('New cookbook')}
          icon={Plus}
          onPress={() => app.requireUser(() => setCreate(true))}
        />
      </PageHeading>
      {!app.user ? (
        <SignInKitchen
          title={tr('Keep your favorites close')}
          text={tr('Sign in to save recipes and sort them into cookbooks.')}
          icon={BookOpen}
        />
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[{ flexGrow: 0 }, compact && { marginHorizontal: -gutter }]}
            contentContainerStyle={{ gap: 8, paddingHorizontal: compact ? gutter : 0 }}
          >
            <Chip
              title={tr('All saved · {{v0}}', { v0: app.library.savedIds.length })}
              active={active === 'all'}
              onPress={() => setActive('all')}
            />
            <Chip
              title={tr('My recipes')}
              active={active === 'mine'}
              onPress={() => setActive('mine')}
            />
            {app.library.collections.map((c) => (
              <Chip
                key={c.id}
                title={c.name}
                icon={c.public ? Globe : undefined}
                active={active === c.id}
                onPress={() => setActive(c.id)}
              />
            ))}
          </ScrollView>
          {selected && (
            <View style={{ gap: 6 }}>
              <View style={[s.between, { gap: 12 }]}>
                <View style={[s.row, { flex: 1, gap: 10, flexWrap: 'wrap' }]}>
                  <Text style={s.h2}>{selected.name}</Text>
                  {selected.public && <Pill title={tr('Public')} icon={Globe} />}
                </View>
                <View style={[s.row, { gap: 8 }]}>
                  {selected.public && (
                    <IconButton
                      icon={Share2}
                      size={38}
                      label={tr('Share cookbook')}
                      onPress={() => void share(selected)}
                    />
                  )}
                  {/* Older servers can't rename a cookbook or make it public. */}
                  {typeof selected.public === 'boolean' && (
                    <IconButton
                      icon={Pencil}
                      size={38}
                      label={tr('Edit cookbook')}
                      onPress={() => setEditing(true)}
                    />
                  )}
                  <IconButton
                    icon={Trash2}
                    size={38}
                    label={tr('Delete cookbook')}
                    onPress={() => setRemove(true)}
                  />
                </View>
              </View>
              {!!selected.description && (
                <Text style={[s.muted, { maxWidth: 640 }]}>{selected.description}</Text>
              )}
            </View>
          )}
          {recipes.length ? (
            <>
              <RecipeGrid recipes={recipes} onOpen={onOpen} />
              {shelf.hasMore && (
                <Button
                  title={tr('Show more')}
                  variant="secondary"
                  busy={shelf.busy}
                  onPress={() => void shelf.showMore()}
                  style={{ alignSelf: 'center', minWidth: 220 }}
                />
              )}
            </>
          ) : !shelf.settled ? (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <ActivityIndicator color={color.ink} accessibilityLabel={tr('Loading…')} />
            </View>
          ) : (
            <Empty
              title={
                active === 'mine' ? tr('Every recipe has a story') : tr('Nothing saved here yet')
              }
              text={
                active === 'mine'
                  ? tr('Share a family favorite, a little experiment or your signature dish.')
                  : tr('Tap the bookmark on any recipe to keep it here.')
              }
              icon={BookOpen}
              action={() => navigate(active === 'mine' ? 'create' : 'explore')}
              actionTitle={active === 'mine' ? tr('Share a recipe') : tr('Find recipes')}
            />
          )}
        </>
      )}
      <Dialog visible={create} onClose={() => setCreate(false)} title={tr('New cookbook')}>
        <Field
          label={tr('Cookbook name')}
          placeholder={tr('Slow Sundays, weeknight heroes…')}
          value={name}
          onChangeText={setName}
          maxLength={60}
        />
        <Button
          title={tr('Create cookbook')}
          disabled={!name.trim()}
          onPress={() =>
            void app.act(async () => {
              const c = await api<{ id: string }>('/collections', {
                method: 'POST',
                body: { name },
              });
              await app.refreshLibrary();
              setName('');
              setCreate(false);
              setActive(c.id);
            }, 'Your new cookbook is ready.')
          }
        />
      </Dialog>
      <Dialog visible={remove} onClose={() => setRemove(false)} title={tr('Delete this cookbook?')}>
        <Text style={s.body}>
          {tr('Recipes stay in All saved. Only the cookbook “{{v0}}” is removed.', {
            v0: selected?.name || '',
          })}
        </Text>
        <DangerButton
          title={tr('Delete cookbook')}
          onPress={() =>
            void app.act(async () => {
              await api(`/collections/${active}`, { method: 'DELETE' });
              await app.refreshLibrary();
              setActive('all');
              setRemove(false);
            }, 'Cookbook removed. Your recipes are still saved.')
          }
        />
      </Dialog>
      <CookbookSettings
        cookbook={editing && selected ? selected : null}
        onClose={() => setEditing(false)}
      />
    </View>
  );
}
function MealSlot({
  meal,
  plan,
  onOpen,
  onAdd,
  onRemove,
}: {
  meal: string;
  plan?: Plan;
  onOpen: (r: Recipe) => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  // Another household member's private recipe is only its name here: it doesn't open.
  const teaser = !!plan?.recipe.teaser;
  const by = plan?.plannedBy && plan.plannedBy.id !== app.user?.id ? plan.plannedBy.name : '';
  return plan ? (
    <View style={[s.card, s.row, { padding: 10, gap: 12, flex: 1 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          teaser
            ? tr('{{v0}}’s private recipe: {{v1}}', { v0: by, v1: plan.recipe.title })
            : tr('View {{v0}}', { v0: plan.recipe.title })
        }
        onPress={() =>
          teaser
            ? app.notify(tr('Only {{v0}} can open this recipe; it’s private.', { v0: by }))
            : onOpen(plan.recipe)
        }
        style={[s.row, { gap: 12, flex: 1 }]}
      >
        <FoodImage uri={plan.recipe.image} style={{ width: 56, height: 56, borderRadius: 18 }} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[s.label, { fontSize: 10 }]}>{tr(meal)}</Text>
          <Text numberOfLines={1} style={[s.h3, { fontSize: 15 }]}>
            {plan.recipe.title}
          </Text>
          <Text numberOfLines={1} style={s.small}>
            {by
              ? `${tr('servingCount', { count: plan.servings })} · ${tr('Planned by {{v0}}', { v0: by })}`
              : tr('servingCount', { count: plan.servings })}
          </Text>
        </View>
      </Pressable>
      <IconButton
        icon={X}
        plain
        size={34}
        label={tr('Remove {{v0}} on {{v1}}', {
          v0: tr(meal),
          v1: formatDay(plan.day, locale, { weekday: 'long', month: 'long', day: 'numeric' }),
        })}
        onPress={onRemove}
      />
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tr('Add {{v0}}', { v0: tr(meal) })}
      onPress={onAdd}
      style={({ pressed }: { pressed: boolean }) => [
        s.row,
        {
          flex: 1,
          gap: 12,
          padding: 10,
          minHeight: 78,
          borderRadius: radius.lg,
          borderWidth: 1.5,
          borderStyle: 'dashed',
          borderColor: color.line,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 18,
          backgroundColor: color.subtle,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {React.createElement(foodIcon(meal) || Plus, {
          size: 20,
          color: color.muted,
          strokeWidth: 1.8,
        })}
      </View>
      <View style={{ gap: 3, flex: 1 }}>
        <Text style={[s.label, { fontSize: 10 }]}>{tr(meal)}</Text>
        <Text style={[s.h3, { fontSize: 15, color: color.muted }]}>{tr('Add a recipe')}</Text>
      </View>
      <Plus size={18} color={color.soft} />
    </Pressable>
  );
}
/** The YYYY-MM-DD day `n` days after (or before) `day`. */
const shiftDay = (day: string, n: number) => {
  const d = parseDay(day) ?? new Date();
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
/**
 * Plans for the week from..to. The store holds them from the week before this one to some weeks
 * ahead; a week it might not hold (anything outside a week back and three ahead, whichever way
 * its weeks are counted) is asked for on its own, and again after every change to it.
 */
function useWeekPlans(from: string, to: string, today: string, userId: string | null) {
  const near = from >= shiftDay(today, -7) && to <= shiftDay(today, 21);
  const key = `${userId}:${from}:${to}`;
  const [week, setWeek] = useState<{ key: string; plans: Plan[] | null; error: string } | null>(
    null,
  );
  // Answers are numbered: one for a week the planner has since left is dropped.
  const asked = useRef(0);
  const load = useCallback(() => {
    const n = ++asked.current;
    return api<Kitchen>(`/kitchen?from=${from}&to=${to}`).then(
      (kitchen) => {
        const plans = Array.isArray(kitchen?.plans) ? kitchen.plans : [];
        if (n === asked.current) setWeek({ key, plans, error: '' });
      },
      (e: Error) => {
        if (n === asked.current) setWeek({ key, plans: null, error: e.message });
      },
    );
  }, [key, from, to]);
  useEffect(() => {
    if (!near && userId) void load();
  }, [near, userId, load]);
  const reload = useCallback(async () => {
    if (!near) await load();
  }, [near, load]);
  const own = !near && week?.key === key ? week : null;
  return {
    /** The week's own plans, or null to use the store's. */
    plans: own?.plans ?? null,
    loading: !near && !!userId && !own,
    error: own?.error ?? '',
    reload,
  };
}
/**
 * Others in the household change the same kitchen, so while it's on screen it's asked for again
 * every 20 seconds, and as the app comes back to the foreground. A kitchen of one changes only
 * when its cook does, and isn't polled.
 */
function useLiveKitchen(shared: boolean, refresh: () => Promise<unknown>) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    if (!shared) return;
    const hidden = () =>
      Platform.OS === 'web' && typeof document !== 'undefined' && document.hidden;
    const tick = () => {
      if (AppState.currentState === 'active' && !hidden()) void latest.current().catch(() => {});
    };
    const timer = setInterval(tick, 20_000);
    const back = AppState.addEventListener('change', (state) => state === 'active' && tick());
    return () => {
      clearInterval(timer);
      back.remove();
    };
  }, [shared]);
}
export function Planner({
  onOpen,
  onAsk,
}: {
  onOpen: (r: Recipe) => void;
  /** Opens the sous-chef's conversation with a message. */
  onAsk: (message: string) => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const { refreshKitchen } = app;
  const { compact } = useChrome();
  const [tab, setTab] = useState<'week' | 'groceries'>('week');
  const [offset, setOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState(localDate(new Date()));
  const [pick, setPick] = useState<{ day: string; meal: string } | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const userId = app.user?.id ?? null;
  const today = localDate(new Date());
  // Weeks start where the cook's calendar does: Sunday in the US, Japan or Brazil, Monday in Europe.
  const firstDay = firstDayOfWeek(locale);
  const days = weekDays(offset, firstDay);
  const from = localDate(days[0]);
  const to = localDate(days[6]);
  const week = useWeekPlans(from, to, today, userId);
  const weekPlans = (week.plans ?? app.kitchen.plans).filter((p) => p.day >= from && p.day <= to);
  const household = useHousehold(userId);
  const shared = household.supported && !!household.household;
  const groceries = app.kitchen.groceries;
  const checked = groceries.filter((g) => g.checked).length;
  // Others add to a shared list too, so opening it shows their latest, and it keeps up.
  useEffect(() => {
    if (tab === 'groceries' && shared) void refreshKitchen().catch(() => {});
  }, [tab, shared, refreshKitchen]);
  useLiveKitchen(shared, () => Promise.all([refreshKitchen(), week.reload()]));
  const moveWeek = (n: number) => {
    setOffset(n);
    const next = weekDays(n, firstDay);
    setSelectedDay(n === 0 ? today : localDate(next[0]));
  };
  const replan = () => Promise.all([refreshKitchen(), week.reload()]);
  const remove = (p: Plan) =>
    void app.act(async () => {
      await api(`/planner/${p.id}`, { method: 'DELETE' });
      await replan();
    });
  // The server puts the whole week on the list at once, folding repeats into matching lines.
  const addAll = async () => {
    if (busy) return;
    setBusy(true);
    await app.act(async () => {
      // What the pantry has, and kitchen basics like salt and oil, stay off the list.
      const result = await api<GroceryMerge>('/planner/groceries', {
        method: 'POST',
        body: { from, to, skipPantry: true },
      });
      await refreshKitchen();
      const skipped = new Set((result?.skipped ?? []).map((n) => n.trim().toLowerCase())).size;
      const said = [
        result?.added > 0 ? tr('weekGroceriesAdded', { count: result.added }) : '',
        result?.merged > 0 ? tr('weekGroceriesMerged', { count: result.merged }) : '',
        skipped > 0 ? tr('weekGroceriesSkipped', { count: skipped }) : '',
      ].filter(Boolean);
      app.notify(said.length ? said.join(' ') : tr('Nothing new to add from this week.'));
    });
    setBusy(false);
  };
  const slots = (day: string) =>
    meals.map((meal) => (
      <MealSlot
        key={meal}
        meal={meal}
        plan={weekPlans.find((p) => p.day === day && p.meal === meal)}
        onOpen={onOpen}
        onAdd={() => {
          setQuery('');
          setPick({ day, meal });
        }}
        onRemove={() => {
          const p = weekPlans.find((x) => x.day === day && x.meal === meal);
          if (p) remove(p);
        }}
      />
    ));
  const tabs = (
    <Segmented
      value={tab}
      onChange={setTab}
      options={[
        { value: 'week', label: tr('Week') },
        {
          value: 'groceries',
          label: tr('{{v0}}{{v1}}', {
            v0: tr('Groceries'),
            v1: groceries.length - checked ? ` · ${groceries.length - checked}` : '',
          }),
        },
      ]}
    />
  );
  return (
    <View style={{ gap: 22 }}>
      {/* Desktops keep the switch beside the title rather than stretched across the page. */}
      <PageHeading
        title={tr('Meal planner')}
        subtitle={tr('A little plan for the week, and a list to match.')}
      >
        {!compact && <View style={{ width: 320 }}>{tabs}</View>}
      </PageHeading>
      {compact && tabs}
      {!app.user ? (
        <SignInKitchen
          title={tr('A little planning goes a long way')}
          text={tr('Sign in to plan your week and keep a grocery list in your pocket.')}
          icon={CalendarDays}
        />
      ) : tab === 'week' ? (
        <>
          <View style={s.between}>
            <IconButton
              icon={ChevronLeft}
              size={40}
              label={tr('Previous week')}
              onPress={() => moveWeek(offset - 1)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tr('Go to this week')}
              onPress={() => moveWeek(0)}
              style={{ alignItems: 'center' }}
            >
              <Text style={s.h3}>
                {days[0].toLocaleDateString(locale, { month: 'short', day: 'numeric' })} –{' '}
                {days[6].toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
              </Text>
              <View style={[s.row, { gap: 6 }]}>
                <Text style={s.small}>
                  {[
                    offset === 0 ? tr('This week') : tr('Tap for this week'),
                    tr('plannedCount', { count: weekPlans.length }),
                  ].join(' · ')}
                </Text>
                {week.loading && (
                  <ActivityIndicator
                    size="small"
                    color={color.muted}
                    accessibilityLabel={tr('Loading…')}
                    style={{ transform: [{ scale: 0.7 }] }}
                  />
                )}
              </View>
            </Pressable>
            <IconButton
              icon={ChevronRight}
              size={40}
              label={tr('Next week')}
              onPress={() => moveWeek(offset + 1)}
            />
          </View>
          {compact ? (
            <>
              <View style={[s.row, { gap: 6 }]}>
                {days.map((d) => {
                  const day = localDate(d);
                  const on = day === selectedDay;
                  const count = weekPlans.filter((p) => p.day === day).length;
                  return (
                    <Pressable
                      key={day}
                      accessibilityRole="button"
                      accessibilityLabel={d.toLocaleDateString(locale, {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                      })}
                      accessibilityState={{ selected: on }}
                      onPress={() => setSelectedDay(day)}
                      style={{
                        flex: 1,
                        minHeight: 72,
                        paddingVertical: 8,
                        borderRadius: radius.pill,
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        backgroundColor: on ? color.ink : color.white,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        maxFontSizeMultiplier={maxFontScale}
                        style={{
                          fontFamily: font.semibold,
                          fontSize: 11,
                          color: on ? color.onInk : color.muted,
                        }}
                      >
                        {d.toLocaleDateString(locale, { weekday: 'short' })}
                      </Text>
                      <Text
                        maxFontSizeMultiplier={maxFontScale}
                        style={{
                          fontFamily: font.bold,
                          fontSize: 17,
                          color: on ? color.white : color.ink,
                        }}
                      >
                        {d.getDate()}
                      </Text>
                      <View style={[s.row, { gap: 2, height: 4 }]}>
                        {Array.from({ length: count }, (_, i) => (
                          <View
                            key={i}
                            style={{
                              width: 4,
                              height: 4,
                              borderRadius: 2,
                              backgroundColor: on ? color.white : color.ink,
                            }}
                          />
                        ))}
                        {!count && day === today && (
                          <View
                            style={{
                              width: 4,
                              height: 4,
                              borderRadius: 2,
                              backgroundColor: on ? color.onInk : color.soft,
                            }}
                          />
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <View style={{ gap: 10 }}>{slots(selectedDay)}</View>
            </>
          ) : (
            <View style={{ gap: 10 }}>
              {days.map((d) => {
                const day = localDate(d);
                return (
                  <View key={day} style={[s.row, { gap: 16, alignItems: 'stretch' }]}>
                    <View
                      style={{
                        width: 92,
                        borderRadius: radius.lg,
                        backgroundColor: day === today ? color.ink : color.white,
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingVertical: 12,
                      }}
                    >
                      <Text
                        style={[
                          s.label,
                          { fontSize: 10, color: day === today ? color.onInk : color.muted },
                        ]}
                      >
                        {d.toLocaleDateString(locale, { weekday: 'short' })}
                      </Text>
                      <Text style={[s.h1, { color: day === today ? color.white : color.ink }]}>
                        {d.getDate()}
                      </Text>
                    </View>
                    <View style={{ flex: 1, flexDirection: 'row', gap: 10 }}>{slots(day)}</View>
                  </View>
                );
              })}
            </View>
          )}
          {!!week.error && (
            <View style={[s.card, s.row, { gap: 12, padding: 14 }]}>
              <Text style={[s.small, { flex: 1, color: color.error, fontFamily: font.medium }]}>
                {tr(week.error)}
              </Text>
              <Button
                small
                variant="secondary"
                title={tr('Try again')}
                onPress={() => void week.reload()}
              />
            </View>
          )}
          <Button
            title={tr('Add this week’s groceries')}
            icon={ShoppingBasket}
            variant="secondary"
            disabled={!weekPlans.length}
            busy={busy}
            onPress={() => void addAll()}
          />
          <AskCard
            title={tr('Plan my week for me')}
            text={tr('Get a balanced week that reuses ingredients and fits your diet.')}
            onPress={() => onAsk(tr('Plan my dinners for this week'))}
          />
        </>
      ) : (
        <View style={{ gap: 16 }}>
          {household.supported && household.ready && (
            <HouseholdEntry household={household.household} onPress={() => setSharing(true)} />
          )}
          <View style={[s.card, { gap: 14 }]}>
            <View style={s.between}>
              <Text style={s.h3}>
                {tr('{{v0}} of {{v1}} in the basket', { v0: checked, v1: groceries.length })}
              </Text>
              {groceries.length > 0 && checked === groceries.length && (
                <Pill title={tr('All done')} tone="success" />
              )}
            </View>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: color.subtle }}>
              <View
                style={{
                  width: `${groceries.length ? (checked / groceries.length) * 100 : 0}%`,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor:
                    groceries.length && checked === groceries.length ? color.success : color.ink,
                }}
              />
            </View>
            <View style={[s.row, { gap: 8 }]}>
              <View style={{ flex: 2 }}>
                <Field
                  value={name}
                  onChangeText={setName}
                  placeholder={tr('Add an item')}
                  style={{ backgroundColor: color.bg, borderColor: color.bg }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  value={quantity}
                  onChangeText={setQuantity}
                  placeholder={tr('Qty')}
                  accessibilityLabel={tr('Quantity')}
                  style={{ backgroundColor: color.bg, borderColor: color.bg }}
                />
              </View>
              <IconButton
                icon={Plus}
                selected
                size={54}
                label={tr('Add to list')}
                disabled={!name.trim()}
                onPress={() =>
                  void app.act(async () => {
                    await api('/groceries', { method: 'POST', body: { name, quantity } });
                    setName('');
                    setQuantity('');
                    await app.refreshKitchen();
                  })
                }
              />
            </View>
          </View>
          {!groceries.length ? (
            <Empty
              title={tr('Your basket is empty')}
              text={tr('Add items above, or send a recipe’s ingredients here in one tap.')}
              icon={ShoppingBasket}
            />
          ) : (
            [...new Set(groceries.map((g) => g.category))].map((cat) => (
              <View key={cat} style={{ gap: 8 }}>
                <Text style={[s.label, { marginLeft: 4 }]}>{tr(cat || 'Other')}</Text>
                <View style={[s.card, { paddingVertical: 2, paddingRight: 8 }]}>
                  {groceries
                    .filter((g) => g.category === cat)
                    .map((g, n) => (
                      <View
                        key={g.id}
                        style={[
                          s.row,
                          n > 0 && {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderColor: color.line,
                          },
                        ]}
                      >
                        <View style={{ flex: 1 }}>
                          <CheckRow checked={g.checked} onPress={() => void app.toggleGrocery(g)}>
                            <View style={[s.between, { gap: 10 }]}>
                              <View style={{ flex: 1, gap: 1 }}>
                                <Text
                                  style={[
                                    s.body,
                                    g.checked && { textDecorationLine: 'line-through' },
                                  ]}
                                >
                                  {g.name}
                                </Text>
                                {/* On a shared list, a quiet note of who added what (not you). */}
                                {shared && !!g.addedBy && g.addedBy.id !== userId && (
                                  <AddedBy name={g.addedBy.name} />
                                )}
                              </View>
                              <Text style={s.small}>{g.quantity}</Text>
                            </View>
                          </CheckRow>
                        </View>
                        <IconButton
                          icon={X}
                          plain
                          size={34}
                          label={tr('Remove {{v0}}', { v0: g.name })}
                          onPress={() =>
                            void app.act(async () => {
                              await api(`/groceries/${g.id}`, { method: 'DELETE' });
                              await app.refreshKitchen();
                            })
                          }
                        />
                      </View>
                    ))}
                </View>
              </View>
            ))
          )}
        </View>
      )}
      <Dialog
        visible={!!pick}
        onClose={() => setPick(null)}
        title={
          pick?.meal === 'Breakfast'
            ? tr('What’s for breakfast?')
            : pick?.meal === 'Lunch'
              ? tr('What’s for lunch?')
              : tr('What’s for dinner?')
        }
        header={
          <View style={{ flexDirection: 'row' }}>
            <SearchBar
              value={query}
              onChangeText={setQuery}
              placeholder={tr('Search your next meal…')}
            />
          </View>
        }
      >
        <View style={[s.card, { paddingVertical: 4 }]}>
          {app.recipes
            .filter((r) => r.title.toLowerCase().includes(query.toLowerCase()))
            .map((r, n) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('Plan {{v0}}', { v0: r.title })}
                key={r.id}
                onPress={() =>
                  void app.act(async () => {
                    await api('/planner', {
                      method: 'POST',
                      body: { ...pick, recipeId: r.id, servings: r.servings },
                    });
                    await replan();
                    setPick(null);
                  }, 'Added to your week.')
                }
                style={[
                  s.row,
                  { gap: 12, paddingVertical: 10 },
                  n > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
                ]}
              >
                <FoodImage uri={r.image} style={{ width: 52, height: 52, borderRadius: 16 }} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={[s.h3, { fontSize: 15 }]}>
                    {r.title}
                  </Text>
                  <Text style={s.small}>
                    {[
                      tr('minuteCount', { count: r.minutes }),
                      tr('servingCount', { count: r.servings }),
                    ].join(' · ')}
                  </Text>
                </View>
                <Plus size={18} color={color.ink} />
              </Pressable>
            ))}
        </View>
      </Dialog>
      <HouseholdSheet visible={sharing} onClose={() => setSharing(false)} state={household} />
    </View>
  );
}
/**
 * The recipes the pantry goes furthest toward (GET /kitchen/pantry-recipes), read by what each
 * ingredient is rather than its spelling, asked again whenever the pantry changes. Older servers
 * have no such route, and the section stays empty.
 */
function usePantryMatches() {
  const app = useApp();
  const pantryKey = app.kitchen.pantry.map((p) => `${p.name}:${p.expiresOn ?? ''}`).join('\n');
  // Allergies and diets change what fits, so a profile change asks again too.
  const asking =
    app.user && pantryKey
      ? `${app.user.id}\n${JSON.stringify(app.user.avoid ?? null)}\n${pantryKey}`
      : '';
  // Matches are kept with what they were asked for, so a stale answer never shows.
  const [answer, setAnswer] = useState<{ asking: string; matches: PantryMatch[] }>();
  useEffect(() => {
    if (!asking) return;
    let current = true;
    api<{ matches: PantryMatch[] }>('/kitchen/pantry-recipes?limit=6')
      .then(
        (r) =>
          current && setAnswer({ asking, matches: Array.isArray(r?.matches) ? r.matches : [] }),
      )
      .catch(() => current && setAnswer({ asking, matches: [] }));
    return () => {
      current = false;
    };
  }, [asking]);
  return asking && answer?.asking === asking ? answer.matches : [];
}
function PantryMatchRow({ match, onOpen }: { match: PantryMatch; onOpen: (r: Recipe) => void }) {
  const { t: tr, language } = useI18n();
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const { recipe, missing, expiring } = match;
  return (
    <View style={{ gap: 8 }}>
      <RecipeRow recipe={recipe} onOpen={onOpen} />
      <View style={[s.row, { gap: 8, flexWrap: 'wrap', paddingHorizontal: 6 }]}>
        <Text style={[s.small, { flexShrink: 1 }]}>
          {missing.length
            ? tr('Missing: {{v0}}', { v0: joinNames(missing, language) })
            : tr('You have everything for this.')}
        </Text>
        {expiring.length > 0 && (
          <Pill
            title={tr('Uses {{v0}}', { v0: joinNames(expiring, language) })}
            icon={Leaf}
            tone="warning"
          />
        )}
        {missing.length > 0 && (
          <Button
            small
            variant="secondary"
            icon={ShoppingBasket}
            title={tr('Add what’s missing')}
            busy={busy}
            onPress={() => {
              if (busy) return;
              setBusy(true);
              void app
                .act(async () => {
                  await api<GroceryMerge>(`/recipes/${recipe.id}/groceries`, {
                    method: 'POST',
                    body: { servings: recipe.servings, skipPantry: true },
                  });
                  await app.refreshKitchen();
                }, 'Added what’s missing to your grocery list.')
                .finally(() => setBusy(false));
            }}
          />
        )}
      </View>
    </View>
  );
}
export function Pantry({
  onOpen,
  onAsk,
}: {
  onOpen: (r: Recipe) => void;
  /** Opens the sous-chef's conversation with a message. */
  onAsk: (message: string) => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const { desktop } = useChrome();
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [expires, setExpires] = useState('');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Days left until a best-before date (negative once it has passed), compared as calendar days.
  const daysLeft = (day: string | null) => {
    const date = parseDay(day);
    return date ? daysBetween(now, date) : null;
  };
  const matching = usePantryMatches();
  // A household shares the pantry: it says who added what, and keeps up with the others.
  const household = useHousehold(app.user?.id ?? null);
  const shared = household.supported && !!household.household;
  const [sharing, setSharing] = useState(false);
  useLiveKitchen(shared, app.refreshKitchen);
  const ask = (
    <AskCard
      title={tr('What can I make with this?')}
      text={tr('The sous-chef builds a recipe around your pantry, using what expires first.')}
      onPress={() => onAsk(tr('What can I make with my pantry?'))}
    />
  );
  const add = (
    <View style={[s.card, { gap: 12 }]}>
      <Text style={s.h3}>{tr('Add an ingredient')}</Text>
      <View style={{ gap: 8 }}>
        <Field
          placeholder={tr('Chickpeas, lemons, rice…')}
          accessibilityLabel={tr('Ingredient')}
          value={name}
          onChangeText={setName}
          style={{ backgroundColor: color.bg, borderColor: color.bg }}
        />
        <View style={[s.row, { gap: 8 }]}>
          <View style={{ flex: 1 }}>
            <Field
              placeholder={tr('Quantity')}
              value={quantity}
              onChangeText={setQuantity}
              style={{ backgroundColor: color.bg, borderColor: color.bg }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DatePicker
              label={tr('Best before')}
              value={expires}
              onChange={setExpires}
              style={{ backgroundColor: color.bg, borderColor: color.bg }}
            />
          </View>
        </View>
      </View>
      <Button
        title={tr('Add to pantry')}
        icon={Plus}
        disabled={!name.trim()}
        onPress={() =>
          void app.act(async () => {
            await api('/pantry', {
              method: 'POST',
              body: { name, quantity, expiresOn: expires || null },
            });
            setName('');
            setQuantity('');
            setExpires('');
            await app.refreshKitchen();
          }, 'Added to your pantry.')
        }
      />
    </View>
  );
  const entry = household.supported && household.ready && (
    <HouseholdEntry household={household.household} onPress={() => setSharing(true)} />
  );
  const stock = (
    <>
      {app.kitchen.pantry.length ? (
        <View style={[s.card, { paddingVertical: 4, paddingRight: 8 }]}>
          {app.kitchen.pantry.map((p, n) => {
            const left = daysLeft(p.expiresOn);
            const expired = left !== null && left < 0;
            const soon = left !== null && left >= 0 && left <= 3;
            return (
              <View
                key={p.id}
                style={[
                  s.row,
                  { gap: 12, paddingVertical: 12 },
                  n > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderColor: color.line,
                  },
                ]}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: color.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Leaf size={17} color={color.ink} strokeWidth={1.8} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[s.h3, { textTransform: 'capitalize', fontSize: 15 }]}>
                    {p.name}
                  </Text>
                  <Text style={s.small}>
                    {p.quantity || tr('In the pantry')}
                    {left !== null && !soon && !expired
                      ? tr(' · best before {{v0}}', { v0: formatDay(p.expiresOn, locale) })
                      : ''}
                  </Text>
                  {p.addedBy && p.addedBy.id !== app.user?.id && <AddedBy name={p.addedBy.name} />}
                </View>
                {expired ? (
                  <Pill title={tr('Expired')} tone="error" />
                ) : soon ? (
                  <Pill title={tr('Use soon')} tone="warning" />
                ) : null}
                <IconButton
                  icon={X}
                  plain
                  size={34}
                  label={tr('Remove {{v0}}', { v0: p.name })}
                  onPress={() =>
                    void app.act(async () => {
                      await api(`/pantry/${p.id}`, { method: 'DELETE' });
                      await app.refreshKitchen();
                    })
                  }
                />
              </View>
            );
          })}
        </View>
      ) : (
        <Empty
          title={tr('Let’s look in the fridge')}
          text={tr('Add a few ingredients and we’ll find recipes you can already make.')}
          icon={Leaf}
        />
      )}
      {matching.length > 0 && (
        <View style={{ gap: 12 }}>
          <SectionTitle
            title={tr('You’re partway there')}
            subtitle={tr('Recipes your pantry goes furthest toward, using what expires first.')}
          />
          {matching.map((m) => (
            <PantryMatchRow key={m.recipe.id} match={m} onOpen={onOpen} />
          ))}
        </View>
      )}
    </>
  );
  return (
    <View style={{ gap: 22 }}>
      <PageHeading
        title={tr('Pantry')}
        subtitle={tr('Start with what you have. Waste a little less.')}
      />
      {!app.user ? (
        <SignInKitchen
          title={tr('Your pantry, full of possibilities')}
          text={tr('Sign in to track ingredients and find recipes that use what you already have.')}
          icon={Leaf}
        />
      ) : desktop ? (
        // Adding on the left, what you have and what it makes on the right.
        <View style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start' }}>
          <View style={{ width: 380, gap: 16 }}>
            {ask}
            {add}
            {entry}
          </View>
          <View style={{ flex: 1, gap: 22 }}>{stock}</View>
        </View>
      ) : (
        <>
          {ask}
          {add}
          {entry}
          {stock}
        </>
      )}
      <HouseholdSheet visible={sharing} onClose={() => setSharing(false)} state={household} />
    </View>
  );
}
