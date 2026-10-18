import { chromium, defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// CI runs the tests in Playwright's own Chromium, pinned to this Playwright version; locally they
// use it too once it's installed (`npx playwright install chromium`), so both see the same browser.
// Until then the installed Google Chrome stands in, which can differ in version and behaviour.
// PLAYWRIGHT_CHANNEL picks a browser explicitly (`chrome`, `msedge`, …).
const bundled = existsSync(chromium.executablePath());
const channel = process.env.PLAYWRIGHT_CHANNEL || (bundled ? undefined : 'chrome');
const workers = process.env.TEST_WORKERS;
if (!bundled && !process.env.PLAYWRIGHT_CHANNEL && !process.env.TEST_WORKER_INDEX)
  console.warn(
    'Playwright’s Chromium isn’t installed, so the tests run in Google Chrome rather than the ' +
      'browser CI uses. Install it with: npx playwright install chromium',
  );

export default defineConfig({
  testDir: './tests',
  // The pre-push hook (scripts/browser-tests.mjs) runs without the API, so it leaves out the one
  // spec that needs it.
  testIgnore: process.env.TEST_WITHOUT_API ? ['smoke.spec.ts'] : [],
  timeout: 60000,
  // Spec files run side by side, and a file's tests one after another. By default there are half
  // as many workers as the machine has cores (Playwright's default); TEST_WORKERS sets a number
  // or a percentage of the cores, as on a busy machine.
  fullyParallel: false,
  workers: /^\d+$/.test(workers ?? '') ? Number(workers) : workers || undefined,
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
