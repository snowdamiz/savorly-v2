import { expect, test } from '@playwright/test';
import { mockApi, recipe } from './mockApi';

// With every API request failing at the network, the app says it can't reach the kitchen and
// offers to try again; once the network is back, trying again loads the app. Either a full page
// ("Let’s reconnect your kitchen") or an offline banner with a retry action will do.

const soup = recipe({ id: 'soup', title: 'Pumpkin soup' });

test('an unreachable API offers to reconnect, and Try again loads the app', async ({ page }) => {
  const api = await mockApi(page, { recipes: [soup] });
  api.state.online = false;
  await page.goto('/');
  const offline = page
    .getByText('Let’s reconnect your kitchen', { exact: true })
    .or(page.getByText(/offline|couldn’t reach|can’t reach|no connection/i));
  const retry = page.getByRole('button', { name: /try again|retry|reconnect/i });
  await expect(offline.first()).toBeVisible({ timeout: 15_000 });
  await expect(retry.first()).toBeVisible();
  expect(api.requests.length).toBeGreaterThan(0);

  // Trying again while still offline asks again and stays put.
  let asked = api.requests.length;
  await retry.first().click();
  await expect.poll(() => api.requests.length).toBeGreaterThan(asked);
  await expect(offline.first()).toBeVisible();
  await expect(retry.first()).toBeVisible();

  // The network is back: the next try loads the kitchen.
  api.state.online = true;
  asked = api.requests.length;
  await retry.first().click();
  await expect(page.getByText('Pumpkin soup').first()).toBeVisible();
  await expect(offline).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  // Nothing had loaded before, so the session was asked for again (GET /me or GET /session).
  const after = api.requests.slice(asked).map((r) => r.path);
  expect(after).toEqual(expect.arrayContaining([expect.stringMatching(/^\/(me|session)$/)]));
});
