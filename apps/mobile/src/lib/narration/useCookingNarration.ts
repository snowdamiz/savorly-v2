import { useCallback, useEffect, useRef, useState } from 'react';
import * as Speech from 'expo-speech';
import { api } from '../api';
import { useApp } from '../store';
import type { Recipe } from '../types';
import { CookingNarration, NarrationState } from './controller';
import { narrationPlayer } from './player';

export function useCookingNarration(recipe: Recipe, step: number) {
  const app = useApp();
  const [state, setState] = useState<NarrationState>('idle');
  const controller = useRef<CookingNarration | null>(null);
  const texts = JSON.stringify(recipe.steps.map((s) => s.text));
  const enabled = Boolean(app.capabilities?.cookingNarration && app.user);
  const owner = app.user?.id;
  useEffect(() => {
    const narration = new CookingNarration({
      enabled,
      texts: JSON.parse(texts),
      prepare: async (index, text) => {
        const response = await api<{ path: string }>(
          `/recipes/${encodeURIComponent(recipe.id)}/steps/${index}/narration`,
          { method: 'POST', body: { text } },
        );
        return response.path;
      },
      player: narrationPlayer,
      speak: (text, done) => Speech.speak(text, { onDone: done, onError: done, onStopped: done }),
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
  }, [recipe.id, texts, enabled, owner]);
  useEffect(() => {
    controller.current?.select(step);
  }, [step, recipe.id, texts, enabled, owner]);
  const stop = useCallback(() => controller.current?.stop(), []);
  const read = useCallback(() => controller.current?.read(), []);
  return { state, speaking: state === 'playing' || state === 'loading', read, stop };
}
