import AsyncStorage from '@react-native-async-storage/async-storage';
import { isLanguage } from './i18n/core';
import type { Recipe, RecipeTranslation } from './types';

// Recipes in the reader's language. The API translates a recipe's title, description, ingredient
// names and steps once per language, for every reader (GET /recipes/:id/translation); amounts,
// units, tags and cuisine stay as written, so servings, unit conversion, the checklist and timers
// work on a translated recipe as on the original. The device keeps the translations of the last
// recipes read translated, so a recipe kept for cooking without a connection (offline.ts) still
// reads in the cook's language. Published recipes only, like the recipes it keeps: they are public,
// so they can stay after signing out.

const KEY = 'savorly.offline.translations';
/** How many translations the device keeps: the ones read last. */
export const TRANSLATIONS_KEPT = 30;

/** Whether a recipe is written in another of the app's languages than `language`. */
export function translatable(recipe: Pick<Recipe, 'language'>, language: string) {
  const own = recipe.language ?? '';
  return isLanguage(own) && own !== language;
}

/**
 * A digest of the text a translation is made from, its language included: a translation kept for
 * a recipe applies only while the recipe still reads the same.
 */
export function fingerprint(recipe: Recipe) {
  const text = JSON.stringify([
    recipe.language ?? '',
    recipe.title,
    recipe.description,
    recipe.ingredients.map((i) => i.name),
    recipe.steps.map((s) => [s.title, s.text]),
    // Only for a recipe that lists equipment, so the translations kept before it still apply.
    ...(recipe.equipment?.length ? [recipe.equipment] : []),
  ]);
  // cyrb53 (public domain): two 32-bit hashes in one number, plenty to tell versions apart.
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

/**
 * The recipe as the reader sees it translated: its title, description, ingredient names, steps and
 * equipment from `t`, in `t`'s language, with everything else as it is. Null when `t` isn't of this
 * recipe (another number of ingredients or steps: a translation of another version). Equipment a
 * translation doesn't name one for one stays as the cook wrote it.
 */
export function translated(recipe: Recipe, t: RecipeTranslation): Recipe | null {
  if (
    !Array.isArray(t.ingredients) ||
    !Array.isArray(t.steps) ||
    t.ingredients.length !== recipe.ingredients.length ||
    t.steps.length !== recipe.steps.length
  )
    return null;
  return {
    ...recipe,
    title: t.title || recipe.title,
    description: t.description || recipe.description,
    ingredients: recipe.ingredients.map((i, n) => ({
      ...i,
      name: t.ingredients[n].name || i.name,
    })),
    steps: recipe.steps.map((s, n) => ({
      ...s,
      title: t.steps[n].title || s.title,
      text: t.steps[n].text || s.text,
    })),
    equipment:
      recipe.equipment && t.equipment?.length === recipe.equipment.length
        ? recipe.equipment.map((name, n) => t.equipment?.[n] || name)
        : recipe.equipment,
    language: t.language,
  };
}

/** A translation kept on the device, for the recipe as it read when it was translated. */
export type KeptTranslation = {
  recipe: string;
  fingerprint: string;
  translation: RecipeTranslation;
};

/** A stored list, without anything that isn't a kept translation (older or damaged data). */
export function parseKept(text: string | null): KeptTranslation[] {
  try {
    const list = text ? (JSON.parse(text) as unknown) : [];
    return Array.isArray(list)
      ? list.filter(
          (k: Partial<KeptTranslation> | null): k is KeptTranslation =>
            !!k &&
            typeof k.recipe === 'string' &&
            typeof k.fingerprint === 'string' &&
            !!k.translation &&
            typeof k.translation.language === 'string' &&
            Array.isArray(k.translation.ingredients) &&
            Array.isArray(k.translation.steps),
        )
      : [];
  } catch {
    return [];
  }
}

/** The list with `kept` first, one translation per recipe and language, at most `limit` long. */
export function withKept(
  list: KeptTranslation[],
  kept: KeptTranslation,
  limit = TRANSLATIONS_KEPT,
) {
  const same = (k: KeptTranslation) =>
    k.recipe === kept.recipe && k.translation.language === kept.translation.language;
  return [kept, ...list.filter((k) => !same(k))].slice(0, limit);
}

// Storage is slow and can fail (private browsing, a full disk); none of that may reach the cook.
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(task: (list: KeptTranslation[]) => Promise<T>): Promise<T> {
  const run = queue.then(async () =>
    task(parseKept(await AsyncStorage.getItem(KEY).catch(() => null))),
  );
  queue = run.catch(() => {});
  return run;
}

/** The device's translation of the recipe, as it reads now, into `language`, or null. */
export function keptTranslation(
  recipe: Recipe,
  language: string,
): Promise<RecipeTranslation | null> {
  const print = fingerprint(recipe);
  return serially(async (list) => {
    const kept = list.find(
      (k) =>
        k.recipe === recipe.id && k.fingerprint === print && k.translation.language === language,
    );
    return kept && translated(recipe, kept.translation) ? kept.translation : null;
  }).catch(() => null);
}

/** Keeps a published recipe's translation on the device, the newest first. */
export function keepTranslation(recipe: Recipe, translation: RecipeTranslation) {
  if (recipe.published === false) return;
  const kept = { recipe: recipe.id, fingerprint: fingerprint(recipe), translation };
  void serially((list) =>
    AsyncStorage.setItem(KEY, JSON.stringify(withKept(list, kept))).catch(() => {}),
  ).catch(() => {});
}
