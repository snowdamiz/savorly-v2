import { test, expect } from '@playwright/test';
import type { Recipe } from '../src/lib/types';

// The address helpers (sized, blurred) have unit tests in src/lib/__tests__/images.test.ts.

test('a recipe page describes its photo and loads it first', async ({ page }) => {
  const cook = { id: 'cook', name: 'Alex', handle: 'alex', avatar: '', bio: '' };
  const recipe: Recipe = {
    id: 'toast',
    title: 'Lemon toast',
    description: 'Bright and golden lemon toast for a quick lunch.',
    cuisine: 'Italian',
    minutes: 10,
    servings: 2,
    difficulty: 'Easy',
    image: 'https://media.test/cover.png',
    video: '',
    ingredients: [{ name: 'Bread', amount: 2, unit: 'slices', category: 'Bakery' }],
    steps: [{ title: 'Toast', text: 'Toast the bread until golden.', seconds: 0 }],
    tags: [],
    calories: 120,
    aiGenerated: false,
    published: true,
    author: cook,
    rating: 0,
    reviewCount: 0,
    saveCount: 0,
    createdAt: new Date().toISOString(),
  };
  await page.route('https://media.test/**', (route) =>
    route.fulfill({ path: 'tests/fixtures/sample.png', contentType: 'image/png' }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return json({ error: 'Sign in' }, 401);
    if (path === '/capabilities') return json({});
    if (path === '/recipes') return json([recipe]);
    if (path === `/recipes/${recipe.id}`) return json(recipe);
    return json([]);
  });
  await page.goto(`/?recipe=${recipe.id}`);
  const hero = page.locator('img[alt="Lemon toast"]');
  await expect(hero).toHaveAttribute('src', 'https://media.test/cover.png');
  await expect(hero).toHaveAttribute('fetchpriority', 'high');
  await expect(hero).toHaveAttribute('loading', 'eager');
});

test('a photo shows a blurred preview from its host until it arrives', async ({ page }) => {
  const photo = 'https://images.unsplash.com/photo-preview-test';
  const recipe = {
    id: 'soup',
    title: 'Tomato soup',
    description: 'Warm and bright.',
    cuisine: 'Italian',
    minutes: 30,
    servings: 2,
    difficulty: 'Easy',
    image: photo,
    video: '',
    ingredients: [{ name: 'Tomatoes', amount: 4, unit: '', category: 'Produce' }],
    steps: [{ title: 'Simmer', text: 'Simmer until soft.', seconds: 0 }],
    tags: [],
    calories: 0,
    aiGenerated: false,
    published: true,
    author: { id: 'cook', name: 'Alex', handle: 'alex', avatar: '', bio: '' },
    rating: 0,
    reviewCount: 0,
    saveCount: 0,
    createdAt: '2026-10-01T12:00:00Z',
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dWQAAAAASUVORK5CYII=',
    'base64',
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const asked: string[] = [];
  await page.route('https://images.unsplash.com/**', async (route) => {
    const url = route.request().url();
    asked.push(url);
    // The full photo takes its time; the preview is there at once.
    if (!url.includes('blur=')) await held;
    await route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    if (path === '/session') return route.fulfill({ json: { user: null } });
    if (path === '/capabilities') return route.fulfill({ json: {} });
    if (path === '/recipes/soup') return route.fulfill({ json: recipe });
    if (path === '/feed') return route.fulfill({ status: 404, json: { error: 'Not found' } });
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto('/recipes/soup');
    await expect(page.getByRole('button', { name: 'Start cooking', exact: true })).toBeVisible();
    await expect.poll(() => asked.some((url) => url.includes('blur=200'))).toBe(true);
    await expect(page.locator('img[src*="blur=200"]').first()).toBeAttached();
  } finally {
    release();
  }
  // Then the photo itself.
  await expect(page.locator('img[src*="photo-preview-test?w="]').first()).toBeAttached();
});
