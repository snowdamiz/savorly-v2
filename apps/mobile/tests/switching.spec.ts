import { expect, Page, test } from '@playwright/test';
import type { ImportBatch, ImportItem } from '../src/lib/imports';
import { alex, failure, json, mockApi, recipe } from './mockApi';
import { afterPageTimers, stopsMoving } from './waits';

// Switching to Savorly: the page for Mealime's members (/?page=mealime), a creator's import of
// their own site (/?page=own-site), several links at once from Add a recipe, and the export as
// files. The server reads a batch one item at a time; this one moves an item on each look.

const orzo = recipe({ id: 'orzo', title: 'Chicken orzo with spinach' });
const mealimeLink = 'https://www.mealime.com/recipes/lemony-chicken-orzo/1234';
const notes = `https://cook.example/lemon-pasta
https://blog.example/leek-soup
${mealimeLink}
---
Grandma's stew
Ingredients
500 g beef
2 onions
Method
Brown the beef, add the onions and leave it in a low oven all afternoon.`;

/** A kitchen whose server reads bulk imports, one item further on each look at a batch. */
async function kitchen(page: Page, signedIn = true) {
  const api = await mockApi(page, { signedIn, recipes: [orzo] });
  const batches: ImportBatch[] = [];
  api.on('POST', '/imports', ({ body }) => {
    const {
      purpose = 'links',
      urls = [],
      texts = [],
    } = body as {
      purpose?: ImportBatch['purpose'];
      urls?: string[];
      texts?: string[];
    };
    const items: ImportItem[] = [
      ...urls.map((url) => ({ url, text: '' })),
      ...texts.map((text) => ({ url: '', text: text.split('\n')[0] })),
    ].map((item, i) => ({
      ...item,
      position: i + 1,
      status: item.url.includes('mealime') ? ('failed' as const) : ('queued' as const),
      error: item.url.includes('mealime')
        ? 'This is one of Mealime’s own recipes, which stay with Mealime. Look for a similar Savorly recipe instead.'
        : '',
      recipe: null,
    }));
    const site = purpose === 'own_site' ? new URL(urls[0]).hostname : '';
    const batch: ImportBatch = {
      id: `batch-${batches.length + 1}`,
      purpose,
      site,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      items,
    };
    batches.unshift(batch);
    return json(batch, 201);
  });
  api.on('GET', '/imports', ({ query }) =>
    json(batches.filter((b) => !query.get('purpose') || b.purpose === query.get('purpose'))),
  );
  api.on('GET', /^\/imports\/([^/]+)$/, ({ params: [id] }) => {
    const batch = batches.find((b) => b.id === id);
    if (!batch) return failure(404, 'This item could not be found.');
    const next = batch.items.find((i) => i.status === 'queued' || i.status === 'reading');
    if (next?.status === 'queued') next.status = 'reading';
    else if (next) {
      if (next.url.includes('blog.example')) {
        next.status = 'failed';
        next.error = 'We couldn’t find a recipe on that page.';
      } else {
        const title = next.text || 'Lemon & ricotta pasta';
        const draft = recipe({
          id: `draft-${next.position}`,
          title,
          author: alex,
          published: false,
        });
        api.state.recipes.push(draft);
        next.status = 'imported';
        next.recipe = { id: draft.id, title, image: '' };
      }
    }
    if (!batch.items.some((i) => i.status === 'queued' || i.status === 'reading'))
      batch.finishedAt = new Date().toISOString();
    return json(batch);
  });
  api.on('POST', '/imports/similar', ({ body }) =>
    json((body as { names: string[] }).names.map((name) => ({ name, recipes: [orzo] }))),
  );
  return { api, batches };
}

// Screenshots of each page at desktop and phone width, once the splash has gone: on a phone the
// top and, scrolled, the end. A sheet closes as the window changes size, so `open` opens it again.
const shot = async (page: Page, name: string, open?: () => Promise<void>) => {
  await expect(page.getByTestId('splash-mascot')).toHaveCount(0);
  const settled = async () => {
    const sheet = page.getByRole('dialog');
    if (await sheet.count()) await stopsMoving(sheet);
  };
  await settled();
  await page.screenshot({ path: `test-results/switching/${name}-desktop.png` });
  for (const [width, height] of [
    [390, 844],
    [1440, 1000],
  ]) {
    await page.setViewportSize({ width, height });
    await afterPageTimers(page, 400);
    await open?.();
    if (width === 1440) break;
    await settled();
    await page.screenshot({ path: `test-results/switching/${name}-phone.png` });
    if (open) continue;
    await page.mouse.move(195, 400);
    await page.mouse.wheel(0, 3000);
    await afterPageTimers(page, 400);
    await page.screenshot({ path: `test-results/switching/${name}-phone-end.png` });
  }
};

test('Mealime’s members see what comes over, and are asked to make a kitchen first', async ({
  page,
}) => {
  await kitchen(page, false);
  await page.goto('/?page=mealime');
  await expect(page.getByRole('heading', { name: 'Bring your recipes to Savorly' })).toBeVisible();
  await expect(
    page.getByText('Mealime’s own recipes stay with Mealime, so we’ll find similar ones here.'),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your recipes', exact: true })).toHaveCount(0);
  await shot(page, 'mealime-guest');
  // Finding a similar recipe needs no kitchen.
  await page.getByRole('textbox', { name: 'A Mealime recipe’s name' }).fill('Lemony chicken orzo');
  await page.getByRole('button', { name: 'Find similar recipes', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Like “Lemony chicken orzo”' })).toBeVisible();
  await expect(sheet.getByText('Chicken orzo with spinach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Create my free kitchen', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Create your kitchen', exact: true }),
  ).toBeVisible();
});

test('links and recipes a member wrote come over, read one at a time', async ({ page }) => {
  const { api } = await kitchen(page);
  await page.goto('/?page=mealime');
  const box = page.getByRole('textbox', { name: 'Your recipes', exact: true });
  await box.fill(notes);
  await page.getByRole('button', { name: 'Bring 4 recipes over', exact: true }).click();
  expect(api.sentTo('/imports')).toEqual([
    [
      'POST',
      {
        purpose: 'mealime',
        urls: ['https://cook.example/lemon-pasta', 'https://blog.example/leek-soup', mealimeLink],
        texts: [notes.split('---\n')[1]],
      },
    ],
  ]);
  await expect(box).toHaveValue('');
  await expect(page.getByText('4 recipes are in My kitchen as private drafts.')).toBeHidden();
  await expect(page.getByText('You can leave this page: Savorly keeps reading.')).toBeVisible();
  await shot(page, 'mealime-reading');
  await expect(page.getByText('2 recipes are in My kitchen as private drafts.')).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByText('We couldn’t find a recipe on that page.')).toBeVisible();
  await shot(page, 'mealime-done');
  // One of Mealime's own recipes finds similar ones, by the name in its link.
  await page
    .getByRole('button', { name: 'Find recipes like Lemony chicken orzo on Savorly', exact: true })
    .click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Like “Lemony chicken orzo”' }),
  ).toBeVisible();
  await stopsMoving(page.getByRole('dialog'));
  await page.screenshot({ path: 'test-results/switching/similar-desktop.png' });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  // An imported draft opens.
  await page.getByRole('button', { name: "Open Grandma's stew", exact: true }).click();
  await expect(page.getByText("Grandma's stew", { exact: true }).first()).toBeVisible();
});

test('a creator imports their own site, once they confirm the recipes are theirs', async ({
  page,
}) => {
  const { api } = await kitchen(page);
  await page.goto('/?page=own-site');
  await expect(
    page.getByRole('heading', { name: 'Bring your recipes from your own site' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Links to your recipes', exact: true })
    .fill(
      'https://www.cook.example/lemon-pasta\nhttps://cook.example/leek-pie\nhttps://elsewhere.example/soup',
    );
  await expect(
    page.getByText('1 link isn’t on cook.example, so it stays out: one site at a time.'),
  ).toBeVisible();
  const go = page.getByRole('button', { name: 'Import my recipes', exact: true });
  await expect(go).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: /^These recipes are my own and published on my own site, cook\.example\./,
    })
    .click();
  await shot(page, 'own-site');
  await go.click();
  expect(api.sentTo('/imports')).toEqual([
    [
      'POST',
      {
        purpose: 'own_site',
        urls: ['https://www.cook.example/lemon-pasta', 'https://cook.example/leek-pie'],
        ownRecipes: true,
      },
    ],
  ]);
  await expect(page.getByText('2 recipes are in My kitchen as private drafts.')).toBeVisible({
    timeout: 20000,
  });
  // The link on another site waits for its own import.
  await expect(
    page.getByRole('textbox', { name: 'Links to your recipes', exact: true }),
  ).toHaveValue('https://elsewhere.example/soup');
});

test('several links from Add a recipe come in together', async ({ page }) => {
  const { api } = await kitchen(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Import a recipe from a link', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Recipe link', exact: true });
  await field.fill('Try these: https://cook.example/lemon-pasta and https://cook.example/pie');
  await shot(page, 'add-a-recipe-form', async () => {
    if (await page.getByRole('dialog').count()) return;
    await page.getByRole('button', { name: 'Create recipe', exact: true }).first().click();
    await page.getByRole('button', { name: 'Import a recipe from a link', exact: true }).click();
    await field.fill('Try these: https://cook.example/lemon-pasta and https://cook.example/pie');
  });
  await page.getByRole('button', { name: 'Import 2 recipes', exact: true }).click();
  expect(api.sentTo('/imports')).toEqual([
    [
      'POST',
      { purpose: 'links', urls: ['https://cook.example/lemon-pasta', 'https://cook.example/pie'] },
    ],
  ]);
  await expect(page.getByText('2 recipes are in My kitchen as private drafts.')).toBeVisible({
    timeout: 20000,
  });
  await shot(page, 'add-a-recipe-links');
  // The bulk pages are a tap away.
  await page.getByRole('button', { name: 'Import more links', exact: true }).click();
  await page.getByRole('link', { name: 'From Mealime', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bring your recipes to Savorly' })).toBeVisible();
});

test('Download my data offers everything as files', async ({ page }) => {
  const { api } = await kitchen(page);
  api.on('POST', '/me/export-link', () => json({ url: '/v1/export/single-use', expiresAt: '' }));
  await page.route('**/v1/export/single-use', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="savorly-export-2026-10-17.zip"',
      },
      body: 'PK\u0005\u0006' + '\u0000'.repeat(18),
    }),
  );
  await page.goto('/?page=settings');
  const sheet = page.getByRole('dialog');
  const download = sheet.getByRole('button', { name: 'Download as files', exact: true });
  // Crossing between phone and desktop widths lays the page out again, which closes the sheet
  // a moment later. On a slow machine the sheet can still be on its way out when this looks, so
  // it opens the sheet until it is still there a second later, before shot waits on it.
  const open = () =>
    expect(async () => {
      if (!(await sheet.count()))
        await page
          .getByRole('button', { name: 'Download my data', exact: true })
          .click({ timeout: 5000 });
      await afterPageTimers(page, 1000);
      await expect(download).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
  await open();
  await shot(page, 'download-my-data', open);
  // The browser fetches the archive itself, from a single-use link, rather than the page.
  const fetched = page.waitForRequest(
    (r) => r.url().endsWith('/v1/export/single-use') && r.isNavigationRequest(),
  );
  await download.click();
  await fetched;
  await expect(page.getByText('Your data is downloading.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?page=settings$/);
  expect(api.sentTo('/me/export-link')).toEqual([['POST', { format: 'files' }]]);
});

test.describe('in Japanese', () => {
  test.use({ locale: 'ja-JP' });
  test('the page for Mealime’s members, and why a link didn’t come over, are translated', async ({
    page,
  }) => {
    await kitchen(page);
    await page.goto('/?page=mealime');
    await expect(page.getByRole('heading', { name: 'レシピをSavorlyへ' })).toBeVisible();
    await page.getByRole('textbox', { name: 'あなたのレシピ', exact: true }).fill(mealimeLink);
    await page.getByRole('button', { name: '1件を取り込む', exact: true }).click();
    await expect(page.getByText('どれも取り込めませんでした。', { exact: true })).toBeVisible();
    await expect(page.getByText('Mealime独自のレシピ', { exact: true })).toBeVisible();
    await shot(page, 'mealime-japanese');
  });
});
