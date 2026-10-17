/// <reference types="jest" />
import type { Kitchen, Library, Recipe, User } from '../types';
import {
  RECENT_LIMIT,
  SAVED_LIMIT,
  type Snapshot,
  parseSnapshot,
  remember,
  trimmed,
  worthShowing,
} from '../offline';

const author = { id: 'cook', name: 'Robin', handle: 'robin', bio: '', avatar: '' };
const recipe = (id: string, extra: Partial<Recipe> = {}): Recipe => ({
  id,
  title: `Recipe ${id}`,
  description: '',
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [],
  steps: [{ title: '', text: 'Cook it.', seconds: 0 }],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: true,
  author,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T00:00:00Z',
  ...extra,
});
const library = (recipes: Recipe[]): Library => ({
  savedIds: recipes.map((r) => r.id),
  saves: [],
  collections: [],
  followingIds: [],
  recipes,
});
const kitchen = (planned: Recipe[]): Kitchen => ({
  plans: planned.map((r, n) => ({
    id: `p${n}`,
    recipeId: r.id,
    day: '2026-10-16',
    meal: 'Dinner',
    servings: 2,
    recipe: r,
  })),
  groceries: [{ id: 'g1', name: 'Lemons', quantity: '2', category: 'Produce', checked: false }],
  pantry: [],
});
const user = { ...author, email: 'robin@example.test' } as unknown as User;
const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  recipes: [],
  creators: [],
  feed: null,
  user: null,
  library: null,
  kitchen: null,
  ...extra,
});

describe('recently opened recipes', () => {
  test('newest first, each once, at most thirty', () => {
    let list: Recipe[] = [];
    for (let n = 0; n < RECENT_LIMIT + 3; n++) list = remember(list, recipe(`r${n}`));
    expect(RECENT_LIMIT).toBe(30);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].id).toBe(`r${RECENT_LIMIT + 2}`);
    expect(list.some((r) => r.id === 'r0')).toBe(false);
    // Opening one again moves it to the front, with its newer copy.
    list = remember(list, recipe('r10', { title: 'Updated' }));
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toMatchObject({ id: 'r10', title: 'Updated' });
    expect(list.filter((r) => r.id === 'r10')).toHaveLength(1);
    expect(remember([recipe('a'), recipe('b')], recipe('b'), 2).map((r) => r.id)).toEqual([
      'b',
      'a',
    ]);
  });
});

describe('the snapshot', () => {
  test('keeps the newest saved recipes only', () => {
    const many = Array.from({ length: SAVED_LIMIT + 20 }, (_, n) => recipe(`s${n}`));
    const stored = trimmed(snapshot({ user, library: library(many) }));
    expect(stored.library?.recipes).toHaveLength(SAVED_LIMIT);
    expect(stored.library?.recipes[0].id).toBe('s0');
    expect(stored.library?.savedIds).toHaveLength(SAVED_LIMIT + 20);
    const few = snapshot({ library: library([recipe('a')]) });
    expect(trimmed(few)).toBe(few);
  });

  test('is shown only when it has something to cook from', () => {
    expect(worthShowing(null)).toBe(false);
    expect(worthShowing(snapshot())).toBe(false);
    expect(worthShowing(snapshot({ recipes: [recipe('a')] }))).toBe(true);
    expect(worthShowing(snapshot({ user, library: library([recipe('a')]) }))).toBe(true);
    expect(worthShowing(snapshot({ user, kitchen: kitchen([recipe('a')]) }))).toBe(true);
  });

  test('reads back what was stored, and nothing from damaged data', () => {
    const stored = snapshot({ recipes: [recipe('a')], user, library: library([recipe('b')]) });
    expect(parseSnapshot(JSON.stringify(stored))).toEqual(stored);
    expect(parseSnapshot(JSON.stringify({ recipes: [recipe('a')] }))).toEqual(
      snapshot({ recipes: [recipe('a')] }),
    );
    for (const text of [null, '', 'not json', '[]', '{}', 'null', '{"recipes":"x"}'])
      expect(parseSnapshot(text)).toBeNull();
  });
});

describe('on the device', () => {
  // The device's storage, kept across "launches" (fresh copies of the module).
  const disk = new Map<string, string>();
  const storage = {
    getItem: jest.fn<Promise<string | null>, [string]>(),
    setItem: jest.fn<Promise<void>, [string, string]>(),
    removeItem: jest.fn<Promise<void>, [string]>(),
  };
  const launch = (): typeof import('../offline') => {
    jest.resetModules();
    jest.doMock('@react-native-async-storage/async-storage', () => storage);
    return require('../offline');
  };
  let offline: typeof import('../offline');
  beforeEach(() => {
    jest.useFakeTimers();
    disk.clear();
    storage.getItem.mockImplementation(async (key) => disk.get(key) ?? null);
    storage.setItem.mockImplementation(async (key, value) => void disk.set(key, value));
    storage.removeItem.mockImplementation(async (key) => void disk.delete(key));
    offline = launch();
  });
  afterEach(() => jest.useRealTimers());
  // Lets storage's promises settle, under fake timers.
  const settle = async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  };

  test('an opened recipe is found again, and survives a relaunch', async () => {
    offline.rememberRecipe(recipe('lemon'));
    offline.rememberRecipe(recipe('draft', { published: false }));
    await settle();
    expect(await offline.cachedRecipe('lemon')).toMatchObject({ id: 'lemon' });
    // A kitchen's own drafts aren't kept: they could outlive signing out.
    expect(await offline.cachedRecipe('draft')).toBeNull();
    const relaunched = launch();
    expect(await relaunched.cachedRecipe('lemon')).toMatchObject({ id: 'lemon' });
  });

  test('saved, planned and home recipes are found in the snapshot', async () => {
    offline.saveSnapshot(
      snapshot({
        recipes: [recipe('home')],
        user,
        library: library([recipe('saved')]),
        kitchen: kitchen([recipe('planned')]),
      }),
    );
    // Before the write lands, the waiting snapshot answers.
    expect(await offline.cachedRecipe('saved')).toMatchObject({ id: 'saved' });
    jest.advanceTimersByTime(1000);
    await settle();
    const relaunched = launch();
    for (const id of ['home', 'saved', 'planned'])
      expect(await relaunched.cachedRecipe(id)).toMatchObject({ id });
    expect(await relaunched.cachedRecipe('elsewhere')).toBeNull();
    expect((await relaunched.loadSnapshot())?.user).toMatchObject({ id: 'cook' });
  });

  test('signing out takes the kitchen’s own copies off the device at once', async () => {
    offline.saveSnapshot(
      snapshot({ recipes: [recipe('home')], user, library: library([recipe('saved')]) }),
    );
    jest.advanceTimersByTime(1000);
    await settle();
    offline.rememberRecipe(recipe('opened'));
    offline.forgetKitchen();
    await settle();
    const stored = parseSnapshot(disk.get('savorly.offline.snapshot') ?? null);
    expect(stored).toMatchObject({ user: null, library: null, kitchen: null });
    expect(stored?.recipes.map((r) => r.id)).toEqual(['home']);
    expect(await offline.cachedRecipe('saved')).toBeNull();
    // Public recipes opened on this device stay.
    expect(await offline.cachedRecipe('opened')).toMatchObject({ id: 'opened' });
  });

  test('storage failures stay quiet', async () => {
    storage.getItem.mockImplementation(() => Promise.reject(new Error('denied')));
    storage.setItem.mockImplementation(() => Promise.reject(new Error('full')));
    offline = launch();
    offline.rememberRecipe(recipe('a'));
    offline.saveSnapshot(snapshot({ recipes: [recipe('a')] }));
    jest.advanceTimersByTime(1000);
    await settle();
    await expect(offline.cachedRecipe('zzz')).resolves.toBeNull();
    await expect(offline.loadSnapshot()).resolves.toBeNull();
  });
});
