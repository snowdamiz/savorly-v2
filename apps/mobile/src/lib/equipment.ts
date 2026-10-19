import type { Recipe } from './types';

// What a recipe needs besides its ingredients. The cook's own list (`equipment`) comes first. A
// recipe without one shows what the sous-chef's model guesses its method uses (`equipmentGuess`,
// with the steps that use each piece), or, until it has guessed, what its method mentions
// (`equipmentDetected`, read by the server's equipment lexicon). Both are English keys that the
// app names in the reader's language, and say where they came from. They never mix with the
// cook's list: the list is the cook's words, the keys the app's. The editor asks the server what a method mentions too (POST /recipes/equipment), so the
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

type Shown = Pick<Recipe, 'equipment' | 'equipmentKinds' | 'equipmentDetected' | 'equipmentGuess'>;

/**
 * A piece of equipment as a recipe shows it: its name, what it names for its icon, and, for the
 * sous-chef's guess, the 1-based steps that use it.
 */
export type ShownTool = { name: string; kind: string; steps?: number[] };

/** Tools as a list keeps names: trimmed, without blanks or repeats (in any case), at most 20. */
function cleanTools(tools: readonly ShownTool[]): ShownTool[] {
  const seen = new Set<string>();
  const out: ShownTool[] = [];
  for (const tool of tools) {
    const name = tool.name.trim();
    if (!name || seen.has(same(name))) continue;
    seen.add(same(name));
    out.push({ ...tool, name });
  }
  return out.slice(0, EQUIPMENT_MAX);
}

const shown = (tools: ShownTool[], detected: boolean, guessed: boolean) => ({
  tools,
  names: tools.map((tool) => tool.name),
  detected,
  guessed,
});

/**
 * What a recipe shows as what you'll need: the cook's list, or else the sous-chef's guess, or else
 * what its method mentions, named by `name` ('' for a key this version of the app doesn't know,
 * which is left out). Each tool carries what it names for its icon: for the cook's list, what the
 * server read in each name (`equipmentKinds`). `detected` is anything but the cook's list, and
 * `guessed` the guess.
 */
export function shownEquipment(recipe: Shown, name: (key: string) => string) {
  const kinds = recipe.equipmentKinds ?? [];
  const own = cleanTools(
    (recipe.equipment ?? []).map((item, i) => ({ name: item, kind: kinds[i] ?? '' })),
  );
  if (own.length) return shown(own, false, false);
  const guess = cleanTools(
    (recipe.equipmentGuess ?? []).map((use) => ({
      name: name(use.key),
      kind: use.key,
      steps: use.steps,
    })),
  );
  if (guess.length) return shown(guess, true, true);
  const found = cleanTools(
    (recipe.equipmentDetected ?? []).map((key) => ({ name: name(key), kind: key })),
  );
  return shown(found, found.length > 0, false);
}

// How much a piece of equipment matters when only a few show: what a kitchen may not have first
// (appliances), then special pans and tools, and anything the lexicon doesn't know (a pasta
// machine, or every name from an older server), then everyday cookware, then everyday tools (a
// bowl, a spoon).
const appliances = [
  'oven',
  'grill',
  'slow cooker',
  'pressure cooker',
  'air fryer',
  'deep fryer',
  'microwave',
  'rice cooker',
  'steamer',
  'blender',
  'immersion blender',
  'food processor',
  'stand mixer',
  'hand mixer',
];
const special = [
  'dutch oven',
  'wok',
  'griddle',
  'roasting pan',
  'loaf pan',
  'cake pan',
  'pie dish',
  'muffin pan',
  'mandoline',
  'thermometer',
  'kitchen scale',
  'mortar and pestle',
  'rolling pin',
  'sieve',
];
const cookware = [
  'pot',
  'saucepan',
  'frying pan',
  'sheet pan',
  'baking dish',
  'whisk',
  'grater',
  'colander',
];

function importance(kind: string) {
  if (appliances.includes(kind)) return 0;
  if (!kind || special.includes(kind)) return 1;
  if (cookware.includes(kind)) return 2;
  return 3;
}

/** Tools by how much they matter, keeping the list's own order among equals. */
export function byImportance(tools: readonly ShownTool[]): ShownTool[] {
  return tools
    .map((tool, i) => ({ tool, i, rank: importance(tool.kind) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ tool }) => tool);
}

/**
 * What the sous-chef guesses step `index` (0-based) uses, named by `name`; nothing when the cook
 * lists equipment, since their list doesn't say when.
 */
export function stepEquipment(recipe: Shown, index: number, name: (key: string) => string) {
  if (cleanEquipment(recipe.equipment ?? []).length) return [];
  const uses = (recipe.equipmentGuess ?? []).filter((use) => use.steps.includes(index + 1));
  return cleanEquipment(uses.map((use) => name(use.key)));
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
