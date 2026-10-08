// Render the app's own vector mark into the platform icon sizes.
import { chromium } from '../apps/mobile/node_modules/playwright/index.mjs';
import { writeFile, copyFile } from 'node:fs/promises';
const path = 'M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#1B1C1A"/><svg x="220" y="196" width="584" height="584" viewBox="0 0 24 24" fill="none" stroke="#F7F8F5" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/><path d="M6 17h12"/></svg><circle cx="734" cy="742" r="31" fill="#CAD5AE"/></svg>`;
await writeFile('apps/mobile/assets/brand.svg', svg);
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
for (const [size, name] of [[1024, 'icon.png'], [64, 'favicon.png']]) {
 const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
 await page.setContent(`<style>html,body{margin:0}svg{width:100vw;height:100vh;display:block}</style>${svg}`);
 await page.screenshot({ path: `apps/mobile/assets/${name}` });
 await page.close();
}
await browser.close();
await copyFile('apps/mobile/node_modules/lucide-react-native/LICENSE', 'apps/mobile/assets/LUCIDE-LICENSE.txt');
