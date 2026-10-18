import { expect, Page, test } from '@playwright/test';
import type { Creator, Library, Recipe } from '../src/lib/types';
import { afterPageTimers } from './waits';

// Who is signed in comes from GET /session (no 401s for guests), the home's shelves from GET /feed
// (each recipe once, worked out on the device when /feed fails), the activity sheet from
// GET /recipes?following=true, and the kitchen from a window of days. The API is mocked.

const cook: Creator = {
  id: 'cook',
  name: 'Robin',
  handle: 'robin',
  bio: '',
  avatar: '',
  recipeCount: 2,
  followerCount: 0,
};
const friend: Creator = { ...cook, id: 'friend', name: 'Sam', handle: 'sam' };
const recipe = (id: string, title: string, extra: Partial<Recipe> = {}): Recipe => ({
  id,
  title,
  description: '',
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [],
  steps: [{ title: '', text: 'Cook it.', seconds: 0 }],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: true,
  author: cook,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
  ...extra,
});
const user = {
  ...cook,
  id: 'me',
  name: 'Alex',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
  identities: [],
  hasPassword: true,
  plan: 'free',
  onboarded: true,
};

const hero = recipe('sunday-roast', 'Sunday roast');
const t1 = recipe('trend-one', 'Trend one', { rating: 4.8, reviewCount: 12 });
const t2 = recipe('trend-two', 'Trend two', { rating: 5, reviewCount: 1 });
const q1 = recipe('quick-one', 'Quick one', { minutes: 10 });
const f1 = recipe('friends-stew', 'Friend’s stew', { author: friend });
const feed = {
  hero,
  trending: [t1, t2],
  // The server's quick shelf can repeat a trending recipe; the home shows it once.
  quick: [t2, q1],
  following: [f1],
  newest: [],
};
// The plain list (GET /recipes) the computed shelves use when /feed fails.
const listed = [recipe('lemon-ricotta-pasta', 'Lemon pasta'), recipe('plain-two', 'Plain two')];

async function kitchen(
  page: Page,
  options: { signedIn?: boolean; feed?: 'ok' | 'missing' | 'failing' } = {},
) {
  const asked: string[] = [];
  const statuses: number[] = [];
  const library: Library = {
    savedIds: [],
    saves: [],
    collections: [],
    followingIds: ['friend'],
    recipes: [],
  };
  page.on('response', (response) => {
    if (response.url().includes('/v1/')) statuses.push(response.status());
  });
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    asked.push(`${route.request().method()} ${path}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/session') return json({ user: options.signedIn ? user : null });
    if (path === '/me')
      return options.signedIn ? json(user) : json({ error: 'Sign in to continue.' }, 401);
    if (path === '/capabilities') return json({});
    if (path === '/feed') {
      if (options.feed === 'missing') return json({ error: 'Not found' }, 404);
      if (options.feed === 'failing') return json({ error: 'Something went wrong.' }, 500);
      return json(feed);
    }
    if (path === '/recipes')
      return json(url.searchParams.get('following') === 'true' ? [f1] : listed);
    if (path === '/creators') return json([cook, friend]);
    if (path === '/library') return json(library);
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    return json([]);
  });
  return { asked, statuses };
}

const href = (page: Page, id: string) => page.locator(`a[href="/recipes/${id}"]`);

test('a guest’s visit asks GET /session, never /me, and gets no 401s', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const { asked, statuses } = await kitchen(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sunday roast', level: 2 })).toBeVisible();
  // Anything the page had scheduled to ask for has been asked by now.
  await afterPageTimers(page, 500);
  expect(asked).toContain('GET /session');
  expect(asked.filter((a) => a.startsWith('GET /me'))).toEqual([]);
  // A guest has no library or kitchen to ask for.
  expect(asked.filter((a) => /^GET \/(library|kitchen)/.test(a))).toEqual([]);
  expect(statuses.filter((s) => s === 401)).toEqual([]);
  expect(errors.filter((e) => /401|Unauthorized/.test(e))).toEqual([]);
});

test('a signed-in kitchen comes from the session, and its plans for a window of weeks', async ({
  page,
}) => {
  const { asked } = await kitchen(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByText(/Good (morning|afternoon|evening), Alex/)).toBeVisible();
  await expect.poll(() => asked.find((a) => a.startsWith('GET /kitchen'))).toBeTruthy();
  expect(asked.filter((a) => a.startsWith('GET /me'))).toEqual([]);
  const window = asked.find((a) => a.startsWith('GET /kitchen'))!;
  const [, from, to] = /from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/.exec(window) ?? [];
  const day = 86_400_000;
  // The window is in the cook's own days, so today is the local date (as UTC midnight, like
  // Date.parse reads the window's dates), not the UTC one, which is already tomorrow in the
  // evening west of Greenwich.
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  // Last week's start through four weeks ahead: six whole weeks around today.
  expect((Date.parse(to) - Date.parse(from)) / day + 1).toBe(42);
  expect((today - Date.parse(from)) / day).toBeGreaterThanOrEqual(7);
  expect((today - Date.parse(from)) / day).toBeLessThanOrEqual(13);
});

test('GET /feed fills the shelves, each recipe once', async ({ page }) => {
  const { asked } = await kitchen(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sunday roast', level: 2 })).toBeVisible();
  expect(asked).toContain('GET /feed?limit=12');
  await expect(page.getByRole('heading', { name: 'Trending now', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Weeknight winners', level: 2 })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'From kitchens you follow', level: 2 }),
  ).toBeVisible();
  // Trend two is both trending and quick on the server; the page shows it once.
  for (const id of ['sunday-roast', 'trend-one', 'trend-two', 'quick-one', 'friends-stew'])
    await expect(href(page, id)).toHaveCount(1);
  // The plain list isn't what the home shows any more.
  await expect(href(page, 'plain-two')).toHaveCount(0);
  // Ratings come with how many reviews they're from.
  await expect(page.getByRole('img', { name: 'Rated 4.8 from 12 reviews' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Rated 5.0 from 1 review' })).toBeVisible();
  await expect(page.getByText('4.8 · 12', { exact: true })).toBeVisible();
});

for (const failure of ['missing', 'failing'] as const)
  test(`without /feed (${failure}) the home works its shelves out itself`, async ({ page }) => {
    await kitchen(page, { feed: failure });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Lemon pasta', level: 2 })).toBeVisible();
    await expect(href(page, 'plain-two')).toHaveCount(1);
    await expect(href(page, 'sunday-roast')).toHaveCount(0);
    // A guest follows no one.
    await expect(page.getByRole('heading', { name: 'From kitchens you follow' })).toHaveCount(0);
  });

test('the activity sheet shows GET /recipes?following=true', async ({ page }) => {
  const { asked } = await kitchen(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByText(/Good (morning|afternoon|evening), Alex/)).toBeVisible();
  await page.getByRole('button', { name: 'Kitchen activity', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Friend’s stew', { exact: true })).toBeVisible();
  await expect(sheet.getByText('New from Sam', { exact: true })).toBeVisible();
  expect(asked).toContain('GET /recipes?following=true&limit=8');
  // It opens the recipe, in place of the sheet.
  await sheet.getByRole('link', { name: /Friend’s stew/ }).click();
  await expect(page.getByRole('button', { name: 'Start cooking', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/friends-stew$/);
});
