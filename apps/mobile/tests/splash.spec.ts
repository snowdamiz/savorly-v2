import { expect, test } from '@playwright/test';
import { afterPageTimers } from './waits';

type Frames = { splashFrames: { frames: number; last: number } };

for (const mobile of [false, true]) {
  test(`one splash survives loading and stops animating (${mobile ? 'mobile, reduced motion' : 'desktop'})`, async ({
    page,
  }) => {
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    let releaseFonts!: () => void;
    let releaseData!: () => void;
    const fonts = new Promise<void>((resolve) => {
      releaseFonts = resolve;
    });
    const data = new Promise<void>((resolve) => {
      releaseData = resolve;
    });
    let dataRequested = false;
    await page.addInitScript(() => {
      const original = window.requestAnimationFrame.bind(window);
      const state = { frames: 0, last: 0 };
      Object.assign(window, { splashFrames: state });
      window.requestAnimationFrame = (callback) =>
        original((time) => {
          state.frames++;
          state.last = performance.now();
          callback(time);
        });
    });
    await page.route(/\.(ttf|otf)(\?|$)/, async (route) => {
      await fonts;
      await route.continue();
    });
    await page.route('**/v1/**', async (route) => {
      dataRequested = true;
      await data;
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/me')) return route.fulfill({ status: 401, json: { error: 'Sign in' } });
      return route.fulfill({ json: path.endsWith('/capabilities') ? {} : [] });
    });
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const splash = page.getByRole('progressbar');
      await expect(splash).toBeVisible();
      const initial = await splash.elementHandle();
      expect(initial).not.toBeNull();
      // Cross the splash's minimum time on screen (a second from when it appeared, Splash.tsx)
      // on the page's own clock, while fonts are still held back.
      await afterPageTimers(page, 1100);
      releaseFonts();
      await expect.poll(() => dataRequested).toBe(true);
      // Replacing this node restarts animated transforms and flashes the mascot between stages.
      expect(
        await initial!.evaluate(
          (node) => node.isConnected && node === document.querySelector('[role="progressbar"]'),
        ),
      ).toBe(true);
      await expect(splash).toHaveCSS('opacity', '1');
      releaseData();
      await expect(page.getByText('What would you like to cook today?')).toBeVisible();
      await expect(splash).toHaveCount(0);
      // Finite page-entry animations settle, and the removed splash must leave no animation loop:
      // the page stops asking for frames, none for a whole second, well within ten seconds.
      expect(
        await page.evaluate(() => (window as unknown as Frames).splashFrames.frames),
      ).toBeGreaterThan(0);
      await page.waitForFunction(
        () => performance.now() - (window as unknown as Frames).splashFrames.last > 1000,
        undefined,
        { polling: 100, timeout: 10_000 },
      );
    } finally {
      releaseFonts();
      releaseData();
    }
  });
}
