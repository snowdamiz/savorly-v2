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
  onboarded: true,
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

async function mockAccounts(page: Page, signedIn: boolean, catalogLive = true, created = false) {
  const posts: { path: string; body: unknown }[] = [];
  let nonces = 0;
  let session = signedIn;
  // A kitchen made by this sign-in has its setup ahead of it.
  Object.assign(user, {
    onboarded: !created,
    avatar: '',
    preferences: { diets: [], allergies: [] },
  });
  let job = 0;
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
    if (method === 'POST')
      posts.push({
        path,
        // Uploads are multipart, not JSON.
        body: path === '/media' ? null : route.request().postDataJSON(),
      });
    if (path === '/me' && method === 'PATCH') {
      const { name, handle, avatar, preferences } = route.request().postDataJSON();
      Object.assign(user, { name, handle, avatar, preferences });
      return fulfill(user);
    }
    if (path === '/me/onboarded') {
      user.onboarded = true;
      return fulfill(user);
    }
    if (path === '/media') return fulfill({ url: 'https://media.test/cook/upload.jpg' }, 201);
    // A touch-up finishes on the second look.
    if (path === '/media/touch-up')
      return fulfill({ id: 'touch', kind: 'image', status: 'queued', result: {}, error: '' }, 202);
    if (path === '/ai/jobs/touch')
      return fulfill({
        id: 'touch',
        kind: 'image',
        status: ++job > 1 ? 'completed' : 'running',
        result: job > 1 ? { url: 'https://media.test/cook/touched.jpg' } : {},
        error: '',
      });
    if (path === '/me') return session ? fulfill(user) : fulfill({ error: 'Sign in' }, 401);
    if (path === '/capabilities')
      return fulfill({
        textAI: true,
        imageAI: true,
        plans: catalogLive,
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
      return fulfill(created ? { ok: true, created: true } : { ok: true });
    }
    if (path.startsWith('/handles/')) {
      const handle = decodeURIComponent(path.slice('/handles/'.length));
      return fulfill({ handle, valid: true, available: handle !== 'alex.rivera' });
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

test('a new Google kitchen sets itself up before anything else', async ({ page }) => {
  const posts = await mockAccounts(page, false, true, true);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join' }).click();
  await page.getByRole('button', { name: 'Sign in with Google (test)' }).click();
  // Photo, name and username first; the username is checked as it's typed.
  await expect(page.getByText('Set up your kitchen', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a photo' }).first()).toBeVisible();
  const username = page.getByRole('textbox', { name: 'Username', exact: true });
  await username.fill('Alex.Rivera');
  await expect(page.getByText('That username is taken.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await username.fill('@Alex.Cooks');
  await expect(username).toHaveValue('alex.cooks');
  await expect(page.getByText('@alex.cooks is available.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // Then tastes, saved as the step is left.
  await expect(page.getByText('How do you like to eat?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Vegetarian', exact: true }).click();
  await page.getByRole('textbox', { name: 'Allergies (comma separated)' }).fill('peanuts, sesame');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Cooks to follow', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Let’s get started', exact: true }).click();
  await expect(page.getByText('Welcome to the table, @alex.cooks.', { exact: true })).toBeVisible();
  await expect(page.getByText('@alex.cooks', { exact: true })).toBeVisible();
  await expect(page.getByText('Set up your kitchen', { exact: true })).toHaveCount(0);
  expect(user.preferences).toEqual({ diets: ['Vegetarian'], allergies: ['peanuts', 'sesame'] });
  expect(posts.find((p) => p.path === '/auth/oauth')).toBeTruthy();
  expect(posts.find((p) => p.path === '/me/onboarded')).toBeTruthy();
});

test('the profile photo changes from My kitchen, with an AI touch-up', async ({ page }) => {
  const posts = await mockAccounts(page, true);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Add a photo' }).first().click();
  await expect(page.getByText('Profile photo', { exact: true })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose a photo', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dWQAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect.poll(() => posts.some((p) => p.path === '/media')).toBe(true);
  await page.getByRole('button', { name: 'Touch up with AI', exact: true }).click();
  // The touched-up photo can be compared with the one it came from before it's kept.
  await expect(page.getByRole('tab', { name: 'Touched up' })).toBeVisible({ timeout: 15000 });
  expect(posts.find((p) => p.path === '/media/touch-up')?.body).toEqual({
    url: 'https://media.test/cook/upload.jpg',
    kind: 'avatar',
  });
  await page.getByRole('button', { name: 'Use this photo', exact: true }).click();
  await expect(page.getByText('Your photo is updated.', { exact: true })).toBeVisible();
  expect(user.avatar).toBe('https://media.test/cook/touched.jpg');
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

test('plans stay hidden until the catalog is live', async ({ page }) => {
  await mockAccounts(page, true, false);
  await page.goto('/?page=profile');
  await expect(page.getByText('Sign-in methods', { exact: true })).toBeVisible();
  await expect(page.getByText('Your plan', { exact: true })).toHaveCount(0);
});
