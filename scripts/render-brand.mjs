// Render the approved Curious Chef artwork; no image service or tracing dependency is needed.
// `--web` renders only the web app's icons and link-preview image (apps/mobile/public), which
// leaves the native assets, and so the app's fingerprint, untouched.
import { chromium } from '../apps/mobile/node_modules/playwright/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import artwork from '../apps/mobile/assets/brand-artwork.json' with { type: 'json' };

const assets = new URL('../apps/mobile/assets/', import.meta.url);
const web = new URL('../apps/mobile/public/', import.meta.url);
const webOnly = process.argv.includes('--web');
const { ink, cream } = artwork.colors;
const path = (d, fill) => `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`;
const mascot = (monochrome = false) =>
  monochrome
    ? path(
        artwork.mascot.path + artwork.mascot.accents + artwork.mascot.eyes + artwork.mascot.pupils,
        ink,
      )
    : path(artwork.mascot.path, ink) +
      path(artwork.mascot.accents, cream) +
      path(artwork.mascot.eyes, cream) +
      path(artwork.mascot.pupils, ink);
const svg = (body, viewBox = '0 0 1024 1024') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const mark = (size, monochrome = false) =>
  `<svg x="${(1024 - size) / 2}" y="${(1024 - size) / 2}" width="${size}" height="${size}" viewBox="${artwork.mascot.viewBox}">${mascot(monochrome)}</svg>`;
const background = `<rect width="1024" height="1024" fill="${cream}"/>`;
const icon = svg(background + mark(704));
// Link previews (Open Graph, 1200 × 630): the chef beside the wordmark on cream.
const preview = (() => {
  const [width, height, markSize, wordHeight, gap] = [1200, 630, 300, 190, 36];
  const [, , w, h] = artwork.wordmark.viewBox.split(' ').map(Number);
  const wordWidth = (w / h) * wordHeight;
  const x = (width - markSize - gap - wordWidth) / 2;
  return svg(
    `<rect width="${width}" height="${height}" fill="${cream}"/>` +
      `<svg x="${x}" y="${(height - markSize) / 2}" width="${markSize}" height="${markSize}" viewBox="${artwork.mascot.viewBox}">${mascot()}</svg>` +
      `<svg x="${x + markSize + gap}" y="${(height - wordHeight) / 2}" width="${wordWidth}" height="${wordHeight}" viewBox="${artwork.wordmark.viewBox}">${path(artwork.wordmark.path, ink)}</svg>`,
    `0 0 ${width} ${height}`,
  );
})();

const config = JSON.parse(await readFile(new URL('../app.json', assets), 'utf8'));
if (config.expo.android.adaptiveIcon.backgroundColor !== cream) {
  throw new Error('Android adaptiveIcon.backgroundColor must match the brand cream color.');
}

if (!webOnly) {
  await writeFile(new URL('brand.svg', assets), icon);
  await writeFile(new URL('brand-mark.svg', assets), svg(mascot(), artwork.mascot.viewBox));
  await writeFile(
    new URL('brand-wordmark.svg', assets),
    svg(path(artwork.wordmark.path, ink), artwork.wordmark.viewBox),
  );
}
await mkdir(new URL('icons/', web), { recursive: true });

const browser = await chromium.launch({
  channel: process.env.CI ? undefined : 'chrome',
  headless: true,
});
try {
  for (const [size, name, art, folder = assets] of [
    ...(webOnly
      ? []
      : [
          [1024, 'icon.png', icon],
          // Give the eyes more pixels when the browser scales the favicon down to 16px.
          [64, 'favicon.png', svg(background + mark(896))],
          // The entire mascot fits inside Android's guaranteed 66/108 safe circle.
          [512, 'android-icon-foreground.png', svg(mark(560))],
          // Themed icons use alpha only: light details are cutouts, with opaque pupil islands.
          [512, 'android-icon-monochrome.png', svg(mark(560, true))],
          [1024, 'splash-icon.png', svg(mark(704))],
        ]),
    // The web app's manifest icons and the iOS home-screen icon (public/manifest.json).
    [192, 'icons/icon-192.png', icon, web],
    [512, 'icons/icon-512.png', icon, web],
    [180, 'icons/apple-touch-icon.png', icon, web],
    // Maskable icons keep the whole chef inside the central 80% circle launchers may crop to.
    [192, 'icons/maskable-192.png', svg(background + mark(640)), web],
    [512, 'icons/maskable-512.png', svg(background + mark(640)), web],
    [[1200, 630], 'og-image.png', preview, web],
  ]) {
    const [width, height] = Array.isArray(size) ? size : [size, size];
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<style>html,body{margin:0;width:100%;height:100%;background:transparent}body>svg{width:100%;height:100%;display:block}</style>${art}`,
      );
      await page.screenshot({ path: new URL(name, folder).pathname, omitBackground: true });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(
  webOnly
    ? 'Rendered the web icons and link-preview image.'
    : 'Rendered Curious Chef SVGs, app icon, favicon, Android layers, splash artwork, and the web icons and link-preview image.',
);
