import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Check, Info, Mic } from './icons';
import { examples, wakeWord } from '../lib/handsFree/grammar';
import type { RecognitionPlace } from '../lib/handsFree/recognition';
import { recognition } from '../lib/handsFree/recognizer';
import { useHandsFree, type CookControls } from '../lib/handsFree/useHandsFree';
import { useApp } from '../lib/store';
import type { Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { Button, Dialog, motionReduced, native, Press } from './ui';

const EXPLAINED = 'savorly.handsFree.explained';

/**
 * Cooking mode's hands-free listening: on the device, for free commands and "Chef, …" questions,
 * so a whole cook can be hands-free without a live call's voice minutes. Its pieces go where they
 * belong on the screen: the switch in the bar, how it's listening on the line under the title, and
 * an answer or a problem under the step.
 */
export function useHandsFreeView(recipe: Recipe, cook: CookControls) {
  const { locale } = useI18n();
  const hands = useHandsFree(recipe, cook);
  const [explaining, setExplaining] = useState(false);
  // Until it's known, assume the explainer was seen rather than show it twice.
  const [explained, setExplained] = useState(true);
  const [preview, setPreview] = useState<RecognitionPlace | null>(null);
  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(EXPLAINED)
      .then((seen) => live && setExplained(seen === '1'))
      .catch(() => live && setExplained(false));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!explaining || hands.place) return;
    let live = true;
    void recognition
      .place(locale)
      .then((place) => live && setPreview(place))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [explaining, hands.place, locale]);
  const start = () => {
    setExplaining(false);
    if (!explained) {
      setExplained(true);
      void AsyncStorage.setItem(EXPLAINED, '1').catch(() => {});
    }
    if (!hands.on) hands.turnOn();
  };
  const toggle = () => {
    if (hands.on) hands.turnOff();
    else if (!explained) setExplaining(true);
    else hands.turnOn();
  };
  return {
    hands,
    done: cook.done,
    place: hands.place ?? preview,
    explaining,
    explain: (open: boolean) => setExplaining(open),
    start,
    toggle,
  };
}
export type HandsFreeView = ReturnType<typeof useHandsFreeView>;

/** The switch in cooking mode's bar: a microphone, white with a dot while it listens. */
export function HandsFreeSwitch({ view }: { view: HandsFreeView }) {
  const { t: tr } = useI18n();
  const { hands } = view;
  if (view.done) return null;
  return (
    <>
      <Press
        accessibilityRole="switch"
        accessibilityLabel={tr('Hands-free')}
        accessibilityState={{ checked: hands.on }}
        aria-checked={hands.on}
        onPress={view.toggle}
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: hands.on ? color.white : color.glass,
          borderWidth: 1,
          borderColor: hands.on ? color.white : color.glassBorder,
        }}
      >
        <Mic size={19} color={hands.on ? color.ink : color.white} strokeWidth={2} />
        {hands.on && (
          <View style={{ position: 'absolute', top: 9, right: 9 }}>
            <ListeningDot active={hands.status === 'listening'} />
          </View>
        )}
      </Press>
      <Explainer view={view} />
    </>
  );
}

/**
 * How hands-free is listening, for the line under cooking mode's title: why it paused, or what it
 * last heard, and a way back to what it can do. Nothing while it's off.
 */
export function HandsFreeStatus({ view }: { view: HandsFreeView }) {
  const { t: tr } = useI18n();
  const { hands } = view;
  if (view.done || !hands.on) return null;
  const state =
    hands.status === 'starting'
      ? tr('Starting…')
      : hands.status === 'paused'
        ? hands.liveCall
          ? tr('Paused during the live call')
          : tr('Paused while Savorly speaks')
        : hands.asking
          ? tr('Asking the chef…')
          : hands.waiting
            ? tr('Listening for your question…')
            : tr('Listening');
  return (
    <View style={[s.row, { gap: 6, flexShrink: 1 }]}>
      <Text
        accessibilityLiveRegion="polite"
        numberOfLines={1}
        style={[styles.status, { flexShrink: 0 }]}
      >
        {state}
      </Text>
      {!!hands.heard && !hands.answer && (
        <View key={hands.heard.n} style={[s.row, { gap: 4, flexShrink: 1 }]}>
          <Check size={12} color={color.white} strokeWidth={2.6} />
          <Text
            accessibilityLiveRegion="polite"
            numberOfLines={1}
            style={[styles.status, { color: color.white, flexShrink: 1 }]}
          >
            {tr('“{{v0}}”', { v0: hands.heard.text })}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('What can I say?')}
        hitSlop={10}
        onPress={() => view.explain(true)}
      >
        <Info size={13} color="rgba(255,255,255,0.72)" strokeWidth={2.2} />
      </Pressable>
    </View>
  );
}

/** Under the step: the answer to a "Chef, …" question, or why hands-free stopped. */
export function HandsFreeNote({ view }: { view: HandsFreeView }) {
  const { t: tr } = useI18n();
  const { hands } = view;
  if (view.done) return null;
  const web = Platform.OS === 'web';
  // Denied once or for good, the way back is the same: allow it where the platform keeps it.
  const allow = web
    ? tr('Allow the microphone for this site in your browser, then turn hands-free on again.')
    : tr(
        'Allow the microphone and speech recognition for Savorly in Settings, then turn hands-free on again.',
      );
  const problem =
    hands.problem &&
    {
      denied: allow,
      blocked: allow,
      unsupported: web
        ? tr("This browser can't recognize speech. Try Chrome or Safari, or tap through the steps.")
        : tr("This device doesn't offer speech recognition. You can still tap through the steps."),
      language: tr("Speech recognition here doesn't support this language yet."),
      microphone: tr(
        "Savorly couldn't use the microphone. Check that it's connected and not in use.",
      ),
      failed: tr(
        "Hands-free stopped because speech recognition isn't responding. Turn it on to try again.",
      ),
    }[hands.problem];
  if (problem)
    return (
      <View style={[s.row, { gap: 12, flexWrap: 'wrap' }]}>
        <Text
          accessibilityLiveRegion="polite"
          style={[s.small, { color: color.warningBg, flexShrink: 1 }]}
        >
          {problem}
        </Text>
        {hands.problem === 'blocked' && native && (
          <Button
            title={tr('Open settings')}
            variant="inverse"
            small
            onPress={() => void Linking.openSettings().catch(() => {})}
          />
        )}
      </View>
    );
  if (!hands.on || !hands.answer) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ gap: 4, padding: 14, borderRadius: radius.md, backgroundColor: color.glass }}
    >
      <Text numberOfLines={2} style={[s.small, { color: color.onInk }]}>
        {tr('“{{v0}}”', { v0: hands.answer.question })}
      </Text>
      {hands.answer.text ? (
        <Text
          style={{
            fontFamily: font.medium,
            fontSize: 15,
            lineHeight: 22,
            color: hands.answer.failed ? color.warningBg : color.white,
          }}
        >
          {hands.answer.text}
        </Text>
      ) : (
        <ActivityIndicator
          color={color.white}
          accessibilityLabel={tr('Asking the chef…')}
          style={{ alignSelf: 'flex-start' }}
        />
      )}
    </View>
  );
}

/** What hands-free hears and where, the first time it's turned on and from the status line's ⓘ. */
function Explainer({ view }: { view: HandsFreeView }) {
  const { t: tr, language } = useI18n();
  const app = useApp();
  const quote = (text: string) => tr('“{{v0}}”', { v0: text });
  const words = examples(language);
  const wake = wakeWord(language);
  const web = Platform.OS === 'web';
  const privacy =
    view.place === 'device'
      ? tr('Speech is recognized on this device, so what you say stays on it.')
      : web
        ? tr(
            "This browser sends what you say to its maker's speech service to turn it into text (Google in Chrome, Apple in Safari).",
          )
        : Platform.OS === 'ios'
          ? tr(
              "Apple's speech recognition turns what you say into text, so your audio goes to Apple.",
            )
          : tr(
              "Google's speech recognition turns what you say into text, so your audio goes to Google.",
            );
  const questions = app.capabilities?.cookingQuestions
    ? app.capabilities.plans
      ? tr("A question gets a short spoken answer and uses one of your plan's cooking questions.")
      : tr('A question gets a short spoken answer.')
    : tr("Questions aren't available right now. Commands still work.");
  const commands: [string, string[]][] = [
    [tr('Move between steps'), [words.next, words.previous]],
    [tr('Hear this step again'), [words.repeat]],
    [
      tr('Start, pause or resume the timer'),
      [words.startTimer, words.pauseTimer, words.resumeTimer],
    ],
    [tr('Stop reading'), [words.stopReading]],
    [tr('Hear the ingredients'), [words.ingredients, words.stepIngredients]],
    [tr('Finish cooking'), [words.done]],
  ];
  return (
    <Dialog
      visible={view.explaining}
      onClose={() => view.explain(false)}
      title={tr('Cook hands-free')}
    >
      <View style={{ gap: 14 }}>
        <Text style={s.muted}>
          {tr(
            "While cooking mode is open, Savorly listens for a few short commands. They're free and use none of your voice minutes.",
          )}
        </Text>
        <View style={{ gap: 10 }}>
          {commands.map(([label, said]) => (
            <View key={label} style={{ gap: 2 }}>
              <Text style={s.h3}>{label}</Text>
              <Text style={s.muted}>{said.map(quote).join(' · ')}</Text>
            </View>
          ))}
          <View style={{ gap: 2 }}>
            <Text style={s.h3}>{tr('Ask the sous-chef')}</Text>
            <Text style={s.muted}>{tr('“Chef, how long should this simmer?”')}</Text>
          </View>
        </View>
        <Text style={s.muted}>{questions}</Text>
        <Text style={s.small}>{privacy}</Text>
        <Text style={s.small}>
          {tr('Only the words of a question that starts with {{v0}} reach Savorly, as text.', {
            v0: quote(wake),
          })}
        </Text>
        <Text style={s.small}>
          {tr('Savorly stops listening while it speaks or reads a step, so it never hears itself.')}
        </Text>
        <Text style={s.small}>
          {tr(
            "For a conversation, the sous-chef's live voice is a tap away, using your plan's voice minutes.",
          )}
        </Text>
        <Button
          title={view.hands.on ? tr('Got it') : tr('Start listening')}
          icon={view.hands.on ? undefined : Mic}
          onPress={view.start}
        />
      </View>
    </Dialog>
  );
}

// Breathes while listening, unless the system asks for less motion; still while paused.
function ListeningDot({ active }: { active: boolean }) {
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!active || motionReduced()) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: native }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);
  return (
    <Animated.View
      style={{
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: active ? color.error : color.soft,
        opacity: pulse,
      }}
    />
  );
}

const styles = StyleSheet.create({
  status: {
    fontFamily: font.semibold,
    fontSize: 12,
    lineHeight: 16,
    color: 'rgba(255,255,255,0.72)',
  },
});
