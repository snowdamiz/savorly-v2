import { expect, Page, test } from '@playwright/test';
import type { Creator, Kitchen, Library, Recipe } from '../src/lib/types';

// A kitchen with poor reception: what the device kept stands in for the API, recipes open from it,
// and trying again brings the real kitchen back. The API is mocked, and "down" aborts every request
// as a lost connection does.

const cook: Creator = {
  id: 'cook',
  name: 'Robin',
  handle: 'robin',
  bio: '',
  avatar: '',
  recipeCount: 3,
  followerCount: 0,
};
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
  ...extra,
});
const lemon = recipe('lemon-ricotta-pasta', 'Lemon pasta');
const soup = recipe('tomato-soup', 'Tomato soup', { saveCount: 3 });
// Saved, and not on the home: only the kitchen's library has it.
const saved = recipe('saved-stew', 'Saved stew');
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

async function kitchen(page: Page, { down = false } = {}) {
  const api = { down };
  const library: Library = {
    savedIds: [saved.id],
    saves: [{ recipeId: saved.id, collectionId: null }],
    collections: [],
    followingIds: [],
    recipes: [saved],
  };
  const pantry: Kitchen = { plans: [], groceries: [], pantry: [] };
  await page.route('**/v1/**', (route) => {
    if (api.down) return route.abort('internetdisconnected');
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/session') return json({ user });
    if (path === '/capabilities') return json({});
    if (path === '/feed') return json({ error: 'Not found' }, 404);
    if (path === '/recipes') return json([lemon, soup]);
    if (path === '/creators') return json([cook]);
    if (path === '/library') return json(library);
    if (path === '/kitchen') return json(pantry);
    const one = [lemon, soup, saved].find((r) => path === `/recipes/${r.id}`);
    if (one) return json(one);
    return json([]);
  });
  return api;
}

const banner = (page: Page) =>
  page.getByText('You’re offline. Showing what’s saved on this device.', { exact: true });
const recipeOpen = (page: Page) => page.getByRole('button', { name: 'Start cooking', exact: true });
/** What the device keeps (offline.ts): `snapshot`, written a second after loads, or `recent`. */
const kept = (page: Page, key: 'snapshot' | 'recent') =>
  page.evaluate((name) => localStorage.getItem(`savorly.offline.${name}`) ?? '', key);

test('offline, the kitchen this device kept shows, recipes open from it, and it reconnects', async ({
  page,
}) => {
  const api = await kitchen(page);
  await page.goto('/');
  await expect(page.getByText(/Good (morning|afternoon|evening), Alex/)).toBeVisible();
  // Opening a recipe keeps it on the device; the rest is kept a second after it loads.
  await page.getByRole('link', { name: 'View Tomato soup', exact: true }).click();
  await expect(recipeOpen(page)).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(() => kept(page, 'recent')).toContain('Tomato soup');
  await expect.poll(() => kept(page, 'snapshot')).toContain('Saved stew');

  api.down = true;
  await page.reload();
  await expect(banner(page)).toBeVisible();
  await expect(page.getByText('Let’s reconnect your kitchen', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Good (morning|afternoon|evening), Alex/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lemon pasta', level: 2 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Tomato soup', exact: true })).toBeVisible();
  // The saved recipes are there too, and cook from the device's copy.
  await page.getByRole('button', { name: 'My cookbooks', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View Saved stew', exact: true })).toBeVisible();

  // A link to a recipe the API can't send opens the copy kept here, and says so.
  await page.goto('/recipes/saved-stew');
  await expect(recipeOpen(page)).toBeVisible();
  await expect(
    page.getByText('Showing the copy saved on this device.', { exact: true }),
  ).toBeVisible();
  // Cooking mode works from it.
  await recipeOpen(page).click();
  const close = page.getByRole('button', { name: 'Close cooking mode', exact: true });
  await expect(close).toBeVisible();
  await expect(page.getByText('STEP 1 OF 1', { exact: true })).toBeVisible();
  await close.click();
  await expect(close).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(recipeOpen(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'My cookbooks', exact: true }).click();

  // Trying again while still offline keeps the kitchen on screen and says why.
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByText('We couldn’t reach your kitchen. Check your connection and try again.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(banner(page)).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Saved stew', exact: true })).toBeVisible();
  // The connection is back.
  api.down = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View Saved stew', exact: true })).toBeVisible();
});

test('the browser coming back online reconnects by itself', async ({ page, context }) => {
  const api = await kitchen(page);
  await page.goto('/');
  await expect(page.getByText(/Good (morning|afternoon|evening), Alex/)).toBeVisible();
  await expect.poll(() => kept(page, 'snapshot')).toContain('Saved stew');
  api.down = true;
  await page.reload();
  await expect(banner(page)).toBeVisible();
  api.down = false;
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(banner(page)).toHaveCount(0);
});

test('with nothing kept on the device, the reconnect page shows as before', async ({ page }) => {
  await kitchen(page, { down: true });
  await page.goto('/');
  await expect(page.getByText('Let’s reconnect your kitchen', { exact: true })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test('signing out takes the kitchen’s own copies off the device', async ({ page }) => {
  await kitchen(page);
  await page.goto('/');
  await expect(page.getByText(/Good (morning|afternoon|evening), Alex/)).toBeVisible();
  await expect.poll(() => kept(page, 'snapshot')).toContain('Saved stew');
  expect(await kept(page, 'snapshot')).toContain('alex@example.test');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('You’ve signed out. See you at the table.', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => kept(page, 'snapshot')).not.toContain('alex@example.test');
  const after = await kept(page, 'snapshot');
  expect(after).not.toContain('Saved stew');
  // Public recipes stay for the next visit.
  expect(after).toContain('Lemon pasta');
});
