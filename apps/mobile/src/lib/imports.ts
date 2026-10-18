import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { recipeLink } from './recipeImport';
import { useApp } from './store';
import { track } from './telemetry';

// Bulk imports (POST /imports): many recipe links, or recipes the cook wrote as text, read on the
// server one at a time into private drafts, so leaving the page doesn't stop them. The page for
// Mealime's members, Add a recipe and a creator's own site start them; each shows its progress.

/** Where a bulk import started. */
export type ImportPurpose = 'links' | 'mealime' | 'own_site';
export type ImportItem = {
  position: number;
  /** The link, or '' for a recipe the cook pasted. */
  url: string;
  /** A pasted recipe's first line. */
  text: string;
  status: 'queued' | 'reading' | 'imported' | 'failed';
  /** Why a failed item brought no recipe, in English (the catalogs translate it). */
  error: string;
  /** The draft it became, while that still exists. */
  recipe: { id: string; title: string; image: string } | null;
};
export type ImportBatch = {
  id: string;
  purpose: ImportPurpose;
  /** For a creator's own site, the site. */
  site: string;
  createdAt: string;
  finishedAt: string | null;
  items: ImportItem[];
};

/** What one batch takes (import_batches.go). */
export const MAX_BATCH = 50;
export const MAX_TEXTS = 10;
export const MAX_TEXT = 12000;

/** A failed item that was one of Mealime's own recipes, which stay with Mealime. */
export const mealimeOwn =
  'This is one of Mealime’s own recipes, which stay with Mealime. Look for a similar Savorly recipe instead.';

/**
 * Every web address in what the cook pasted or uploaded, once each and in order: links anywhere in
 * the text (a message, a list, a bookmarks file), and lines that are a bare address
 * ("example.com/soup").
 */
export function recipeLinks(text: string) {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // Links pasted into a one-line field can arrive run together, with nothing between them.
    const links = line.match(/https?:\/\/[^\s<>"'“”‘’«»]+?(?=https?:\/\/|[\s<>"'“”‘’«»]|$)/gi) ?? [
      line,
    ];
    for (const candidate of links) {
      const link = recipeLink(candidate);
      if (link && !found.includes(link)) found.push(link);
    }
  }
  return found;
}

/** The site a link is on, without "www." ('' for anything else). */
export function siteOf(link: string) {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Whether a link is to Mealime's site, whose recipes are Mealime's own. */
export const mealimeLink = (link: string) => /(^|\.)mealime\.com$/.test(siteOf(link));

/**
 * The recipe a link to Mealime's site names, read from its address
 * (mealime.com/recipes/lemony-chicken-orzo/1234 is "Lemony chicken orzo"), or ''.
 */
export function mealimeName(link: string) {
  if (!mealimeLink(link)) return '';
  const parts = new URL(link).pathname
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .filter((part) => /\p{L}/u.test(part) && !/^recipes?$/i.test(part));
  const name = (parts.pop() ?? '')
    .replace(/\.\w+$/, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+\d+$/, '')
    .trim();
  return name && name[0].toUpperCase() + name.slice(1);
}

/**
 * Recipes in a file the cook wrote: the parts between lines of dashes, equals signs or stars
 * ("---"), or the whole text when it has none.
 */
export function splitRecipes(text: string) {
  return text
    .split(/^\s*(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

// The line that starts a recipe's ingredients, in the app's languages (as the server reads them).
const ingredientsLine =
  /^[#*_\s]*(?:ingredients?|ingrédients|zutaten|ingredienti|ingredientes|ингредиенты|材料|配料|用料)(?![\p{L}\p{N}])[^\n]{0,30}$/iu;

/**
 * Recipes pasted one after another, each cut from the paragraph before its Ingredients line (its
 * title, and anything said before the ingredients) to the next one's.
 */
function eachRecipe(part: string) {
  const lines = part.split(/\r?\n/);
  // Where the paragraph holding line `at` starts.
  const paragraph = (at: number) => {
    while (at > 0 && lines[at - 1].trim()) at--;
    return at;
  };
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (!ingredientsLine.test(line.trim())) return;
    let start = paragraph(i);
    // An Ingredients line on its own goes with the paragraph above it, the title.
    if (start === i) {
      let above = i - 1;
      while (above >= 0 && !lines[above].trim()) above--;
      if (above >= 0) start = paragraph(above);
    }
    if (!starts.length || start > starts[starts.length - 1]) starts.push(start);
  });
  if (starts.length < 2) return [part];
  starts[0] = 0;
  return starts.map((start, n) =>
    lines
      .slice(start, starts[n + 1])
      .join('\n')
      .trim(),
  );
}

/**
 * What the cook pasted, as a bulk import takes it: the links to bring in, and the recipes they
 * wrote. Parts between lines of dashes ("---") are read one at a time: a list of links (headings
 * between them are fine) gives its links, and any other part is a recipe the cook wrote, or
 * several, one after another.
 */
export function readPaste(text: string) {
  const links: string[] = [];
  const texts: string[] = [];
  for (const part of splitRecipes(text).flatMap(eachRecipe)) {
    const lines = part.split(/\r?\n/).filter((line) => line.trim());
    const found = recipeLinks(part);
    if (found.length && lines.every((line) => recipeLinks(line).length || line.trim().length <= 60))
      links.push(...found.filter((link) => !links.includes(link)));
    // A line or two without a link is a note, not a recipe.
    else if (lines.length >= 3 || part.length >= 80) texts.push(part.slice(0, MAX_TEXT));
  }
  return { links, texts };
}

/**
 * Links and recipes cut into batches the server takes: up to MAX_BATCH items each, of which up to
 * MAX_TEXTS recipes, links first.
 */
export function batchesOf({ links, texts }: { links: string[]; texts: string[] }) {
  const out: { urls: string[]; texts: string[] }[] = [];
  let urls = [...links];
  let rest = [...texts];
  while (urls.length || rest.length) {
    const some = rest.slice(0, Math.min(MAX_TEXTS, Math.max(0, MAX_BATCH - urls.length)));
    const take = urls.slice(0, MAX_BATCH - some.length);
    out.push({ urls: take, texts: some });
    urls = urls.slice(take.length);
    rest = rest.slice(some.length);
  }
  return out;
}

/** How many of a batch's items are settled, imported and failed. */
export function progressOf(batch: ImportBatch) {
  const imported = batch.items.filter((i) => i.status === 'imported').length;
  const failed = batch.items.filter((i) => i.status === 'failed').length;
  return { total: batch.items.length, imported, failed, done: imported + failed };
}

const POLL = 2000;

/**
 * The cook's latest batches of one purpose, newest first, kept up to date while any is still
 * being read; `start` sends a new one and `stop` leaves what still waits unread. New drafts reach
 * My kitchen as they arrive.
 */
export function useImports(purpose: ImportPurpose, active = true) {
  const app = useApp();
  const { refreshLibrary } = app;
  // The batches belong to the member and purpose they were read for.
  const key = app.user && active ? `${app.user.id}:${purpose}` : '';
  const [held, setHeld] = useState<{ key: string; batches: ImportBatch[] } | null>(null);
  const batches = key && held?.key === key ? held.batches : null;
  const setBatches = useCallback(
    (change: (list: ImportBatch[]) => ImportBatch[]) =>
      setHeld((old) => (old && old.key === key ? { key, batches: change(old.batches) } : old)),
    [key],
  );
  const imported = useRef(-1);
  useEffect(() => {
    if (!key) return;
    let live = true;
    api<ImportBatch[]>(`/imports?purpose=${purpose}`)
      .then((list) => live && setHeld({ key, batches: Array.isArray(list) ? list : [] }))
      .catch(() => live && setHeld({ key, batches: [] }));
    return () => {
      live = false;
    };
  }, [key, purpose]);
  const reading = (batches ?? []).filter((b) => !b.finishedAt).map((b) => b.id);
  const watching = reading.join(',');
  useEffect(() => {
    if (!watching) return;
    let live = true;
    const timer = setInterval(() => {
      for (const id of watching.split(','))
        api<ImportBatch>(`/imports/${encodeURIComponent(id)}`)
          .then((next) => live && setBatches((list) => list.map((b) => (b.id === id ? next : b))))
          .catch(() => {});
    }, POLL);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [watching, setBatches]);
  // The library (and so My kitchen's recipes) picks up each new draft.
  const count = (batches ?? []).reduce((n, b) => n + progressOf(b).imported, 0);
  useEffect(() => {
    if (imported.current >= 0 && count > imported.current) void refreshLibrary().catch(() => {});
    imported.current = count;
  }, [count, refreshLibrary]);
  const start = useCallback(
    async (body: { urls: string[]; texts?: string[]; ownRecipes?: boolean }) => {
      const batch = await api<ImportBatch>('/imports', {
        method: 'POST',
        body: { purpose, ...body },
      });
      track('import', { method: `batch-${purpose}` });
      setHeld((old) => ({ key, batches: [batch, ...(old?.key === key ? old.batches : [])] }));
      return batch;
    },
    [purpose, key],
  );
  const stop = useCallback(
    async (id: string) => {
      const batch = await api<ImportBatch>(`/imports/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
      });
      setBatches((list) => list.map((b) => (b.id === id ? batch : b)));
    },
    [setBatches],
  );
  return { batches, start, stop, reading: reading.length > 0 };
}
