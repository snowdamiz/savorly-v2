// Serves the exported web app (apps/mobile/dist) the way the Worker's static assets do: files by
// path, /privacy from privacy.html, and index.html for every other page (single-page fallback).
// CI runs browser tests against it, so they exercise the production bundle rather than Metro.
// The API isn't proxied: export with EXPO_PUBLIC_API_URL pointing at a running API, and list
// this server's origin in that API's ALLOWED_ORIGINS. No dependencies.
//   node scripts/serve-dist.mjs [directory]   (PORT, default 8082; HOST, default 127.0.0.1)
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  process.argv[2] ?? fileURLToPath(new URL('../apps/mobile/dist/', import.meta.url)),
);
const port = Number(process.env.PORT || 8082);
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
};

// infra/cloudflare/site.ts isHashedAsset.
const hashed = /^\/(?:_expo\/static|assets)\/.*[.-][0-9a-f]{32}\.[A-Za-z0-9]+$/;

const isFile = (file) =>
  stat(file).then(
    (s) => (s.isFile() ? file : undefined),
    () => undefined,
  );

// A file inside root for the URL path, trying `<path>.html` and `<path>/index.html` too.
async function find(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const target = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (target !== root && !target.startsWith(root + path.sep)) return undefined;
  return (
    (await isFile(target)) ??
    (await isFile(`${target}.html`)) ??
    (await isFile(path.join(target, 'index.html')))
  );
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  // Paths without an extension are app pages; a missing file with one is a real 404.
  const file =
    (await find(pathname)) ??
    (path.posix.extname(pathname) ? undefined : path.join(root, 'index.html'));
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
    return;
  }
  response.writeHead(200, {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    // Like the Worker: content-hashed bundles and assets are kept for good, so expo-font reuses
    // the preloaded fonts (scripts/web-postbuild.mjs); everything else is revalidated.
    'Cache-Control': hashed.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
});
server.listen(port, host, () =>
  console.log(`Serving ${root} at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`),
);
