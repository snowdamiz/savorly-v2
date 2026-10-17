import { expect, test, type Page } from '@playwright/test';
import type { Recipe } from '../src/lib/types';
import { afterPageTimers } from './waits';

const cook = { id: 'me', name: 'Alex', handle: 'alex', bio: '', avatar: '' };
const user = {
  ...cook,
  email: 'alex@example.test',
  preferences: { diets: [], allergies: [] },
  identities: [],
  hasPassword: true,
  plan: 'free',
  onboarded: true,
};
const pasta: Recipe = {
  id: 'pasta',
  title: 'Weeknight spaghetti',
  description: 'Spaghetti with a quick tomato sauce.',
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [
    { name: 'Spaghetti', amount: 200, unit: 'g', category: 'Pantry' },
    { name: 'Tomato sauce', amount: 300, unit: 'ml', category: 'Pantry' },
  ],
  steps: [
    { title: 'Boil', text: 'Boil the spaghetti in salted water.', seconds: 540 },
    { title: 'Sauce', text: 'Warm the tomato sauce gently.', seconds: 60 },
    { title: 'Serve', text: 'Toss and serve.', seconds: 0 },
  ],
  tags: [],
  calories: 420,
  aiGenerated: false,
  published: true,
  author: { ...cook, id: 'robin', name: 'Robin', handle: 'robin' },
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
};

type Speech = {
  sessions: { lang: string; continuous: boolean; aborted: boolean }[];
  active: boolean;
  spoken: string[];
  say: (text: string) => void;
};

// The browser's speech, scripted: webkitSpeechRecognition hands the test's words to the session
// that is listening, and speechSynthesis writes down what it is asked to say and finishes at once.
function fakeSpeech() {
  type Session = {
    lang: string;
    continuous: boolean;
    aborted: boolean;
    onresult: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onend: (() => void) | null;
  };
  let active: Session | null = null;
  const sessions: Session[] = [];
  const spoken: string[] = [];
  class Recognition {
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    aborted = false;
    onresult: Session['onresult'] = null;
    onerror: Session['onerror'] = null;
    onend: Session['onend'] = null;
    start() {
      sessions.push(this);
      active = this;
    }
    abort() {
      this.aborted = true;
      if (active === this) active = null;
      setTimeout(() => this.onend?.(), 0);
    }
    stop() {
      this.abort();
    }
  }
  // Newer Chromium has the unprefixed name too, which the app prefers.
  Object.assign(window, { webkitSpeechRecognition: Recognition, SpeechRecognition: Recognition });
  window.speechSynthesis.speak = (utterance) => {
    spoken.push(utterance.text);
    setTimeout(() => utterance.onend?.(new Event('end') as SpeechSynthesisEvent), 20);
  };
  window.speechSynthesis.cancel = () => {};
  const speech = {
    sessions,
    spoken,
    get active() {
      return !!active;
    },
    say(text: string) {
      const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: true });
      active?.onresult?.({ resultIndex: 0, results: [result] });
    },
  };
  Object.assign(window, { speech });
}

const speech = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { speech: Speech }).speech;
    return { active: s.active, spoken: [...s.spoken], sessions: s.sessions.length };
  });
const say = async (page: Page, text: string) => {
  // Only a listening session hears anything: wait for one, as a cook would wait for the light.
  await expect.poll(async () => (await speech(page)).active).toBe(true);
  await page.evaluate((words) => (window as unknown as { speech: Speech }).speech.say(words), text);
};

async function mockKitchen(page: Page, asked: unknown[]) {
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/v1/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/me') return json(user);
    if (path === '/session') return json({ user });
    if (path === '/capabilities') return json({ textAI: true, cookingQuestions: true });
    if (path === '/recipes') return json([pasta]);
    if (path === '/feed')
      return json({ hero: pasta, trending: [], quick: [], following: [], newest: [] });
    if (path === '/library')
      return json({ savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] });
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === `/recipes/${pasta.id}`) return json(pasta);
    if (path === `/recipes/${pasta.id}/ask` && request.method() === 'POST') {
      asked.push(request.postDataJSON());
      return json({ answer: 'About nine minutes, until it is al dente.' });
    }
    return json([]);
  });
}

test('hands-free cooking moves on “next step” and answers “Chef, …” questions aloud', async ({
  page,
}) => {
  const asked: unknown[] = [];
  await page.addInitScript(fakeSpeech);
  await mockKitchen(page, asked);
  await page.goto(`/?recipe=${pasta.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  const cooking = page.locator('[aria-modal="true"]').last();
  await expect(cooking.getByText('Boil the spaghetti in salted water.')).toBeVisible();

  // The first time, the switch explains what to say before the microphone is used.
  const handsFree = page.getByRole('switch', { name: 'Hands-free' });
  await expect(handsFree).toHaveAttribute('aria-checked', 'false');
  await handsFree.click();
  await expect(page.getByText('Cook hands-free', { exact: true })).toBeVisible();
  await expect(page.getByText('“next step” · “previous step”', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(handsFree).toHaveAttribute('aria-checked', 'true');
  await expect(handsFree.getByText('Listening', { exact: true })).toBeVisible();
  expect(
    (await page.evaluate(() => (window as unknown as { speech: Speech }).speech.sessions[0])).lang,
  ).toBe('en-US');

  // A command moves the step, and the new step is read out.
  await say(page, 'Next step.');
  await expect(cooking.getByText('STEP 2 OF 3', { exact: true })).toBeVisible();
  await expect(cooking.getByText('Warm the tomato sauce gently.')).toBeVisible();
  await expect
    .poll(async () => (await speech(page)).spoken)
    .toContain('Warm the tomato sauce gently.');

  // Talk around the stove is ignored.
  await say(page, "I'll do the next step after this");
  await say(page, 'start the timer');
  await expect(cooking.getByRole('button', { name: 'Pause timer', exact: true })).toBeVisible();
  await expect(cooking.getByText('STEP 2 OF 3', { exact: true })).toBeVisible();
  await expect.poll(async () => (await speech(page)).spoken).toContain('Timer started.');

  // A question goes to the sous-chef with the step it's about, and its answer is shown and said.
  await say(page, 'Chef, how long do I boil it?');
  await expect(cooking.getByText('About nine minutes, until it is al dente.')).toBeVisible();
  expect(asked).toEqual([{ question: 'how long do I boil it?', step: 2, language: 'en' }]);
  await expect
    .poll(async () => (await speech(page)).spoken)
    .toContain('About nine minutes, until it is al dente.');

  // Turning it off stops listening at once, and nothing listens again.
  await handsFree.click();
  await expect(handsFree).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await speech(page)).active).toBe(false);
  const { sessions } = await speech(page);
  await afterPageTimers(page, 1000);
  expect((await speech(page)).sessions).toBe(sessions);
});

test('closing cooking mode stops listening', async ({ page }) => {
  await page.addInitScript(fakeSpeech);
  await page.addInitScript(() => localStorage.setItem('savorly.handsFree.explained', '1'));
  await mockKitchen(page, []);
  await page.goto(`/?recipe=${pasta.id}`);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  // Seen before, the explainer doesn't come back: the switch listens straight away.
  await page.getByRole('switch', { name: 'Hands-free' }).click();
  await expect.poll(async () => (await speech(page)).active).toBe(true);
  await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Hands-free' })).toHaveCount(0);
  await expect.poll(async () => (await speech(page)).active).toBe(false);
});
