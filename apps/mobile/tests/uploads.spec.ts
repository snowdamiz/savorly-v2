import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
// A real 1×1 PNG: the editor turns it into a JPEG before it goes up.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dWQAAAAASUVORK5CYII=',
  'base64',
);
const clip = {
  name: 'clip.mp4',
  mimeType: 'video/mp4',
  buffer: readFileSync('tests/fixtures/sample.mp4'),
};
const cacheControl = 'public,max-age=31536000,immutable';
type Call = { method: string; path: string; body: Record<string, unknown> | null };

/** The API, signing direct uploads unless `presign` answers with an error status instead. */
async function mockKitchen(page: Page, { presign }: { presign?: number } = {}) {
  const calls: Call[] = [];
  const saved: Record<string, unknown>[] = [];
  let uploads = 0;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/v1', '');
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    // Multipart uploads aren't JSON.
    const body = path === '/media' || !request.postData() ? null : request.postDataJSON();
    calls.push({ method, path, body });
    if (path === '/session') return json({ user });
    if (path === '/me' && method === 'PATCH') return json({ ...user, ...body });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ textAI: true });
    if (path === '/recipes' && method === 'POST') {
      saved.push(body!);
      return json({ ...body, id: 'saved-1', author: user, rating: 0, reviewCount: 0 }, 201);
    }
    if (path === '/recipes') return json([]);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === '/media') return json({ url: 'https://media.test/cook/classic.jpg' }, 201);
    if (path === '/media/uploads') {
      if (presign) return json({ error: 'Not found.' }, presign);
      const { kind, contentType } = body as { kind: string; contentType: string };
      const key = `uploads/cook/${++uploads}.${kind === 'image' ? 'jpg' : 'mp4'}`;
      return json({
        uploadUrl: `https://storage.test/savorly-media/${key}?X-Amz-Signature=test`,
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl },
        url: `https://media.test/${key}`,
        key,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    }
    if (path === '/media/uploads/complete')
      return json({ url: `https://media.test/${(body as { key: string }).key}` });
    return json([]);
  });
  await page.route('https://media.test/**', (route) =>
    route.fulfill({ path: 'tests/fixtures/sample.png', contentType: 'image/png' }),
  );
  return { calls, saved };
}
/** Storage, holding each PUT until the test lets it go; `fail` drops the connection instead. */
async function mockStorage(page: Page, { fail = false } = {}) {
  const puts: { url: string; headers: Record<string, string>; size: number }[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('https://storage.test/**', async (route) => {
    const request = route.request();
    puts.push({
      url: request.url(),
      headers: request.headers(),
      size: request.postDataBuffer()?.length ?? 0,
    });
    if (fail) return route.abort('failed');
    await held;
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
  });
  return { puts, release };
}
// Requests the test intercepts never reach the network, so the browser reports no upload progress
// for them; this plays the part, reporting 40% of the body as sent.
const reportProgress = (page: Page) =>
  page.addInitScript(() => {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const targets = new WeakMap<XMLHttpRequest, string>();
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      targets.set(this, String(args[1]));
      return (open as (...a: unknown[]) => void).apply(this, args);
    };
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body) {
      const total = body instanceof Blob ? body.size : 0;
      if (targets.get(this)?.startsWith('https://storage.test/'))
        this.upload.dispatchEvent(
          new ProgressEvent('progress', { lengthComputable: true, loaded: total * 0.4, total }),
        );
      return send.call(this, body);
    };
  });
const choose = async (
  page: Page,
  button: string,
  file = { name: 'dish.png', mimeType: 'image/png', buffer: png },
) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button, exact: true }).click();
  await (await chooser).setFiles(file);
};

test('a photo goes straight to storage, showing its progress, and its address is saved', async ({
  page,
}) => {
  await reportProgress(page);
  const { calls, saved } = await mockKitchen(page);
  const storage = await mockStorage(page);
  await page.goto('/?page=create');
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Lemon toast');
  await choose(page, 'Upload a photo');
  const progress = page.getByRole('progressbar', { name: 'Upload progress' });
  await expect(progress).toContainText('Uploading… 40%');
  await expect(progress).toHaveAttribute('aria-valuenow', '40');
  storage.release();
  const url = page.getByRole('textbox', { name: 'Or use an image URL', exact: true });
  await expect(url).toHaveValue('https://media.test/uploads/cook/1.jpg');
  await expect(progress).toHaveCount(0);
  // Signed for this exact file: its type, its length and the cache policy.
  const signed = calls.find((call) => call.path === '/media/uploads')!.body!;
  expect(signed).toMatchObject({ kind: 'image', contentType: 'image/jpeg' });
  expect(signed.size).toBe(storage.puts[0].size);
  expect(storage.puts[0].headers['content-type']).toBe('image/jpeg');
  expect(storage.puts[0].headers['cache-control']).toBe(cacheControl);
  expect(calls.find((call) => call.path === '/media/uploads/complete')?.body).toEqual({
    key: 'uploads/cook/1.jpg',
  });
  expect(calls.some((call) => call.path === '/media')).toBe(false);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ image: 'https://media.test/uploads/cook/1.jpg' });
});

test('a step clip shows its upload’s progress, can be cancelled, and says why it failed', async ({
  page,
}) => {
  await reportProgress(page);
  const { calls, saved } = await mockKitchen(page);
  const storage = await mockStorage(page);
  await page.goto('/?page=create');
  await page.getByRole('textbox', { name: 'Recipe title', exact: true }).fill('Lemon toast');
  await choose(page, 'Add a clip to step 1', clip);
  const progress = page.getByRole('progressbar', { name: 'Upload progress' });
  await expect(progress).toContainText('Uploading… 40%');
  expect(calls.find((call) => call.path === '/media/uploads')?.body).toEqual({
    kind: 'video',
    contentType: 'video/mp4',
    size: 2319,
  });
  await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await expect(progress).toHaveCount(0);
  storage.release();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Add a clip to step 1', exact: true }),
  ).toBeVisible();
  expect(calls.some((call) => call.path === '/media/uploads/complete')).toBe(false);
  // A refusal shows where the recipe video's does.
  await page.route('**/v1/media/uploads', (route) =>
    route.fulfill({ status: 400, json: { error: 'Choose a file smaller than 50 MB.' } }),
  );
  await choose(page, 'Add a clip to step 1', clip);
  await expect(page.getByRole('alert')).toHaveText('Choose a file smaller than 50 MB.');
  await page.unroute('**/v1/media/uploads');
  // The next one goes all the way, and the step saves it.
  await choose(page, 'Add a clip to step 1', clip);
  await expect(
    page.getByRole('button', { name: 'Play the clip of step 1', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect((saved[0].steps as { video?: string }[])[0].video).toBe(
    'https://media.test/uploads/cook/2.mp4',
  );
});

test('a server without direct uploads takes the photo the classic way', async ({ page }) => {
  const { calls } = await mockKitchen(page, { presign: 404 });
  const storage = await mockStorage(page);
  await page.goto('/?page=create');
  await choose(page, 'Upload a photo');
  await expect(page.getByRole('textbox', { name: 'Or use an image URL', exact: true })).toHaveValue(
    'https://media.test/cook/classic.jpg',
  );
  expect(calls.map((call) => call.path).filter((path) => path.startsWith('/media'))).toEqual([
    '/media/uploads',
    '/media',
  ]);
  expect(storage.puts).toHaveLength(0);
});

test('storage the browser can’t reach (a bucket without CORS) falls back to the API', async ({
  page,
}) => {
  const { calls } = await mockKitchen(page);
  const storage = await mockStorage(page, { fail: true });
  await page.goto('/?page=create');
  await choose(page, 'Upload a photo');
  await expect(page.getByRole('textbox', { name: 'Or use an image URL', exact: true })).toHaveValue(
    'https://media.test/cook/classic.jpg',
  );
  expect(storage.puts).toHaveLength(1);
  expect(calls.map((call) => call.path).filter((path) => path.startsWith('/media'))).toEqual([
    '/media/uploads',
    '/media',
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a new profile photo shows how far its upload has got', async ({ page }) => {
  await reportProgress(page);
  const { calls } = await mockKitchen(page);
  const storage = await mockStorage(page);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Add a photo' }).first().click();
  await choose(page, 'Choose a photo');
  await page.getByRole('button', { name: 'Finish crop', exact: true }).click();
  const progress = page.getByRole('progressbar', { name: 'Upload progress' });
  await expect(progress).toHaveText('40%');
  storage.release();
  await expect(progress).toHaveCount(0);
  await page.getByRole('button', { name: 'Use this photo', exact: true }).click();
  await expect
    .poll(() => calls.find((call) => call.path === '/me' && call.method === 'PATCH')?.body?.avatar)
    .toBe('https://media.test/uploads/cook/1.jpg');
});
