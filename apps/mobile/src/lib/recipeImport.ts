import { api, ApiError } from './api';
import { AIJob, RecipeInput, emptyRecipe } from './types';

/**
 * The web address in what the cook typed or pasted ("Try this! https://…" works too), or '' when
 * there isn't a usable one. A bare "example.com/soup" gets https:// in front.
 */
export function recipeLink(text: string) {
  const typed = text.trim();
  const found =
    /https?:\/\/[^\s<>"'“”‘’«»]+/i.exec(typed)?.[0] ??
    (/^[^\s/@:]+\.[^\s/@:]+(\/\S*)?$/.test(typed) ? `https://${typed}` : '');
  // A link at the end of a sentence keeps its closing punctuation outside.
  const link = found.replace(/[.,;:!?)\]]+$/, '');
  if (!link || link.length > 2000) return '';
  try {
    const url = new URL(link);
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    return web && url.hostname.includes('.') && !url.hostname.endsWith('.') ? link : '';
  } catch {
    return '';
  }
}

/** The import's answer: the page's own recipe data, or a sous-chef job reading the page. */
type ImportAnswer = { method: 'structured'; recipe: RecipeInput } | { method: 'ai'; job: AIJob };
export type ImportMethod = ImportAnswer['method'];

const unreadable = 'We couldn’t read a recipe from that page.';
// What each refusal means to the cook, in words the catalogs translate.
const refusals: Record<number, string> = {
  400: 'That doesn’t look like a link to a recipe page. Check it and try again.',
  404: 'Importing from a link isn’t available yet.',
  422: 'We couldn’t find a recipe on that page.',
  502: 'We couldn’t open that page.',
  503: unreadable,
};
// A video or photo post's refusals say more than their status does, so they keep the server's
// words (which the catalogs translate too).
const explained = new Set([
  'We couldn’t find a recipe in that post’s caption. Try the link to the full recipe if the creator shared one.',
  'We couldn’t open that post. It may be private or no longer available.',
]);
/** A failed import, as the cook should read it. */
export const importError = (e: unknown) =>
  (e instanceof ApiError && (explained.has(e.message) ? e.message : refusals[e.status])) ||
  (e as Error).message;

/**
 * The platform a link to a video or photo post is on ("TikTok"), as the server recognises them,
 * or '' for any other page.
 */
export function postPlatform(url: string | null | undefined) {
  let host = '';
  try {
    host = new URL((url || '').trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
  const within = (...domains: string[]) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (within('tiktok.com')) return 'TikTok';
  if (within('instagram.com', 'instagr.am')) return 'Instagram';
  if (within('youtube.com', 'youtu.be')) return 'YouTube';
  if (within('facebook.com', 'fb.watch')) return 'Facebook';
  if (
    within('pin.it') ||
    /^(?:[\w-]+\.)*pinterest\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)
  )
    return 'Pinterest';
  return '';
}

/** The creator a post's own address names, as a TikTok's does ("@chefjo"), or ''. */
export function postCreator(url: string | null | undefined) {
  if (postPlatform(url) !== 'TikTok') return '';
  const handle = /^\/@([\w.]+)\/(?:video|photo)\//.exec(new URL((url || '').trim()).pathname)?.[1];
  return handle ? `@${handle}` : '';
}

/** How long to wait for the sous-chef to read a page before leaving it to the history. */
export const IMPORT_WAIT = 3 * 60_000;
const POLL = 2000;

// Everything the editor needs, private until the cook decides, crediting the page.
function seeded(recipe: RecipeInput, url: string): RecipeInput {
  const blank = emptyRecipe();
  return {
    ...blank,
    ...recipe,
    photos: recipe.photos ?? [],
    tags: recipe.tags ?? [],
    ingredients: recipe.ingredients?.length ? recipe.ingredients : blank.ingredients,
    steps: recipe.steps?.length ? recipe.steps : blank.steps,
    sourceUrl: recipe.sourceUrl || url,
    published: false,
  };
}

/**
 * Brings in the recipe at `url` (nothing is saved): straight from the page's own recipe data, or
 * by waiting for the sous-chef to read the page, which `onReading` announces. `live` stops the
 * wait when the cook moves on; the result is then null.
 */
export async function importRecipe(
  url: string,
  { live, onReading }: { live: () => boolean; onReading?: () => void },
): Promise<{ recipe: RecipeInput; method: ImportMethod } | null> {
  const answer = await api<ImportAnswer>('/recipes/import', { method: 'POST', body: { url } });
  if (!live()) return null;
  if (answer?.method === 'structured' && answer.recipe)
    return { recipe: seeded(answer.recipe, url), method: 'structured' };
  if (answer?.method !== 'ai' || !answer.job?.id) throw new Error(unreadable);
  onReading?.();
  let job = answer.job;
  const started = Date.now();
  while (job.status !== 'completed' && job.status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, POLL));
    if (!live()) return null;
    if (Date.now() - started > IMPORT_WAIT)
      throw new Error(
        'This page is taking a while. The recipe will be in your sous-chef history when it’s ready.',
      );
    try {
      job = await api<AIJob>(`/ai/jobs/${encodeURIComponent(job.id)}`);
    } catch (e) {
      // A dropped connection just means another look; a job that's gone won't come back, and
      // neither will a session that ended.
      if (e instanceof ApiError && e.status === 404) throw new Error(unreadable);
      if (e instanceof ApiError && e.status === 401) throw e;
    }
    if (!live()) return null;
  }
  if (job.status === 'failed' || !job.result?.recipe)
    throw new Error(explained.has(job.error) ? job.error : unreadable);
  return { recipe: seeded(job.result.recipe, url), method: 'ai' };
}
