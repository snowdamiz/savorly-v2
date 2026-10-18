import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  View,
} from 'react-native';
import * as Speech from 'expo-speech';
import { ArrowLeft, Check, Hourglass, Pause, Volume2, VolumeX, X } from './icons';
import { HandsFree } from './HandsFree';
import { clockTime, DishDot, useHeat } from './CookTogether';
import { say } from '../lib/handsFree/speech';
import {
  cookMeal,
  currentItem,
  dishDone,
  fallBehind,
  finishItem,
  mealItems,
  nextItem,
  plannedAt,
  settleTimers,
  startRun,
  timerLeft,
  toggleTimer,
  undoItem,
  useCookingMeal,
  useMealSessions,
  type MealItem,
  type MealRun,
  type MealTimeline,
} from '../lib/mealTimeline';
import { speechLanguage } from '../lib/narration/useCookingNarration';
import { useScreenAwake } from '../lib/screenAwake';
import { cancelTimerAlert, scheduleTimerAlert } from '../lib/timerAlerts';
import type { Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { Button, IconButton, useChrome, useSlideOver, webPosition } from './ui';

/** Shows cooking mode over everything while a meal cooked together is open. */
export function MealCookingHost() {
  const meal = useCookingMeal();
  if (!meal) return null;
  return (
    <MealCookMode
      key={meal.n}
      plan={meal.plan}
      recipes={meal.recipes}
      onClose={() => cookMeal(null)}
    />
  );
}

const mmss = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Cooking mode across all the dishes of a meal (docs/MEAL-TIMELINE.md): the step to do now, what
 * comes next and what's running, a timer per dish side by side, "I'm behind", and hands-free
 * commands that work across the dishes. A step with a waiting part starts its dish's timer when
 * it's done, and the cook goes on with another dish.
 */
function MealCookMode({
  plan,
  recipes,
  onClose,
}: {
  plan: MealTimeline;
  recipes: Recipe[];
  onClose: () => void;
}) {
  const { t: tr, locale } = useI18n();
  const heat = useHeat();
  const page = useSlideOver(onClose);
  const { insets, width, webPage } = useChrome();
  // Wet hands can't tap the screen awake again.
  useScreenAwake();
  const items = useMemo(() => mealItems(plan), [plan]);
  const [run, setRun] = useState<MealRun>(startRun);
  const [now, setNow] = useState(() => Date.now());
  const { event, reached } = useMealSessions(plan);
  const recipeOf = (id: string) => recipes.find((r) => r.id === id);
  const dishTitle = (item: MealItem) => plan.dishes[item.dish]?.title ?? '';
  const stepTitle = (item: MealItem) => {
    const step = plan.steps.find((s) => s.recipeId === item.recipeId && s.step === item.step + 1);
    return item.preheat
      ? tr('Preheat the oven to {{v0}}', { v0: heat(step?.oven ?? 0) })
      : (recipeOf(item.recipeId)?.steps[item.step]?.title ?? step?.title ?? '');
  };
  const current = currentItem(items, run);
  const upcoming = nextItem(items, run, current);
  const done = run.done.length === items.length;
  const timers = Object.entries(run.timers)
    .map(([key, timer]) => ({ key, timer, item: items.find((i) => i.key === key)! }))
    .filter((t) => t.item)
    .sort((a, b) => timerLeft(a.timer, now) - timerLeft(b.timer, now));

  // Spoken: the step on screen in its recipe's voice, then what's running in the app's.
  const [speaking, setSpeaking] = useState(false);
  const spoken = useRef<ReturnType<typeof say> | null>(null);
  const stop = useCallback(() => {
    spoken.current?.cancel();
    spoken.current = null;
    setSpeaking(false);
  }, []);
  const latest = useRef({ current, timers, done, run });
  useEffect(() => {
    latest.current = { current, timers, done, run };
  });
  const describe = useRef<() => { text: string; language: string }[]>(() => []);
  useEffect(() => {
    describe.current = () => {
      const { current, timers, done } = latest.current;
      const at = Date.now();
      const running = timers
        .filter((t) => t.timer.endAt !== null)
        .slice(0, 3)
        .map((t) => {
          const count = Math.max(1, Math.ceil(timerLeft(t.timer, at) / 60));
          return t.item.preheat
            ? tr('ovenHotIn', { count })
            : tr('dishMinutesLeft', { dish: dishTitle(t.item), count });
        });
      if (done) return [{ text: tr('Dinner is served.'), language: locale }];
      const status = { text: running.join(' '), language: locale };
      if (!current)
        return [{ text: tr('Nothing to do until a timer ends.'), language: locale }, status];
      const recipe = recipeOf(current.recipeId);
      const text = current.preheat ? '' : (recipe?.steps[current.step]?.text ?? '');
      return [
        {
          text: `${dishTitle(current)}. ${stepTitle(current)}. ${text}`,
          language: speechLanguage(locale, recipe?.language),
        },
        status,
      ].filter((part) => part.text.trim());
    };
  });
  const read = useCallback(() => {
    spoken.current?.cancel();
    const words = say(describe.current());
    spoken.current = words;
    setSpeaking(true);
    void words.done.then(() => {
      if (spoken.current !== words) return;
      spoken.current = null;
      setSpeaking(false);
    });
  }, []);
  useEffect(() => () => spoken.current?.cancel(), []);

  // Each step on screen is entered on its dish's cook session, and left once it's done.
  const currentKey = current?.key;
  useEffect(() => {
    const item = items.find((i) => i.key === currentKey);
    if (item) event(item.recipeId, 'enter', item.step);
  }, [currentKey, items, event]);
  const over = (after: MealRun, item: MealItem) => {
    event(item.recipeId, 'leave', item.step);
    reached(item.recipeId, item.step, dishDone(items, after, item.recipeId));
  };
  const finish = (item: MealItem) => {
    stop();
    const at = Date.now();
    const after = finishItem(run, item, at);
    setRun((r) => finishItem(r, item, at));
    if (item.wait > 0) event(item.recipeId, 'timer_start', item.step);
    else over(after, item);
  };
  const timerToggle = (key: string) => {
    const timer = run.timers[key];
    const item = items.find((i) => i.key === key);
    if (!timer || !item) return;
    setRun((r) => toggleTimer(r, key, Date.now()));
    event(item.recipeId, timer.endAt === null ? 'timer_start' : 'timer_pause', item.step);
  };

  // The clock moves on: four times a second while a timer runs, else every few seconds. A timer
  // that's up finishes its step, says so, and lets its dish go on. JavaScript timers stand still in
  // the background, so returning catches up, and a system alert covers an end while away.
  const settle = useRef(() => {});
  useEffect(() => {
    settle.current = () => {
      const at = Date.now();
      setNow(at);
      const { run: after, ended } = settleTimers(latest.current.run, at);
      if (!ended.length) return;
      setRun((r) => settleTimers(r, at).run);
      for (const key of ended) {
        const item = items.find((i) => i.key === key);
        if (!item) continue;
        event(item.recipeId, 'timer_end', item.step);
        over(after, item);
      }
      const up = ended
        .map((key) => items.find((i) => i.key === key))
        .filter((i): i is MealItem => !!i);
      const names = up.filter((i) => !i.preheat).map(dishTitle);
      const said = [
        up.some((i) => i.preheat) ? tr('The oven is hot.') : '',
        names.length ? tr('{{v0}}: the timer is done.', { v0: names.join(', ') }) : '',
      ];
      Speech.speak(said.filter(Boolean).join(' '), { language: locale });
    };
  });
  const ticking = Object.values(run.timers).some((t) => t.endAt !== null);
  const nextEnd = Math.min(
    ...Object.values(run.timers).map((t) => (t.endAt === null ? Infinity : t.endAt)),
  );
  useEffect(() => {
    const tick = () => settle.current();
    const interval = setInterval(tick, ticking ? 250 : 10_000);
    // A single timer for the next end still runs on time in a hidden tab.
    const end = Number.isFinite(nextEnd) ? setTimeout(tick, nextEnd - Date.now() + 50) : null;
    const sub = AppState.addEventListener('change', (state) => state === 'active' && tick());
    return () => {
      clearInterval(interval);
      if (end) clearTimeout(end);
      sub.remove();
    };
  }, [ticking, nextEnd]);
  // Each running timer has the system say so when it's up, should the cook be away.
  const finishedText = tr('Your cooking timer is finished.');
  const channel = tr('Cooking timers');
  const alerts = JSON.stringify(
    Object.entries(run.timers)
      .filter(([, t]) => t.endAt !== null)
      .map(([key, t]) => [key, t.endAt]),
  );
  useEffect(() => {
    const due: [string, number][] = JSON.parse(alerts);
    let live = true;
    const ids: string[] = [];
    for (const [key, endAt] of due) {
      const title = plan.dishes.find((d) => key.startsWith(`${d.recipeId}:`))?.title ?? '';
      void scheduleTimerAlert(endAt, { title, body: finishedText, channel }).then((id) => {
        if (!id) return;
        if (live) ids.push(id);
        else cancelTimerAlert(id);
      });
    }
    return () => {
      live = false;
      ids.forEach(cancelTimerAlert);
    };
  }, [alerts, plan.dishes, finishedText, channel]);
  // Closing cooking mode leaves the step on screen.
  useEffect(
    () => () => {
      const item = latest.current.current;
      if (item) event(item.recipeId, 'leave', item.step);
    },
    [event],
  );

  const close = () => {
    stop();
    page.leave();
  };
  const next = () => {
    if (current) finish(current);
    else read();
  };
  const previous = () => {
    stop();
    setRun(undoItem);
  };
  const behind = () => setRun((r) => fallBehind(items, r, Date.now()));
  // In a browser, Escape closes and the arrow keys move between steps, unless a field is in use.
  const keys = useRef({ close, next, previous });
  useEffect(() => {
    keys.current = { close, next: done ? () => {} : next, previous };
  });
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        target?.closest?.('input,textarea,[contenteditable]')
      )
        return;
      const action = {
        Escape: keys.current.close,
        ArrowRight: keys.current.next,
        ArrowLeft: keys.current.previous,
      }[e.key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const soonest = timers[0];
  const left = items.filter((i) => !run.done.includes(i.key));
  // Done with the last step finishes the meal; a step with a waiting part starts its timer.
  const last = left.length === 1 && !!current && current.wait <= 0;
  const startsTimer = !!current && current.wait > 0;
  const eatAt = Date.parse(plan.eatAt) + run.shift;
  const big = width > 600;
  const recipe = current ? recipeOf(current.recipeId) : undefined;
  const lead = current ? Math.round((plannedAt(current, run) - now) / 60_000) : 0;
  const waits = current && current.wait > 0 ? Math.round(current.wait / 60) : 0;
  const upNext = current ? upcoming : nextItem(items, run, null);
  // Hands-free keeps listening between steps: questions and ingredients are then the next dish's.
  const voice = recipe ?? (upNext ? recipeOf(upNext.recipeId) : undefined) ?? recipes[0];
  return (
    // The web page sits beside the sidebar, so cooking mode fixes itself over the whole window.
    <Animated.View aria-modal style={[page.style, webPosition('fixed')]}>
      <StatusBar barStyle="light-content" />
      <View
        style={{
          flex: 1,
          backgroundColor: color.ink,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 16,
          paddingHorizontal: 20,
        }}
      >
        <View style={{ flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', gap: 18 }}>
          <View style={[s.between, { gap: 12 }]}>
            <IconButton icon={X} dark label={tr('Close cooking mode')} onPress={close} />
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                textAlign: 'center',
                color: color.onInk,
                fontFamily: font.semibold,
                fontSize: 14,
              }}
            >
              {tr('Eat at {{v0}}', { v0: clockTime(eatAt, locale) })}
            </Text>
            <IconButton
              icon={Hourglass}
              dark
              label={tr('I’m behind')}
              disabled={done}
              onPress={behind}
            />
          </View>
          {voice && (
            <HandsFree
              recipe={voice}
              cook={{
                step: current?.step ?? upNext?.step ?? 0,
                done,
                reading: speaking,
                // The dishes' timer that ends first, for pausing and resuming by voice.
                timer: soonest
                  ? {
                      seconds: Math.round(soonest.timer.length / 1000),
                      remaining: timerLeft(soonest.timer, now),
                      running: soonest.timer.endAt !== null,
                    }
                  : { seconds: 0, remaining: 0, running: false },
                next,
                previous,
                read,
                stopReading: stop,
                setTimer: (running) => {
                  if (soonest && running !== (soonest.timer.endAt !== null))
                    timerToggle(soonest.key);
                },
                meal: { position: run.finished.length, last, startsTimer },
              }}
            />
          )}
          {timers.length > 0 && (
            <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
              {timers.map(({ key, timer, item }) => (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityLabel={
                    timer.endAt === null
                      ? tr('Resume the timer for {{v0}}', { v0: dishTitle(item) })
                      : tr('Pause the timer for {{v0}}', { v0: dishTitle(item) })
                  }
                  onPress={() => timerToggle(key)}
                  style={[
                    s.row,
                    {
                      gap: 8,
                      minHeight: 40,
                      paddingHorizontal: 14,
                      borderRadius: radius.pill,
                      backgroundColor: color.glass,
                      borderWidth: 1,
                      borderColor: color.glassBorder,
                    },
                  ]}
                >
                  <DishDot index={item.dish} />
                  <Text
                    numberOfLines={1}
                    style={{
                      color: color.white,
                      fontFamily: font.semibold,
                      fontSize: 13,
                      maxWidth: 150,
                    }}
                  >
                    {item.preheat ? tr('Oven heating') : dishTitle(item)}
                  </Text>
                  <Text
                    accessibilityLiveRegion="polite"
                    style={{
                      color: color.white,
                      fontFamily: font.bold,
                      fontSize: 13,
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {mmss(timerLeft(timer, now))}
                  </Text>
                  {timer.endAt === null && (
                    <Pause size={13} color={color.onInk} strokeWidth={2.2} />
                  )}
                </Pressable>
              ))}
            </View>
          )}
          {done ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <View
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 48,
                  backgroundColor: color.white,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 8,
                }}
              >
                <Check size={44} color={color.ink} strokeWidth={2.4} />
              </View>
              <Text style={[s.display, { color: color.white, textAlign: 'center' }]}>
                {tr('Dinner is served.')}
              </Text>
              <Text
                style={[
                  s.muted,
                  { color: color.onInk, textAlign: 'center', fontSize: 16, lineHeight: 24 },
                ]}
              >
                {tr('Take a moment to enjoy what you made.\nThen let the cook know how it went.')}
              </Text>
              <Button
                title={tr('Close cooking mode')}
                variant="inverse"
                large
                onPress={page.leave}
                style={{ marginTop: 16, alignSelf: 'stretch' }}
              />
            </View>
          ) : (
            <>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ gap: 14, paddingVertical: 8 }}
                showsVerticalScrollIndicator={false}
              >
                {current ? (
                  <>
                    <View style={[s.row, { gap: 8 }]}>
                      <DishDot index={current.dish} />
                      <Text style={[s.label, { color: color.onInk, flexShrink: 1 }]}>
                        {[
                          dishTitle(current),
                          tr('STEP {{v0}} OF {{v1}}', {
                            v0: current.step + 1,
                            v1: recipe?.steps.length ?? 1,
                          }),
                          clockTime(plannedAt(current, run), locale),
                        ].join(' · ')}
                      </Text>
                    </View>
                    <Text
                      style={[
                        s.display,
                        { color: color.white, fontSize: big ? 38 : 30, lineHeight: big ? 44 : 36 },
                      ]}
                    >
                      {stepTitle(current)}
                    </Text>
                    {!current.preheat && !!recipe?.steps[current.step]?.text && (
                      <Text
                        style={{
                          color: 'rgba(255,255,255,0.86)',
                          fontFamily: font.medium,
                          fontSize: big ? 24 : 20,
                          lineHeight: big ? 36 : 31,
                        }}
                      >
                        {recipe.steps[current.step].text}
                      </Text>
                    )}
                    {waits > 0 && (
                      <Text style={[s.small, { color: color.onInk, fontSize: 14 }]}>
                        {tr('thenOnItsOwn', { count: waits })}
                      </Text>
                    )}
                    {lead >= 2 && (
                      <Text style={[s.small, { color: color.onInk, fontSize: 14 }]}>
                        {tr('freeFirst', { count: lead })}
                      </Text>
                    )}
                  </>
                ) : (
                  <View style={{ gap: 10, paddingTop: 24 }}>
                    <Text style={[s.display, { color: color.white }]}>{tr('Free for now')}</Text>
                    <Text style={[s.small, { color: color.onInk, fontSize: 14 }]}>
                      {tr('Nothing to do until a timer ends.')}
                    </Text>
                  </View>
                )}
              </ScrollView>
              {upNext && (
                <View style={[s.row, { gap: 8 }]}>
                  <DishDot index={upNext.dish} />
                  <Text
                    numberOfLines={1}
                    style={[s.small, { color: color.onInk, flex: 1, fontSize: 14 }]}
                  >
                    {tr('Next at {{time}}: {{step}}', {
                      time: clockTime(plannedAt(upNext, run), locale),
                      step: tr('{{dish}}: {{step}}', {
                        dish: dishTitle(upNext),
                        step: stepTitle(upNext),
                      }),
                    })}
                    {timers.some((t) => t.item.recipeId === upNext.recipeId && !t.item.preheat) &&
                      ` · ${tr('after its timer')}`}
                  </Text>
                </View>
              )}
              <View style={[s.row, { gap: 10 }]}>
                <IconButton
                  icon={ArrowLeft}
                  dark
                  size={58}
                  label={tr('Previous')}
                  disabled={!run.finished.length}
                  onPress={previous}
                />
                <IconButton
                  icon={speaking ? VolumeX : Volume2}
                  dark
                  size={58}
                  label={speaking ? tr('Stop reading') : tr('Read this step aloud')}
                  onPress={speaking ? stop : read}
                />
                <Button
                  title={last ? tr('Finish cooking') : tr('Done')}
                  icon={last ? Check : undefined}
                  variant="inverse"
                  large
                  disabled={!current}
                  style={{ flex: 1 }}
                  onPress={next}
                />
              </View>
              {webPage && (
                <Text style={[s.small, { color: color.onInk, textAlign: 'center' }]}>
                  {tr('Use ← and → to move between steps, and Esc to close.')}
                </Text>
              )}
            </>
          )}
        </View>
      </View>
    </Animated.View>
  );
}
