import { test, expect } from '@playwright/test';

// The admin Overview's Insights panel (GET /admin/insights), against a mocked API.
const owner = {
  id: 'owner',
  name: 'Owner',
  handle: 'owner',
  bio: '',
  avatar: '',
  email: 'owner@example.test',
  preferences: { diets: [], allergies: [] },
  hasPassword: true,
  identities: [],
  plan: 'free',
  admin: true,
  adminOwner: true,
  adminPending: false,
  onboarded: true,
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
      total: 4,
      new24h: 0,
      new7d: 1,
      new30d: 2,
      verified: 3,
      suspended: 0,
      admins: 1,
      withPassword: 4,
      active7d: 2,
    },
    samples: 0,
    plans: { free: 4 },
    comped: 0,
    identities: {},
    recipes: { published: 3, drafts: 1, aiGenerated: 0, new7d: 1, withVideo: 0 },
    community: { reviews: 1, reviews7d: 1, follows: 2, saves: 3, cookbooks: 1, mealPlans: 0 },
    reports: { open: 0, recipes: 0 },
    jobs: {
      queued: 0,
      running: 0,
      processing: 0,
      failed24h: 0,
      completed24h: 0,
      oldestQueuedSeconds: 0,
    },
    assistant: { queued: 0, running: 0, failed24h: 0, turns24h: 0 },
    conversations: { total: 0, active7d: 0 },
    voiceLive: 0,
    spend: { last24h: 0, free24h: 0, last7d: 0, last30d: 0 },
    spendBySource: { media: 0, tools: 0, assistant: 0, narration: 0, voice: 0 },
    migration: '021_engagement.sql',
    databaseBytes: 12_000_000,
  },
  series: [{ day: '2026-10-16', signups: 1, recipes: 1, jobs: 0, spend: 0 }],
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
    environment: 'development',
    owners: ['owner@example.test'],
    ownersMustVerify: false,
    paidPlans: false,
    billing: false,
    media: true,
    email: false,
    appleSignIn: false,
    googleSignIn: false,
    textAI: false,
    videoAI: false,
    voiceAI: false,
    narration: false,
    models: {},
  },
};
const week = {
  days: 7,
  topSearches: [
    { query: 'lemon pasta', count: 12 },
    { query: 'natto', count: 3 },
  ],
  zeroResultSearches: [{ query: 'natto', count: 3 }],
  onboarding: [
    { step: 'photo', count: 9 },
    { step: 'tastes', count: 7 },
    { step: 'done', count: 5 },
    { step: 'skipped', count: 2 },
  ],
  events: [
    { name: 'search', count: 15 },
    { name: 'recipe_open', count: 8 },
  ],
};
const month = {
  days: 30,
  topSearches: [{ query: 'borscht', count: 40 }],
  zeroResultSearches: [],
  onboarding: [],
  events: [{ name: 'search', count: 40 }],
};

test('the overview shows what people search for and where the setup loses them', async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/v1/, '');
    const fulfill = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me' || path === '/session')
      return fulfill(path === '/me' ? owner : { user: owner });
    if (path === '/capabilities')
      return fulfill({ textAI: false, voiceAI: false, recipeChat: false });
    if (path === '/library')
      return fulfill({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return fulfill({ plans: [], groceries: [], pantry: [] });
    if (path === '/admin/overview') return fulfill(overview);
    if (path === '/admin/insights') {
      asked.push(url.searchParams.get('days') || '');
      return fulfill(url.searchParams.get('days') === '30' ? month : week);
    }
    return fulfill([]);
  });
  await page.goto('/?page=admin');
  await expect(page.getByText('Insights', { exact: true })).toBeVisible();
  await expect(page.getByLabel('lemon pasta: 12')).toBeVisible();
  await expect(page.getByText('Searches that found nothing', { exact: true })).toBeVisible();
  await expect(page.getByLabel('natto: 3')).toHaveCount(2);
  await expect(page.getByLabel('Step: photo: 9')).toBeVisible();
  await expect(page.getByLabel('Finished the setup: 5')).toBeVisible();
  await expect(page.getByLabel('Skipped the setup: 2')).toBeVisible();
  await expect(page.getByLabel('Searches: 15')).toBeVisible();
  await expect(page.getByLabel('Recipes opened: 8')).toBeVisible();

  await page.getByRole('tab', { name: '30 days', exact: true }).click();
  await expect(page.getByLabel('borscht: 40')).toBeVisible();
  await expect(page.getByText('Every search found something.')).toBeVisible();
  await expect(page.getByText('Nobody started the setup.')).toBeVisible();
  expect(asked).toEqual(['7', '30']);
});
