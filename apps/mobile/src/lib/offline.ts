import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Feed } from './feed';
import { forgetNarration } from './narration/cache';
import type { Creator, Kitchen, Library, Recipe, User } from './types';

// Recipes for a kitchen with poor reception. The device keeps the last 30 recipes opened and a
// snapshot of what the app last loaded (the home's recipes, and the signed-in kitchen's saved
// recipes, plans, groceries and pantry), so a recipe that can't be fetched opens from here, and a
// launch without a connection still shows the kitchen. Read only: nothing is changed offline.
// The cloud narration of the last three recipes read aloud is kept too (narration/cache.ts), so
// cooking mode reads them in the same voice offline. The signed-in kitchen's part, narration
// included, goes when it signs out. AsyncStorage is localStorage on the web.

const RECENT_KEY = 'savorly.offline.recent';
const SNAPSHOT_KEY = 'savorly.offline.snapshot';
/** How many recently opened recipes the device keeps. */
export const RECENT_LIMIT = 30;
/** How many of the kitchen's saved recipes the device keeps (the newest saves). */
export const SAVED_LIMIT = 100;

/** What the app last loaded, for a launch without a connection. */
export type Snapshot = {
  recipes: Recipe[];
  creators: Creator[];
  feed: Feed | null;
  /** The signed-in kitchen, or null for a guest. */
  user: User | null;
  library: Library | null;
  kitchen: Kitchen | null;
};

/** The recently opened list with `recipe` first, each recipe once, at most `limit` long. */
export function remember(list: Recipe[], recipe: Recipe, limit = RECENT_LIMIT): Recipe[] {
  return [recipe, ...list.filter((r) => r.id !== recipe.id)].slice(0, limit);
}

/** The snapshot as stored: the library keeps only its newest saved recipes. */
export function trimmed(snapshot: Snapshot, saved = SAVED_LIMIT): Snapshot {
  const { library } = snapshot;
  return library && library.recipes.length > saved
    ? { ...snapshot, library: { ...library, recipes: library.recipes.slice(0, saved) } }
    : snapshot;
}

/** Whether a snapshot has anything worth showing in place of the connection error. */
export const worthShowing = (snapshot: Snapshot | null): snapshot is Snapshot =>
  !!snapshot &&
  (snapshot.recipes.length > 0 ||
    !!snapshot.library?.recipes.length ||
    !!snapshot.kitchen?.plans.length);

/** A stored snapshot, or null when it isn't one (older or damaged data). */
export function parseSnapshot(text: string | null): Snapshot | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<Snapshot> | null;
    if (!value || typeof value !== 'object' || !Array.isArray(value.recipes)) return null;
    return {
      recipes: value.recipes,
      creators: Array.isArray(value.creators) ? value.creators : [],
      feed: value.feed ?? null,
      user: value.user ?? null,
      library: value.library ?? null,
      kitchen: value.kitchen ?? null,
    };
  } catch {
    return null;
  }
}

// Storage is slow and can fail (private browsing, a full disk); none of that may reach the cook.
let recent: Recipe[] | null = null;
let reading: Promise<Recipe[]> | null = null;
function recentList() {
  if (recent) return Promise.resolve(recent);
  reading ??= AsyncStorage.getItem(RECENT_KEY)
    .then((text) => {
      const list = text ? (JSON.parse(text) as unknown) : [];
      return Array.isArray(list) ? (list as Recipe[]) : [];
    })
    .catch(() => [] as Recipe[])
    .then((list) => (recent ??= list));
  return reading;
}

/**
 * Keeps an opened recipe on the device (the newest 30). Published recipes only: they are public,
 * so they can stay after signing out, where a kitchen's own drafts must not.
 */
export function rememberRecipe(recipe: Recipe) {
  if (recipe.published === false) return;
  void recentList().then((list) => {
    recent = remember(list, recipe);
    return AsyncStorage.setItem(RECENT_KEY, JSON.stringify(recent)).catch(() => {});
  });
}

let pending: Snapshot | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** Stores what the app has loaded; writes are gathered for a second, as refreshes come in bursts. */
export function saveSnapshot(snapshot: Snapshot) {
  pending = snapshot;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const next = pending;
    pending = null;
    if (next)
      void AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(trimmed(next))).catch(() => {});
  }, 1000);
}

/** What the app last loaded, or null. */
export async function loadSnapshot(): Promise<Snapshot | null> {
  if (pending) return pending;
  return parseSnapshot(await AsyncStorage.getItem(SNAPSHOT_KEY).catch(() => null));
}

/** A copy of the recipe kept on this device: recently opened, saved, planned, or on the home. */
export async function cachedRecipe(id: string): Promise<Recipe | null> {
  const opened = (await recentList()).find((r) => r.id === id);
  if (opened) return opened;
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const { feed } = snapshot;
  return (
    [
      ...(snapshot.library?.recipes ?? []),
      ...(snapshot.kitchen?.plans.map((p) => p.recipe) ?? []),
      ...snapshot.recipes,
      ...(feed ? [feed.hero, ...feed.trending, ...feed.quick, ...feed.following] : []),
    ].find((r): r is Recipe => !!r && r.id === id) ?? null
  );
}

/**
 * Signing out takes the kitchen's own copies off the device at once (its profile, saved recipes,
 * plans and lists), rather than with the next snapshot a second later, and the narration kept for
 * cooking offline, which can be of its drafts.
 */
export function forgetKitchen() {
  const signedOut = (snapshot: Snapshot): Snapshot => ({
    ...snapshot,
    user: null,
    library: null,
    kitchen: null,
  });
  void forgetNarration();
  if (pending) pending = signedOut(pending);
  void loadSnapshot().then((snapshot) =>
    snapshot
      ? AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(signedOut(snapshot))).catch(() => {})
      : undefined,
  );
}
