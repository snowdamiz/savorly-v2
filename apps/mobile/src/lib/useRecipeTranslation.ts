import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, NetworkError } from './api';
import { useI18n } from './i18n';
import { useApp } from './store';
import {
  fingerprint,
  keepTranslation,
  keptTranslation,
  translatable,
  translated,
} from './translation';
import type { Recipe, RecipeTranslation } from './types';

// "Always translate recipes", once chosen, stays chosen for the session: a guest's only copy, and
// a signed-in cook's until the profile it was chosen over changes, or someone else signs in (as
// the units do, Units.tsx).
let picked: { user: string | null; on: boolean; over: boolean } | null = null;

/** Whether recipes in other languages open translated, and a setter that saves it with the cook. */
export function useAlwaysTranslate() {
  const app = useApp();
  const user = app.user?.id ?? null;
  const saved = app.user?.preferences?.translateRecipes === true;
  const [chosen, setChosen] = useState<boolean | null>(null);
  const session = picked && picked.user === user && picked.over === saved ? picked.on : null;
  const on = chosen ?? session ?? saved;
  // Saved one after another, so quick changes can't leave an older choice on the profile.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const { act } = app;
  const choose = useCallback(
    (next: boolean) => {
      setChosen(next);
      picked = { user, on: next, over: saved };
      if (!user) return;
      saving.current = saving.current.then(() =>
        act(() => api('/me/preferences', { method: 'PATCH', body: { translateRecipes: next } })),
      );
    },
    [user, saved, act],
  );
  return [on, choose] as const;
}

export type TranslationStatus = 'original' | 'loading' | 'translated' | 'failed';
type State = {
  /** What it is for: the recipe, as it reads, and the language (see `key` below). */
  key: string;
  status: TranslationStatus;
  translation: RecipeTranslation | null;
  error: string;
  /** Turned down because only signed-in cooks start a translation: the bar offers to sign in. */
  signIn: boolean;
};
const start = (key: string, status: TranslationStatus = 'original'): State => ({
  key,
  status,
  translation: null,
  error: '',
  signIn: false,
});

/**
 * The recipe page's translation: whether the recipe can be read in the app's language, the recipe
 * as it shows (`shown`: translated, or as written), and what the cook can do. The first time is a
 * tap; with "Always translate recipes" on, recipes open translated. A translation the device kept
 * shows at once, offline too; online the API is still asked, which keeps its copy in use.
 */
export function useRecipeTranslation(recipe: Recipe) {
  const app = useApp();
  const { language } = useI18n();
  const [always, setAlways] = useAlwaysTranslate();
  const can = translatable(recipe, language);
  const print = useMemo(() => fingerprint(recipe), [recipe]);
  const key = `${recipe.id}:${print}:${language}`;
  const [state, setState] = useState<State>(() => start(key));
  // Another recipe, version or language starts as written.
  const current = state.key === key ? state : start(key);
  // The device has a translation of it (`key`), which works where the server can't translate.
  const [kept, setKept] = useState<string | null>(null);
  const asked = useRef(0);
  const latest = useRef(recipe);
  const { offline } = app;
  const request = useCallback(
    async (auto: boolean) => {
      const n = ++asked.current;
      const stale = () => n !== asked.current;
      const recipe = latest.current;
      setState(start(key, 'loading'));
      const copy = await keptTranslation(recipe, language);
      if (stale()) return;
      if (copy) {
        setState({ ...start(key, 'translated'), translation: copy });
        if (offline) return;
      }
      try {
        const answer = await api<RecipeTranslation>(
          `/recipes/${encodeURIComponent(recipe.id)}/translation?language=${language}`,
          // The model can take a while, and a failed translation is asked for again only when the
          // cook asks: it costs.
          { timeout: 95_000, retry: false },
        );
        if (stale()) return;
        // A translation of another version of the recipe than the one on screen.
        if (!translated(recipe, answer))
          throw new Error('We couldn’t translate this recipe. Please try again.');
        keepTranslation(recipe, answer);
        setState({ ...start(key, 'translated'), translation: answer });
      } catch (e) {
        if (stale() || copy) return;
        // Opened translated on its own: a failure leaves the recipe as written, with the offer.
        if (auto) return setState(start(key));
        setState({
          ...start(key, 'failed'),
          // A gateway error is the API's own sentence here (a failed translation is a 502).
          error:
            e instanceof NetworkError
              ? 'You’re offline. Translate this recipe once you’re back online.'
              : (e as Error).message,
          signIn: e instanceof ApiError && e.status === 401,
        });
      }
    },
    [key, language, offline],
  );
  const status = current.status;
  const auto = useRef({ status, request });
  useEffect(() => {
    latest.current = recipe;
    auto.current = { status, request };
  });
  useEffect(() => {
    // Whatever was on its way was for another recipe, version or language.
    asked.current++;
    if (!can) return;
    let live = true;
    void keptTranslation(latest.current, language).then((copy) => {
      if (live && copy) setKept(key);
    });
    return () => {
      live = false;
    };
  }, [key, can, language]);
  // With "Always translate recipes" on, a recipe shown as written turns to its translation by
  // itself: when it opens, and when the cook's profile, which says so, arrives after the page.
  useEffect(() => {
    if (can && always && auto.current.status === 'original') void auto.current.request(true);
  }, [key, can, always]);
  const showOriginal = useCallback(() => {
    asked.current++;
    setState(start(key));
  }, [key]);
  const translate = useCallback(() => void request(false), [request]);
  const translation = current.translation;
  const shown = useMemo(
    () => (translation && translated(recipe, translation)) || recipe,
    [translation, recipe],
  );
  return {
    /** The page offers a translation: the recipe is in another of the app's languages. */
    available: can && (!!app.capabilities?.recipeTranslation || kept === key || !!translation),
    status,
    error: current.error,
    signIn: current.signIn,
    /** The recipe as it shows. */
    shown,
    /** The language of the translation showing, or null for the recipe as written. */
    translatedTo: translation && shown !== recipe ? translation.language : null,
    translate,
    showOriginal,
    always,
    setAlways,
  };
}
