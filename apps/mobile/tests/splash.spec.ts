import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { splashEyeOrigin, splashSize } from '../src/lib/splashGeometry';

test('blink anchor survives the actual native transform-origin parser', () => {
  const nativeRequire = createRequire(require.resolve('react-native/package.json'));
  const filename = nativeRequire.resolve('./Libraries/StyleSheet/processTransformOrigin');
  const { transformSync } = nativeRequire('@babel/core');
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [
      nativeRequire.resolve('@babel/plugin-transform-flow-strip-types'),
      nativeRequire.resolve('@babel/plugin-transform-modules-commonjs'),
    ],
  });
  const module = { exports: {} as { default?: (origin: unknown) => number[] } };
  runInNewContext(code, { module, exports: module.exports, require: nativeRequire, __DEV__: true });
  const origin = module.exports.default!(splashEyeOrigin);
  // A closed eye must still be centered 71.3% down the mascot, not 3% down it.
  expect(origin).toEqual([splashSize * 0.576, splashSize * 0.713, 0]);
});

test('the eyes stay attached to the face throughout a full blink', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/v1/**', (route) => route.abort());
  let releaseFonts!: () => void;
  const fonts = new Promise<void>((resolve) => {
    releaseFonts = resolve;
  });
  await page.route(/\.(ttf|otf)(\?|$)/, async (route) => {
    await fonts;
    await route.continue();
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('splash-eyes')).toBeVisible();
    const frames = await page.evaluate(async () => {
      const eyes = document.querySelector('[data-testid="splash-eyes"]')!;
      const mascot = document.querySelector('[data-testid="splash-mascot"]')!;
      const eyePaths = eyes.querySelector('path')!;
      const samples: { scale: number; eyeY: number }[] = [];
      const start = performance.now();
      while (performance.now() - start < 3600) {
        await new Promise(requestAnimationFrame);
        const body = mascot.getBoundingClientRect();
        const eye = eyePaths.getBoundingClientRect();
        samples.push({
          scale: new DOMMatrix(getComputedStyle(eyes).transform).m22,
          eyeY: (eye.y + eye.height / 2 - body.y) / body.height,
        });
      }
      return samples;
    });
    expect(Math.min(...frames.map((frame) => frame.scale))).toBeLessThan(0.3);
    expect(Math.max(...frames.map((frame) => frame.scale))).toBe(1);
    for (const frame of frames) {
      expect(frame.eyeY).toBeGreaterThan(0.7);
      expect(frame.eyeY).toBeLessThan(0.73);
    }
  } finally {
    releaseFonts();
  }
});

test('native launch artwork matches the resting splash frame', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let releaseData!: () => void;
  const data = new Promise<void>((resolve) => {
    releaseData = resolve;
  });
  await page.route('**/v1/**', async (route) => {
    await data;
    await route.fulfill({ json: [] });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const splash = page.getByRole('progressbar');
    await expect(splash).toBeVisible();
    await expect(splash).toHaveCSS('background-color', 'rgb(244, 244, 244)');
    const actual = await page.screenshot({
      path: testInfo.outputPath('resting-splash.png'),
      clip: { x: 115, y: 342, width: 160, height: 160 },
    });
    const native = readFileSync(join(__dirname, '../assets/splash-icon.png'));
    const mismatch = await page.evaluate(
      async ({ actual, native }) => {
        const pixels = async (base64: string) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 160;
          const context = canvas.getContext('2d')!;
          context.fillStyle = '#F4F4F4';
          context.fillRect(0, 0, 160, 160);
          context.drawImage(image, 0, 0, 160, 160);
          return context.getImageData(0, 0, 160, 160).data;
        };
        const [a, b] = await Promise.all([pixels(actual), pixels(native)]);
        let different = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (
            Math.max(
              Math.abs(a[i] - b[i]),
              Math.abs(a[i + 1] - b[i + 1]),
              Math.abs(a[i + 2] - b[i + 2]),
            ) > 32
          )
            different++;
        }
        return different / (160 * 160);
      },
      { actual: actual.toString('base64'), native: native.toString('base64') },
    );
    // Allow raster downsampling at the outline, but no size, pose or position jump.
    expect(mismatch).toBeLessThan(0.01);
  } finally {
    releaseData();
  }
});

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
