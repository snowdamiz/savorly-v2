import { expect, test, type Page } from '@playwright/test';
import type { RecipeInput, RecipeTranslation } from '../src/lib/types';
import { alex, json, mockApi, recipe } from './mockApi';

// What a recipe needs besides its ingredients: the recipe page's "You'll need" (the cook's list,
// or what the method mentions, labelled), cooking mode's first step, and the editor's list.

const pasta = recipe({
  id: 'pasta',
  title: 'Weeknight pasta',
  steps: [
    { title: 'Boil', text: 'Bring a large pot of salted water to a boil.', seconds: 0 },
    { title: 'Drain', text: 'Drain the pasta in a colander.', seconds: 0 },
  ],
  equipment: ['Large pot', 'Colander'],
  equipmentDetected: ['pot', 'colander'],
});
// No list of its own: the page shows what the method mentions.
const frittata = recipe({
  id: 'frittata',
  title: 'Oven frittata',
  steps: [{ title: 'Bake', text: 'Fry the onions in a pan, then bake in the oven.', seconds: 0 }],
  equipment: [],
  equipmentDetected: ['frying pan', 'oven', 'sous vide circulator'],
});
// No list either, and the sous-chef has guessed what each step uses.
const pesto = recipe({
  id: 'pesto',
  title: 'Pesto linguine',
  steps: [
    { title: 'Pesto', text: 'Blend the basil with oil.', seconds: 0 },
    { title: 'Pasta', text: 'Cook the linguine in salted boiling water, then drain.', seconds: 0 },
  ],
  equipment: [],
  equipmentDetected: [],
  equipmentGuess: [
    { key: 'blender', steps: [1] },
    { key: 'pot', steps: [2] },
    { key: 'colander', steps: [2] },
  ],
});
const needs = (page: Page) => page.getByRole('heading', { name: 'You’ll need', exact: true });
const item = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name });

test('a recipe page lists the cook’s equipment before the method', async ({ page }) => {
  await mockApi(page, { recipes: [pasta] });
  await page.goto('/recipes/pasta');
  await expect(needs(page)).toBeVisible();
  await expect(item(page, 'Large pot')).toBeVisible();
  await expect(item(page, 'Colander')).toBeVisible();
  // The cook's own words, never mixed with what the method mentions.
  await expect(page.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('· From the method', { exact: true })).toHaveCount(0);
});

test('without a list, the page shows what the method mentions, and says so', async ({ page }) => {
  await mockApi(page, { recipes: [frittata, recipe({ id: 'plain', title: 'Plain toast' })] });
  await page.goto('/recipes/frittata');
  await expect(needs(page)).toBeVisible();
  await expect(page.getByText('· From the method', { exact: true })).toBeVisible();
  await expect(item(page, 'Frying pan')).toBeVisible();
  await expect(item(page, 'Oven')).toBeVisible();
  // A key this version of the app can't name is left out.
  await expect(page.getByRole('listitem')).toHaveCount(2);
  // A recipe from an older server, or one whose method mentions nothing, shows no section.
  await page.goto('/recipes/plain');
  await expect(page.getByRole('heading', { name: 'Plain toast' }).first()).toBeVisible();
  await expect(needs(page)).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the method tab starts with what you’ll need', async ({ page }) => {
    await mockApi(page, { recipes: [pasta] });
    await page.goto('/recipes/pasta');
    await expect(page.getByRole('heading', { name: 'Ingredients', exact: true })).toBeVisible();
    await expect(needs(page)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Method', exact: true }).click();
    await expect(needs(page)).toBeVisible();
    await expect(item(page, 'Large pot')).toBeVisible();
    // Above the first step, so it's read before cooking starts.
    const top = async (name: string) =>
      (await page.getByRole('heading', { name, exact: true }).boundingBox())!.y;
    expect(await top('You’ll need')).toBeLessThan(await top('Boil'));
  });
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });
  test('what the method mentions is named in the reader’s language', async ({ page }) => {
    await mockApi(page, { recipes: [frittata] });
    await page.goto('/recipes/frittata');
    await expect(page.getByRole('heading', { name: 'Il vous faut', exact: true })).toBeVisible();
    await expect(page.getByText('· D’après la préparation', { exact: true })).toBeVisible();
    await expect(item(page, 'Poêle')).toBeVisible();
    await expect(item(page, 'Four')).toBeVisible();
  });
});

test('a translated recipe shows the cook’s equipment translated', async ({ page }) => {
  const soup = recipe({
    id: 'soup',
    title: 'Soupe à l’oignon',
    language: 'fr',
    ingredients: [{ name: 'Oignons', amount: 1, unit: 'kg', category: 'Produce' }],
    steps: [{ title: 'Oignons', text: 'Faites fondre les oignons.', seconds: 0 }],
    equipment: ['Grande cocotte'],
    equipmentDetected: ['dutch oven'],
  });
  const english: RecipeTranslation = {
    language: 'en',
    sourceLanguage: 'fr',
    title: 'French onion soup',
    description: 'A soup.',
    ingredients: [{ name: 'Onions' }],
    steps: [{ title: 'Onions', text: 'Cook the onions down slowly.' }],
    equipment: ['Large Dutch oven'],
    translatedAt: '2026-10-17T10:00:00Z',
  };
  const api = await mockApi(page, { recipes: [soup], capabilities: { recipeTranslation: true } });
  api.on('GET', '/recipes/soup/translation', () => json(english));
  await page.goto('/recipes/soup');
  await expect(item(page, 'Grande cocotte')).toBeVisible();
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await expect(item(page, 'Large Dutch oven')).toBeVisible();
  await expect(item(page, 'Grande cocotte')).toHaveCount(0);
});

test('cooking mode starts with what to get out, then moves on', async ({ page }) => {
  await mockApi(page, { recipes: [pasta] });
  await page.goto('/recipes/pasta');
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(page.getByText('Before you start', { exact: true })).toBeVisible();
  await expect(page.getByText('You’ll need: Large pot, Colander', { exact: true })).toBeVisible();
  await expect(page.getByText('STEP 1 OF 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.getByText('STEP 2 OF 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Before you start', { exact: true })).toHaveCount(0);
});

test('cooking mode names what the method mentions when the cook lists nothing', async ({
  page,
}) => {
  await mockApi(page, { recipes: [frittata] });
  await page.goto('/recipes/frittata');
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(page.getByText('You’ll need: Frying pan, Oven', { exact: true })).toBeVisible();
  await expect(page.getByText('From the method', { exact: true })).toBeVisible();
});

test('without a list, the page and cooking mode show the sous-chef’s guess, step by step', async ({
  page,
}) => {
  await mockApi(page, { recipes: [pesto] });
  await page.goto('/recipes/pesto');
  await expect(needs(page)).toBeVisible();
  await expect(page.getByText('· Sous-chef’s guess', { exact: true })).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(3);
  await expect(item(page, 'Blender')).toBeVisible();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(
    page.getByText('You’ll need: Blender, Pot, Colander', { exact: true }),
  ).toBeVisible();
  // Each step says what it uses, when it uses it.
  const step = page.getByLabel(/^Equipment for this step: /);
  await expect(step).toHaveAccessibleName('Equipment for this step: Blender');
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(step).toHaveAccessibleName('Equipment for this step: Pot, Colander');
});

test('the cook’s list says nothing of steps', async ({ page }) => {
  await mockApi(page, { recipes: [{ ...pesto, equipment: ['Food processor'] }] });
  await page.goto('/recipes/pesto');
  await expect(item(page, 'Food processor')).toBeVisible();
  await expect(page.getByText('· Sous-chef’s guess', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(page.getByText('You’ll need: Food processor', { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Equipment for this step: /)).toHaveCount(0);
});

test('the editor keeps a list, fills it from the method, and saves it', async ({ page }) => {
  const api = await mockApi(page);
  const read: unknown[] = [];
  api.on('POST', '/recipes/equipment', ({ body }) => {
    read.push(body);
    return json({ equipment: ['frying pan', 'oven', 'sous vide circulator'] });
  });
  api.on('POST', '/recipes', ({ body }) =>
    json(
      {
        ...(body as RecipeInput),
        id: 'saved-1',
        author: alex,
        rating: 0,
        reviewCount: 0,
        saveCount: 0,
        createdAt: '2026-10-17T10:00:00Z',
      },
      201,
    ),
  );
  await page.goto('/?page=create');
  await expect(page.getByText('Equipment', { exact: true })).toBeVisible();
  // Nothing to read until the method says something.
  const fill = page.getByRole('button', { name: 'Add what the method mentions', exact: true });
  await expect(fill).toBeDisabled();
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Oven frittata');
  await page
    .getByRole('textbox', { name: 'Step 1 instructions', exact: true })
    .fill('Fry the onions in a pan, then bake in the oven.');
  await fill.click();
  await expect(page.getByText('Added 2 items from the method.', { exact: true })).toBeVisible();
  const field = (n: number) => page.getByRole('textbox', { name: `Equipment ${n}`, exact: true });
  await expect(field(1)).toHaveValue('Frying pan');
  await expect(field(2)).toHaveValue('Oven');
  await expect(field(3)).toHaveCount(0);
  expect(read).toEqual([
    {
      steps: [{ title: '', text: 'Fry the onions in a pan, then bake in the oven.' }],
      language: 'en',
    },
  ]);
  // Asking again adds nothing twice.
  await fill.click();
  await expect(
    page.getByText('Your list already has what the method mentions.', { exact: true }),
  ).toBeVisible();
  // The cook's own, moved up, and one taken out.
  await page.getByRole('button', { name: 'Add equipment', exact: true }).click();
  await field(3).fill('Large ovenproof skillet');
  await page.getByRole('button', { name: 'Move equipment 3 up', exact: true }).click();
  await expect(field(2)).toHaveValue('Large ovenproof skillet');
  await page.getByRole('button', { name: 'Remove equipment 1', exact: true }).click();
  await expect(field(1)).toHaveValue('Large ovenproof skillet');
  await expect(field(2)).toHaveValue('Oven');
  // The device draft keeps it as it's typed.
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('savorly.draft.me.new') || '{}').equipment,
      ),
    )
    .toEqual(['Large ovenproof skillet', 'Oven']);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => api.sentTo('/recipes').length).toBe(1);
  const [[, sent]] = api.sentTo('/recipes');
  expect((sent as RecipeInput).equipment).toEqual(['Large ovenproof skillet', 'Oven']);
});

test('editing a recipe keeps its list, and emptying it clears it', async ({ page }) => {
  const mine = recipe({ ...pasta, id: 'mine', author: alex, published: false });
  const api = await mockApi(page, { recipes: [mine], library: { recipes: [mine] } });
  api.on('PUT', '/recipes/mine', ({ body }) => json({ ...mine, ...(body as RecipeInput) }));
  await page.goto('/recipes/mine');
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  const field = (n: number) => page.getByRole('textbox', { name: `Equipment ${n}`, exact: true });
  await expect(field(1)).toHaveValue('Large pot');
  await expect(field(2)).toHaveValue('Colander');
  await page.getByRole('button', { name: 'Remove equipment 2', exact: true }).click();
  await page.getByRole('button', { name: 'Remove equipment 1', exact: true }).click();
  await expect(field(1)).toHaveCount(0);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => api.sentTo('/recipes/mine').length).toBe(1);
  expect((api.sentTo('/recipes/mine')[0][1] as RecipeInput).equipment).toEqual([]);
});
