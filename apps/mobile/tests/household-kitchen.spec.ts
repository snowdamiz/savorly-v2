import { expect, test } from '@playwright/test';
import type { Household, Plan, Recipe } from '../src/lib/types';
import { json, mockApi, recipe } from './mockApi';

// A household shares the meal plan and the pantry as well as the grocery list: each says who
// planned or added what, another member's private recipe shows only as its name, the pantry
// links to the household, and a housemate who shares their allergies is warned about on recipes.

test.use({ timezoneId: 'UTC', locale: 'en-US', viewport: { width: 390, height: 844 } });
const NOW = new Date('2026-10-16T12:00:00Z');

const home: Household = {
  id: 'home',
  name: 'Home',
  role: 'owner',
  members: [
    { id: 'me', name: 'Alex', handle: 'alex', avatar: '', role: 'owner' },
    { id: 'ben', name: 'Ben', handle: 'ben', avatar: '', role: 'member' },
  ],
};
const soup = recipe({ id: 'soup', title: 'Pumpkin soup' });
const stew: Recipe = {
  ...recipe({ id: 'stew', title: 'Ben’s stew', ingredients: [], steps: [] }),
  teaser: true,
};
const plan = (id: string, r: Recipe, meal: string, by: Plan['plannedBy']): Plan => ({
  id,
  recipeId: r.id,
  day: '2026-10-16',
  meal,
  servings: 2,
  recipe: r,
  plannedBy: by,
});

test('the shared plan and pantry say who added what, and private recipes stay private', async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  const api = await mockApi(page, {
    recipes: [soup],
    kitchen: {
      plans: [
        plan('p1', soup, 'Lunch', { id: 'me', name: 'Alex' }),
        plan('p2', stew, 'Dinner', { id: 'ben', name: 'Ben' }),
      ],
      pantry: [
        {
          id: 'k1',
          name: 'rice',
          quantity: '',
          expiresOn: null,
          addedBy: { id: 'ben', name: 'Ben' },
        },
      ],
    },
  });
  api.on('GET', '/household', () => json(home));
  await page.goto('/?page=planner');
  // My own plans don't name me; Ben's do, and his private recipe doesn't open.
  await expect(page.getByText('2 servings', { exact: true })).toBeVisible();
  await expect(page.getByText('2 servings · Planned by Ben', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ben’s private recipe: Ben’s stew', exact: true }).click();
  await expect(
    page.getByText('Only Ben can open this recipe; it’s private.', { exact: true }),
  ).toBeVisible();

  await page.goto('/?page=pantry');
  await expect(page.getByText('Added by Ben', { exact: true })).toBeVisible();
  // The pantry opens the household, where sharing diets is the member's own choice.
  await page.getByRole('button', { name: 'Shared kitchen: Home', exact: true }).click();
  await expect(
    page.getByText(
      'Everyone here shares the grocery list, the meal plan and the pantry, and can change any of them.',
      { exact: true },
    ),
  ).toBeVisible();
  const share = page.getByRole('switch', { name: 'Share my diets and allergies', exact: true });
  await expect(share).toHaveAttribute('aria-checked', 'false');
  await share.click();
  await expect(share).toHaveAttribute('aria-checked', 'true');
  expect(api.sentTo('/me/preferences')).toEqual([['PATCH', { shareDiet: true }]]);
});

test('a housemate’s shared allergies warn on recipes, with their name', async ({ page }) => {
  const satay = recipe({
    id: 'satay',
    title: 'Chicken satay',
    ingredients: [{ name: 'Peanut butter', amount: 3, unit: 'tbsp', category: 'Pantry' }],
    ingredientFood: [{ key: 'peanut butter', allergens: ['peanut'], terms: ['peanut butter'] }],
    allergens: ['peanut'],
  });
  await mockApi(page, {
    recipes: [satay],
    user: {
      householdAvoid: [
        { id: 'ben', name: 'Ben', avoid: { groups: { peanut: ['Peanuts'] }, terms: {} } },
      ],
    },
  });
  await page.goto('/recipes/satay');
  const warning = page.getByRole('alert').filter({ hasText: 'Check before you cook' });
  await expect(warning).toContainText('Peanuts · Peanut butter');
  await expect(warning).toContainText('From your household’s diets and allergies (Ben: Peanuts)');
  await expect(
    page.getByLabel('Contains Peanuts, which your household avoids', { exact: true }).first(),
  ).toBeVisible();
});
