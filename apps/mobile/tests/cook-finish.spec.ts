import { expect, test } from '@playwright/test';

const cook = { id: 'me', name: 'Alex', handle: 'alex', bio: '', avatar: '' };
const toast = {
  id: 'lemon-toast',
  title: 'Lemon toast',
  description: 'Bright and golden lemon toast.',
  cuisine: 'Italian',
  minutes: 10,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Bread', amount: 2, unit: 'slices', category: 'Bakery' }],
  steps: [{ title: 'Toast', text: 'Toast the bread until golden.', seconds: 0 }],
  tags: [],
  calories: 120,
  aiGenerated: false,
  published: true,
  author: { ...cook, id: 'robin', name: 'Robin', handle: 'robin' },
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
};

test('finishing cooking mode offers “I cooked this”, which opens its sheet', async ({ page }) => {
  const user = {
    ...cook,
    email: 'alex@example.test',
    preferences: { diets: [], allergies: [] },
    identities: [],
    hasPassword: true,
    plan: 'free',
    onboarded: true,
  };
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/v1/, '');
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/me') return json(user);
    if (path === '/session') return json({ user });
    if (path === '/capabilities') return json({});
    if (path === '/recipes') return json([toast]);
    if (path === '/feed')
      return json({ hero: toast, trending: [], quick: [], following: [], newest: [] });
    if (path === '/library')
      return json({
        savedIds: [],
        saves: [],
        collections: [],
        followingIds: [],
        recipes: [],
        cookedIds: [],
      });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === `/recipes/${toast.id}`) return json(toast);
    return json([]);
  });
  await page.goto(`/?recipe=${toast.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Finish cooking', exact: true }).click();
  const served = page.getByText('Dinner is served.', { exact: true });
  await expect(served).toBeVisible();
  // The finish screen's own button, not the one on the recipe page underneath.
  await served.locator('..').getByRole('button', { name: 'I cooked this', exact: true }).click();
  await expect(served).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark as cooked', exact: true })).toBeVisible();
});
