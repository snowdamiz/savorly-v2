import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChefHat, Minus, Pencil, Plus, SlidersHorizontal } from './icons';
import { spokenList } from '../lib/handsFree/ingredients';
import {
  cookMeal,
  defaultEatAt,
  dishColor,
  keepKitchen,
  kitchenLimits,
  planMeal,
  savedKitchen,
  type MealKitchen,
  type MealTimeline,
  type TimelineWarning,
} from '../lib/mealTimeline';
import { useApp } from '../lib/store';
import type { Recipe } from '../lib/types';
import { color, font, s } from '../lib/theme';
import { Button, Dialog, IconButton, SearchBar } from './ui';

type Translate = ReturnType<typeof useI18n>['t'];

/** "6:05 PM": a plan's time on the cook's clock. */
export function clockTime(at: string | number, locale: string) {
  return new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Oven heats in the cook's units: Fahrenheit where they read imperial amounts or live in the US, to
 * the nearest 25 °F as ovens are set there.
 */
export function useHeat() {
  const app = useApp();
  const { t: tr, locale } = useI18n();
  const units = app.user?.preferences?.units;
  const fahrenheit = units === 'imperial' || (!units && /-US$/.test(locale));
  return (celsius: number) =>
    fahrenheit
      ? tr('{{v0}} °F', { v0: Math.round(((celsius * 9) / 5 + 32) / 25) * 25 })
      : tr('{{v0}} °C', { v0: celsius });
}

/** A dish's colour, as a small dot. */
export function DishDot({ index, size = 8 }: { index: number; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: dishColor(index),
      }}
    />
  );
}

/** What a warning says, as one quiet line. */
export function warningText(
  tr: Translate,
  w: TimelineWarning,
  plan: MealTimeline,
  locale: string,
  heat: (celsius: number) => string,
) {
  const names = w.recipeIds.map((id) => plan.dishes.find((d) => d.recipeId === id)?.title ?? '');
  const time = clockTime(w.at, locale);
  if (w.kind === 'oven')
    return tr('{{dishes}} need the oven at once, at {{heats}}.', {
      dishes: spokenList(names, locale),
      heats: spokenList((w.heats ?? []).map(heat), locale),
    });
  if (w.kind === 'burners')
    return tr('burnersAtOnce', { count: w.needed ?? 0, have: w.have ?? 0, time });
  return tr('waitsAfterBusy', { count: w.minutes ?? 0, dish: names[0] ?? '', time });
}

/** The plan as one list: each step at its time, marked by its dish, and the free time between. */
export function TimelineList({ plan }: { plan: MealTimeline }) {
  const { t: tr, locale } = useI18n();
  const heat = useHeat();
  const dishOf = (id: string) => plan.dishes.findIndex((d) => d.recipeId === id);
  const rows = [
    ...plan.steps.map((step) => ({ at: Date.parse(step.startAt), step, free: null })),
    ...plan.free.map((free) => ({ at: Date.parse(free.startAt) + 1, step: null, free })),
  ].sort((a, b) => a.at - b.at);
  return (
    <View>
      {rows.map(({ step, free }, n) => {
        if (free) {
          const minutes = Math.round((Date.parse(free.endAt) - Date.parse(free.startAt)) / 60_000);
          return (
            <Text key={`free:${n}`} style={[s.small, styles.free]}>
              {tr('freeMinutes', { count: minutes })}
            </Text>
          );
        }
        if (!step) return null;
        const dish = dishOf(step.recipeId);
        const title = step.preheat
          ? tr('Preheat the oven to {{v0}}', { v0: heat(step.oven) })
          : step.title;
        // A step that waits shows how long it takes in all.
        const lasts =
          step.wait >= 300 && !step.preheat
            ? Math.round((Date.parse(step.endAt) - Date.parse(step.startAt)) / 60_000)
            : 0;
        return (
          <View key={`${step.recipeId}:${step.step}`} style={[s.row, styles.row]}>
            <Text style={[s.small, styles.time]}>{clockTime(step.startAt, locale)}</Text>
            <DishDot index={dish} />
            <Text style={[s.body, { flex: 1 }]}>
              {tr('{{dish}}: {{step}}', { dish: plan.dishes[dish]?.title ?? '', step: title })}
              {lasts > 0 && (
                <Text style={s.muted}>{` · ${tr('minuteCount', { count: lasts })}`}</Text>
              )}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** One number the kitchen has, with a step down and up. */
function Stepper({
  label,
  fewer,
  more,
  value,
  range: [low, high],
  onChange,
}: {
  label: string;
  fewer: string;
  more: string;
  value: number;
  range: readonly [number, number];
  onChange: (value: number) => void;
}) {
  return (
    <View style={[s.row, { gap: 8 }]}>
      <IconButton
        icon={Minus}
        size={34}
        label={fewer}
        disabled={value <= low}
        onPress={() => onChange(value - 1)}
      />
      <Text style={[s.h3, { minWidth: 18, textAlign: 'center' }]}>{value}</Text>
      <IconButton
        icon={Plus}
        size={34}
        label={more}
        disabled={value >= high}
        onPress={() => onChange(value + 1)}
      />
      <Text style={s.small}>{label}</Text>
    </View>
  );
}

const QUARTER = 15 * 60_000;

/**
 * "Cook together": two to four recipes and a time to eat, planned into one timeline so everything
 * is ready together (docs/MEAL-TIMELINE.md), then cooked in one cooking mode. With fewer than two
 * chosen it opens on the choice; otherwise on the plan.
 */
export function CookTogether({
  visible,
  onClose,
  recipes,
  chosen,
  day = null,
  meals = [],
}: {
  visible: boolean;
  onClose: () => void;
  /** What to choose from: a day's meals, or saved recipes. */
  recipes: Recipe[];
  /** Those chosen to start with. */
  chosen?: string[];
  /** The planner's day (YYYY-MM-DD) and its meals, for when to eat; today's dinner otherwise. */
  day?: string | null;
  meals?: string[];
}) {
  const { t: tr, locale } = useI18n();
  const heat = useHeat();
  const [opened, setOpened] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [stage, setStage] = useState<'pick' | 'plan'>('pick');
  const [eatAt, setEatAt] = useState(() => defaultEatAt(day, meals).getTime());
  const [kitchen, setKitchen] = useState<MealKitchen | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [query, setQuery] = useState('');
  // Each opening starts afresh from what it's given.
  if (visible !== opened) {
    setOpened(visible);
    if (visible) {
      const start = [...new Set(chosen ?? [])]
        .filter((id) => recipes.some((r) => r.id === id))
        .slice(0, 4);
      setPicked(start);
      setStage(start.length >= 2 ? 'plan' : 'pick');
      setEatAt(defaultEatAt(day, meals).getTime());
      setAdjusting(false);
      setQuery('');
    }
  }
  useEffect(() => {
    if (!visible) return;
    let live = true;
    void savedKitchen().then((saved) => live && setKitchen(saved));
    return () => {
      live = false;
    };
  }, [visible]);
  // The plan for what's chosen, asked for again as any of it changes.
  const key = JSON.stringify([picked, eatAt, kitchen]);
  const [answer, setAnswer] = useState<{
    key: string;
    plan: MealTimeline | null;
    error: string;
    /** When it came, to tell whether it would have started already. */
    at: number;
  } | null>(null);
  useEffect(() => {
    if (!visible || stage !== 'plan' || !kitchen || picked.length < 2) return;
    const controller = new AbortController();
    const id = setTimeout(() => {
      planMeal(picked, new Date(eatAt), kitchen, controller.signal).then(
        (plan) => setAnswer({ key, plan, error: '', at: Date.now() }),
        (e: Error) =>
          !controller.signal.aborted &&
          setAnswer({ key, plan: null, error: e.message, at: Date.now() }),
      );
    }, 250);
    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [visible, stage, key, picked, eatAt, kitchen]);
  const current = answer?.key === key ? answer : null;
  // The last plan stays on screen while the next one loads, so the list doesn't jump.
  const plan = current?.plan ?? (answer?.plan && !current ? answer.plan : null);
  const chosenRecipes = picked
    .map((id) => recipes.find((r) => r.id === id))
    .filter((r): r is Recipe => !!r);
  const choose = (kitchenNext: MealKitchen) => {
    setKitchen(kitchenNext);
    keepKitchen(kitchenNext);
  };
  const eat = new Date(eatAt);
  const today = new Date().toDateString() === eat.toDateString();
  const eatLabel = today
    ? clockTime(eatAt, locale)
    : `${eat.toLocaleDateString(locale, { weekday: 'short' })} ${clockTime(eatAt, locale)}`;
  const asked = answer?.at ?? 0;
  const late = plan && Date.parse(plan.startAt) < asked - 60_000;
  const lateBy = plan ? asked - Date.parse(plan.startAt) : 0;
  const onTime = eatAt + Math.ceil(lateBy / (5 * 60_000)) * 5 * 60_000;
  const shown = recipes.filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={tr('Cook together')}
      header={
        stage === 'pick' && recipes.length > 8 ? (
          <View style={{ flexDirection: 'row' }}>
            <SearchBar value={query} onChangeText={setQuery} placeholder={tr('Search recipes')} />
          </View>
        ) : undefined
      }
      footer={
        stage === 'pick' ? (
          <Button
            title={tr('Plan the timing')}
            disabled={picked.length < 2}
            onPress={() => setStage('plan')}
          />
        ) : (
          <Button
            title={tr('Start cooking')}
            icon={ChefHat}
            large
            disabled={!plan || !current}
            onPress={() => {
              if (!plan) return;
              cookMeal({ plan, recipes: chosenRecipes });
              onClose();
            }}
          />
        )
      }
    >
      {stage === 'pick' ? (
        <View style={{ gap: 4 }}>
          <Text style={s.muted}>
            {tr('Choose 2 to 4 recipes, and Savorly times them to be ready together.')}
          </Text>
          <View style={[s.card, { paddingVertical: 2 }]}>
            {shown.map((r, n) => {
              const on = picked.includes(r.id);
              return (
                <View
                  key={r.id}
                  style={
                    n > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line }
                  }
                >
                  <Pressable
                    accessibilityRole="checkbox"
                    aria-checked={on}
                    accessibilityState={{ checked: on, disabled: !on && picked.length >= 4 }}
                    onPress={() =>
                      setPicked(
                        on
                          ? picked.filter((id) => id !== r.id)
                          : picked.length < 4
                            ? [...picked, r.id]
                            : picked,
                      )
                    }
                    style={[s.row, { gap: 14, paddingVertical: 13 }]}
                  >
                    <View style={[styles.tick, on && styles.ticked]}>
                      {on && <Check size={14} color={color.white} strokeWidth={3} />}
                    </View>
                    <View style={{ flex: 1, gap: 1 }}>
                      <Text numberOfLines={1} style={s.h3}>
                        {r.title}
                      </Text>
                      <Text style={s.small}>{tr('minuteCount', { count: r.minutes })}</Text>
                    </View>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={{ gap: 18 }}>
          <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
            {chosenRecipes.map((r, i) => (
              <View key={r.id} style={[s.row, { gap: 6, marginRight: 6 }]}>
                {/* The plan's colour for the dish, the same as its steps'. */}
                <DishDot index={plan ? plan.dishes.findIndex((d) => d.recipeId === r.id) : i} />
                <Text style={[s.small, { color: color.ink }]}>{r.title}</Text>
              </View>
            ))}
            <IconButton
              icon={Pencil}
              plain
              size={32}
              label={tr('Change the recipes')}
              onPress={() => setStage('pick')}
            />
          </View>
          <View style={[s.between, { gap: 12 }]}>
            <View style={{ gap: 2 }}>
              <Text style={s.label}>{tr('Eat at')}</Text>
              <Text style={[s.h1, { fontVariant: ['tabular-nums'] }]}>{eatLabel}</Text>
            </View>
            <View style={[s.row, { gap: 8 }]}>
              <IconButton
                icon={Minus}
                label={tr('15 minutes earlier')}
                onPress={() => setEatAt(eatAt - QUARTER)}
              />
              <IconButton
                icon={Plus}
                label={tr('15 minutes later')}
                onPress={() => setEatAt(eatAt + QUARTER)}
              />
            </View>
          </View>
          {plan ? (
            <View style={{ gap: 10 }}>
              {late && (
                <View style={[s.row, { gap: 6, flexWrap: 'wrap' }]}>
                  <Text style={s.small}>
                    {tr('It would have started at {{v0}}.', {
                      v0: clockTime(plan.startAt, locale),
                    })}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => setEatAt(onTime)}
                  >
                    <Text style={[s.small, { color: color.ink, textDecorationLine: 'underline' }]}>
                      {tr('Eat at {{v0}}', { v0: clockTime(onTime, locale) })}
                    </Text>
                  </Pressable>
                </View>
              )}
              {plan.warnings.map((w, n) => (
                <Text key={n} style={[s.small, { color: color.warning }]}>
                  {warningText(tr, w, plan, locale, heat)}
                </Text>
              ))}
              <View style={{ opacity: current ? 1 : 0.5 }}>
                <TimelineList plan={plan} />
              </View>
              {plan.steps.some((step) => step.estimated) && (
                <Text style={s.small}>{tr('Some times are estimates.')}</Text>
              )}
            </View>
          ) : answer?.error && current ? (
            <Text style={[s.small, { color: color.error }]}>{tr(answer.error)}</Text>
          ) : (
            <ActivityIndicator color={color.ink} accessibilityLabel={tr('Loading…')} />
          )}
          {kitchen && (
            <View style={{ gap: 10 }}>
              <View style={[s.row, { gap: 4 }]}>
                <Text style={[s.small, { flex: 1 }]}>
                  {`${tr('burnerCount', { count: kitchen.burners })} · ${tr('ovenCount', { count: kitchen.ovens })}`}
                </Text>
                <IconButton
                  icon={SlidersHorizontal}
                  plain
                  size={32}
                  label={tr('Change your kitchen')}
                  onPress={() => setAdjusting(!adjusting)}
                />
              </View>
              {adjusting && (
                <View style={[s.row, { gap: 22, flexWrap: 'wrap' }]}>
                  <Stepper
                    label={tr('Burners')}
                    fewer={tr('Fewer burners')}
                    more={tr('More burners')}
                    value={kitchen.burners}
                    range={kitchenLimits.burners}
                    onChange={(burners) => choose({ ...kitchen, burners })}
                  />
                  <Stepper
                    label={tr('Ovens')}
                    fewer={tr('Fewer ovens')}
                    more={tr('More ovens')}
                    value={kitchen.ovens}
                    range={kitchenLimits.ovens}
                    onChange={(ovens) => choose({ ...kitchen, ovens })}
                  />
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  tick: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ticked: { backgroundColor: color.ink, borderColor: color.ink },
  row: { gap: 10, paddingVertical: 7, alignItems: 'baseline' },
  time: { width: 66, fontVariant: ['tabular-nums'], color: color.ink, fontFamily: font.semibold },
  free: { paddingLeft: 84, paddingVertical: 5 },
});
