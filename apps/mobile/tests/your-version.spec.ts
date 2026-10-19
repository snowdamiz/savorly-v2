import { expect, test } from '@playwright/test';
import { json, mockApi, recipe } from './mockApi';
import type { RecipeEdit } from '../src/lib/yourVersion';
import { afterPageTimers } from './waits';

// Your version of a recipe (docs/YOUR-VERSION.md): the member's own changes applied over a recipe,
// the way back to the original, a change that no longer fits, keeping a step's time after a cook,
// and kitchen notes.

const steps = [
  { title: 'Prep', text: 'Chop the onion.', seconds: 0 },
  { title: 'Simmer', text: 'Simmer the sauce for 8 minutes.', seconds: 480 },
  { title: 'Serve', text: 'Serve it hot.', seconds: 0 },
];
const sauce = recipe({
  id: 'sauce',
  title: 'Tomato sauce',
  steps,
  ingredients: [{ name: 'Tomatoes', amount: 1, unit: 'kg', category: 'Produce' }],
});
const longer: RecipeEdit = {
  id: 'e1',
  kind: 'time',
  part: 'step',
  place: 2,
  before: { title: 'Simmer', text: 'Simmer the sauce for 8 minutes.', seconds: 480 },
  after: { title: 'Simmer', text: 'Simmer the sauce for 12 minutes.', seconds: 720 },
  said: 'My oven needs longer.',
  source: 'cooking',
  fits: true,
  updatedAt: '2026-10-17T19:00:00Z',
};
const fewer: RecipeEdit = {
  ...longer,
  id: 'e2',
  kind: 'amount',
  part: 'ingredient',
  place: 1,
  before: { name: 'Tomatoes', amount: 1, unit: 'kg' },
  after: { name: 'Tomatoes', amount: 0.8, unit: 'kg' },
  said: '',
};

test('a recipe opens as the member’s version, with the original a tap away', async ({ page }) => {
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('GET', '/recipes/sauce/my-version', () => json({ edits: [longer, fewer] }));
  await page.goto(`/?recipe=${sauce.id}`);
  await expect(page.getByText('Your version', { exact: true })).toBeVisible();
  await expect(page.getByText('· 2 changes', { exact: true })).toBeVisible();
  await expect(page.getByText('Simmer the sauce for 12 minutes.', { exact: true })).toBeVisible();
  await expect(page.getByText('Yours', { exact: true })).toHaveCount(2);
  await afterPageTimers(page, 1500);
  await page.screenshot({ path: 'test-results/your-version.png', fullPage: true });
  await page.getByRole('button', { name: 'Show the original', exact: true }).click();
  await expect(page.getByText('Simmer the sauce for 8 minutes.', { exact: true })).toBeVisible();
  await expect(page.getByText('Yours', { exact: true })).toHaveCount(0);
  await expect(page.getByText('The original recipe', { exact: true })).toBeVisible();
});

test('a change whose step changed since is the member’s to keep or drop', async ({ page }) => {
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('GET', '/recipes/sauce/my-version', () =>
    json({ edits: [{ ...longer, fits: false }, fewer] }),
  );
  api.on('PATCH', '/recipe-edits/e1', () => json({ ...longer, fits: true }));
  await page.goto(`/?recipe=${sauce.id}`);
  await expect(page.getByText('· 2 changes, 1 to look at', { exact: true })).toBeVisible();
  // It isn't applied while it doesn't fit.
  await expect(page.getByText('Simmer the sauce for 8 minutes.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Your changes', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('The recipe changed here since.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('“My oven needs longer.”', { exact: true })).toBeVisible();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/your-changes.png' });
  await dialog.getByRole('button', { name: 'Keep my change', exact: true }).click();
  await expect.poll(() => api.sentTo('/recipe-edits/e1')).toEqual([['PATCH', { keep: true }]]);
});

test('after a step ran long, the cook keeps its time for next time in one tap', async ({
  page,
}) => {
  await page.clock.install();
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('POST', '/recipes/sauce/cook-sessions', () => json({ id: 'k1' }, 201));
  api.on('PATCH', '/cook-sessions/k1', () => json({ id: 'k1', verified: false }));
  api.on('PUT', '/recipes/sauce/my-version', () => json({ edit: longer, replaced: null }));
  api.on('DELETE', '/recipe-edits/e1', () => ({ status: 204 }));
  await page.goto(`/?recipe=${sauce.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.clock.fastForward('12:00');
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.getByRole('button', { name: 'Finish cooking', exact: true }).click();
  await expect(page.getByText('Step 2 took you 12 minutes, not 8.', { exact: true })).toBeVisible();
  // Not a verified cook: it can be kept for themselves, not suggested to the cook.
  await expect(page.getByRole('button', { name: 'Suggest a change', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Keep 12 min for next time', exact: true }).click();
  await expect(page.getByText('Kept in your version.', { exact: true })).toBeVisible();
  expect(api.sentTo('/recipes/sauce/my-version')).toEqual([
    [
      'PUT',
      {
        kind: 'time',
        step: 2,
        change: { seconds: 720 },
        said: 'It took me 12 minutes, not 8.',
        source: 'cooking',
      },
    ],
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.sentTo('/recipe-edits/e1')).toEqual([['DELETE', undefined]]);
});

test('a member keeps a change for themselves from the composer', async ({ page }) => {
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('GET', '/recipes/sauce/my-version', () => json({ edits: [longer] }));
  api.on('PUT', '/recipes/sauce/my-version', () => json({ edit: fewer, replaced: null }));
  await page.goto(`/?recipe=${sauce.id}`);
  await page.getByRole('button', { name: 'Your changes', exact: true }).click();
  await page.getByRole('button', { name: 'Add a change', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Change it for yourself', { exact: true })).toBeVisible();
  // A personal version changes steps and ingredients, but adds none.
  await expect(dialog.getByRole('button', { name: 'A missing step', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'An amount', exact: true }).click();
  await dialog.getByLabel('Amount').fill('0.8');
  await dialog.getByRole('button', { name: 'Keep in my version', exact: true }).click();
  await expect
    .poll(() => api.sentTo('/recipes/sauce/my-version'))
    .toEqual([
      [
        'PUT',
        {
          kind: 'amount',
          ingredient: 1,
          change: { name: 'Tomatoes', amount: 0.8, unit: 'kg' },
          said: '',
          source: 'typed',
        },
      ],
    ]);
});

test('kitchen notes in Settings', async ({ page }) => {
  const api = await mockApi(page);
  api.on('GET', '/me/kitchen-notes', () =>
    json({ notes: [{ id: 'n1', note: 'We like it mild', source: 'typed', createdAt: '' }] }),
  );
  api.on('POST', '/me/kitchen-notes', ({ body }) =>
    json({ id: 'n2', note: (body as { note: string }).note, source: 'typed', createdAt: '' }, 201),
  );
  api.on('DELETE', '/me/kitchen-notes/n1', () => ({ status: 204 }));
  await page.goto('/?page=settings');
  await page.getByRole('button', { name: 'Your cooking', exact: true }).click();
  await expect(page.getByText('We like it mild', { exact: true })).toBeVisible();
  await page.getByLabel('A kitchen note').fill('My oven runs hot');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('My oven runs hot', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove We like it mild', exact: true }).click();
  await expect(page.getByText('We like it mild', { exact: true })).toHaveCount(0);
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/kitchen-notes.png' });
});
