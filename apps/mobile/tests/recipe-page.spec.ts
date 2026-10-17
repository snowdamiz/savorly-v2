import { expect, Locator, Page, test } from '@playwright/test';
import type {
  Creator,
  Library,
  Recipe,
  RecipeComment,
  RecipeCook,
  Review,
  UnitChoice,
} from '../src/lib/types';

const robin: Creator = { id: 'robin', name: 'Robin', handle: 'robin', bio: '', avatar: '' };
const sam = { id: 'sam', name: 'Sam', handle: 'sam', avatar: '' };
const alex = { id: 'me', name: 'Alex', handle: 'alex', avatar: '' };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const recipe = (fields: Partial<Recipe>): Recipe => ({
  id: 'tomato-soup',
  title: 'Tomato soup',
  description: 'A bright soup for cold evenings.',
  cuisine: 'Italian',
  minutes: 30,
  servings: 4,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [],
  steps: [{ title: 'Serve', text: 'Serve it hot.', seconds: 0 }],
  tags: [],
  calories: 200,
  aiGenerated: false,
  published: true,
  author: robin,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
  ...fields,
});
const soup = recipe({
  ingredients: [
    { name: 'Milk', amount: 2, unit: 'cups', category: 'Dairy' },
    { name: 'Butter', amount: 4, unit: 'oz', category: 'Dairy' },
    { name: 'Garlic', amount: 3, unit: 'cloves', category: 'Produce' },
    { name: 'Olive oil', amount: 2, unit: 'tbsp', category: 'Pantry' },
    { name: 'Flour', amount: 500, unit: 'g', category: 'Pantry' },
  ],
  steps: [
    {
      title: 'Soften',
      text: 'Soften the garlic in the oil.',
      seconds: 0,
      video: 'https://media.test/step.mp4',
    },
    {
      title: 'Simmer',
      text: 'Simmer with <b>milk</b> & butter.',
      seconds: 0,
      image: 'https://media.test/step.png',
    },
  ],
  sourceUrl: 'https://www.example.com/soup?ref=1',
  derivedFrom: {
    id: 'grandmas-soup',
    title: 'Grandma’s soup',
    author: { id: 'rosa', name: 'Rosa', handle: 'rosa' },
  },
  variationCount: 2,
  commentCount: 3,
  cookedCount: 2,
});
const others = [
  recipe({
    id: 'grandmas-soup',
    title: 'Grandma’s soup',
    author: { ...robin, id: 'rosa', name: 'Rosa' },
  }),
  recipe({
    id: 'spicy-soup',
    title: 'Spicy tomato soup',
    author: { ...robin, id: 'sam', name: 'Sam' },
  }),
  recipe({ id: 'creamy-soup', title: 'Creamy tomato soup' }),
];

type Options = {
  signedIn?: boolean;
  units?: UnitChoice;
  comments?: RecipeComment[];
  cooks?: RecipeCook[];
  reviews?: Review[];
  /** An older server's library, without cookedIds. */
  noCookedIds?: boolean;
};
// The API for one recipe page, kept in memory: what the page sends changes what it reads next.
async function kitchen(page: Page, options: Options = {}) {
  const user = {
    ...alex,
    bio: '',
    email: 'alex@example.test',
    preferences: { diets: [], allergies: [], units: options.units ?? '' },
    identities: [],
    hasPassword: true,
    plan: 'free',
    onboarded: true,
  };
  const comments = [...(options.comments ?? [])];
  const cooks = [...(options.cooks ?? [])];
  let reviews = [...(options.reviews ?? [])];
  const library: Library = {
    savedIds: [],
    saves: [],
    collections: [],
    followingIds: [],
    recipes: [],
    ...(options.noCookedIds ? {} : { cookedIds: [] as string[] }),
  };
  const sent: { method: string; path: string; body: unknown }[] = [];
  let made = 0;
  await page.route('https://media.test/**', (route) =>
    route.request().url().endsWith('.mp4')
      ? route.fulfill({ path: 'tests/fixtures/sample.mp4', contentType: 'video/mp4' })
      : route.fulfill({ path: 'tests/fixtures/sample.png', contentType: 'image/png' }),
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/v1/, '');
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const done = () => route.fulfill({ status: 204, body: '' });
    if (method !== 'GET') {
      let body: unknown = null;
      try {
        body = request.postData() ? request.postDataJSON() : null;
      } catch {
        body = 'form';
      }
      sent.push({ method, path, body });
    }
    if (path === '/me')
      return options.signedIn === false ? json({ error: 'Sign in to continue.' }, 401) : json(user);
    if (path === '/session') return json({ user: options.signedIn === false ? null : user });
    if (path === '/me/preferences' && method === 'PATCH') {
      Object.assign(user.preferences, request.postDataJSON());
      return json(user);
    }
    if (path === '/capabilities') return json({});
    if (path === '/recipes') return json([soup]);
    if (path === '/feed')
      return json({ hero: soup, trending: [], quick: [], following: [], newest: [] });
    if (path === '/creators') return json([robin]);
    if (path === '/library') return json(library);
    if (path === '/kitchen') return json({ plans: [], groceries: [], pantry: [] });
    if (path === '/media/uploads') return json({ error: 'Not found.' }, 404);
    if (path === '/media' && method === 'POST')
      return json({ url: 'https://media.test/cooked.png' });
    const comment = /^\/comments\/(.+)$/.exec(path);
    if (comment && method === 'DELETE') {
      for (let i = comments.length - 1; i >= 0; i--)
        if (comments[i].id === comment[1] || comments[i].parentId === comment[1])
          comments.splice(i, 1);
      return done();
    }
    const match = /^\/recipes\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return json([]);
    const [, id, rest = ''] = match;
    const mine = id === soup.id;
    if (!rest) return json([soup, ...others].find((r) => r.id === id) ?? soup);
    if (rest === '/reviews') return json(mine ? reviews : []);
    if (rest === '/review' && method === 'DELETE') {
      reviews = reviews.filter((r) => r.author.id !== alex.id);
      return done();
    }
    if (rest === '/comments' && method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      return json(mine ? comments.slice(offset, offset + limit) : []);
    }
    if (rest === '/comments' && method === 'POST') {
      const body = request.postDataJSON();
      const created: RecipeComment = {
        id: `new-${++made}`,
        body: body.body,
        parentId: body.parentId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        author: alex,
        canDelete: true,
      };
      comments.push(created);
      return json(created, 201);
    }
    if (rest.startsWith('/cooks')) return json(mine ? cooks : []);
    if (rest === '/cooked' && method === 'POST') {
      const body = request.postDataJSON();
      const index = cooks.findIndex((c) => c.author.id === alex.id);
      if (index >= 0) cooks.splice(index, 1);
      cooks.unshift({
        id: 'my-cook',
        photo: body.photo ?? '',
        note: body.note ?? '',
        createdAt: ago(0),
        author: alex,
      });
      library.cookedIds = [...new Set([...(library.cookedIds ?? []), id])];
      return json({ cooked: true, cookedCount: cooks.length });
    }
    if (rest === '/cooked' && method === 'DELETE') {
      const index = cooks.findIndex((c) => c.author.id === alex.id);
      if (index >= 0) cooks.splice(index, 1);
      library.cookedIds = (library.cookedIds ?? []).filter((r) => r !== id);
      return done();
    }
    if (rest === '/variations') return json(mine ? others.slice(1) : []);
    return json([]);
  });
  return { sent, user };
}
const posts = (sent: { method: string; path: string; body: unknown }[], path: string) =>
  sent.filter((s) => s.path === path).map((s) => [s.method, s.body]);
const openSoup = async (page: Page) => {
  await page.goto(`/?recipe=${soup.id}`);
  await expect(page.getByText('Soften the garlic in the oil.', { exact: true })).toBeVisible();
};
const amounts = (page: Page, texts: string[]) =>
  Promise.all(texts.map((t) => expect(page.getByText(t, { exact: true })).toBeVisible()));

test('units: metric and imperial convert the amounts, and a cook’s choice is kept', async ({
  page,
}) => {
  const { sent } = await kitchen(page);
  await openSoup(page);
  await amounts(page, ['2 cups', '4 oz', '3 cloves', '2 tbsp', '500 g']);
  await page.getByRole('tab', { name: 'Metric', exact: true }).click();
  // Spoons are measures in both systems; cloves have no size to convert.
  await amounts(page, ['480 ml', '113 g', '3 cloves', '2 tbsp', '500 g']);
  await page.getByRole('tab', { name: 'Imperial', exact: true }).click();
  await amounts(page, ['2 cups', '4 oz', '3 cloves', '2 tbsp', '1⅛ lb']);
  await page.getByRole('button', { name: 'Fewer servings', exact: true }).click();
  await amounts(page, ['1½ cups', '3 oz', '2¼ cloves', '1½ tbsp', '13¼ oz']);
  await expect
    .poll(() => posts(sent, '/me/preferences'))
    .toEqual([
      ['PATCH', { units: 'metric' }],
      ['PATCH', { units: 'imperial' }],
    ]);
  // Saved to the profile, so it's where the next visit starts.
  await page.reload();
  await amounts(page, ['2 cups', '1⅛ lb']);
  await page.getByRole('tab', { name: 'Original', exact: true }).click();
  await amounts(page, ['500 g']);
  await expect.poll(() => posts(sent, '/me/preferences').at(-1)).toEqual(['PATCH', { units: '' }]);
});

test('units: a guest’s choice lasts the visit and is saved nowhere', async ({ page }) => {
  const { sent } = await kitchen(page, { signedIn: false });
  await openSoup(page);
  await page.getByRole('tab', { name: 'Metric', exact: true }).click();
  await amounts(page, ['480 ml']);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('link', { name: 'Let’s get cooking: Tomato soup', exact: true }).click();
  await amounts(page, ['480 ml', '113 g']);
  expect(posts(sent, '/me/preferences')).toEqual([]);
});

test.describe('Russian', () => {
  test.use({ locale: 'ru-RU' });
  test('converted units and counts take the forms their numbers need', async ({ page }) => {
    await kitchen(page, {
      units: 'imperial',
      comments: [
        {
          id: 'c1',
          body: 'Отличный суп.',
          parentId: null,
          createdAt: ago(5),
          updatedAt: ago(5),
          author: sam,
          canDelete: false,
        },
        {
          id: 'c2',
          body: 'Спасибо!',
          parentId: 'c1',
          createdAt: ago(3),
          updatedAt: ago(3),
          author: alex,
          canDelete: true,
        },
        {
          id: 'c3',
          body: 'Можно без масла?',
          parentId: null,
          createdAt: ago(2),
          updatedAt: ago(2),
          author: sam,
          canDelete: false,
        },
      ],
    });
    await openSoup(page);
    await amounts(page, ['2 чашки', '4 унции', '3 cloves', '2 ст. л.', '1⅛ фунта']);
    await page.getByRole('button', { name: 'Меньше порций', exact: true }).click();
    await page.getByRole('button', { name: 'Меньше порций', exact: true }).click();
    await amounts(page, ['1 чашка', '2 унции', '1 ст. л.', '8¾ унции']);
    await expect(page.getByText('3 комментария', { exact: true })).toBeVisible();
    await expect(page.getByText('5 минут назад', { exact: true })).toBeVisible();
    await expect(page.getByText('3 минуты назад', { exact: true })).toBeVisible();
  });
});

test('comments: oldest first with replies, then post, reply and delete', async ({ page }) => {
  const { sent } = await kitchen(page, {
    comments: [
      {
        id: 'c1',
        body: 'Can I use canned tomatoes?',
        parentId: null,
        createdAt: ago(10),
        updatedAt: ago(10),
        author: sam,
        canDelete: false,
      },
      {
        id: 'r1',
        body: 'Yes, two cans.',
        parentId: 'c1',
        createdAt: ago(8),
        updatedAt: ago(8),
        author: { ...robin },
        canDelete: false,
      },
      {
        id: 'c2',
        body: 'Made it twice already.',
        parentId: null,
        createdAt: ago(2),
        updatedAt: ago(2),
        author: alex,
        canDelete: true,
      },
    ],
  });
  await openSoup(page);
  await expect(page.getByText('3 comments', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/^(Can I use canned tomatoes\?|Yes, two cans\.|Made it twice already\.)$/),
  ).toHaveText(['Can I use canned tomatoes?', 'Yes, two cans.', 'Made it twice already.']);
  await expect(page.getByText('10 min ago', { exact: true })).toBeVisible();
  // Only what you may delete offers it.
  await expect(page.getByRole('button', { name: /^Delete comment by / })).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete comment by Alex', exact: true }).click();
  await expect(page.getByText('Delete this comment?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete comment', exact: true }).click();
  await expect(page.getByText('Comment deleted.', { exact: true })).toBeVisible();
  await expect(page.getByText('Made it twice already.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('2 comments', { exact: true })).toBeVisible();
  expect(posts(sent, '/comments/c2')).toEqual([['DELETE', null]]);

  await page
    .getByRole('textbox', { name: 'Your comment', exact: true })
    .fill('  Does it freeze well?  ');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.getByText('Does it freeze well?', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your comment', exact: true })).toHaveValue('');
  await expect(page.getByText('3 comments', { exact: true })).toBeVisible();

  // Replying to a reply joins the conversation it belongs to.
  await page.getByRole('button', { name: 'Reply to Robin', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reply to Sam', exact: true }).fill('Fresh is better.');
  await page.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(page.getByText('Fresh is better.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reply to Sam', exact: true })).toHaveCount(0);
  await expect(page.getByText('4 comments', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/^(Yes, two cans\.|Fresh is better\.|Does it freeze well\?)$/),
  ).toHaveText(['Yes, two cans.', 'Fresh is better.', 'Does it freeze well?']);
  expect(posts(sent, `/recipes/${soup.id}/comments`)).toEqual([
    ['POST', { body: 'Does it freeze well?' }],
    ['POST', { body: 'Fresh is better.', parentId: 'c1' }],
  ]);
});

test('comments: a page at a time, and guests are asked to sign in to post', async ({ page }) => {
  const many = Array.from({ length: 21 }, (_, i) => ({
    id: `c${i + 1}`,
    body: `Comment ${i + 1}`,
    parentId: null,
    createdAt: ago(100 - i),
    updatedAt: ago(100 - i),
    author: sam,
    canDelete: false,
  }));
  const { sent } = await kitchen(page, { signedIn: false, comments: many });
  const pages: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/comments?')) pages.push(new URL(r.url()).search);
  });
  await openSoup(page);
  await expect(page.getByText('Comment 20', { exact: true })).toBeVisible();
  await expect(page.getByText('Comment 21', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show more comments', exact: true }).click();
  await expect(page.getByText('Comment 21', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more comments', exact: true })).toHaveCount(
    0,
  );
  expect(pages).toEqual(['?offset=0&limit=20', '?offset=20&limit=20']);
  await page.getByRole('textbox', { name: 'Your comment', exact: true }).fill('Hello!');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toBeVisible();
  expect(posts(sent, `/recipes/${soup.id}/comments`)).toEqual([]);
});

test('I cooked this: a photo and a note, the count, and taking it back', async ({ page }) => {
  const { sent } = await kitchen(page, {
    cooks: [
      {
        id: 'k1',
        photo: 'https://media.test/k1.png',
        note: 'Added chili.',
        createdAt: ago(60 * 24),
        author: sam,
      },
      {
        id: 'k2',
        photo: '',
        note: '',
        createdAt: ago(60 * 48),
        author: { ...sam, id: 'rosa', name: 'Rosa' },
      },
    ],
  });
  await openSoup(page);
  await expect(page.getByText('2 cooks made this', { exact: true })).toBeVisible();
  // Only cooks who shared a photo are in the gallery.
  await expect(page.getByRole('button', { name: /^Photo by / })).toHaveCount(1);
  await page.getByRole('button', { name: 'Photo by Sam', exact: true }).click();
  await expect(page.getByText('Added chili.', { exact: true })).toBeVisible();
  await expect(page.getByText('1 day ago', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'I cooked this', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose a photo', exact: true }).click();
  await (await chooser).setFiles('tests/fixtures/sample.png');
  // The photo shows at once and uploads; the button waits for the upload.
  await expect(page.locator('img[alt="Your photo"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as cooked', exact: true })).toBeEnabled();
  expect(posts(sent, '/media')).toEqual([['POST', 'form']]);
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Lovely with bread.');
  await page.getByRole('button', { name: 'Mark as cooked', exact: true }).click();
  await expect(page.getByText('Marked as cooked. Enjoy!', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'You cooked this', exact: true })).toBeVisible();
  await expect(page.getByText('3 cooks made this', { exact: true })).toBeVisible();
  expect(posts(sent, `/recipes/${soup.id}/cooked`)).toEqual([
    ['POST', { photo: 'https://media.test/cooked.png', note: 'Lovely with bread.' }],
  ]);
  await expect(page.getByRole('button', { name: 'Photo by Alex', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'You cooked this', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
    'Lovely with bread.',
  );
  await page.getByRole('button', { name: 'Unmark as cooked', exact: true }).click();
  await expect(page.getByText('No longer marked as cooked.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'I cooked this', exact: true })).toBeVisible();
  await expect(page.getByText('2 cooks made this', { exact: true })).toBeVisible();
  expect(posts(sent, `/recipes/${soup.id}/cooked`).at(-1)).toEqual(['DELETE', null]);
});

test('I cooked this: an older server’s library still shows it from the cooks', async ({ page }) => {
  await kitchen(page, {
    noCookedIds: true,
    cooks: [{ id: 'k1', photo: '', note: 'Again!', createdAt: ago(30), author: alex }],
  });
  await openSoup(page);
  await expect(page.getByRole('button', { name: 'You cooked this', exact: true })).toBeVisible();
});

test('where a recipe comes from and its variations', async ({ page }) => {
  await kitchen(page);
  await openSoup(page);
  const source = page.getByRole('link', { name: 'From example.com', exact: true });
  await expect(source).toHaveAttribute('href', 'https://www.example.com/soup?ref=1');
  await expect(source).toHaveAttribute('target', '_blank');
  await expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  await page
    .getByRole('button', { name: 'Show the variations of this recipe', exact: true })
    .click();
  await expect(page.getByText('Variations (2)', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'View Creamy tomato soup', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'View Spicy tomato soup', exact: true }).click();
  await expect(page.getByText('Serve it hot.', { exact: true })).toBeVisible();
  await expect(page.getByText('Spicy tomato soup', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Soften the garlic in the oil.', { exact: true })).toHaveCount(0);
  // Nothing in it has a size to convert, so there's no choice of units.
  await expect(page.getByRole('tab', { name: 'Metric', exact: true })).toHaveCount(0);
  await openSoup(page);
  await page
    .getByRole('link', { name: 'Adapted from Grandma’s soup by Rosa', exact: true })
    .click();
  await expect(page.getByText('Serve it hot.', { exact: true })).toBeVisible();
  await expect(page.getByText('Grandma’s soup', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Soften the garlic in the oil.', { exact: true })).toHaveCount(0);
});

test('a review shows when it was edited, and its author can delete it', async ({ page }) => {
  const { sent } = await kitchen(page, {
    reviews: [
      {
        id: 'v1',
        rating: 5,
        body: 'So good.',
        createdAt: ago(3000),
        updatedAt: ago(60),
        author: { ...alex, bio: '' },
      },
      {
        id: 'v2',
        rating: 4,
        body: 'Nice and easy.',
        createdAt: ago(2000),
        updatedAt: ago(2000),
        author: { ...sam, bio: '' },
      },
    ],
  });
  await openSoup(page);
  await expect(page.getByText('So good.', { exact: true })).toBeVisible();
  await expect(page.getByText('Edited', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Delete your review', exact: true })).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Delete your review', exact: true }).click();
  await expect(page.getByText('Delete your review?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete review', exact: true }).click();
  await expect(page.getByText('Your review is deleted.', { exact: true })).toBeVisible();
  await expect(page.getByText('So good.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Nice and easy.', { exact: true })).toBeVisible();
  expect(posts(sent, `/recipes/${soup.id}/review`)).toEqual([['DELETE', null]]);
});

test('steps show their photos, on the page and in cooking mode', async ({ page }) => {
  await kitchen(page);
  await openSoup(page);
  await expect(page.locator('img[alt="Photo of step 2"]')).toHaveAttribute(
    'src',
    'https://media.test/step.png',
  );
  await expect(page.locator('img[alt="Photo of step 1"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  const cooking = page.locator('[aria-modal="true"]').last();
  await expect(cooking.getByText('Soften the garlic in the oil.', { exact: true })).toBeVisible();
  await expect(cooking.locator('img[alt="Photo of step 1"]')).toHaveCount(0);
  await cooking.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(cooking.locator('img[alt="Photo of step 2"]')).toBeVisible();
});

type Playback = { muted: boolean; loop: boolean; paused: boolean; controls: boolean };
const playback = (video: Locator) =>
  video.evaluate((v: HTMLVideoElement) => ({
    muted: v.muted,
    loop: v.loop,
    paused: v.paused,
    controls: v.controls,
  })) as Promise<Playback>;

test('steps show their clips: still on the page, muted on a loop in cooking mode', async ({
  page,
}) => {
  await kitchen(page);
  await openSoup(page);
  // The shared player with its controls, in a frame of its own shape, waiting to be played.
  const frame = page.getByRole('group', { name: 'Clip of step 1', exact: true });
  const clip = frame.locator('video');
  await expect(clip).toHaveAttribute('src', 'https://media.test/step.mp4');
  expect(await playback(clip)).toMatchObject({ paused: true, controls: true, muted: false });
  const box = (await frame.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
  await expect(page.getByRole('group', { name: 'Clip of step 2' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  const cooking = page.locator('[aria-modal="true"]').last();
  const pause = cooking.getByRole('button', { name: 'Pause the clip of step 1', exact: true });
  const play = cooking.getByRole('button', { name: 'Play the clip of step 1', exact: true });
  await expect(pause).toBeVisible();
  const looping = cooking.locator('video');
  await expect
    .poll(() => playback(looping))
    .toEqual({ muted: true, loop: true, paused: false, controls: false });
  // A tap pauses it, and another plays it again.
  await pause.click();
  await expect(play).toBeVisible();
  expect((await playback(looping)).paused).toBe(true);
  await play.click();
  await expect(pause).toBeVisible();
  // The next step's photo takes its place, and the clip stops with its step.
  await cooking.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(cooking.locator('img[alt="Photo of step 2"]')).toBeVisible();
  await expect(cooking.locator('video')).toHaveCount(0);
  await cooking.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(pause).toBeVisible();
  await cooking.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
  await expect(page.getByRole('button', { name: /the clip of step/ })).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(1);
  expect((await playback(clip)).paused).toBe(true);
});

test('print makes a page of the recipe in the units on screen', async ({ page }) => {
  // The test stands in for the print dialog and counts its openings.
  await page.addInitScript(() => {
    const own = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const view = own.get!.call(this) as Window | null;
        if (view && this.hasAttribute('data-print'))
          view.print = () => {
            const counter = window as unknown as { printed?: number };
            counter.printed = (counter.printed ?? 0) + 1;
          };
        return view;
      },
    });
  });
  await kitchen(page);
  await openSoup(page);
  await page.getByRole('tab', { name: 'Metric', exact: true }).click();
  await page.getByRole('button', { name: 'Print recipe', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { printed?: number }).printed ?? 0))
    .toBe(1);
  const printed = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe[data-print]')!.contentDocument!;
    const texts = (selector: string) =>
      [...doc.querySelectorAll(selector)].map((e) => e.textContent?.trim());
    return {
      title: doc.title,
      lang: doc.documentElement.lang,
      heading: texts('h1'),
      sections: texts('h2'),
      ingredients: texts('.ingredient'),
      boxes: doc.querySelectorAll('.ingredient .box').length,
      steps: texts('ol > li'),
      credits: texts('footer p'),
      markup: doc.querySelectorAll('b, script').length,
      // Step clips stay on screen; paper has no use for them.
      clips: doc.querySelectorAll('video').length + doc.body.innerHTML.split('.mp4').length - 1,
    };
  });
  expect(printed).toEqual({
    title: 'Tomato soup',
    lang: 'en-US',
    heading: ['Tomato soup'],
    sections: ['Ingredients', 'Method'],
    ingredients: ['Milk480 ml', 'Butter113 g', 'Garlic3 cloves', 'Olive oil2 tbsp', 'Flour500 g'],
    boxes: 5,
    steps: ['SoftenSoften the garlic in the oil.', 'SimmerSimmer with <b>milk</b> & butter.'],
    credits: [
      'Adapted from Grandma’s soup by Rosa',
      'From example.com · https://www.example.com/soup?ref=1',
      expect.stringMatching(/\/recipes\/tomato-soup$/),
    ],
    markup: 0,
    clips: 0,
  });
});

test('a phone shows the same parts in its own layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await kitchen(page, {
    comments: [
      {
        id: 'c1',
        body: 'Lovely soup.',
        parentId: null,
        createdAt: ago(1),
        updatedAt: ago(1),
        author: sam,
        canDelete: false,
      },
    ],
  });
  await page.goto(`/?recipe=${soup.id}`);
  await page.getByRole('tab', { name: 'Metric', exact: true }).click();
  await amounts(page, ['480 ml', '113 g']);
  await expect(page.getByRole('button', { name: 'I cooked this', exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Adapted from Grandma’s soup by Rosa', exact: true }),
  ).toBeVisible();
  await page.getByText('Lovely soup.', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByText('1 comment', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print recipe', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // A step's clip keeps a fixed shape across the card, whatever the video's own.
  await page.getByRole('tab', { name: 'Method', exact: true }).click();
  const clip = page.getByRole('group', { name: 'Clip of step 1', exact: true });
  await clip.scrollIntoViewIfNeeded();
  const box = (await clip.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
  expect(box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
