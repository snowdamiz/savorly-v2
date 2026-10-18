import type { Recipe } from './types';

// What a recipe needs besides its ingredients. The cook's own list (`equipment`) comes first. A
// recipe without one shows what its method mentions (`equipmentDetected`), which the server reads
// with its equipment lexicon as English keys that the app names in the reader's language, and
// says that's where it came from. The two never mix: the list is the cook's words, the keys the
// app's. The editor asks the server what a method mentions too (POST /recipes/equipment), so the
// lexicon lives in one place.

/** The most a list holds, as the API allows (services/api/internal/app/models.go). */
export const EQUIPMENT_MAX = 20;
/** The longest name on a list, in characters. */
export const EQUIPMENT_NAME_MAX = 60;

const same = (name: string) => name.trim().toLocaleLowerCase();

/** A list as the API keeps it: trimmed, without blanks or repeats (in any case), at most 20. */
export function cleanEquipment(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(same(name))) continue;
    seen.add(same(name));
    out.push(name);
  }
  return out.slice(0, EQUIPMENT_MAX);
}

/**
 * What a recipe shows as what you'll need: the cook's list, or else what its method mentions,
 * named by `name` ('' for a key this version of the app doesn't know, which is left out).
 */
export function shownEquipment(
  recipe: Pick<Recipe, 'equipment' | 'equipmentDetected'>,
  name: (key: string) => string,
): { names: string[]; detected: boolean } {
  const own = cleanEquipment(recipe.equipment ?? []);
  if (own.length) return { names: own, detected: false };
  const names = cleanEquipment((recipe.equipmentDetected ?? []).map(name));
  return { names, detected: names.length > 0 };
}

/**
 * The list with `suggested` names after it, leaving out the ones it already has (in any case), up
 * to the most a list holds, and how many were added.
 */
export function withSuggestions(list: readonly string[], suggested: readonly string[]) {
  const have = new Set(list.map(same));
  const added: string[] = [];
  for (const name of suggested) {
    if (!name.trim() || have.has(same(name))) continue;
    have.add(same(name));
    added.push(name.trim());
  }
  const equipment = [...list, ...added].slice(0, Math.max(EQUIPMENT_MAX, list.length));
  return { equipment, added: equipment.length - list.length };
}

/** A list with the item at `from` moved by `by` places (-1 up, 1 down), kept inside the list. */
export function moved<T>(list: readonly T[], from: number, by: number): T[] {
  const to = Math.min(Math.max(from + by, 0), list.length - 1);
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
