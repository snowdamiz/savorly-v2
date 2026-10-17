import { expect, test, type Page } from '@playwright/test';
import type { RecipeTranslation } from '../src/lib/types';
import { failure, json, mockApi, recipe, type MockOptions } from './mockApi';

// Recipes written in another language: the page offers its translation into the app's, reads it
// in cooking mode, remembers "Always translate recipes", and keeps it for cooking offline.

const soup = recipe({
  id: 'onion-soup',
  title: 'Soupe à l’oignon',
  description: 'Une soupe gratinée pour les soirs d’hiver.',
  cuisine: 'French',
  language: 'fr',
  ingredients: [
    { name: 'Oignons', amount: 1, unit: 'kg', category: 'Produce' },
    { name: 'Beurre', amount: 50, unit: 'g', category: 'Dairy' },
  ],
  steps: [
    { title: 'Oignons', text: 'Faites fondre les oignons.', seconds: 0 },
    { title: 'Servir', text: 'Servez bien chaud.', seconds: 0 },
  ],
});
const english: RecipeTranslation = {
  language: 'en',
  sourceLanguage: 'fr',
  title: 'French onion soup',
  description: 'A soup with a golden cheese crust, for winter evenings.',
  ingredients: [{ name: 'Onions' }, { name: 'Butter' }],
  steps: [
    { title: 'Onions', text: 'Cook the onions down slowly.' },
    { title: 'Serve', text: 'Serve piping hot.' },
  ],
  translatedAt: '2026-10-17T10:00:00Z',
};

/** The API, with recipe translation on, translating the soup into English. */
async function kitchen(page: Page, options: MockOptions = {}) {
  const api = await mockApi(page, {
    recipes: [soup],
    capabilities: { recipeTranslation: true, cookingNarration: true },
    ...options,
  });
  const asked: string[] = [];
  api.on('GET', /^\/recipes\/([^/]+)\/translation$/, ({ params, query }) => {
    asked.push(`${params[0]}:${query.get('language')}`);
    if (!api.state.session) return failure(401, 'Sign in to translate this recipe.');
    return json(english);
  });
  return { api, asked };
}
const heading = (page: Page, title: string) =>
  page.getByRole('heading', { level: 1, name: title, exact: true });

test('a recipe in another language is read and cooked translated, then shown as written', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const spoken: { text: string; lang: string }[] = [];
    Object.assign(window, { spoken });
    window.speechSynthesis.speak = (u) => void spoken.push({ text: u.text, lang: u.lang });
  });
  const { api, asked } = await kitchen(page);
  await page.goto(`/recipes/${soup.id}`);
  await expect(heading(page, 'Soupe à l’oignon')).toBeVisible();
  await expect(page.getByText('Written in French', { exact: true })).toBeVisible();
  // Nothing is translated, or paid for, until the cook asks.
  expect(asked).toEqual([]);
  await page.getByRole('checkbox', { name: /Oignons/ }).click();
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await expect(heading(page, 'French onion soup')).toBeVisible();
  await expect(page.getByText('Translated from French by AI', { exact: true })).toBeVisible();
  await expect(page.getByText('Cook the onions down slowly.', { exact: true })).toBeVisible();
  // Amounts and units stay the recipe's, and the checklist stays checked.
  await expect(page.getByRole('checkbox', { name: /Onions/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByText('1 kg', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Always translate recipes' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(asked).toEqual([`${soup.id}:en`]);

  // Cooking mode reads the translation, aloud too: the API is asked for the translation's step
  // (it declines here, so the device's voice reads it, in English).
  const narration: unknown[] = [];
  api.on('POST', /^\/recipes\/[^/]+\/steps\/\d+\/narration$/, ({ body }) => {
    narration.push(body);
    return failure(409, 'This recipe has changed. Refresh it before reading aloud.');
  });
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  const cooking = page.locator('[aria-modal="true"]').last();
  await expect(cooking.getByText('Cook the onions down slowly.', { exact: true })).toBeVisible();
  await expect(cooking.getByText('Translated by AI', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Read this step aloud', exact: true }).click();
  await expect
    .poll(() => narration)
    .toEqual([{ text: 'Cook the onions down slowly.', language: 'en' }]);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { spoken: unknown[] }).spoken))
    .toEqual([{ text: 'Cook the onions down slowly.', lang: 'en-US' }]);
  await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();

  await page.getByRole('button', { name: 'Show original', exact: true }).click();
  await expect(heading(page, 'Soupe à l’oignon')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Oignons/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(errors).toEqual([]);
});

test('"Always translate recipes" is saved with the cook and opens recipes translated', async ({
  page,
}) => {
  const { api, asked } = await kitchen(page);
  await page.goto(`/recipes/${soup.id}`);
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await page.getByRole('switch', { name: 'Always translate recipes' }).click();
  await expect(page.getByRole('switch', { name: 'Always translate recipes' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect
    .poll(() => api.sentTo('/me/preferences'))
    .toEqual([['PATCH', { translateRecipes: true }]]);
  // Another visit, with the preference on the profile: the recipe opens translated by itself.
  const signedIn = await page.context().newPage();
  const next = await kitchen(signedIn, {
    user: { preferences: { diets: [], allergies: [], translateRecipes: true } },
  });
  await signedIn.goto(`/recipes/${soup.id}`);
  await expect(heading(signedIn, 'French onion soup')).toBeVisible();
  expect(next.asked).toEqual([`${soup.id}:en`]);
  expect(asked).toEqual([`${soup.id}:en`]);
  await signedIn.close();
});

test('a guest is asked to sign in, and a failed translation is asked for again only on a tap', async ({
  page,
}) => {
  const { api, asked } = await kitchen(page, { signedIn: false });
  await page.goto(`/recipes/${soup.id}`);
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await expect(page.getByText('Sign in to translate this recipe.', { exact: true })).toBeVisible();
  await expect(heading(page, 'Soupe à l’oignon')).toBeVisible();

  // The model's answer was unusable: one request, then the cook decides.
  api.state.session = true;
  let failing = true;
  api.on('GET', /^\/recipes\/[^/]+\/translation$/, () =>
    failing ? failure(502, 'We couldn’t translate this recipe. Please try again.') : undefined,
  );
  const before = asked.length;
  const tries = () => api.requests.filter((r) => r.path.endsWith('/translation')).length;
  const sent = tries();
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await expect(
    page.getByText('We couldn’t translate this recipe. Please try again.', { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  expect(tries() - sent).toBe(1);
  failing = false;
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await expect(heading(page, 'French onion soup')).toBeVisible();
  expect(asked.length).toBe(before + 1);
});

test('a translation kept on the device reads offline, in the same language', async ({ page }) => {
  const { api } = await kitchen(page);
  await page.goto(`/recipes/${soup.id}`);
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await expect(heading(page, 'French onion soup')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('savorly.offline.translations') ?? ''))
    .toContain('French onion soup');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('savorly.offline.snapshot') ?? ''))
    .toContain('Soupe à l’oignon');

  // No connection: the app opens from what the device kept, and the recipe's translation with it.
  api.state.online = false;
  await page.goto(`/recipes/${soup.id}`);
  await expect(heading(page, 'Soupe à l’oignon')).toBeVisible();
  await page.getByRole('button', { name: 'Translate to English', exact: true }).click();
  await expect(heading(page, 'French onion soup')).toBeVisible();
  await expect(page.getByText('Translated from French by AI', { exact: true })).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the bar fits a phone and the translation reads in the app’s language', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { get: () => ['de-DE'] });
    });
    const { api, asked } = await kitchen(page);
    api.on('GET', /^\/recipes\/[^/]+\/translation$/, ({ query }) =>
      query.get('language') === 'de'
        ? json({ ...english, language: 'de', title: 'Französische Zwiebelsuppe' })
        : undefined,
    );
    await page.goto(`/recipes/${soup.id}`);
    await expect(page.getByText('Auf Französisch geschrieben', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Ins Deutsche übersetzen', exact: true }).click();
    await expect(heading(page, 'Französische Zwiebelsuppe')).toBeVisible();
    await expect(
      page.getByText('Von KI aus dem Französischen übersetzt', { exact: true }),
    ).toBeVisible();
    expect(asked).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/recipe-translated-phone-de.png' });
  });
});
