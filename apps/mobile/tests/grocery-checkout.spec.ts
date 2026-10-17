import { expect, test } from '@playwright/test';
import { json, mockApi, recipe } from './mockApi';

// Ordering the grocery list or a recipe's ingredients through Instacart (POST /groceries/checkout,
// POST /recipes/:id/checkout), offered in the US and Canada when the server has a key, and
// sharing the list as text, offered everywhere.

test.use({ locale: 'en-US' });
const instacart = 'https://customers.instacart.com/store/shopping_lists/123';
const groceries = [
  { id: 'g1', name: 'Milk', quantity: '1 l', category: 'Dairy', checked: false },
  { id: 'g2', name: 'Tea', quantity: '', category: 'Pantry', checked: true },
];

test('the list orders through Instacart and shares as text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const api = await mockApi(page, {
    kitchen: { groceries },
    capabilities: { groceryCheckout: 'instacart' },
  });
  api.on('POST', '/groceries/checkout', () =>
    json({ url: instacart, provider: 'instacart', items: 1 }),
  );
  await page.addInitScript(() => {
    // Desktop browsers without a share sheet copy instead; the order opens a new tab.
    Object.defineProperty(navigator, 'share', { value: undefined });
    (window as unknown as { opened: string[] }).opened = [];
    window.open = ((url: string) => {
      (window as unknown as { opened: string[] }).opened.push(url);
      return null;
    }) as typeof window.open;
  });
  await page.goto('/?page=planner');
  await page
    .getByRole('tab', { name: 'Groceries' })
    .or(page.getByRole('button', { name: 'Groceries', exact: true }))
    .first()
    .click();
  await page.getByRole('button', { name: 'Order with Instacart', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { opened: string[] }).opened))
    .toEqual([instacart]);
  await page.getByRole('button', { name: 'Share list', exact: true }).click();
  await expect(page.getByText('List copied to your clipboard.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Groceries\n• Milk — 1 l');
});

test('without Instacart, the list only shares', async ({ page }) => {
  await mockApi(page, { kitchen: { groceries } });
  await page.goto('/?page=planner');
  await page
    .getByRole('tab', { name: 'Groceries' })
    .or(page.getByRole('button', { name: 'Groceries', exact: true }))
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Share list', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Order with Instacart', exact: true })).toHaveCount(
    0,
  );
});

test('a recipe orders its ingredients, less what the pantry has', async ({ page }) => {
  const soup = recipe({ id: 'soup', title: 'Pumpkin soup', servings: 2 });
  const api = await mockApi(page, {
    recipes: [soup],
    capabilities: { groceryCheckout: 'instacart' },
  });
  api.on('POST', '/recipes/soup/checkout', () =>
    json({ url: instacart, provider: 'instacart', items: 1 }),
  );
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open;
  });
  await page.goto('/recipes/soup');
  await page.getByRole('button', { name: 'Get the ingredients delivered', exact: true }).click();
  await expect
    .poll(() => api.sentTo('/recipes/soup/checkout'))
    .toEqual([['POST', { servings: 2, skipPantry: true }]]);
});
