import { expect, Page, test } from '@playwright/test';
import type {
  AdminRecipe,
  CookAlongs,
  CookingMetrics,
  FundWeeks,
  Overview,
} from '../src/lib/admin';
import { json, mockApi } from './mockApi';

// The console's Cooking section (docs/ADMIN.md): plan section 10's metrics, the creator fund's
// weekly report, the cook-along's weeks and the founding creators' rotation; and the paid-cooks
// signals in the Overview's fund panel. The API is mocked.

const owner = {
  id: 'owner',
  name: 'Olive',
  handle: 'olive',
  email: 'owner@example.test',
  admin: true,
  adminOwner: true,
};
const maya = { id: 'maya', name: 'Maya', email: 'maya@example.test' };
const tom = { id: 'tom', name: 'Tom', email: 'tom@example.test' };
const at = '2026-10-15T09:00:00Z';
const metrics: CookingMetrics = {
  cooksPerActive: { cooks: 50, active: 20 },
  finishRate: { started: 40, finished: 30 },
  payingCooked: { month: '2026-10-01', paying: 10, cooked: 8 },
  creatorsOver25: { month: '2026-09-01', creators: 3 },
  retention: { cohort: 0, retained: 0, recordedSince: '2026-10-01T00:00:00Z' },
  aiCost: { members: 10, spend: 21, perMember: 2.1, shareOfCap: 0.55 },
};
const weeks: FundWeeks = {
  weeks: [
    {
      week: '2026-10-12',
      current: true,
      cooks: 14,
      payingMembers: 5,
      poolCents: 855,
      top: [{ ...maya, cooks: 9 }],
      flaggedMembers: 1,
      flaggedCreators: [tom],
    },
    {
      week: '2026-10-05',
      current: false,
      cooks: 3,
      payingMembers: 2,
      poolCents: 342,
      top: [],
      flaggedMembers: 0,
      flaggedCreators: [],
    },
  ],
  threshold: 4,
  sharePercent: 20,
};
// This week is open, and Maya is next in the rotation; Tom has a week scheduled ahead.
const cookAlongs = (): CookAlongs => ({
  week: '2026-10-12',
  announcedWeek: '2026-10-05',
  weeks: [
    {
      week: '2026-10-05',
      updatedAt: at,
      automatic: true,
      scheduledBy: null,
      creator: maya,
      recipe: {
        id: 'tart',
        title: 'Lemon tart',
        image: '',
        published: true,
        author: { ...maya, suspended: false, founding: true },
      },
      cooks: 12,
      started: 30,
    },
    {
      week: '2026-10-19',
      updatedAt: at,
      automatic: false,
      scheduledBy: owner.email,
      creator: tom,
      recipe: {
        id: 'stew',
        title: 'Bean stew',
        image: '',
        published: true,
        author: { ...tom, suspended: false, founding: true },
      },
      cooks: 0,
      started: 0,
    },
  ],
  rotation: [
    {
      ...maya,
      avatar: '',
      foundingAt: '2026-09-01T00:00:00Z',
      lastWeek: '2026-10-05',
      recipes: [
        { id: 'shakshuka', title: 'Shakshuka', image: '', saveCount: 7, featuredWeek: null },
        { id: 'tart', title: 'Lemon tart', image: '', saveCount: 9, featuredWeek: '2026-10-05' },
      ],
    },
    {
      ...tom,
      avatar: '',
      foundingAt: '2026-09-02T00:00:00Z',
      lastWeek: '2026-10-19',
      recipes: [
        { id: 'stew', title: 'Bean stew', image: '', saveCount: 2, featuredWeek: '2026-10-19' },
      ],
    },
  ],
  next: 'maya',
});

async function console(page: Page, tab: string) {
  const api = await mockApi(page, { user: owner, capabilities: { creatorFund: true } });
  api.on('GET', '/admin/overview', () => json(overview));
  api.on('GET', '/admin/cooking', () => json(metrics));
  api.on('GET', '/admin/fund/weeks', () => json(weeks));
  api.on('GET', '/admin/cook-alongs', () => json(cookAlongs()));
  api.on('PUT', /^\/admin\/cook-alongs\/([\d-]+)$/, () => json(cookAlongs()));
  api.on('DELETE', /^\/admin\/cook-alongs\/([\d-]+)$/, () => json(cookAlongs()));
  const listed: AdminRecipe = {
    id: 'soup',
    title: 'Plain soup',
    image: '',
    cuisine: 'Italian',
    published: true,
    aiGenerated: false,
    video: false,
    createdAt: at,
    updatedAt: at,
    author: {
      id: 'sam',
      name: 'Sam',
      email: 'sam@example.test',
      avatar: '',
      handle: 'sam',
      suspended: false,
    },
    rating: 0,
    reviewCount: 0,
    saveCount: 4,
    openReports: 0,
    reportCount: 0,
  };
  api.on('GET', '/admin/recipes', () => json({ items: [listed], total: 1, offset: 0, limit: 50 }));
  await page.goto(`/?page=admin&tab=${tab}`);
  return api;
}

test('the Cooking section shows the numbers that say whether members cook', async ({ page }) => {
  await console(page, 'cooking');
  await expect(page.getByText('Is it working?', { exact: true })).toBeVisible();
  for (const [label, value] of [
    ['Verified cooks per active member', '2.5'],
    ['Cooking-mode finish rate', '75%'],
    ['Paying members who cooked', '80%'],
    ['Creators earning over $25', '3'],
    ['Month-3 retention of paying members', '–'],
    ['AI cost per paying member', '$2.10'],
  ])
    await expect(
      page.getByText(label, { exact: true }).locator('..').getByText(value, { exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText(/^Not measured yet: nobody started paying 90 to 120 days ago/),
  ).toBeVisible();
  await expect(page.getByText(/^55% of their plan’s cap on average/)).toBeVisible();
  // The weekly fund report.
  await expect(page.getByText('Creator fund, week by week', { exact: true })).toBeVisible();
  await expect(
    page.getByText('$8.55 added to the pool · 14 verified cooks · 5 paying members cooked', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Most cooked by paying members: Maya (9)', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('1 one-creator member', { exact: true })).toBeVisible();
});

test('a week is scheduled from the founding creators’ recipes, and cleared back to the rotation', async ({
  page,
}) => {
  const api = await console(page, 'cooking');
  await expect(
    page.getByText('Open: the rotation gives it to Maya, with “Shakshuka”, within minutes.', {
      exact: true,
    }),
  ).toBeVisible();
  // Later open weeks aren't decided yet, so they say nothing; Tom's week is scheduled.
  await expect(page.getByText(/^Open: /)).toHaveCount(1);
  await expect(
    page.getByText('“Bean stew” by Tom · founding creator', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Scheduled by owner@example.test', { exact: true })).toBeVisible();
  // The rotation, in turn order.
  await expect(
    page.getByText('Last turn: the week of Oct 5 · their turn offers “Shakshuka” (7 saves)', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Schedule the week of Oct 12', exact: true }).click();
  const picker = page.getByRole('dialog');
  await expect(picker.getByText('Maya · founding creator', { exact: true })).toBeVisible();
  await expect(
    picker.getByText('9 saves · featured the week of Oct 5', { exact: true }),
  ).toBeVisible();
  await picker.getByRole('button', { name: 'Feature Shakshuka', exact: true }).click();
  await expect(
    page.getByText('“Shakshuka” is the cook-along for the week of Oct 12.', { exact: true }),
  ).toBeVisible();
  // Any public recipe can be picked too.
  await page.getByRole('button', { name: 'Schedule the week of Oct 12', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Feature Plain soup', exact: true })
    .click();
  await expect(
    page.getByText('“Plain soup” is the cook-along for the week of Oct 12.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear the week of Oct 19', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Clear the week of Oct 19?', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear the week', exact: true }).click();
  await expect(
    page.getByText('The week of Oct 19 is back with the rotation.', { exact: true }),
  ).toBeVisible();
  expect(
    api.requests
      .filter((r) => r.method !== 'GET' && r.path.startsWith('/admin/'))
      .map((r) => [r.method, r.path, r.body]),
  ).toEqual([
    ['PUT', '/admin/cook-alongs/2026-10-12', { recipeId: 'shakshuka' }],
    ['PUT', '/admin/cook-alongs/2026-10-12', { recipeId: 'soup' }],
    ['DELETE', '/admin/cook-alongs/2026-10-19', undefined],
  ]);
});

test('the fund panel flags members whose every cook goes to one creator', async ({ page }) => {
  const api = await mockApi(page, { user: owner, capabilities: { creatorFund: true } });
  api.on('GET', '/admin/overview', () => json(overview));
  api.on('GET', '/admin/insights', () =>
    json({ days: 7, topSearches: [], zeroResultSearches: [], onboarding: [], events: [] }),
  );
  api.on('GET', '/admin/fund', () =>
    json({
      enabled: true,
      sharePercent: 20,
      minimumCents: 1000,
      current: {
        month: '2026-10-01',
        poolCents: 513,
        members: 3,
        cooks: 12,
        creators: 1,
        leaders: [],
      },
      months: [],
      unpaidCents: 2500,
      paidCents: 0,
      payouts: { sending: 0, failed7d: 0, paid30dCents: 0 },
      accounts: { connected: 1, enabled: 1, held: 0 },
      firstPayoutsWaiting: 1,
      flags: {
        threshold: 4,
        members: [
          {
            id: 'ring',
            name: 'Ring cook',
            email: 'ring@example.test',
            cooks: 5,
            cents: 171,
            creator: tom,
          },
        ],
        creators: [{ ...tom, estimateCents: 300, flaggedCents: 171, members: 1 }],
      },
    }),
  );
  await page.goto('/?page=admin');
  await expect(page.getByText('Paid-cooks signals', { exact: true })).toBeVisible();
  await expect(
    page.getByText("ring@example.test · 5 verified cooks, all of Tom's recipes · $1.71 to them", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('tom@example.test · $1.71 of $3.00 this month from 1 such member', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('$0.00 paid in all · 1 first payout waiting 60 days', { exact: true }),
  ).toBeVisible();
});

const overview: Overview = {
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
    migration: '038_cook_along_and_founding_creators.sql',
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
  settings: {
    aiPaused: false,
    aiDailyBudgetUSD: null,
    aiFreeDailyBudgetUSD: null,
    signupsPaused: false,
    announcement: '',
    announcementTone: 'info',
  },
  system: {
    environment: 'development',
    owners: ['owner@example.test'],
    ownersMustVerify: false,
    paidPlans: true,
    billing: true,
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
