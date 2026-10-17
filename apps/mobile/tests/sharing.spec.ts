import { expect, Page, test } from '@playwright/test';
import type { Creator, Recipe } from '../src/lib/types';

const author: Creator = {
  id: 'author',
  name: 'Robin',
  handle: 'robin',
  bio: '',
  avatar: '',
  recipeCount: 1,
  followerCount: 0,
};
const recipe = (minutes: number): Recipe => ({
  id: 'lemon-ricotta-pasta',
  title: 'Lemon pasta',
  description: 'A bright and simple pasta.',
  cuisine: 'Italian',
  minutes,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Pasta', amount: 200, unit: 'g', category: 'Pantry' }],
  steps: [{ title: 'Cook', text: 'Boil the pasta until tender.', seconds: 0 }],
  tags: [],
  calories: 300,
  aiGenerated: false,
  published: true,
  author,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
});

async function kitchen(page: Page, minutes: number) {
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === '/me')
      return reply({
        ...author,
        id: 'me',
        name: 'Alex',
        email: 'alex@example.test',
        preferences: { diets: [], allergies: [] },
        identities: [],
        hasPassword: true,
        plan: 'free',
        onboarded: true,
      });
    if (path === '/capabilities') return reply({});
    if (path === '/library')
      return reply({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return reply({ plans: [], groceries: [], pantry: [] });
    if (path === '/recipes') return reply([recipe(minutes)]);
    if (path === '/creators') return reply([author]);
    if (path === '/recipes/lemon-ricotta-pasta') return reply(recipe(minutes));
    return reply(path.endsWith('/save') ? {} : []);
  });
  // A share sheet the cook closes without sharing, as the browser reports it; and a record of any
  // text about it that reaches the page.
  await page.addInitScript(() => {
    const shared: ShareData[] = [];
    const noticed: string[] = [];
    Object.assign(window, { shared, noticed });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        return Promise.reject(new DOMException('Share canceled', 'AbortError'));
      },
    });
    new MutationObserver((changes) => {
      for (const change of changes)
        for (const node of change.addedNodes)
          if (/cancel|abort/i.test(node.textContent || '')) noticed.push(node.textContent || '');
    }).observe(document, { childList: true, subtree: true });
  });
}

const shared = (page: Page) =>
  page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared);

test('closing the share sheet without sharing shows no message', async ({ page }) => {
  await kitchen(page, 15);
  await page.goto('/');
  await page.getByRole('link', { name: 'Let’s get cooking: Lemon pasta', exact: true }).click();
  await page.getByRole('button', { name: 'Share recipe', exact: true }).click();
  await expect.poll(async () => (await shared(page)).length).toBe(1);
  const origin = new URL(page.url()).origin;
  expect((await shared(page))[0].text).toBe(
    `Lemon pasta — 15 minutes. ${origin}/recipes/lemon-ricotta-pasta`,
  );
  // The next message is the next action's: nothing about the share came before it.
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByText('Saved to your cookbook', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { noticed: string[] }).noticed)).toEqual(
    [],
  );
});

test.describe('Russian', () => {
  test.use({ locale: 'ru-RU' });
  test('the shared text is in the cook’s language, with the right plural', async ({ page }) => {
    await kitchen(page, 21);
    await page.goto('/');
    await page.getByRole('link', { name: 'Начнём готовить: Lemon pasta', exact: true }).click();
    await page.getByRole('button', { name: 'Поделиться рецептом', exact: true }).click();
    await expect.poll(async () => (await shared(page)).length).toBe(1);
    expect((await shared(page))[0].text).toMatch(/^Lemon pasta — 21 минута\. http/);
  });
});
