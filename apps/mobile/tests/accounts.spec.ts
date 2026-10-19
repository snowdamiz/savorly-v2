import { test, expect, Page } from '@playwright/test';

// Each test gets its own account, so what one test changes (a name, a photo) can't leak into the
// next.
const newUser = () => ({
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  email: 'alex@example.test',
  preferences: { diets: [] as string[], allergies: [] as string[] },
  hasPassword: false,
  identities: ['google'],
  plan: 'free',
  onboarded: true,
});
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

// Sign in with Apple JS, reduced to what the app calls.
const appleScript = `window.AppleID = { auth: {
  init(o) { window.__apple = o; },
  async signIn() { return { authorization: { id_token: 'apple-id-token:' + window.__apple.nonce, code: 'apple-code' }, user: { name: { firstName: 'Alex', lastName: 'Cook' } } }; } } };`;

async function mockAccounts(page: Page, signedIn: boolean, catalogLive = true, created = false) {
  const posts: { path: string; body: unknown }[] = [];
  let nonces = 0;
  let session = signedIn;
  // A kitchen made by this sign-in has its setup ahead of it.
  const user = { ...newUser(), onboarded: !created };
  let job = 0;
  // Google's sign-in page, which sends the browser straight back with an ID token for its nonce.
  await page.route('https://accounts.google.com/o/oauth2/v2/auth?**', (r) => {
    const query = new URL(r.request().url()).searchParams;
    const back = `${query.get('redirect_uri')}#state=${query.get('state')}&id_token=google-id-token:${query.get('nonce')}`;
    return r.fulfill({
      contentType: 'text/html',
      body: `<script>location.replace(${JSON.stringify(back)})</script>`,
    });
  });
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
  return { posts, user };
}

test('profile edits reset on reopening and desktop/mobile chrome stays warning-free', async ({
  page,
}) => {
  const diagnostics: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error')
      diagnostics.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.push(error.message));
  const { user } = await mockAccounts(page, true);
  const originalName = user.name;
  await page.goto('/');
  await page.getByRole('button', { name: 'Open my kitchen', exact: true }).click();
  await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Unsaved name');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your name', exact: true })).toHaveValue(
    originalName,
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your name', exact: true })).toHaveValue(
    originalName,
  );
  expect(diagnostics).toEqual([]);
});

test('the web offers Apple and Google sign-in, each bound to a fresh server nonce', async ({
  page,
}) => {
  const { posts } = await mockAccounts(page, false);
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
  await expect(page.getByRole('button', { name: 'Edit your profile', exact: true })).toBeVisible();

  posts.length = 0;
  await page.evaluate(() => document.cookie);
  await page.goto('/?page=settings');
  // Signed in with Google already: Account and security offers to connect Apple, not Google.
  await page.getByRole('button', { name: 'Account and security', exact: true }).click();
  await expect(page.getByText('Sign-in methods', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
});

test('Google sign-in goes to Google’s page and comes back with its ID token', async ({ page }) => {
  const { posts } = await mockAccounts(page, false);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join' }).click();
  const google = page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/'));
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const query = new URL((await google).url()).searchParams;
  expect(Object.fromEntries(query)).toMatchObject({
    client_id: 'web-client',
    redirect_uri: `${new URL(process.env.TEST_WEB_URL || 'http://localhost:8081').origin}/`,
    response_type: 'id_token',
    nonce: expect.stringMatching(/^nonce-\d+$/),
  });
  await expect
    .poll(() => posts.find((p) => p.path === '/auth/oauth')?.body)
    .toMatchObject({
      provider: 'google',
      token: expect.stringMatching(/^google-id-token:nonce-\d+$/),
    });
  // Back where the button was pressed, with the token gone from the address bar.
  await expect(page.getByRole('button', { name: 'Edit your profile', exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe('?page=profile');
  expect(new URL(page.url()).hash).toBe('');
});

test('a Google answer this tab didn’t ask for is ignored and wiped', async ({ page }) => {
  const { posts } = await mockAccounts(page, false);
  await page.goto('/?page=profile#state=forged&id_token=google-id-token:someone-else');
  await expect(page.getByRole('button', { name: 'Sign in or join' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(posts.find((p) => p.path === '/auth/oauth')).toBeUndefined();
});

test('a new Google kitchen sets itself up before anything else', async ({ page }) => {
  const { posts, user } = await mockAccounts(page, false, true, true);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join' }).click();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
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
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // Last, the sous-chef: what to ask it and where to find it.
  await expect(page.getByText('Just ask your sous-chef', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Plan my week and add the groceries.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('One tap away, on every screen', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Let’s get started', exact: true }).click();
  await expect(page.getByText('Welcome to the table, @alex.cooks.', { exact: true })).toBeVisible();
  await expect(page.getByText('@alex.cooks', { exact: true })).toBeVisible();
  await expect(page.getByText('Set up your kitchen', { exact: true })).toHaveCount(0);
  expect(user.preferences).toEqual({ diets: ['Vegetarian'], allergies: ['peanuts', 'sesame'] });
  expect(posts.find((p) => p.path === '/auth/oauth')).toBeTruthy();
  expect(posts.find((p) => p.path === '/me/onboarded')).toBeTruthy();
});

test('the profile photo changes from My kitchen, with an AI touch-up', async ({ page }) => {
  const { posts, user } = await mockAccounts(page, true);
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
  // The photo is framed in Savorly's own crop, and nothing uploads until it's finished.
  await expect(page.getByRole('button', { name: 'Finish crop', exact: true })).toBeVisible();
  expect(posts.some((p) => p.path === '/media')).toBe(false);
  await page.getByRole('button', { name: 'Finish crop', exact: true }).click();
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

test('an uploaded recipe photo can be touched up and compared before it is used', async ({
  page,
}) => {
  const { posts } = await mockAccounts(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Write a recipe yourself', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload a photo', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'dish.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dWQAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  const url = page.getByRole('textbox', { name: 'Or use an image URL', exact: true });
  await expect(url).toHaveValue('https://media.test/cook/upload.jpg');
  await page.getByRole('button', { name: 'Touch up the cover photo', exact: true }).click();
  // Nothing is spent until the cook asks for it.
  expect(posts.some((p) => p.path === '/media/touch-up')).toBe(false);
  await page.getByRole('button', { name: 'Touch up with AI', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Touched up' })).toBeVisible({ timeout: 15000 });
  expect(posts.find((p) => p.path === '/media/touch-up')?.body).toEqual({
    url: 'https://media.test/cook/upload.jpg',
    kind: 'dish',
  });
  await page.getByRole('button', { name: 'Use touched-up photo', exact: true }).click();
  await expect(url).toHaveValue('https://media.test/cook/touched.jpg');
});

test('plans show usage and sell through Stripe checkout on the web', async ({ page }) => {
  const { posts } = await mockAccounts(page, true);
  await page.goto('/?page=settings');
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
  await page.goto('/?page=settings');
  await expect(
    page.getByRole('button', { name: 'Account and security', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Your plan', { exact: true })).toHaveCount(0);
});
