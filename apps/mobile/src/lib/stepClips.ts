import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AIJob, RecipeStep, StepClipJob } from './types';

// AI clips of a saved recipe's steps. The server makes one for each step without a clip when the
// cook asks, and puts each on the step with the same text once it's ready; the editor follows
// along so a clip that finishes while it's open shows up there too.

export const makingClip = (status: AIJob['status']) =>
  status === 'queued' || status === 'running' || status === 'processing';

/** The steps a clip would be made for: those without one or one on its way, once per text. */
export function stepsWithoutClips(steps: RecipeStep[], clips: StepClipJob[]) {
  const taken = new Set(clips.filter((c) => makingClip(c.status)).map((c) => c.text));
  return steps.filter((step) => {
    const text = step.text.trim();
    if (step.video || !text || taken.has(text)) return false;
    taken.add(text);
    return true;
  });
}

/** The clip on its way for a step, if any. */
export const clipFor = (step: RecipeStep, clips: StepClipJob[]) =>
  clips.find((c) => c.text === step.text.trim() && makingClip(c.status));

const POLL_MS = 5000;

/**
 * The clips of one of the member's recipes (`recipe`, its id; none for a recipe not saved yet):
 * those on their way, checked every few seconds while there are any. A clip that finishes while
 * this is open goes to `onReady` with its step's text; one that fails is in `failed`, by text,
 * until it's asked for again. Clips that finished before stay out of it: the server already
 * put them on their steps, or the cook has since removed them.
 */
export function useStepClips(
  recipe: string | undefined,
  enabled: boolean,
  onReady: (text: string, url: string) => void,
) {
  const [clips, setClips] = useState<StepClipJob[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const waiting = useRef(new Set<string>());
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);
  const take = useCallback((list: StepClipJob[]) => {
    const lost: string[] = [];
    for (const clip of list) {
      if (makingClip(clip.status)) waiting.current.add(clip.text);
      else if (waiting.current.delete(clip.text)) {
        if (clip.status === 'completed' && clip.url) ready.current(clip.text, clip.url);
        else lost.push(clip.text);
      }
    }
    setClips(list);
    setFailed((old) => [...old.filter((text) => !waiting.current.has(text)), ...lost]);
  }, []);
  const path = recipe ? `/recipes/${encodeURIComponent(recipe)}/step-clips` : '';
  const busy = clips.some((c) => makingClip(c.status));
  useEffect(() => {
    if (!path || !enabled) return;
    let alive = true;
    const look = () =>
      api<{ clips: StepClipJob[] }>(path)
        .then((out) => alive && take(out.clips))
        .catch(() => {});
    if (!busy) void look();
    const timer = busy ? setInterval(look, POLL_MS) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [path, enabled, busy, take]);
  /** Asks for a clip of every step without one, once per `key`. */
  const order = useCallback(
    async (key: string) => {
      if (!path) return;
      const out = await api<{ clips: StepClipJob[] }>(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
      });
      take(out.clips);
    },
    [path, take],
  );
  return { clips, failed, busy, order };
}
