import { test, expect, Page } from '@playwright/test';
import type { AIJob, RecipeInput } from '../src/lib/types';

// Importing from a video post's link: the API reads the caption (mocked here), and the editor
// credits the post and its creator and asks the cook to check the amounts.
const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
const shared = 'https://vm.tiktok.com/ZMabc123/';
const post = 'https://www.tiktok.com/@chefjo/video/7300000000000000001';
const pasta: RecipeInput = {
  title: 'Creamy lemon pasta',
  description: 'From Chef Jo (@chefjo) on TikTok. The butter amount was estimated.',
  cuisine: 'Italian',
  minutes: 15,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  photos: [],
  video: '',
  ingredients: [
    { name: 'Spaghetti', amount: 200, unit: 'g', category: 'Pantry' },
    { name: 'Butter', amount: 2, unit: 'tbsp', category: 'Dairy' },
  ],
  steps: [{ title: 'Toss', text: 'Toss the pasta with butter and lemon.', seconds: 0 }],
  tags: [],
  calories: 0,
  aiGenerated: true,
  published: false,
  sourceUrl: post,
};
const job = (status: AIJob['status'], recipe?: RecipeInput): AIJob => ({
  id: 'video-job',
  kind: 'recipe',
  prompt: '',
  status,
  result: recipe ? { recipe } : {},
  error: '',
  createdAt: new Date().toISOString(),
});
const captionless =
  'We couldn’t find a recipe in that post’s caption. Try the link to the full recipe if the creator shared one.';

/** The API, answering the import with `answer` and each look at the job with the next of `jobs`. */
async function mockKitchen(page: Page, answer: { status: number; body: unknown }, jobs: AIJob[] = []) {
  const imports: unknown[] = [];
  const saved: Record<string, unknown>[] = [];
  let looks = 0;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/v1', '');
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/session') return json({ user });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ textAI: true });
    if (path === '/recipes/import') {
      imports.push(request.postDataJSON());
      return json(answer.body, answer.status);
    }
    if (path === '/ai/jobs/video-job') return json(jobs[Math.min(looks++, jobs.length - 1)]);
    if (path === '/recipes' && request.method() === 'POST') {
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

test('a TikTok link brings its caption’s recipe into the editor, crediting the creator', async ({
  page,
}) => {
  const { imports, saved } = await mockKitchen(
    page,
    { status: 202, body: { method: 'ai', job: job('queued') } },
    [job('running'), job('completed', pasta)],
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  // The way in says video links work.
  await expect(
    page.getByText(
      'Paste a link to a recipe page or a cooking video. We’ll bring it in for you to edit.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Import a recipe from a link', exact: true }).click();
  await expect(
    page.getByText(
      'Paste the address of a recipe page, or of a video on TikTok, Instagram, YouTube, Facebook or Pinterest. We’ll bring the recipe into the editor for you to check.',
      { exact: true },
    ),
  ).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Recipe link', exact: true });
  // Sharing from the app pastes the caption's first words with the link.
  await field.fill(`Creamy lemon pasta 🍋 ${shared}`);
  await expect(field).toHaveValue(shared);
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  await expect(page.getByText('The sous-chef is reading the post…', { exact: true })).toBeVisible();
  const title = page.getByRole('textbox', { name: 'Recipe title', exact: true });
  await expect(title).toHaveValue('Creamy lemon pasta', { timeout: 15000 });
  expect(imports).toEqual([{ url: shared }]);
  // The post and its creator are credited, a tap away to compare the amounts against.
  await expect(page.getByRole('link', { name: 'Imported from @chefjo on TikTok' })).toBeVisible();
  await expect(
    page.getByText(
      'The sous-chef read this from the original. Check the amounts against it before you share it.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'The story behind it', exact: true })).toHaveValue(
    pasta.description,
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ sourceUrl: post, aiGenerated: true, published: false });
});

test('a post whose caption holds no recipe says so, and the link stays to try another', async ({
  page,
}) => {
  await mockKitchen(page, { status: 422, body: { error: captionless } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Import a recipe from a link', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Recipe link', exact: true });
  await field.fill(post);
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(captionless);
  await expect(field).toHaveValue(post);
});

test.describe('in Spanish', () => {
  test.use({ locale: 'es-ES' });
  test('the reason a post couldn’t be imported is translated', async ({ page }) => {
    await mockKitchen(page, {
      status: 502,
      body: { error: 'We couldn’t open that post. It may be private or no longer available.' },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Crear receta', exact: true }).click();
    await page
      .getByRole('button', { name: 'Importar una receta desde un enlace', exact: true })
      .click();
    await page.getByRole('textbox', { name: 'Enlace de la receta', exact: true }).fill(post);
    await page.getByRole('button', { name: 'Importar receta', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'No pudimos abrir esa publicación. Puede que sea privada o que ya no esté disponible.',
    );
  });
});
