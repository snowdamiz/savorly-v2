import { expect, test, type Page } from '@playwright/test';
import type { Billing, PricePlan } from '../src/lib/types';
import { failure, json, mockApi } from './mockApi';

// Billing members can trust (docs/PRICING.md#cancelling-renewals-and-refunds): the plan card says
// what the plan costs and when it renews, what's used of each allowance and when it frees up,
// cancels in two taps, keeps in one, and offers a yearly plan's refund while it applies.

const plans: PricePlan[] = [
  {
    id: 'free',
    monthlyUSD: 0,
    yearlyUSD: 0,
    assistant: 10,
    voiceMinutes: 2,
    images: 1,
    videos: 0,
    narration: 5,
    cookQuestions: 30,
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
    cookQuestions: 100,
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
    cookQuestions: 150,
  },
];
const usage = {
  assistant: 0,
  voiceSeconds: 0,
  images: 0,
  videos: 0,
  narration: 0,
  cookQuestions: 0,
};
/** Alex's own yearly Pro plan, renewing on 2 March 2027, shared with one housemate. */
const yearlyPro = (fields: Partial<Billing> = {}): Billing => ({
  plan: 'pro',
  status: 'active',
  interval: 'yearly',
  renewsAt: '2027-03-02T10:00:00Z',
  cancels: false,
  usage: { ...usage, assistant: 130, voiceSeconds: 61, images: 3 },
  plans,
  checkout: true,
  manage: true,
  sharedBy: null,
  sharedWith: 1,
  cancelable: true,
  refund: null,
  usageFreesAt: { assistant: '2026-11-04T09:00:00Z', voiceSeconds: '2026-10-20T09:00:00Z' },
  ...fields,
});
const free: Billing = {
  ...yearlyPro(),
  plan: 'free',
  status: 'canceled',
  interval: 'yearly',
  renewsAt: null,
  usage,
  sharedWith: 0,
  cancelable: false,
  usageFreesAt: {},
};

async function kitchen(page: Page, billing: Billing) {
  const api = await mockApi(page, {
    user: { plan: billing.plan },
    capabilities: { plans: true, billing: true },
  });
  const state = { billing };
  api.on('GET', '/billing', () => json(state.billing));
  return { api, state };
}
const dialog = (page: Page) => page.getByRole('dialog');

test('a yearly plan says what it costs, cancels in two taps and is kept in one', async ({
  page,
}) => {
  const { api, state } = await kitchen(page, yearlyPro());
  api.on('POST', '/billing/cancel', () => {
    state.billing = { ...state.billing, cancels: true };
    return json(state.billing);
  });
  api.on('POST', '/billing/resume', () => {
    state.billing = { ...state.billing, cancels: false };
    return json(state.billing);
  });
  const renews = page.getByText(
    'Renews Mar 2, 2027 at $159.99 a year. We’ll remind you a week before.',
    { exact: true },
  );
  await page.goto('/?page=settings');
  await expect(renews).toBeVisible();
  // Usage against each allowance, and when a used-up one frees up.
  await expect(page.getByText('Used up · more from Nov 4', { exact: true })).toBeVisible();
  await expect(page.getByText('130 of 130 used', { exact: true })).toHaveCount(0);
  await expect(page.getByText('2 of 40 used', { exact: true })).toBeVisible();
  await expect(page.getByText('3 of 10 used', { exact: true })).toBeVisible();

  // The first tap asks, saying what happens and when; nothing is sent until the second.
  await page.getByRole('button', { name: 'Cancel plan', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Cancel your plan?' })).toBeVisible();
  await expect(
    dialog(page).getByText(
      'You keep Pro until Mar 2, 2027, and it won’t renew, so nothing more is charged. Then you’re on Free, and your recipes, cookbooks, plans and lists all stay.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog(page).getByText(
      'The 1 other person in your household who shares it moves to Free then too.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(api.sentTo('/billing/cancel')).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Cancel plan', exact: true }).click();
  await expect(page.getByText('Your plan won’t renew.', { exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page.getByText('Ends Mar 2, 2027 and won’t renew, so nothing more is charged.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(api.sentTo('/billing/cancel')).toEqual([['POST', {}]]);

  // Keeping it is one tap.
  await page.getByRole('button', { name: 'Keep my plan', exact: true }).click();
  await expect(page.getByText('Your plan will renew as before.', { exact: true })).toBeVisible();
  await expect(renews).toBeVisible();
  expect(api.sentTo('/billing/resume')).toEqual([['POST', {}]]);
  await expect(page.getByRole('button', { name: 'Get a refund', exact: true })).toHaveCount(0);
});

test('a refund shows its amount and last day, and asks before it ends the plan', async ({
  page,
}) => {
  const { api, state } = await kitchen(
    page,
    yearlyPro({
      sharedWith: 0,
      refund: { until: '2026-10-29T10:00:00Z', amountCents: 17279, currency: 'usd' },
    }),
  );
  let tries = 0;
  api.on('POST', '/billing/refund', () => {
    // The first try meets a refund already under way; the error stays in the dialog.
    if (++tries === 1) return failure(409, 'Your refund is already on its way.');
    state.billing = free;
    return json(free);
  });
  await page.goto('/?page=settings');
  await expect(
    page.getByText('Changed your mind? Get the full $172.79 back until Oct 29, 2026.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Get a refund', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Refund $172.79?' })).toBeVisible();
  await expect(
    dialog(page).getByText(
      'You get $172.79 back the way you paid; banks usually show it within 5 to 10 days. Your Pro plan ends now and you’re on Free straight away, and your recipes, cookbooks, plans and lists all stay.',
      { exact: true },
    ),
  ).toBeVisible();
  const confirm = dialog(page).getByRole('button', { name: 'Refund and end my plan', exact: true });
  await confirm.click();
  await expect(
    dialog(page).getByText('Your refund is already on its way.', { exact: true }),
  ).toBeVisible();
  await confirm.click();
  await expect(page.getByText('Refunded. You’re on Free now.', { exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel plan', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Get a refund', exact: true })).toHaveCount(0);
  expect(api.sentTo('/billing/refund')).toEqual([
    ['POST', {}],
    ['POST', {}],
  ]);
});

test('a refund Stripe couldn’t price still says until when', async ({ page }) => {
  await kitchen(page, yearlyPro({ refund: { until: '2026-10-29T10:00:00Z' } }));
  await page.goto('/?page=settings');
  await expect(
    page.getByText('Changed your mind? Get this year’s payment back in full until Oct 29, 2026.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Get a refund', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Get a refund?' })).toBeVisible();
});

test('a plan Savorly gave offers nothing to cancel or refund', async ({ page }) => {
  await kitchen(
    page,
    yearlyPro({
      plan: 'plus',
      interval: '',
      renewsAt: null,
      manage: false,
      sharedWith: 0,
      cancelable: false,
    }),
  );
  await page.goto('/?page=settings');
  await expect(
    page.getByText('Savorly gave you this plan, so there’s nothing to pay.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel plan', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep my plan', exact: true })).toHaveCount(0);
});

test('renewal reminders have their own switch while plans are on', async ({ page }) => {
  const { api } = await kitchen(page, yearlyPro());
  api.on('PATCH', '/me/preferences', ({ body }) => {
    const { notifications } = body as { notifications: Record<string, boolean> };
    const preferences = api.state.user.preferences;
    preferences.notifications = { ...preferences.notifications, ...notifications };
    return json(api.state.user);
  });
  await page.goto('/?page=settings');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const renewals = page.getByRole('switch', { name: 'Renewal reminders', exact: true });
  await expect(renewals).toHaveAttribute('aria-checked', 'true');
  await renewals.click();
  await expect(renewals).toHaveAttribute('aria-checked', 'false');
  expect(api.sentTo('/me/preferences')).toEqual([
    ['PATCH', { notifications: { renewals: false } }],
  ]);
});
