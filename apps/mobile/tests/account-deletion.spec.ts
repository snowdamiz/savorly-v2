import { expect, Page, test } from '@playwright/test';
import { alex, empty, failure, mockApi, recipe, recipeCard } from './mockApi';

// My kitchen → Delete my account: the password confirmation, DELETE /me, a refused password, and
// the guest the app returns to.

const password = 'my real password';
const toast = recipe({ id: 'toast', title: 'Lemon toast', author: alex });

/**
 * A signed-in kitchen whose server deletes it for the right password and refuses others with a
 * 403, as the API refuses a password without ending the session (stillSignedIn).
 */
async function kitchen(page: Page) {
  const api = await mockApi(page, { library: { recipes: [toast] } });
  api.on('DELETE', '/me', ({ body }) => {
    if ((body as { password?: string }).password !== password)
      return failure(403, 'Password is incorrect.');
    api.state.session = false;
    api.state.library.recipes = [];
    return empty();
  });
  return api;
}
const openDeletion = async (page: Page) => {
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delete your account?' })).toBeVisible();
  await expect(
    page.getByText(
      'This permanently deletes your account, recipes, reviews and kitchen lists. It can’t be undone.',
      { exact: true },
    ),
  ).toBeVisible();
};
const confirmButton = (page: Page) =>
  page.getByRole('button', { name: 'Permanently delete my account', exact: true });
const passwordField = (page: Page) =>
  page.getByRole('textbox', { name: 'Your password', exact: true });
/** After a refusal: the kitchen behind the dialog is still Alex's, and the dialog keeps the try. */
const stillSignedIn = async (page: Page) => {
  await expect(page.getByRole('button', { name: 'Edit your profile', exact: true })).toBeVisible();
  await expect(passwordField(page)).toHaveValue('not my password');
  await expect(page.getByRole('heading', { name: 'Delete your account?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Welcome back' })).toHaveCount(0);
};

test('deleting the account takes the password, sends it, and leaves a guest', async ({ page }) => {
  const api = await kitchen(page);
  await openDeletion(page);
  // Nothing goes without the password.
  await expect(confirmButton(page)).toBeDisabled();
  await passwordField(page).fill(password);
  await expect(confirmButton(page)).toBeEnabled();
  await confirmButton(page).click();
  await expect(page.getByText('Your account has been deleted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The app starts over as a guest.
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(api.sentTo('/me')).toEqual([['DELETE', { password }]]);
  await page.getByRole('button', { name: 'Open my kitchen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in or join', exact: true })).toBeVisible();
  await expect(recipeCard(page, 'Lemon toast')).toHaveCount(0);
});

test('a refused password stays in the dialog, signed in, and the right one deletes', async ({
  page,
}) => {
  const api = await kitchen(page);
  await openDeletion(page);
  await passwordField(page).fill('not my password');
  await confirmButton(page).click();
  await expect(page.getByText('Password is incorrect.', { exact: true })).toBeVisible();
  await stillSignedIn(page);
  await passwordField(page).fill(password);
  await confirmButton(page).click();
  await expect(page.getByText('Your account has been deleted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(api.sentTo('/me')).toEqual([
    ['DELETE', { password: 'not my password' }],
    ['DELETE', { password }],
  ]);
});

// DELETE /me refuses a wrong password with 403, like the other password checks (stillSignedIn in
// the API): the app takes any 401 for a lost session and would sign the cook out of a kitchen
// whose session is still good.
test('a mistyped password doesn’t sign the cook out or empty the kitchen', async ({ page }) => {
  const api = await kitchen(page);
  await openDeletion(page);
  await passwordField(page).fill('not my password');
  await confirmButton(page).click();
  await expect(page.getByText('Password is incorrect.', { exact: true })).toBeVisible();
  await stillSignedIn(page);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit your profile', exact: true })).toBeVisible();
  await expect(recipeCard(page, 'Lemon toast')).toBeVisible();
  expect(api.sentTo('/me')).toEqual([['DELETE', { password: 'not my password' }]]);
});
