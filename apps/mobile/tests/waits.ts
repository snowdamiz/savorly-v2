import type { Locator, Page } from '@playwright/test';

// Waits tied to what the page is doing rather than to fixed sleeps in the test runner, which pass
// or fail with the machine's speed.

/**
 * Lets `ms` pass on the page's own timers. Whatever the page had already scheduled to run sooner,
 * such as a search debounce or a delayed save, has run by then, even when a busy machine runs
 * timers late. Use it before checking that something did NOT happen, or for an app delay that
 * nothing on screen shows.
 */
export const afterPageTimers = (page: Page, ms: number) =>
  page.evaluate((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)), ms);

/**
 * Waits until an element has kept the same place and size for `frames` animation frames in a
 * row, as when a sheet's spring has come to rest; fails if it is still moving after `timeout` ms.
 */
export const stopsMoving = (locator: Locator, frames = 20, timeout = 10_000) =>
  locator.evaluate(
    (element, { needed, limit }) =>
      new Promise<void>((resolve, reject) => {
        const until = performance.now() + limit;
        let last = '';
        let still = 0;
        const check = () => {
          const { x, y, width, height } = element.getBoundingClientRect();
          const box = `${x},${y},${width},${height}`;
          still = box === last ? still + 1 : 0;
          last = box;
          if (still >= needed) resolve();
          else if (performance.now() > until)
            reject(new Error(`Still moving after ${limit} ms (last at ${box}).`));
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
    { needed: frames, limit: timeout },
  );
