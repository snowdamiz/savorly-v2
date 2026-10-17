// Ships the Android app for an EAS build profile. When EAS already has a build of this native
// code (same fingerprint, which is the runtime version), the JavaScript goes out as an
// over-the-air update on the profile's channel; otherwise a new build is queued. Usage:
//   node scripts/ship-app.mjs staging|production [--dry-run]
// Needs `eas login` (or EXPO_TOKEN) and apps/mobile/node_modules. See docs/UPDATES.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [target, ...options] = process.argv.slice(2);
const dryRun = options.includes('--dry-run');
if (!['staging', 'production'].includes(target)) {
  console.error('usage: ship-app.mjs staging|production [--dry-run]');
  process.exit(2);
}
const platform = 'android';
const app = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
const profile = JSON.parse(readFileSync(`${app}eas.json`, 'utf8')).build[target];

// CI installs this EAS CLI version globally (eas-version in .github/workflows/ci.yml; bump both
// together); elsewhere npx fetches it unless an `eas` is installed.
const easCli = 'eas-cli@24.14.0';
const cli = spawnSync('eas', ['--version']).status === 0 ? ['eas'] : ['npx', '--yes', easCli];
const eas = (args, { json = false, env = {} } = {}) => {
  const flags = json ? ['--json', '--non-interactive'] : ['--non-interactive'];
  const out = execFileSync(cli[0], [...cli.slice(1), ...args, ...flags], {
    cwd: app,
    encoding: 'utf8',
    maxBuffer: 1 << 28, // fingerprint JSON lists every hashed file
    env: { ...process.env, ...env },
    stdio: ['ignore', json ? 'pipe' : 'inherit', 'inherit'],
  });
  return json ? JSON.parse(out) : out;
};

const { hash } = eas(['fingerprint:generate', '--build-profile', target, '--platform', platform], {
  json: true,
});
const builds = eas(
  ['build:list', '--platform', platform, '--build-profile', target, '--runtime-version', hash],
  { json: true },
);
const build = builds.find((b) => !['ERRORED', 'CANCELED', 'PENDING_CANCEL'].includes(b.status));

if (build) {
  console.log(
    `Build ${build.id} (${build.status.toLowerCase()}) has runtime ${hash.slice(0, 7)}, ` +
      `so this ships as an update on the "${profile.channel}" channel.`,
  );
  if (dryRun) process.exit(0);
  const message = execFileSync('git', ['log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim();
  // eas update doesn't apply a build profile's env, which sets the API URL baked into the
  // bundle and, through app.config.js, the runtime version. Pass it on here.
  eas(
    [
      'update',
      '--channel',
      profile.channel,
      '--environment',
      profile.environment,
      '--platform',
      platform,
      '--message',
      message,
    ],
    { env: profile.env },
  );
} else {
  console.log(`No ${target} build has runtime ${hash.slice(0, 7)} yet, so this needs a build.`);
  if (dryRun) process.exit(0);
  eas(['build', '--platform', platform, '--profile', target, '--no-wait']);
}
