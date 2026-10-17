import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Recipe, RecipeInput } from '../src/lib/types';

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
const rosa = { id: 'rosa', name: 'Rosa', handle: 'rosa', avatar: '', bio: '' };
const original: Recipe = {
  id: 'nonna-toast',
  title: 'Nonna’s lemon toast',
  description: 'The one that started it.',
  cuisine: 'Italian',
  minutes: 10,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  photos: [],
  video: '',
  ingredients: [{ name: 'Bread', amount: 2, unit: 'slices', category: 'Bakery' }],
  steps: [{ title: 'Toast', text: 'Toast the bread.', seconds: 0 }],
  tags: [],
  calories: 120,
  aiGenerated: false,
  published: true,
  language: 'it',
  author: rosa,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
};
// Alex's own take on Rosa's toast, as the server returns it.
const mine: Recipe = {
  ...original,
  id: 'alex-toast',
  title: 'Lemon toast, my way',
  language: '',
  author: user,
  derivedFrom: { id: original.id, title: original.title, author: rosa },
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dWQAAAAASUVORK5CYII=',
  'base64',
);
const mp4 = readFileSync('tests/fixtures/sample.mp4');

/** The API, with `own` as Alex's recipe; photos upload as step-<n>.jpg, clips as clip-<n>.mp4. */
async function mockKitchen(page: Page, { gone = false, own = mine } = {}) {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const asked: string[] = [];
  let uploads = 0;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/v1', '');
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    asked.push(`${method} ${path}`);
    const body = request.postData() ? request.postDataJSON() : null;
    if (path === '/session') return json({ user });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ textAI: true });
    if (path === '/recipes' && method === 'POST') {
      writes.push({ method, path, body });
      return json({ ...body, id: 'saved-1', author: user, rating: 0, reviewCount: 0 }, 201);
    }
    if (path === `/recipes/${own.id}` && method === 'PUT') {
      writes.push({ method, path, body });
      return json({ ...own, ...body });
    }
    if (path === '/recipes') return json([original, own]);
    if (path === `/recipes/${own.id}`) return json(own);
    if (path === `/recipes/${original.id}`)
      return gone ? json({ error: 'Recipe not found.' }, 404) : json(original);
    if (path === '/creators') return json([user, rosa]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === '/media/uploads') {
      const clip = body.kind === 'video';
      const key = `uploads/cook/${clip ? 'clip' : 'step'}-${++uploads}.${clip ? 'mp4' : 'jpg'}`;
      return json({
        uploadUrl: `https://storage.test/savorly-media/${key}`,
        method: 'PUT',
        headers: { 'Content-Type': body.contentType, 'Cache-Control': 'public,max-age=31536000' },
        url: `https://media.test/${key}`,
        key,
      });
    }
    if (path === '/media/uploads/complete') return json({ url: `https://media.test/${body.key}` });
    return json([]);
  });
  await page.route('https://storage.test/**', (route) =>
    route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }),
  );
  await page.route('https://media.test/**', (route) =>
    route.request().url().endsWith('.mp4')
      ? route.fulfill({ path: 'tests/fixtures/sample.mp4', contentType: 'video/mp4' })
      : route.fulfill({ path: 'tests/fixtures/sample.png', contentType: 'image/png' }),
  );
  return { writes, asked };
}
const stepPhoto = async (page: Page, button: string) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button, exact: true }).click();
  await (await chooser).setFiles({ name: 'step.png', mimeType: 'image/png', buffer: png });
};
const stepClip = async (page: Page, button: string) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button, exact: true }).click();
  await (await chooser).setFiles({ name: 'step.mp4', mimeType: 'video/mp4', buffer: mp4 });
};
type Sent = RecipeInput['steps'];
// A recipe started by hand earlier on this device, carried on when the editor opens.
const draft = (page: Page, recipe: Partial<RecipeInput>) =>
  page.addInitScript((value) => {
    if (localStorage.getItem('savorly.draft.cook.new') === null)
      localStorage.setItem('savorly.draft.cook.new', value);
  }, JSON.stringify(recipe));

test('each step can carry a photo, added, replaced and removed', async ({ page }) => {
  const { writes } = await mockKitchen(page);
  await page.goto('/?page=create');
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Step toast');
  await page.getByRole('textbox', { name: 'Step 1 instructions', exact: true }).fill('Toast it.');
  await stepPhoto(page, 'Add a photo for step 1');
  await expect(
    page.getByRole('img', { name: 'Photo for step 1', exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('textbox', { name: 'Step 2 instructions', exact: true }).fill('Serve it.');
  await stepPhoto(page, 'Add a photo for step 2');
  await expect(
    page.getByRole('img', { name: 'Photo for step 2', exact: true }).first(),
  ).toBeVisible();
  // A better photo for the first step, then none for the second after all.
  await stepPhoto(page, 'Replace the photo for step 1');
  await page.getByRole('button', { name: 'Remove the photo for step 2', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Photo for step 2', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a photo for step 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  const steps = writes[0].body.steps as RecipeInput['steps'];
  expect(steps.map((step) => step.image || '')).toEqual([
    'https://media.test/uploads/cook/step-3.jpg',
    '',
  ]);
  expect(steps.map((step) => step.text)).toEqual(['Toast it.', 'Serve it.']);
});

test('each step can carry a short clip beside its photo, added, replaced and removed', async ({
  page,
}) => {
  const { writes } = await mockKitchen(page);
  await page.goto('/?page=create');
  await expect(
    page.getByText('Each step can have a photo and a short clip of up to 30 seconds.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Clip toast');
  await page.getByRole('textbox', { name: 'Step 1 instructions', exact: true }).fill('Toast it.');
  await stepClip(page, 'Add a clip to step 1');
  // The clip waits for a tap in the editor, and plays muted.
  const play = page.getByRole('button', { name: 'Play the clip of step 1', exact: true });
  await expect(play).toBeVisible();
  await expect(page.locator('video')).toHaveAttribute(
    'src',
    'https://media.test/uploads/cook/clip-1.mp4',
  );
  await play.click();
  await expect(
    page.getByRole('button', { name: 'Pause the clip of step 1', exact: true }),
  ).toBeVisible();
  expect(
    await page.locator('video').evaluate((v: HTMLVideoElement) => [v.muted, v.paused]),
  ).toEqual([true, false]);
  // A photo beside it, and a clip for a second step.
  await stepPhoto(page, 'Add a photo for step 1');
  await expect(
    page.getByRole('img', { name: 'Photo for step 1', exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('textbox', { name: 'Step 2 instructions', exact: true }).fill('Serve it.');
  await stepClip(page, 'Add a clip to step 2');
  await expect(
    page.getByRole('button', { name: 'Play the clip of step 2', exact: true }),
  ).toBeVisible();
  // A better clip for the first step, then none for the second after all.
  await stepClip(page, 'Replace the clip for step 1');
  await expect(page.locator('video[src="https://media.test/uploads/cook/clip-4.mp4"]')).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Remove the clip for step 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play the clip of step 2' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Add a clip to step 2', exact: true }),
  ).toBeVisible();
  await expect(page.locator('video')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('POST');
  const steps = writes[0].body.steps as Sent;
  expect(steps.map((step) => [step.text, step.image || '', step.video])).toEqual([
    [
      'Toast it.',
      'https://media.test/uploads/cook/step-2.jpg',
      'https://media.test/uploads/cook/clip-4.mp4',
    ],
    ['Serve it.', '', ''],
  ]);
});

test('editing a recipe keeps its clips, and sends a removed one as empty', async ({ page }) => {
  const own: Recipe = {
    ...mine,
    steps: [
      {
        title: 'Toast',
        text: 'Toast the bread.',
        seconds: 0,
        video: 'https://media.test/toast.mp4',
      },
      {
        title: 'Spread',
        text: 'Spread the ricotta.',
        seconds: 0,
        image: 'https://media.test/spread.png',
        video: 'https://media.test/spread.mp4',
      },
    ],
  };
  const { writes } = await mockKitchen(page, { own });
  await page.goto(`/?recipe=${own.id}`);
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Play the clip of step 1', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove the clip for step 2', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Add a clip to step 2', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Photo for step 2', exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('PUT');
  const steps = writes[0].body.steps as Sent;
  expect(steps.map((step) => [step.image ?? null, step.video ?? null])).toEqual([
    [null, 'https://media.test/toast.mp4'],
    ['https://media.test/spread.png', ''],
  ]);
});

test('a new recipe is in the app’s language unless the cook picks another', async ({ page }) => {
  const { writes } = await mockKitchen(page);
  await page.goto('/?page=create');
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Tostada');
  await page
    .getByRole('button', { name: 'Choose the recipe’s language, currently English', exact: true })
    .click();
  await expect(page.getByRole('radio', { name: 'English' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('radio', { name: 'Español', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Choose the recipe’s language, currently Español' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Share my recipe', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ title: 'Tostada', language: 'es', published: true });
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });
  test('a new recipe starts in French', async ({ page }) => {
    const { writes } = await mockKitchen(page);
    await page.goto('/?page=create');
    await page.getByRole('textbox', { name: 'Nom de la recette', exact: true }).fill('Tartine');
    await expect(
      page.getByRole('button', {
        name: 'Choisir la langue de la recette, actuellement Français',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body).toMatchObject({ title: 'Tartine', language: 'fr', published: false });
  });
});

test('editing an adaptation credits the original and leaves its link to the server', async ({
  page,
}) => {
  const { writes } = await mockKitchen(page);
  await page.goto(`/?recipe=${mine.id}`);
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await expect(
    page.getByText('Adapted from Nonna’s lemon toast by Rosa', { exact: true }),
  ).toBeVisible();
  // Saved before recipes had a language: nothing is chosen until the cook says.
  await expect(
    page.getByRole('button', { name: 'Choose the recipe’s language, currently Not set' }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Lemon toast, mine');
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('PUT');
  expect(writes[0].body).toMatchObject({ title: 'Lemon toast, mine', language: '' });
  expect(writes[0].body).not.toHaveProperty('derivedFrom');
});

test('a new adaptation keeps its original when it’s saved', async ({ page }) => {
  await draft(page, { ...original, title: 'Lemon toast with chili', derivedFrom: original.id });
  const { writes, asked } = await mockKitchen(page);
  await page.goto('/?page=create');
  await expect(page.getByRole('textbox', { name: 'Recipe title', exact: true })).toHaveValue(
    'Lemon toast with chili',
  );
  // The original's name is looked up by its id.
  await expect(
    page.getByText('Adapted from Nonna’s lemon toast by Rosa', { exact: true }),
  ).toBeVisible();
  expect(asked).toContain(`GET /recipes/${original.id}`);
  await page.getByRole('button', { name: 'Share my recipe', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({
    title: 'Lemon toast with chili',
    derivedFrom: original.id,
    language: 'it',
  });
});

test('an original that’s gone isn’t credited', async ({ page }) => {
  await draft(page, { ...original, title: 'Lemon toast with chili', derivedFrom: original.id });
  const { writes } = await mockKitchen(page, { gone: true });
  await page.goto('/?page=create');
  await expect(page.getByRole('textbox', { name: 'Recipe title', exact: true })).toHaveValue(
    'Lemon toast with chili',
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).not.toHaveProperty('derivedFrom');
  await expect(page.getByText(/^Adapted from/)).toHaveCount(0);
});

test('device speech reads a recipe in its own language', async ({ page }) => {
  await page.addInitScript(() => {
    const spoken: { text: string; lang: string }[] = [];
    Object.assign(window, { spoken });
    window.speechSynthesis.speak = (u) => void spoken.push({ text: u.text, lang: u.lang });
  });
  await mockKitchen(page);
  await page.goto(`/?recipe=${original.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Read this step aloud', exact: true }).click();
  // An Italian recipe in an English app is read with an Italian voice.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { spoken: unknown[] }).spoken))
    .toEqual([{ text: 'Toast the bread.', lang: 'it-IT' }]);
});
