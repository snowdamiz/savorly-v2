/// <reference types="node" />
import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// My kitchen's account settings against a mocked API: security (password, email, devices, email
// confirmation), data export, preferences, legal links, and the sign-up form's Turnstile check.

type Options = {
  signedIn?: boolean;
  hasPassword?: boolean;
  identities?: ('apple' | 'google')[];
  emailVerified?: boolean;
  /** The server can send email: email changes and confirmation. */
  email?: boolean;
  turnstileSiteKey?: string;
};
type Sent = { method: string; path: string; body: unknown };

const exported = { format: 'savorly-export', version: 1, profile: { name: 'Alex' }, recipes: [] };

async function kitchen(page: Page, options: Options = {}) {
  const {
    signedIn = true,
    hasPassword = true,
    identities = [],
    emailVerified = true,
    email = true,
    turnstileSiteKey = '',
  } = options;
  const user = {
    id: 'cook',
    name: 'Alex',
    handle: 'alex',
    bio: '',
    avatar: '',
    email: 'alex@example.test',
    emailVerified,
    preferences: {
      diets: [],
      allergies: [],
      units: '',
      language: 'en',
      notifications: { follows: true, pantry: true, reviews: true, comments: true },
    },
    hasPassword,
    identities,
    plan: 'free',
    onboarded: true,
  };
  let sessions = [
    {
      id: 'here',
      createdAt: '2026-10-01T10:00:00Z',
      lastUsedAt: new Date().toISOString(),
      expiresAt: '2026-11-15T10:00:00Z',
      userAgent: 'Chrome',
      client: 'Chrome',
      system: 'macOS',
      current: true,
    },
    {
      id: 'phone',
      createdAt: '2026-09-20T10:00:00Z',
      lastUsedAt: '2026-10-10T18:30:00Z',
      expiresAt: '2026-11-09T18:30:00Z',
      userAgent: 'Savorly/1.0 CFNetwork Darwin',
      client: 'Savorly',
      system: 'iPhone',
      current: false,
    },
    {
      id: 'laptop',
      createdAt: '2026-09-02T10:00:00Z',
      lastUsedAt: '2026-10-02T08:00:00Z',
      expiresAt: '2026-11-01T08:00:00Z',
      userAgent: 'Firefox',
      client: 'Firefox',
      system: 'Windows',
      current: false,
    },
  ];
  let session = signedIn;
  let nonces = 0;
  const sent: Sent[] = [];
  // Google's sign-in page sends the browser straight back with an ID token for its nonce.
  await page.route('https://accounts.google.com/o/oauth2/v2/auth?**', (r) => {
    const query = new URL(r.request().url()).searchParams;
    const back = `${query.get('redirect_uri')}#state=${query.get('state')}&id_token=google-id-token:${query.get('nonce')}`;
    return r.fulfill({
      contentType: 'text/html',
      body: `<script>location.replace(${JSON.stringify(back)})</script>`,
    });
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/v1/, '');
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    if (method !== 'GET') sent.push({ method, path, body });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/me') return session ? reply(user) : reply({ error: 'Sign in' }, 401);
    if (path === '/capabilities')
      return reply({
        textAI: false,
        voiceAI: false,
        recipeChat: false,
        passwordRecovery: email,
        turnstileSiteKey,
        googleSignIn: true,
        appleSignIn: true,
        auth: {
          googleWebClientId: 'web-client',
          googleIosClientId: '',
          appleServicesId: 'app.savorly.web',
          appleRedirectUri: 'https://savorly.test/auth/apple',
        },
      });
    if (path === '/library')
      return reply({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return reply({ plans: [], groceries: [], pantry: [] });
    if (path === '/auth/nonce') return reply({ nonce: `nonce-${++nonces}` });
    if (path === '/me/password') {
      if (body.currentPassword === 'not my password')
        return reply({ error: 'Password is incorrect.' }, 403);
      user.hasPassword = true;
      return reply(user);
    }
    if (path === '/me/email') return reply({ ok: true, email: body.email });
    if (path === '/me/email/confirm') {
      if (body.code !== '246810')
        return reply({ error: 'That code is invalid or expired. Request a new code.' }, 400);
      user.email = 'alex@new.example';
      return reply(user);
    }
    if (path === '/me/verify-email/resend') return reply({ ok: true });
    if (path === '/me/verify-email') {
      if (body.code !== '135790')
        return reply({ error: 'That code is invalid or expired. Request a new code.' }, 400);
      user.emailVerified = true;
      return reply(user);
    }
    if (path === '/me/sessions') return reply(sessions);
    if (path.startsWith('/me/sessions/') && method === 'DELETE') {
      sessions = sessions.filter((s) => s.id !== path.split('/').pop());
      return route.fulfill({ status: 204 });
    }
    if (path === '/me/sessions/revoke-others') {
      const revoked = sessions.filter((s) => !s.current).length;
      sessions = sessions.filter((s) => s.current);
      return reply({ revoked });
    }
    if (path === '/me/export') return reply(exported);
    if (path === '/me/preferences') {
      const { notifications, ...rest } = body;
      Object.assign(user.preferences, rest);
      Object.assign(user.preferences.notifications, notifications);
      return reply(user);
    }
    if (path === '/auth/register') {
      if (turnstileSiteKey && !body.turnstileToken)
        return reply({ error: 'Complete the security check to continue.' }, 400);
      if (body.email === 'taken@example.test')
        return reply({ error: 'An account with that email already exists.' }, 409);
      session = true;
      return reply({ ok: true, created: true });
    }
    if (path === '/auth/forgot') return reply({ ok: true });
    if (path === '/auth/logout') {
      session = false;
      return reply({ ok: true });
    }
    return reply([]);
  });
  return { user, sent, sessions: () => sessions };
}

const security = async (page: Page) => {
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Account and security', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account and security' })).toBeVisible();
};

test('a wrong current password stays in the form, signed in; the right one changes it', async ({
  page,
}) => {
  const { sent } = await kitchen(page);
  await security(page);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  // The sheet's own button, not the one on the Account and security page it came from.
  const submit = page.getByRole('dialog').getByRole('button', { name: 'Change password' }).last();
  await page.getByRole('textbox', { name: 'Current password' }).fill('not my password');
  await page
    .getByRole('textbox', { name: 'New password', exact: true })
    .fill('a much longer secret');
  await page.getByRole('textbox', { name: 'Repeat the new password' }).fill('a much longer secret');
  await submit.click();
  // 403 is a refusal, not a lost session: the form stays, with the reason, and no sign-in sheet.
  await expect(page.getByText('Password is incorrect.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Welcome back' })).toHaveCount(0);
  // Too short is caught before anything is sent.
  const before = sent.length;
  await page.getByRole('textbox', { name: 'Current password' }).fill('my real password');
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill('short');
  await page.getByRole('textbox', { name: 'Repeat the new password' }).fill('short');
  await submit.click();
  await expect(
    page.getByText('Use a password of 12–72 characters.', { exact: true }),
  ).toBeVisible();
  expect(sent.length).toBe(before);
  await page
    .getByRole('textbox', { name: 'New password', exact: true })
    .fill('a much longer secret');
  await page.getByRole('textbox', { name: 'Repeat the new password' }).fill('a much longer secret');
  await submit.click();
  await expect(
    page.getByText('Password changed. Your other devices were signed out.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Change your password' })).toHaveCount(0);
  expect(sent.filter((s) => s.path === '/me/password').map((s) => s.body)).toEqual([
    { currentPassword: 'not my password', newPassword: 'a much longer secret' },
    { currentPassword: 'my real password', newPassword: 'a much longer secret' },
  ]);
});

test('a kitchen made with Google sets a password after confirming with Google', async ({
  page,
}) => {
  const { sent } = await kitchen(page, { hasPassword: false, identities: ['google'] });
  await security(page);
  await expect(
    page.getByText('Add a password to sign in with your email address as well.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Set a password', exact: true }).click();
  // No current password to ask for: the connected Google account confirms it instead.
  await expect(page.getByRole('textbox', { name: 'Current password' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  // Google's page sends the browser back, to the same step.
  await expect(page.getByText('Confirmed with Google', { exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe('?page=profile');
  await page
    .getByRole('textbox', { name: 'New password', exact: true })
    .fill('a much longer secret');
  await page.getByRole('textbox', { name: 'Repeat the new password' }).fill('a much longer secret');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(
    page.getByText('Password set. Your other devices were signed out.', { exact: true }),
  ).toBeVisible();
  expect(sent.find((s) => s.path === '/me/password')?.body).toEqual({
    newPassword: 'a much longer secret',
    provider: 'google',
    token: expect.stringMatching(/^google-id-token:nonce-\d+$/),
  });
  // Nothing signed the kitchen in again or out.
  expect(sent.find((s) => s.path === '/auth/oauth')).toBeUndefined();
});

test('the email address changes once the code sent to the new one is entered', async ({ page }) => {
  const { sent } = await kitchen(page);
  await security(page);
  await page.getByRole('button', { name: 'Change your email address', exact: true }).click();
  await page.getByRole('textbox', { name: 'New email address' }).fill('alex@new.example');
  await page.getByRole('textbox', { name: 'Your password' }).fill('my real password');
  await page.getByRole('button', { name: 'Send the code', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your new inbox' })).toBeVisible();
  await expect(
    page.getByText('Enter the 6-digit code we sent to alex@new.example. It works for 15 minutes.'),
  ).toBeVisible();
  const code = page.getByRole('textbox', { name: 'Code from the email' });
  await code.fill('111111');
  await page.getByRole('button', { name: 'Confirm the new address', exact: true }).click();
  await expect(
    page.getByText('That code is invalid or expired. Request a new code.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send a new code', exact: true }).click();
  await expect(
    page.getByText('A new code is on its way to alex@new.example.', { exact: true }),
  ).toBeVisible();
  await code.fill('246810');
  await page.getByRole('button', { name: 'Confirm the new address', exact: true }).click();
  await expect(page.getByText('Your email address is changed.', { exact: true })).toBeVisible();
  await expect(page.getByText('alex@new.example', { exact: true })).toBeVisible();
  expect(sent.filter((s) => s.path.startsWith('/me/email')).map((s) => s.body)).toEqual([
    { email: 'alex@new.example', password: 'my real password' },
    { code: '111111' },
    { email: 'alex@new.example', password: 'my real password' },
    { code: '246810' },
  ]);
});

test('an unconfirmed address shows a banner until its code is entered', async ({ page }) => {
  const { sent } = await kitchen(page, { emailVerified: false });
  await page.goto('/?page=profile');
  await expect(page.getByText('Confirm your email address', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enter the code to confirm your email address' }).click();
  await page.getByRole('button', { name: 'Send a new code', exact: true }).click();
  await expect(
    page.getByText('A new code is on its way to alex@example.test.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Code from the email' }).fill('135790');
  await page.getByRole('button', { name: 'Confirm my email address', exact: true }).click();
  await expect(page.getByText('Your email address is confirmed.', { exact: true })).toBeVisible();
  await expect(page.getByText('Confirm your email address', { exact: true })).toHaveCount(0);
  expect(sent.map((s) => s.path)).toEqual(
    expect.arrayContaining(['/me/verify-email/resend', '/me/verify-email']),
  );
  expect(sent.find((s) => s.path === '/me/verify-email')?.body).toEqual({ code: '135790' });
});

test('email features wait for the server to send email', async ({ page }) => {
  await kitchen(page, { emailVerified: false, email: false });
  await security(page);
  await expect(page.getByText('Not confirmed yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change your email address' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByText('Confirm your email address', { exact: true })).toHaveCount(0);
});

test('devices: this one first, others signed out one at a time or all together', async ({
  page,
}) => {
  const { sent } = await kitchen(page);
  await security(page);
  await expect(page.getByText('Chrome on macOS', { exact: true })).toBeVisible();
  await expect(page.getByText('This device', { exact: true })).toBeVisible();
  await expect(page.getByText('Savorly app on iPhone', { exact: true })).toBeVisible();
  await expect(page.getByText('Firefox on Windows', { exact: true })).toBeVisible();
  // This device signs out from My kitchen's own button, not from the list.
  await expect(page.getByRole('button', { name: 'Sign out Chrome on macOS' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out Savorly app on iPhone', exact: true }).click();
  await expect(page.getByText('That device is signed out.', { exact: true })).toBeVisible();
  await expect(page.getByText('Savorly app on iPhone', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out everywhere else', exact: true }).click();
  await expect(page.getByText('You’re signed out everywhere else.', { exact: true })).toBeVisible();
  await expect(page.getByText('Firefox on Windows', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out everywhere else' })).toHaveCount(0);
  expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
    'DELETE /me/sessions/phone',
    'POST /me/sessions/revoke-others',
  ]);
});

test('Download my data saves the export as a dated JSON file', async ({ page }) => {
  await kitchen(page);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Download my data', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Download my data' })).toBeVisible();
  const download = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Download as JSON', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^savorly-export-\d{4}-\d{2}-\d{2}\.json$/);
  expect(JSON.parse(readFileSync(await file.path(), 'utf8'))).toEqual(exported);
  await expect(page.getByText('Your data is downloading.', { exact: true })).toBeVisible();
});

test('measurements, notifications and the language are saved to the account', async ({ page }) => {
  const { sent, user } = await kitchen(page);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Measurement settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Metric', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Metric', exact: true })).toBeChecked();
  await expect.poll(() => user.preferences.units).toBe('metric');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(
    page.getByText('Savorly sends these to the phones where you use the app.', { exact: true }),
  ).toBeVisible();
  const comments = page.getByRole('switch', { name: 'Comments', exact: true });
  await expect(comments).toBeChecked();
  await comments.click();
  await expect(comments).not.toBeChecked();
  await expect.poll(() => user.preferences.notifications.comments).toBe(false);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  // The language follows the app's, once the cook settles on one.
  await page.getByRole('button', { name: 'Language settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Deutsch', exact: true }).click();
  await page.getByRole('radio', { name: 'Français', exact: true }).click();
  await expect.poll(() => user.preferences.language, { timeout: 5000 }).toBe('fr');
  expect(sent.filter((s) => s.path === '/me/preferences').map((s) => s.body)).toEqual([
    { units: 'metric' },
    { notifications: { comments: false } },
    { language: 'fr' },
  ]);
});

test('the legal pages open from My kitchen and from the sign-up form', async ({ page }) => {
  await kitchen(page, { signedIn: false });
  await page.goto('/?page=profile');
  const origin = new URL(page.url()).origin;
  for (const [name, path] of [
    ['Privacy policy', '/privacy'],
    ['Terms of use', '/terms'],
    ['Delete your account', '/account-deletion'],
  ]) {
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('href', `${origin}${path}`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await page.getByRole('button', { name: 'Sign in or join', exact: true }).click();
  await page.getByRole('button', { name: 'New here? Create an account', exact: true }).click();
  const consent = page.getByText(/By creating an account, you agree to the/);
  await expect(consent).toBeVisible();
  await expect(consent.getByRole('link', { name: 'Terms of use' })).toHaveAttribute(
    'href',
    `${origin}/terms`,
  );
  await expect(consent.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
    'href',
    `${origin}/privacy`,
  );
});

// Turnstile's script, reduced to what the app calls: each render or reset passes with a new token.
const turnstileScript = `window.__turnstile = { renders: [], resets: 0, n: 0 };
window.turnstile = {
  render(el, o) { window.__turnstile.renders.push(o); window.__turnstile.o = o;
    setTimeout(() => o.callback('turnstile-token-' + (++window.__turnstile.n)), 50); return 'w1'; },
  reset() { window.__turnstile.resets++; const o = window.__turnstile.o;
    setTimeout(() => o.callback('turnstile-token-' + (++window.__turnstile.n)), 50); },
  remove() {},
};`;

test('with a Turnstile site key, sign-up and reset codes carry a fresh token each time', async ({
  page,
}) => {
  const scripts: string[] = [];
  await page.route('https://challenges.cloudflare.com/**', (route) => {
    scripts.push(route.request().url());
    return route.fulfill({ contentType: 'text/javascript', body: turnstileScript });
  });
  const { sent } = await kitchen(page, {
    signedIn: false,
    turnstileSiteKey: '1x00000000000000000000AA',
  });
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join', exact: true }).click();
  // Signing in needs no check.
  await expect.poll(() => scripts.length).toBe(0);
  await page.getByRole('button', { name: 'New here? Create an account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Alex');
  await page.getByRole('textbox', { name: 'Email address' }).fill('taken@example.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('a much longer secret');
  await page.getByRole('button', { name: 'Create your kitchen', exact: true }).click();
  await expect(
    page.getByText('An account with that email already exists.', { exact: true }),
  ).toBeVisible();
  // A token works once: the next attempt waits for a new one.
  await page.getByRole('textbox', { name: 'Email address' }).fill('alex@example.test');
  await page.getByRole('button', { name: 'Create your kitchen', exact: true }).click();
  await expect.poll(() => sent.filter((s) => s.path === '/auth/register').length).toBe(2);
  expect(scripts).toEqual([
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  ]);
  expect(sent.filter((s) => s.path === '/auth/register').map((s) => s.body)).toEqual([
    {
      name: 'Alex',
      email: 'taken@example.test',
      password: 'a much longer secret',
      turnstileToken: 'turnstile-token-1',
    },
    {
      name: 'Alex',
      email: 'alex@example.test',
      password: 'a much longer secret',
      turnstileToken: 'turnstile-token-2',
    },
  ]);
  const render = await page.evaluate(() => {
    const { sitekey, theme, size, appearance } = (
      window as unknown as { __turnstile: { renders: Record<string, unknown>[] } }
    ).__turnstile.renders[0];
    return { sitekey, theme, size, appearance };
  });
  expect(render).toEqual({
    sitekey: '1x00000000000000000000AA',
    theme: 'light',
    size: 'flexible',
    appearance: 'interaction-only',
  });
});

test('a reset code asks for the check too, and without a site key nothing loads', async ({
  page,
}) => {
  const scripts: string[] = [];
  await page.route('https://challenges.cloudflare.com/**', (route) => {
    scripts.push(route.request().url());
    return route.fulfill({ contentType: 'text/javascript', body: turnstileScript });
  });
  const { sent } = await kitchen(page, { signedIn: false });
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot your password?', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email address' }).fill('alex@example.test');
  await page.getByRole('button', { name: 'Send a reset code', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reset code' })).toBeVisible();
  expect(sent.find((s) => s.path === '/auth/forgot')?.body).toEqual({
    email: 'alex@example.test',
  });
  expect(scripts).toEqual([]);
});

test('a reset code request carries the Turnstile token when the server asks for one', async ({
  page,
}) => {
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: turnstileScript }),
  );
  const { sent } = await kitchen(page, { signedIn: false, turnstileSiteKey: 'site-key' });
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Sign in or join', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot your password?', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email address' }).fill('alex@example.test');
  await page.getByRole('button', { name: 'Send a reset code', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reset code' })).toBeVisible();
  expect(sent.find((s) => s.path === '/auth/forgot')?.body).toEqual({
    email: 'alex@example.test',
    turnstileToken: 'turnstile-token-1',
  });
});
