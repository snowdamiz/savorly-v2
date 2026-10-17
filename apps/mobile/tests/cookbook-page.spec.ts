import { expect, Page, test } from '@playwright/test';
import type { Creator, CookbookSummary, PublicCookbook, Recipe } from '../src/lib/types';

// Needs App.tsx to open /cookbooks/<id> as the CookbookPage (with onCreator wired to the cook's
// profile), and to pass CreatorDialog an onCookbook that opens the page.

const robin: Creator = {
  id: 'robin',
  name: 'Robin',
  handle: 'robin',
  bio: 'Slow food, fast weeknights.',
  avatar: '',
  recipeCount: 2,
  followerCount: 0,
};
const recipe = (id: string, title: string): Recipe => ({
  id,
  title,
  description: '',
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [],
  steps: [],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: true,
  author: robin,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
});
const pasta = recipe('pasta', 'Lemon pasta');
const ragu = recipe('ragu', 'Sunday ragù');
const sundays: PublicCookbook = {
  id: 'c1',
  name: 'Sunday suppers',
  description: 'Long braises and slow roasts.',
  public: true,
  owner: robin,
  recipes: [pasta, ragu],
};
const listed: CookbookSummary[] = [
  {
    id: 'c1',
    name: 'Sunday suppers',
    description: 'Long braises and slow roasts.',
    recipeCount: 2,
    cover: '',
  },
];

/** A visitor who isn't signed in: cookbook pages are public. */
async function visitor(page: Page) {
  const requests: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    requests.push(`${route.request().method()} ${path}`);
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/me') return reply({ error: 'Sign in to your kitchen to continue.' }, 401);
    if (path === '/session') return reply({ user: null });
    if (path === '/capabilities') return reply({});
    if (path === '/recipes') return reply([pasta, ragu]);
    if (path === '/creators') return reply([robin]);
    if (path === '/creators/robin/cookbooks') return reply(listed);
    if (path === '/cookbooks/c1') return reply(sundays);
    if (path.startsWith('/cookbooks/'))
      return reply({ error: 'Cookbook not found.', requestId: 'x' }, 404);
    return reply([]);
  });
  return requests;
}

test('a public cookbook’s page shows its cook, description and recipes', async ({ page }) => {
  await visitor(page);
  await page.goto('/cookbooks/c1');
  await expect(page.getByText('Sunday suppers', { exact: true })).toBeVisible();
  await expect(page.getByText('Long braises and slow roasts.', { exact: true })).toBeVisible();
  await expect(page.getByText('by Robin', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Lemon pasta', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Sunday ragù', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Sunday suppers · Savorly');
  // The cook is a way into their kitchen.
  await page.getByRole('button', { name: 'Visit Robin’s kitchen', exact: true }).click();
  await expect(page.getByText('Slow food, fast weeknights.', { exact: true })).toBeVisible();
});

test('a cookbook that is private or gone says so', async ({ page }) => {
  await visitor(page);
  await page.goto('/cookbooks/nope');
  await expect(page.getByText('This cookbook isn’t available', { exact: true })).toBeVisible();
  await expect(
    page.getByText('It may be private now, or the link may be incomplete.', { exact: true }),
  ).toBeVisible();
});

test('a cook’s profile lists their public cookbooks, and one opens its page', async ({ page }) => {
  const requests = await visitor(page);
  await page.goto('/?page=community');
  await page.getByRole('button', { name: 'Visit Robin’s kitchen', exact: true }).click();
  await expect(page.getByText('Cookbooks', { exact: true })).toBeVisible();
  expect(requests).toContain('GET /creators/robin/cookbooks');
  const open = page.getByRole('button', { name: 'Open the cookbook Sunday suppers', exact: true });
  await open.click();
  // The profile sheet gives way to the cookbook's page.
  await expect(open).toHaveCount(0);
  await expect(page.getByText('Long braises and slow roasts.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Sunday ragù', exact: true })).toBeVisible();
});
