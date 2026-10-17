import { chromium, defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// CI runs the tests in Playwright's own Chromium, pinned to this Playwright version; locally they
// use it too once it's installed (`npx playwright install chromium`), so both see the same browser.
// Until then the installed Google Chrome stands in, which can differ in version and behaviour.
// PLAYWRIGHT_CHANNEL picks a browser explicitly (`chrome`, `msedge`, …).
const bundled = existsSync(chromium.executablePath());
const channel = process.env.PLAYWRIGHT_CHANNEL || (bundled ? undefined : 'chrome');
if (!bundled && !process.env.PLAYWRIGHT_CHANNEL && !process.env.TEST_WORKER_INDEX)
  console.warn(
    'Playwright’s Chromium isn’t installed, so the tests run in Google Chrome rather than the ' +
      'browser CI uses. Install it with: npx playwright install chromium',
  );

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.TEST_WEB_URL || 'http://localhost:8081',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      channel,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
});
