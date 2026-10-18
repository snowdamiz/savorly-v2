import { expect, test } from '@playwright/test';
import type { PantryMatch, Recipe } from '../src/lib/types';
import { json, mockApi, recipe, recipeCard } from './mockApi';

// What the member avoids (GET /me's avoid, from their diets and allergies) against what each
// recipe has (its allergens and ingredientFood, from the server's ingredient lexicon): the recipe
// page's warning, the cards' badge, Explore's filter, the pantry's marks and its suggestions.

const satay: Recipe = recipe({
  id: 'satay',
  title: 'Chicken satay',
  ingredients: [
    { name: 'Chicken thighs', amount: 500, unit: 'g', category: 'Meat' },
    { name: 'Peanut butter', amount: 3, unit: 'tbsp', category: 'Pantry' },
    { name: 'Lime', amount: 1, unit: '', category: 'Produce' },
  ],
  ingredientFood: [
    { key: 'chicken', allergens: ['poultry'], terms: ['chicken', 'chicken thigh'] },
    { key: 'peanut butter', allergens: ['peanut'], terms: ['peanut butter'] },
    { key: 'lime', allergens: [], terms: ['lime'] },
  ],
  allergens: ['peanut', 'poultry'],
});
const salad: Recipe = recipe({
  id: 'salad',
  title: 'Green salad',
  ingredientFood: [{ key: 'lemon', allergens: [], terms: ['lemon'] }],
  allergens: [],
});
const avoid = { groups: { peanut: ['Peanuts'] }, terms: {} };

test('a recipe page warns about what the member avoids, and marks what the pantry has', async ({
  page,
}) => {
  const api = await mockApi(page, {
    recipes: [satay, salad],
    user: { avoid, preferences: { diets: [], allergies: ['Peanuts'] } },
    kitchen: { pantryCover: ['chicken'] },
  });
  api.on('POST', '/recipes/satay/groceries', () =>
    json({ added: 2, merged: 0, skipped: ['Chicken thighs'] }),
  );
  // The home's card says so before the page is open; a recipe without any stays quiet.
  await page.goto('/');
  await expect(
    page.getByLabel('Contains Peanuts, which you avoid', { exact: true }).first(),
  ).toBeVisible();
  await page.goto('/recipes/satay');
  const warning = page.getByRole('alert').filter({ hasText: 'Check before you cook' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Peanuts · Peanut butter');
  await expect(warning).toContainText('From your diets and allergies (Peanuts)');
  await expect(page.getByLabel('Contains something you avoid', { exact: true })).toHaveCount(1);
  await expect(page.getByText('In your pantry', { exact: true })).toHaveCount(1);
  // Adding it to the list leaves off what the pantry has, and says what.
  await page.getByRole('button', { name: 'Add to grocery list', exact: true }).click();
  await expect(
    page.getByText('Added to your grocery list, without what you have: Chicken thighs.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(api.sentTo('/recipes/satay/groceries')).toEqual([
    ['POST', { servings: 2, skipPantry: true }],
  ]);
});

test('a recipe without anything the member avoids shows no warning', async ({ page }) => {
  await mockApi(page, { recipes: [salad], user: { avoid } });
  await page.goto('/recipes/salad');
  await expect(page.getByRole('heading', { name: 'Green salad' }).first()).toBeVisible();
  await expect(page.getByText('Check before you cook', { exact: true })).toHaveCount(0);
});

test('Explore can hide what the member avoids', async ({ page }) => {
  const api = await mockApi(page, { recipes: [satay, salad], user: { avoid } });
  await page.goto('/?page=explore');
  await page.getByRole('button', { name: 'Filter recipes', exact: true }).first().click();
  await page.getByRole('button', { name: 'Hide what I avoid', exact: true }).click();
  await expect
    .poll(() => api.requests.some((r) => r.path === '/recipes' && r.query.get('fits') === 'me'))
    .toBe(true);
});

test('the pantry suggests what it goes furthest toward, and shops only what is missing', async ({
  page,
}) => {
  const omelette = recipe({ id: 'omelette', title: 'Spinach omelette', servings: 2 });
  const matches: PantryMatch[] = [
    { recipe: omelette, have: ['Eggs'], missing: ['Butter'], expiring: ['Baby spinach'] },
  ];
  const api = await mockApi(page, {
    recipes: [omelette],
    kitchen: { pantry: [{ id: 'p1', name: 'eggs', quantity: '', expiresOn: null }] },
  });
  api.on('GET', '/kitchen/pantry-recipes', () => json({ matches }));
  await page.goto('/?page=pantry');
  await expect(recipeCard(page, 'Spinach omelette')).toBeVisible();
  await expect(page.getByText('Missing: Butter', { exact: true })).toBeVisible();
  await expect(page.getByText('Uses Baby spinach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add what’s missing', exact: true }).click();
  await expect(
    page.getByText('Added what’s missing to your grocery list.', { exact: true }),
  ).toBeVisible();
  expect(api.sentTo('/recipes/omelette/groceries')).toEqual([
    ['POST', { servings: 2, skipPantry: true }],
  ]);
});
