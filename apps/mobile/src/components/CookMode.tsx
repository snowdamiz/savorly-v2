import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  View,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import {
  ArrowLeft,
  Check,
  ChefHat,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from './icons';
import * as Speech from 'expo-speech';
import { useCookingNarration } from '../lib/narration/useCookingNarration';
import { useCookSession } from '../lib/cookSessions';
import { useScreenAwake } from '../lib/screenAwake';
import { announced, cancelTimerAlert, scheduleTimerAlert } from '../lib/timerAlerts';
import { CookCommand, Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { Button, FoodImage, IconButton, useChrome, useSlideOver, webPosition } from './ui';
import { StepClip } from './VideoPlayer';
import { HandsFree } from './HandsFree';
import { CookEquipment } from './Equipment';
import { StepQuestions, StepUsual, TimerNote } from './CookInsights';
import { cooksNeed, RecipeInsights, stepInsight } from '../lib/cookInsights';
import { FixDraft } from '../lib/recipeFixes';
const RING = 92;
const CIRCUMFERENCE = 2 * Math.PI * RING;
export function CookMode({
  recipe,
  onClose,
  onAsk,
  onStep,
  command,
  onCooked,
  onSuggest,
  translatedTo,
  insights,
}: {
  /** The recipe as the cook reads it: translated, when they read it translated. */
  recipe: Recipe;
  /** What other cooks found at each step (docs/COOK-TESTED.md), once it has loaded. */
  insights?: RecipeInsights | null;
  onClose: () => void;
  onAsk: () => void;
  /** Reports the 1-based step on screen, so the sous-chef knows where the cook is. */
  onStep: (step: number) => void;
  command?: CookCommand | null;
  /** After the last step: "I cooked this" on the recipe page, with a photo or a note. */
  onCooked?: () => void;
  /**
   * Suggest a change to the recipe (docs/RECIPE-FIXES.md), offered when the cook is done, if this
   * was a verified cook and a step took clearly longer than its timer.
   */
  onSuggest?: (draft: FixDraft) => void;
  /** The language `recipe` is translated into, so its steps are read aloud in it; null as written. */
  translatedTo?: string | null;
}) {
  const { t: tr, locale } = useI18n();
  const page = useSlideOver(onClose);
  const { insets, width, webPage } = useChrome();
  // Wet hands can't tap the screen awake again.
  useScreenAwake();
  const [step, setStep] = useState(() =>
    Math.min(Math.max((command?.step || 1) - 1, 0), recipe.steps.length - 1),
  );
  const [remaining, setRemaining] = useState(recipe.steps[step].seconds);
  // The timer's length: the step's, unless the cook set it to how long cooks really need.
  const [length, setLength] = useState(recipe.steps[step].seconds);
  const [endAt, setEndAt] = useState<number | null>(null);
  const {
    state: narrationState,
    speaking,
    read,
    stop,
  } = useCookingNarration(recipe, step, translatedTo);
  const [done, setDone] = useState(false);
  const { timerEvent, verified, overrun } = useCookSession(recipe, step, done);
  // The end time is the timer, and the countdown is redrawn from it. JavaScript timers stand still
  // while the app is in the background and slow down in a hidden browser tab, so the countdown is
  // redrawn on return too, and a system alert covers an end that comes while the cook is away.
  const systemAlert = useRef<string | null>(null);
  useEffect(() => {
    if (!endAt) return;
    let finished = false;
    const tick = () => {
      if (finished) return;
      const seconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds) return;
      finished = true;
      setEndAt(null);
      timerEvent('timer_end');
      stop();
      // Back after an end the system already announced, the finished ring says enough.
      const away =
        Date.now() - endAt > 3000 && !!systemAlert.current && announced(systemAlert.current);
      if (!away) Speech.speak(tr('Your cooking timer is finished.'), { language: locale });
    };
    tick();
    const interval = setInterval(tick, 250);
    // A single timer for the end itself still runs on time in a hidden tab.
    const end = setTimeout(tick, endAt - Date.now() + 50);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      clearInterval(interval);
      clearTimeout(end);
      sub.remove();
    };
  }, [endAt, tr, locale, stop, timerEvent]);
  const { title } = recipe;
  const finishedText = tr('Your cooking timer is finished.');
  const channel = tr('Cooking timers');
  // Scheduled while the timer runs; pausing, resetting, finishing or leaving calls it off.
  useEffect(() => {
    if (!endAt) return;
    let live = true;
    void scheduleTimerAlert(endAt, { title, body: finishedText, channel }).then((id) => {
      if (!id) return;
      if (live) systemAlert.current = id;
      else cancelTimerAlert(id);
    });
    return () => {
      live = false;
      if (systemAlert.current) cancelTimerAlert(systemAlert.current);
      systemAlert.current = null;
    };
  }, [endAt, title, finishedText, channel]);
  const current = recipe.steps[step];
  const last = step === recipe.steps.length - 1;
  // What other cooks found at this step (docs/COOK-TESTED.md).
  const found = stepInsight(insights ?? null, step + 1);
  const need = cooksNeed(found);
  const change = (n: number) => {
    stop();
    setEndAt(null);
    setDone(false);
    setStep(n);
    setRemaining(recipe.steps[n].seconds);
    setLength(recipe.steps[n].seconds);
  };
  useEffect(() => onStep(step + 1), [step, onStep]);
  // Each sous-chef command applies once, to the step on screen when it arrives.
  const [handled, setHandled] = useState(command?.n);
  if (command && command.n !== handled) {
    setHandled(command.n);
    if (command.step) {
      const n = Math.min(Math.max(command.step, 1), recipe.steps.length) - 1;
      setEndAt(null);
      setDone(false);
      setStep(n);
      setRemaining(recipe.steps[n].seconds);
      setLength(recipe.steps[n].seconds);
    } else if (command.timerFrom && current.seconds && !endAt)
      setEndAt(command.timerFrom + remaining * 1000);
  }
  // A timer the sous-chef started counts like one started on screen.
  const startedBy = command?.timerFrom ? command.n : undefined;
  useEffect(() => {
    if (startedBy !== undefined) timerEvent('timer_start');
  }, [startedBy, timerEvent]);
  const close = () => {
    stop();
    page.leave();
  };
  const next = () => {
    if (last) {
      stop();
      setEndAt(null);
      setDone(true);
    } else change(step + 1);
  };
  // In a browser, Escape closes and the arrow keys move between steps, unless a field is in use.
  const keys = useRef({ close, next, previous: () => {} });
  useEffect(() => {
    keys.current = {
      close,
      next: done ? () => {} : next,
      previous: () => !done && step > 0 && change(step - 1),
    };
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
  const clock = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const progress = length ? remaining / length : 0;
  const big = width > 600;
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
        <View style={{ flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', gap: 20 }}>
          <View style={[s.between, { gap: 12 }]}>
            <IconButton icon={X} dark label={tr('Close cooking mode')} onPress={close} />
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={{
                  textAlign: 'center',
                  color: color.onInk,
                  fontFamily: font.semibold,
                  fontSize: 14,
                }}
              >
                {recipe.title}
              </Text>
              {!!translatedTo && (
                <Text style={[s.small, { color: color.onInk, textAlign: 'center' }]}>
                  {tr('Translated by AI')}
                </Text>
              )}
            </View>
            <IconButton
              icon={Sparkles}
              dark
              label={tr('Ask the sous-chef')}
              onPress={() => {
                stop();
                onAsk();
              }}
            />
          </View>
          {/* Free on-device listening, the first choice over a live call's voice minutes. */}
          <HandsFree
            recipe={recipe}
            cook={{
              step,
              done,
              reading: speaking,
              timer: { seconds: current.seconds, remaining, running: !!endAt },
              next,
              previous: () => step > 0 && change(step - 1),
              read,
              stopReading: stop,
              setTimer: (run) => {
                timerEvent(run ? 'timer_start' : 'timer_pause');
                setEndAt(run ? Date.now() + remaining * 1000 : null);
              },
            }}
          />
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
              {overrun && verified && onSuggest && (
                <View style={[s.row, { gap: 8, justifyContent: 'center', flexWrap: 'wrap' }]}>
                  <Text style={[s.small, { color: color.onInk, fontSize: 14 }]}>
                    {tr('tookYouLonger', {
                      step: overrun.step,
                      count: overrun.minutes,
                      timer: overrun.timer,
                    })}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => {
                      page.leave();
                      onSuggest({
                        kind: 'time',
                        step: overrun.step,
                        change: { seconds: overrun.minutes * 60 },
                        reason: tr('It took me {{v0}} minutes, not {{v1}}.', {
                          v0: overrun.minutes,
                          v1: overrun.timer,
                        }),
                      });
                    }}
                  >
                    <Text
                      style={[
                        s.small,
                        { color: color.white, fontSize: 14, textDecorationLine: 'underline' },
                      ]}
                    >
                      {tr('Suggest a change')}
                    </Text>
                  </Pressable>
                </View>
              )}
              {onCooked && (
                <Button
                  title={tr('I cooked this')}
                  icon={ChefHat}
                  variant="inverse"
                  large
                  onPress={() => {
                    page.leave();
                    onCooked();
                  }}
                  style={{ marginTop: 16, alignSelf: 'stretch' }}
                />
              )}
              <Button
                title={tr('Back to the recipe')}
                variant={onCooked ? 'ghost' : 'inverse'}
                large
                onPress={page.leave}
                style={{ marginTop: onCooked ? 4 : 16, alignSelf: 'stretch' }}
              />
            </View>
          ) : (
            <>
              <View style={[s.row, { gap: 6 }]}>
                {recipe.steps.map((_, i) => (
                  <View
                    key={i}
                    style={{
                      flex: 1,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: i <= step ? color.white : 'rgba(255,255,255,0.16)',
                    }}
                  />
                ))}
              </View>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ gap: 14, paddingVertical: 12 }}
                showsVerticalScrollIndicator={false}
              >
                {/* Everything to get out before step 1, so nothing is missing midway. */}
                {step === 0 && <CookEquipment recipe={recipe} />}
                <Text style={[s.label, { color: color.onInk }]}>
                  {tr('STEP {{v0}} OF {{v1}}', { v0: step + 1, v1: recipe.steps.length })}
                </Text>
                <Text
                  style={[
                    s.display,
                    { color: color.white, fontSize: big ? 38 : 30, lineHeight: big ? 44 : 36 },
                  ]}
                >
                  {current.title}
                </Text>
                <Text
                  style={{
                    color: 'rgba(255,255,255,0.86)',
                    fontFamily: font.medium,
                    fontSize: big ? 24 : 20,
                    lineHeight: big ? 36 : 31,
                  }}
                >
                  {current.text}
                </Text>
                <StepUsual insight={found} dark />
                <StepQuestions key={step} insight={found} dark />
                {/* One picture a step keeps the timer in view: a clip shows how, so it takes the
                    photo's place, and a new step or closing stops it. */}
                {current.video ? (
                  <StepClip
                    key={`${step}:${current.video}`}
                    uri={current.video}
                    step={step + 1}
                    autoPlay
                    style={{
                      aspectRatio: big ? 16 / 9 : 4 / 3,
                      borderRadius: radius.lg,
                      marginTop: 4,
                    }}
                  />
                ) : (
                  !!current.image && (
                    <FoodImage
                      key={current.image}
                      uri={current.image}
                      label={tr('Photo of step {{v0}}', { v0: step + 1 })}
                      width={Math.min(width - 40, 720)}
                      style={{
                        width: '100%',
                        aspectRatio: big ? 16 / 9 : 4 / 3,
                        borderRadius: radius.lg,
                        marginTop: 4,
                      }}
                    />
                  )
                )}
                {current.seconds > 0 && (
                  <View style={{ alignItems: 'center', gap: 18, marginTop: 18 }}>
                    <View
                      style={{
                        width: 210,
                        height: 210,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Svg width={210} height={210} style={{ position: 'absolute' }}>
                        <Circle
                          cx={105}
                          cy={105}
                          r={RING}
                          stroke="rgba(255,255,255,0.12)"
                          strokeWidth={6}
                          fill="none"
                        />
                        <Circle
                          cx={105}
                          cy={105}
                          r={RING}
                          stroke={remaining === 0 ? color.success : color.white}
                          strokeWidth={6}
                          fill="none"
                          strokeLinecap="round"
                          strokeDasharray={`${CIRCUMFERENCE}`}
                          strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
                          transform="rotate(-90 105 105)"
                        />
                      </Svg>
                      <Text
                        accessibilityLiveRegion="polite"
                        style={{
                          fontFamily: font.bold,
                          fontSize: 46,
                          letterSpacing: -1.5,
                          color: color.white,
                          fontVariant: ['tabular-nums'],
                        }}
                      >
                        {clock}
                      </Text>
                      <Text style={[s.small, { color: color.onInk }]}>
                        {remaining === 0 ? tr('Done') : endAt ? tr('Running') : tr('Timer')}
                      </Text>
                    </View>
                    <View style={[s.row, { gap: 10 }]}>
                      <Button
                        title={
                          endAt
                            ? tr('Pause timer')
                            : remaining === 0
                              ? tr('Timer finished')
                              : tr('Start timer')
                        }
                        icon={endAt ? Pause : Play}
                        variant="inverse"
                        disabled={remaining === 0}
                        onPress={() => {
                          timerEvent(endAt ? 'timer_pause' : 'timer_start');
                          setEndAt(endAt ? null : Date.now() + remaining * 1000);
                        }}
                      />
                      <IconButton
                        icon={RotateCcw}
                        dark
                        size={52}
                        label={tr('Reset timer')}
                        onPress={() => {
                          setEndAt(null);
                          setRemaining(length);
                        }}
                      />
                    </View>
                    {!!need && remaining > 0 && (
                      <TimerNote
                        seconds={need}
                        onUse={
                          !endAt && remaining === length && length !== need
                            ? () => {
                                setLength(need);
                                setRemaining(need);
                              }
                            : undefined
                        }
                      />
                    )}
                  </View>
                )}
              </ScrollView>
              {narrationState === 'loading' && (
                <ActivityIndicator
                  color={color.white}
                  accessibilityLabel={tr('Read this step aloud')}
                />
              )}
              {narrationState === 'blocked' && (
                <Text style={[s.small, { color: color.onInk }]}>{tr('Tap again to play')}</Text>
              )}
              <View style={[s.row, { gap: 10 }]}>
                <IconButton
                  icon={ArrowLeft}
                  dark
                  size={58}
                  label={tr('Previous')}
                  disabled={step === 0}
                  onPress={() => change(step - 1)}
                />
                <IconButton
                  icon={speaking ? VolumeX : Volume2}
                  dark
                  size={58}
                  label={speaking ? tr('Stop reading') : tr('Read this step aloud')}
                  onPress={speaking ? stop : read}
                />
                <Button
                  title={last ? tr('Finish cooking') : tr('Next step')}
                  icon={last ? Check : undefined}
                  variant="inverse"
                  large
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
