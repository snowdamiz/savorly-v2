import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  View,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import {
  ArrowLeft,
  Check,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';
import * as Speech from 'expo-speech';
import { useCookingNarration } from '../lib/narration/useCookingNarration';
import { CookCommand, Recipe } from '../lib/types';
import { color, font, s } from '../lib/theme';
import { Button, IconButton, useChrome, useSlideOver, webPosition } from './ui';
const RING = 92;
const CIRCUMFERENCE = 2 * Math.PI * RING;
export function CookMode({
  recipe,
  onClose,
  onAsk,
  onStep,
  command,
}: {
  recipe: Recipe;
  onClose: () => void;
  onAsk: () => void;
  /** Reports the 1-based step on screen, so the sous-chef knows where the cook is. */
  onStep: (step: number) => void;
  command?: CookCommand | null;
}) {
  const { t: tr, locale } = useI18n();
  const page = useSlideOver(onClose);
  const { insets, width, webPage } = useChrome();
  const [step, setStep] = useState(() =>
    Math.min(Math.max((command?.step || 1) - 1, 0), recipe.steps.length - 1),
  );
  const [remaining, setRemaining] = useState(recipe.steps[step].seconds);
  const [endAt, setEndAt] = useState<number | null>(null);
  const { state: narrationState, speaking, read, stop } = useCookingNarration(recipe, step);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!endAt) return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) {
        setEndAt(null);
        stop();
        Speech.speak(tr('Your cooking timer is finished.'), { language: locale });
      }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [endAt, tr, locale, stop]);
  const current = recipe.steps[step];
  const last = step === recipe.steps.length - 1;
  const change = (n: number) => {
    stop();
    setEndAt(null);
    setDone(false);
    setStep(n);
    setRemaining(recipe.steps[n].seconds);
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
    } else if (command.timerFrom && current.seconds && !endAt)
      setEndAt(command.timerFrom + remaining * 1000);
  }
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
  const progress = current.seconds ? remaining / current.seconds : 0;
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
              {recipe.title}
            </Text>
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
                title={tr('Back to the recipe')}
                variant="inverse"
                large
                onPress={page.leave}
                style={{ marginTop: 16, alignSelf: 'stretch' }}
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
                        onPress={() => setEndAt(endAt ? null : Date.now() + remaining * 1000)}
                      />
                      <IconButton
                        icon={RotateCcw}
                        dark
                        size={52}
                        label={tr('Reset timer')}
                        onPress={() => {
                          setEndAt(null);
                          setRemaining(current.seconds);
                        }}
                      />
                    </View>
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
