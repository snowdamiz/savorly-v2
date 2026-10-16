import { expect, Page, test } from '@playwright/test';
import { Creator, Kitchen, Library, Recipe } from '../src/lib/types';
import { observeRenders, renderCounts, resetRenderCounts } from './renderCounts';

const creator: Creator = {
  id: 'author',
  name: 'Robin',
  handle: 'robin',
  bio: '',
  avatar: '',
  followerCount: 0,
  recipeCount: 1,
};
const recipe: Recipe = {
  id: 'lemon-ricotta-pasta',
  title: 'Lemon pasta',
  description: 'A bright and simple pasta.',
  cuisine: 'Italian',
  minutes: 15,
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
  author: creator,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
};

async function kitchen(page: Page, recipeCount = 1) {
  const recipes = Array.from({ length: recipeCount }, (_, i) =>
    i === 0
      ? recipe
      : {
          ...recipe,
          id: `pasta-${i + 1}`,
          title: `Pasta ${i + 1}`,
        },
  );
  const requests: string[] = [];
  const library: Library = {
    savedIds: [],
    saves: [],
    followingIds: [],
    collections: [],
    recipes: [],
  };
  const kitchen: Kitchen = { plans: [], groceries: [], pantry: [] };
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    requests.push(`${method} ${path}${url.search}`);
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/me')
      return reply({
        ...creator,
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
    if (path === '/library') return reply(library);
    if (path === '/kitchen') return reply(kitchen);
    if (path === '/recipes') return reply(recipes);
    if (path === '/creators')
      return reply([{ ...creator, followerCount: library.followingIds.length }]);
    if (path === '/recipes/lemon-ricotta-pasta') return reply(recipe);
    if (path.endsWith('/reviews')) return reply([]);
    if (path.endsWith('/save')) {
      library.savedIds = method === 'PUT' ? [recipe.id] : [];
      library.recipes = method === 'PUT' ? [recipe] : [];
      library.saves = method === 'PUT' ? [{ recipeId: recipe.id, collectionId: null }] : [];
      return reply({});
    }
    if (path.endsWith('/follow')) {
      library.followingIds = method === 'PUT' ? [creator.id] : [];
      return reply({});
    }
    if (path.endsWith('/groceries') && method === 'POST') {
      kitchen.groceries.push({
        id: 'g1',
        name: 'Pasta',
        quantity: '200 g',
        category: 'Pantry',
        checked: false,
      });
      return reply({ added: 1 });
    }
    if (path === '/groceries/g1' && method === 'PATCH') {
      kitchen.groceries[0].checked = route.request().postDataJSON().checked;
      return reply({});
    }
    return reply([]);
  });
  await page.goto('/');
  await expect(page.getByText(/Good (morning|afternoon|evening), Alex/)).toBeVisible();
  await expect.poll(() => requests.includes('GET /kitchen')).toBe(true);
  // Let the 200ms search debounce expire, so hidden requests cannot escape the assertion.
  await page.waitForTimeout(400);
  return requests;
}

test('home fetches only the displayed feed; search and Explore still fetch results', async ({
  page,
}) => {
  const requests = await kitchen(page);
  expect(requests.filter((r) => r.startsWith('GET /recipes'))).toEqual(['GET /recipes']);
  requests.length = 0;
  await page.getByRole('textbox', { name: 'Search recipes', exact: true }).fill('lemon');
  await expect(page.getByRole('button', { name: 'View Lemon pasta', exact: true })).toBeVisible();
  expect(requests.filter((r) => r.startsWith('GET /recipes?'))).toHaveLength(1);
  expect(requests.find((r) => r.startsWith('GET /recipes?'))).toContain('q=lemon');
  requests.length = 0;
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Let’s get cooking', exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  expect(requests.filter((r) => r.startsWith('GET /recipes'))).toEqual([]);
  await page.getByRole('button', { name: 'Explore recipes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Lemon pasta', exact: true })).toBeVisible();
  expect(requests.filter((r) => r.startsWith('GET /recipes?'))).toHaveLength(1);
});

async function recipeGrid(page: Page) {
  await observeRenders(page);
  await kitchen(page, 24);
  await page.getByRole('button', { name: 'Explore recipes', exact: true }).click();
  await expect(page.getByRole('button', { name: /^View (Lemon pasta|Pasta \d+)$/ })).toHaveCount(
    24,
  );
  // Let layout and entry animations settle before measuring a user interaction.
  await page.waitForTimeout(1500);
  const initial = await renderCounts(page);
  // Positive controls: the probe must have observed the actual app, not silently reported zero.
  expect(initial.Shell).toBeGreaterThan(0);
  expect(initial.Discover).toBeGreaterThan(0);
  expect(initial.RecipeTile).toBeGreaterThanOrEqual(24);
  await resetRenderCounts(page);
}

test('saving a recipe does not rerender unchanged grid cards', async ({ page }) => {
  await recipeGrid(page);
  await page.getByRole('button', { name: 'Save Lemon pasta', exact: true }).click();
  await expect(page.getByText('Saved to your cookbook', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unsave Lemon pasta', exact: true })).toBeVisible();
  const renders = await renderCounts(page);
  console.log('Renders while saving in a 24-card grid:', renders);
  expect(renders.Save).toBeGreaterThan(0);
  expect.soft(renders.RecipeTile || 0).toBe(0);
  expect.soft(renders.RecipeGrid || 0).toBe(0);
  // Memoization must preserve the correct click handler and recipe.
  await page.getByRole('button', { name: 'View Pasta 2', exact: true }).click();
  await expect(page.getByText('Let’s make it', { exact: true })).toBeVisible();
  await expect(page.getByText('Pasta 2', { exact: true }).last()).toBeVisible();
});

test('toast expiry does not rerender the screen or its recipe cards', async ({ page }) => {
  await recipeGrid(page);
  await page.getByRole('button', { name: 'Save Lemon pasta', exact: true }).click();
  await expect(page.getByText('Saved to your cookbook', { exact: true })).toBeVisible();
  await resetRenderCounts(page);
  await expect(page.getByText('Saved to your cookbook', { exact: true })).toHaveCount(0, {
    timeout: 7000,
  });
  const renders = await renderCounts(page);
  console.log('Renders while a toast expires:', renders);
  expect(renders.Toast).toBeGreaterThan(0);
  for (const name of ['Shell', 'Discover', 'RecipeGrid', 'RecipeTile', 'Save']) {
    expect.soft(renders[name] || 0, `${name} rerenders on toast expiry`).toBe(0);
  }
});

test('save and unsave refresh only the library and update the cookbook', async ({ page }) => {
  const requests = await kitchen(page);
  requests.length = 0;
  await page.getByRole('button', { name: 'Save Lemon pasta', exact: true }).click();
  await expect(page.getByText('Saved to your cookbook', { exact: true })).toBeVisible();
  expect(requests).toEqual(['PUT /recipes/lemon-ricotta-pasta/save', 'GET /library']);
  await page.getByRole('button', { name: 'My cookbooks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Lemon pasta', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unsave Lemon pasta', exact: true })).toBeVisible();
  requests.length = 0;
  await page.getByRole('button', { name: 'Unsave Lemon pasta', exact: true }).click();
  await expect(page.getByText('Removed from your cookbook', { exact: true })).toBeVisible();
  expect(requests).toEqual(['DELETE /recipes/lemon-ricotta-pasta/save', 'GET /library']);
  await expect(page.getByText('Nothing saved here yet', { exact: true })).toBeVisible();
});

test('follow refreshes the library and creator counts without downloading recipes or kitchen', async ({
  page,
}) => {
  const requests = await kitchen(page);
  requests.length = 0;
  await page.getByRole('button', { name: 'Follow Robin', exact: true }).click();
  await expect(
    page.getByText('Following. Their recipes will show up for you.', { exact: true }),
  ).toBeVisible();
  expect(requests).toEqual(['PUT /creators/author/follow', 'GET /library', 'GET /creators']);
  await expect(page.getByRole('button', { name: 'Unfollow Robin', exact: true })).toBeVisible();
  requests.length = 0;
  await page.getByRole('button', { name: 'Unfollow Robin', exact: true }).click();
  await expect(page.getByText('You’ve unfollowed this kitchen.', { exact: true })).toBeVisible();
  expect(requests).toEqual(['DELETE /creators/author/follow', 'GET /library', 'GET /creators']);
  await expect(page.getByRole('button', { name: 'Follow Robin', exact: true })).toBeVisible();
});

test('a failed save rolls back without refreshing unrelated data', async ({ page }) => {
  const requests = await kitchen(page);
  await page.route('**/v1/recipes/lemon-ricotta-pasta/save', (route) => {
    requests.push(`${route.request().method()} /recipes/lemon-ricotta-pasta/save`);
    return route.fulfill({ status: 500, json: { error: 'Unable to save' } });
  });
  requests.length = 0;
  await page.getByRole('button', { name: 'Save Lemon pasta', exact: true }).click();
  await expect(page.getByText('Unable to save', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Lemon pasta', exact: true })).toBeVisible();
  expect(requests).toEqual(['PUT /recipes/lemon-ricotta-pasta/save']);
});

test('adding groceries and checking an item refresh only kitchen data', async ({ page }) => {
  const requests = await kitchen(page);
  await page.getByRole('button', { name: 'Let’s get cooking', exact: true }).click();
  await expect(page.getByText('Let’s make it', { exact: true })).toBeVisible();
  requests.length = 0;
  await page.getByRole('button', { name: 'Add to grocery list', exact: true }).click();
  await expect(
    page.getByText('Ingredients added to your grocery list.', { exact: true }),
  ).toBeVisible();
  expect(requests).toEqual(['POST /recipes/lemon-ricotta-pasta/groceries', 'GET /kitchen']);
  await page.getByRole('button', { name: 'Meal planner', exact: true }).click();
  await page.getByRole('tab', { name: /Groceries/ }).click();
  await expect(page.getByText('200 g', { exact: true })).toBeVisible();
  requests.length = 0;
  await page.getByRole('checkbox').click();
  await expect(page.getByText('1 of 1 in the basket', { exact: true })).toBeVisible();
  expect(requests).toEqual(['PATCH /groceries/g1', 'GET /kitchen']);
});
