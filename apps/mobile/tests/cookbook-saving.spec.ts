import { expect, Page, test } from '@playwright/test';
import { json, mockApi, recipe, recipeCard } from './mockApi';

// A new cookbook from the Saved screen (POST /collections), then a recipe saved into it from its
// page (PUT /recipes/:id/save with the cookbook's id).

const soup = recipe({ id: 'soup', title: 'Pumpkin soup' });

/** A kitchen with nothing saved yet, whose server keeps cookbooks and saves. */
async function kitchen(page: Page) {
  const api = await mockApi(page, { recipes: [soup] });
  const { library } = api.state;
  api.on('POST', '/collections', ({ body }) => {
    const { name } = body as { name: string };
    const cookbook = { id: 'weeknight', name: name.trim(), public: false, description: '' };
    library.collections.push(cookbook);
    return json({ id: cookbook.id, name: cookbook.name });
  });
  api.on('PUT', /^\/recipes\/([^/]+)\/save$/, ({ params: [id], body }) => {
    const { collectionId = null } = (body ?? {}) as { collectionId?: string | null };
    library.saves = [
      ...library.saves.filter((v) => v.recipeId !== id),
      { recipeId: id, collectionId },
    ];
    if (!library.savedIds.includes(id)) library.savedIds.push(id);
    const saved = api.state.recipes.find((r) => r.id === id);
    if (saved && !library.recipes.some((r) => r.id === id)) library.recipes.push(saved);
    return json({ saved: true });
  });
  return api;
}

test('a new cookbook is created from Saved and a recipe is saved into it', async ({ page }) => {
  const api = await kitchen(page);
  await page.goto('/?page=saved');
  await page.getByRole('button', { name: 'New cookbook', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New cookbook' })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create cookbook', exact: true });
  await expect(create).toBeDisabled();
  await page.getByRole('textbox', { name: 'Cookbook name', exact: true }).fill('Weeknight heroes');
  await create.click();
  await expect(page.getByText('Your new cookbook is ready.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The new cookbook is the one on show, still empty.
  await expect(
    page.getByRole('button', { name: 'Weeknight heroes', exact: true, pressed: true }),
  ).toBeVisible();
  await expect(page.getByText('Nothing saved here yet', { exact: true })).toBeVisible();
  expect(api.sentTo('/collections')).toEqual([['POST', { name: 'Weeknight heroes' }]]);

  // A recipe's page offers it, under All saved.
  await page.goto(`/?recipe=${soup.id}`);
  await page.getByRole('button', { name: 'Add to cookbook', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add to a cookbook' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All saved', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Weeknight heroes', exact: true }).click();
  await expect(page.getByText('Saved to Weeknight heroes', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'In your cookbooks', exact: true })).toBeVisible();
  expect(api.sentTo('/recipes/soup/save')).toEqual([['PUT', { collectionId: 'weeknight' }]]);

  // Saved now has it, in All saved and in the cookbook.
  await page.goto('/?page=saved');
  await expect(page.getByRole('button', { name: 'All saved · 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Weeknight heroes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Weeknight heroes', exact: true, pressed: true }),
  ).toBeVisible();
  await expect(recipeCard(page, 'Pumpkin soup')).toBeVisible();
  expect(
    api.requests.some(
      (r) => r.path === '/library/recipes' && r.query.get('collection') === 'weeknight',
    ),
  ).toBe(true);
});
