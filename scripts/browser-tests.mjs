// Runs the app's browser tests (apps/mobile/tests) against an Expo dev server it starts from this
// checkout on a free port, so a worktree tests its own code even while another checkout's Expo
// has 8081. The pre-push hook (.githooks/pre-push) runs it; CI doesn't run the browser tests.
// Without the API, smoke.spec.ts is left out (playwright.config.ts); run it with the API and Expo
// up: `npm --prefix apps/mobile run test:e2e -- smoke.spec.ts`. Arguments go to Playwright.
// No dependencies.
//   node scripts/browser-tests.mjs [playwright arguments]
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
const bin = (name) => path.join(app, 'node_modules', '.bin', name);
if (!existsSync(bin('playwright'))) {
  console.error('The app’s packages aren’t installed. Run: npm --prefix apps/mobile ci');
  process.exit(1);
}

const free = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
// From 8090, clear of the API (8080), Expo (8081) and serve-dist (8082).
let port = 8090;
while (!(await free(port))) port++;
const url = `http://localhost:${port}`;

const log = path.join(os.tmpdir(), `savorly-browser-tests-${port}.log`);
const out = openSync(log, 'w');
// CI=1 keeps Expo from asking questions; detached puts it in its own process group to stop.
const expo = spawn(bin('expo'), ['start', '--port', String(port)], {
  cwd: app,
  env: { ...process.env, CI: '1' },
  detached: true,
  stdio: ['ignore', out, out],
});
const stop = () => {
  try {
    process.kill(-expo.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
};
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));

const get = (address) =>
  fetch(address)
    .then((r) => (r.ok ? r.text() : undefined))
    .catch(() => undefined);
const until = Date.now() + 120_000;
let page;
while (!(page = await get(url))) {
  if (expo.exitCode !== null || Date.now() > until) {
    console.error(`Expo didn't start on ${url}; its output is in ${log}.`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
// Bundles the app once before the first test, so that test doesn't spend its time waiting on it.
const bundle = page.match(/<script src="([^"]+)"/)?.[1];
if (bundle) await get(new URL(bundle, url));

const tests = spawn(bin('playwright'), ['test', ...process.argv.slice(2)], {
  cwd: app,
  env: { ...process.env, TEST_WEB_URL: url, TEST_WITHOUT_API: '1' },
  stdio: 'inherit',
});
tests.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
