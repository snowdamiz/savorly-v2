import { test, expect, Page } from '@playwright/test';
import type { Recipe, RecipeInput, StepClipJob } from '../src/lib/types';
import { stopsMoving } from './waits';

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
// Alex's recipe: the first step has a clip of its own, the others none.
const mine: Recipe = {
  id: 'alex-toast',
  title: 'Lemon ricotta toast',
  description: 'Bright and quick.',
  cuisine: 'Italian',
  minutes: 10,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  photos: [],
  video: '',
  ingredients: [{ name: 'Bread', amount: 2, unit: 'slices', category: 'Bakery' }],
  steps: [
    { title: 'Toast', text: 'Toast the bread.', seconds: 0, video: 'https://media.test/toast.mp4' },
    { title: 'Spread', text: 'Spread the ricotta.', seconds: 0 },
    { title: 'Zest', text: 'Zest the lemon over it.', seconds: 0 },
  ],
  tags: [],
  calories: 220,
  aiGenerated: false,
  published: true,
  language: 'en',
  author: user,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
};

/**
 * The API, with `own` as Alex's recipe. `clips` is what GET /recipes/:id/step-clips answers,
 * and POST queues the steps it names as `ordered`.
 */
async function mockKitchen(
  page: Page,
  {
    own = mine,
    videoAI = true,
    ordered = [] as string[],
  }: { own?: Recipe; videoAI?: boolean; ordered?: string[] } = {},
) {
  const state = { clips: [] as StepClipJob[], orders: [] as string[] };
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/v1', '');
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = request.postData() ? request.postDataJSON() : null;
    if (path === '/session') return json({ user });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ textAI: true, imageAI: true, videoAI });
    if (path === `/recipes/${own.id}/step-clips` && method === 'POST') {
      state.orders.push(request.headers()['idempotency-key'] || '');
      state.clips = ordered.map((text) => ({ text, status: 'queued', error: '' }));
      return json({ clips: state.clips }, 202);
    }
    if (path === `/recipes/${own.id}/step-clips`) return json({ clips: state.clips });
    if (path === `/recipes/${own.id}` && method === 'PUT') {
      writes.push({ method, body });
      return json({ ...own, ...body });
    }
    if (path === '/recipes' && method === 'POST') {
      writes.push({ method, body });
      return json({ ...body, id: 'saved-1', author: user, rating: 0, reviewCount: 0 }, 201);
    }
    if (path === '/recipes') return json([own]);
    if (path === `/recipes/${own.id}`) return json(own);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    return json([]);
  });
  await page.route('https://media.test/**', (route) =>
    route.fulfill({ path: 'tests/fixtures/sample.mp4', contentType: 'video/mp4' }),
  );
  return { state, writes };
}

const openEditor = async (page: Page, recipe = mine) => {
  await page.goto(`/?recipe=${recipe.id}`);
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
};

test('a saved recipe gets an AI clip of every step without one, once asked', async ({
  page,
}, testInfo) => {
  const { state, writes } = await mockKitchen(page, {
    ordered: ['Spread the ricotta.', 'Zest the lemon over it.'],
  });
  await openEditor(page);
  await expect(
    page.getByText('A four-second AI clip of each step that has none.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Make step clips', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('A four-second AI clip for each of the 2 steps that have none.', {
      exact: true,
    }),
  ).toBeVisible();
  await stopsMoving(dialog);
  await page.screenshot({ path: testInfo.outputPath('step-clips-confirm.png') });
  // Nothing is ordered until the cook says so, and then once.
  expect(state.orders).toEqual([]);
  await dialog.getByRole('button', { name: 'Make clips', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.orders).toHaveLength(1);
  expect(state.orders[0].length).toBeGreaterThanOrEqual(8);
  for (const n of [2, 3])
    await expect(page.getByLabel(`Making an AI clip of step ${n}`, { exact: true })).toBeVisible();
  await expect(
    page.getByText('Clips on their way appear on their steps in a few minutes.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make step clips', exact: true })).toBeDisabled();
  await page.getByLabel('Making an AI clip of step 3', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('step-clips-making.png') });

  // One is made, the other fails; the editor sees it on its next look.
  state.clips = [
    {
      text: 'Spread the ricotta.',
      status: 'completed',
      error: '',
      url: 'https://media.test/ai/spread.mp4',
    },
    {
      text: 'Zest the lemon over it.',
      status: 'failed',
      error:
        'The video provider could not complete this generation. Review your prompt and try again.',
    },
  ];
  await expect(
    page.getByRole('button', { name: 'Play the clip of step 2', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText('This step’s AI clip couldn’t be made. Make step clips to try again.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add a clip to step 3', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make step clips', exact: true })).toBeEnabled();
  await page
    .getByRole('button', { name: 'Add a clip to step 3', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('step-clips-made.png') });

  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  const sent = writes[0].body as unknown as RecipeInput;
  expect(sent.steps.map((step) => step.video ?? null)).toEqual([
    'https://media.test/toast.mp4',
    'https://media.test/ai/spread.mp4',
    null,
  ]);
  expect(sent.aiGenerated).toBe(true);
});

test('clips are made from saved steps, and only where the server makes them', async ({ page }) => {
  // A clip finished before the editor opened was already put on its step, or removed since:
  // the editor leaves the step as it is.
  const { state, writes } = await mockKitchen(page);
  state.clips = [
    {
      text: 'Spread the ricotta.',
      status: 'completed',
      error: '',
      url: 'https://media.test/ai/old.mp4',
    },
  ];
  await openEditor(page);
  await expect(
    page.getByRole('button', { name: 'Add a clip to step 2', exact: true }),
  ).toBeVisible();
  // Changed steps are saved first.
  await page
    .getByRole('textbox', { name: 'Step 3 instructions', exact: true })
    .fill('Zest the lemon over it, then serve.');
  await expect(
    page.getByText('Save your changes to make AI clips of these steps.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make step clips', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  const sent = writes[0].body as unknown as RecipeInput;
  expect(sent.steps.map((step) => step.video ?? null)).toEqual([
    'https://media.test/toast.mp4',
    null,
    null,
  ]);
  expect(state.orders).toEqual([]);
});

test('a recipe not saved yet is saved before its steps get clips', async ({ page }) => {
  await mockKitchen(page);
  await page.goto('/?page=create');
  await expect(
    page.getByText('Save the recipe to make AI clips of its steps.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make step clips', exact: true })).toBeDisabled();
  // There's no recipe video to add any more, by upload, address or AI.
  await expect(page.getByRole('button', { name: 'Upload a recipe video' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Or use a direct video URL' })).toHaveCount(0);
});

test('without a video provider the editor offers no AI clips, and recipe videos stay hidden', async ({
  page,
}) => {
  // An older recipe's video isn't shown on its page any more.
  const withVideo = { ...mine, video: 'https://media.test/recipe.mp4' };
  await mockKitchen(page, { own: withVideo, videoAI: false });
  await page.goto(`/?recipe=${withVideo.id}`);
  await expect(page.getByRole('button', { name: 'Edit recipe', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Watch video' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Add a clip to step 2', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make step clips' })).toHaveCount(0);
});
