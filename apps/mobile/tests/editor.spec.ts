import { test, expect, Page } from '@playwright/test';
import type { AIJob, Recipe, RecipeInput } from '../src/lib/types';

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
const recipe: Recipe = {
  id: 'toast',
  title: 'Lemon toast',
  description: 'Bright and golden lemon toast for a quick lunch.',
  cuisine: 'Italian',
  minutes: 10,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  photos: [],
  video: '',
  ingredients: [{ name: 'Bread', amount: 2, unit: 'slices', category: 'Bakery' }],
  steps: [{ title: 'Toast', text: 'Toast the bread until golden.', seconds: 0 }],
  tags: [],
  calories: 120,
  aiGenerated: false,
  published: true,
  author: user,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: new Date().toISOString(),
};
const soup: RecipeInput = {
  title: 'Sous-chef soup',
  description: 'A quick soup from what is in the fridge.',
  cuisine: 'French',
  minutes: 25,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Leeks', amount: 2, unit: '', category: 'Produce' }],
  steps: [{ title: 'Simmer', text: 'Simmer the leeks until soft.', seconds: 600 }],
  tags: [],
  calories: 210,
  aiGenerated: true,
  published: false,
};
const job: AIJob = {
  id: 'soup-job',
  kind: 'recipe',
  prompt: 'A soup from my fridge',
  status: 'completed',
  result: { recipe: soup },
  error: '',
  createdAt: new Date().toISOString(),
};

async function mockKitchen(page: Page) {
  const updates: unknown[] = [];
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const method = route.request().method();
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ textAI: true });
    if (path === '/recipes') return json([recipe]);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === '/ai/jobs') return json([job]);
    if (path === `/recipes/${recipe.id}` && method === 'PUT') {
      updates.push(route.request().postDataJSON());
      return json(recipe);
    }
    if (path === `/recipes/${recipe.id}`) return json(recipe);
    return json([]);
  });
  return updates;
}
// A draft left on this device by an earlier visit.
const keep = (page: Page, key: string, draft: RecipeInput) =>
  page.addInitScript(
    ([key, value]) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    [key, JSON.stringify(draft)],
  );
const draft = (page: Page, key: string) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), key);
const sousChefDrafts = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('savorly.draft.cook.ai-'))
      .map((key) => JSON.parse(localStorage.getItem(key)!)),
  );
test('editing a recipe offers to restore changes kept on this device', async ({ page }) => {
  await keep(page, 'savorly.draft.cook.toast', { ...recipe, title: 'Lemon toast with honey' });
  const updates = await mockKitchen(page);
  await page.goto(`/?recipe=${recipe.id}`);
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Recipe title', exact: true });
  await expect(page.getByText('Restore unsaved changes?', { exact: true })).toBeVisible();
  await expect(title).toHaveValue('Lemon toast');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(title).toHaveValue('Lemon toast with honey');
  await expect(page.getByText('Restore unsaved changes?', { exact: true })).toHaveCount(0);
  // Typing carries on saving to the device, until the recipe is saved to the account.
  await title.fill('Lemon toast with thyme honey');
  await expect
    .poll(async () => (await draft(page, 'savorly.draft.cook.toast'))?.title)
    .toBe('Lemon toast with thyme honey');
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).toMatchObject({ title: 'Lemon toast with thyme honey', published: true });
  await expect.poll(() => draft(page, 'savorly.draft.cook.toast')).toBeNull();
});

test('discarding device changes keeps the saved recipe', async ({ page }) => {
  await keep(page, 'savorly.draft.cook.toast', { ...recipe, title: 'Lemon toast with honey' });
  await mockKitchen(page);
  await page.goto(`/?recipe=${recipe.id}`);
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('Restore unsaved changes?', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Recipe title', exact: true })).toHaveValue(
    'Lemon toast',
  );
  await expect.poll(() => draft(page, 'savorly.draft.cook.toast')).toBeNull();
});

test('a sous-chef recipe keeps its own draft beside the one started by hand', async ({ page }) => {
  await keep(page, 'savorly.draft.cook.new', {
    ...soup,
    title: 'My hand-written stew',
    aiGenerated: false,
  });
  await mockKitchen(page);
  const openSoup = async () => {
    await page.goto('/?page=profile');
    await page.getByRole('button', { name: 'Sous-chef history', exact: true }).click();
    await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
  };
  await openSoup();
  const title = page.getByRole('textbox', { name: 'Recipe title', exact: true });
  await expect(title).toHaveValue('Sous-chef soup');
  await title.fill('Sous-chef soup, my way');
  await expect
    .poll(async () => (await sousChefDrafts(page)).map((d) => d.title))
    .toEqual(['Sous-chef soup, my way']);
  expect(await draft(page, 'savorly.draft.cook.new')).toMatchObject({
    title: 'My hand-written stew',
  });
  // The recipe started by hand is still there to carry on with.
  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Write a recipe yourself', exact: true }).click();
  await expect(title).toHaveValue('My hand-written stew');
  // Opening the same sous-chef recipe again offers its own changes back.
  await openSoup();
  await expect(title).toHaveValue('Sous-chef soup');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(title).toHaveValue('Sous-chef soup, my way');
});

test('the last changes are kept when the editor closes before the autosave', async ({ page }) => {
  await page.clock.install();
  await mockKitchen(page);
  await page.goto('/?page=create');
  const title = page.getByRole('textbox', { name: 'Recipe title', exact: true });
  await expect(title).toBeVisible();
  // With the clock stopped the autosave never comes due; leaving the editor writes the draft.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await title.fill('Midnight pancakes');
  await expect(title).toHaveValue('Midnight pancakes');
  expect(await draft(page, 'savorly.draft.cook.new')).toBeNull();
  await page.evaluate(() => {
    history.pushState({}, '', '/?page=planner');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect
    .poll(async () => (await draft(page, 'savorly.draft.cook.new'))?.title)
    .toBe('Midnight pancakes');
  await page.clock.resume();
});

test('the step timer takes fractional minutes typed either way', async ({ page }) => {
  await mockKitchen(page);
  await page.goto('/?page=create');
  const timer = page.getByRole('textbox', { name: 'Timer in minutes (optional)', exact: true });
  await timer.fill('1.');
  await expect(timer).toHaveValue('1.');
  await timer.fill('1,5');
  await expect(timer).toHaveValue('1,5');
  await expect
    .poll(async () => (await draft(page, 'savorly.draft.cook.new'))?.steps[0].seconds)
    .toBe(90);
});

test('a video address mounts a player only once it is complete', async ({ page }) => {
  await mockKitchen(page);
  await page.route('https://media.test/**', (route) =>
    route.fulfill({ path: 'tests/fixtures/sample.mp4', contentType: 'video/mp4' }),
  );
  await page.goto('/?page=create');
  const field = page.getByRole('textbox', { name: 'Or use a direct video URL', exact: true });
  const players = page.locator('video');
  await field.fill('https://media.test/cl');
  await expect(field).toHaveValue('https://media.test/cl');
  await expect(players).toHaveCount(0);
  await field.fill('not a video link');
  await field.press('Tab');
  await expect(players).toHaveCount(0);
  await field.fill('https://media.test/clip.mp4');
  await field.press('Enter');
  await expect(players).toHaveCount(1);
});

test('a photo address that failed shows the photo once it is corrected', async ({ page }) => {
  await mockKitchen(page);
  await page.route('https://media.test/**', (route) =>
    route.request().url().endsWith('/good.png')
      ? route.fulfill({ path: 'tests/fixtures/sample.png', contentType: 'image/png' })
      : route.fulfill({ status: 404, body: '' }),
  );
  await page.goto('/?page=create');
  const field = page.getByRole('textbox', { name: 'Or use an image URL', exact: true });
  const failed = page.waitForResponse('https://media.test/bad.png');
  await field.fill('https://media.test/bad.png');
  expect((await failed).status()).toBe(404);
  await expect(page.locator('img[src="https://media.test/bad.png"]')).toHaveCount(0);
  await field.fill('https://media.test/good.png');
  await expect(page.locator('img[src="https://media.test/good.png"]')).toBeVisible();
});
