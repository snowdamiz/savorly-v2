import { expect, test, type Page } from '@playwright/test';
import type { Creator } from '../src/lib/types';
import { mockApi, recipe, robin } from './mockApi';

// Finding cooks: the community lists every member, whether or not they have published, and finds
// them by name or handle, as the recipe search does above its recipes.

const rosa: Creator = {
  id: 'rosa',
  name: 'Rosa Martínez',
  handle: 'rosa',
  bio: 'Paella every Sunday.',
  avatar: '',
  recipeCount: 3,
  followerCount: 2,
};
// Joined and cooked, never published.
const sam: Creator = {
  id: 'sam',
  name: 'Sam Okafor',
  handle: 'samcooks',
  bio: '',
  avatar: '',
  recipeCount: 0,
  followerCount: 0,
};
const card = (page: Page, name: string) =>
  page.getByRole('button', { name: `Visit ${name}’s kitchen`, exact: true });

test('the community lists every member, and finds cooks by name or handle', async ({ page }) => {
  const api = await mockApi(page, { creators: [rosa, robin, sam] });
  await page.goto('/?page=community');
  // The home's cooks have published; the community has everyone.
  await expect(card(page, 'Sam Okafor')).toBeVisible();
  expect(
    api.requests.some((r) => r.path === '/creators' && r.query.get('everyone') === 'true'),
  ).toBe(true);
  // Someone who hasn't published yet is new, not "0 recipes".
  await expect(card(page, 'Sam Okafor')).toContainText('New to Savorly');
  await expect(card(page, 'Rosa Martínez')).toContainText('3 recipes · 2 followers');
  const search = page.getByRole('textbox', { name: 'Search cooks', exact: true });
  await search.fill('@samc');
  await expect(card(page, 'Rosa Martínez')).toHaveCount(0);
  await expect(card(page, 'Sam Okafor')).toBeVisible();
  expect(api.requests.at(-1)?.query.get('q')).toBe('@samc');
  await search.fill('zelda');
  await expect(page.getByText('No cooks by that name', { exact: true })).toBeVisible();
  // The empty state's button, beside the field's own.
  await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await expect(card(page, 'Rosa Martínez')).toBeVisible();
  await card(page, 'Sam Okafor').click();
  await expect(page.getByRole('dialog').getByText('@samcooks', { exact: true })).toBeVisible();
});

test('a name in the recipe search finds its cook above the recipes', async ({ page }) => {
  await mockApi(page, {
    creators: [rosa, sam],
    recipes: [recipe({ id: 'paella', title: 'Rosa’s paella' })],
  });
  await page.goto('/');
  const search = page.getByRole('textbox', { name: 'Search recipes', exact: true });
  await search.fill('rosa');
  await expect(page.getByRole('heading', { name: 'Cooks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Meet Sam Okafor', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Meet Rosa Martínez', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('@rosa', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  // A search that names nobody shows recipes alone.
  await search.fill('paella');
  await expect(page.getByRole('heading', { name: 'Results for “paella”' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cooks', exact: true })).toHaveCount(0);
});
