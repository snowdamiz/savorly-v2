import { expect, Page, test } from '@playwright/test';
import type { Creator, Grocery, Household, HouseholdMember } from '../src/lib/types';

test.use({ timezoneId: 'UTC' });
const NOW = new Date('2026-10-16T12:00:00Z');

const cook: Creator = {
  id: 'me',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  recipeCount: 0,
  followerCount: 0,
};
const member = (id: string, name: string, role: HouseholdMember['role']): HouseholdMember => ({
  id,
  name,
  handle: name.toLowerCase(),
  avatar: '',
  role,
});
const grocery = (id: string, name: string, addedBy: Grocery['addedBy']): Grocery => ({
  id,
  name,
  quantity: '1',
  category: 'Produce',
  checked: false,
  addedBy,
});
// The household Sam owns, which the code ABCD2345 joins.
const rossi = (): Household => ({
  id: 'rossi',
  name: 'The Rossi kitchen',
  role: 'member',
  members: [member('sam', 'Sam', 'owner'), member('me', 'Alex', 'member')],
});

type Server = { household: Household | null; groceries: Grocery[] };

/** A signed-in kitchen; `server` is the server's copy, which the household routes change. */
async function kitchen(page: Page, server: Server) {
  const requests: string[] = [];
  const bodies: Record<string, unknown> = {};
  await page.clock.install({ time: NOW });
  // A share sheet that records what it was given.
  await page.addInitScript(() => {
    const shared: ShareData[] = [];
    Object.assign(window, { shared });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        return Promise.resolve();
      },
    });
  });
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    requests.push(`${method} ${path}`);
    const body = route.request().postDataJSON();
    if (body) bodies[`${method} ${path}`] = body;
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/me' || path === '/session') {
      const user = {
        ...cook,
        email: 'alex@example.test',
        preferences: { diets: [], allergies: [] },
        identities: [],
        hasPassword: true,
        plan: 'free',
        onboarded: true,
      };
      return reply(path === '/session' ? { user } : user);
    }
    if (path === '/capabilities') return reply({});
    if (path === '/library')
      return reply({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen')
      return reply({ plans: [], groceries: structuredClone(server.groceries), pantry: [] });
    if (path === '/household' && method === 'GET') return reply(server.household);
    if (path === '/household' && method === 'POST') {
      server.household = {
        id: 'flat',
        name: body.name,
        role: 'owner',
        members: [member('me', 'Alex', 'owner')],
      };
      return reply(server.household);
    }
    if (path === '/household/invite' && method === 'POST')
      return reply({ code: 'K7M2Q9XA', expiresAt: '2026-10-23T12:00:00Z' });
    if (path === '/household/join' && method === 'POST') {
      if (server.household)
        return reply({ error: 'You’re already in a household. Leave it to join another.' }, 409);
      if (body.code !== 'ABCD2345')
        return reply({ error: 'That invite code isn’t valid or has expired.' }, 404);
      server.household = rossi();
      server.groceries = [
        grocery('g1', 'Basil', { id: 'sam', name: 'Sam' }),
        grocery('g2', 'Bread', { id: 'me', name: 'Alex' }),
      ];
      return reply(server.household);
    }
    if (path.startsWith('/household/members/') && method === 'DELETE') {
      const id = path.split('/').pop();
      const h = server.household;
      if (id === 'me' || !h) server.household = null;
      else server.household = { ...h, members: h.members.filter((m) => m.id !== id) };
      return route.fulfill({ status: 204 });
    }
    return reply([]);
  });
  return { requests, bodies };
}

const shared = (page: Page) =>
  page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared);

async function openGroceries(page: Page) {
  await page.goto('/?page=planner');
  await page.getByRole('tab', { name: /Groceries/ }).click();
}

test('a cook starts a household and invites someone with a code', async ({ page }) => {
  const server: Server = { household: null, groceries: [grocery('g1', 'Lemons', null)] };
  const { requests, bodies } = await kitchen(page, server);
  await openGroceries(page);
  await page.getByRole('button', { name: 'Share your kitchen', exact: true }).click();
  await page.getByRole('textbox', { name: 'Household name', exact: true }).fill('The flat');
  requests.length = 0;
  await page.getByRole('button', { name: 'Create household', exact: true }).click();
  await expect(page.getByText('Alex (you)', { exact: true })).toBeVisible();
  await expect(page.getByText('@alex · Owner', { exact: true })).toBeVisible();
  expect(bodies['POST /household']).toEqual({ name: 'The flat' });
  // The list moved into the household, so the kitchen is fetched again.
  expect(requests.slice(requests.indexOf('POST /household'))).toContain('GET /kitchen');

  await page.getByRole('button', { name: 'Invite someone', exact: true }).click();
  await expect(page.getByText('K7M2Q9XA', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Anyone with this code can join until October 23.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Share code', exact: true }).click();
  await expect
    .poll(async () => (await shared(page)).map((d) => d.text))
    .toEqual(['Join my household on Savorly to share our grocery list. The code is K7M2Q9XA.']);

  // Back on the list, the entry names the household.
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Shared kitchen: The flat', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Just you so far. Invite someone to share your kitchen.', { exact: true }),
  ).toBeVisible();
});

test('joining takes a valid code, and the shared list shows who added what', async ({ page }) => {
  const server: Server = { household: null, groceries: [grocery('g2', 'Bread', null)] };
  const { bodies } = await kitchen(page, server);
  await openGroceries(page);
  await expect(page.getByText('Added by', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Share your kitchen', exact: true }).click();
  const code = page.getByRole('textbox', { name: 'Invite code', exact: true });
  await code.fill('wrong-123');
  // Dashes and lower case don't count; the code is 8 letters and digits.
  await expect(code).toHaveValue('WRONG123');
  await page.getByRole('button', { name: 'Join household', exact: true }).click();
  await expect(
    page.getByText('That invite code isn’t valid or has expired.', { exact: true }),
  ).toBeVisible();

  await code.fill('abcd 2345');
  await page.getByRole('button', { name: 'Join household', exact: true }).click();
  await expect(page.getByText('@sam · Owner', { exact: true })).toBeVisible();
  await expect(page.getByText('@alex · Member', { exact: true })).toBeVisible();
  await expect(page.getByText('Alex (you)', { exact: true })).toBeVisible();
  expect(bodies['POST /household/join']).toEqual({ code: 'ABCD2345' });
  // Only the owner removes people.
  await expect(page.getByRole('button', { name: /^Remove .* from the household$/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Shared kitchen: The Rossi kitchen', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('2 people share this list', { exact: true })).toBeVisible();
  // Sam's basil says who added it; your own bread doesn't.
  await expect(page.getByRole('checkbox').filter({ hasText: 'Basil' })).toContainText(
    'Added by Sam',
  );
  await expect(page.getByRole('checkbox').filter({ hasText: 'Bread' })).not.toContainText(
    'Added by',
  );

  // A member leaving is told what that means.
  await page
    .getByRole('button', { name: 'Shared kitchen: The Rossi kitchen', exact: true })
    .click();
  await page.getByRole('button', { name: 'Leave household', exact: true }).click();
  await expect(
    page.getByText(
      'You’ll stop seeing the shared kitchen and start an empty one of your own. You can join again with a new code.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
});

test('joining from a kitchen that is already in a household shows that household', async ({
  page,
}) => {
  const server: Server = { household: null, groceries: [] };
  await kitchen(page, server);
  await openGroceries(page);
  await page.getByRole('button', { name: 'Share your kitchen', exact: true }).click();
  // Meanwhile, another device joined the Rossis.
  server.household = rossi();
  await page.getByRole('textbox', { name: 'Invite code', exact: true }).fill('ABCD2345');
  await page.getByRole('button', { name: 'Join household', exact: true }).click();
  await expect(page.getByText('@sam · Owner', { exact: true })).toBeVisible();
});

test('the owner removes a member, then leaves after being told what happens', async ({ page }) => {
  const server: Server = {
    household: {
      id: 'flat',
      name: 'The flat',
      role: 'owner',
      members: [member('me', 'Alex', 'owner'), member('sam', 'Sam', 'member')],
    },
    groceries: [grocery('g1', 'Basil', { id: 'sam', name: 'Sam' })],
  };
  const { requests } = await kitchen(page, server);
  await openGroceries(page);
  await page.getByRole('button', { name: 'Shared kitchen: The flat', exact: true }).click();
  await page.getByRole('button', { name: 'Leave household', exact: true }).click();
  // The owner hears that someone else takes over.
  await expect(
    page.getByText(
      'You own this household. When you leave, the member who has been here longest becomes the owner.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'Remove Sam from the household', exact: true }).click();
  await expect(
    page.getByText('They’ll stop seeing the shared kitchen. They can join again with a new code.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove from household', exact: true }).click();
  await expect(page.getByText('@sam · Member', { exact: true })).toHaveCount(0);
  expect(requests).toContain('DELETE /household/members/sam');

  // Alone now: leaving closes the household.
  await page.getByRole('button', { name: 'Leave household', exact: true }).click();
  await expect(
    page.getByText('You’re the only one here, so leaving closes the household.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Leave household', exact: true }).click();
  await expect(page.getByText('You’ve left the household.', { exact: true })).toBeVisible();
  expect(requests).toContain('DELETE /household/members/me');
  await expect(page.getByRole('button', { name: 'Share your kitchen', exact: true })).toBeVisible();
});
