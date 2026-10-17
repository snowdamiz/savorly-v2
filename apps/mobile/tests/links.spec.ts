import { expect, Page, test } from '@playwright/test';
import type { Creator, Recipe } from '../src/lib/types';

// Recipe pages have their own addresses (/recipes/<id>), older /?recipe= links still open, cards
// are real links, and pages have headings. The API is mocked.

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
  description: `${title}, simply.`,
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Pasta', amount: 200, unit: 'g', category: 'Pantry' }],
  steps: [{ title: 'Cook', text: 'Boil the pasta until tender.', seconds: 0 }],
  tags: [],
  calories: 300,
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
// On a desktop the four most saved trend; the three others are the weeknight winners.
const others = [
  recipe('tomato-soup', 'Tomato soup', { saveCount: 9, minutes: 35 }),
  recipe('green-salad', 'Green salad', { saveCount: 8, minutes: 10 }),
  recipe('rice-bowl', 'Rice bowl', { saveCount: 7, minutes: 25 }),
  recipe('bean-chili', 'Bean chili', { saveCount: 6, minutes: 50 }),
  recipe('herb-omelette', 'Herb omelette', { saveCount: 1, minutes: 12 }),
  recipe('miso-noodles', 'Miso noodles', { saveCount: 1, minutes: 15 }),
  recipe('fried-rice', 'Fried rice', { saveCount: 0, minutes: 18 }),
];
const all = [lemon, ...others];

/** A guest's kitchen; returns the API paths asked for. */
async function guest(page: Page) {
  const asked: string[] = [];
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    asked.push(`${route.request().method()} ${path}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/session') return json({ user: null });
    if (path === '/capabilities') return json({});
    if (path === '/recipes') return json(all);
    if (path === '/creators') return json([cook]);
    if (path === '/feed') return json({ error: 'Not found' }, 404);
    const one = all.find((r) => path === `/recipes/${r.id}`);
    if (one) return json(one);
    if (path.startsWith('/recipes/') && path.split('/').length === 3)
      return json({ error: 'We couldn’t find that recipe.' }, 404);
    return json([]);
  });
  return asked;
}

// A mark the page keeps until it reloads: in-app navigation keeps it.
const mark = (page: Page) => page.evaluate(() => Object.assign(window, { stayed: true }));
const stayed = (page: Page) =>
  page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed === true);
const recipeOpen = (page: Page) => page.getByRole('button', { name: 'Start cooking', exact: true });

test('a recipe link opens the recipe, and Back returns to where the cook was', async ({ page }) => {
  await guest(page);
  await page.goto('/recipes/tomato-soup');
  await expect(recipeOpen(page)).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/tomato-soup$/);
  await expect(page).toHaveTitle('Tomato soup · Savorly');
  // From the home, a card opens its recipe in the app (no page load), and Back closes it again.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Lemon pasta', level: 2 })).toBeVisible();
  await mark(page);
  await page.getByRole('link', { name: 'View Tomato soup', exact: true }).click();
  await expect(recipeOpen(page)).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/tomato-soup$/);
  expect(await stayed(page)).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect(recipeOpen(page)).toHaveCount(0);
  await expect(page.getByText('What would you like to cook today?', { exact: true })).toBeVisible();
  expect(await stayed(page)).toBe(true);
  // Forward opens it again; closing it leaves the page's own address.
  await page.goForward();
  await expect(recipeOpen(page)).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(recipeOpen(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\?page=discover$/);
});

test('a recipe page has a heading outline: the title, then its sections and steps', async ({
  page,
}) => {
  await guest(page);
  await page.goto('/recipes/tomato-soup');
  await expect(recipeOpen(page)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Tomato soup']);
  for (const section of ['Ingredients', 'Let’s make it', 'Around the table'])
    await expect(page.getByRole('heading', { name: section, exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cook', exact: true, level: 3 })).toBeVisible();
});

test('an older ?recipe= link opens the recipe and takes its new address', async ({ page }) => {
  await guest(page);
  await page.goto('/?recipe=lemon-ricotta-pasta');
  await expect(recipeOpen(page)).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/lemon-ricotta-pasta$/);
  // Rewritten in place, not added: Back doesn't return to the old form.
  await page.goBack().catch(() => null);
  expect(page.url()).not.toContain('recipe=');
});

test('an unknown recipe says so, and screens keep their ?page= addresses', async ({ page }) => {
  await guest(page);
  await page.goto('/recipes/no-such-recipe');
  await expect(page.getByText('We couldn’t find that recipe.', { exact: true })).toBeVisible();
  await expect(recipeOpen(page)).toHaveCount(0);
  await page.goto('/?page=explore');
  await expect(page.getByRole('heading', { name: 'Explore', level: 1 })).toBeVisible();
});

test('recipe cards are real links, and the home has headings', async ({ page, context }) => {
  await guest(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trending now', level: 2 })).toBeVisible();
  // The hero, the trending row and the weeknight rows: every recipe on the page, each a link.
  const links = page.locator('a[href^="/recipes/"]');
  await expect(links).toHaveCount(all.length);
  const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(new Set(hrefs)).toEqual(new Set(all.map((r) => `/recipes/${r.id}`)));
  await expect(page.getByRole('link', { name: 'Let’s get cooking: Lemon pasta' })).toHaveAttribute(
    'href',
    '/recipes/lemon-ricotta-pasta',
  );
  // One page title, sections under it, recipes under those.
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('What would you like to cook today?');
  const sections = await page.locator('h2').allInnerTexts();
  expect(sections).toEqual(
    expect.arrayContaining([
      'Lemon pasta',
      'Trending now',
      'Not sure what to make?',
      'Weeknight winners',
      'Cooks to follow',
    ]),
  );
  const cards = await page.locator('a[href^="/recipes/"] h3').allInnerTexts();
  expect(cards.sort()).toEqual(others.map((r) => r.title).sort());
  // A modified click is the browser's: a new tab at the recipe's address, this page unchanged.
  await mark(page);
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: 'View Green salad', exact: true }).click({
      modifiers: ['ControlOrMeta'],
    }),
  ]);
  await expect(tab).toHaveURL(/\/recipes\/green-salad$/);
  await tab.close();
  await expect(recipeOpen(page)).toHaveCount(0);
  expect(await stayed(page)).toBe(true);
});

test('a cookbook link opens the cookbook page', async ({ page }) => {
  await guest(page);
  await page.goto('/cookbooks/weeknights');
  await expect(page.getByTestId('cookbook-page')).toBeVisible();
  await expect(page.getByText('What would you like to cook today?', { exact: true })).toHaveCount(
    0,
  );
  // Moving on closes it.
  await page.getByRole('button', { name: 'Explore recipes', exact: true }).click();
  await expect(page.getByTestId('cookbook-page')).toHaveCount(0);
  await expect(page).toHaveURL(/\?page=explore$/);
  // Back returns to it.
  await page.goBack();
  await expect(page.getByTestId('cookbook-page')).toBeVisible();
  await expect(page).toHaveURL(/\/cookbooks\/weeknights$/);
});
