import { test, expect, Page } from '@playwright/test';

const member = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
  hasPassword: true,
  identities: [],
  plan: 'free',
  admin: false,
  adminOwner: false,
  adminPending: false,
};
const owner = {
  ...member,
  id: 'owner',
  name: 'Owner',
  email: 'owner@example.test',
  admin: true,
  adminOwner: true,
};
const settings = {
  aiPaused: false,
  aiDailyBudgetUSD: null,
  aiFreeDailyBudgetUSD: null,
  signupsPaused: false,
  announcement: '',
  announcementTone: 'info',
};
const overview = {
  stats: {
    members: {
      total: 42,
      new24h: 2,
      new7d: 9,
      new30d: 30,
      verified: 20,
      suspended: 1,
      admins: 1,
      withPassword: 30,
      active7d: 18,
    },
    samples: 6,
    plans: { free: 40, plus: 2 },
    comped: 1,
    identities: { google: 12 },
    recipes: { published: 120, drafts: 14, aiGenerated: 30, new7d: 11, withVideo: 3 },
    community: { reviews: 80, reviews7d: 7, follows: 50, saves: 300, cookbooks: 25, mealPlans: 60 },
    reports: { open: 3, recipes: 1 },
    jobs: {
      queued: 0,
      running: 1,
      processing: 0,
      failed24h: 2,
      completed24h: 40,
      oldestQueuedSeconds: 0,
    },
    assistant: { queued: 0, running: 0, failed24h: 0, turns24h: 75 },
    conversations: { total: 90, active7d: 22 },
    voiceLive: 1,
    spend: { last24h: 21.5, free24h: 3, last7d: 60, last30d: 180 },
    spendBySource: { media: 50, tools: 20, assistant: 90, narration: 5, voice: 15 },
    migration: '012_admin.sql',
    databaseBytes: 52_000_000,
  },
  series: Array.from({ length: 30 }, (_, i) => ({
    day: new Date(Date.UTC(2026, 8, 16 + i)).toISOString().slice(0, 10),
    signups: i % 4,
    recipes: i % 3,
    jobs: i,
    spend: i / 2,
  })),
  budget: {
    daily: 25,
    freeDaily: 5,
    baseDaily: 25,
    baseFreeDaily: 5,
    memberFreeShare: 0,
    memberPaidShare: 0,
    paused: false,
  },
  settings,
  system: {
    environment: 'production',
    owners: ['owner@example.test'],
    ownersMustVerify: true,
    paidPlans: false,
    billing: false,
    media: true,
    email: true,
    appleSignIn: false,
    googleSignIn: true,
    textAI: true,
    videoAI: false,
    voiceAI: true,
    narration: true,
    models: { text: 'openai/gpt-6-luna' },
  },
};
const reportGroup = {
  recipe: {
    id: 'copied',
    title: 'Copied carbonara',
    image: '',
    published: true,
    createdAt: '2026-10-10T10:00:00Z',
  },
  author: {
    id: 'spammer',
    name: 'Sam Spam',
    email: 'sam@example.test',
    avatar: '',
    suspended: false,
  },
  count: 3,
  latestAt: '2026-10-15T09:00:00Z',
  reports: [
    {
      id: 'r1',
      reason: 'Copied from another blog',
      status: 'open',
      createdAt: '2026-10-15T09:00:00Z',
      resolution: '',
      resolvedAt: null,
      resolvedBy: null,
      reporter: { id: 'cook', name: 'Alex', email: 'alex@example.test', avatar: '' },
    },
  ],
};

async function mockAPI(page: Page, user: typeof member, announcement: unknown = null) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    const fulfill = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method !== 'GET') writes.push({ method, path, body: route.request().postDataJSON() });
    if (path === '/me/onboarded') return fulfill(Object.assign(user, { onboarded: true }));
    if (path === '/me') return fulfill(user);
    if (path === '/capabilities')
      return fulfill({ textAI: false, voiceAI: false, recipeChat: false, announcement });
    if (path === '/library')
      return fulfill({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return fulfill({ plans: [], groceries: [], pantry: [] });
    if (path.startsWith('/admin/') && !user.admin)
      return fulfill({ error: 'The admin console is for Savorly admins.' }, 403);
    if (path === '/admin/overview') return fulfill(overview);
    if (path === '/admin/reports')
      return fulfill(
        url.searchParams.get('status') === 'open' &&
          !writes.some((w) => w.path.endsWith('/reports'))
          ? { items: [reportGroup], total: 1, offset: 0, limit: 50 }
          : { items: [], total: 0, offset: 0, limit: 50 },
      );
    if (path === '/admin/recipes/copied/reports') return fulfill({ id: 'copied' });
    if (path === `/admin/users/${user.id}/setup`) {
      Object.assign(user, { onboarded: false });
      return fulfill({ ...user, onboarded: false });
    }
    if (path === '/admin/settings')
      return fulfill({
        settings: method === 'PUT' ? route.request().postDataJSON() : settings,
        defaults: { aiDailyBudgetUSD: 25, aiFreeDailyBudgetUSD: 5 },
        updatedAt: null,
        updatedBy: null,
      });
    return fulfill([]);
  });
  return writes;
}

test('members never see the admin console', async ({ page }) => {
  await mockAPI(page, { ...member, adminPending: true });
  await page.goto('/');
  await expect(page.getByText('What would you like to cook today?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Admin console' })).toHaveCount(0);
  await page.goto('/?page=admin');
  await expect(page.getByText('Admins only')).toBeVisible();
  // An owner's address that isn't verified yet explains how to open the console.
  await expect(page.getByText(/is an admin address, but it isn’t verified yet/)).toBeVisible();
});

test('admins review reports and change operator settings', async ({ page }) => {
  const writes = await mockAPI(page, owner);
  await page.goto('/');
  await page.getByRole('button', { name: 'Admin console' }).click();
  await expect(page.getByText('Admin console', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Signed in as owner@example.test · owner.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Open reports')).toBeVisible();
  await expect(page.getByText('$21.50 of $25.00')).toBeVisible();
  await expect(page.getByText('Nearly at the limit')).toBeVisible();

  await page.getByRole('button', { name: 'Reports · 1' }).click();
  await expect(page).toHaveURL(/tab=reports/);
  await expect(page.getByText('Copied carbonara')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByLabel('Note for other admins (optional)').fill('Checked: it is original.');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).last().click();
  await expect
    .poll(() => writes.find((w) => w.path === '/admin/recipes/copied/reports')?.body)
    .toEqual({ status: 'dismissed', note: 'Checked: it is original.' });
  await expect(page.getByText('Nothing to review. The queue is clear.')).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Pause all AI features' }).click();
  await page.getByLabel('Daily AI budget for everyone (USD)').fill('12.5');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect
    .poll(() => writes.find((w) => w.path === '/admin/settings')?.body)
    .toMatchObject({ aiPaused: true, aiDailyBudgetUSD: 12.5, aiFreeDailyBudgetUSD: null });
  await expect(page.getByText('Settings saved. They apply from the next request.')).toBeVisible();
});

test('an announcement shows to everyone until it is dismissed', async ({ page }) => {
  await mockAPI(page, member, { text: 'Maintenance tonight at 22:00 UTC.', tone: 'warning' });
  await page.goto('/');
  await expect(page.getByText('Maintenance tonight at 22:00 UTC.')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss announcement' }).click();
  await expect(page.getByText('Maintenance tonight at 22:00 UTC.')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('What would you like to cook today?')).toBeVisible();
  await expect(page.getByText('Maintenance tonight at 22:00 UTC.')).toHaveCount(0);
});

test('admins replay the kitchen setup and the welcome to try them', async ({ page }) => {
  const me = { ...owner, onboarded: true };
  const writes = await mockAPI(page, me);
  await page.goto('/?page=admin&tab=settings');
  await expect(page.getByText('Test onboarding', { exact: true })).toBeVisible();

  // The setup opens at once, and skipping through it marks it done again.
  await page.getByRole('button', { name: 'Replay my kitchen setup' }).click();
  await expect(page.getByText('Set up your kitchen', { exact: true })).toBeVisible();
  for (const next of ['How do you like to eat?', 'Cooks to follow']) {
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByText(next, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.getByText('Set up your kitchen', { exact: true })).toHaveCount(0);
  expect(writes.map((w) => w.path)).toEqual(
    expect.arrayContaining(['/admin/users/owner/setup', '/me/onboarded']),
  );

  // The welcome needs a signed-out device, even on the web where it otherwise never shows.
  await page.getByRole('button', { name: 'Replay the welcome' }).click();
  await expect(page.getByText('Welcome to Savorly', { exact: true })).toBeVisible();
  expect(writes.some((w) => w.path === '/auth/logout')).toBe(true);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Look around first' }).click();
  await expect(page.getByText('Welcome to Savorly', { exact: true })).toHaveCount(0);
});
