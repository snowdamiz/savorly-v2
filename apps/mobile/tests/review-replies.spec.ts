import { expect, Page, test } from '@playwright/test';
import type { Recipe, Review } from '../src/lib/types';

const me = { id: 'me', name: 'Alex', handle: 'alex', bio: '', avatar: '' };
const sam = { id: 'sam', name: 'Sam', handle: 'sam', bio: '', avatar: '' };
const soup: Recipe = {
  id: 'tomato-soup',
  title: 'Tomato soup',
  description: 'A bright soup for cold evenings.',
  cuisine: 'Italian',
  minutes: 30,
  servings: 4,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Tomatoes', amount: 6, unit: '', category: 'Produce' }],
  steps: [{ title: 'Simmer', text: 'Simmer the tomatoes until soft.', seconds: 0 }],
  tags: [],
  calories: 200,
  aiGenerated: false,
  published: true,
  author: me,
  rating: 4,
  reviewCount: 1,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
};
const review = (reply: Review['reply'] = null): Review => ({
  id: 'v2',
  rating: 4,
  body: 'Lovely, but a little sweet.',
  createdAt: '2026-10-10T12:00:00Z',
  updatedAt: '2026-10-10T12:00:00Z',
  author: sam,
  reply,
});

// One recipe page, by whoever `viewer` is; replies sent change what the reviews read next.
async function page$(page: Page, viewer: typeof me, start: Review) {
  let current = start;
  const sent: { method: string; path: string; body: unknown }[] = [];
  const user = {
    ...viewer,
    email: `${viewer.handle}@example.test`,
    preferences: { diets: [], allergies: [] },
    identities: [],
    hasPassword: true,
    plan: 'free',
    onboarded: true,
  };
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/v1/, '');
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (method !== 'GET')
      sent.push({ method, path, body: request.postData() ? request.postDataJSON() : null });
    if (path === '/me') return json(user);
    if (path === '/session') return json({ user });
    if (path === '/capabilities') return json({});
    if (path === '/recipes') return json([soup]);
    if (path === '/feed')
      return json({ hero: soup, trending: [], quick: [], following: [], newest: [] });
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === `/recipes/${soup.id}`) return json(soup);
    if (path === `/recipes/${soup.id}/reviews`) return json([current]);
    if (path === `/recipes/${soup.id}/reviews/v2/reply` && method === 'PUT') {
      const reply = { body: request.postDataJSON().body, repliedAt: new Date().toISOString() };
      current = review(reply);
      return json({ reply });
    }
    if (path === `/recipes/${soup.id}/reviews/v2/reply` && method === 'DELETE') {
      current = review(null);
      return route.fulfill({ status: 204, body: '' });
    }
    return json([]);
  });
  await page.goto(`/?recipe=${soup.id}`);
  await expect(page.getByText('Lovely, but a little sweet.', { exact: true })).toBeVisible();
  return sent;
}

test('a recipe’s author answers a review, changes the answer, and removes it', async ({ page }) => {
  const sent = await page$(page, me, review());
  await page.getByRole('button', { name: 'Reply to Sam', exact: true }).click();
  await page.getByLabel('Reply to Sam', { exact: true }).fill('Thank you! Try less sugar.');
  await page.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(page.getByText('Reply from Alex', { exact: true })).toBeVisible();
  await expect(page.getByText('Thank you! Try less sugar.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit reply', exact: true }).click();
  await page.getByLabel('Reply to Sam', { exact: true }).fill('Thank you! Try 50 g less sugar.');
  await page.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(page.getByText('Thank you! Try 50 g less sugar.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove reply', exact: true }).click();
  await expect(page.getByText('Reply from Alex', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reply to Sam', exact: true })).toBeVisible();
  expect(sent.filter((s) => s.path.endsWith('/reply')).map((s) => [s.method, s.body])).toEqual([
    ['PUT', { body: 'Thank you! Try less sugar.' }],
    ['PUT', { body: 'Thank you! Try 50 g less sugar.' }],
    ['DELETE', null],
  ]);
});

test('other cooks read the answer but can’t reply', async ({ page }) => {
  const answered = review({ body: 'Thanks, Sam!', repliedAt: '2026-10-11T12:00:00Z' });
  await page$(page, { ...me, id: 'guest-cook', name: 'Jo', handle: 'jo' }, answered);
  await expect(page.getByText('Reply from Alex', { exact: true })).toBeVisible();
  await expect(page.getByText('Thanks, Sam!', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reply to Sam', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit reply', exact: true })).toHaveCount(0);
});
