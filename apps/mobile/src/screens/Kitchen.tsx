import { useI18n } from '../lib/i18n';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Leaf,
  Plus,
  ShoppingBasket,
  Trash2,
  X,
} from 'lucide-react-native';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import { AIRequest, Plan, Recipe, Screen } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
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
import { RecipeGrid } from '../components/RecipeCard';
import { AskCard } from '../components/SousChef';
import { localDate, weekDays } from '../lib/utils';
import { foodIcon } from '../lib/icons';
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
  const selected = app.library.collections.find((c) => c.id === active);
  const recipes = app.library.recipes.filter((r) =>
    active === 'mine'
      ? r.author.id === app.user?.id
      : active === 'all'
        ? app.library.savedIds.includes(r.id)
        : app.library.saves.some((v) => v.recipeId === r.id && v.collectionId === active),
  );
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
                active={active === c.id}
                onPress={() => setActive(c.id)}
              />
            ))}
          </ScrollView>
          {selected && (
            <View style={s.between}>
              <Text style={s.h2}>{selected.name}</Text>
              <IconButton
                icon={Trash2}
                size={38}
                label={tr('Delete cookbook')}
                onPress={() => setRemove(true)}
              />
            </View>
          )}
          {recipes.length ? (
            <RecipeGrid recipes={recipes} onOpen={onOpen} />
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
              await app.refreshPrivate();
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
              await app.refreshPrivate();
              setActive('all');
              setRemove(false);
            }, 'Cookbook removed. Your recipes are still saved.')
          }
        />
      </Dialog>
    </View>
  );
}
export function DangerButton({
  title,
  onPress,
  busy,
  disabled,
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        minHeight: 52,
        borderRadius: radius.pill,
        backgroundColor: color.error,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled || busy ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: font.bold, fontSize: 15, color: color.white }}>{title}</Text>
    </Pressable>
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
  const { t: tr } = useI18n();
  return plan ? (
    <View style={[s.card, s.row, { padding: 10, gap: 12, flex: 1 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('View {{v0}}', { v0: plan.recipe.title })}
        onPress={() => onOpen(plan.recipe)}
        style={[s.row, { gap: 12, flex: 1 }]}
      >
        <FoodImage uri={plan.recipe.image} style={{ width: 56, height: 56, borderRadius: 18 }} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[s.label, { fontSize: 10 }]}>{tr(meal)}</Text>
          <Text numberOfLines={1} style={[s.h3, { fontSize: 15 }]}>
            {plan.recipe.title}
          </Text>
          <Text style={s.small}>{tr('{{v0}} servings', { v0: plan.servings })}</Text>
        </View>
      </Pressable>
      <IconButton
        icon={X}
        plain
        size={34}
        label={tr('Remove {{v0}} on {{v1}}', { v0: tr(meal), v1: plan.day })}
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
export function Planner({
  onOpen,
  onAI,
}: {
  onOpen: (r: Recipe) => void;
  onAI: (r: AIRequest) => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const { compact } = useChrome();
  const [tab, setTab] = useState<'week' | 'groceries'>('week');
  const [offset, setOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState(localDate(new Date()));
  const [pick, setPick] = useState<{ day: string; meal: string } | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const today = localDate(new Date());
  const days = weekDays(offset);
  const weekPlans = app.kitchen.plans.filter((p) => days.some((d) => localDate(d) === p.day));
  const groceries = app.kitchen.groceries;
  const checked = groceries.filter((g) => g.checked).length;
  const moveWeek = (n: number) => {
    setOffset(n);
    const next = weekDays(n);
    setSelectedDay(n === 0 ? today : localDate(next[0]));
  };
  const remove = (p: Plan) =>
    void app.act(async () => {
      await api(`/planner/${p.id}`, { method: 'DELETE' });
      await app.refreshPrivate();
    });
  const addAll = async () => {
    if (busy) return;
    setBusy(true);
    await app.act(async () => {
      for (const p of weekPlans)
        await api(`/recipes/${p.recipeId}/groceries`, {
          method: 'POST',
          body: { servings: p.servings },
        });
      await app.refreshPrivate();
    }, 'Your week’s ingredients are on the list.');
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
              <Text style={s.small}>
                {tr('{{v0}} · {{v1}} planned', {
                  v0: offset === 0 ? tr('This week') : tr('Tap for this week'),
                  v1: weekPlans.length,
                })}
              </Text>
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
                        height: 72,
                        borderRadius: radius.pill,
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        backgroundColor: on ? color.ink : color.white,
                      }}
                    >
                      <Text
                        style={{
                          fontFamily: font.semibold,
                          fontSize: 11,
                          color: on ? color.onInk : color.muted,
                        }}
                      >
                        {d.toLocaleDateString(locale, { weekday: 'short' })}
                      </Text>
                      <Text
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
          <Button
            title={tr('Add this week to my grocery list')}
            icon={ShoppingBasket}
            variant="secondary"
            disabled={!weekPlans.length}
            busy={busy}
            onPress={() => void addAll()}
          />
          <AskCard
            title={tr('Plan my week for me')}
            text={tr('Get a balanced week that reuses ingredients and fits your diet.')}
            onPress={() =>
              onAI({
                kind: 'plan',
                title: tr('Plan a lovely week'),
                context: app.kitchen.pantry.length
                  ? `Use these pantry ingredients where possible: ${app.kitchen.pantry.map((p) => p.name).join(', ')}`
                  : undefined,
                suggestions: [
                  tr('Five easy dinners for two'),
                  tr('A vegetarian week'),
                  tr('Family favorites on a budget'),
                  tr('High-protein lunches to meal prep'),
                ],
              })
            }
          />
        </>
      ) : (
        <View style={{ gap: 16 }}>
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
                    await app.refreshPrivate();
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
                          <CheckRow
                            checked={g.checked}
                            onPress={() =>
                              void app.act(async () => {
                                await api(`/groceries/${g.id}`, {
                                  method: 'PATCH',
                                  body: { checked: !g.checked },
                                });
                                await app.refreshPrivate();
                              })
                            }
                          >
                            <View style={[s.between, { gap: 10 }]}>
                              <Text
                                style={[
                                  s.body,
                                  { flex: 1 },
                                  g.checked && { textDecorationLine: 'line-through' },
                                ]}
                              >
                                {g.name}
                              </Text>
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
                              await app.refreshPrivate();
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
        title={tr('What’s for {{v0}}?', { v0: tr(pick?.meal || '').toLowerCase() })}
      >
        <View style={{ flexDirection: 'row' }}>
          <SearchBar
            value={query}
            onChangeText={setQuery}
            placeholder={tr('Search your next meal…')}
          />
        </View>
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
                    await app.refreshPrivate();
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
                    {tr('{{v0}} min · {{v1}} servings', { v0: r.minutes, v1: r.servings })}
                  </Text>
                </View>
                <Plus size={18} color={color.ink} />
              </Pressable>
            ))}
        </View>
      </Dialog>
    </View>
  );
}
export function Pantry({
  onOpen,
  onAI,
}: {
  onOpen: (r: Recipe) => void;
  onAI: (r: AIRequest) => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const { desktop } = useChrome();
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [expires, setExpires] = useState('');
  const today = localDate(new Date());
  const soonDate = localDate(new Date(Date.now() + 3 * 86400000));
  const matching = useMemo(
    () =>
      app.recipes
        .map((r) => ({
          recipe: r,
          count: r.ingredients.filter((i) =>
            app.kitchen.pantry.some(
              (p) =>
                i.name.toLowerCase().includes(p.name.toLowerCase()) ||
                p.name.toLowerCase().includes(i.name.toLowerCase()),
            ),
          ).length,
        }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
    [app.recipes, app.kitchen.pantry],
  );
  const pantryList = app.kitchen.pantry
    .map(
      (p) =>
        `${p.name}${p.quantity ? ` (${p.quantity})` : ''}${p.expiresOn ? `, best before ${p.expiresOn}` : ''}`,
    )
    .join('; ');
  const ask = (
    <AskCard
      title={tr('What can I make with this?')}
      text={tr('The sous-chef builds a recipe around your pantry, using what expires first.')}
      onPress={() =>
        onAI({
          kind: 'recipe',
          title: tr('Cook from your pantry'),
          context: pantryList ? `My pantry: ${pantryList}` : 'My pantry is nearly empty.',
          suggestions: [
            tr('Something quick, under 30 minutes'),
            tr('Something cozy and comforting'),
            tr('Use what expires soonest'),
          ],
        })
      }
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
          <Field
            placeholder={tr('Quantity')}
            value={quantity}
            onChangeText={setQuantity}
            style={{ backgroundColor: color.bg, borderColor: color.bg }}
          />
          <Field
            placeholder={tr('Best before')}
            accessibilityLabel={tr('Best before (YYYY-MM-DD)')}
            value={expires}
            onChangeText={setExpires}
            style={{ backgroundColor: color.bg, borderColor: color.bg }}
          />
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
            await app.refreshPrivate();
          }, 'Added to your pantry.')
        }
      />
    </View>
  );
  const stock = (
    <>
      {app.kitchen.pantry.length ? (
        <View style={[s.card, { paddingVertical: 4, paddingRight: 8 }]}>
          {app.kitchen.pantry.map((p, n) => {
            const expired = !!p.expiresOn && p.expiresOn < today;
            const soon = !!p.expiresOn && !expired && p.expiresOn <= soonDate;
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
                    {p.expiresOn && !soon && !expired
                      ? tr(' · best before {{v0}}', {
                          v0: new Date(`${p.expiresOn}T12:00:00`).toLocaleDateString(locale),
                        })
                      : ''}
                  </Text>
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
                      await app.refreshPrivate();
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
        <View>
          <SectionTitle
            title={tr('You’re partway there')}
            subtitle={tr('Recipes that use what you have.')}
          />
          <RecipeGrid recipes={matching.map((m) => m.recipe)} onOpen={onOpen} />
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
          </View>
          <View style={{ flex: 1, gap: 22 }}>{stock}</View>
        </View>
      ) : (
        <>
          {ask}
          {add}
          {stock}
        </>
      )}
    </View>
  );
}
