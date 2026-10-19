import { expect, Page, test } from '@playwright/test';
import { alex, json, mockApi, MockOptions, recipe } from './mockApi';
import type { Earnings } from '../src/lib/creatorFund';
import { afterPageTimers } from './waits';

// The creator fund (docs/CREATOR-FUND.md): My kitchen's "Creator earnings" for cooks with
// published recipes while the fund is on, payout setup through Stripe in the browser, the real
// cook time on recipe pages (docs/COOK-TESTED.md has the rest of what they show), and the cook
// sessions cooking mode records.

const mine = recipe({ id: 'my-soup', title: 'My soup', author: alex });
const earnings = (fields: Partial<Earnings> = {}): Earnings => ({
  month: '2026-10-01',
  cooks: 4,
  estimateCents: 684,
  balanceCents: 1230,
  paidCents: 4000,
  sharePercent: 20,
  minimumCents: 1000,
  history: [
    { month: '2026-09-01', amountCents: 1230, cooks: 7, status: 'pending', paidAt: null },
    {
      month: '2026-08-01',
      amountCents: 4000,
      cooks: 1,
      status: 'paid',
      paidAt: '2026-09-02T10:00:00Z',
    },
  ],
  payouts: { connected: false, enabled: false, detailsSubmitted: false, held: false, country: '' },
  countries: ['DE', 'FR', 'GB', 'US'],
  ...fields,
});
const creator: MockOptions = {
  capabilities: { creatorFund: true },
  recipes: [mine],
  library: { recipes: [mine], ownIds: [mine.id], publishedCount: 1 },
};
const card = (page: Page) =>
  page.getByRole('heading', { name: 'Creator earnings', exact: true }).locator('../../..');

test('a creator sees this month, what’s waiting and paid, and sets up payouts in the browser', async ({
  page,
}) => {
  const api = await mockApi(page, creator);
  api.on('GET', '/me/earnings', () => json(earnings()));
  api.on('POST', '/me/payouts/onboarding', () =>
    json({ url: 'https://connect.stripe.test/onboarding', kind: 'onboarding' }),
  );
  await page.route('https://connect.stripe.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Stripe onboarding</h1>' }),
  );
  await page.goto('/?page=profile');
  const box = card(page);
  await expect(
    box.getByText(
      'Each month, 20% of what members pay goes to the cooks whose recipes they actually cooked.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(box.getByText('Verified cooks this month', { exact: true })).toBeVisible();
  await expect(box.getByText('4', { exact: true })).toBeVisible();
  await expect(box.getByText('$6.84', { exact: true })).toBeVisible();
  await expect(box.getByText('Waiting to be paid', { exact: true }).locator('..')).toContainText(
    '$12.30',
  );
  await expect(box.getByText('Paid so far', { exact: true }).locator('..')).toContainText('$40.00');
  await expect(
    box.getByText('Each month is added up once it ends. Payouts go out once you have $10.00.', {
      exact: true,
    }),
  ).toBeVisible();
  const september = box.getByText('September 2026', { exact: true }).locator('../..');
  await expect(september).toContainText('7 cooks by paying members');
  await expect(september).toContainText('Pending');
  await expect(box.getByText('August 2026', { exact: true }).locator('../..')).toContainText(
    '1 cook by a paying member',
  );
  // The browser says en-US, so payouts go to the United States unless the creator changes it.
  await expect(box.getByText('Payouts to United States', { exact: true })).toBeVisible();
  await box.getByRole('button', { name: 'Change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Where should payouts go?' });
  await dialog.getByRole('button', { name: 'France', exact: true }).click();
  await expect(box.getByText('Payouts to France', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/creator-earnings.png' });
  await box.getByRole('button', { name: 'Set up payouts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stripe onboarding' })).toBeVisible();
  expect(api.sentTo('/me/payouts/onboarding')).toEqual([['POST', { country: 'FR' }]]);
});

test.describe('in a country Stripe can’t pay out to', () => {
  test.use({ locale: 'ko-KR' });
  test('the card says so and payouts can’t be set up there', async ({ page }) => {
    const api = await mockApi(page, creator);
    api.on('GET', '/me/earnings', () => json(earnings()));
    await page.goto('/?page=profile');
    const box = card(page);
    await expect(box.getByText('Payouts to South Korea', { exact: true })).toBeVisible();
    await expect(
      box.getByText(
        "Stripe can't send payouts to your country yet, so payouts aren't available there.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(box.getByRole('button', { name: 'Set up payouts', exact: true })).toBeDisabled();
  });
});

test('back from Stripe, the card re-reads the payout account and offers the dashboard', async ({
  page,
}) => {
  const api = await mockApi(page, creator);
  const ready = earnings({
    payouts: { connected: true, enabled: true, detailsSubmitted: true, held: false, country: 'FR' },
  });
  api.on('GET', '/me/earnings', () => json(ready));
  await page.goto('/?page=profile&payouts=done');
  await expect(
    page.getByText('Thanks. Payouts start once Stripe has checked your details.', { exact: true }),
  ).toBeVisible();
  const box = card(page);
  await expect(box.getByText('Payouts are on', { exact: true })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Manage payouts', exact: true })).toBeVisible();
  expect(
    api.requests.some((r) => r.path === '/me/earnings' && r.query.get('refresh') === 'true'),
  ).toBe(true);
  await expect(page).toHaveURL(/\/\?page=profile$/);
});

test('a held creator is told, and nobody else sees the card', async ({ page }) => {
  const api = await mockApi(page, creator);
  api.on('GET', '/me/earnings', () =>
    json(earnings({ payouts: { ...earnings().payouts, connected: true, held: true } })),
  );
  await page.goto('/?page=profile');
  await expect(
    card(page).getByText(
      'Your payouts are on hold. Contact Savorly support if you think this is a mistake.',
      { exact: true },
    ),
  ).toBeVisible();
  // Without published recipes, or with the fund off, there's no card and no request for it.
  for (const options of [
    { ...creator, library: { publishedCount: 0 } },
    { ...creator, capabilities: { creatorFund: false } },
  ]) {
    const other = await page.context().newPage();
    const quiet = await mockApi(other, options);
    await other.goto('/?page=profile');
    await expect(
      other.getByRole('button', { name: 'Edit your profile', exact: true }),
    ).toBeVisible();
    await expect(other.getByRole('heading', { name: 'Creator earnings' })).toHaveCount(0);
    expect(quiet.requests.some((r) => r.path === '/me/earnings')).toBe(false);
    await other.close();
  }
});

test('the recipe page shows how long cooks usually take once enough have cooked it', async ({
  page,
}) => {
  const timed = recipe({
    id: 'braise',
    title: 'Braise',
    minutes: 30,
    verifiedCooks: 12,
    cookedMinutes: 45,
  });
  const fresh = recipe({
    id: 'new-braise',
    title: 'New braise',
    minutes: 30,
    verifiedCooks: 2,
    cookedMinutes: null,
  });
  await mockApi(page, { recipes: [timed, fresh] });
  await page.goto(`/?recipe=${timed.id}`);
  // Cook-tested from 5 verified cooks, with the stated time beside theirs when it differs.
  const tested = 'Cook-tested · 12 cooks · usually 45 min (says 30)';
  await expect(page.getByText(tested, { exact: true })).toBeVisible();
  await expect(page.getByText('30 min', { exact: true }).first()).toBeVisible();
  await afterPageTimers(page, 1500); // the splash fades out
  await page.screenshot({ path: 'test-results/cook-time-desktop.png' });
  // Phones lay the page out on their own, under the same facts.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText(tested, { exact: true })).toBeVisible();
  await afterPageTimers(page, 1500);
  await page.screenshot({ path: 'test-results/cook-time-mobile.png' });
  await page.goto(`/?recipe=${fresh.id}`);
  await expect(page.getByRole('heading', { name: 'New braise', exact: true })).toBeVisible();
  await expect(page.getByText('Early: 2 cooks', { exact: true })).toBeVisible();
  await expect(page.getByText(/Cooks usually take|Cook-tested/)).toHaveCount(0);
});

test('cooking mode records a session for a signed-in cook, and nothing for guests or authors', async ({
  page,
}) => {
  const soup = recipe({
    id: 'soup',
    title: 'Soup',
    steps: [
      { title: 'Chop', text: 'Chop everything.', seconds: 0 },
      { title: 'Simmer', text: 'Simmer it all.', seconds: 0 },
    ],
  });
  const own = recipe({ ...soup, id: 'own-soup', title: 'Own soup', author: alex });
  const api = await mockApi(page, { recipes: [soup, own] });
  api.on('POST', '/recipes/soup/cook-sessions', () => json({ id: 'session-1' }, 201));
  const cook = async (id: string) => {
    await page.goto(`/?recipe=${id}`);
    await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
    await page.getByRole('button', { name: 'Next step', exact: true }).click();
    await page.getByRole('button', { name: 'Finish cooking', exact: true }).click();
    await expect(page.getByText('Dinner is served.', { exact: true })).toBeVisible();
  };
  await cook(soup.id);
  await expect
    .poll(() => api.sentTo(/^\/(recipes\/soup\/cook-sessions|cook-sessions\/session-1)$/))
    .toEqual([
      ['POST', undefined],
      ['PATCH', { step: 2 }],
      ['PATCH', { step: 2, finished: true }],
    ]);
  await cook(own.id);
  api.state.session = false;
  await cook(soup.id);
  expect(api.sentTo(/^\/(recipes\/[^/]+\/cook-sessions|cook-sessions\/[^/]+)$/)).toHaveLength(3);
});
