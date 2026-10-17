import { expect, Page, test } from '@playwright/test';
import type { Plan } from '../src/lib/types';
import { json, mockApi, recipe, recipeCard } from './mockApi';

// The meal planner's previous and next week buttons, and planning a meal on a chosen day of
// another week (POST /planner with that day). A phone, whose day strip names each day.

// Fixed dates need a fixed zone and locale: the clock starts at midday on Friday 16 October 2026,
// in a US week (Sunday to Saturday), and runs on so the app's animations still finish.
test.use({ timezoneId: 'UTC', locale: 'en-US', viewport: { width: 390, height: 844 } });
const NOW = new Date('2026-10-16T12:00:00Z');

const pasta = recipe({ id: 'pasta', title: 'Lemon pasta', servings: 3 });
const soup = recipe({ id: 'soup', title: 'Pumpkin soup' });

async function planner(page: Page) {
  await page.clock.install({ time: NOW });
  const api = await mockApi(page, { recipes: [pasta, soup] });
  const { plans } = api.state.kitchen;
  api.on('POST', '/planner', ({ body }) => {
    const sent = body as Omit<Plan, 'id' | 'recipe'>;
    const planned = [pasta, soup].find((r) => r.id === sent.recipeId)!;
    plans.push({ ...sent, id: `plan-${plans.length + 1}`, recipe: planned });
    return json({ ok: true });
  });
  return api;
}
/** The week on show: its dates over the day strip, and the strip's seven days in order. */
const expectWeek = async (page: Page, range: string, first: number, month = 'October') => {
  await expect(page.getByText(range, { exact: true })).toBeVisible();
  const days = page.getByRole('button', {
    name: /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, \w+ \d+$/,
  });
  await expect(days).toHaveCount(7);
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const [i, weekday] of weekdays.entries())
    await expect(days.nth(i)).toHaveAccessibleName(`${weekday}, ${month} ${first + i}`);
};

test('the week buttons change the days, and a meal is planned on the day picked', async ({
  page,
}) => {
  const api = await planner(page);
  await page.goto('/?page=planner');
  await expectWeek(page, 'Oct 11 – Oct 17', 11);
  await expect(page.getByText('This week · 0 planned', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Previous week', exact: true }).click();
  await expectWeek(page, 'Oct 4 – Oct 10', 4);
  await expect(page.getByText('Tap for this week · 0 planned', { exact: true })).toBeVisible();

  const next = page.getByRole('button', { name: 'Next week', exact: true });
  await next.click();
  await expectWeek(page, 'Oct 11 – Oct 17', 11);
  await next.click();
  await expectWeek(page, 'Oct 18 – Oct 24', 18);

  // Wednesday of that week, at dinner.
  await page.getByRole('button', { name: 'Wednesday, October 21', exact: true }).click();
  await page.getByRole('button', { name: 'Add Dinner', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What’s for dinner?' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan Lemon pasta', exact: true }).click();
  await expect(page.getByText('Added to your week.', { exact: true })).toBeVisible();
  expect(api.sentTo('/planner')).toEqual([
    ['POST', { day: '2026-10-21', meal: 'Dinner', recipeId: 'pasta', servings: 3 }],
  ]);
  await expect(recipeCard(page, 'Lemon pasta')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove Dinner on Wednesday, October 21', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Tap for this week · 1 planned', { exact: true })).toBeVisible();
  // The day next to it is still free, and this week has nothing new.
  await page.getByRole('button', { name: 'Thursday, October 22', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Dinner', exact: true })).toBeVisible();
  await expect(recipeCard(page, 'Lemon pasta')).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to this week', exact: true }).click();
  await expectWeek(page, 'Oct 11 – Oct 17', 11);
  await expect(page.getByText('This week · 0 planned', { exact: true })).toBeVisible();
});
