import { test, expect, Page } from '@playwright/test';
import type { AppAction, Recipe, StudioEvent, StudioProject } from '../src/lib/types';

const user = {
  id: 'studio-cook',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
};
const recipe: Recipe = {
  id: 'voice-toast',
  title: 'Lemon toast',
  description: 'Bright and golden lemon toast for a quick lunch.',
  cuisine: 'Italian',
  minutes: 10,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Bread', amount: 2, unit: 'slices', category: 'Bakery' }],
  steps: [{ title: 'Toast', text: 'Toast the bread until golden.', seconds: 0 }],
  tags: [],
  calories: 120,
  aiGenerated: true,
  published: false,
  author: user,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: new Date().toISOString(),
};

test('a late search response cannot replace the current results', async ({ page }) => {
  await mockStudio(page);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/v1/recipes?**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'lemon') await delayed;
    await route.fulfill({
      json:
        query === 'lemon' ? [{ ...recipe, id: 'stale', title: 'Stale lemon result' }] : [recipe],
    });
  });
  await page.goto('/');
  const search = page.getByRole('textbox', { name: 'Search recipes', exact: true });
  const first = page.waitForRequest((r) => new URL(r.url()).searchParams.get('q') === 'lemon');
  await search.fill('lemon');
  await first;
  await search.fill('toast');
  await expect(page.getByRole('button', { name: 'View Lemon toast', exact: true })).toBeVisible();
  const late = page.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === 'lemon');
  release();
  await late;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(
    page.getByRole('button', { name: 'View Stale lemon result', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View Lemon toast', exact: true })).toBeVisible();
});

test('an automatic ingredient swap submits once and can be followed by another request', async ({
  page,
}) => {
  await mockStudio(page);
  const submissions: string[] = [];
  const job = {
    id: 'swap',
    kind: 'substitute',
    status: 'completed',
    result: { text: 'Use a tortilla.' },
    error: '',
  };
  await page.route('**/v1/ai/jobs', async (route) => {
    if (route.request().method() === 'POST') {
      submissions.push(route.request().headers()['idempotency-key']);
      return route.fulfill({ json: { ...job, status: 'queued', result: {} } });
    }
    return route.fulfill({ json: [job] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Let’s get cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Swap Bread', exact: true }).click();
  await expect(page.getByText('Use a tortilla.', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toBeTruthy();
  await page.getByRole('button', { name: 'Ask something else', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Your request', exact: true })
    .fill('Another bread substitute');
  await page.getByRole('button', { name: 'Ask the sous-chef', exact: true }).last().click();
  await expect(page.getByText('Use a tortilla.', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).not.toBe(submissions[0]);
});

// Recipes start from the Add a recipe sheet (the + tab on phones, Create recipe on desktop).
test('an automatic ingredient swap asks guests to sign in before submitting', async ({ page }) => {
  await mockStudio(page);
  await page.route('**/v1/me', (route) =>
    route.fulfill({ status: 401, json: { error: 'Sign in' } }),
  );
  const submissions: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/ai/jobs') && request.method() === 'POST')
      submissions.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Let’s get cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Swap Bread', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toBeVisible();
  expect(submissions).toEqual([]);
});

async function startRecipe(page: Page, option: string) {
  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  await page.getByRole('button', { name: option, exact: true }).click();
}
async function mockStudio(
  page: Page,
  voice = true,
  cards = false,
  respond?: (text: string) => { content: string; actions?: AppAction[] },
) {
  let project: StudioProject | null = null;
  const events: StudioEvent[] = [];
  const messages: string[] = [];
  const sessionCloses: string[] = [];
  let uploads = 0;
  let starts = 0;
  let kitchenLoads = 0;
  const contexts: Record<string, unknown>[] = [];
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/v1', '');
    const method = route.request().method();
    const fulfill = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return fulfill(user);
    if (path === '/library')
      return fulfill({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') {
      kitchenLoads++;
      return fulfill({ plans: [], groceries: [], pantry: [] });
    }
    if (path === '/capabilities')
      return fulfill({
        textAI: true,
        imageAI: true,
        videoAI: true,
        recipeChat: true,
        recipePhotos: true,
        voiceAI: voice,
        voiceModel: 'gpt-live-1',
        dailyLimit: 10,
      });
    if (path === '/recipes') return fulfill([recipe]);
    if (path === '/creators') return fulfill([user]);
    if (path.endsWith('/reviews')) return fulfill([]);
    if (path.startsWith('/recipes/')) return fulfill(recipe);
    if (path === '/recipe-studio' && method === 'GET') return fulfill(project ? [project] : []);
    if (path === '/recipe-studio' && method === 'POST') {
      project = {
        id: 'test-project',
        recipeId: null,
        recipe: null,
        revision: 0,
        status: 'listening',
        busy: false,
        reply: '',
        error: '',
        assets: [],
        updatedAt: new Date().toISOString(),
      };
      return fulfill(project);
    }
    if (path.endsWith('/events'))
      return fulfill(events.filter((e) => e.seq > Number(url.searchParams.get('after') || 0)));
    if (path.endsWith('/images')) {
      uploads++;
      return fulfill({ id: 'private-image' }, 201);
    }
    if (path.endsWith('/context') && method === 'PUT') {
      contexts.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/messages') && respond) {
      const data = route.request().postDataJSON();
      messages.push(data.text);
      events.push({ seq: events.length + 1, role: 'user', content: data.text, imageCount: 0 });
      events.push({
        seq: events.length + 1,
        role: 'assistant',
        imageCount: 0,
        ...respond(data.text),
      });
      return fulfill({ accepted: true }, 202);
    }
    if (path.endsWith('/messages')) {
      const data = route.request().postDataJSON();
      messages.push(data.text);
      events.push({
        seq: events.length + 1,
        role: 'user',
        content: data.text,
        imageCount: data.images?.length || 0,
      });
      if (messages.length === 1) {
        project!.reply = 'How many slices of bread do you use?';
      } else {
        project!.recipe = { ...recipe };
        project!.recipeId = recipe.id;
        project!.revision = 1;
        project!.status = 'generating';
        project!.reply = 'Your private recipe is saved. The photo and video are creating.';
        project!.assets = [
          { kind: 'image', status: 'running', error: '' },
          { kind: 'video', status: 'processing', error: '' },
        ];
      }
      events.push({
        seq: events.length + 1,
        role: 'assistant',
        content: project!.reply,
        imageCount: 0,
        recipes: cards
          ? [{ id: recipe.id, title: recipe.title, image: '', minutes: 10, cuisine: 'Italian' }]
          : [],
      });
      return fulfill({ accepted: true }, 202);
    }
    if (path.endsWith('/voice') && method === 'POST') {
      starts++;
      return fulfill({ id: 'test-session-' + starts, sdp: 'test-answer', maxSeconds: 1800 }, 201);
    }
    if (path.startsWith('/recipe-studio/voice/') && method === 'DELETE') {
      sessionCloses.push(path);
      return route.fulfill({ status: 204 });
    }
    if (path.startsWith('/recipe-studio/')) return fulfill(project);
    return fulfill([]);
  });
  return {
    messages,
    sessionCloses,
    uploads: () => uploads,
    starts: () => starts,
    kitchenLoads: () => kitchenLoads,
    contexts,
  };
}

// A synthetic microphone and WebRTC peer that acknowledges the session like GPT-Live.
async function fakeVoice(page: Page) {
  await page.addInitScript(() => {
    let stopped = 0;
    const track = {
      enabled: true,
      stop: () => {
        stopped++;
      },
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }),
      },
    });
    class Channel extends EventTarget {
      readyState = 'open';
      send(data: string) {
        if (JSON.parse(data).type === 'session.close')
          this.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify({ type: 'session.closed' }) }),
          );
      }
      close() {}
    }
    class Peer extends EventTarget {
      iceGatheringState = 'complete';
      connectionState = 'connected';
      localDescription = { sdp: 'v=0\r\n' };
      channel = new Channel();
      constructor() {
        super();
        Object.defineProperty(window, '__voiceChannel', {
          value: this.channel,
          configurable: true,
        });
      }
      addTrack() {}
      createDataChannel() {
        return this.channel;
      }
      async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\n' };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        setTimeout(
          () =>
            this.channel.dispatchEvent(
              new MessageEvent('message', { data: JSON.stringify({ type: 'session.started' }) }),
            ),
          20,
        );
      }
      close() {}
    }
    Object.defineProperty(window, 'RTCPeerConnection', { value: Peer });
    Object.defineProperty(window, '__voiceStopped', { get: () => stopped });
  });
}

test('chat clarifies, saves a complete recipe with both media jobs, and resumes', async ({
  page,
}, testInfo) => {
  const state = await mockStudio(page);
  await page.goto('/');
  await startRecipe(page, 'Chat to create a recipe');
  const composer = page.getByRole('textbox', { name: 'Message your sous-chef' });
  await composer.fill('I make lemon toast. Make it into a recipe.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByText('How many slices of bread do you use?', { exact: true }),
  ).toBeVisible();
  await composer.fill('Two slices, for two people.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Private draft saved', { exact: true })).toBeVisible();
  await expect(page.getByText('AI cover photo', { exact: true })).toBeVisible();
  await expect(page.getByText('AI recipe video', { exact: true })).toBeVisible();
  expect(state.messages).toHaveLength(2);
  await page.screenshot({ path: testInfo.outputPath('recipe-studio-chat.png') });
  await page.getByRole('button', { name: 'Close the sous-chef', exact: true }).click();
  await startRecipe(page, 'Chat to create a recipe');
  await expect(page.getByText('Two slices, for two people.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  // Allow the shared React Native modal spring to finish after changing viewport.
  await page.waitForTimeout(450);
  await page.screenshot({
    path: testInfo.outputPath('recipe-studio-mobile.png'),
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('photo upload is normalized and sent for clarification automatically', async ({ page }) => {
  const state = await mockStudio(page);
  await page.goto('/');
  await startRecipe(page, 'Scan a recipe');
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add a photo', exact: true }).click();
  await (await chooser).setFiles('tests/fixtures/sample.png');
  await expect(
    page.getByText('How many slices of bread do you use?', { exact: true }),
  ).toBeVisible();
  expect(state.uploads()).toBe(1);
  expect(state.messages[0]).toContain('photo');
  await expect(page.getByText('You · 1 recipe photo', { exact: true })).toBeVisible();
});

test('voice starts on one tap, supports mute, releases microphone, and retains chat', async ({
  page,
}) => {
  const state = await mockStudio(page);
  await fakeVoice(page);
  await page.goto('/');
  await startRecipe(page, 'Speak a recipe');
  await expect(page.getByText('I’m listening. Take your time.', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __voiceChannel: EventTarget }).__voiceChannel.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'session.closed', reason: 'expired' }),
      }),
    );
  });
  await expect.poll(() => state.starts()).toBe(2);
  await expect(page.getByText('I’m listening. Take your time.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.getByText('Microphone paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume microphone', exact: true }).click();
  await page.getByRole('button', { name: 'End voice', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message your sous-chef' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start live conversation' })).toBeVisible();
  expect(state.sessionCloses).toHaveLength(2);
  expect(
    await page.evaluate(() => (window as unknown as { __voiceStopped: number }).__voiceStopped),
  ).toBeGreaterThan(0);
});

test('unavailable voice falls back honestly to text without a session charge', async ({ page }) => {
  const state = await mockStudio(page, false);
  await page.goto('/');
  await startRecipe(page, 'Speak a recipe');
  await expect(page.getByText(/Voice isn’t connected yet/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message your sous-chef' })).toBeVisible();
  expect(state.sessionCloses).toHaveLength(0);
});

test('camera permission failure leaves upload and chat usable', async ({ page }) => {
  await mockStudio(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        },
        enumerateDevices: async () => [],
      },
    });
  });
  await page.goto('/');
  await startRecipe(page, 'Scan a recipe');
  await expect(page.getByText('Take a photo', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add a photo', exact: true })).toBeVisible();
});

test('in-app camera captures, retakes, and submits an actual image', async ({ page, context }) => {
  await context.grantPermissions(['camera']);
  const state = await mockStudio(page);
  await page.goto('/');
  await startRecipe(page, 'Scan a recipe');
  const allow = page.getByRole('button', { name: 'Allow camera', exact: true });
  if (await allow.isVisible()) await allow.click();
  const capture = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(capture).toBeEnabled();
  await capture.click();
  await page.getByRole('button', { name: 'Retake recipe photo', exact: true }).click();
  await expect(capture).toBeEnabled();
  await capture.click();
  await page.getByRole('button', { name: 'Use this photo', exact: true }).click();
  await expect(
    page.getByText('How many slices of bread do you use?', { exact: true }),
  ).toBeVisible();
  expect(state.uploads()).toBe(1);
});

test('the sous-chef is one tap away, shows recipe cards, and refreshes the kitchen', async ({
  page,
}) => {
  const state = await mockStudio(page, true, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask your sous-chef' }).click();
  await expect(page.getByText('How can I help in the kitchen?', { exact: true })).toBeVisible();
  const loads = state.kitchenLoads();
  await page.getByRole('button', { name: 'Find me a quick dinner', exact: true }).click();
  expect(state.messages).toEqual(['Find me a quick dinner']);
  await expect(page.getByRole('button', { name: 'Open Lemon toast' })).toBeVisible();
  await expect.poll(() => state.kitchenLoads()).toBeGreaterThan(loads);
  await page.getByRole('button', { name: 'Open Lemon toast' }).click();
  await expect(page.getByText('Toast the bread until golden.').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=planner');
  await expect(page.getByRole('button', { name: 'Ask your sous-chef' })).toBeInViewport();
});

test('the sous-chef knows the open recipe and cooking step, and acts on screen', async ({
  page,
}) => {
  const state = await mockStudio(page, true, false, (text) =>
    text.includes('Start cooking')
      ? {
          content: 'Starting Lemon toast. Step one: toast the bread.',
          actions: [{ type: 'start_cooking', recipeId: recipe.id, step: 1 }],
        }
      : text.includes('planner')
        ? { content: 'Here is your planner.', actions: [{ type: 'go_to', page: 'planner' }] }
        : { content: 'Sure.' },
  );
  await page.goto(`/?recipe=${recipe.id}`);
  await page.getByRole('button', { name: 'Ask the sous-chef' }).first().click();
  await expect(page.getByText('Viewing Lemon toast', { exact: true })).toBeVisible();
  await expect
    .poll(() => state.contexts.at(-1))
    .toMatchObject({ recipeId: recipe.id, cookingStep: 0, timeZone: expect.stringMatching(/./) });
  const composer = page.getByRole('textbox', { name: 'Message your sous-chef' });
  await composer.fill('Start cooking it with me');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Close cooking mode' })).toBeVisible();
  // On a desktop the sous-chef stays beside cooking mode and follows the step.
  await expect(page.getByText('Cooking Lemon toast · step 1', { exact: true })).toBeVisible();
  await expect.poll(() => state.contexts.at(-1)).toMatchObject({ cookingStep: 1 });
  await expect(page.getByRole('button', { name: 'I don’t have the right pan' })).toBeVisible();
  await composer.fill('Take me to my planner');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('A little plan for the week, and a list to match.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close cooking mode' })).toHaveCount(0);
});

test('live voice keeps going from a minimized pill while the user browses', async ({ page }) => {
  await fakeVoice(page);
  const state = await mockStudio(page);
  await page.goto('/');
  await startRecipe(page, 'Speak a recipe');
  await expect(page.getByText('I’m listening. Take your time.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep talking while you browse' }).click();
  await expect(page.getByText('Listening…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask your sous-chef' })).toHaveCount(0);
  expect(state.sessionCloses).toHaveLength(0);
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(page.getByText('I’m listening. Take your time.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep talking while you browse' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'End voice' }).click();
  await expect.poll(() => state.sessionCloses.length).toBe(1);
  // Once the voice ends, the pill folds back into the launcher, which reopens the same chat.
  await expect(page.getByRole('button', { name: 'Back to conversation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask your sous-chef' }).click();
  await expect(page.getByRole('button', { name: 'Start live conversation' })).toBeVisible();
  expect(state.starts()).toBe(1);
});

test('the sous-chef floats beside the page, which stays usable and in context', async ({
  page,
}) => {
  const state = await mockStudio(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask your sous-chef' }).click();
  const panel = page.getByRole('dialog', { name: 'Sous-chef' });
  const composer = page.getByRole('textbox', { name: 'Message your sous-chef' });
  await expect(composer).toBeFocused();
  await composer.fill('A draft question');
  // The page beside it still works, and the conversation follows it there.
  await page.getByRole('button', { name: 'Meal planner', exact: true }).click();
  await expect(page.getByText('A little plan for the week, and a list to match.')).toBeVisible();
  await expect(panel.getByText('Viewing Meal planner', { exact: true })).toBeVisible();
  await expect.poll(() => state.contexts.at(-1)).toMatchObject({ screen: 'planner' });
  // Minimizing folds it into the launcher and keeps the draft; Escape inside it does the same.
  await page.getByRole('button', { name: 'Minimize the sous-chef', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask your sous-chef' }).click();
  await expect(composer).toHaveValue('A draft question');
  await composer.press('Escape');
  await expect(panel).toHaveCount(0);
  // On a phone it sits above the tab bar, which stays usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Ask your sous-chef' }).click();
  await expect(composer).toBeVisible();
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  await expect(panel.getByText('Viewing My cookbooks', { exact: true })).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
