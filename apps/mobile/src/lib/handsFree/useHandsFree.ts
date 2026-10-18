import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, ApiError } from '../api';
import { haptic } from '../haptics';
import { languages, useI18n, type Language } from '../i18n';
import { speechLanguage } from '../narration/useCookingNarration';
import { useApp } from '../store';
import type { Recipe } from '../types';
import { hear, hints, type HandsFreeCommand } from './grammar';
import { ingredientsOf, spokenIngredient, spokenList } from './ingredients';
import { HandsFreeListener, type ListenerProblem, type ListenerStatus } from './listener';
import type { RecognitionPlace } from './recognition';
import { recognition } from './recognizer';
import { say, useLiveCall, type Spoken } from './speech';

/** What cooking mode lets hands-free see and do. */
export type CookControls = {
  /** The 0-based step on screen. */
  step: number;
  /** Cooking is finished: the screen after the last step. */
  done: boolean;
  /** The step is being read aloud. */
  reading: boolean;
  /** The step's timer: its length (0 for none), what's left, and whether it runs. */
  timer: { seconds: number; remaining: number; running: boolean };
  /** The next step, or finishing after the last, as the Next button does. */
  next: () => void;
  previous: () => void;
  read: () => void;
  stopReading: () => void;
  setTimer: (running: boolean) => void;
  /**
   * Cooking several dishes at once (docs/MEAL-TIMELINE.md): the step's place in the meal, so
   * moving to another dish's step reads it too; whether next finishes the meal; and whether the
   * step's own timer starts when it's done, so "start the timer" is done with it. `timer` is then
   * the dishes' timer that ends first, for pausing and resuming.
   */
  meal?: { position: number; last: boolean; startsTimer: boolean };
};

/** How long the wake word alone waits for its question. */
const WAITING_MS = 8000;
const problems: ListenerStatus[] = [
  'denied',
  'blocked',
  'unsupported',
  'language',
  'microphone',
  'failed',
];

/** The locale to recognize the app's language in: the app's own when it's that language. */
function listeningLocale(language: Language, locale: string) {
  const fallback = languages.find((item) => item.code === language)?.locale ?? 'en-US';
  // Recognizers know zh-CN, not script subtags such as zh-Hans-CN.
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(locale) && locale.startsWith(language) ? locale : fallback;
}

/**
 * Hands-free cooking for cooking mode: listens on the device while it's on, carries out the
 * commands it hears through `cook`, reads replies with device speech, and sends "Chef, …"
 * questions to the sous-chef.
 */
export function useHandsFree(recipe: Recipe, cook: CookControls) {
  const { t: tr, language, locale } = useI18n();
  const app = useApp();
  const liveCall = useLiveCall();
  const [status, setStatus] = useState<ListenerStatus>('off');
  const [place, setPlace] = useState<RecognitionPlace | null>(null);
  /** The last command heard, shown with a check. */
  const [heard, setHeard] = useState<{ text: string; n: number } | null>(null);
  const [answer, setAnswer] = useState<{ question: string; text: string; failed: boolean } | null>(
    null,
  );
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const listener = useRef<HandsFreeListener | null>(null);
  const spoken = useRef<ReturnType<typeof say> | null>(null);
  const question = useRef<AbortController | null>(null);
  const waitingUntil = useRef(0);
  const readAfterMove = useRef(false);
  const heardCount = useRef(0);
  const listening = listeningLocale(language, locale);
  const latest = useRef({ recipe, cook, tr, app, language, locale, listening });
  useEffect(() => {
    latest.current = { recipe, cook, tr, app, language, locale, listening };
  });

  const speak = useCallback((parts: Spoken[] | string) => {
    spoken.current?.cancel();
    const { locale: voice } = latest.current;
    const words = say(typeof parts === 'string' ? [{ text: parts, language: voice }] : parts);
    spoken.current = words;
    listener.current?.hold('speaking', true);
    void words.done.then(() => {
      if (spoken.current !== words) return;
      spoken.current = null;
      listener.current?.hold('speaking', false);
    });
  }, []);

  const quiet = useCallback(() => {
    spoken.current?.cancel();
    question.current?.abort();
    question.current = null;
    setAsking(false);
  }, []);

  const ask = useCallback(
    async (text: string) => {
      const { app, recipe, cook, tr, language } = latest.current;
      setWaiting(false);
      waitingUntil.current = 0;
      const reply = (said: string, failed: boolean) => {
        setAnswer({ question: text, text: said, failed });
        speak(said);
      };
      if (!app.user) return reply(tr('Sign in to ask the chef. Commands still work.'), true);
      if (!app.capabilities?.cookingQuestions)
        return reply(tr("Questions aren't available right now. Commands still work."), true);
      question.current?.abort();
      const controller = new AbortController();
      question.current = controller;
      setAnswer({ question: text, text: '', failed: false });
      setAsking(true);
      try {
        const { answer } = await api<{ answer: string }>(
          `/recipes/${encodeURIComponent(recipe.id)}/ask`,
          {
            method: 'POST',
            body: { question: text, step: cook.step + 1, language },
            signal: controller.signal,
          },
        );
        if (question.current === controller) reply(answer, false);
      } catch (error) {
        if (question.current !== controller) return;
        reply(
          error instanceof ApiError
            ? `${tr(error.message)} ${tr('Commands still work.')}`
            : tr("I couldn't reach the chef. Commands still work."),
          true,
        );
      } finally {
        if (question.current === controller) {
          question.current = null;
          setAsking(false);
        }
      }
    },
    [speak],
  );

  const timer = useCallback(
    (want: 'start' | 'resume' | 'pause') => {
      const { cook, tr } = latest.current;
      const { seconds, remaining, running } = cook.timer;
      // In a meal, the step's timer runs on its own once it's done: the next step is read, with
      // what's running.
      if (cook.meal?.startsTimer && want === 'start') {
        quiet();
        readAfterMove.current = true;
        cook.next();
        return;
      }
      if (!seconds) return speak(tr('This step has no timer.'));
      if (want === 'pause') {
        if (!running) return speak(tr("The timer isn't running."));
        cook.setTimer(false);
        return speak(tr('Timer paused.'));
      }
      if (running) return speak(tr('The timer is already running.'));
      if (!remaining) return speak(tr('The timer has finished.'));
      cook.setTimer(true);
      speak(remaining < seconds ? tr('Timer resumed.') : tr('Timer started.'));
    },
    [speak, quiet],
  );

  const ingredients = useCallback(
    (forStep: boolean) => {
      const { recipe, cook, tr, locale } = latest.current;
      // Ingredients are the recipe's words: read in its language, after the app's own sentence.
      const theirs = speechLanguage(locale, recipe.language);
      const items = forStep
        ? ingredientsOf(recipe.steps[cook.step], recipe.ingredients)
        : recipe.ingredients;
      if (!items.length) return speak(tr("This step doesn't name any of the ingredients."));
      speak([
        {
          text: forStep ? tr('Here’s what this step uses.') : tr('Here are the ingredients.'),
          language: locale,
        },
        {
          text: spokenList(
            items.map((item) => spokenIngredient(item, theirs)),
            theirs,
          ),
          language: theirs,
        },
      ]);
    },
    [speak],
  );

  const run = useCallback(
    (command: HandsFreeCommand) => {
      const { recipe, cook, tr } = latest.current;
      const last = cook.meal ? cook.meal.last : cook.step >= recipe.steps.length - 1;
      switch (command) {
        case 'next':
        case 'done':
          // "Done" is done with this step: the Next button's job, finishing after the last.
          quiet();
          if (last) {
            cook.next();
            speak(tr('Dinner is served.'));
          } else {
            readAfterMove.current = true;
            cook.next();
          }
          return;
        case 'previous':
          quiet();
          if (cook.meal ? cook.meal.position === 0 : cook.step === 0)
            return speak(tr('This is the first step.'));
          readAfterMove.current = true;
          cook.previous();
          return;
        case 'repeat':
          quiet();
          cook.read();
          return;
        case 'startTimer':
          return timer('start');
        case 'resumeTimer':
          return timer('resume');
        case 'pauseTimer':
          return timer('pause');
        case 'stopReading':
          quiet();
          cook.stopReading();
          return;
        case 'ingredients':
          return ingredients(false);
        case 'stepIngredients':
          return ingredients(true);
      }
    },
    [quiet, speak, timer, ingredients],
  );

  // One final transcript from the listener.
  const utterance = useCallback(
    (text: string) => {
      const { language, tr } = latest.current;
      const meaning = hear(text, language);
      const awaited = waitingUntil.current > Date.now();
      if (meaning.kind === 'command') {
        setWaiting(false);
        waitingUntil.current = 0;
        haptic.tap();
        setHeard({ text, n: ++heardCount.current });
        setAnswer(null);
        return run(meaning.command);
      }
      if (meaning.kind === 'question') return void ask(meaning.question);
      if (meaning.kind === 'wake') {
        haptic.tap();
        waitingUntil.current = Date.now() + WAITING_MS;
        setWaiting(true);
        return speak(tr('Yes?'));
      }
      // After the wake word alone, whatever comes next is the question.
      if (awaited) void ask(text);
    },
    [ask, run, speak],
  );

  const handle = useRef(utterance);
  useEffect(() => {
    handle.current = utterance;
  }, [utterance]);
  useEffect(() => {
    const created = new HandsFreeListener({
      recognition,
      language: latest.current.listening,
      hints: hints(latest.current.language),
      onStatus: setStatus,
      onPlace: setPlace,
      onUtterance: (text) => handle.current(text),
    });
    listener.current = created;
    return () => {
      created.dispose();
      listener.current = null;
      spoken.current?.cancel();
      question.current?.abort();
    };
  }, []);
  useEffect(() => {
    listener.current?.setLanguage(listening, hints(language));
  }, [listening, language]);

  // Never listening to itself or over the live call, and never from the background.
  useEffect(() => {
    listener.current?.hold('reading', cook.reading);
  }, [cook.reading]);
  useEffect(() => {
    listener.current?.hold('call', liveCall);
  }, [liveCall]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) =>
      listener.current?.hold('background', state !== 'active'),
    );
    return () => sub.remove();
  }, []);

  // A step reached by voice is read out, once cooking mode has moved to it (and its narration
  // has selected the step, which its own effect does after this one).
  useEffect(() => {
    if (!readAfterMove.current) return;
    readAfterMove.current = false;
    const id = setTimeout(() => latest.current.cook.read(), 0);
    return () => clearTimeout(id);
  }, [cook.step, cook.meal?.position]);

  // The wake word's wait for its question runs out.
  useEffect(() => {
    if (!waiting) return;
    const id = setTimeout(() => setWaiting(false), WAITING_MS);
    return () => clearTimeout(id);
  }, [waiting]);

  const turnOff = useCallback(() => {
    listener.current?.disable();
    quiet();
    setWaiting(false);
    setHeard(null);
    setAnswer(null);
  }, [quiet]);
  const turnOn = useCallback(() => {
    void listener.current?.enable();
  }, []);
  // The finished screen has nothing left to say.
  useEffect(() => {
    if (cook.done) listener.current?.disable();
  }, [cook.done]);

  const on = status === 'starting' || status === 'listening' || status === 'paused';
  return {
    on,
    status,
    /** Why listening stopped by itself, if it did. */
    problem: problems.includes(status) ? (status as ListenerProblem) : null,
    place,
    liveCall,
    heard,
    answer,
    asking,
    waiting,
    turnOn,
    turnOff,
  };
}
