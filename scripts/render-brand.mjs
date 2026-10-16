// Render the approved Happy Clove artwork; no image service or tracing dependency is needed.
import { chromium } from '../apps/mobile/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import artwork from '../apps/mobile/assets/brand-artwork.json' with { type: 'json' };

const assets = new URL('../apps/mobile/assets/', import.meta.url);
const { ink, cream } = artwork.colors;
const path = (d, fill) => `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`;
const clove = (monochrome = false) =>
  path(artwork.clove.path, ink) + (monochrome ? '' : path(artwork.clove.eyes, cream));
const svg = (body, viewBox = '0 0 1024 1024') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const mark = (size, monochrome = false) =>
  `<svg x="${(1024 - size) / 2}" y="${(1024 - size) / 2}" width="${size}" height="${size}" viewBox="${artwork.clove.viewBox}">${clove(monochrome)}</svg>`;
const background = `<rect width="1024" height="1024" fill="${cream}"/>`;
const icon = svg(background + mark(704));

const config = JSON.parse(await readFile(new URL('../app.json', assets), 'utf8'));
if (config.expo.android.adaptiveIcon.backgroundColor !== cream) {
  throw new Error('Android adaptiveIcon.backgroundColor must match the brand cream color.');
}

await writeFile(new URL('brand.svg', assets), icon);
await writeFile(new URL('brand-mark.svg', assets), svg(clove(), artwork.clove.viewBox));
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
    [64, 'favicon.png', svg(background + mark(768))],
    // The entire clove fits inside Android's guaranteed 66/108 safe circle.
    [512, 'android-icon-foreground.png', svg(mark(560))],
    // Themed icons use alpha only: the eyes and clove separation must remain cutouts.
    [512, 'android-icon-monochrome.png', svg(mark(560, true))],
    [1024, 'splash-icon.png', svg(mark(704))],
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
console.log('Rendered Happy Clove SVGs, app icon, favicon, Android layers, and splash artwork.');
