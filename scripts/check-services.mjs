// Stops `make check` early, saying what to do, when the Postgres or object storage its Go tests
// use isn't running; otherwise those suites would fail one by one with connection errors. Only
// checks that something answers on each address. No dependencies.
//   node scripts/check-services.mjs <postgres URL> [<S3 endpoint URL>]
import net from 'node:net';

function reach(label, raw, defaultPort) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return resolve(`${label}: "${raw}" isn't a URL.`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || defaultPort);
    const socket = net.connect({ host, port, timeout: 3000 });
    const done = (problem) => {
      socket.destroy();
      resolve(problem);
    };
    socket.once('connect', () => done());
    socket.once('timeout', () => done(`${label} isn't answering on ${host}:${port}.`));
    socket.once('error', () => done(`${label} isn't answering on ${host}:${port}.`));
  });
}

const [database, storage] = process.argv.slice(2);
const problems = (
  await Promise.all([
    reach('Postgres (TEST_DATABASE_URL)', database ?? '', 5432),
    storage ? reach('Object storage (TEST_S3_ENDPOINT)', storage, 80) : undefined,
  ])
).filter(Boolean);
if (problems.length) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(
    'The Go tests need them: start the local ones with `make services`, or point the tests\n' +
      'elsewhere, e.g. make check TEST_DATABASE_URL=postgres://… TEST_S3_ENDPOINT=http://…',
  );
  process.exit(1);
}
