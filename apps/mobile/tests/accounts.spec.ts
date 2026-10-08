import { test, expect, Page } from '@playwright/test';

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
  hasPassword: false,
  identities: ['google'],
  plan: 'free',
};
const plans = [
  {
    id: 'free',
    monthlyUSD: 0,
    yearlyUSD: 0,
    assistant: 10,
    voiceMinutes: 2,
    images: 1,
    videos: 0,
    narration: 5,
  },
  {
    id: 'plus',
    monthlyUSD: 9.99,
    yearlyUSD: 79.99,
    assistant: 80,
    voiceMinutes: 20,
    images: 6,
    videos: 0,
    narration: 30,
  },
  {
    id: 'pro',
    monthlyUSD: 19.99,
    yearlyUSD: 159.99,
    assistant: 130,
    voiceMinutes: 40,
    images: 10,
    videos: 1,
    narration: 30,
  },
];

// Google Identity Services and Sign in with Apple JS, reduced to what the app calls.
const googleScript = `window.google = { accounts: { id: {
  initialize(o) { window.__google = o; },
  renderButton(el) {
    const b = document.createElement('button');
    b.textContent = 'Sign in with Google (test)';
    b.onclick = () => window.__google.callback({ credential: 'google-id-token:' + window.__google.nonce });
    el.appendChild(b);
  } } } };`;
const appleScript = `window.AppleID = { auth: {
  init(o) { window.__apple = o; },
  async signIn() { return { authorization: { id_token: 'apple-id-token:' + window.__apple.nonce, code: 'apple-code' }, user: { name: { firstName: 'Alex', lastName: 'Cook' } } }; } } };`;

async function mockAccounts(page: Page, signedIn: boolean) {
  const posts: { path: string; body: unknown }[] = [];
  let nonces = 0;
  let session = signedIn;
  await page.route('https://accounts.google.com/gsi/client', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: googleScript }),
  );
  await page.route('https://appleid.cdn-apple.com/**', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: appleScript }),
  );
  await page.route('https://checkout.stripe.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<h1>Stripe checkout</h1>' }),
  );
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    const fulfill = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method === 'POST') posts.push({ path, body: route.request().postDataJSON() });
    if (path === '/me') return session ? fulfill(user) : fulfill({ error: 'Sign in' }, 401);
    if (path === '/capabilities')
      return fulfill({
        textAI: true,
        billing: true,
        appleSignIn: true,
        googleSignIn: true,
        auth: {
          googleWebClientId: 'web-client',
          googleIosClientId: '',
          appleServicesId: 'app.savorly.web',
          appleRedirectUri: 'https://savorly.test/auth/apple',
        },
      });
    if (path === '/auth/nonce') return fulfill({ nonce: `nonce-${++nonces}` });
    if (path === '/auth/oauth') {
      session = true;
      return fulfill({ ok: true });
    }
    if (path === '/library')
      return fulfill({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return fulfill({ plans: [], groceries: [], pantry: [] });
    if (path === '/billing')
      return fulfill({
        plan: 'free',
        status: '',
        interval: '',
        renewsAt: null,
        cancels: false,
        usage: { assistant: 4, voiceSeconds: 61, images: 0, videos: 0, narration: 1 },
        plans,
        checkout: true,
        manage: false,
      });
    if (path === '/billing/checkout') return fulfill({ url: 'https://checkout.stripe.test/s' });
    return fulfill([]);
  });
  return posts;
}

test('the web offers Apple and Google sign-in, each bound to a fresh server nonce', async ({
  page,
}) => {
  const posts = await mockAccounts(page, false);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join' }).click();
  await page.getByRole('button', { name: 'Continue with Apple' }).click();
  await expect
    .poll(() => posts.find((p) => p.path === '/auth/oauth')?.body)
    .toMatchObject({
      provider: 'apple',
      token: expect.stringMatching(/^apple-id-token:nonce-\d+$/),
      code: 'apple-code',
      name: 'Alex Cook',
    });
  await expect(page.getByText('Your plan', { exact: true })).toBeVisible();

  posts.length = 0;
  await page.evaluate(() => document.cookie);
  await page.goto('/?page=profile');
  // Signed in with Google already: the profile offers to connect Apple, not Google.
  await expect(page.getByText('Sign-in methods', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google (test)' })).toHaveCount(0);
});

test('Google’s own button signs in with its ID token', async ({ page }) => {
  const posts = await mockAccounts(page, false);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join' }).click();
  await page.getByRole('button', { name: 'Sign in with Google (test)' }).click();
  await expect
    .poll(() => posts.find((p) => p.path === '/auth/oauth')?.body)
    .toMatchObject({
      provider: 'google',
      token: expect.stringMatching(/^google-id-token:nonce-\d+$/),
    });
});

test('plans show usage and sell through Stripe checkout on the web', async ({ page }) => {
  const posts = await mockAccounts(page, true);
  await page.goto('/?page=profile');
  await expect(page.getByText('Your plan', { exact: true })).toBeVisible();
  await expect(page.getByText('4 of 10')).toBeVisible();
  await expect(page.getByText('$79.99 a year')).toBeVisible();
  await page.getByRole('tab', { name: 'Monthly' }).click();
  await expect(page.getByText('$9.99 a month')).toBeVisible();
  await page.getByRole('button', { name: 'Choose Plus' }).click();
  await expect(page.getByRole('heading', { name: 'Stripe checkout' })).toBeVisible();
  expect(posts.find((p) => p.path === '/billing/checkout')?.body).toEqual({
    plan: 'plus',
    interval: 'monthly',
  });
});
