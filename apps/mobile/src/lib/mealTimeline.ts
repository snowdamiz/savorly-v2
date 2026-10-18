import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import { useApp } from './store';
import type { Recipe } from './types';

// The whole-meal timeline (docs/MEAL-TIMELINE.md): two to four recipes and a time to eat, planned
// by the server into one list of timed steps (POST /meals/timeline), then cooked together in one
// cooking mode with a timer per dish, each dish recorded as its own cook session.

/** What the kitchen has: burners on the hob and ovens. */
export type MealKitchen = { burners: number; ovens: number };
export const defaultKitchen: MealKitchen = { burners: 4, ovens: 1 };
export const kitchenLimits = { burners: [1, 12], ovens: [1, 3] } as const;

/** A step of the plan, at its time. Seconds are whole minutes; `oven` is °C, 0 for none. */
export type TimelineStep = {
  recipeId: string;
  /** 1-based, as in the recipe. */
  step: number;
  title: string;
  startAt: string;
  endAt: string;
  active: number;
  wait: number;
  oven: number;
  burners: number;
  /** Heats the oven ahead of a step that needs it. */
  preheat: boolean;
  /** Its times are an estimate, or what 5 or more cooks measured. */
  estimated: boolean;
  tested: boolean;
};
export type TimelineDish = {
  recipeId: string;
  title: string;
  image: string;
  startAt: string;
  readyAt: string;
  estimated: boolean;
  tested: boolean;
};
/** What the kitchen can't do: two oven heats at once, more burners than it has, too much at once. */
export type TimelineWarning = {
  kind: 'oven' | 'burners' | 'hands';
  at: string;
  recipeIds: string[];
  heats?: number[];
  needed?: number;
  have?: number;
  minutes?: number;
};
export type MealTimeline = {
  eatAt: string;
  startAt: string;
  kitchen: MealKitchen;
  dishes: TimelineDish[];
  steps: TimelineStep[];
  free: { startAt: string; endAt: string }[];
  warnings: TimelineWarning[];
};

/** The colours that tell the dishes apart, as small dots, in the plan's order. */
export const dishColors = ['#C2703D', '#4F8A5B', '#4A6FA5', '#9A5BB0'];
export const dishColor = (index: number) => dishColors[index % dishColors.length];

const pad = (n: number) => String(n).padStart(2, '0');
/** A time as the cook's clock shows it ("2026-10-17T19:30"), the eating time the API reads. */
export function localTime(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** The cook's time zone, which the plan's times come back in. */
export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Asks the server for the plan that has `recipes` ready together at `eatAt`. */
export function planMeal(
  recipes: string[],
  eatAt: Date,
  kitchen: MealKitchen,
  signal?: AbortSignal,
) {
  return api<MealTimeline>('/meals/timeline', {
    method: 'POST',
    body: { recipes, eatAt: localTime(eatAt), timeZone: timeZone(), kitchen },
    signal,
  });
}

const QUARTER = 15 * 60_000;
/**
 * When a meal is eaten unless the cook says: on `day` (YYYY-MM-DD, today when null) at the usual
 * hour of the latest of its `meals` (dinner when none), or, when that's too soon to cook, an hour
 * and a half from now, on a quarter hour.
 */
export function defaultEatAt(day: string | null, meals: string[], now = new Date()) {
  const [hour, minute] = meals.includes('Dinner')
    ? [19, 0]
    : meals.includes('Lunch')
      ? [12, 30]
      : meals.includes('Breakfast')
        ? [8, 30]
        : [19, 0];
  const [y, m, d] = (day ?? '').split('-').map(Number);
  const at =
    y && m && d
      ? new Date(y, m - 1, d, hour, minute)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (at.getTime() >= now.getTime() + 45 * 60_000) return at;
  return new Date(Math.ceil((now.getTime() + 90 * 60_000) / QUARTER) * QUARTER);
}

const KITCHEN = 'savorly.kitchen';
/** The kitchen this device last planned for, or the usual one. */
export async function savedKitchen(): Promise<MealKitchen> {
  try {
    const saved = JSON.parse((await AsyncStorage.getItem(KITCHEN)) ?? 'null');
    const fits = (n: unknown, [low, high]: readonly [number, number]) =>
      typeof n === 'number' && Number.isInteger(n) && n >= low && n <= high;
    if (fits(saved?.burners, kitchenLimits.burners) && fits(saved?.ovens, kitchenLimits.ovens))
      return { burners: saved.burners, ovens: saved.ovens };
  } catch {
    // Unreadable or missing: the usual kitchen.
  }
  return defaultKitchen;
}
export function keepKitchen(kitchen: MealKitchen) {
  void AsyncStorage.setItem(KITCHEN, JSON.stringify(kitchen)).catch(() => {});
}

/** A step of the meal as cooking mode works through it. */
export type MealItem = {
  /** `recipeId:step`, unique in the meal. */
  key: string;
  /** The dish's place in the plan, for its colour. */
  dish: number;
  recipeId: string;
  /** 0-based, in its recipe. */
  step: number;
  /** When the plan has it start, in milliseconds. */
  start: number;
  /** Seconds it runs on its own once its hands-on part is done (a preheat's heating included). */
  wait: number;
  preheat: boolean;
  oven: boolean;
};
export function mealItems(plan: MealTimeline): MealItem[] {
  return plan.steps.map((s) => {
    const start = Date.parse(s.startAt);
    return {
      key: `${s.recipeId}:${s.step}`,
      dish: Math.max(
        0,
        plan.dishes.findIndex((d) => d.recipeId === s.recipeId),
      ),
      recipeId: s.recipeId,
      step: s.step - 1,
      start,
      wait: s.preheat ? Math.round((Date.parse(s.endAt) - start) / 1000) : s.wait,
      preheat: s.preheat,
      oven: s.oven > 0 && !s.preheat,
    };
  });
}

/** A step's waiting part under way: running until `endAt`, or paused with `left` ms to go. */
export type MealTimer = { endAt: number | null; left: number; length: number };
/** How far the cook is through the meal. */
export type MealRun = {
  /** How much later everything not yet started now runs ("I'm behind"), in ms. */
  shift: number;
  /** Steps finished, in the order they were. */
  done: string[];
  /** Steps whose waiting part is under way. */
  timers: Record<string, MealTimer>;
  /** Steps whose hands-on part the cook finished, in order, for Back. */
  finished: string[];
};
export const startRun = (): MealRun => ({ shift: 0, done: [], timers: {}, finished: [] });

const started = (run: MealRun, key: string) => run.done.includes(key) || key in run.timers;

/**
 * Whether the cook can do `item` now: every earlier step of its dish is done, but a preheat, which
 * only an oven step waits for, and then only until it's switched on.
 */
export function canStart(items: MealItem[], run: MealRun, item: MealItem) {
  return items.every(
    (other) =>
      other.recipeId !== item.recipeId ||
      other.step >= item.step ||
      (other.preheat ? !item.oven || started(run, other.key) : run.done.includes(other.key)),
  );
}
/** What to do now: the first step in the plan's order not yet started that can be. */
export function currentItem(items: MealItem[], run: MealRun) {
  return items.find((item) => !started(run, item.key) && canStart(items, run, item)) ?? null;
}
/** What comes after `current` in the plan's order, whether or not it can start yet. */
export function nextItem(items: MealItem[], run: MealRun, current: MealItem | null) {
  return items.find((item) => item !== current && !started(run, item.key)) ?? null;
}
/** When the plan now has `item` start. */
export const plannedAt = (item: MealItem, run: MealRun) => item.start + run.shift;
/** Seconds left on a timer at `now`. */
export const timerLeft = (timer: MealTimer, now: number) =>
  Math.max(0, Math.ceil((timer.endAt === null ? timer.left : timer.endAt - now) / 1000));

/** Finishes `item`'s hands-on part: its waiting part starts counting down, or it's done. */
export function finishItem(run: MealRun, item: MealItem, now: number): MealRun {
  const finished = [...run.finished, item.key];
  if (item.wait <= 0) return { ...run, done: [...run.done, item.key], finished };
  const length = item.wait * 1000;
  return {
    ...run,
    timers: { ...run.timers, [item.key]: { endAt: now + length, left: length, length } },
    finished,
  };
}
/** Takes back the last step the cook finished, its timer with it. */
export function undoItem(run: MealRun): MealRun {
  const key = run.finished[run.finished.length - 1];
  if (!key) return run;
  const timers = { ...run.timers };
  delete timers[key];
  return {
    ...run,
    timers,
    done: run.done.filter((k) => k !== key),
    finished: run.finished.slice(0, -1),
  };
}
/** Pauses a running timer, or runs a paused one on. */
export function toggleTimer(run: MealRun, key: string, now: number): MealRun {
  const timer = run.timers[key];
  if (!timer) return run;
  const next =
    timer.endAt === null
      ? { ...timer, endAt: now + timer.left }
      : { ...timer, endAt: null, left: Math.max(0, timer.endAt - now) };
  return { ...run, timers: { ...run.timers, [key]: next } };
}
/** Timers whose time is up are done; it answers the run and which ended. */
export function settleTimers(run: MealRun, now: number): { run: MealRun; ended: string[] } {
  const ended = Object.entries(run.timers)
    .filter(([, t]) => t.endAt !== null && t.endAt <= now)
    .map(([key]) => key);
  if (!ended.length) return { run, ended };
  const timers = { ...run.timers };
  for (const key of ended) delete timers[key];
  return { run: { ...run, timers, done: [...run.done, ...ended] }, ended };
}
/**
 * "I'm behind": everything not yet started moves later, so the step to do now starts now, and
 * by 5 minutes at least. Timers under way keep running as they are.
 */
export function fallBehind(items: MealItem[], run: MealRun, now: number): MealRun {
  const current = currentItem(items, run) ?? nextItem(items, run, null);
  const late = current ? now - plannedAt(current, run) : 0;
  return { ...run, shift: run.shift + Math.max(5 * 60_000, Math.ceil(late / 60_000) * 60_000) };
}
/** Whether every step of dish `recipeId` is done. */
export const dishDone = (items: MealItem[], run: MealRun, recipeId: string) =>
  items.every((item) => item.recipeId !== recipeId || run.done.includes(item.key));

// The meal being cooked, which MealCookingHost shows over everything.
export type CookingMeal = { plan: MealTimeline; recipes: Recipe[]; n: number };
let cooking: CookingMeal | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
/** Opens cooking mode for a planned meal; null closes it. */
export function cookMeal(meal: Omit<CookingMeal, 'n'> | null) {
  cooking = meal ? { ...meal, n: (cooking?.n ?? 0) + 1 } : null;
  for (const listener of listeners) listener();
}
export const useCookingMeal = () =>
  useSyncExternalStore(
    subscribe,
    () => cooking,
    () => cooking,
  );

type MealEvent = 'enter' | 'leave' | 'timer_start' | 'timer_pause' | 'timer_end';
/**
 * Records a meal cooked together as one cook session per dish (POST /meals/cook-sessions), as
 * cooking mode does for one recipe (cookSessions.ts): each step entered when it's on screen and
 * left when it's done, its timer started, paused and run out, the furthest step as the dish goes
 * on, and the dish finished with its last step, so each dish counts as cooked. Guests record
 * nothing, the server keeps none for the cook's own recipes, and a member who keeps their cooking
 * out sends no step events. Nothing waits on it, and a request that fails is dropped.
 */
export function useMealSessions(plan: MealTimeline) {
  const { user } = useApp();
  const signedIn = !!user;
  const sharing = signedIn && user?.preferences?.shareCooking !== false;
  const sessions = useRef<Promise<
    Record<string, { id: string; seq: number; steps: number }>
  > | null>(null);
  const recipes = plan.dishes.map((d) => d.recipeId).join(',');
  useEffect(() => {
    if (!signedIn || sessions.current) return;
    sessions.current = api<{ sessions?: { id?: unknown; recipeId?: unknown; steps?: unknown }[] }>(
      '/meals/cook-sessions',
      { method: 'POST', body: { recipes: recipes.split(',') } },
    )
      .then((meal) => {
        const out: Record<string, { id: string; seq: number; steps: number }> = {};
        for (const s of meal?.sessions ?? [])
          if (typeof s.id === 'string' && typeof s.recipeId === 'string')
            out[s.recipeId] = { id: s.id, seq: 0, steps: Number(s.steps) || 0 };
        return out;
      })
      .catch(() => ({}));
  }, [signedIn, recipes]);
  const event = useCallback(
    (recipeId: string, kind: MealEvent, step: number) => {
      if (!sharing) return;
      void sessions.current?.then((all) => {
        const session = all[recipeId];
        if (!session) return;
        const sent = { seq: session.seq++, kind, step: step + 1, at: Date.now() };
        void api(`/cook-sessions/${encodeURIComponent(session.id)}/events`, {
          method: 'POST',
          body: { events: [sent] },
        }).catch(() => {});
      });
    },
    [sharing],
  );
  const reached = useCallback((recipeId: string, step: number, finished: boolean) => {
    void sessions.current?.then((all) => {
      const session = all[recipeId];
      if (!session) return;
      void api(`/cook-sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: finished ? { step: session.steps, finished: true } : { step: step + 1 },
      }).catch(() => {});
    });
  }, []);
  return { event, reached };
}
