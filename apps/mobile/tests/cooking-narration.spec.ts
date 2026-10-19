import { test, expect, Page } from '@playwright/test';
import {
  CookingNarration,
  NarrationPlayer,
  NarrationState,
  PlayerEvent,
} from '../src/lib/narration/controller';

function harness(enabled = true) {
  const states: NarrationState[] = [];
  const speech: string[] = [];
  const requests: {
    step: number;
    resolve: (path: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  const players: (NarrationPlayer & {
    plays: number;
    stopped: boolean;
    disposed: boolean;
    event: (event: PlayerEvent) => void;
  })[] = [];
  const controller = new CookingNarration({
    enabled,
    texts: ['Stir.', 'Serve.', 'Enjoy.'],
    prepare: (step) => new Promise((resolve, reject) => requests.push({ step, resolve, reject })),
    player: (_path, event) => {
      const player = {
        plays: 0,
        stopped: false,
        disposed: false,
        event,
        play: async () => {
          player.plays++;
          player.stopped = false;
          event('playing');
        },
        stop: () => {
          player.stopped = true;
        },
        dispose: () => {
          player.disposed = true;
        },
      };
      players.push(player);
      return player;
    },
    speak: (text) => {
      speech.push(text);
    },
    stopSpeech: () => {},
    state: (s) => states.push(s),
  });
  return { controller, requests, players, states, speech };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('no key uses device speech without a provider request', () => {
  const h = harness(false);
  h.controller.read();
  expect(h.speech).toEqual(['Stir.']);
  expect(h.requests).toHaveLength(0);
  h.controller.dispose();
});

test('late preparation cannot speak after Stop, Next, or Close', async () => {
  for (const action of ['stop', 'next', 'close']) {
    const h = harness();
    h.controller.read();
    if (action === 'stop') h.controller.stop();
    if (action === 'next') h.controller.select(1);
    if (action === 'close') h.controller.dispose();
    h.requests[0].resolve('/audio');
    await settle();
    expect(h.players.every((p) => p.plays === 0)).toBe(true);
    expect(h.speech).toEqual([]);
    h.controller.dispose();
  }
});

test('playback preloads only the next step and reuses prepared audio', async () => {
  const h = harness();
  h.controller.read();
  h.requests[0].resolve('/first');
  await settle();
  expect(h.requests.map((r) => r.step)).toEqual([0, 1]);
  h.players[0].event('playing');
  expect(h.requests).toHaveLength(2);
  h.requests[1].resolve('/second');
  await settle();
  h.controller.select(1);
  expect(h.players[0].stopped).toBe(true);
  h.controller.read();
  await settle();
  expect(h.players[1].plays).toBe(1);
  expect(h.requests.map((r) => r.step)).toEqual([0, 1, 2]);
  h.controller.stop();
  h.controller.read();
  await settle();
  expect(h.players[1].plays).toBe(2);
  expect(h.requests).toHaveLength(3);
  h.controller.dispose();
  expect(h.players.every((p) => p.disposed)).toBe(true);
});

test('network and playback failures fall back once without repeated generation', async () => {
  const h = harness();
  h.controller.read();
  h.requests[0].reject(new Error('503'));
  await settle();
  expect(h.speech).toEqual(['Stir.']);
  h.controller.read();
  await settle();
  expect(h.requests).toHaveLength(1);
  expect(h.speech).toEqual(['Stir.', 'Stir.']);
  h.controller.dispose();
  const audio = harness();
  audio.controller.read();
  audio.requests[0].resolve('/first');
  await settle();
  audio.players[0].event('error');
  audio.players[0].event('error');
  expect(audio.speech).toEqual(['Stir.']);
  audio.controller.dispose();
});

test('browser autoplay rejection preserves audio for the next tap', async () => {
  const h = harness();
  h.controller.read();
  h.controller.stop();
  h.requests[0].resolve('/first');
  await settle();
  const blocked = new Error('Gesture required');
  blocked.name = 'NotAllowedError';
  h.players[0].play = () => Promise.reject(blocked);
  h.controller.read();
  await settle();
  expect(h.states.at(-1)).toBe('blocked');
  expect(h.speech).toEqual([]);
  h.players[0].play = async () => {
    h.players[0].event('playing');
  };
  h.controller.read();
  await settle();
  expect(h.states.at(-1)).toBe('playing');
  expect(h.requests.filter((r) => r.step === 0)).toHaveLength(1);
  h.controller.dispose();
});

const user = {
  id: 'cook',
  name: 'Alex',
  handle: 'alex',
  avatar: '',
  bio: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
const recipe = {
  id: 'toast',
  title: 'Narration test toast',
  description: 'A simple toast.',
  cuisine: 'Italian',
  minutes: 5,
  servings: 1,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Bread', amount: 1, unit: 'slice', category: 'Bakery' }],
  steps: [
    { title: 'Toast', text: 'Toast the bread.', seconds: 0 },
    { title: 'Serve', text: 'Serve the toast.', seconds: 0 },
  ],
  tags: [],
  calories: 100,
  aiGenerated: false,
  published: true,
  author: user,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: new Date().toISOString(),
};
/** Seconds of valid silent PCM, which exercises the real browser audio player. */
function silence(seconds: number) {
  const wav = Buffer.alloc(44 + 8000 * seconds * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}
test('cooking UI plays cloud audio, preloads next, and stops on navigation', async ({ page }) => {
  const prepared: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const wav = silence(4);
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ cookingNarration: true });
    if (path === '/recipes') return json([recipe]);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path.endsWith('/narration')) {
      prepared.push(path);
      return json({ path: path + '/audio' });
    }
    if (path.endsWith('/audio'))
      return route.fulfill({
        contentType: 'audio/wav',
        body: wav,
        headers: {
          'Access-Control-Allow-Origin': new URL(page.url()).origin,
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    if (path === '/recipes/toast') return json(recipe);
    return json([]);
  });
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Let’s get cooking: Narration test toast', exact: true })
    .click();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  expect(prepared).toEqual([]);
  await page.getByRole('button', { name: 'Read this step aloud', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop reading', exact: true })).toBeVisible();
  await expect.poll(() => prepared.length).toBe(2);
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Read this step aloud', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Read this step aloud', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop reading', exact: true })).toBeVisible();
  expect(prepared).toHaveLength(2);
  await page.getByRole('button', { name: 'Finish cooking', exact: true }).click();
  await expect(page.getByText('Dinner is served.', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('device speech fallback reads the step in the app language', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR'] });
    const spoken: { text: string; lang: string }[] = [];
    Object.assign(window, { spoken });
    window.speechSynthesis.speak = (u) => void spoken.push({ text: u.text, lang: u.lang });
  });
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/v1', '');
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return json(user);
    // No narration capability, so the step goes to device speech.
    if (path === '/capabilities') return json({});
    if (path === '/recipes') return json([recipe]);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === '/recipes/toast') return json(recipe);
    return json([]);
  });
  await page.goto('/');
  await page
    .getByRole('link', { name: 'À vos fourneaux : Narration test toast', exact: true })
    .click();
  await page.getByRole('button', { name: 'Commencer à cuisiner', exact: true }).click();
  await page.getByRole('button', { name: 'Lire cette étape à voix haute', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { spoken: unknown[] }).spoken))
    .toEqual([{ text: 'Toast the bread.', lang: 'fr-FR' }]);
});

// Cooking offline: the cloud narration of a step heard before plays from the device's copy
// (narration/cache.ts), not device speech.
type Heard = { speech: string[]; audio: string[] };
/** Writes down device speech, and the source of every audio element that starts playing. */
function listen() {
  const heard: Heard = { speech: [], audio: [] };
  Object.assign(window, { heard });
  window.speechSynthesis.speak = (utterance) => void heard.speech.push(utterance.text);
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    this.addEventListener('playing', () => heard.audio.push(this.src), { once: true });
    return play.call(this);
  };
}
const heard = (page: Page) =>
  page.evaluate(() => structuredClone((window as unknown as { heard: Heard }).heard));
/** The recordings kept in the browser's Cache Storage, by the address they came from. */
const keptAudio = (page: Page) =>
  page.evaluate(async () =>
    (await (await caches.open('savorly-narration')).keys()).map((request) => request.url),
  );
const keptList = (page: Page) =>
  page.evaluate(() => localStorage.getItem('savorly.offline.narration'));
/** The API's audio for a step of the toast: the path ends with its key for the recording. */
const cloudAudio = (step: number) =>
  new RegExp(`/v1/recipes/toast/steps/${step}/narration/${String(step).repeat(64)}$`);

/**
 * The narration API, each step's recording under a 64-character key as the server's are. `down`
 * loses the connection.
 */
async function narratedKitchen(page: Page) {
  const api = { down: false, prepared: [] as string[], lost: [] as string[] };
  // Long enough to still be playing while the test looks.
  const wav = silence(10);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/v1', '');
    if (api.down) {
      api.lost.push(`${request.method()} ${path}`);
      return route.abort('internetdisconnected');
    }
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return json(user);
    if (path === '/capabilities') return json({ cookingNarration: true });
    if (path === '/recipes') return json([recipe]);
    if (path === '/creators') return json([user]);
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    const step = /^\/recipes\/toast\/steps\/(\d)\/narration$/.exec(path);
    if (step && request.method() === 'POST') {
      api.prepared.push(path);
      return json({ path: `${path}/${step[1].repeat(64)}`, model: 'elevenlabs/eleven-v4-turbo' });
    }
    if (/^\/recipes\/toast\/steps\/\d\/narration\/\d{64}$/.test(path))
      return route.fulfill({
        contentType: 'audio/wav',
        body: wav,
        headers: {
          'Access-Control-Allow-Origin': new URL(page.url()).origin,
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    if (path === '/recipes/toast') return json(recipe);
    return json([]);
  });
  return api;
}
const read = (page: Page) =>
  page.getByRole('button', { name: 'Read this step aloud', exact: true }).click();
/** Closes cooking mode, and waits for it to be gone before the next tap. */
async function closeCooking(page: Page) {
  const close = page.getByRole('button', { name: 'Close cooking mode', exact: true });
  await close.click();
  await expect(close).toHaveCount(0);
}
async function cookTheToast(page: Page) {
  await page
    .getByRole('link', { name: 'Let’s get cooking: Narration test toast', exact: true })
    .click();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
}

test('a step heard online plays from the device’s copy when the API can’t be reached', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(listen);
  const api = await narratedKitchen(page);
  await page.goto('/');
  await cookTheToast(page);
  await read(page);
  // Heard from the cloud, and kept on the device.
  await expect
    .poll(async () => (await heard(page)).audio)
    .toEqual([expect.stringMatching(cloudAudio(0))]);
  await expect.poll(() => keptAudio(page)).toEqual([expect.stringMatching(cloudAudio(0))]);
  expect(JSON.parse((await keptList(page)) ?? '[]')).toMatchObject([
    { owner: 'cook', recipe: 'toast', step: 0, text: 'Toast the bread.' },
  ]);
  await page.getByRole('button', { name: 'Stop reading', exact: true }).click();
  await closeCooking(page);
  // What the app loaded is kept a second later, for a launch without a connection.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('savorly.offline.snapshot') ?? ''))
    .toContain('Narration test toast');

  // The connection goes. Cooking the toast again, step one is read in the same voice, from the
  // device, once the narration request fails.
  api.down = true;
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await read(page);
  await expect.poll(async () => (await heard(page)).audio.at(-1)).toMatch(/^blob:/);
  await expect(page.getByRole('button', { name: 'Stop reading', exact: true })).toBeVisible();
  expect(api.lost).toContain('POST /recipes/toast/steps/0/narration');
  // Step two was never heard, so device speech reads it.
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await read(page);
  await expect.poll(async () => (await heard(page)).speech).toEqual(['Serve the toast.']);
  expect((await heard(page)).audio).toHaveLength(2);

  // Launched without a connection, the recipe page (/recipes/toast) opens from the device and so
  // does the narration, without waiting on the network.
  await page.reload();
  await expect(
    page.getByText('You’re offline. Showing what’s saved on this device.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  const lost = api.lost.length;
  await read(page);
  await expect
    .poll(async () => (await heard(page)).audio)
    .toEqual([expect.stringMatching(/^blob:/)]);
  expect((await heard(page)).speech).toEqual([]);
  expect(api.lost.slice(lost).filter((request) => request.includes('/narration'))).toEqual([]);
  expect(api.prepared).toEqual([
    '/recipes/toast/steps/0/narration',
    '/recipes/toast/steps/1/narration',
  ]);
  expect(errors).toEqual([]);
});

test('signing out takes the narration kept on the device away', async ({ page }) => {
  await page.addInitScript(listen);
  await narratedKitchen(page);
  await page.goto('/');
  await cookTheToast(page);
  await read(page);
  await expect.poll(() => keptAudio(page)).toHaveLength(1);
  await expect.poll(() => keptList(page)).toContain('Toast the bread.');
  await page.getByRole('button', { name: 'Stop reading', exact: true }).click();
  await closeCooking(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('You’ve signed out. See you at the table.', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => keptAudio(page)).toEqual([]);
  expect(await keptList(page)).toBeNull();
});
