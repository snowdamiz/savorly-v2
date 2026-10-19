import { expect, test } from '@playwright/test';
import type { User } from '../src/lib/types';
import { json, mockApi } from './mockApi';
import { afterPageTimers } from './waits';

// My kitchen is the cook and their kitchen: the planner, the grocery list, the pantry and the
// household are a tap away there, and the settings have a page of their own (/?page=settings),
// grouped into the account, food and cooking, and the app.

const phone = { width: 390, height: 844 };

test('My kitchen leads to its places, and its gear to Settings and back', async ({ page }) => {
  await page.setViewportSize(phone);
  await mockApi(page, {
    kitchen: {
      groceries: [
        { id: 'g1', name: 'Milk', quantity: '1 l', category: 'Dairy', checked: false },
        { id: 'g2', name: 'Lemons', quantity: '2', category: 'Produce', checked: true },
      ],
    },
  });
  await page.goto('/?page=profile');
  // No settings here any more: they're behind the gear.
  await expect(page.getByRole('button', { name: 'Language settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  for (const place of ['Meal planner', 'Groceries', 'Pantry', 'Sous-chef history', 'Community'])
    await expect(page.getByRole('button', { name: place, exact: true })).toBeVisible();
  await expect(page.getByText('1 to buy', { exact: true })).toBeVisible();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/my-kitchen-phone.png' });

  // Groceries opens the planner on its list, not on the week.
  await page.getByRole('button', { name: 'Groceries', exact: true }).click();
  await expect(page.getByText('1 of 2 in the basket', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?page=planner$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\?page=settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  for (const group of ['Account', 'Food and cooking', 'App'])
    await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible();
  for (const row of ['Account and security', 'Food preferences', 'Language settings'])
    await expect(page.getByRole('button', { name: row, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/settings-phone.png' });
  // Back returns to My kitchen, whose tab stayed lit.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My kitchen', exact: true })).toBeVisible();
});

test('food preferences save apart from the profile', async ({ page }) => {
  const api = await mockApi(page, {
    user: { name: 'Alex', bio: 'Soups.', preferences: { diets: [], allergies: [] } },
  });
  api.on('PATCH', '/me', ({ body }) => {
    const sent = body as Partial<User>;
    Object.assign(api.state.user, sent, {
      preferences: { ...api.state.user.preferences, ...sent.preferences },
    });
    return json(api.state.user);
  });
  // The profile form keeps to who the cook is.
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your name', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Allergies (comma separated)' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.goto('/?page=settings');
  await page.getByRole('button', { name: 'Food preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Vegetarian', exact: true }).click();
  await page.getByRole('textbox', { name: 'Allergies (comma separated)' }).fill('peanuts, sesame');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Your food preferences are saved.', { exact: true })).toBeVisible();
  // The rest of the profile went along as it was.
  expect(api.sentTo('/me')).toEqual([
    [
      'PATCH',
      expect.objectContaining({
        name: 'Alex',
        bio: 'Soups.',
        handle: 'alex',
        preferences: expect.objectContaining({
          diets: ['Vegetarian'],
          allergies: ['peanuts', 'sesame'],
        }),
      }),
    ],
  ]);
  await expect(page.getByText('Vegetarian, peanuts, sesame', { exact: true })).toBeVisible();
});

test('sign-in methods are part of Account and security', async ({ page }) => {
  await mockApi(page, {
    user: { hasPassword: true, identities: ['google'] },
    capabilities: {
      googleSignIn: true,
      appleSignIn: true,
      auth: {
        googleWebClientId: 'web-client',
        appleServicesId: 'cooking.savorly.web',
        appleRedirectUri: 'https://savorly.test/auth/apple',
      },
    } as never,
  });
  await page.goto('/?page=settings');
  await page.getByRole('button', { name: 'Account and security', exact: true }).click();
  await expect(page.getByText('Sign-in methods', { exact: true })).toBeVisible();
  await expect(page.getByText('Email and password', { exact: true })).toBeVisible();
  await expect(page.getByText('Google', { exact: true })).toBeVisible();
  // Signed in with Google already, so it offers Apple.
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
});

test('the household opens from My kitchen on phones and the sidebar on desktops', async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto('/');
  // Desktop: the sidebar's kitchen holds the household with the cookbooks, planner and pantry.
  await page.getByRole('button', { name: 'Household', exact: true }).click();
  await expect(page.getByText('Start a household', { exact: true })).toBeVisible();
  expect(api.requests.filter((r) => r.path === '/household').length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByText('Start a household', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/settings-desktop.png' });

  // Phone: My kitchen's Household tile.
  await page.setViewportSize(phone);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Share your kitchen', exact: true }).click();
  await expect(page.getByText('Start a household', { exact: true })).toBeVisible();
});

test('a guest’s Settings offer to sign in, with the language there for everyone', async ({
  page,
}) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/?page=settings');
  await expect(page.getByRole('button', { name: 'Language settings', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in or join', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
});
