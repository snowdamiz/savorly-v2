import { expect, Page, Route, test } from '@playwright/test';
import type { Creator, Grocery, Kitchen, PantryItem } from '../src/lib/types';

// Fixed dates need a fixed zone: the clock starts at midday on Friday 16 October 2026 and runs on,
// so the app's animations still finish.
test.use({ timezoneId: 'UTC' });
const NOW = new Date('2026-10-16T12:00:00Z');

const cook: Creator = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  recipeCount: 0,
  followerCount: 0,
};

/** A signed-in kitchen; `kitchen` is the server's copy, which the PATCH and POST mocks update. */
async function signedIn(page: Page, kitchen: Kitchen) {
  const requests: string[] = [];
  await page.clock.install({ time: NOW });
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    requests.push(`${method} ${path}`);
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/me')
      return reply({
        ...cook,
        email: 'alex@example.test',
        preferences: { diets: [], allergies: [] },
        identities: [],
        hasPassword: true,
        plan: 'free',
        onboarded: true,
      });
    if (path === '/capabilities') return reply({});
    if (path === '/library')
      return reply({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return reply(structuredClone(kitchen));
    if (path === '/pantry' && method === 'POST') return reply({ ok: true }, 201);
    if (path.startsWith('/groceries/') && method === 'PATCH') {
      const item = kitchen.groceries.find((g) => `/groceries/${g.id}` === path);
      if (item) item.checked = route.request().postDataJSON().checked;
      return route.fulfill({ status: 204 });
    }
    return reply([]);
  });
  return requests;
}

const grocery = (id: string, name: string): Grocery => ({
  id,
  name,
  quantity: '1',
  category: 'Produce',
  checked: false,
});

test('the date picker sets a pantry best-before date', async ({ page }) => {
  await signedIn(page, { plans: [], groceries: [], pantry: [] });
  await page.goto('/?page=pantry');
  await page.getByRole('textbox', { name: 'Ingredient', exact: true }).fill('Chickpeas');
  await page.getByRole('button', { name: 'Best before', exact: true }).click();
  // A month calendar in the shared sheet, in the reader's language, starting on the US Sunday.
  await expect(page.getByText('October 2026', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.getByText('November 2026', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await page.getByRole('button', { name: 'Thursday, October 22, 2026', exact: true }).click();
  // The sheet closes, and the field shows the day in the reader's format.
  await expect(page.getByText('October 2026', { exact: true })).toHaveCount(0);
  const field = page.getByRole('button', { name: 'Best before: Oct 22, 2026', exact: true });
  await expect(field).toBeVisible();
  // Clear empties it; Today picks today.
  await field.click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Best before', exact: true }).click();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Best before: Oct 16, 2026', exact: true }).click();
  await page.getByRole('button', { name: 'Thursday, October 22, 2026', exact: true }).click();
  const saved = page.waitForRequest((r) => r.url().endsWith('/v1/pantry') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Add to pantry', exact: true }).click();
  expect((await saved).postDataJSON()).toEqual({
    name: 'Chickpeas',
    quantity: '',
    expiresOn: '2026-10-22',
  });
});

test('the calendar follows the locale: German weeks start on Monday', async ({ page }) => {
  await signedIn(page, { plans: [], groceries: [], pantry: [] });
  await page.goto('/?page=pantry');
  await page.evaluate(() => localStorage.setItem('savorly.language', 'de'));
  await page.reload();
  await page.getByRole('button', { name: 'Mindestens haltbar bis', exact: true }).click();
  await expect(page.getByText('Oktober 2026', { exact: true })).toBeVisible();
  // The weekday row (for the eye only; each day button names its full date) starts on Monday.
  const weekdays = page.locator('[aria-hidden="true"]').filter({ hasText: /^MoDiMiDoFrSaSo$/ });
  await expect(weekdays).toHaveCount(1);
  await page.getByRole('button', { name: 'Donnerstag, 22. Oktober 2026', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Mindestens haltbar bis: 22. Okt. 2026', exact: true }),
  ).toBeVisible();
});

test('pantry dates compare as dates and show in the reader’s format', async ({ page }) => {
  const item = (id: string, name: string, expiresOn: string | null): PantryItem => ({
    id,
    name,
    quantity: '',
    expiresOn,
  });
  await signedIn(page, {
    plans: [],
    groceries: [],
    pantry: [
      item('a', 'milk', '2026-10-15'),
      item('b', 'eggs', '2026-10-19'),
      item('c', 'rice', '2026-11-02'),
      item('d', 'salt', null),
    ],
  });
  await page.goto('/?page=pantry');
  await expect(page.getByText('Expired', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Use soon', { exact: true })).toHaveCount(1);
  await expect(
    page.getByText('In the pantry · best before Nov 2, 2026', { exact: true }),
  ).toBeVisible();
});

test('the planner’s week starts where the reader’s calendar does', async ({ page }) => {
  await signedIn(page, { plans: [], groceries: [], pantry: [] });
  await page.goto('/?page=planner');
  // Friday 16 October: the US week runs Sunday 11 to Saturday 17.
  await expect(page.getByText('Oct 11 – Oct 17', { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('savorly.language', 'fr'));
  await page.reload();
  // French (France) weeks run Monday 12 to Sunday 18.
  await expect(page.getByText('12 oct. – 18 oct.', { exact: true })).toBeVisible();
});

test('a grocery check-off shows at once and is undone if the server refuses', async ({ page }) => {
  await signedIn(page, { plans: [], groceries: [grocery('g1', 'Lemons')], pantry: [] });
  // The server holds its answer until the test has seen the box.
  let answer!: () => Promise<void>;
  let patched!: () => void;
  const asked = new Promise<void>((resolve) => (patched = resolve));
  await page.route('**/v1/groceries/g1', (route: Route) => {
    answer = () => route.fulfill({ status: 500, json: { error: 'That list is busy.' } });
    patched();
  });
  await page.goto('/?page=planner');
  await page.getByRole('tab', { name: /Groceries/ }).click();
  const box = page.getByRole('checkbox');
  await expect(box).not.toBeChecked();
  await box.click();
  await asked;
  // Checked while the server hasn't answered yet.
  await expect(box).toBeChecked();
  await expect(page.getByText('1 of 1 in the basket', { exact: true })).toBeVisible();
  await answer();
  await expect(box).not.toBeChecked();
  await expect(page.getByText('0 of 1 in the basket', { exact: true })).toBeVisible();
  await expect(page.getByText('That list is busy.', { exact: true })).toBeVisible();
});

test('a kitchen refresh that answers late cannot undo a newer check-off', async ({ page }) => {
  const kitchen: Kitchen = {
    plans: [],
    groceries: [grocery('g1', 'Lemons'), grocery('g2', 'Basil')],
    pantry: [],
  };
  const requests = await signedIn(page, kitchen);
  await page.goto('/?page=planner');
  await page.getByRole('tab', { name: /Groceries/ }).click();
  const lemons = page.getByRole('checkbox').filter({ hasText: 'Lemons' });
  const basil = page.getByRole('checkbox').filter({ hasText: 'Basil' });
  await expect(basil).not.toBeChecked();
  // Hold the next kitchen refresh, answering it later with what the server had when it was asked.
  let late!: () => Promise<void>;
  let asked!: () => void;
  const held = new Promise<void>((resolve) => (asked = resolve));
  // Kitchen refreshes ask for a window of days (/v1/kitchen?from&to).
  await page.route(
    (url) => url.pathname === '/v1/kitchen',
    (route) => {
      const then = structuredClone(kitchen);
      late = () => route.fulfill({ json: then });
      asked();
    },
    { times: 1 },
  );
  await lemons.click();
  await held;
  // Lemons' refresh is held (it saw Lemons checked, Basil not); Basil's goes through at once.
  await basil.click();
  await expect.poll(() => requests.filter((r) => r === 'PATCH /groceries/g2')).toHaveLength(1);
  await expect.poll(() => requests.filter((r) => r === 'GET /kitchen').length).toBeGreaterThan(1);
  await expect(basil).toBeChecked();
  await expect(page.getByText('2 of 2 in the basket', { exact: true })).toBeVisible();
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/v1/kitchen');
  await late();
  await answered;
  // Let the page take in the late answer before checking that it changed nothing.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await expect(basil).toBeChecked();
  await expect(lemons).toBeChecked();
  await expect(page.getByText('2 of 2 in the basket', { exact: true })).toBeVisible();
});
