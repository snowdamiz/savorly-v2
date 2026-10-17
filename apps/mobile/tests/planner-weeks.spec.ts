import { expect, Page, test } from '@playwright/test';
import type { Creator, GroceryMerge, Plan, Recipe } from '../src/lib/types';

// Fixed dates need a fixed zone: the clock starts at midday on Friday 16 October 2026 and runs on,
// so the app's animations still finish.
test.use({ timezoneId: 'UTC' });
const NOW = new Date('2026-10-16T12:00:00Z');

const cook: Creator = {
  id: 'me',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  recipeCount: 0,
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
  ingredients: [{ name: 'Lemon', amount: 1, unit: '', category: 'Produce' }],
  steps: [],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: true,
  author: cook,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
});
const soup = recipe('soup', 'Pumpkin soup');
const pasta = recipe('pasta', 'Lemon pasta');
const plan = (id: string, day: string, meal: string, r: Recipe): Plan => ({
  id,
  recipeId: r.id,
  day,
  meal,
  servings: 2,
  recipe: r,
});

/**
 * A signed-in kitchen whose server keeps `plans`. Asked without dates, /kitchen answers only the
 * previous week to four weeks ahead, as the app's windowed store gets them; with dates, that range.
 */
async function planner(page: Page, plans: Plan[], merge: GroceryMerge = { added: 0, merged: 0 }) {
  const requests: string[] = [];
  const posted: unknown[] = [];
  await page.clock.install({ time: NOW });
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    requests.push(`${method} ${path}${url.search}`);
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/me' || path === '/session') {
      const user = {
        ...cook,
        email: 'alex@example.test',
        preferences: { diets: [], allergies: [] },
        identities: [],
        hasPassword: true,
        plan: 'free',
        onboarded: true,
      };
      return reply(path === '/session' ? { user } : user);
    }
    if (path === '/capabilities') return reply({});
    if (path === '/recipes') return reply([pasta, soup]);
    if (path === '/creators') return reply([cook]);
    if (path === '/library')
      return reply({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/household') return reply(null);
    if (path === '/kitchen') {
      const from = url.searchParams.get('from') || '2026-10-04';
      const to = url.searchParams.get('to') || '2026-11-14';
      const shown = plans.filter((p) => p.day >= from && p.day <= to);
      return reply({ plans: shown, groceries: [], pantry: [] });
    }
    if (path === '/planner' && method === 'POST') {
      const body = route.request().postDataJSON();
      const r = [pasta, soup].find((x) => x.id === body.recipeId)!;
      plans.push(plan(`p${plans.length + 1}`, body.day, body.meal, r));
      return reply({ ok: true });
    }
    if (path.startsWith('/planner/') && method === 'DELETE') {
      const at = plans.findIndex((p) => `/planner/${p.id}` === path);
      if (at >= 0) plans.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    if (path === '/planner/groceries' && method === 'POST') {
      posted.push(route.request().postDataJSON());
      return reply(merge);
    }
    return reply([]);
  });
  return { requests, posted };
}

test('a week past the store’s plans is asked for on its own, and again after each change', async ({
  page,
}) => {
  const plans = [plan('far', '2026-11-18', 'Dinner', soup)];
  const { requests } = await planner(page, plans);
  await page.goto('/?page=planner');
  await expect(page.getByText('Oct 11 – Oct 17', { exact: true })).toBeVisible();
  const next = page.getByRole('button', { name: 'Next week', exact: true });
  for (let i = 0; i < 5; i++) await next.click();
  await expect(page.getByText('Nov 15 – Nov 21', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Pumpkin soup', exact: true })).toBeVisible();
  await expect(page.getByText('Tap for this week · 1 planned', { exact: true })).toBeVisible();
  expect(requests).toContain('GET /kitchen?from=2026-11-15&to=2026-11-21');

  // Removing the plan asks for the week again, and the slot empties.
  requests.length = 0;
  await page
    .getByRole('button', { name: 'Remove Dinner on Wednesday, November 18', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'View Pumpkin soup', exact: true })).toHaveCount(0);
  await expect(page.getByText('Tap for this week · 0 planned', { exact: true })).toBeVisible();
  expect(requests).toContain('DELETE /planner/far');
  expect(requests).toContain('GET /kitchen?from=2026-11-15&to=2026-11-21');

  // So does planning a meal there.
  await page.getByRole('button', { name: 'Add Breakfast', exact: true }).first().click();
  await page.getByRole('button', { name: 'Plan Lemon pasta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Lemon pasta', exact: true })).toBeVisible();
  expect(plans).toEqual([
    expect.objectContaining({ day: '2026-11-15', meal: 'Breakfast', recipeId: 'pasta' }),
  ]);

  // The weeks the store holds don't ask again.
  requests.length = 0;
  await page.getByRole('button', { name: 'Go to this week', exact: true }).click();
  await expect(page.getByText('Oct 11 – Oct 17', { exact: true })).toBeVisible();
  expect(requests.filter((r) => r.startsWith('GET /kitchen?'))).toEqual([]);
});

test('the week’s groceries go on the list in one request, and the toast says what changed', async ({
  page,
}) => {
  const plans = [plan('a', '2026-10-12', 'Dinner', soup), plan('b', '2026-10-14', 'Lunch', pasta)];
  const { requests, posted } = await planner(page, plans, { added: 3, merged: 2 });
  await page.goto('/?page=planner');
  await expect(page.getByText('This week · 2 planned', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add this week’s groceries', exact: true }).click();
  await expect(
    page.getByText(
      '3 new items on your grocery list. 2 ingredients were combined with matching items.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(posted).toEqual([{ from: '2026-10-11', to: '2026-10-17', skipPantry: true }]);
  // One request for the whole week (not one per recipe), then the list is fetched again.
  expect(requests.filter((r) => r.startsWith('POST'))).toEqual(['POST /planner/groceries']);
  const added = requests.indexOf('POST /planner/groceries');
  expect(requests.slice(added).some((r) => r.startsWith('GET /kitchen'))).toBe(true);
});

test('a week with nothing new to add says so', async ({ page }) => {
  await planner(page, [plan('a', '2026-10-12', 'Dinner', soup)], { added: 0, merged: 0 });
  await page.goto('/?page=planner');
  await page.getByRole('button', { name: 'Add this week’s groceries', exact: true }).click();
  await expect(page.getByText('Nothing new to add from this week.', { exact: true })).toBeVisible();
});

test.describe('Russian', () => {
  test.use({ locale: 'ru-RU' });
  test('the toast counts in Russian, for a week that starts on Monday', async ({ page }) => {
    const plans = [plan('a', '2026-10-12', 'Dinner', soup)];
    const { posted } = await planner(page, plans, { added: 2, merged: 5 });
    await page.goto('/?page=planner');
    await page.getByRole('button', { name: 'Добавить покупки на неделю', exact: true }).click();
    await expect(
      page.getByText(
        '2 новых продукта в списке покупок. 5 ингредиентов объединены с такими же продуктами.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(posted).toEqual([{ from: '2026-10-12', to: '2026-10-18', skipPantry: true }]);
  });
});
