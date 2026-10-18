import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Creator } from './types';

/**
 * Recipe fixes from cooks (docs/RECIPE-FIXES.md): a member who cooked a recipe through in cooking
 * mode can suggest a change to one part of it, other cooks who made it can say "same for me", and
 * its author accepts (as it is or edited), declines, or later undoes an accepted one.
 */

export type FixKind = 'time' | 'heat' | 'note' | 'missing_step' | 'amount' | 'swap';
export type FixPartKind = 'step' | 'new_step' | 'ingredient';

/** The part of the recipe a fix changes, as it is and as the cook would have it. */
export type FixPart = {
  title?: string;
  text?: string;
  seconds?: number;
  name?: string;
  amount?: number;
  unit?: string;
};

export const fixPart: Record<FixKind, FixPartKind> = {
  time: 'step',
  heat: 'step',
  note: 'step',
  missing_step: 'new_step',
  amount: 'ingredient',
  swap: 'ingredient',
};

export type Suggestion = {
  id: string;
  kind: FixKind;
  part: FixPartKind;
  /** Where its part is in the recipe now (when it fits), else where it was: 1-based, or for a
   * missing step the step it follows (0 for the start). */
  place: number;
  before: FixPart;
  after: FixPart;
  reason: string;
  /** Waiting, or `stale` once it waited 30 days: it then reads as a cook's note. */
  status: 'open' | 'stale';
  /** False once the recipe changed there since: it can no longer be accepted. */
  fits: boolean;
  votes: number;
  voted: boolean;
  mine: boolean;
  createdAt: string;
  author: Pick<Creator, 'id' | 'name' | 'handle' | 'avatar'>;
};

/** One accepted fix in a recipe's history. */
export type FixVersion = {
  id: string;
  number: number;
  kind: FixKind | '';
  part: FixPartKind | '';
  before: FixPart;
  after: FixPart;
  createdAt: string;
  by: Pick<Creator, 'id' | 'name' | 'handle' | 'avatar'> | null;
  /** The author's only: nothing changed the recipe since, so it can still be taken back. */
  undoable: boolean;
  suggestionId: string;
};

/** What a cook fills in to suggest a fix: the kind, the part, and the change. */
export type FixDraft = {
  kind: FixKind;
  /** A step's 1-based place, or the step a missing one goes after (0 for the start). */
  step?: number;
  /** An ingredient's 1-based place. */
  ingredient?: number;
  change: FixPart;
  reason?: string;
};

/**
 * A recipe's waiting suggestions and whether the viewer may suggest one. An older API, or a
 * failure, leaves them empty and the recipe reads as before.
 */
export function useSuggestions(recipeId: string, enabled = true) {
  const [state, setState] = useState<{
    id: string;
    canSuggest: boolean;
    suggestions: Suggestion[];
  } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<{ canSuggest?: boolean; suggestions?: Suggestion[] }>(
      `/recipes/${encodeURIComponent(recipeId)}/suggestions`,
    )
      .then((v) => {
        if (live && Array.isArray(v?.suggestions))
          setState({ id: recipeId, canSuggest: !!v.canSuggest, suggestions: v.suggestions });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [recipeId, enabled, version]);
  const current = state?.id === recipeId ? state : null;
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const replace = useCallback(
    (s: Suggestion) =>
      setState(
        (v) => v && { ...v, suggestions: v.suggestions.map((x) => (x.id === s.id ? s : x)) },
      ),
    [],
  );
  return {
    canSuggest: current?.canSuggest ?? false,
    suggestions: current?.suggestions ?? [],
    reload,
    replace,
  };
}

/** Sends a suggestion; the server answers it as the recipe now shows it. */
export const sendSuggestion = (recipeId: string, draft: FixDraft) =>
  api<Suggestion>(`/recipes/${encodeURIComponent(recipeId)}/suggestions`, {
    method: 'POST',
    body: draft,
  });

/** Minutes for a timer of `seconds`, rounded, never below 1. */
export const minutesOf = (seconds?: number) => Math.max(1, Math.round((seconds ?? 0) / 60));
