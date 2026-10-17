import AsyncStorage from '@react-native-async-storage/async-storage';
import { audioSource, clearAudio, removeAudio, saveAudio } from './audioStore';

// The cloud narration of the recipes read aloud last, kept on the device so cooking mode still
// reads their steps in the same voice without a connection (controller.ts). A copy is the
// recording the API streams for a step, under the API's own key for it, which covers the recipe,
// the step, its exact text, the voice, the model and the format; the copy also notes the cook it
// was for, the recipe's language and the text, and plays only for the same. So an edited step, a
// recipe in another language or a new voice never plays an old recording. The list is kept in
// AsyncStorage (localStorage on the web) and the audio by audioStore.ts: files in the app's cache
// directory on phones, Cache Storage in browsers. Only the last three recipes narrated, within
// 15 MB, the oldest going first. Signing out takes it all away (forgetKitchen in offline.ts): it
// can be of a cook's own drafts. Storage is slow and can fail; none of that may reach the cook.

const INDEX_KEY = 'savorly.offline.narration';
/** How many recipes' narration the device keeps: the ones read aloud last. */
export const NARRATION_RECIPES = 3;
/** How much narration audio the device keeps, at most. */
export const NARRATION_BYTES = 15 * 1024 * 1024;

/** A step as it was read aloud: for whom, of which recipe (in which language), and its text. */
export type NarratedStep = {
  /** The signed-in cook's id. */
  owner: string;
  recipe: string;
  /** The recipe's language, '' when it doesn't say. */
  language: string;
  step: number;
  /** The step's exact text. */
  text: string;
};
/** A recording of a step on the device. */
export type KeptNarration = NarratedStep & {
  /** The API's key for the recording: the end of `path`, and the name it's kept under. */
  key: string;
  /** Where the API streams it: /recipes/:id/steps/:step/narration/:key. */
  path: string;
  bytes: number;
  /** When it was kept or last played, in milliseconds. */
  used: number;
};

/** The API's key in a narration path, or null when `path` isn't one. */
export function narrationKey(path: string): string | null {
  return (
    /^\/recipes\/[^/?#]+\/steps\/\d+\/narration\/([A-Za-z0-9_-]{1,128})$/.exec(path)?.[1] ?? null
  );
}

const sameStep = (a: NarratedStep, b: NarratedStep) =>
  a.recipe === b.recipe && a.step === b.step && a.text === b.text && a.language === b.language;

/**
 * The copies still of use once the API has named `key` for `step`. Another key for the same
 * recipe, step and text means the server reads with another voice (or model) now, so every copy
 * made before is out of date; copies of the step's earlier text are of no more use either.
 */
export function current(copies: KeptNarration[], step: NarratedStep, key: string) {
  const sameText = (c: KeptNarration) =>
    c.recipe === step.recipe && c.step === step.step && c.text === step.text;
  if (copies.some((c) => c.key !== key && sameText(c))) return copies.filter((c) => c.key === key);
  return copies.filter(
    (c) => c.key === key || c.recipe !== step.recipe || c.step !== step.step || sameText(c),
  );
}

/**
 * The copies kept within the limits: those of the `recipes` recipes read aloud last (a recipe is
 * as recent as its newest copy), newest first, up to `bytes` in all. The oldest go first.
 */
export function within(
  copies: KeptNarration[],
  recipes = NARRATION_RECIPES,
  bytes = NARRATION_BYTES,
): KeptNarration[] {
  const latest = new Map<string, number>();
  for (const c of copies) latest.set(c.recipe, Math.max(latest.get(c.recipe) ?? 0, c.used));
  const order = [...copies].sort(
    (a, b) =>
      latest.get(b.recipe)! - latest.get(a.recipe)! ||
      (a.recipe === b.recipe ? b.used - a.used : a.recipe < b.recipe ? -1 : 1),
  );
  const kept: KeptNarration[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const c of order) {
    if (!seen.has(c.recipe) && seen.size >= recipes) break;
    total += c.bytes;
    if (total > bytes) break;
    seen.add(c.recipe);
    kept.push(c);
  }
  return kept;
}

const isCopy = (c: unknown): c is KeptNarration => {
  const v = c as Partial<KeptNarration> | null;
  return (
    !!v &&
    typeof v.key === 'string' &&
    typeof v.path === 'string' &&
    narrationKey(v.path) === v.key &&
    typeof v.owner === 'string' &&
    typeof v.recipe === 'string' &&
    typeof v.language === 'string' &&
    typeof v.step === 'number' &&
    typeof v.text === 'string' &&
    typeof v.bytes === 'number' &&
    typeof v.used === 'number'
  );
};

/** A stored list, without anything that isn't a copy (older or damaged data). */
export function parseCopies(text: string | null): KeptNarration[] {
  try {
    const value = text ? (JSON.parse(text) as unknown) : [];
    return Array.isArray(value) ? value.filter(isCopy) : [];
  } catch {
    return [];
  }
}

/** The list as last read or written: what's used when storage can't be read. */
let index: KeptNarration[] = [];
let queue: Promise<unknown> = Promise.resolve();
/** Counts sign-outs: work begun before one never keeps a copy after it. */
let generation = 0;
/** The recordings being downloaded, by key. */
const saving = new Set<string>();

/**
 * Runs `task` on the list once the changes before it are done, so none is lost. The list is read
 * afresh each time, as another tab of the web app may have changed it.
 */
function serially<T>(task: (copies: KeptNarration[]) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const stored = await AsyncStorage.getItem(INDEX_KEY).then(parseCopies, () => null);
    index = stored ?? index;
    return task(index);
  });
  queue = run.catch(() => {});
  return run;
}

/** Stores the list as `next`, and takes the recordings no longer on it off the device. */
async function write(before: KeptNarration[], next: KeptNarration[]) {
  index = next;
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(next)).catch(() => {});
  const gone = before.filter((c) => !next.some((n) => n.key === c.key));
  await Promise.all(gone.map((c) => removeAudio(c.key, c.path).catch(() => {})));
}

/** The API named `path` for a step: the copies that makes out of date (see `current`) go. */
export function narrationNamed(step: NarratedStep, path: string) {
  const key = narrationKey(path);
  if (!key) return;
  void serially(async (copies) => {
    const next = current(copies, step, key);
    if (next.length !== copies.length) await write(copies, next);
  }).catch(() => {});
}

/**
 * Keeps the recording of a step that played from the cloud (`path` from the API) on the device,
 * downloading it unless it's kept already. Fails quietly: without a copy, a step read offline
 * goes to device speech, as before.
 */
export function keepNarration(step: NarratedStep, path: string) {
  const key = narrationKey(path);
  if (!key || saving.has(key)) return;
  saving.add(key);
  const started = generation;
  void (async () => {
    const kept = await serially(async (copies) => {
      const fresh = current(copies, step, key);
      const copy = fresh.find((c) => c.key === key && sameStep(c, step));
      const next = copy
        ? fresh.map((c) => (c === copy ? { ...c, owner: step.owner, used: Date.now() } : c))
        : fresh;
      if (copy || next.length !== copies.length) await write(copies, next);
      return !!copy;
    });
    if (kept || started !== generation) return;
    const bytes = await saveAudio(key, path);
    await serially(async (copies) => {
      if (started !== generation) {
        await removeAudio(key, path);
        return;
      }
      const copy: KeptNarration = { ...step, key, path, bytes, used: Date.now() };
      const others = current(copies, step, key).filter((c) => c.key !== key);
      const next = within([copy, ...others]);
      await write(copies, next);
      if (!next.includes(copy)) await removeAudio(key, path);
    });
  })()
    .catch(() => {})
    .finally(() => saving.delete(key));
}

/**
 * The device's copy of a step, as a source for the narration player, or null. With `path` (the
 * API answered), only the copy of that recording; without (it couldn't be reached), the newest
 * copy of the step as the cook sees it now. A copy played counts as read aloud again.
 */
export async function cachedNarration(step: NarratedStep, path?: string): Promise<string | null> {
  const key = path === undefined ? undefined : narrationKey(path);
  if (key === null) return null;
  const started = generation;
  try {
    const copy = await serially(async (copies) => {
      const fresh = key === undefined ? copies : current(copies, step, key);
      let found: KeptNarration | undefined;
      for (const c of fresh)
        if (c.owner === step.owner && sameStep(c, step) && (key === undefined || c.key === key))
          if (!found || c.used > found.used) found = c;
      const used = found && { ...found, used: Date.now() };
      const next = used ? fresh.map((c) => (c === found ? used : c)) : fresh;
      if (used || next.length !== copies.length) await write(copies, next);
      return used ?? null;
    });
    if (!copy || started !== generation) return null;
    const source = await audioSource(copy.key, copy.path);
    if (source) return started === generation ? source : null;
    // The system cleared it to make room: the list lets it go too.
    await serially(async (copies) => {
      const next = copies.filter((c) => c.key !== copy.key);
      if (next.length !== copies.length) await write(copies, next);
    });
    return null;
  } catch {
    return null;
  }
}

/** Takes every copy off the device: signing out, as they can be of a cook's own drafts. */
export function forgetNarration(): Promise<void> {
  generation++;
  return serially(async () => {
    index = [];
    await AsyncStorage.removeItem(INDEX_KEY).catch(() => {});
    await clearAudio().catch(() => {});
  }).catch(() => {});
}
