import { expect, test } from '@playwright/test';
import { alex, json, mockApi, recipe } from './mockApi';

// The library comes with only its newest recipes (GET /library?limit=24), so My kitchen pages
// through the cook's own recipes, drafts too, and takes the count of published ones from the
// server rather than from the recipes it happens to have.

const dishes = Array.from({ length: 30 }, (_, i) =>
  recipe({
    id: `dish-${i + 1}`,
    title: `Dish ${i + 1}`,
    author: alex,
    // Every third one is still a draft.
    published: i % 3 !== 2,
  }),
);
const cards = (page: import('@playwright/test').Page) =>
  page.getByRole('link', { name: /^View Dish \d+$/ });

test('My kitchen pages through the cook’s recipes and counts the shared ones whole', async ({
  page,
}) => {
  const api = await mockApi(page, { recipes: dishes });
  api.on('GET', '/library', ({ query }) =>
    json({
      ...api.state.library,
      recipes: dishes.slice(0, Number(query.get('limit') || dishes.length)),
      ownIds: dishes.map((d) => d.id),
      publishedCount: 20,
      hasMore: true,
    }),
  );
  await page.goto('/?page=profile');
  await expect(page.getByText('Shared', { exact: true }).locator('..')).toContainText('20');
  await expect(cards(page)).toHaveCount(24);
  const asked = () => api.requests.map((r) => `${r.method} ${r.path}?${r.query}`);
  expect(asked()).toContain('GET /library?limit=24');
  expect(asked()).toContain('GET /library/recipes?scope=mine&offset=0&limit=24');
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(cards(page)).toHaveCount(30);
  expect(asked()).toContain('GET /library/recipes?scope=mine&offset=24&limit=24');
  await expect(page.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
});

test('a recipe the cook deleted leaves My kitchen even when it was past the first page', async ({
  page,
}) => {
  const api = await mockApi(page, { recipes: dishes });
  let ownIds = dishes.map((d) => d.id);
  api.on('GET', '/library', () =>
    json({ ...api.state.library, recipes: dishes.slice(0, 24), ownIds, hasMore: true }),
  );
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(cards(page)).toHaveCount(30);
  // Deleted on another device: the next library refresh (here, after a save) no longer lists it.
  ownIds = ownIds.filter((id) => id !== 'dish-30');
  api.state.recipes = api.state.recipes.filter((r) => r.id !== 'dish-30');
  await page.getByRole('button', { name: 'Save Dish 1', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View Dish 30', exact: true })).toHaveCount(0);
  await expect(cards(page)).toHaveCount(29);
});
