import { expect, Page, test } from '@playwright/test';
import type { Creator } from '../src/lib/types';
import type { CookAlong } from '../src/lib/feed';
import { json, mockApi, recipe, recipeCard, robin } from './mockApi';

// The weekly cook-along and founding creators (docs/CREATOR-FUND.md): a section on Home from
// GET /feed's cookAlong saying how many people are cooking it this week, the "Founding creator"
// mark on profiles and author lines, and the cook-along's own notification switch. The API is
// mocked.

const maya: Creator = {
  id: 'maya',
  name: 'Maya',
  handle: 'maya',
  bio: 'Weeknight cook.',
  avatar: '',
  recipeCount: 1,
  followerCount: 3,
  founding: true,
};
const shakshuka = recipe({ id: 'shakshuka', title: 'Shakshuka', author: maya });
const roast = recipe({ id: 'sunday-roast', title: 'Sunday roast' });

/** Home over a mocked API whose feed has the cook-along `week()` answers when it's asked. */
async function home(page: Page, week: () => Partial<CookAlong> | null) {
  const api = await mockApi(page, { recipes: [shakshuka, roast], creators: [maya, robin] });
  api.on('GET', '/feed', () => {
    const cookAlong = week();
    return json({
      hero: roast,
      trending: [shakshuka, roast],
      quick: [],
      following: [],
      newest: [],
      cookAlong: cookAlong && {
        week: '2026-10-12',
        recipe: shakshuka,
        cooks: 2,
        started: 5,
        ...cookAlong,
      },
    });
  });
  return api;
}

test('Home features the week’s cook-along with how many are cooking it, once', async ({ page }) => {
  await home(page, () => ({}));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'This week’s cook-along', level: 2 }),
  ).toBeVisible();
  await expect(page.getByText('5 people are cooking it this week', { exact: true })).toBeVisible();
  // One of the feed's row cards, whose author line names the founding creator.
  await expect(page.getByText('by Maya · Founding creator', { exact: true })).toBeVisible();
  // No shelf repeats it, and the hero is something else.
  await expect(page.locator('a[href="/recipes/shakshuka"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Sunday roast', level: 2 })).toBeVisible();
  // It opens the recipe, whose author line carries the mark too.
  await recipeCard(page, 'Shakshuka').click();
  await expect(page).toHaveURL(/\/recipes\/shakshuka$/);
  const byline = page.getByRole('button', { name: 'Visit Maya’s kitchen', exact: true });
  await expect(byline.getByText('Founding creator · 3 followers', { exact: true })).toBeVisible();
});

test('a cook-along nobody has cooked yet invites the first, and a week without one shows none', async ({
  page,
}) => {
  let week: Partial<CookAlong> | null = { cooks: 0, started: 0 };
  await home(page, () => week);
  await page.goto('/');
  await expect(page.getByText('Be the first to cook it this week.', { exact: true })).toBeVisible();
  // Someone who started late last Sunday and finished this week still counts.
  week = { cooks: 1, started: 0 };
  await page.reload();
  await expect(page.getByText('1 person is cooking it this week', { exact: true })).toBeVisible();
  week = null;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sunday roast', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This week’s cook-along' })).toHaveCount(0);
});

test('a founding creator’s profile says so, and other cooks’ don’t', async ({ page }) => {
  await home(page, () => null);
  await page.goto('/?page=community');
  await expect(page.getByText('@maya · Founding creator', { exact: true })).toBeVisible();
  await expect(page.getByText('@robin', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Visit Maya’s kitchen', exact: true }).click();
  const profile = page.getByRole('dialog');
  await expect(profile.getByText('Weeknight cook.', { exact: true })).toBeVisible();
  await expect(profile.getByText('Founding creator', { exact: true })).toBeVisible();
});

test('the cook-along has its own notification switch', async ({ page }) => {
  const api = await mockApi(page, {
    user: { preferences: { diets: [], allergies: [], notifications: { cookAlong: true } } },
  });
  api.on('PATCH', '/me/preferences', ({ body }) => {
    const notifications = (body as { notifications: Record<string, boolean> }).notifications;
    api.state.user.preferences.notifications = {
      ...api.state.user.preferences.notifications,
      ...notifications,
    };
    return json(api.state.user);
  });
  await page.goto('/?page=settings');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Weekly cook-along', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(api.sentTo('/me/preferences')).toEqual([
    ['PATCH', { notifications: { cookAlong: false } }],
  ]);
});
