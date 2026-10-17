/// <reference types="jest" />
import { API_URL, ApiError } from '../api';
import { importError, importRecipe, postCreator, postPlatform, recipeLink } from '../recipeImport';
import type { AIJob, RecipeInput } from '../types';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const soup: RecipeInput = {
  title: 'Leek soup',
  description: 'From a blog.',
  cuisine: 'French',
  minutes: 30,
  servings: 4,
  difficulty: 'Easy',
  image: 'https://media.test/soup.jpg',
  video: '',
  ingredients: [{ name: 'Leeks', amount: 3, unit: '', category: 'Produce' }],
  steps: [{ title: 'Simmer', text: 'Simmer the leeks.', seconds: 900 }],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: false,
  sourceUrl: 'https://blog.test/leek-soup',
};
const job = (status: AIJob['status'], recipe?: RecipeInput): AIJob => ({
  id: 'import-1',
  kind: 'recipe',
  prompt: '',
  status,
  result: recipe ? { recipe } : {},
  error: status === 'failed' ? 'The model gave up.' : '',
  createdAt: '2026-10-16T12:00:00Z',
});
let answers: { path: string; status: number; body: unknown }[] = [];
const asked: string[] = [];
beforeEach(() => {
  answers = [];
  asked.length = 0;
  global.fetch = jest.fn((url: string) => {
    const path = url.replace(`${API_URL}/v1`, '');
    asked.push(path);
    const index = answers.findIndex((answer) => answer.path === path);
    const { status, body } =
      index < 0 ? { status: 404, body: { error: 'Not found.' } } : answers.splice(index, 1)[0];
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }) as unknown as typeof fetch;
});
afterEach(() => jest.useRealTimers());

test('finds the link in whatever was pasted', () => {
  expect(recipeLink('  https://blog.test/leek-soup  ')).toBe('https://blog.test/leek-soup');
  expect(recipeLink('Try this! https://blog.test/leek-soup.')).toBe('https://blog.test/leek-soup');
  expect(recipeLink('blog.test/leek-soup')).toBe('https://blog.test/leek-soup');
  expect(recipeLink('http://www.example.com/a?b=c#d')).toBe('http://www.example.com/a?b=c#d');
  for (const bad of [
    '',
    'leek soup',
    'ftp://blog.test/soup',
    'https://localhost/x',
    'cook@blog.test',
  ])
    expect(recipeLink(bad)).toBe('');
});

test('a page with recipe data opens straight away, private and crediting the page', async () => {
  answers.push({
    path: '/recipes/import',
    status: 200,
    body: { method: 'structured', recipe: { ...soup, published: true, tags: null } },
  });
  const result = await importRecipe('https://blog.test/leek-soup', { live: () => true });
  expect(result?.method).toBe('structured');
  expect(result?.recipe).toMatchObject({
    title: 'Leek soup',
    published: false,
    tags: [],
    photos: [],
    sourceUrl: 'https://blog.test/leek-soup',
  });
});

test('otherwise the sous-chef reads the page while the app waits', async () => {
  jest.useFakeTimers();
  answers.push(
    { path: '/recipes/import', status: 202, body: { method: 'ai', job: job('queued') } },
    { path: '/ai/jobs/import-1', status: 200, body: job('running') },
    {
      path: '/ai/jobs/import-1',
      status: 200,
      body: job('completed', { ...soup, aiGenerated: true, sourceUrl: '' }),
    },
  );
  const reading = jest.fn();
  const imported = importRecipe('https://blog.test/leek-soup', {
    live: () => true,
    onReading: reading,
  });
  await jest.advanceTimersByTimeAsync(4100);
  const result = await imported;
  expect(reading).toHaveBeenCalledTimes(1);
  expect(result?.method).toBe('ai');
  // The server credits the page; an answer without it still gets the link that was imported.
  expect(result?.recipe).toMatchObject({
    aiGenerated: true,
    sourceUrl: 'https://blog.test/leek-soup',
  });
  expect(asked).toEqual(['/recipes/import', '/ai/jobs/import-1', '/ai/jobs/import-1']);
});

test('a failed reading, or a wait the cook left, ends without a recipe', async () => {
  jest.useFakeTimers();
  answers.push(
    { path: '/recipes/import', status: 202, body: { method: 'ai', job: job('queued') } },
    { path: '/ai/jobs/import-1', status: 200, body: job('failed') },
  );
  const failed = expect(
    importRecipe('https://blog.test/soup', { live: () => true }),
  ).rejects.toThrow('We couldn’t read a recipe from that page.');
  await jest.advanceTimersByTimeAsync(2100);
  await failed;

  answers.push({
    path: '/recipes/import',
    status: 202,
    body: { method: 'ai', job: job('queued') },
  });
  let live = true;
  const left = importRecipe('https://blog.test/soup', { live: () => live });
  await jest.advanceTimersByTimeAsync(10);
  live = false;
  await jest.advanceTimersByTimeAsync(2100);
  await expect(left).resolves.toBeNull();
});

test('each refusal reads as what it means', async () => {
  for (const [status, message] of [
    [400, 'That doesn’t look like a link to a recipe page. Check it and try again.'],
    [422, 'We couldn’t find a recipe on that page.'],
    [502, 'We couldn’t open that page.'],
    [503, 'We couldn’t read a recipe from that page.'],
    [404, 'Importing from a link isn’t available yet.'],
  ] as const) {
    answers.push({ path: '/recipes/import', status, body: { error: 'Server words.' } });
    const failure = await importRecipe('https://blog.test/soup', { live: () => true }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(importError(failure)).toBe(message);
  }
  // Anything else keeps the server's own message, such as a rate limit.
  expect(importError(new ApiError(429, 'Too many requests.'))).toBe('Too many requests.');
});

const captionless =
  'We couldn’t find a recipe in that post’s caption. Try the link to the full recipe if the creator shared one.';

test('a video post’s refusals keep the server’s words, which say more than the status', async () => {
  expect(importError(new ApiError(422, captionless))).toBe(captionless);
  const gone = 'We couldn’t open that post. It may be private or no longer available.';
  expect(importError(new ApiError(502, gone))).toBe(gone);
  // A caption the sous-chef found no recipe in says so too.
  jest.useFakeTimers();
  answers.push(
    { path: '/recipes/import', status: 202, body: { method: 'ai', job: job('queued') } },
    { path: '/ai/jobs/import-1', status: 200, body: { ...job('failed'), error: captionless } },
  );
  const failed = expect(
    importRecipe('https://vm.tiktok.com/ZMabc123/', { live: () => true }),
  ).rejects.toThrow(captionless);
  await jest.advanceTimersByTimeAsync(2100);
  await failed;
});

test('links to video and photo posts are told apart from pages', () => {
  for (const [url, platform] of [
    ['https://vm.tiktok.com/ZMabc123/', 'TikTok'],
    ['https://www.tiktok.com/@chefjo/video/7300000000000000001', 'TikTok'],
    ['https://www.instagram.com/reel/C5aKbmTOTA6/', 'Instagram'],
    ['https://youtu.be/dQw4w9WgXcQ', 'YouTube'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'YouTube'],
    ['https://fb.watch/abc123/', 'Facebook'],
    ['https://www.facebook.com/reel/1050738759418766', 'Facebook'],
    ['https://pin.it/1Zx2y3', 'Pinterest'],
    ['https://uk.pinterest.com/pin/99360735500167749/', 'Pinterest'],
    ['https://www.pinterest.co.uk/pin/99360735500167749/', 'Pinterest'],
    ['https://blog.test/leek-soup', ''],
    ['https://faketiktok.com/@a/video/1', ''],
    ['not a link', ''],
    ['', ''],
  ])
    expect(postPlatform(url)).toBe(platform);
  // A TikTok's own address names its creator; nothing else's does.
  expect(postCreator('https://www.tiktok.com/@chef.jo/video/7300000000000000001')).toBe('@chef.jo');
  expect(postCreator('https://www.tiktok.com/@/video/7300000000000000001')).toBe('');
  expect(postCreator('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('');
  expect(postCreator(undefined)).toBe('');
});
