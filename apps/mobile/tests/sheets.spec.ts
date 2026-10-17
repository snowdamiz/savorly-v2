import { expect, Page, test } from '@playwright/test';

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
