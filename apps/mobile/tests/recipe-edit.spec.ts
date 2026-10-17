import { expect, Page, test } from '@playwright/test';
import type { Recipe } from '../src/lib/types';
import { alex, empty, json, mockApi, recipe, recipeCard } from './mockApi';

// A cook's own recipe from My kitchen: edited (PUT /recipes/:id) and deleted (DELETE /recipes/:id).

const toast = recipe({
  id: 'toast',
  title: 'Lemon toast',
  description: 'Bright and golden lemon toast for a quick lunch.',
  author: alex,
  ingredients: [{ name: 'Bread', amount: 2, unit: 'slices', category: 'Bakery' }],
  steps: [{ title: 'Toast', text: 'Toast the bread until golden.', seconds: 0 }],
});

/** A kitchen with one recipe of its own, which the server updates and deletes. */
async function kitchen(page: Page) {
  const api = await mockApi(page, { recipes: [toast], library: { recipes: [toast] } });
  const stores = () => [api.state.recipes, api.state.library.recipes];
  api.on('PUT', /^\/recipes\/([^/]+)$/, ({ params: [id], body }) => {
    const before = api.state.recipes.find((r) => r.id === id);
    if (!before) return;
    const saved: Recipe = { ...before, ...(body as Partial<Recipe>), id };
    for (const list of stores()) {
      const at = list.findIndex((r) => r.id === id);
      if (at >= 0) list[at] = saved;
    }
    return json(saved);
  });
  api.on('DELETE', /^\/recipes\/([^/]+)$/, ({ params: [id] }) => {
    for (const list of stores()) list.splice(0, list.length, ...list.filter((r) => r.id !== id));
    return empty();
  });
  return api;
}
/** My kitchen → the recipe → Edit. */
const editToast = async (page: Page) => {
  await page.goto('/?page=profile');
  await recipeCard(page, 'Lemon toast').click();
  await expect(page.getByText('Toast the bread until golden.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Recipe title', exact: true })).toHaveValue(
    'Lemon toast',
  );
};

test('editing a recipe from My kitchen saves the new title with PUT', async ({ page }) => {
  const api = await kitchen(page);
  await editToast(page);
  await page
    .getByRole('textbox', { name: 'Recipe title', exact: true })
    .fill('Lemon toast with honey');
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect(
    page.getByText('Your recipe is at the table. Thanks for sharing.', { exact: true }),
  ).toBeVisible();
  // The rest of the recipe goes back as it was, and it stays published.
  expect(api.sentTo('/recipes/toast')).toEqual([
    [
      'PUT',
      expect.objectContaining({
        title: 'Lemon toast with honey',
        description: toast.description,
        ingredients: toast.ingredients,
        steps: toast.steps,
        published: true,
      }),
    ],
  ]);
  expect(api.sentTo('/recipes')).toEqual([]);
  // The saved recipe opens (its cover photo is named after it), and My kitchen lists it so.
  await expect(
    page.getByRole('img', { name: 'Lemon toast with honey', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Toast the bread until golden.', { exact: true })).toBeVisible();
  await page.goto('/?page=profile');
  await expect(recipeCard(page, 'Lemon toast with honey')).toBeVisible();
  await expect(recipeCard(page, 'Lemon toast')).toHaveCount(0);
});

test('deleting a recipe asks first, then sends DELETE and it leaves My kitchen', async ({
  page,
}) => {
  const api = await kitchen(page);
  await editToast(page);
  const ask = async () => {
    await page.getByRole('button', { name: 'Delete this recipe', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Delete this recipe?' })).toBeVisible();
    await expect(
      page.getByText(
        'This permanently deletes your recipe, its reviews and saves. To hide it instead, save it as a draft.',
        { exact: true },
      ),
    ).toBeVisible();
  };
  // Closing the question deletes nothing.
  await ask();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.sentTo('/recipes/toast')).toEqual([]);
  await ask();
  await page.getByRole('button', { name: 'Permanently delete recipe', exact: true }).click();
  await expect(page.getByText('Recipe deleted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.sentTo('/recipes/toast')).toEqual([['DELETE', undefined]]);
  // Back in My kitchen, which has no recipes of its own any more.
  await expect(page.getByText('Your first recipe is waiting', { exact: true })).toBeVisible();
  await expect(recipeCard(page, 'Lemon toast')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Your first recipe is waiting', { exact: true })).toBeVisible();
});
