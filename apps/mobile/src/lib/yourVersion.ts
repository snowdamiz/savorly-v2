import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { FixDraft, FixKind, FixPart } from './recipeFixes';
import { Recipe } from './types';

/**
 * Your version of a recipe (docs/YOUR-VERSION.md): what a member changed in someone else's recipe
 * when they cooked it, kept one change per step or ingredient and applied over the recipe as it
 * is, so it opens their way next time while the author's own changes still arrive. A change
 * whose step or ingredient changed since no longer fits: it's the member's to keep or drop.
 */

export type RecipeEdit = {
  id: string;
  kind: Exclude<FixKind, 'missing_step'>;
  part: 'step' | 'ingredient';
  /** The step or ingredient's 1-based place now (when it fits), else where it was. */
  place: number;
  before: FixPart;
  after: FixPart;
  said: string;
  source: 'typed' | 'cooking' | 'sous_chef';
  fits: boolean;
  updatedAt: string;
};

export type KitchenNote = { id: string; note: string; source: string; createdAt: string };

/** What the page shows with the member's changes on it, and which lines they changed. */
export type Applied = {
  recipe: Recipe;
  /** 0-based steps and ingredients the member changed. */
  steps: Set<number>;
  ingredients: Set<number>;
};

/**
 * The recipe with the changes that fit applied, by place: the steps and ingredients keep their
 * order in a translation, so this works on the translated recipe too.
 */
export function applyEdits(recipe: Recipe, edits: RecipeEdit[]): Applied {
  const steps = new Set<number>();
  const ingredients = new Set<number>();
  if (!edits.some((e) => e.fits)) return { recipe, steps, ingredients };
  const next = { ...recipe, steps: [...recipe.steps], ingredients: [...recipe.ingredients] };
  for (const e of edits) {
    if (!e.fits) continue;
    const n = e.place - 1;
    if (e.part === 'step' && next.steps[n]) {
      next.steps[n] = {
        ...next.steps[n],
        text: e.after.text ?? next.steps[n].text,
        seconds: e.after.seconds ?? next.steps[n].seconds,
      };
      steps.add(n);
    }
    if (e.part === 'ingredient' && next.ingredients[n]) {
      next.ingredients[n] = {
        ...next.ingredients[n],
        name: e.after.name ?? next.ingredients[n].name,
        amount: e.after.amount ?? next.ingredients[n].amount,
        unit: e.after.unit ?? next.ingredients[n].unit,
      };
      ingredients.add(n);
    }
  }
  return { recipe: next, steps, ingredients };
}

/**
 * The member's changes to someone else's published recipe, when `enabled`. An older API, or a
 * failure, leaves none, and the recipe reads as written.
 */
export function useYourVersion(recipeId: string, enabled: boolean) {
  const [state, setState] = useState<{ id: string; edits: RecipeEdit[] } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<{ edits?: RecipeEdit[] }>(`/recipes/${encodeURIComponent(recipeId)}/my-version`)
      .then((v) => live && Array.isArray(v?.edits) && setState({ id: recipeId, edits: v.edits }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [recipeId, enabled, version]);
  const edits = useMemo(
    () => (enabled && state?.id === recipeId ? state.edits : []),
    [enabled, state, recipeId],
  );
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  return { edits, reload };
}

/** Keeps a change in the member's version: it answers the change, and the one it replaced. */
export const keepEdit = (recipeId: string, draft: FixDraft, source: RecipeEdit['source']) =>
  api<{ edit: RecipeEdit; replaced: RecipeEdit | null }>(
    `/recipes/${encodeURIComponent(recipeId)}/my-version`,
    {
      method: 'PUT',
      body: {
        kind: draft.kind,
        ...(draft.ingredient ? { ingredient: draft.ingredient } : { step: draft.step }),
        change: draft.change,
        said: draft.reason ?? '',
        source,
      },
    },
  );

export const dropEdit = (id: string) =>
  api(`/recipe-edits/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** A change as a suggestion to the recipe's cook would start out (docs/RECIPE-FIXES.md). */
export const editDraft = (e: RecipeEdit): FixDraft => ({
  kind: e.kind,
  ...(e.part === 'ingredient' ? { ingredient: e.place } : { step: e.place }),
  change: e.after,
  reason: e.said,
});
