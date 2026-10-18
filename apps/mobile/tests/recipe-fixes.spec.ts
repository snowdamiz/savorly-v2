import { expect, test } from '@playwright/test';
import { alex, json, mockApi, recipe } from './mockApi';
import type { Suggestion } from '../src/lib/recipeFixes';
import { afterPageTimers } from './waits';

// Recipe fixes from cooks (docs/RECIPE-FIXES.md): what cooks who made a recipe suggest, "same
// for me", suggesting one (and being offered to after a step ran long), and the author's answer.

const steps = [
  { title: 'Prep', text: 'Chop the onion.', seconds: 0 },
  { title: 'Simmer', text: 'Simmer the sauce for 8 minutes.', seconds: 480 },
  { title: 'Serve', text: 'Serve it hot.', seconds: 0 },
];
const sauce = recipe({
  id: 'sauce',
  title: 'Tomato sauce',
  steps,
  verifiedCooks: 8,
  improvedBy: 2,
});
const maya = { id: 'maya', name: 'Maya', handle: 'maya', avatar: '' };
const longer: Suggestion = {
  id: 's1',
  kind: 'time',
  part: 'step',
  place: 2,
  before: { title: 'Simmer', text: 'Simmer the sauce for 8 minutes.', seconds: 480 },
  after: { title: 'Simmer', text: 'Simmer the sauce for 12 minutes.', seconds: 720 },
  reason: 'It took me 12 minutes, not 8.',
  status: 'open',
  fits: true,
  votes: 3,
  voted: false,
  mine: false,
  createdAt: '2026-10-15T10:00:00Z',
  author: maya,
};
const swap: Suggestion = {
  ...longer,
  id: 's2',
  kind: 'swap',
  part: 'ingredient',
  place: 1,
  before: { name: 'Lemon', amount: 1, unit: '' },
  after: { name: 'Lemon or lime', amount: 1, unit: '' },
  reason: 'Lime worked just as well.',
  votes: 0,
};

test('cooks see what others suggest, agree, and suggest a change', async ({ page }) => {
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('GET', '/recipes/sauce/suggestions', () =>
    json({ canSuggest: true, suggestions: [longer, swap] }),
  );
  api.on('PUT', '/suggestions/s1/vote', () => json({ ...longer, votes: 4, voted: true }));
  api.on('POST', '/recipes/sauce/suggestions', ({ body }) =>
    json({ ...longer, id: 's3', mine: true, ...(body as object) }, 201),
  );
  await page.goto(`/?recipe=${sauce.id}`);
  const row = page.getByRole('button', { name: /Step 2: 12 min instead of 8/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('3 agree');
  await expect(page.getByText('Lemon: Lemon or lime', { exact: true })).toBeVisible();
  // Opened: the change, why, who, and "Same for me".
  await row.click();
  await expect(page.getByText('“It took me 12 minutes, not 8.”', { exact: true })).toBeVisible();
  await expect(page.getByText('Suggested by Maya', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Same for me', exact: true }).click();
  await expect(row).toContainText('4 agree');
  await afterPageTimers(page, 1500);
  await page.screenshot({ path: 'test-results/recipe-fixes-cook.png', fullPage: true });

  // Suggesting one: a kind, a step, the change, and what happened.
  await page.getByRole('button', { name: 'Suggest a change', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'A missing step', exact: true }).click();
  await dialog.getByRole('button', { name: 'Step 1', exact: true }).click();
  await dialog.getByLabel('Step title').fill('Soften');
  await dialog.getByLabel('Minutes').fill('5');
  await dialog.getByLabel('The step as it should read').fill('Soften the onion in olive oil.');
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/recipe-fixes-suggest.png' });
  await dialog.getByRole('button', { name: 'Send to Robin', exact: true }).click();
  await expect
    .poll(() => api.sentTo('/recipes/sauce/suggestions'))
    .toEqual([
      [
        'POST',
        {
          kind: 'missing_step',
          step: 1,
          change: { title: 'Soften', text: 'Soften the onion in olive oil.', seconds: 300 },
          reason: '',
        },
      ],
    ]);
});

test('the recipe credits the cooks whose fixes its author accepted', async ({ page }) => {
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('GET', '/recipes/sauce/history', () =>
    json({
      versions: [
        {
          id: 'v1',
          number: 1,
          kind: 'time',
          part: 'step',
          before: longer.before,
          after: longer.after,
          createdAt: '2026-10-16T10:00:00Z',
          by: maya,
          undoable: false,
          suggestionId: 's1',
        },
      ],
    }),
  );
  await page.goto(`/?recipe=${sauce.id}`);
  await page.getByRole('button', { name: 'Improved by 2 cooks', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/From Maya/)).toBeVisible();
});

test('after a step ran long, a verified cook is offered to suggest a change', async ({ page }) => {
  await page.clock.install();
  const quick = recipe({
    id: 'quick',
    title: 'Quick sauce',
    steps: [
      { title: 'Simmer', text: 'Simmer the sauce for 3 minutes.', seconds: 180 },
      { title: 'Serve', text: 'Serve it hot.', seconds: 0 },
    ],
  });
  const api = await mockApi(page, { recipes: [quick] });
  api.on('POST', '/recipes/quick/cook-sessions', () => json({ id: 'k1' }, 201));
  api.on('PATCH', '/cook-sessions/k1', ({ body }) =>
    json({ id: 'k1', verified: !!(body as { finished?: boolean }).finished }),
  );
  api.on('GET', '/recipes/quick/suggestions', () => json({ canSuggest: true, suggestions: [] }));
  await page.goto(`/?recipe=${quick.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await page.clock.fastForward('06:00');
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.getByRole('button', { name: 'Finish cooking', exact: true }).click();
  const prompt = page.getByText('Step 1 took you 6 minutes, not 3.', { exact: true });
  await expect(prompt).toBeVisible();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/recipe-fixes-done.png' });
  await prompt.locator('..').getByRole('button', { name: 'Suggest a change', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Minutes')).toHaveValue('6');
  await expect(dialog.getByLabel('What happened? (optional)')).toHaveValue(
    'It took me 6 minutes, not 3.',
  );
});

test('an author accepts a suggestion where cooks get stuck', async ({ page }) => {
  const mine = { ...sauce, id: 'my-sauce', author: alex, improvedBy: 0 };
  const api = await mockApi(page, {
    recipes: [mine],
    library: { recipes: [mine], ownIds: [mine.id], publishedCount: 1 },
  });
  api.on('GET', '/recipes/my-sauce/suggestions', () =>
    json({ canSuggest: false, suggestions: [longer, swap] }),
  );
  api.on('GET', '/recipes/my-sauce/insights/author', () =>
    json({
      sessions: 0,
      finished: 0,
      finishRate: null,
      computedAt: null,
      verifiedCooks: 8,
      cookedMinutes: 30,
      steps: steps.map((_, i) => ({
        step: i + 1,
        sessions: 0,
        timerSeconds: steps[i].seconds,
        note: null,
        questions: [],
      })),
    }),
  );
  api.on('PATCH', '/suggestions/s1', () => json({ id: 'v1' }));
  await page.goto(`/?recipe=${mine.id}`);
  await page
    .getByRole('button', { name: 'Where cooks get stuck · 2 suggestions', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Suggested by cooks', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Lemon: Lemon or lime', { exact: true })).toBeVisible();
  await expect(dialog.getByText('A step’s time', { exact: true })).toBeVisible();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/recipe-fixes-author.png' });
  await dialog.getByRole('button', { name: 'Accept', exact: true }).last().click();
  await expect.poll(() => api.sentTo('/suggestions/s1')).toEqual([['PATCH', { action: 'accept' }]]);
});
