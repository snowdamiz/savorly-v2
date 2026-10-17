// Load test for the API: registers throwaway accounts, signs each one in, lists recipes and
// optionally uploads a photo, a set number of users at a time; then deletes every account it made
// and reports latency percentiles and errors for each step. Node 22, no dependencies.
//
//   !! It creates real accounts. Run it only against a local API or staging, never production. !!
//
//   node scripts/loadtest.mjs --base http://localhost:8080 [--users 20] [--concurrency 5]
//     [--upload] [--photo file] [--client-ip-header X-Savorly-Client-IP] [--yes]
//
// --base is the API root without /v1: http://localhost:8080 locally, https://staging.savorly.cooking/api
// on staging (other hosts than localhost need --yes). --upload sends a photo per user
// (apps/mobile/tests/fixtures/sample.png, or --photo); uploaded files stay in the bucket.
//
// Sign-up and sign-in share a limit of 15 requests per 15 minutes per visitor address, so from
// one machine a bigger run mostly measures refusals (429). To give each simulated user its own
// address, start a local API with TRUSTED_PROXY_HEADER=X-Savorly-Client-IP and pass
// --client-ip-header X-Savorly-Client-IP. Through Cloudflare the Worker overwrites that header, so
// staging can't be tested that way. Bot protection on sign-up must be off on the target. To
// approximate the `basic` container, run the API image with `--cpus 0.25 --memory 1g`
// (docs/DEPLOYMENT.md#capacity).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({
  options: {
    base: { type: 'string' },
    users: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '5' },
    upload: { type: 'boolean', default: false },
    photo: { type: 'string' },
    'client-ip-header': { type: 'string' },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});
const usage =
  'usage: node scripts/loadtest.mjs --base <API root> [--users N] [--concurrency N] [--upload] [--photo file] [--client-ip-header NAME] [--yes]';
if (options.help || !options.base) {
  console.log(usage);
  process.exit(options.help ? 0 : 2);
}
const base = options.base.replace(/\/+$/, '');
const host = new URL(base).hostname;
const users = Number(options.users);
const concurrency = Number(options.concurrency);
if (!Number.isInteger(users) || users < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error(usage);
  process.exit(2);
}

console.warn(
  [
    '',
    `!! LOAD TEST: this creates ${users} real accounts on ${host}.`,
    '!! Run it only against a local API or staging, never production. The accounts are',
    '!! deleted at the end; uploaded photos stay in the bucket.',
    '',
  ].join('\n'),
);
if (['savorly.cooking', 'www.savorly.cooking'].includes(host)) {
  console.error('Refusing to run against production.');
  process.exit(2);
}
if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !options.yes) {
  console.error(`${host} isn't local: pass --yes if it is a staging or test deployment.`);
  process.exit(2);
}

const photo =
  options.upload || options.photo
    ? new Blob([
        await readFile(
          options.photo ?? new URL('../apps/mobile/tests/fixtures/sample.png', import.meta.url),
        ),
      ])
    : undefined;
const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const timings = new Map(); // step → [ms]
const errors = new Map(); // step → { status → count }
const created = []; // { email, password, token, headers }

async function call(step, method, path, { json, form, headers = {} } = {}) {
  const started = performance.now();
  let status = 'network';
  let body;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : form,
      signal: AbortSignal.timeout(60_000),
    });
    status = response.status;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (response.ok) return { ok: true, body };
  } catch (error) {
    status = error.name === 'TimeoutError' ? 'timeout' : 'network';
  } finally {
    if (!timings.has(step)) timings.set(step, []);
    timings.get(step).push(performance.now() - started);
  }
  const counts = errors.get(step) ?? {};
  counts[status] = (counts[status] ?? 0) + 1;
  errors.set(step, counts);
  return { ok: false, status, body };
}

// One simulated cook. Addresses come from 198.18.0.0/15, the range set aside for benchmarks.
async function cook(n) {
  const headers = options['client-ip-header']
    ? { [options['client-ip-header']]: `198.18.${(n >> 8) & 255}.${n & 255}` }
    : {};
  const email = `loadtest+${run}-${n}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const registered = await call('register', 'POST', '/v1/auth/register', {
    json: { name: `Load Test ${n}`, email, password },
    headers,
  });
  if (!registered.ok) return;
  const account = { email, password, token: registered.body?.token, headers };
  created.push(account);
  const signedIn = await call('login', 'POST', '/v1/auth/login', {
    json: { email, password },
    headers,
  });
  if (signedIn.ok && signedIn.body?.token) account.token = signedIn.body.token;
  await call('list recipes', 'GET', '/v1/recipes?limit=24', { headers });
  if (photo && account.token) {
    const form = new FormData();
    form.append('file', photo, 'loadtest.png');
    await call('upload photo', 'POST', '/v1/media', {
      form,
      headers: { ...headers, Authorization: `Bearer ${account.token}` },
    });
  }
}

async function pool(count, work) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) await work(next++);
  });
  await Promise.all(lanes);
}

// Deletes every account this run made, also after Ctrl-C.
let cleaning;
async function cleanUp() {
  cleaning ??= (async () => {
    const left = [];
    await pool(created.length, async (i) => {
      const account = created[i];
      const deleted =
        account.token &&
        (
          await call('delete account', 'DELETE', '/v1/me', {
            json: { password: account.password },
            headers: { ...account.headers, Authorization: `Bearer ${account.token}` },
          })
        ).ok;
      if (!deleted) left.push(account.email);
    });
    return left;
  })();
  return cleaning;
}
process.once('SIGINT', async () => {
  console.warn('\nInterrupted: deleting the accounts made so far…');
  const left = await cleanUp();
  if (left.length) console.error(`Not deleted: ${left.join(', ')}`);
  process.exit(130);
});

const started = performance.now();
await pool(users, cook);
const left = await cleanUp();
const seconds = (performance.now() - started) / 1000;

const percentile = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`);
const rows = [...timings].map(([step, list]) => {
  const sorted = [...list].sort((a, b) => a - b);
  const failed = errors.get(step) ?? {};
  const failures = Object.values(failed).reduce((sum, n) => sum + n, 0);
  return {
    step,
    requests: sorted.length,
    errors: failures
      ? Object.entries(failed)
          .map(([status, n]) => `${n}×${status}`)
          .join(' ')
      : '0',
    p50: ms(percentile(sorted, 0.5)),
    p95: ms(percentile(sorted, 0.95)),
    p99: ms(percentile(sorted, 0.99)),
    max: ms(sorted.at(-1)),
  };
});
const total = rows.reduce((sum, row) => sum + row.requests, 0);
console.log(`\n${users} users, ${concurrency} at a time, against ${base}`);
console.table(rows);
console.log(`${total} requests in ${seconds.toFixed(1)}s (${(total / seconds).toFixed(1)}/s).`);
if (left.length) {
  console.error(
    `\nThese accounts could not be deleted; remove them from the admin console:\n  ${left.join('\n  ')}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Deleted all ${created.length} accounts this run created.`);
}
