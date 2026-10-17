import { expect, Page, test } from '@playwright/test';
import { alex, failure, json, mockApi, recipe, recipeCard } from './mockApi';

// Signing in with an email and password, the reset-code dialog, and signing out, against the
// mocked API.

const email = 'alex@example.test';
const password = 'a much longer secret';

/** A guest whose account exists: the login answers for its password only. */
async function guest(page: Page) {
  const api = await mockApi(page, { signedIn: false });
  api.on('POST', '/auth/login', ({ body }) => {
    const sent = body as { email: string; password: string };
    if (sent.email !== email || sent.password !== password)
      return failure(401, 'Email or password is incorrect.');
    api.state.session = true;
    return json({ ok: true });
  });
  return api;
}
const openSignIn = async (page: Page) => {
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Welcome back', exact: true })).toBeVisible();
};
const fillSignIn = async (page: Page, address: string, secret: string) => {
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(address);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Welcome back', exact: true }).click();
};
const expectGuest = async (page: Page) => {
  await expect(page.getByRole('button', { name: 'Sign in or join', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit your profile' })).toHaveCount(0);
};

test('an email and password sign in, and the kitchen shows who is signed in', async ({ page }) => {
  const api = await guest(page);
  await openSignIn(page);
  await fillSignIn(page, email, password);
  await expect(page.getByText('Welcome back to your kitchen.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // My kitchen is Alex's now: the profile, the account's sign-in methods, and the header avatar.
  await expect(page.getByRole('button', { name: 'Edit your profile', exact: true })).toBeVisible();
  await expect(page.getByText('@alex', { exact: true })).toBeVisible();
  await expect(page.getByText('Sign-in methods', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'My profile', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in or join' })).toHaveCount(0);
  expect(api.sentTo('/auth/login')).toEqual([
    ['POST', expect.objectContaining({ email, password })],
  ]);
  // The session is the server's: a reload finds it again.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit your profile', exact: true })).toBeVisible();
});

test('a wrong password keeps the sheet open with the reason, still signed out', async ({
  page,
}) => {
  const api = await guest(page);
  await openSignIn(page);
  await fillSignIn(page, email, 'not my password at all');
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await expect(page.getByRole('button', { name: 'Welcome back', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue(
    email,
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectGuest(page);
  // The next opening starts clean, and the right password still works.
  await page.getByRole('button', { name: 'Sign in or join', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Welcome back', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await fillSignIn(page, email, password);
  await expect(page.getByRole('button', { name: 'Edit your profile', exact: true })).toBeVisible();
  expect(api.sentTo('/auth/login').map(([, body]) => body)).toEqual([
    expect.objectContaining({ email, password: 'not my password at all' }),
    expect.objectContaining({ email, password }),
  ]);
});

test('too many sign-in attempts are refused with the server’s message', async ({ page }) => {
  const api = await guest(page);
  api.on('POST', '/auth/login', () =>
    failure(429, 'Too many sign-in attempts. Please wait a few minutes and try again.'),
  );
  await openSignIn(page);
  await fillSignIn(page, email, password);
  await expect(page.getByRole('alert')).toHaveText(
    'Too many sign-in attempts. Please wait a few minutes and try again.',
  );
  await expect(page.getByRole('button', { name: 'Welcome back', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectGuest(page);
  // Refused once, and not tried again behind the cook's back.
  expect(api.sentTo('/auth/login')).toHaveLength(1);
});

test('a reset code sets a new password, and a wrong code says so', async ({ page }) => {
  const api = await guest(page);
  api.on('POST', '/auth/reset', ({ body }) =>
    (body as { code: string }).code === '24681357'
      ? json({ ok: true })
      : failure(400, 'That reset code is invalid or expired. Request a new code.'),
  );
  await openSignIn(page);
  await page.getByRole('button', { name: 'Forgot your password?', exact: true }).click();
  // Only the address first.
  await expect(page.getByRole('textbox', { name: 'Password', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send a reset code', exact: true }).click();
  const code = page.getByRole('textbox', { name: 'Reset code', exact: true });
  await expect(code).toBeVisible();
  await expect(
    page.getByText(
      'If an account exists for this address, a reset code is on its way. Enter it below with a new password.',
      { exact: true },
    ),
  ).toBeVisible();
  const submit = page.getByRole('button', { name: 'Set my new password', exact: true });
  await code.fill('11112222');
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('a brand new secret');
  await submit.click();
  await expect(page.getByRole('alert')).toHaveText(
    'That reset code is invalid or expired. Request a new code.',
  );
  // Still on the code step, with what was typed, to correct it.
  await expect(code).toHaveValue('11112222');
  await code.fill('24681357');
  await submit.click();
  await expect(
    page.getByText('Your password is updated. Sign in to return to your kitchen.', {
      exact: true,
    }),
  ).toBeVisible();
  // Back on the sign-in side with the address kept and the password cleared, still signed out.
  await expect(page.getByRole('button', { name: 'Welcome back', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reset code' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue(
    email,
  );
  await expect(page.getByRole('textbox', { name: 'Password', exact: true })).toHaveValue('');
  expect(api.sentTo('/auth/forgot')).toEqual([['POST', { email }]]);
  expect(api.sentTo('/auth/reset')).toEqual([
    ['POST', { email, code: '11112222', password: 'a brand new secret' }],
    ['POST', { email, code: '24681357', password: 'a brand new secret' }],
  ]);
  expect(api.sentTo('/auth/login')).toEqual([]);
});

test('signing out from My kitchen ends the session and leaves a guest', async ({ page }) => {
  const toast = recipe({ id: 'toast', title: 'Lemon toast', author: alex });
  const api = await mockApi(page, { library: { recipes: [toast] } });
  await page.goto('/?page=profile');
  await expect(recipeCard(page, 'Lemon toast')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('You’ve signed out. See you at the table.', { exact: true }),
  ).toBeVisible();
  await expectGuest(page);
  // The kitchen's own recipes went with the session.
  await expect(recipeCard(page, 'Lemon toast')).toHaveCount(0);
  expect(api.sentTo('/auth/logout')).toEqual([['POST', undefined]]);
  // The server ended the session, so a reload is still a guest's.
  await page.reload();
  await expectGuest(page);
});
