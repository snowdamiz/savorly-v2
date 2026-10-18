import { expect, Page, test } from '@playwright/test';
import type { MealTimeline, TimelineStep, TimelineWarning } from '../src/lib/mealTimeline';
import type { Plan, Recipe } from '../src/lib/types';
import { json, mockApi, recipe } from './mockApi';
import { fakeSpeech, say, spoken } from './fakeSpeech';
import { afterPageTimers } from './waits';

// The whole-meal timeline (docs/MEAL-TIMELINE.md): "Cook together" from the planner's day and from
// saved recipes, the plan as one list across the dishes, cooking mode across all of them with a
// timer per dish and "I'm behind", and a step's timing in the editor.

// Friday 16 October 2026, 2 pm in New York: dinner at 7 is today's.
test.use({ timezoneId: 'America/New_York', locale: 'en-US' });
const NOW = new Date('2026-10-16T18:00:00Z');
/**
 * A time the app sends as the cook's local time ("2026-10-16T19:00"), in New York like the page.
 * The mock answers in the test's own process, whose zone is the machine's (UTC on CI).
 */
const inNewYork = (local: string) => new Date(`${local.slice(0, 16)}:00-04:00`).getTime();

const steps = (...titles: string[]) =>
  titles.map((title) => ({ title, text: `${title} it as the recipe says.`, seconds: 0 }));
const roast = recipe({
  id: 'roast',
  title: 'Roast chicken',
  minutes: 115,
  steps: steps('Heat', 'Season', 'Roast', 'Rest', 'Carve'),
});
const potatoes = recipe({
  id: 'potatoes',
  title: 'Crispy potatoes',
  minutes: 75,
  steps: steps('Peel', 'Parboil', 'Drain', 'Roast'),
});
const beans = recipe({
  id: 'beans',
  title: 'Green beans',
  minutes: 12,
  steps: steps('Trim', 'Boil', 'Toss'),
});

/** The plan the server answers for the roast dinner, ready at `eatAt` (the cook's local time). */
function roastDinner(eatAt: string, warnings: TimelineWarning[] = []): MealTimeline {
  const eat = inNewYork(eatAt);
  const at = (minutes: number) => new Date(eat + minutes * 60_000).toISOString();
  const step = (
    recipeId: string,
    n: number,
    from: number,
    to: number,
    fields: Partial<TimelineStep> = {},
  ): TimelineStep => ({
    recipeId,
    step: n,
    title: [roast, potatoes, beans].find((r) => r.id === recipeId)!.steps[n - 1].title,
    startAt: at(from),
    endAt: at(to),
    active: (to - from) * 60,
    wait: 0,
    oven: 0,
    burners: 0,
    preheat: false,
    estimated: true,
    tested: false,
    ...fields,
  });
  const wait = (minutes: number) => ({ active: 60, wait: (minutes - 1) * 60 });
  return {
    eatAt: at(0),
    startAt: at(-115),
    kitchen: { burners: 4, ovens: 1 },
    dishes: [roast, potatoes, beans].map((r) => ({
      recipeId: r.id,
      title: r.title,
      image: '',
      startAt: at(-115),
      readyAt: at(0),
      estimated: true,
      tested: false,
    })),
    steps: [
      step('roast', 1, -115, -100, { active: 0, oven: 220, preheat: true }),
      step('roast', 2, -110, -100),
      step('roast', 3, -100, -25, { ...wait(75), oven: 220 }),
      step('potatoes', 1, -73, -58),
      step('potatoes', 2, -58, -48, { ...wait(10), burners: 1 }),
      step('potatoes', 3, -48, -45),
      step('potatoes', 4, -45, 0, { ...wait(45), oven: 220 }),
      step('roast', 4, -25, -10, wait(15)),
      step('beans', 1, -22, -17),
      step('beans', 2, -17, -12, { ...wait(5), burners: 1, tested: true, estimated: false }),
      step('beans', 3, -12, -10),
      step('roast', 5, -10, 0),
    ],
    free: [
      { startAt: at(-99), endAt: at(-73) },
      { startAt: at(-44), endAt: at(-25) },
    ],
    warnings,
  };
}

async function kitchen(page: Page, plans: Plan[] = []) {
  await page.clock.install({ time: NOW });
  const api = await mockApi(page, {
    recipes: [roast, potatoes, beans],
    kitchen: { plans },
    library: {
      savedIds: ['roast', 'potatoes', 'beans'],
      saves: ['roast', 'potatoes', 'beans'].map((recipeId) => ({ recipeId, collectionId: null })),
      recipes: [roast, potatoes, beans],
    },
  });
  const asked: { recipes: string[]; eatAt: string; timeZone: string; kitchen: unknown }[] = [];
  api.on('POST', '/meals/timeline', ({ body }) => {
    const sent = body as (typeof asked)[number];
    asked.push(sent);
    return json(roastDinner(sent.eatAt));
  });
  api.on('POST', '/meals/cook-sessions', ({ body }) => {
    const { recipes } = body as { recipes: string[] };
    return json(
      {
        mealId: 'meal-1',
        sessions: recipes.map((id) => ({
          id: `session-${id}`,
          recipeId: id,
          steps: [roast, potatoes, beans].find((r) => r.id === id)!.steps.length,
          mealId: 'meal-1',
        })),
      },
      201,
    );
  });
  return { api, asked };
}
const planned = (recipe: Recipe, meal: string): Plan => ({
  id: `plan-${recipe.id}`,
  recipeId: recipe.id,
  day: '2026-10-16',
  meal,
  servings: 4,
  recipe,
});

test('a day’s meals become one timed plan, cooked together with a timer per dish', async ({
  page,
}) => {
  const { api, asked } = await kitchen(page, [
    planned(roast, 'Dinner'),
    planned(potatoes, 'Lunch'),
    planned(beans, 'Breakfast'),
  ]);
  // A phone offers it under the day's meals.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=planner');
  await expect(page.getByRole('button', { name: 'Cook together', exact: true })).toBeVisible();
  await afterPageTimers(page, 1500);
  await page.screenshot({ path: 'test-results/meal-timeline-planner-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Cook together on Friday', exact: true }).click();
  // Dinner at 7, the roast first; every step at its time, marked by dish, and the free time.
  await expect(page.getByText('7:00 PM', { exact: true })).toBeVisible();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toEqual({
    recipes: ['beans', 'potatoes', 'roast'],
    eatAt: '2026-10-16T19:00',
    timeZone: 'America/New_York',
    kitchen: { burners: 4, ovens: 1 },
  });
  const sheet = page.getByRole('dialog');
  await expect(
    sheet.getByText('Roast chicken: Preheat the oven to 425 °F', { exact: true }),
  ).toBeVisible();
  await expect(sheet.getByText('Crispy potatoes: Roast · 45 min', { exact: true })).toBeVisible();
  await expect(sheet.getByText('26 minutes free', { exact: true })).toBeVisible();
  await expect(sheet.getByText('5:05 PM', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Some times are estimates.', { exact: true })).toBeVisible();
  await expect(sheet.getByText('4 burners · 1 oven', { exact: true })).toBeVisible();
  // Later by a quarter hour: asked again.
  await sheet.getByRole('button', { name: '15 minutes later', exact: true }).click();
  await expect.poll(() => asked.at(-1)?.eatAt).toBe('2026-10-16T19:15');
  await sheet.getByRole('button', { name: '15 minutes earlier', exact: true }).click();
  await expect.poll(() => asked.at(-1)?.eatAt).toBe('2026-10-16T19:00');
  await afterPageTimers(page, 800);
  await page.screenshot({ path: 'test-results/meal-timeline-plan-desktop.png' });

  // Cooking mode across all of them: the oven first, then the seasoning while it heats.
  await sheet.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(page.getByText('Eat at 7:00 PM', { exact: true })).toBeVisible();
  await expect(page.getByText('Preheat the oven to 425 °F', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Next at 5:10 PM: Roast chicken: Season', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => api.sentTo('/meals/cook-sessions'))
    .toEqual([['POST', { recipes: ['roast', 'potatoes', 'beans'] }]]);
  const done = page.getByRole('button', { name: 'Done', exact: true });
  await done.click();
  // The oven heats on its own, in its dish's timer; the seasoning is next.
  await expect(
    page.getByRole('button', { name: 'Pause the timer for Roast chicken', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Season', { exact: true })).toBeVisible();
  await done.click();
  await expect(
    page.getByText('Then it’s on its own for 74 minutes.', { exact: true }),
  ).toBeVisible();
  await done.click();
  // The roast is in: peeling the potatoes comes next, with the free time before it.
  await expect(page.getByText('Peel', { exact: true })).toBeVisible();
  await expect(page.getByText(/^You have \d+ minutes free first\.$/)).toBeVisible();
  // Each step entered and left goes to its own dish's session.
  const events = api
    .sentTo(/^\/cook-sessions\/session-roast\/events$/)
    .map(
      ([, body]) => (body as { events: { seq: number; kind: string; step: number }[] }).events[0],
    )
    .sort((a, b) => a.seq - b.seq);
  expect(events.map((e) => `${e.kind} ${e.step}`)).toEqual([
    'enter 1',
    'timer_start 1',
    'enter 2',
    'leave 2',
    'enter 3',
    'timer_start 3',
  ]);
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/meal-timeline-cooking-desktop.png' });

  // Behind: everything still to do moves later, and so does dinner.
  await page.getByRole('button', { name: 'I’m behind', exact: true }).click();
  await expect(page.getByText('Eat at 7:05 PM', { exact: true })).toBeVisible();
  // Back takes the roast out again, timer and all.
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText('Roast', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/meal-timeline-cooking-mobile.png' });
});

test('hands-free commands work across the dishes, and say what is running', async ({ page }) => {
  await page.addInitScript(fakeSpeech);
  await page.addInitScript(() => localStorage.setItem('savorly.handsFree.explained', '1'));
  await kitchen(page, [planned(roast, 'Dinner'), planned(potatoes, 'Lunch')]);
  await page.goto('/?page=planner');
  await page.getByRole('button', { name: 'Cook together on Friday', exact: true }).click();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await page.getByRole('switch', { name: 'Hands-free' }).click();
  // Done with the oven: it heats on its own, and the next step is read, with what's running.
  await say(page, 'next step');
  await expect(page.getByText('Season', { exact: true })).toBeVisible();
  await expect
    .poll(() => spoken(page))
    .toEqual(
      expect.arrayContaining([
        'Roast chicken. Season. Season it as the recipe says.',
        'The oven is hot in 15 minutes.',
      ]),
    );
  await say(page, 'next step');
  await expect(
    page.getByText('Then it’s on its own for 74 minutes.', { exact: true }),
  ).toBeVisible();
  // "Start the timer" on a step that waits is done with it: the roast's hour runs, and peeling the
  // potatoes is read, with both timers.
  await say(page, 'start the timer');
  await expect(page.getByText('Peel', { exact: true })).toBeVisible();
  await expect
    .poll(() => spoken(page))
    .toEqual(
      expect.arrayContaining([
        'Crispy potatoes. Peel. Peel it as the recipe says.',
        'The oven is hot in 15 minutes. Roast chicken has 74 minutes left.',
      ]),
    );
  // Pausing pauses the timer that ends first.
  await say(page, 'pause the timer');
  await expect(
    page.getByRole('button', { name: 'Resume the timer for Roast chicken', exact: true }),
  ).toBeVisible();
  await expect.poll(() => spoken(page)).toContain('Timer paused.');
});

test('a few saved recipes are cooked together, and what the kitchen can’t do is said quietly', async ({
  page,
}) => {
  const { api, asked } = await kitchen(page);
  api.on('POST', '/meals/timeline', ({ body }) => {
    const sent = body as { eatAt: string; recipes: string[] };
    asked.push(body as (typeof asked)[number]);
    return json(
      roastDinner(sent.eatAt, [
        {
          kind: 'oven',
          at: new Date(inNewYork(sent.eatAt) - 45 * 60_000).toISOString(),
          recipeIds: ['roast', 'potatoes'],
          heats: [220, 180],
        },
        {
          kind: 'burners',
          at: new Date(inNewYork(sent.eatAt) - 15 * 60_000).toISOString(),
          recipeIds: ['potatoes', 'beans'],
          needed: 3,
          have: 2,
        },
      ]),
    );
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=saved');
  await page.getByRole('button', { name: 'Cook together', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(
    sheet.getByText('Choose 2 to 4 recipes, and Savorly times them to be ready together.', {
      exact: true,
    }),
  ).toBeVisible();
  const plan = sheet.getByRole('button', { name: 'Plan the timing', exact: true });
  await expect(plan).toBeDisabled();
  await sheet.getByRole('checkbox').filter({ hasText: 'Roast chicken' }).click();
  await sheet.getByRole('checkbox').filter({ hasText: 'Crispy potatoes' }).click();
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/meal-timeline-pick-mobile.png' });
  await plan.click();
  // A kitchen of two burners, kept on this device.
  await sheet.getByRole('button', { name: 'Change your kitchen', exact: true }).click();
  await sheet.getByRole('button', { name: 'Fewer burners', exact: true }).click();
  await sheet.getByRole('button', { name: 'Fewer burners', exact: true }).click();
  await expect.poll(() => asked.at(-1)?.kitchen).toEqual({ burners: 2, ovens: 1 });
  expect(asked.at(-1)?.recipes).toEqual(['roast', 'potatoes']);
  await expect(
    sheet.getByText(
      'Roast chicken and Crispy potatoes need the oven at once, at 425 °F and 350 °F.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    sheet.getByText('3 burners at once around 6:45 PM, but your kitchen has 2.', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('savorly.kitchen') ?? '')).toContain(
    '"burners":2',
  );
  await afterPageTimers(page, 500);
  await page.screenshot({ path: 'test-results/meal-timeline-plan-mobile.png', fullPage: true });
});

test('a step’s timing for cooking with other dishes is one quiet line in the editor', async ({
  page,
}) => {
  const api = await mockApi(page);
  const writes: Record<string, unknown>[] = [];
  api.on('POST', '/recipes', ({ body }) => {
    writes.push(body as Record<string, unknown>);
    return json({ ...(body as object), id: 'saved-1', author: { id: 'me', name: 'Alex' } }, 201);
  });
  await page.goto('/?page=create');
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Sheet-pan supper');
  await page
    .getByRole('textbox', { name: 'Step 1 instructions', exact: true })
    .fill('Roast everything until golden.');
  const line = page.getByRole('button', { name: /^Timing for step 1: / });
  await expect(line).toHaveAccessibleName(
    'Timing for step 1: Timing for cooking with other dishes',
  );
  await line.click();
  await page.getByRole('textbox', { name: 'Hands-on minutes for step 1', exact: true }).fill('5');
  await page.getByRole('textbox', { name: 'Waiting minutes for step 1', exact: true }).fill('30');
  await page.getByRole('textbox', { name: 'Oven heat for step 1', exact: true }).fill('400');
  await expect(line).toHaveAccessibleName(
    'Timing for step 1: 5 min hands-on · 30 min waiting · Oven 400 °F',
  );
  await afterPageTimers(page, 300);
  await line.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/meal-timeline-editor-desktop.png' });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  const [first] = writes[0].steps as { timing?: unknown }[];
  expect(first.timing).toEqual({ active: 300, wait: 1800, oven: 204, burners: 0 });
});
