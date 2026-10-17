/// <reference types="jest" />
import { studioPollDelay } from '../studioPace';
import type { StudioProject } from '../types';

const project = (changes: Partial<StudioProject> = {}): StudioProject => ({
  id: 'p1',
  recipeId: null,
  recipe: null,
  revision: 0,
  status: 'listening',
  busy: false,
  reply: '',
  error: '',
  assets: [],
  updatedAt: '2026-10-17T12:00:00Z',
  ...changes,
});

test('a reply on its way is looked for soon', () => {
  expect(studioPollDelay(project({ busy: true }), true)).toBe(1200);
});

test('a live call keeps its transcript current', () => {
  expect(studioPollDelay(project(), true)).toBe(1500);
});

test('media still being made is looked at less often', () => {
  const making = project({
    assets: [
      { kind: 'image', status: 'completed', error: '' },
      { kind: 'video', status: 'processing', error: '' },
    ],
  });
  expect(studioPollDelay(making, false)).toBe(4000);
});

test('a quiet conversation is looked at least', () => {
  const done = project({ assets: [{ kind: 'image', status: 'failed', error: 'No credit.' }] });
  expect(studioPollDelay(done, false)).toBe(6000);
  expect(studioPollDelay(null, false)).toBe(6000);
});
