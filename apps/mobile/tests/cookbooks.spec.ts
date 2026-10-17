import { expect, Page, test } from '@playwright/test';
import type { Creator, Library, Recipe } from '../src/lib/types';

const robin: Creator = {
  id: 'robin',
  name: 'Robin',
  handle: 'robin',
  bio: '',
  avatar: '',
  recipeCount: 30,
  followerCount: 0,
};
const recipe = (n: number): Recipe => ({
  id: `r${n}`,
  title: `Recipe ${n}`,
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
// Thirty saved recipes, newest first; the first one is also in the cookbook "Slow Sundays".
const saved = Array.from({ length: 30 }, (_, i) => recipe(i + 1));

/**
 * A signed-in kitchen. /library holds only the newest three recipes (as the app's bounded store
 * asks for); /library/recipes pages through the rest.
 */
async function kitchen(page: Page) {
  const requests: string[] = [];
  const patches: unknown[] = [];
  const library: Library = {
    savedIds: saved.map((r) => r.id),
    saves: saved.map((r, i) => ({ recipeId: r.id, collectionId: i === 0 ? 'c1' : null })),
    collections: [{ id: 'c1', name: 'Slow Sundays', public: false, description: '' }],
    followingIds: [],
    recipes: saved.slice(0, 3),
  };
  await page.addInitScript(() => {
    const shared: ShareData[] = [];
    Object.assign(window, { shared });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        return Promise.resolve();
      },
    });
  });
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    requests.push(`${method} ${path}${url.search}`);
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/me' || path === '/session') {
      const user = {
        id: 'me',
        name: 'Alex',
        handle: 'alex',
        bio: '',
        avatar: '',
        email: 'alex@example.test',
        preferences: { diets: [], allergies: [] },
        identities: [],
        hasPassword: true,
        plan: 'free',
        onboarded: true,
      };
      return reply(path === '/session' ? { user } : user);
    }
    if (path === '/capabilities') return reply({});
    if (path === '/creators') return reply([robin]);
    if (path === '/library') return reply(structuredClone(library));
    if (path === '/library/recipes') {
      const collection = url.searchParams.get('collection');
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const shelf = saved.filter((r) =>
        library.saves.some(
          (v) => v.recipeId === r.id && (!collection || v.collectionId === collection),
        ),
      );
      return reply({
        recipes: shelf.slice(offset, offset + limit),
        hasMore: shelf.length > offset + limit,
      });
    }
    if (path.endsWith('/save') && method === 'DELETE') {
      const id = path.split('/')[2];
      library.savedIds = library.savedIds.filter((v) => v !== id);
      library.saves = library.saves.filter((v) => v.recipeId !== id);
      return route.fulfill({ status: 204 });
    }
    if (path === '/collections/c1' && method === 'PATCH') {
      const body = route.request().postDataJSON();
      patches.push(body);
      Object.assign(library.collections[0], body);
      return reply(library.collections[0]);
    }
    if (path === '/kitchen') return reply({ plans: [], groceries: [], pantry: [] });
    return reply([]);
  });
  return { requests, patches };
}

const cards = (page: Page) => page.getByRole('link', { name: /^View Recipe \d+$/ });

test('Saved shows a page of the library at a time, and the store says what is saved', async ({
  page,
}) => {
  const { requests } = await kitchen(page);
  await page.goto('/?page=saved');
  await expect(cards(page)).toHaveCount(24);
  expect(requests).toContain('GET /library/recipes?scope=saved&offset=0&limit=24');
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(cards(page)).toHaveCount(30);
  expect(requests).toContain('GET /library/recipes?scope=saved&offset=24&limit=24');
  await expect(page.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);

  // An unsave hides the recipe at once; no page is fetched again.
  requests.length = 0;
  await page.getByRole('button', { name: 'Unsave Recipe 30', exact: true }).click();
  await expect(page.getByText('Removed from your cookbook', { exact: true })).toBeVisible();
  await expect(cards(page)).toHaveCount(29);
  expect(requests.filter((r) => r.startsWith('GET /library/recipes'))).toEqual([]);

  // Each cookbook pages on its own.
  await page.getByRole('button', { name: 'Slow Sundays', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  expect(requests).toContain('GET /library/recipes?scope=saved&collection=c1&offset=0&limit=24');
  await page.getByRole('button', { name: 'My recipes', exact: true }).click();
  await expect(page.getByText('Every recipe has a story', { exact: true })).toBeVisible();
  expect(requests).toContain('GET /library/recipes?scope=mine&offset=0&limit=24');
});

test('a cookbook is renamed, described and made public, then shared by its link', async ({
  page,
}) => {
  const { patches } = await kitchen(page);
  await page.goto('/?page=saved');
  await page.getByRole('button', { name: 'Slow Sundays', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Share cookbook', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit cookbook', exact: true }).click();
  await page.getByRole('textbox', { name: 'Cookbook name', exact: true }).fill('Sunday suppers');
  await page
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Long braises and slow roasts.');
  await expect(page.getByText('29/300', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Anyone with the link can see this cookbook and the published recipes in it.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('switch', { name: 'Public cookbook', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByText('Your cookbook is public. Anyone with the link can open it.', { exact: true }),
  ).toBeVisible();
  expect(patches).toEqual([
    { name: 'Sunday suppers', description: 'Long braises and slow roasts.', public: true },
  ]);
  // The sheet closes, and the cookbook's heading shows what was saved.
  await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveCount(0);
  await expect(page.getByText('Long braises and slow roasts.', { exact: true })).toBeVisible();
  await expect(page.getByText('Public', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Share cookbook', exact: true }).click();
  const origin = new URL(page.url()).origin;
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared.map((d) => d.text)),
    )
    .toEqual([`Sunday suppers, a cookbook on Savorly: ${origin}/cookbooks/c1`]);

  // The words beside the switch flip it too; only what changed is sent.
  await page.getByRole('button', { name: 'Edit cookbook', exact: true }).click();
  const publicSwitch = page.getByRole('switch', { name: 'Public cookbook', exact: true });
  await expect(publicSwitch).toBeChecked();
  await page
    .getByText('Anyone with the link can see this cookbook and the published recipes in it.', {
      exact: true,
    })
    .click();
  await expect(publicSwitch).not.toBeChecked();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Cookbook updated.', { exact: true })).toBeVisible();
  expect(patches[1]).toEqual({ public: false });
  await expect(page.getByRole('button', { name: 'Share cookbook', exact: true })).toHaveCount(0);
});
