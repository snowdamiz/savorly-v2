import { useEffect, useState } from 'react';
import { api } from './api';
import { Recipe } from './types';

/**
 * What cooks found cooking a recipe in Savorly (docs/COOK-TESTED.md): how long its steps really
 * take, where cooks stop, how many finish, and the questions they keep asking, with answers. The
 * server works it out each night from cooking mode's step events and the questions asked while
 * cooking, and only from enough cooks that nobody's own numbers or words show.
 */

/** Verified cooks that make a recipe cook-tested; fewer show as early. */
export const COOK_TESTED_COOKS = 5;

export const cookTested = (r: Pick<Recipe, 'verifiedCooks'>) =>
  (r.verifiedCooks ?? 0) >= COOK_TESTED_COOKS;

/** What a step's numbers tell cooks: it runs over its timer, or how long one without a timer takes. */
export type StepNote = { kind: 'longer' | 'usual'; minutes: number };

/** A question cooks keep asking at a step; `checked` when its answer is the recipe's author's. */
export type StepQuestion = {
  id: string;
  question: string;
  answer: string;
  checked: boolean;
  /** The author's view only: how many cooks asked it, and whether it's hidden from cooks. */
  askers?: number;
  hidden?: boolean;
};

/** One step's insights, by its 1-based place in the recipe as it is now. */
export type StepInsight = {
  step: number;
  /** Sessions that spent time on it; its numbers show from 5. */
  sessions: number;
  medianSeconds?: number;
  p75Seconds?: number;
  timerSeconds: number;
  note: StepNote | null;
  questions: StepQuestion[];
  /** The author's view only: sessions that reached the step, and how many stopped there. */
  entered?: number;
  gaveUp?: number;
};

export type RecipeInsights = {
  /** Sessions that are over (finished, or a day old) and how many of them finished. */
  sessions: number;
  finished: number;
  /** From 20 sessions; null before. */
  finishRate: number | null;
  steps: StepInsight[];
  computedAt: string | null;
};

/** The author's "Where cooks get stuck": every step, with the recipe's verified cooks. */
export type AuthorInsights = RecipeInsights & {
  verifiedCooks: number;
  cookedMinutes: number | null;
};

/**
 * A recipe's insights for cooks, or null until they load. An older API, or a failure, leaves
 * them null: the recipe reads exactly as before.
 */
export function useCookInsights(recipeId: string): RecipeInsights | null {
  const [insights, setInsights] = useState<{ id: string; value: RecipeInsights } | null>(null);
  useEffect(() => {
    let live = true;
    api<RecipeInsights>(`/recipes/${encodeURIComponent(recipeId)}/insights`)
      .then((value) => {
        if (live && value && Array.isArray(value.steps)) setInsights({ id: recipeId, value });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [recipeId]);
  return insights?.id === recipeId ? insights.value : null;
}

/** The insight for 1-based step `n`, if it has anything to say. */
export const stepInsight = (insights: RecipeInsights | null, n: number) =>
  insights?.steps.find((s) => s.step === n);

/**
 * How long cooks usually need at a step that runs over its timer, in whole minutes as seconds,
 * or null when the timer is about right (or there's no telling).
 */
export function cooksNeed(insight?: StepInsight): number | null {
  if (insight?.note?.kind !== 'longer' || !insight.medianSeconds) return null;
  return Math.max(60, Math.round(insight.medianSeconds / 60) * 60);
}

/**
 * "Finished by 9 in 10 who started": tenths rounded down, so 96% is still 9 in 10, and everyone
 * only when everyone did.
 */
export function finishedTenths(rate: number) {
  return rate >= 1 ? 10 : Math.max(1, Math.floor(rate * 10));
}
