import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useApp } from './store';
import { Recipe } from './types';

/** What cooking mode reports of a step: entered or left, its timer started, paused or run out. */
export type CookEvent = 'enter' | 'leave' | 'timer_start' | 'timer_pause' | 'timer_end';

/** A step that took this cook clearly longer than its timer: its 1-based place and the minutes. */
export type Overrun = { step: number; minutes: number; timer: number };

/**
 * The step that ran furthest over its timer, if one ran over by at least 2 minutes and a quarter
 * of the timer (as cook-tested notes count it), from the seconds spent on each step.
 */
export function overrunOf(recipe: Recipe, spent: Record<number, number>): Overrun | null {
  let best: Overrun | null = null;
  let most = 0;
  for (const [i, st] of recipe.steps.entries()) {
    const extra = (spent[i] ?? 0) - st.seconds;
    if (st.seconds > 0 && extra >= 120 && extra * 4 >= st.seconds && extra > most) {
      most = extra;
      best = {
        step: i + 1,
        minutes: Math.round(spent[i] / 60),
        timer: Math.round(st.seconds / 60),
      };
    }
  }
  return best;
}

/**
 * Records a run through cooking mode as a cook session: started when cooking mode opens
 * (POST /recipes/:id/cook-sessions), the furthest step as the cook moves on, and finished at
 * "Dinner is served" (PATCH /cook-sessions/:id). The server decides from it whether this was a
 * real cook, for the recipe's real cook time and the creator fund (docs/CREATOR-FUND.md).
 * Each step entered and left, and each timer started, paused and run out, goes with it as an
 * event (POST /cook-sessions/:id/events), unless the cook keeps their cooking out: from them the
 * server works out how long steps really take (docs/COOK-TESTED.md). Guests and a recipe's own
 * author record nothing, and cooking never waits on any of it: a request that fails is simply
 * dropped, and an older API without sessions answers with errors. It answers a function that
 * records a timer event on the step on screen, and, once the cook is done, whether the server
 * counted it as a verified cook and which step ran furthest over its timer, timed on the device
 * (visits under 5 seconds are glances, and one past the timer and half an hour a phone left on).
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
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    const current = session.current;
    // The first step is where every session starts.
    if (!current || (step === 0 && !done)) return;
    const body = done ? { step: steps, finished: true } : { step: step + 1 };
    void current.id.then((id) => {
      if (id)
        void api<{ verified?: unknown } | null>(`/cook-sessions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body,
        })
          .then((s) => done && s?.verified === true && setVerified(true))
          .catch(() => {});
    });
  }, [step, done, steps]);
  // Seconds on each step (0-based), for the "took you longer" prompt when the cook is done.
  const spent = useRef<Record<number, number>>({});
  const visit = useRef<{ step: number; at: number } | null>(null);
  const [overrun, setOverrun] = useState<Overrun | null>(null);
  useEffect(() => {
    const now = Date.now();
    const last = visit.current;
    if (last) {
      const ms = now - last.at;
      const limit = ((recipe.steps[last.step]?.seconds ?? 0) + 30 * 60) * 1000;
      if (ms >= 5000 && ms <= limit)
        spent.current[last.step] = (spent.current[last.step] ?? 0) + ms / 1000;
    }
    visit.current = done ? null : { step, at: now };
    setOverrun(done ? overrunOf(recipe, spent.current) : null);
  }, [step, done, recipe]);
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
  const timerEvent = useCallback(
    (kind: Exclude<CookEvent, 'enter' | 'leave'>) => record(kind, shown.current.step + 1),
    [record],
  );
  return { timerEvent, verified: done && verified, overrun };
}
