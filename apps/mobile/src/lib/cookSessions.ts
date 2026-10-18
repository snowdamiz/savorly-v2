import { useCallback, useEffect, useRef } from 'react';
import { api } from './api';
import { useApp } from './store';
import { Recipe } from './types';

/** What cooking mode reports of a step: entered or left, its timer started, paused or run out. */
export type CookEvent = 'enter' | 'leave' | 'timer_start' | 'timer_pause' | 'timer_end';

/**
 * Records a run through cooking mode as a cook session: started when cooking mode opens
 * (POST /recipes/:id/cook-sessions), the furthest step as the cook moves on, and finished at
 * "Dinner is served" (PATCH /cook-sessions/:id). The server decides from it whether this was a
 * real cook, for the recipe's real cook time and the creator fund (docs/CREATOR-FUND.md).
 * Each step entered and left, and each timer started, paused and run out, goes with it as an
 * event (POST /cook-sessions/:id/events), unless the cook keeps their cooking out: from them the
 * server works out how long steps really take (docs/COOK-TESTED.md). Guests and a recipe's own
 * author record nothing, and cooking never waits on any of it: a request that fails is simply
 * dropped, and an older API without sessions answers with errors. The returned function records a
 * timer event on the step on screen.
 */
export function useCookSession(recipe: Recipe, step: number, done: boolean) {
  const { user } = useApp();
  const counts = !!user && recipe.published && recipe.author.id !== user.id;
  const sharing = counts && user?.preferences?.shareCooking !== false;
  // One session each time cooking mode opens, even if the effect runs twice.
  const session = useRef<{ recipe: string; id: Promise<string | null>; seq: number } | null>(null);
  useEffect(() => {
    if (!counts || session.current?.recipe === recipe.id) return;
    session.current = {
      recipe: recipe.id,
      seq: 0,
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
  // Numbered as they happen, so a retried request never counts one twice.
  const record = useCallback(
    (kind: CookEvent, n: number) => {
      const current = session.current;
      if (!current || !sharing) return;
      const event = { seq: current.seq++, kind, step: n, at: Date.now() };
      void current.id.then((id) => {
        if (id)
          void api(`/cook-sessions/${encodeURIComponent(id)}/events`, {
            method: 'POST',
            body: { events: [event] },
          }).catch(() => {});
      });
    },
    [sharing],
  );
  // Entering a step leaves the one before; finishing, or closing cooking mode, leaves the last.
  const shown = useRef({ step, done });
  useEffect(() => {
    shown.current = { step, done };
    record(done ? 'leave' : 'enter', done ? steps : step + 1);
  }, [step, done, steps, record]);
  useEffect(
    () => () => {
      if (!shown.current.done) record('leave', shown.current.step + 1);
    },
    [record],
  );
  return useCallback(
    (kind: Exclude<CookEvent, 'enter' | 'leave'>) => record(kind, shown.current.step + 1),
    [record],
  );
}
