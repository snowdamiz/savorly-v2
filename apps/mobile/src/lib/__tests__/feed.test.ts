/// <reference types="jest" />
import type { Recipe } from '../types';
import { type Feed, homeShelves, parseFeed } from '../feed';
import { kitchenWindow } from '../store';

const recipe = (id: string, extra: Partial<Recipe> = {}): Recipe =>
  ({
    id,
    title: `Recipe ${id}`,
    minutes: 30,
    saveCount: 0,
    rating: 0,
    author: { id: 'cook', name: 'Robin' },
    ...extra,
  }) as Recipe;
const ids = (list: Recipe[]) => list.map((r) => r.id);
const counts = { trending: 3, quick: 2, following: 3 };

describe('GET /feed', () => {
  test('reads the feed, and nothing else as one', () => {
    const feed = {
      hero: recipe('h'),
      trending: [recipe('t1')],
      quick: [recipe('q1')],
      following: [],
      newest: [recipe('n1')],
      cookAlong: { week: '2026-10-12', recipe: recipe('c'), cooks: 2, started: 5 },
    };
    expect(parseFeed(feed)).toEqual(feed);
    // Missing shelves are empty; things that aren't recipes are left out.
    expect(parseFeed({ trending: [recipe('t1'), null, { id: 3 }], quick: [] })).toEqual({
      hero: null,
      trending: [recipe('t1')],
      quick: [],
      following: [],
      newest: [],
      cookAlong: null,
    });
    for (const answer of [null, undefined, [], [recipe('a')], 'feed', {}, { trending: [] }])
      expect(parseFeed(answer)).toBeNull();
  });

  test('reads the cook-along, with counts that are never negative', () => {
    const cookAlong = (value: unknown) =>
      parseFeed({ trending: [], quick: [], cookAlong: value })?.cookAlong;
    expect(cookAlong({ week: '2026-10-12', recipe: recipe('c'), started: 3.7, cooks: -1 })).toEqual(
      { week: '2026-10-12', recipe: recipe('c'), started: 3, cooks: 0 },
    );
    for (const value of [null, undefined, 'soup', { week: '2026-10-12' }, { recipe: recipe('c') }])
      expect(cookAlong(value)).toBeNull();
  });
});

describe('the home shelves', () => {
  const feed: Feed = {
    hero: recipe('h'),
    trending: ['t1', 't2', 't3', 't4', 't5'].map((id) => recipe(id)),
    // Quick shares two recipes with trending; following shares one with quick.
    quick: ['t2', 'q1', 't5', 'q2', 'q3'].map((id) => recipe(id)),
    following: ['q1', 'f1', 'f2'].map((id) => recipe(id, { author: { id: 'friend' } as never })),
    newest: [],
  };

  test('from the feed, no recipe shows twice on one screen', () => {
    const shelves = homeShelves(feed, [], ['friend'], counts);
    expect(shelves.hero?.id).toBe('h');
    expect(ids(shelves.trending)).toEqual(['t1', 't2', 't3']);
    // t2 is in trending's shown three; t5 isn't shown there, so quick can have it.
    expect(ids(shelves.quick)).toEqual(['q1', 't5']);
    expect(ids(shelves.following)).toEqual(['f1', 'f2']);
    const all = [shelves.hero!, ...shelves.trending, ...shelves.quick, ...shelves.following];
    expect(new Set(ids(all)).size).toBe(all.length);
  });

  test('a desktop row that shows fewer leaves more for the next shelf', () => {
    const shelves = homeShelves(feed, [], ['friend'], { ...counts, trending: 1 });
    expect(ids(shelves.trending)).toEqual(['t1']);
    expect(ids(shelves.quick)).toEqual(['t2', 'q1']);
  });

  test('kitchens unfollowed since the feed came drop out; guests see no following shelf', () => {
    expect(homeShelves(feed, [], [], counts).following).toEqual([]);
    expect(homeShelves(feed, [], ['friend'], { ...counts, following: 0 }).following).toEqual([]);
  });

  test('the cook-along has its own card, so no shelf repeats it', () => {
    const cookAlong = { week: '2026-10-12', recipe: recipe('h'), cooks: 0, started: 0 };
    const shelves = homeShelves({ ...feed, cookAlong }, [], ['friend'], counts);
    expect(shelves.cookAlong).toBe(cookAlong);
    expect(shelves.hero?.id).toBe('t1');
    expect(ids(shelves.trending)).toEqual(['t2', 't3', 't4']);
    expect(homeShelves(feed, [], [], counts).cookAlong).toBeNull();
  });

  test('without a hero the feed still leads with something', () => {
    expect(homeShelves({ ...feed, hero: null }, [], [], counts).hero?.id).toBe('t1');
    const empty: Feed = { hero: null, trending: [], quick: [], following: [], newest: [] };
    expect(homeShelves(empty, [recipe('x')], [], counts).hero).toBeUndefined();
  });

  test('without the feed, the home works its shelves out as it used to', () => {
    const all = [
      recipe('slow-popular', { saveCount: 9, minutes: 90 }),
      recipe('lemon-ricotta-pasta', { saveCount: 1, minutes: 25 }),
      recipe('quick', { saveCount: 0, minutes: 10 }),
      recipe('mid', { saveCount: 5, minutes: 40, rating: 4 }),
      recipe('mid-better', { saveCount: 5, minutes: 45, rating: 5 }),
      recipe('friendly', { saveCount: 0, minutes: 15, author: { id: 'friend' } as never }),
    ];
    const shelves = homeShelves(null, all, ['friend'], counts);
    // The sample recipe leads when it is there, as before; otherwise the first recipe.
    expect(shelves.hero?.id).toBe('lemon-ricotta-pasta');
    expect(ids(shelves.trending)).toEqual(['slow-popular', 'mid-better', 'mid']);
    expect(ids(shelves.quick)).toEqual(['quick', 'friendly']);
    expect(ids(shelves.following)).toEqual([]);
    expect(homeShelves(null, all.slice(2), [], counts).hero?.id).toBe('quick');
    expect(homeShelves(null, [], [], counts)).toEqual({
      cookAlong: null,
      hero: undefined,
      trending: [],
      quick: [],
      following: [],
    });
  });
});

describe('the kitchen’s window', () => {
  // Friday 16 October 2026.
  const friday = new Date(2026, 9, 16, 12);
  test('the week before this one through four weeks ahead, in the locale’s weeks', () => {
    // Monday-first: last week starts Monday 5 October; four weeks ahead ends Sunday 15 November.
    expect(kitchenWindow(1, friday)).toEqual({ from: '2026-10-05', to: '2026-11-15' });
    // Sunday-first: Sunday 4 October to Saturday 14 November.
    expect(kitchenWindow(0, friday)).toEqual({ from: '2026-10-04', to: '2026-11-14' });
    // Saturday-first: Saturday 3 October to Friday 13 November.
    expect(kitchenWindow(6, friday)).toEqual({ from: '2026-10-03', to: '2026-11-13' });
  });

  test('on the first day of a week, and across a year’s end', () => {
    expect(kitchenWindow(1, new Date(2026, 9, 12))).toEqual({
      from: '2026-10-05',
      to: '2026-11-15',
    });
    expect(kitchenWindow(1, new Date(2026, 11, 31))).toEqual({
      from: '2026-12-21',
      to: '2027-01-31',
    });
  });

  test('six weeks, inside the API’s 62 days', () => {
    for (let day = 0; day < 14; day++) {
      const { from, to } = kitchenWindow(1, new Date(2026, 2, 20 + day));
      const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
      expect(days).toBe(42);
    }
  });
});
