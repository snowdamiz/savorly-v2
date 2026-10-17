import { useEffect, useRef } from 'react';
import { api } from './api';
import { useApp } from './store';
import { Recipe } from './types';

/**
 * Records a run through cooking mode as a cook session: started when cooking mode opens
 * (POST /recipes/:id/cook-sessions), the furthest step as the cook moves on, and finished at
 * "Dinner is served" (PATCH /cook-sessions/:id). The server decides from it whether this was a
 * real cook, for the recipe's real cook time and the creator fund (docs/CREATOR-FUND.md).
 * Guests and a recipe's own author record nothing, and cooking never waits on any of it: a
 * request that fails is simply dropped, and an older API without sessions answers with errors.
 */
export function useCookSession(recipe: Recipe, step: number, done: boolean) {
  const { user } = useApp();
  const counts = !!user && recipe.published && recipe.author.id !== user.id;
  // One session each time cooking mode opens, even if the effect runs twice.
  const session = useRef<{ recipe: string; id: Promise<string | null> } | null>(null);
  useEffect(() => {
    if (!counts || session.current?.recipe === recipe.id) return;
    session.current = {
      recipe: recipe.id,
      id: api<{ id?: unknown } | null>(`/recipes/${encodeURIComponent(recipe.id)}/cook-sessions`, {
        method: 'POST',
      })
        .then((s) => (typeof s?.id === 'string' ? s.id : null))
        .catch(() => null),
    };
  }, [counts, recipe.id]);
  const steps = recipe.steps.length;
  useEffect(() => {
    const current = session.current;
    // The first step is where every session starts.
    if (!current || (step === 0 && !done)) return;
    const body = done ? { step: steps, finished: true } : { step: step + 1 };
    void current.id.then((id) => {
      if (id)
        void api(`/cook-sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body }).catch(
          () => {},
        );
    });
  }, [step, done, steps]);
}
