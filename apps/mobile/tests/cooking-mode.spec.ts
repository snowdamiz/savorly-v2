import { test, expect, Page } from '@playwright/test';
import type { Recipe } from '../src/lib/types';

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
const recipe: Recipe = {
  id: 'sauce',
  title: 'Slow tomato sauce',
  description: 'A sauce that simmers while you set the table.',
  cuisine: 'Italian',
  minutes: 30,
  servings: 4,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Tomatoes', amount: 800, unit: 'g', category: 'Produce' }],
  steps: [
    { title: 'Simmer', text: 'Simmer the sauce gently.', seconds: 60 },
    { title: 'Serve', text: 'Serve it over pasta.', seconds: 0 },
  ],
  tags: [],
  calories: 180,
  aiGenerated: false,
  published: true,
  author: user,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: new Date().toISOString(),
};

async function mockKitchen(page: Page, served: Recipe = recipe) {
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({});
    if (path === '/recipes') return json([served]);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === `/recipes/${served.id}`) return json(served);
    return json([]);
  });
  await page.route('https://media.test/**', (route) =>
    route.fulfill({ path: 'tests/fixtures/sample.mp4', contentType: 'video/mp4' }),
  );
}

type Controls = { wakeLog: string[]; spoken: string[]; showPage: (shown: boolean) => void };
// A page the test can hide and show, a Screen Wake Lock that logs what it's asked for (and, like a
// browser, drops the lock while the page is hidden), and speech that is written down.
function pageControls() {
  let visibility: DocumentVisibilityState = 'visible';
  const wakeLog: string[] = [];
  const locks: { released: boolean }[] = [];
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => visibility === 'hidden',
  });
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async (type: string) => {
        wakeLog.push(`request ${type}`);
        const lock = {
          released: false,
          release: async () => {
            if (!lock.released) wakeLog.push('release');
            lock.released = true;
          },
        };
        locks.push(lock);
        return lock;
      },
    },
  });
  const spoken: string[] = [];
  window.speechSynthesis.speak = (utterance) => void spoken.push(utterance.text);
  const showPage = (shown: boolean) => {
    visibility = shown ? 'visible' : 'hidden';
    if (!shown) for (const lock of locks) lock.released = true;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  Object.assign(window, { wakeLog, spoken, showPage });
}
const wakeLog = (page: Page) => page.evaluate(() => [...(window as unknown as Controls).wakeLog]);
const spoken = (page: Page) => page.evaluate(() => [...(window as unknown as Controls).spoken]);
const showPage = (page: Page, shown: boolean) =>
  page.evaluate((next) => (window as unknown as Controls).showPage(next), shown);

async function startCooking(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /^Let’s get cooking: / }).click();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close cooking mode' })).toBeVisible();
}

test('cooking mode keeps the screen awake, and asks again when the page comes back', async ({
  page,
}) => {
  await page.addInitScript(pageControls);
  await mockKitchen(page);
  await startCooking(page);
  await expect.poll(() => wakeLog(page)).toEqual(['request screen']);
  // The browser let go of the lock while the page was hidden.
  await showPage(page, false);
  await showPage(page, true);
  await expect.poll(() => wakeLog(page)).toEqual(['request screen', 'request screen']);
  await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
  await expect.poll(() => wakeLog(page)).toEqual(['request screen', 'request screen', 'release']);
});

test('a running timer catches up the moment the page comes back', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(pageControls);
  await mockKitchen(page);
  await startCooking(page);
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause timer', exact: true })).toBeVisible();
  // Away for two minutes: the clock stops, so no timer in the page can fire, and only coming back
  // can bring the countdown up to date.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
  await showPage(page, false);
  await page.clock.setSystemTime(now + 120_000);
  await expect(page.getByText('00:00', { exact: true })).toHaveCount(0);
  await showPage(page, true);
  await expect(page.getByText('00:00', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Timer finished', exact: true })).toBeVisible();
  await expect.poll(() => spoken(page)).toEqual(['Your cooking timer is finished.']);
  await page.clock.resume();
});

test('a step’s clip plays silently while the step is read aloud, and stops with its step', async ({
  page,
}) => {
  await page.addInitScript(pageControls);
  const [simmer, serve] = recipe.steps;
  await mockKitchen(page, {
    ...recipe,
    steps: [{ ...simmer, video: 'https://media.test/simmer.mp4' }, serve],
  });
  await startCooking(page);
  const cooking = page.locator('[aria-modal="true"]').last();
  await expect(
    cooking.getByRole('button', { name: 'Pause the clip of step 1', exact: true }),
  ).toBeVisible();
  const clip = cooking.locator('video');
  await expect
    .poll(() => clip.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, paused: v.paused })))
    .toEqual({ muted: true, paused: false });
  // Reading the step aloud and its timer carry on beside it.
  await page.getByRole('button', { name: 'Read this step aloud', exact: true }).click();
  await expect.poll(() => spoken(page)).toEqual(['Simmer the sauce gently.']);
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause timer', exact: true })).toBeVisible();
  expect(await clip.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  // The next step has no clip, so the clip stops; the screen stays awake until cooking ends.
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(cooking.getByText('Serve it over pasta.', { exact: true })).toBeVisible();
  await expect(cooking.locator('video')).toHaveCount(0);
  expect(await wakeLog(page)).toEqual(['request screen']);
  await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
  await expect.poll(() => wakeLog(page)).toEqual(['request screen', 'release']);
});
