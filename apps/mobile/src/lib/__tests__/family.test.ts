/// <reference types="jest" />
import { API_URL } from '../api';
import { awaitingConsent, stepVoice, writtenDown } from '../family';
import type { AIJob, RecipeRecording } from '../types';

const nonna: RecipeRecording = {
  id: 'r1',
  speaker: 'Nonna Rosa',
  url: 'https://media.test/uploads/cook/r1.m4a',
  durationMs: 12500,
  consented: false,
};

test('a step plays the stretch of its recipe’s own recording, and nothing else', () => {
  const recipe = { recordings: [nonna] };
  expect(stepVoice(recipe, { voice: { recording: 'r1', startMs: 4300, endMs: 12500 } })).toEqual({
    url: nonna.url,
    startMs: 4300,
    endMs: 12500,
    speaker: 'Nonna Rosa',
  });
  // No voice, another recipe's recording, an empty stretch, or a server without recordings.
  expect(stepVoice(recipe, {})).toBeNull();
  expect(stepVoice(recipe, { voice: null })).toBeNull();
  expect(stepVoice(recipe, { voice: { recording: 'r2', startMs: 0, endMs: 900 } })).toBeNull();
  expect(stepVoice(recipe, { voice: { recording: 'r1', startMs: 900, endMs: 900 } })).toBeNull();
  expect(stepVoice({}, { voice: { recording: 'r1', startMs: 0, endMs: 900 } })).toBeNull();
});

test('publishing waits on everyone recorded who hasn’t agreed yet', () => {
  const grandpa = { ...nonna, id: 'r2', speaker: 'Grandpa', consented: true };
  expect(awaitingConsent({ recordings: [nonna, grandpa, { ...nonna, id: 'r3' }] })).toEqual([
    'Nonna Rosa',
  ]);
  expect(awaitingConsent({ recordings: [grandpa] })).toEqual([]);
  expect(awaitingConsent({})).toEqual([]);
});

describe('waiting for a recipe to be written down', () => {
  const answers: Partial<AIJob>[] = [];
  beforeEach(() => {
    jest.useFakeTimers();
    answers.length = 0;
    global.fetch = jest.fn((url: string) => {
      expect(url).toBe(`${API_URL}/v1/ai/jobs/j1`);
      const next = answers.shift();
      return Promise.resolve({
        status: next ? 200 : 502,
        ok: !!next,
        text: () => Promise.resolve(JSON.stringify(next ?? { error: 'Bad gateway.' })),
      });
    }) as unknown as typeof fetch;
  });
  afterEach(() => jest.useRealTimers());
  const job = { id: 'j1', status: 'queued', result: {}, error: '' } as unknown as AIJob;
  // Runs the clock until the wait settles, catching what it rejects with as it happens.
  const settle = async <T>(wait: Promise<T>) => {
    const outcome = wait.then(
      (value) => ({ value, error: null }),
      (error: Error) => ({ value: null, error }),
    );
    for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(1000);
    return outcome;
  };

  test('answers the new recipe once the job completes', async () => {
    answers.push(
      { ...job, status: 'running' },
      { ...job, status: 'completed', result: { recipeId: 'new' } as AIJob['result'] },
    );
    expect(await settle(writtenDown(job, () => true))).toEqual({ value: 'new', error: null });
  });

  test('says why when it fails', async () => {
    answers.push({
      ...job,
      status: 'failed',
      error: 'The card couldn’t be read. Please try again.',
    });
    const { error } = await settle(writtenDown(job, () => true));
    expect(error?.message).toBe('The card couldn’t be read. Please try again.');
  });

  test('stops waiting once the cook moves on', async () => {
    let live = true;
    const wait = writtenDown(job, () => live);
    live = false;
    expect(await settle(wait)).toEqual({ value: null, error: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
