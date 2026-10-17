import { createContext, useContext } from 'react';
import type { Avoid, Recipe } from './types';

/**
 * What recipe cards and pages need to warn about what a member avoids and to mark what their
 * pantry has, kept apart from the rest of the app's data the way library.tsx keeps bookmarks: the
 * value changes only when the avoid list, the diets or the pantry do, so a feed of cards doesn't
 * re-render for a kitchen refresh. AppProvider supplies it; signed out, it's empty.
 */
export type FoodState = {
  avoid: Avoid | null;
  /** The member's diets, so a warning can say a diet led to it rather than an allergy. */
  diets: string[];
  /** Ingredient keys the pantry has (Kitchen.pantryCover). */
  pantryCover: string[];
};

export const noFood: FoodState = { avoid: null, diets: [], pantryCover: [] };
export const FoodContext = createContext<FoodState>(noFood);
export const useFood = () => useContext(FoodContext);

/** One thing in a recipe its reader avoids, and where it is. */
export type FoodConflict = {
  /** An allergen or diet group ('peanut', 'pork'), or else… */
  group?: string;
  /** …one of the member's own words or an ingredient's key ('kiwi', 'cilantro'). */
  term?: string;
  /** What the member wrote that leads to it ('Peanuts', 'Vegan'). */
  from: string[];
  /** The recipe's ingredient lines that have it, by position. */
  ingredients: number[];
};

/**
 * What in a recipe its reader avoids, in the order the ingredients first show it. Ingredient facts
 * come from the server's lexicon; a recipe from an older server without them is matched by its
 * recipe-wide groups only, with no lines to point at.
 */
export function foodConflicts(recipe: Recipe, avoid: Avoid | null): FoodConflict[] {
  if (!avoid) return [];
  const found = new Map<string, FoodConflict>();
  const add = (id: string, conflict: Omit<FoodConflict, 'ingredients'>, line?: number) => {
    const c = found.get(id) ?? { ...conflict, ingredients: [] };
    if (line !== undefined && !c.ingredients.includes(line)) c.ingredients.push(line);
    found.set(id, c);
  };
  const facts = recipe.ingredientFood;
  if (facts && facts.length === recipe.ingredients.length) {
    facts.forEach((f, line) => {
      for (const g of f.allergens) {
        const from = avoid.groups[g];
        if (from) add(`group:${g}`, { group: g, from }, line);
      }
      for (const t of f.terms) {
        const from = avoid.terms[t];
        if (from) add(`term:${t}`, { term: t, from }, line);
      }
    });
  } else {
    for (const g of recipe.allergens ?? []) {
      const from = avoid.groups[g];
      if (from) add(`group:${g}`, { group: g, from });
    }
  }
  return [...found.values()];
}

/** Which ingredient lines the pantry has, by the same keys pantry matching uses. */
export function pantryLines(recipe: Recipe, cover: string[]): boolean[] {
  const facts = recipe.ingredientFood;
  if (!cover.length || !facts || facts.length !== recipe.ingredients.length)
    return recipe.ingredients.map(() => false);
  return facts.map((f) => !!f.key && cover.includes(f.key));
}

/** A stable identity for a food state, so the provider's value changes only when it does. */
export const foodKey = (f: FoodState) =>
  JSON.stringify([f.avoid?.groups ?? {}, f.avoid?.terms ?? {}, f.diets, f.pantryCover]);

/** Names as a list in the app's language: commas, or the ideographic comma in Chinese and Japanese. */
export const joinNames = (names: string[], language: string) =>
  names.filter(Boolean).join(language === 'zh' || language === 'ja' ? '、' : ', ');
