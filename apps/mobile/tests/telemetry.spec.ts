import { expect, Page, test } from '@playwright/test';
import type { Creator, Recipe } from '../src/lib/types';
import { afterPageTimers } from './waits';

// What the app reports about itself: crashes to POST /client-errors, once each, and product
// events in batches to POST /events. The API is mocked.

const cook: Creator = {
  id: 'cook',
  name: 'Robin',
  handle: 'robin',
  bio: '',
  avatar: '',
  recipeCount: 2,
  followerCount: 0,
};
const recipe = (id: string, title: string): Recipe => ({
  id,
  title,
  description: '',
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Lemons', amount: 2, unit: '', category: 'Produce' }],
  steps: [{ title: 'Cook', text: 'Cook it gently.', seconds: 0 }],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: true,
  author: cook,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
});
const lemon = recipe('lemon-ricotta-pasta', 'Lemon pasta');
const soup = recipe('tomato-soup', 'Tomato soup');

type Sent = { body: Record<string, unknown>; type?: string };
async function kitchen(page: Page, { feed }: { feed?: unknown } = {}) {
  const errors: Sent[] = [];
  const events: Sent[] = [];
  await page.route('**/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/v1', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const sent = () => ({ body: request.postDataJSON(), type: request.headers()['content-type'] });
    if (path === '/client-errors') {
      errors.push(sent());
      return route.fulfill({ status: 204 });
    }
    if (path === '/events') {
      events.push(sent());
      return route.fulfill({ status: 204 });
    }
    if (path === '/session') return json({ user: null });
    if (path === '/capabilities') return json({});
    if (path === '/feed') return feed ? json(feed) : json({ error: 'Not found' }, 404);
    if (path === '/recipes')
      return json(url.searchParams.get('q') === 'lemon' ? [lemon] : [lemon, soup]);
    if (path === '/creators') return json([cook]);
    const one = [lemon, soup].find((r) => path === `/recipes/${r.id}`);
    if (one) return json(one);
    return json([]);
  });
  return { errors, events };
}

test('a screen that fails to render is reported once, with where it failed', async ({ page }) => {
  // A hero without its cook can't render.
  const broken = { ...lemon, author: null };
  const { errors } = await kitchen(page, {
    feed: { hero: broken, trending: [], quick: [], following: [], newest: [] },
  });
  await page.goto('/');
  await expect(
    page.getByText('Something needs a little attention.', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => errors.length).toBe(1);
  // Nothing else reports it again (the global handlers, React's retry).
  await afterPageTimers(page, 1500);
  expect(errors).toHaveLength(1);
  const [report] = errors;
  expect(report.type).toContain('application/json');
  expect(report.body).toMatchObject({
    message: expect.stringContaining('avatar'),
    stack: expect.stringContaining('Hero'),
    componentStack: expect.stringContaining('Hero'),
    platform: 'web',
    appVersion: expect.any(String),
    release: expect.any(String),
    url: expect.stringMatching(/^http:\/\/localhost:\d+\/$/),
  });
});

test('uncaught errors and unhandled rejections are reported, each once', async ({ page }) => {
  const { errors } = await kitchen(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Lemon pasta', level: 2 })).toBeVisible();
  await page.evaluate(() => {
    for (let n = 0; n < 3; n++)
      setTimeout(() => {
        throw new Error('Thrown from a timer');
      });
    void Promise.reject(new Error('A promise nobody caught'));
  });
  await expect
    .poll(() => errors.map((e) => e.body.message).sort())
    .toEqual(['A promise nobody caught', 'Thrown from a timer']);
  await afterPageTimers(page, 500);
  expect(errors).toHaveLength(2);
});

test.describe('a cook’s visit', () => {
  // Automated browsers aren't counted, so this one passes for an ordinary Chrome.
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });

  test('events are batched to /events, and sent when the page is hidden', async ({ page }) => {
    await page.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }),
    );
    const { events } = await kitchen(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Lemon pasta', level: 2 })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search recipes', exact: true }).fill('lemon');
    const result = page.getByRole('link', { name: 'View Lemon pasta', exact: true });
    await expect(result).toBeVisible();
    // A search counts once its results have been on screen for 1.5 seconds (Discover). Waiting
    // on the page's own timers runs that one first, however late a busy machine runs them.
    await afterPageTimers(page, 1800);
    await result.click();
    await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close cooking mode' })).toBeVisible();
    expect(events).toHaveLength(0);
    // About ten seconds after the first, they travel together.
    await expect.poll(() => events.length, { timeout: 15_000 }).toBe(1);
    const [batch] = events;
    expect(batch.type).toContain('application/json');
    expect(batch.body.session).toEqual(expect.any(String));
    expect(batch.body.events).toEqual([
      { name: 'search', props: { query: 'lemon', results: 1 }, at: expect.any(String) },
      {
        name: 'recipe_open',
        props: { recipeId: 'lemon-ricotta-pasta', from: 'search' },
        at: expect.any(String),
      },
      { name: 'cook_start', props: { recipeId: 'lemon-ricotta-pasta' }, at: expect.any(String) },
    ]);
    // Leaving the page sends what is waiting at once, in the same session.
    await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
    await page.goto('/recipes/tomato-soup');
    await expect(page.getByRole('button', { name: 'Start cooking', exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => events.length).toBe(2);
    expect(events[1].body.events).toEqual([
      {
        name: 'recipe_open',
        props: { recipeId: 'tomato-soup', from: 'link' },
        at: expect.any(String),
      },
    ]);
    // A new page load is a new session.
    expect(events[1].body.session).not.toBe(batch.body.session);
  });

  test('automated browsers send no events', async ({ page }) => {
    const { events } = await kitchen(page);
    await page.goto('/recipes/tomato-soup');
    await expect(page.getByRole('button', { name: 'Start cooking', exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await afterPageTimers(page, 500);
    expect(events).toHaveLength(0);
  });
});
