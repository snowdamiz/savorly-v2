import { expect, test, type Page } from '@playwright/test';
import type { AIJob, Household } from '../src/lib/types';
import { alex, empty, json, mockApi, recipe } from './mockApi';
import { afterPageTimers, stopsMoving } from './waits';

// Family recipes in their own voice: recording a relative (or picking a card), the recipe it
// becomes, its steps' clips on the recipe page and in cooking mode, the agreement asked before
// publishing, and cookbooks shared with the household. Each screen is saved under test-results/.

const recording = 'https://media.test/uploads/me/nonna.weba';
const nonna = recipe({
  id: 'nonna',
  title: 'Nonna Rosa’s pasta',
  author: alex,
  published: false,
  aiGenerated: true,
  steps: [
    {
      title: 'Salt the water',
      text: 'Salt the water well.',
      seconds: 0,
      voice: { recording: 'r1', startMs: 0, endMs: 4500 },
    },
    {
      title: 'Cook the pasta',
      text: 'Cook the pasta for nine minutes, stirring.',
      seconds: 540,
      voice: { recording: 'r1', startMs: 4300, endMs: 12500 },
    },
    { title: 'Serve', text: 'Serve it hot.', seconds: 0 },
  ],
  recordings: [
    { id: 'r1', speaker: 'Nonna Rosa', url: recording, durationMs: 12500, consented: false },
  ],
});
const job = (status: AIJob['status']): AIJob => ({
  id: 'family-job',
  kind: 'recipe',
  prompt: 'Write down the recipe Nonna Rosa tells in a recording.',
  status,
  result: (status === 'completed' ? { recipeId: 'nonna' } : {}) as AIJob['result'],
  error: '',
  createdAt: '2026-10-17T12:00:00Z',
});
const home: Household = {
  id: 'h1',
  name: 'Home',
  role: 'owner',
  members: [
    { id: 'me', name: 'Alex', handle: 'alex', avatar: '', role: 'owner' },
    { id: 'ben', name: 'Ben', handle: 'ben', avatar: '', role: 'member' },
  ],
};
// Sheets, tabs and cooking mode ease in: each picture waits for them to come to rest.
const shot = async (page: Page, name: string) => {
  await afterPageTimers(page, 800);
  await page.screenshot({ path: `test-results/family-recipes/${name}.png` });
};

/** The API, with uploads that land and a write-down that takes one look to finish. */
async function familyKitchen(page: Page) {
  const api = await mockApi(page, {
    recipes: [nonna],
    capabilities: { familyRecipes: true, textAI: true },
  });
  await page.route('https://storage.test/**', (route) => route.fulfill({ status: 200 }));
  api.on('GET', '/recordings', () => json([]));
  api.on('POST', '/media/uploads', () =>
    json({
      uploadUrl: 'https://storage.test/media/uploads/me/nonna.weba',
      method: 'PUT',
      headers: { 'Content-Type': 'audio/webm' },
      url: recording,
      key: 'uploads/me/nonna.weba',
    }),
  );
  api.on('POST', '/media/uploads/complete', () => json({ url: recording }));
  api.on('POST', '/recordings', () =>
    json(
      {
        recording: { id: 'r1', speaker: 'Nonna Rosa', url: recording, durationMs: 4000 },
        job: job('queued'),
      },
      201,
    ),
  );
  let looks = 0;
  api.on('GET', '/ai/jobs/family-job', () => json(job(looks++ ? 'completed' : 'running')));
  return api;
}

const openFamily = async (page: Page) => {
  await page.goto('/');
  // Create recipe on a desktop, the + tab on a phone.
  await page
    .getByRole('button', { name: 'Create recipe', exact: true })
    .or(page.getByRole('button', { name: 'Create a recipe', exact: true }))
    .first()
    .click();
  await page.getByRole('button', { name: 'Record a family recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record a family recipe' })).toBeVisible();
};

for (const [device, viewport] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['phone', { width: 390, height: 844 }],
] as const)
  test.describe(`on a ${device}`, () => {
    test.use({ viewport });

    test('a relative’s recording is written down and opens as a private recipe', async ({
      page,
    }) => {
      const api = await familyKitchen(page);
      await openFamily(page);
      await shot(page, `${device}-record`);
      const write = page.getByRole('button', { name: 'Write it down', exact: true });
      await page.getByRole('textbox', { name: 'Who’s speaking?' }).fill('Nonna Rosa');
      // The browser's fake microphone stands in for Nonna.
      await page.getByRole('button', { name: 'Start recording', exact: true }).click();
      const stop = page.getByRole('button', { name: 'Stop recording', exact: true });
      await expect(stop).toBeVisible();
      await shot(page, `${device}-recording`);
      await expect(stop).toHaveText(/00:0[3-9]/, { timeout: 10_000 });
      await stop.click();
      await expect(page.getByText(/Recorded · 00:0\d/)).toBeVisible();
      await shot(page, `${device}-recorded`);
      await write.click();
      await expect(page.getByText('Writing it down…')).toBeVisible();
      await shot(page, `${device}-writing`);
      // Written down, the recipe opens, private.
      await expect(page).toHaveURL(/\/recipes\/nonna$/, { timeout: 15_000 });
      const [[, kept]] = api.sentTo('/recordings');
      expect(kept).toMatchObject({ url: recording, speaker: 'Nonna Rosa' });
      expect((kept as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(3000);
      // Each voiced step names whose voice it plays, on its last line (a phone's Method tab).
      if (device === 'phone') await page.getByRole('tab', { name: 'Method', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Play Nonna Rosa’s voice', exact: true }),
      ).toHaveCount(2);
      await shot(page, `${device}-recipe`);
    });

    test('a step plays its recorded clip beside read-aloud in cooking mode', async ({ page }) => {
      await familyKitchen(page);
      await page.goto('/recipes/nonna');
      await page.getByRole('button', { name: 'Start cooking', exact: true }).first().click();
      // Cooking mode covers the recipe page, whose steps have links of their own.
      const cooking = page.locator('[aria-modal="true"]').filter({ hasText: 'STEP 1 OF 3' });
      const play = cooking.getByRole('button', { name: 'Play Nonna Rosa’s voice', exact: true });
      await expect(play).toBeVisible();
      await expect(cooking.getByRole('button', { name: 'Read this step aloud' })).toBeVisible();
      await stopsMoving(play);
      await shot(page, `${device}-cooking`);
      // The step it didn't say has narration only.
      const next = page.getByRole('button', { name: 'Next step', exact: true });
      await next.click();
      await next.click();
      const last = page.locator('[aria-modal="true"]').filter({ hasText: 'STEP 3 OF 3' });
      await expect(last.getByRole('button', { name: 'Read this step aloud' })).toBeVisible();
      await expect(last.getByRole('button', { name: 'Play Nonna Rosa’s voice' })).toHaveCount(0);
    });
  });

test('a handwritten card becomes a recipe with the card as its cover', async ({ page }) => {
  const api = await familyKitchen(page);
  api.on('POST', '/media/uploads', () =>
    json({
      uploadUrl: 'https://storage.test/media/uploads/me/card.png',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      url: 'https://media.test/uploads/me/card.png',
      key: 'uploads/me/card.png',
    }),
  );
  api.on('POST', '/media/uploads/complete', () =>
    json({ url: 'https://media.test/uploads/me/card.png' }),
  );
  api.on('POST', '/family/cards', () => json(job('queued'), 202));
  await openFamily(page);
  await page.getByRole('button', { name: 'Use a handwritten card', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A family recipe card' })).toBeVisible();
  await shot(page, 'desktop-card');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose a photo', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'card.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dWQAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page).toHaveURL(/\/recipes\/nonna$/, { timeout: 15_000 });
  expect(api.sentTo('/family/cards')).toEqual([
    ['POST', { url: 'https://media.test/uploads/me/card.png' }],
  ]);
  // Back in the sheet, a card's way back is the recording it was chosen instead of.
  await openFamily(page);
  await page.getByRole('button', { name: 'Use a handwritten card', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record a family recipe' })).toBeVisible();
});

test('publishing a family recipe asks whether the person recorded agreed', async ({ page }) => {
  const api = await familyKitchen(page);
  api.on('POST', '/recipes/nonna/recording-consent', () =>
    json({ recordings: [{ ...nonna.recordings![0], consented: true }] }),
  );
  api.on('PUT', '/recipes/nonna', ({ body }) =>
    json({ ...nonna, ...(body as object), id: 'nonna', author: alex }),
  );
  await page.goto('/recipes/nonna');
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).first().click();
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  const ask = page.getByRole('heading', { name: 'Did Nonna Rosa agree?' });
  await expect(ask).toBeVisible();
  await shot(page, 'desktop-consent');
  // Keeping it private sends nothing.
  await page.getByRole('button', { name: 'Keep it private', exact: true }).click();
  await expect(ask).toHaveCount(0);
  expect(api.sentTo('/recipes/nonna')).toEqual([]);
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, they agreed', exact: true }).click();
  await expect.poll(() => api.sentTo('/recipes/nonna').length).toBe(1);
  expect(api.sentTo('/recipes/nonna/recording-consent')).toEqual([['POST', { agreed: true }]]);
  expect(api.sentTo('/recipes/nonna')[0][1]).toMatchObject({ published: true });
});

test('a cookbook is shared with the household, and the household’s show in Saved', async ({
  page,
}) => {
  const api = await mockApi(page, {
    recipes: [nonna],
    library: {
      collections: [
        { id: 'fam', name: 'Family recipes', public: false, description: '', household: false },
      ],
      saves: [{ recipeId: 'nonna', collectionId: 'fam' }],
      savedIds: ['nonna'],
    },
  });
  api.on('GET', '/household', () => json(home));
  api.on('GET', '/household/cookbooks', () =>
    json([
      {
        id: 'ben-book',
        name: 'Ben’s family',
        description: '',
        recipeCount: 3,
        cover: '',
        owner: { id: 'ben', name: 'Ben', handle: 'ben', avatar: '' },
      },
    ]),
  );
  api.on('PATCH', '/collections/fam', ({ body }) =>
    json({
      id: 'fam',
      name: 'Family recipes',
      public: false,
      description: '',
      ...(body as object),
    }),
  );
  api.on('GET', '/cookbooks/ben-book', () => empty(404));
  await page.goto('/?page=saved');
  await expect(page.getByRole('button', { name: 'Ben’s family' })).toBeVisible();
  await page.getByRole('button', { name: 'Family recipes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit cookbook', exact: true }).click();
  const share = page.getByRole('switch', { name: 'Share with my household' });
  await expect(share).toBeVisible();
  await expect(
    page.getByText('Everyone in Home can open it, your private recipes in it too.'),
  ).toBeVisible();
  await shot(page, 'desktop-cookbook-settings');
  await share.click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => api.sentTo('/collections/fam')).toEqual([['PATCH', { household: true }]]);
  await shot(page, 'desktop-saved');
});
