import { expect, Page, test } from '@playwright/test';
import { stopsMoving } from './waits';

async function guest(page: Page) {
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    if (path === '/me')
      return route.fulfill({
        status: 401,
        json: { error: 'Sign in to your kitchen to continue.' },
      });
    if (path === '/capabilities') return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });
}

// The sheet's title is its only heading, so it shows whether the Filters sheet is open.
const filters = (page: Page) => page.getByRole('heading', { name: 'Filters', exact: true });

async function exploreWithFilters(page: Page) {
  await guest(page);
  await page.goto('/?page=discover');
  await page.getByRole('button', { name: 'Explore recipes', exact: true }).click();
  await expect(page).toHaveURL(/\?page=explore$/);
  await page.getByRole('button', { name: 'Filter recipes', exact: true }).click();
  await expect(filters(page)).toBeVisible();
}

test('the browser’s Back closes an open sheet and keeps the page under it', async ({ page }) => {
  await exploreWithFilters(page);
  await page.goBack();
  await expect(filters(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\?page=explore$/);
  await expect(page.getByText('Explore', { exact: true })).toBeVisible();
  // The next Back leaves Explore, as it would have without the sheet.
  await page.goBack();
  await expect(page).toHaveURL(/\?page=discover$/);
  await expect(page.getByText('What would you like to cook today?', { exact: true })).toBeVisible();
});

test('a sheet closed by its own button leaves no history entry behind', async ({ page }) => {
  await exploreWithFilters(page);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(filters(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\?page=explore$/);
  // Back goes straight to the page before Explore.
  await page.goBack();
  await expect(page).toHaveURL(/\?page=discover$/);
  await expect(page.getByText('What would you like to cook today?', { exact: true })).toBeVisible();
});

test('a sheet closing as the window narrows to a phone lets go of the page', async ({ page }) => {
  await page.clock.install();
  await exploreWithFilters(page);
  // With the page's clock held, the window narrows partway through the sheet's slide down, which
  // remounts the sheet for the phone's drag and stops its animation.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.clock.runFor(150);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.resume();
  await expect(filters(page)).toHaveCount(0);
  // Nothing is left over the page: it takes taps again.
  await page.getByRole('button', { name: 'Filter recipes', exact: true }).click({ timeout: 5000 });
  await expect(filters(page)).toBeVisible();
});

test('a sheet opening as the window widens settles where it would have', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install();
  await guest(page);
  await page.goto('/?page=explore');
  const open = page.getByRole('button', { name: 'Filter recipes', exact: true });
  // Where the sheet rests when it opens on a wide window.
  await open.click();
  await stopsMoving(filters(page));
  const resting = (await filters(page).boundingBox())!;
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(filters(page)).toHaveCount(0);
  // Opened on a phone, with the window widening partway through its rise from the bottom.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await open.click();
  await page.clock.runFor(60);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.resume();
  await stopsMoving(filters(page));
  expect((await filters(page).boundingBox())!.y).toBeCloseTo(resting.y, 0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(filters(page)).toHaveCount(0);
});

test('an address the page sets while a sheet is open stays when the sheet closes', async ({
  page,
}) => {
  await exploreWithFilters(page);
  // As the admin console does when it switches tabs.
  await page.evaluate(() => history.replaceState({}, '', '/?page=explore&tab=quick'));
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(filters(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\?page=explore&tab=quick$/);
  await page.goBack();
  await expect(page).toHaveURL(/\?page=discover$/);
});

test('a page opened from a sheet takes the sheet’s place in history', async ({ page }) => {
  await guest(page);
  await page.goto('/?page=discover');
  await page.getByRole('button', { name: 'Kitchen activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'From kitchens you follow' })).toBeVisible();
  await page.getByRole('button', { name: 'Meet the community', exact: true }).click();
  await expect(page).toHaveURL(/\?page=community$/);
  await expect(page.getByRole('heading', { name: 'From kitchens you follow' })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\?page=discover$/);
  await expect(page.getByText('What would you like to cook today?', { exact: true })).toBeVisible();
});
