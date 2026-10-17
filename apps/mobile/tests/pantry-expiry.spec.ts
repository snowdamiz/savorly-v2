import { expect, Page, test } from '@playwright/test';
import type { PantryItem } from '../src/lib/types';
import { json, mockApi } from './mockApi';

// Adding pantry items with and without a best-before date (POST /pantry), and how the list shows
// them: "Use soon" within three days, the date further out, nothing without one. The calendar
// itself is covered in kitchen.spec.ts.

// Fixed dates need a fixed zone: the clock starts at midday on Friday 16 October 2026 and runs on,
// so the app's animations still finish.
test.use({ timezoneId: 'UTC', locale: 'en-US' });
const NOW = new Date('2026-10-16T12:00:00Z');

async function pantry(page: Page) {
  await page.clock.install({ time: NOW });
  const api = await mockApi(page);
  const items = api.state.kitchen.pantry;
  // Like the API, names are kept in lower case (the app capitalizes them).
  api.on('POST', '/pantry', ({ body }) => {
    const { name, quantity, expiresOn } = body as Omit<PantryItem, 'id'>;
    items.push({
      id: `p${items.length + 1}`,
      name: name.trim().toLowerCase(),
      quantity,
      expiresOn,
    });
    return json({ ok: true }, 201);
  });
  return api;
}
/** The pantry line of `name`: the innermost element around its remove button. */
const line = (page: Page, name: string) =>
  page
    .locator('div')
    .filter({ has: page.getByRole('button', { name: `Remove ${name}`, exact: true }) })
    .last();

test('items added with a best-before date say how soon to use them', async ({ page }) => {
  const api = await pantry(page);
  await page.goto('/?page=pantry');
  await expect(page.getByText('Let’s look in the fridge', { exact: true })).toBeVisible();
  const ingredient = page.getByRole('textbox', { name: 'Ingredient', exact: true });
  const quantity = page.getByRole('textbox', { name: 'Quantity', exact: true });
  const add = page.getByRole('button', { name: 'Add to pantry', exact: true });
  const bestBefore = async (day: string, shown: string) => {
    await page.getByRole('button', { name: 'Best before', exact: true }).click();
    await page.getByRole('button', { name: day, exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Best before: ${shown}`, exact: true }),
    ).toBeVisible();
  };

  // Three days left: use it soon.
  await ingredient.fill('Chickpeas');
  await quantity.fill('2 cans');
  await bestBefore('Monday, October 19, 2026', 'Oct 19, 2026');
  await add.click();
  await expect(page.getByText('Added to your pantry.', { exact: true })).toBeVisible();
  const chickpeas = line(page, 'chickpeas');
  await expect(chickpeas.getByText('Use soon', { exact: true })).toBeVisible();
  await expect(chickpeas.getByText('2 cans', { exact: true })).toBeVisible();
  // The form starts over, date included.
  await expect(ingredient).toHaveValue('');
  await expect(quantity).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Best before', exact: true })).toBeVisible();

  // Four days left: no hurry yet, so the line gives the date instead.
  await ingredient.fill('Rice');
  await bestBefore('Tuesday, October 20, 2026', 'Oct 20, 2026');
  await add.click();
  const rice = line(page, 'rice');
  await expect(
    rice.getByText('In the pantry · best before Oct 20, 2026', { exact: true }),
  ).toBeVisible();
  await expect(rice.getByText('Use soon')).toHaveCount(0);

  // No date, nothing to say about one.
  await ingredient.fill('Salt');
  await add.click();
  await expect(line(page, 'salt').getByText('In the pantry', { exact: true })).toBeVisible();
  await expect(page.getByText('Use soon', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Expired', { exact: true })).toHaveCount(0);
  expect(api.sentTo('/pantry')).toEqual([
    ['POST', { name: 'Chickpeas', quantity: '2 cans', expiresOn: '2026-10-19' }],
    ['POST', { name: 'Rice', quantity: '', expiresOn: '2026-10-20' }],
    ['POST', { name: 'Salt', quantity: '', expiresOn: null }],
  ]);
});
