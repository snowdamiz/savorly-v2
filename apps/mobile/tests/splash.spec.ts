import { expect, test } from '@playwright/test';

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
      const state = { frames: 0 };
      Object.assign(window, { splashFrames: state });
      window.requestAnimationFrame = (callback) =>
        original((time) => {
          state.frames++;
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
      // Cross the minimum splash duration while fonts are still held back.
      await page.waitForTimeout(1200);
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
      // Finite page-entry animations settle; the removed splash must leave no animation loop.
      await page.waitForTimeout(1800);
      const frames = () =>
        page.evaluate(
          () => (window as unknown as { splashFrames: { frames: number } }).splashFrames.frames,
        );
      const before = await frames();
      await page.waitForTimeout(1200);
      expect(await frames()).toBe(before);
    } finally {
      releaseFonts();
      releaseData();
    }
  });
}
