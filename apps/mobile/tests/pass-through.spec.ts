import { expect, Locator, Page, test } from '@playwright/test';
import { mockApi, recipe } from './mockApi';

// Layers drawn over the page whose own box must let clicks through to what is under it, keeping
// them only for their buttons (passThrough in ui.tsx). React Native Web drops the inline style
// for that, so a layer written with it inline blocks the page across its whole box.

const recipes = ['Italian', 'Mexican', 'Japanese', 'Indian', 'French', 'Thai', 'Greek'].map(
  (cuisine, i) => recipe({ id: `r${i}`, title: `${cuisine} supper`, cuisine }),
);

/** Whether a click at (x, y) lands inside `layer` itself rather than on the page under it. */
const blocks = (layer: Locator, x: number, y: number) =>
  layer.evaluate(
    (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
    { x, y },
  );

async function home(page: Page) {
  await mockApi(page, { recipes });
  await page.goto('/');
  await expect(page.getByRole('link', { name: /^Let’s get cooking: / })).toBeVisible();
}

test('beside the phone tab bar, clicks reach the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await home(page);
  const tabs = page.getByRole('tablist');
  await expect(tabs).toBeVisible();
  const bar = (await tabs.boundingBox())!;
  expect(bar.x).toBeGreaterThan(4);
  // The strip the bar sits in spans the screen; level with the bar, just left of it.
  const strip = tabs.locator('xpath=..');
  expect(await blocks(strip, bar.x / 2, bar.y + bar.height / 2)).toBe(false);
  // The bar itself still takes its taps.
  expect(await blocks(strip, bar.x + bar.width / 2, bar.y + bar.height / 2)).toBe(true);
});

test('under a carousel’s faded edge, the cards still take clicks', async ({ page }) => {
  await home(page);
  const more = page.getByRole('button', { name: 'Scroll for more', exact: true }).first();
  await expect(more).toBeVisible();
  // The edge is the button's layer: a gradient across 88 points, with the button at its end.
  const edge = more.locator('xpath=..');
  const box = (await edge.boundingBox())!;
  const button = (await more.boundingBox())!;
  expect(button.x - box.x).toBeGreaterThan(20);
  const y = button.y + button.height / 2;
  expect(await blocks(edge, box.x + 10, y)).toBe(false);
  expect(await blocks(edge, button.x + button.width / 2, y)).toBe(true);
});
