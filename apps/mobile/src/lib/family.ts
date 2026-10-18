import { api, ApiError } from './api';
import { AIJob, Creator, Recipe, RecipeStep } from './types';
import { requestKey } from './utils';

// Family recipes in their own voice (docs/FAMILY-RECIPES.md). A relative's recording, or a photo
// of a handwritten card, is written down on the server as a private recipe; each step of one from
// a recording points at the stretch of it that says the step (`step.voice`), which cooking mode
// plays beside narration. Nothing ever speaks in their voice but the recording itself.

/** A family recording, as GET /recordings lists it. */
export type Recording = {
  id: string;
  speaker: string;
  url: string;
  durationMs: number;
  language: string;
  consentedAt: string | null;
  createdAt: string;
  /** The recipe it was written down as; null until it is, or once that recipe is deleted. */
  recipe: { id: string; title: string; published: boolean } | null;
  /** The latest job writing it down. */
  job: { id: string; status: AIJob['status']; error: string } | null;
};
/** A cookbook someone in the household shares with it (GET /household/cookbooks). */
export type HouseholdCookbook = {
  id: string;
  name: string;
  description: string;
  recipeCount: number;
  cover: string;
  owner: Pick<Creator, 'id' | 'name' | 'handle' | 'avatar'>;
};
/** A step's recorded clip: where it is, the stretch to play, and whose voice it is. */
export type VoiceClip = { url: string; startMs: number; endMs: number; speaker: string };

/** What the server tells a recording's or card's writer when nothing more specific applies. */
const failed = 'The recipe couldn’t be written down. Your recording is saved; please try again.';

/** The clip a step plays of its recipe's recordings, or null for a step without one. */
export function stepVoice(
  recipe: Pick<Recipe, 'recordings'>,
  step: Pick<RecipeStep, 'voice'> | undefined,
): VoiceClip | null {
  const v = step?.voice;
  const recording = v ? recipe.recordings?.find((r) => r.id === v.recording) : undefined;
  if (!v || !recording || v.endMs <= v.startMs) return null;
  return { url: recording.url, startMs: v.startMs, endMs: v.endMs, speaker: recording.speaker };
}

/** Whose agreement publishing still waits on: the speakers of recordings not yet agreed to. */
export const awaitingConsent = (recipe: Pick<Recipe, 'recordings'>) => [
  ...new Set((recipe.recordings ?? []).filter((r) => !r.consented).map((r) => r.speaker)),
];

/**
 * Keeps an uploaded recording and starts writing it down. `job` is null, with `error` saying why,
 * when that can't start now; the recording is kept either way.
 */
export const keepRecording = (url: string, speaker: string, durationMs: number) =>
  api<{ recording: Recording; job: AIJob | null; error?: string }>('/recordings', {
    method: 'POST',
    body: { url, speaker: speaker.trim(), durationMs },
    headers: { 'Idempotency-Key': requestKey() },
  });

/** Writes a kept recording down again, from what speech-to-text already heard. */
export const writeAgain = (id: string) =>
  api<AIJob>(`/recordings/${encodeURIComponent(id)}/transcribe`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestKey() },
  });

/** Starts reading an uploaded photo of a recipe card. */
export const readCard = (url: string) =>
  api<AIJob>('/family/cards', {
    method: 'POST',
    body: { url },
    headers: { 'Idempotency-Key': requestKey() },
  });

/** The member's recordings, newest first; none on a server without family recipes. */
export const recordings = () =>
  api<Recording[]>('/recordings').catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  });

/** Confirms that the people recorded in a recipe agreed to share their voice. */
export const agreeToRecordings = (recipeId: string) =>
  api(`/recipes/${encodeURIComponent(recipeId)}/recording-consent`, {
    method: 'POST',
    body: { agreed: true },
  });

/** The cookbooks the household shares; none on a server without them. */
export const householdCookbooks = () =>
  api<HouseholdCookbook[]>('/household/cookbooks').catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  });

/** How long to wait for a recipe to be written down before leaving it to My recipes. */
export const WRITE_WAIT = 5 * 60_000;
const POLL = 2000;

/**
 * Waits for a family job to write its recipe down, and answers the new recipe's id; null once
 * `live` says the cook moved on. A failed job rejects with the server's reason.
 */
export async function writtenDown(job: AIJob, live: () => boolean): Promise<string | null> {
  const started = Date.now();
  while (job.status !== 'completed' && job.status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, POLL));
    if (!live()) return null;
    if (Date.now() - started > WRITE_WAIT)
      throw new Error('This is taking a while. The recipe will be in My recipes when it’s ready.');
    try {
      job = await api<AIJob>(`/ai/jobs/${encodeURIComponent(job.id)}`);
    } catch (e) {
      // A dropped connection just means another look; a session that ended won't come back.
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) throw e;
    }
    if (!live()) return null;
  }
  const id = (job.result as { recipeId?: string } | null)?.recipeId;
  if (job.status === 'failed' || !id) throw new Error(job.error || failed);
  return id;
}
