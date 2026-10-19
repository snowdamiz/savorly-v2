import { test, expect, Page } from '@playwright/test';
import type { Recipe } from '../src/lib/types';
import { stopsMoving } from './waits';

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
  // The clip plays behind the step, with nothing over it to tap.
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
  // A link under the step shows it whole, with nothing over it, and goes back to the step.
  await cooking.getByRole('button', { name: 'Watch the clip', exact: true }).click();
  const pause = cooking.getByRole('button', { name: 'Pause the clip of step 1', exact: true });
  await expect(pause).toBeVisible();
  await cooking.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(pause).toHaveCount(0);
  // The next step has no clip, so the clip stops; the screen stays awake until cooking ends.
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(cooking.getByText('Serve it over pasta.', { exact: true })).toBeVisible();
  await expect(cooking.locator('video')).toHaveCount(0);
  expect(await wakeLog(page)).toEqual(['request screen']);
  await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
  await expect.poll(() => wakeLog(page)).toEqual(['request screen', 'release']);
});

test('a long step fits a small phone without scrolling, over its photo', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const [simmer, serve] = recipe.steps;
  const text =
    'Warm the olive oil in a wide pot over medium-low heat. Add the onion with a good pinch of ' +
    'salt and cook, stirring now and then, until soft and translucent but not browned. Add the ' +
    'tomatoes, crush them with the spoon and let the sauce simmer gently, uncovered, until thick ' +
    'and glossy. Stir from the bottom every few minutes so it doesn’t catch.';
  await mockKitchen(page, {
    ...recipe,
    steps: [{ ...simmer, text, image: 'https://media.test/simmer.png' }, serve],
  });
  await page.route('https://media.test/**.png', (route) =>
    route.fulfill({ path: 'tests/fixtures/sample.png', contentType: 'image/png' }),
  );
  await startCooking(page);
  const cooking = page.locator('[aria-modal="true"]').last();
  const words = cooking.getByText(text, { exact: true });
  const timer = cooking.getByRole('button', { name: 'Start timer', exact: true });
  const next = cooking.getByRole('button', { name: 'Next step', exact: true });
  await expect(words).toBeVisible();
  await stopsMoving(words);
  // The words end above the timer, the buttons are on screen, and nothing scrolls.
  const box = async (l: typeof words) => (await l.boundingBox())!;
  const [w, t, n] = [await box(words), await box(timer), await box(next)];
  expect(w.y + w.height).toBeLessThanOrEqual(t.y);
  expect(n.y + n.height).toBeLessThanOrEqual(667);
  expect(
    await cooking.evaluate((root) =>
      [root, ...root.querySelectorAll('*')].some(
        (el) =>
          el.scrollHeight > el.clientHeight + 1 &&
          /auto|scroll/.test(getComputedStyle(el).overflowY),
      ),
    ),
  ).toBe(false);
  // The photo shows on its own, without anything over it, and Escape goes back to the step.
  await cooking.getByRole('button', { name: 'See the photo', exact: true }).click();
  await expect(cooking.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cooking.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await expect(words).toBeVisible();
});

test('a step too long for the screen stays readable and scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const [simmer, serve] = recipe.steps;
  const text = Array.from(
    { length: 12 },
    (_, i) =>
      `Stage ${i + 1}: stir the sauce from the bottom, scrape the sides, and taste it again.`,
  ).join(' ');
  await mockKitchen(page, { ...recipe, steps: [{ ...simmer, text }, serve] });
  await startCooking(page);
  const cooking = page.locator('[aria-modal="true"]').last();
  const words = cooking.getByText(text, { exact: true });
  await expect(words).toBeVisible();
  await stopsMoving(words);
  // It shrinks only as far as reads at arm's length, then scrolls; the buttons stay put.
  expect(await words.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(16);
  expect(
    await words.evaluate((el) => {
      for (let up = el.parentElement; up; up = up.parentElement)
        if (/auto|scroll/.test(getComputedStyle(up).overflowY))
          return up.scrollHeight > up.clientHeight;
      return false;
    }),
  ).toBe(true);
  const next = (await cooking
    .getByRole('button', { name: 'Next step', exact: true })
    .boundingBox())!;
  expect(next.y + next.height).toBeLessThanOrEqual(667);
});
