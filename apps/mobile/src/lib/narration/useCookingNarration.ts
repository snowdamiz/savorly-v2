import { useCallback, useEffect, useRef, useState } from 'react';
import * as Speech from 'expo-speech';
import { api, NetworkError, unreachable } from '../api';
import { languages, useI18n } from '../i18n';
import { useApp } from '../store';
import type { Recipe } from '../types';
import { cachedNarration, keepNarration, narrationNamed, type NarratedStep } from './cache';
import { CookingNarration, NarrationState } from './controller';
import { narrationPlayer } from './player';

/**
 * The voice device speech reads a step in. Steps are written in the recipe's own language, which
 * can differ from the app's: a French recipe is read in French in an English app. The app's own
 * locale wins when it's the same language (en-GB stays British), and recipes that don't say which
 * language they're in are read in the app's.
 */
export function speechLanguage(appLocale: string, recipeLanguage?: string | null) {
  const tag = (recipeLanguage || '').trim().replace(/_/g, '-');
  const code = tag.toLowerCase().split('-')[0];
  if (!code || appLocale.toLowerCase().split(/[-_]/)[0] === code) return appLocale;
  if (tag.includes('-')) return tag;
  return languages.find((language) => language.code === code)?.locale ?? tag;
}

export function useCookingNarration(recipe: Recipe, step: number) {
  const app = useApp();
  const { locale } = useI18n();
  const [state, setState] = useState<NarrationState>('idle');
  const controller = useRef<CookingNarration | null>(null);
  const texts = JSON.stringify(recipe.steps.map((s) => s.text));
  const owner = app.user?.id;
  // Launched without a connection, the server's capabilities are unknown; the recordings kept on
  // this device (cache.ts) still read in its voice.
  const natural = app.capabilities ? !!app.capabilities.cookingNarration : app.offline;
  const enabled = Boolean(natural && owner);
  // Known to be offline, steps go straight to the device's copies rather than wait on the network.
  const offline = useRef(app.offline);
  useEffect(() => {
    offline.current = app.offline;
  }, [app.offline]);
  useEffect(() => {
    const language = recipe.language ?? '';
    const narrated = (index: number, text: string): NarratedStep => ({
      owner: owner ?? '',
      recipe: recipe.id,
      language,
      step: index,
      text,
    });
    const narration = new CookingNarration({
      enabled,
      texts: JSON.parse(texts),
      prepare: async (index, text) => {
        if (offline.current) throw new NetworkError('Offline: narration plays from this device.');
        const response = await api<{ path: string }>(
          `/recipes/${encodeURIComponent(recipe.id)}/steps/${index}/narration`,
          { method: 'POST', body: { text } },
        );
        narrationNamed(narrated(index, text), response.path);
        return response.path;
      },
      kept: (index, text, path) => cachedNarration(narrated(index, text), path),
      keep: (index, text, path) => keepNarration(narrated(index, text), path),
      unreachable,
      player: narrationPlayer,
      speak: (text, done) =>
        Speech.speak(text, {
          language: speechLanguage(locale, recipe.language),
          onDone: done,
          onError: done,
          onStopped: done,
        }),
      stopSpeech: () => {
        void Speech.stop();
      },
      state: setState,
    });
    controller.current = narration;
    return () => {
      narration.dispose();
      controller.current = null;
    };
  }, [recipe.id, recipe.language, texts, enabled, owner, locale]);
  useEffect(() => {
    controller.current?.select(step);
  }, [step, recipe.id, recipe.language, texts, enabled, owner, locale]);
  const stop = useCallback(() => controller.current?.stop(), []);
  const read = useCallback(() => controller.current?.read(), []);
  return { state, speaking: state === 'playing' || state === 'loading', read, stop };
}
