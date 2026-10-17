import { expect, Page, test } from '@playwright/test';
import type { Creator, Recipe } from '../src/lib/types';

const creator = (id: string, name: string, recipes: number, followers: number): Creator => ({
  id,
  name,
  handle: id,
  bio: '',
  avatar: '',
  recipeCount: recipes,
  followerCount: followers,
});
const me = creator('me', 'Alex', 1, 0);
const mine: Recipe = {
  id: 'my-soup',
  title: 'Soup',
  description: '',
  cuisine: 'French',
  minutes: 30,
  servings: 4,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [],
  steps: [],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: true,
  author: me,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
};

async function kitchen(page: Page, creators: Creator[], signedIn = false) {
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/me')
      return signedIn
        ? reply({
            ...me,
            email: 'alex@example.test',
            preferences: { diets: [], allergies: [] },
            identities: [],
            hasPassword: true,
            plan: 'free',
            onboarded: true,
          })
        : reply({ error: 'Sign in to your kitchen to continue.' }, 401);
    if (path === '/capabilities') return reply({});
    if (path === '/creators') return reply(creators);
    if (path === '/library')
      return reply({
        savedIds: ['a', 'b'],
        saves: [],
        collections: [],
        followingIds: ['anna', 'boris', 'vera'],
        recipes: [mine],
      });
    if (path === '/kitchen') return reply({ plans: [], groceries: [], pantry: [] });
    return reply([]);
  });
}

test.describe('Russian', () => {
  test.use({ locale: 'ru-RU' });
  test('counts take the form their number needs', async ({ page }) => {
    await kitchen(page, [
      creator('anna', 'Анна', 1, 21),
      creator('boris', 'Борис', 3, 2),
      creator('vera', 'Вера', 5, 11),
    ]);
    await page.goto('/?page=community');
    await expect(page.getByText('1 рецепт · 21 подписчик', { exact: true })).toBeVisible();
    await expect(page.getByText('3 рецепта · 2 подписчика', { exact: true })).toBeVisible();
    await expect(page.getByText('5 рецептов · 11 подписчиков', { exact: true })).toBeVisible();
  });
});

test.describe('French', () => {
  test.use({ locale: 'fr-FR' });
  test('profile stats agree with their numbers and with what they count', async ({ page }) => {
    await kitchen(page, [me], true);
    await page.goto('/?page=profile');
    // One shared recipe, two saved recipes, three kitchens followed.
    await expect(page.getByText('Partagée', { exact: true })).toBeVisible();
    await expect(page.getByText('Enregistrées', { exact: true })).toBeVisible();
    await expect(page.getByText('Abonnements', { exact: true })).toBeVisible();
  });
});
