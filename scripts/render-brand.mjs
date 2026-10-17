// Render the approved Curious Chef artwork; no image service or tracing dependency is needed.
import { chromium } from '../apps/mobile/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import artwork from '../apps/mobile/assets/brand-artwork.json' with { type: 'json' };

const assets = new URL('../apps/mobile/assets/', import.meta.url);
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
// Match Splash.tsx's resting frame: a 112px chef, 10px gap and 64x10px shadow,
// centered as a 132px-tall group within the native splash's 160px image.
const splash = svg(
  `<svg x="24" y="14" width="112" height="112" viewBox="${artwork.mascot.viewBox}">${mascot()}</svg>` +
    '<rect x="48" y="136" width="64" height="10" rx="5" fill="rgba(27,28,26,0.16)"/>',
  '0 0 160 160',
);

const config = JSON.parse(await readFile(new URL('../app.json', assets), 'utf8'));
if (config.expo.android.adaptiveIcon.backgroundColor !== cream) {
  throw new Error('Android adaptiveIcon.backgroundColor must match the brand cream color.');
}

await writeFile(new URL('brand.svg', assets), icon);
await writeFile(new URL('brand-mark.svg', assets), svg(mascot(), artwork.mascot.viewBox));
await writeFile(
  new URL('brand-wordmark.svg', assets),
  svg(path(artwork.wordmark.path, ink), artwork.wordmark.viewBox),
);

const browser = await chromium.launch({
  channel: process.env.CI ? undefined : 'chrome',
  headless: true,
});
try {
  for (const [size, name, art] of [
    [1024, 'icon.png', icon],
    // Give the eyes more pixels when the browser scales the favicon down to 16px.
    [64, 'favicon.png', svg(background + mark(896))],
    // The entire mascot fits inside Android's guaranteed 66/108 safe circle.
    [512, 'android-icon-foreground.png', svg(mark(560))],
    // Themed icons use alpha only: light details are cutouts, with opaque pupil islands.
    [512, 'android-icon-monochrome.png', svg(mark(560, true))],
    [1024, 'splash-icon.png', splash],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(
        `<style>html,body{margin:0;width:100%;height:100%;background:transparent}body>svg{width:100%;height:100%;display:block}</style>${art}`,
      );
      await page.screenshot({ path: new URL(name, assets).pathname, omitBackground: true });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log('Rendered Curious Chef SVGs, app icon, favicon, Android layers, and splash artwork.');
