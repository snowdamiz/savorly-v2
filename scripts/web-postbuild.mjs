// Runs after `expo export --platform web` (the root `npm run build`). The app loads its Manrope
// fonts from JavaScript, so without help they only start downloading once the whole bundle has
// run; preload links in index.html start them alongside it. With EXPO_PUBLIC_MEDIA_ORIGIN set
// (where recipe photos are served from), a preconnect link opens that connection early too.
// Rerunning replaces its own links. No dependencies.
//   node scripts/web-postbuild.mjs [dist directory, default apps/mobile/dist]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(
  process.argv[2] ?? fileURLToPath(new URL('../apps/mobile/dist/', import.meta.url)),
);
const indexFile = path.join(dist, 'index.html');
const start = '<!-- web-postbuild -->';
const end = '<!-- /web-postbuild -->';

let html;
try {
  html = await readFile(indexFile, 'utf8');
} catch {
  console.error(`web-postbuild: ${indexFile} is missing; run the web export first.`);
  process.exit(1);
}
html = html.replace(new RegExp(`\\s*${start}[\\s\\S]*?${end}`), '');

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    ),
  );
  return nested.flat();
}
const url = (file) => `/${path.relative(dist, file).split(path.sep).join('/')}`;

// The fonts: the families App.tsx passes to expo-font's useFonts, whose keys survive minification
// as `useFonts)({Manrope_400Regular:…,…})`, matched to the exported files (`<family>.<hash>.ttf`).
const scripts = [...html.matchAll(/<script[^>]*\ssrc="\/([^"]+\.js)"/g)].map((m) => m[1]);
const code = (
  await Promise.all(scripts.map((src) => readFile(path.join(dist, src), 'utf8').catch(() => '')))
).join('\n');
const families = new Set(
  [...code.matchAll(/useFonts\)\(\{([^}]*)\}/g)].flatMap((m) =>
    [...m[1].matchAll(/([A-Za-z][\w]*):/g)].map((key) => key[1]),
  ),
);
const exported = (await files(dist)).filter((file) => /\.(ttf|otf)$/.test(file));
const fonts = exported.filter((file) => families.has(path.basename(file).split('.')[0]));
if (!fonts.length)
  console.warn(
    "web-postbuild: found no useFonts() fonts in the bundle, so nothing is preloaded. Check the pattern above if App.tsx's font loading changed.",
  );

let media;
const origin = process.env.EXPO_PUBLIC_MEDIA_ORIGIN?.trim();
if (origin) {
  try {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('not http(s)');
    media = parsed.origin;
  } catch {
    console.warn(`web-postbuild: EXPO_PUBLIC_MEDIA_ORIGIN "${origin}" isn't a URL; no preconnect.`);
  }
}

const links = [
  // Photos and videos are plain <img>/<video> requests (no CORS), so no crossorigin here.
  ...(media ? [`<link rel="preconnect" href="${media}">`] : []),
  // Fonts are always fetched with CORS, so their preloads need crossorigin to be reused.
  ...fonts.map(
    (file) =>
      `<link rel="preload" href="${url(file)}" as="font" type="font/${path.extname(file).slice(1)}" crossorigin>`,
  ),
];
if (!html.includes('</head>')) {
  console.error('web-postbuild: index.html has no </head>.');
  process.exit(1);
}
if (links.length)
  html = html.replace('</head>', `\n  ${start}\n  ${links.join('\n  ')}\n  ${end}\n</head>`);
await writeFile(indexFile, html);
console.log(
  `web-postbuild: preloading ${fonts.length} font${fonts.length === 1 ? '' : 's'}` +
    (media ? `, preconnecting to ${media}` : ''),
);
