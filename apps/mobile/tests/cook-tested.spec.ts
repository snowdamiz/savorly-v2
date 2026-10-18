import { expect, test } from '@playwright/test';
import { alex, json, mockApi, recipe, recipeCard } from './mockApi';
import type { AuthorInsights, RecipeInsights } from '../src/lib/cookInsights';
import { afterPageTimers } from './waits';

// Cook-tested recipes (docs/COOK-TESTED.md): what cooking in Savorly shows on a recipe and its
// steps, the step events cooking mode sends, Explore's filter, the author's "Where cooks get
// stuck", and the switch that keeps a member's cooking out.

const steps = [
  { title: 'Prep', text: 'Chop the onion.', seconds: 0 },
  { title: 'Simmer', text: 'Simmer the sauce for 8 minutes.', seconds: 480 },
  { title: 'Serve', text: 'Serve it hot.', seconds: 0 },
];
const sauce = recipe({
  id: 'sauce',
  title: 'Tomato sauce',
  minutes: 40,
  steps,
  verifiedCooks: 214,
  cookedMinutes: 55,
});
const question = {
  id: 'q1',
  question: 'Can I use a smaller pan?',
  answer: 'Yes, a 20 cm pan works; give it a few minutes more.',
  checked: false,
};
const insights: RecipeInsights = {
  sessions: 240,
  finished: 221,
  finishRate: 221 / 240,
  computedAt: '2026-10-17T03:05:00Z',
  steps: [
    {
      step: 2,
      sessions: 230,
      medianSeconds: 720,
      p75Seconds: 800,
      timerSeconds: 480,
      note: { kind: 'longer', minutes: 4 },
      questions: [question],
    },
  ],
};

test('a cook-tested recipe shows what cooks found, on its page and its steps', async ({ page }) => {
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('GET', '/recipes/sauce/insights', () => json(insights));
  await page.goto(`/?recipe=${sauce.id}`);
  await expect(
    page.getByText('Cook-tested · 214 cooks · usually 55 min (says 40)', { exact: true }),
  ).toBeVisible();
  // 92% finished: still 9 in 10.
  await expect(page.getByText('Finished by 9 in 10 who started', { exact: true })).toBeVisible();
  // The step's timer line says how long cooks really need; nothing else crowds the step.
  await expect(
    page.getByText('Timer for 8 min in cooking mode · most cooks need about 12 min', {
      exact: true,
    }),
  ).toBeVisible();
  // A question cooks keep asking opens to its answer.
  const asked = page.getByRole('button', { name: question.question, exact: true });
  await expect(asked).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(question.answer, { exact: true })).toHaveCount(0);
  await asked.click();
  await expect(asked).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(question.answer, { exact: true })).toBeVisible();
  await expect(page.getByText('Answered by the sous-chef', { exact: true })).toBeVisible();
  await afterPageTimers(page, 1500); // the splash fades out
  await page.screenshot({ path: 'test-results/cook-tested-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByText('Cook-tested · 214 cooks · usually 55 min (says 40)', { exact: true }),
  ).toBeVisible();
  await afterPageTimers(page, 1500);
  await page.screenshot({ path: 'test-results/cook-tested-mobile.png' });
});

test('cards mark cook-tested recipes, and Explore can show only them', async ({ page }) => {
  const plain = recipe({ id: 'plain', title: 'Plain toast', verifiedCooks: 3, cookedMinutes: 9 });
  const api = await mockApi(page, { recipes: [sauce, plain] });
  await page.goto('/?page=explore');
  await expect(recipeCard(page, 'Plain toast')).toBeVisible();
  // Only the recipe with 5 verified cooks or more carries the pill.
  await expect(page.getByText('Cook-tested', { exact: true })).toHaveCount(1);
  await expect(recipeCard(page, 'Tomato sauce')).toBeVisible();
  await page.getByRole('button', { name: 'Filter recipes', exact: true }).first().click();
  await page.getByRole('button', { name: 'Cook-tested only', exact: true }).click();
  await expect
    .poll(() =>
      api.requests.some((r) => r.path === '/recipes' && r.query.get('cookTested') === 'true'),
    )
    .toBe(true);
});

test('cooking mode shows a step’s notes and reports each step and timer', async ({ page }) => {
  const api = await mockApi(page, { recipes: [sauce] });
  api.on('GET', '/recipes/sauce/insights', () => json(insights));
  api.on('POST', '/recipes/sauce/cook-sessions', () => json({ id: 'session-1' }, 201));
  await page.goto(`/?recipe=${sauce.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  // Under the timer: how long cooks really need, and a tap that sets the timer to it.
  await expect(page.getByText('Most cooks need about 12 min', { exact: true })).toBeVisible();
  await expect(page.getByText('08:00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Set to 12 min', exact: true }).click();
  await expect(page.getByText('12:00', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set to 12 min', exact: true })).toHaveCount(0);
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/cook-tested-cooking.png' });
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.getByRole('button', { name: 'Finish cooking', exact: true }).click();
  await expect(page.getByText('Dinner is served.', { exact: true })).toBeVisible();
  const events = () =>
    api
      .sentTo('/cook-sessions/session-1/events')
      .flatMap(
        ([, body]) => (body as { events: { seq: number; kind: string; step: number }[] }).events,
      )
      .sort((a, b) => a.seq - b.seq)
      .map((e) => `${e.kind} ${e.step}`);
  await expect
    .poll(events)
    .toEqual(['enter 1', 'enter 2', 'timer_start 2', 'timer_pause 2', 'enter 3', 'leave 3']);
});

test('a member who keeps their cooking out sends no step events', async ({ page }) => {
  const api = await mockApi(page, {
    recipes: [sauce],
    user: { preferences: { diets: [], allergies: [], shareCooking: false } },
  });
  api.on('POST', '/recipes/sauce/cook-sessions', () => json({ id: 'session-1' }, 201));
  await page.goto(`/?recipe=${sauce.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.getByRole('button', { name: 'Finish cooking', exact: true }).click();
  await expect(page.getByText('Dinner is served.', { exact: true })).toBeVisible();
  // The session itself still counts: it's a verified cook for the creator.
  await expect.poll(() => api.sentTo('/cook-sessions/session-1').length).toBeGreaterThan(0);
  expect(api.sentTo('/cook-sessions/session-1/events')).toEqual([]);
});

test('the switch in My kitchen keeps a member’s cooking out', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Your cooking', exact: true }).click();
  const toggle = page.getByRole('switch', { name: /Share how my cooking goes/ });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect
    .poll(() => api.sentTo('/me/preferences'))
    .toEqual([['PATCH', { shareCooking: false }]]);
});

test('an author sees where cooks get stuck and answers what they ask', async ({ page }) => {
  const mine = { ...sauce, id: 'my-sauce', author: alex };
  const view: AuthorInsights = {
    ...insights,
    verifiedCooks: 214,
    cookedMinutes: 55,
    steps: [
      {
        step: 1,
        sessions: 230,
        medianSeconds: 130,
        p75Seconds: 160,
        timerSeconds: 0,
        note: null,
        questions: [],
        entered: 240,
        gaveUp: 2,
      },
      {
        ...insights.steps[0],
        entered: 236,
        gaveUp: 12,
        questions: [{ ...question, askers: 9, hidden: false }],
      },
      { step: 3, sessions: 0, timerSeconds: 0, note: null, questions: [] },
    ],
  };
  const api = await mockApi(page, {
    recipes: [mine],
    library: { recipes: [mine], ownIds: [mine.id], publishedCount: 1 },
  });
  api.on('GET', '/recipes/my-sauce/insights/author', () => json(view));
  api.on('PATCH', '/recipes/my-sauce/insights/questions/q1', ({ body }) =>
    json({ ...question, ...(body as object), checked: true }),
  );
  await page.goto(`/?recipe=${mine.id}`);
  await page.getByRole('button', { name: 'Where cooks get stuck', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Step 2: Simmer', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Cooks usually take 12 min here (the timer says 8)', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText('12 of 236 cooks who reached this step stopped here', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('Asked by 9 cooks', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Not enough cooks have reached this step yet.', { exact: true }),
  ).toBeVisible();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/cooks-get-stuck.png' });
  await dialog.getByRole('button', { name: 'Approve answer', exact: true }).click();
  await expect
    .poll(() => api.sentTo('/recipes/my-sauce/insights/questions/q1'))
    .toEqual([['PATCH', { approve: true }]]);
  await expect(dialog.getByText('Answered by you', { exact: true })).toBeVisible();
});
