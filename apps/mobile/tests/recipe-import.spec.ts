import { test, expect, Page } from '@playwright/test';
import type { AIJob, RecipeInput } from '../src/lib/types';

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
const link = 'https://www.blog.test/leek-soup';
const soup: RecipeInput = {
  title: 'Leek and potato soup',
  description: 'Silky, peppery and done in half an hour.',
  cuisine: 'French',
  minutes: 30,
  servings: 4,
  difficulty: 'Easy',
  image: '',
  photos: [],
  video: '',
  ingredients: [
    { name: 'Leeks', amount: 3, unit: '', category: 'Produce' },
    { name: 'Potatoes', amount: 500, unit: 'g', category: 'Produce' },
  ],
  steps: [
    { title: 'Sweat', text: 'Soften the leeks in butter.', seconds: 600 },
    { title: 'Simmer', text: 'Add the potatoes and stock; simmer until soft.', seconds: 1200 },
  ],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: false,
  sourceUrl: link,
};
const job = (status: AIJob['status'], recipe?: RecipeInput): AIJob => ({
  id: 'import-job',
  kind: 'recipe',
  prompt: '',
  status,
  result: recipe ? { recipe } : {},
  error: '',
  createdAt: new Date().toISOString(),
});

type Answer = { status: number; body: unknown };
/** The API, answering the import with `answer` and each look at the job with the next of `jobs`. */
async function mockKitchen(page: Page, answer: Answer, jobs: AIJob[] = []) {
  const imports: unknown[] = [];
  const saved: Record<string, unknown>[] = [];
  let looks = 0;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/v1', '');
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/session') return json({ user });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ textAI: true });
    if (path === '/recipes/import') {
      imports.push(request.postDataJSON());
      return json(answer.body, answer.status);
    }
    if (path === '/ai/jobs/import-job') return json(jobs[Math.min(looks++, jobs.length - 1)]);
    if (path === '/recipes' && method === 'POST') {
      const body = request.postDataJSON();
      saved.push(body);
      return json({ ...body, id: 'imported-1', author: user, rating: 0, reviewCount: 0 }, 201);
    }
    if (path === '/recipes') return json([]);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    return json([]);
  });
  return { imports, saved };
}
const openImport = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Import a recipe from a link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import from a link' })).toBeVisible();
  return page.getByRole('textbox', { name: 'Recipe link', exact: true });
};

test('a page with recipe data opens in the editor, private and crediting the page', async ({
  page,
}) => {
  const { imports, saved } = await mockKitchen(page, {
    status: 200,
    body: { method: 'structured', recipe: soup },
  });
  const field = await openImport(page);
  // Pasting a whole message keeps just its link.
  await field.fill(`Look at this one! ${link}`);
  await expect(field).toHaveValue(link);
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Recipe title', exact: true });
  await expect(title).toHaveValue('Leek and potato soup');
  expect(imports).toEqual([{ url: link }]);
  await expect(page.getByRole('link', { name: 'Imported from blog.test' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Step 2 instructions', exact: true })).toHaveValue(
    'Add the potatoes and stock; simmer until soft.',
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({
    title: 'Leek and potato soup',
    sourceUrl: link,
    published: false,
    aiGenerated: false,
  });
});

test('otherwise the sous-chef reads the page, and the editor opens when it’s done', async ({
  page,
}) => {
  const { saved } = await mockKitchen(
    page,
    { status: 202, body: { method: 'ai', job: job('queued') } },
    [job('running'), job('completed', { ...soup, aiGenerated: true })],
  );
  const field = await openImport(page);
  await field.fill(link);
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  await expect(page.getByText('The sous-chef is reading the page…', { exact: true })).toBeVisible();
  const title = page.getByRole('textbox', { name: 'Recipe title', exact: true });
  await expect(title).toHaveValue('Leek and potato soup', { timeout: 15000 });
  await expect(page.getByRole('link', { name: 'Imported from blog.test' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'I used AI to create this' })).toBeChecked();
  // Publishing stays the cook's choice.
  await page.getByRole('button', { name: 'Share my recipe', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ sourceUrl: link, aiGenerated: true, published: true });
});

for (const [status, message] of [
  [422, 'We couldn’t find a recipe on that page.'],
  [502, 'We couldn’t open that page.'],
  [503, 'We couldn’t read a recipe from that page.'],
  [400, 'That doesn’t look like a link to a recipe page. Check it and try again.'],
] as const) {
  test(`an import the server refuses with ${status} says why`, async ({ page }) => {
    await mockKitchen(page, { status, body: { error: 'The server’s own words.' } });
    const field = await openImport(page);
    await field.fill(link);
    await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(message);
    // Still here to try another link.
    await expect(field).toHaveValue(link);
  });
}

test('an address that isn’t a web page is caught before anything is sent', async ({ page }) => {
  const { imports } = await mockKitchen(page, { status: 200, body: {} });
  const field = await openImport(page);
  await field.fill('leek soup');
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Enter the full address of a web page, like https://example.com/recipe.',
  );
  expect(imports).toEqual([]);
  // Back to the other ways in.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add a recipe' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write a recipe yourself' })).toBeVisible();
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });
  test('the reason a page couldn’t be imported is translated', async ({ page }) => {
    await mockKitchen(page, { status: 422, body: { error: 'We couldn’t find a recipe.' } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Créer une recette', exact: true }).click();
    await page
      .getByRole('button', { name: 'Importer une recette depuis un lien', exact: true })
      .click();
    await page.getByRole('textbox', { name: 'Lien de la recette', exact: true }).fill(link);
    await page.getByRole('button', { name: 'Importer la recette', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Nous n’avons pas trouvé de recette sur cette page.',
    );
  });
});
