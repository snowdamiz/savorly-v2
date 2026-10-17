import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import type { Recipe } from '../src/lib/types';

// Against the real API and storage. What it shows comes from the API itself (the seed, locally and
// in CI) rather than from names written here, so changing the seed or the home's choice of
// recipe doesn't break it.
const apiUrl = process.env.TEST_API_URL || 'http://localhost:8080';

/** A published recipe with a few steps, a word from its title, and a recipe that word doesn't find. */
async function searchCase(request: APIRequestContext) {
  const get = async (path: string) => {
    const response = await request.get(`${apiUrl}/v1${path}`);
    expect(response.ok(), `GET ${path}`).toBe(true);
    return (await response.json()) as Recipe[];
  };
  const recipes = await get('/recipes');
  for (const recipe of recipes.filter((r) => r.steps.length >= 2)) {
    const word = recipe.title.split(/[^\p{L}]+/u).find((w) => w.length >= 5);
    if (!word) continue;
    const found = await get(`/recipes?q=${encodeURIComponent(word)}`);
    const other = recipes.find((r) => !found.some((f) => f.id === r.id));
    if (other && found.some((f) => f.id === recipe.id)) return { recipe, word, other };
  }
  throw new Error('The API has no published recipes to search; is it seeded?');
}

test('discovery, filters, details and mobile layout', async ({ page, request }, testInfo) => {
  const { recipe, word, other } = await searchCase(request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText('What would you like to cook today?')).toBeVisible({
    timeout: 60000,
  });
  await page.screenshot({ path: testInfo.outputPath('discover-desktop.png'), fullPage: true });
  await page.getByRole('textbox', { name: 'Search recipes' }).fill(word);
  const card = page.getByRole('link', { name: `View ${recipe.title}`, exact: true });
  await expect(card).toBeVisible();
  await expect(
    page.getByRole('link', { name: `View ${other.title}`, exact: true }),
  ).not.toBeVisible();
  await card.click();
  await expect(page.getByText('Let’s make it', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More servings', exact: true }).click();
  await expect(
    page.getByText(`For ${recipe.servings + 1} people. Tap to check off.`, { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(page.getByText(`STEP 1 OF ${recipe.steps.length}`)).toBeVisible();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.getByText(`STEP 2 OF ${recipe.steps.length}`)).toBeVisible();
  await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
  // A desktop browser shows the recipe as a page with a Back link; phones close a sheet.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'My kitchen', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('discover-mobile.png'), fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
test('register, save, groceries, plan and publish a recipe', async ({ page }) => {
  const email = `browser-${Date.now()}@example.test`;
  const password = 'a-long-browser-test-password';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New here? Create an account', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Robin Cook');
    await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const registration = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/auth/register') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create your kitchen', exact: true }).click();
    expect((await registration).status()).toBe(200);
    // A new kitchen sets itself up: the username suggestion comes from the name, and any free one
    // works; the rest can be skipped.
    const username = page.getByRole('textbox', { name: 'Username', exact: true });
    await expect(username).toHaveValue(/^robincook\d*$/);
    const handle = `robin.${Date.now().toString(36)}`;
    await username.fill(handle);
    await expect(page.getByText(`@${handle} is available.`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('How do you like to eat?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    // The feed behind the setup has a “Cooks to follow” section too (an <h2>; the setup's is an <h1>).
    await expect(
      page.getByRole('heading', { name: 'Cooks to follow', exact: true, level: 1 }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByText('Just ask your sous-chef', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Let’s get started', exact: true }).click();
    await expect(
      page.getByText(`Welcome to the table, @${handle}.`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Good (morning|afternoon|evening), Robin/)).toBeVisible();
    // Whichever recipe the home leads with.
    await page.getByRole('link', { name: /^Let’s get cooking: / }).click();
    await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
    await expect(page.getByText('Saved to your cookbook', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add to grocery list', exact: true }).click();
    await expect(page.getByText('Ingredients added to your grocery list.')).toBeVisible();
    await page.getByRole('button', { name: 'Plan this meal', exact: true }).click();
    await page.getByRole('button', { name: 'Add to my week', exact: true }).click();
    await expect(page.getByText('A delicious plan. Added to your week.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
    await page.getByRole('button', { name: 'Write a recipe yourself', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Recipe title', exact: true })
      .fill('Robin’s lemon toast');
    await page
      .getByRole('textbox', { name: 'The story behind it', exact: true })
      .fill('A bright, simple toast from our weekend kitchen.');
    await page.getByRole('textbox', { name: 'Ingredient 1', exact: true }).fill('Sourdough');
    await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('0.5');
    await page.getByRole('textbox', { name: 'Step 1 title', exact: true }).fill('Toast the bread');
    await page
      .getByRole('textbox', { name: 'Step 1 instructions', exact: true })
      .fill('Toast until golden and finish with a squeeze of lemon.');
    // Each upload goes straight to storage or, where the browser can't reach it, through the API;
    // either way the address it ends up with must be one storage serves.
    const stored = async (field: string, type: RegExp) => {
      const box = page.getByRole('textbox', { name: field, exact: true });
      await expect(box).toHaveValue(/^https?:\/\//, { timeout: 30_000 });
      const file = await page.request.get(await box.inputValue());
      expect(file.ok(), 'storage serves the upload').toBe(true);
      expect(file.headers()['content-type']).toMatch(type);
    };
    const photoChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload a photo', exact: true }).click();
    await (await photoChooser).setFiles('tests/fixtures/sample.png');
    await stored('Or use an image URL', /^image\//);
    const extraChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add another photo', exact: true }).click();
    await (await extraChooser).setFiles('tests/fixtures/sample.png');
    await expect(page.getByRole('button', { name: 'Remove photo 2', exact: true })).toBeVisible();
    const videoChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload a recipe video', exact: true }).click();
    await (await videoChooser).setFiles('tests/fixtures/sample.mp4');
    await stored('Or use a direct video URL', /^video\//);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('video')).some((video) => video.readyState >= 2),
    );
    await page.getByRole('button', { name: 'Share my recipe', exact: true }).click();
    await expect(page.getByText('Your recipe is at the table. Thanks for sharing.')).toBeVisible();
    await expect(page.getByText('Robin’s lemon toast', { exact: true }).last()).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Show photo 2 of 2', exact: true }),
    ).toBeVisible();
  } finally {
    // A test timeout closes fixture contexts; cleanup needs its own connection.
    const cleanup = await apiRequest.newContext({ timeout: 60000 });
    try {
      const response = await cleanup.post(`${apiUrl}/v1/auth/login`, {
        data: { email, password },
      });
      if (response.ok()) {
        const session = await response.json();
        await cleanup.delete(`${apiUrl}/v1/me`, {
          headers: { Authorization: `Bearer ${session.token}` },
          data: { password },
        });
      }
    } finally {
      await cleanup.dispose();
    }
  }
});
