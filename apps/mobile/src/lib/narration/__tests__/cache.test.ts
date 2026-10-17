/// <reference types="jest" />
import {
  NARRATION_BYTES,
  NARRATION_RECIPES,
  type KeptNarration,
  type NarratedStep,
  current,
  narrationKey,
  parseCopies,
  within,
} from '../cache';

// The list of copies runs the same on every platform; where the audio goes (files on phones, Cache
// Storage in browsers) is audioStore's part, stood in for here.

const MB = 1024 * 1024;
const step = (extra: Partial<NarratedStep> = {}): NarratedStep => ({
  owner: 'cook',
  recipe: 'soup',
  language: 'en',
  step: 0,
  text: 'Chop the onions.',
  ...extra,
});
const pathOf = (s: NarratedStep, key: string) =>
  `/recipes/${s.recipe}/steps/${s.step}/narration/${key}`;
const copy = (
  key: string,
  extra: Partial<NarratedStep> = {},
  more: Partial<KeptNarration> = {},
) => {
  const s = step(extra);
  return { ...s, key, path: pathOf(s, key), bytes: MB, used: 1, ...more };
};

describe('keys', () => {
  test('a copy is known by the API’s own key for the recording', () => {
    expect(narrationKey('/recipes/soup/steps/2/narration/9f86d081884c7d659a2feaa0c55ad015')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015',
    );
    for (const path of [
      '/recipes/soup/steps/2/narration',
      '/recipes/soup/steps/x/narration/abc',
      '/recipes/soup/steps/2/narration/../../me',
      '/recipes/soup/steps/2/narration/abc?token=secret',
      'https://elsewhere.example/recipes/soup/steps/2/narration/abc',
      '/me/export',
    ])
      expect(narrationKey(path)).toBeNull();
  });

  test('a new key for the same text means a new voice: every older copy is out of date', () => {
    const copies = [
      copy('old-0'),
      copy('old-1', { step: 1, text: 'Fry them.' }),
      copy('pie', { recipe: 'pie' }),
    ];
    expect(current(copies, step(), 'new-0')).toEqual([]);
    // The same key: nothing changed.
    expect(current(copies, step(), 'old-0')).toEqual(copies);
  });

  test('an edited step lets the copies of its earlier text go, and only those', () => {
    const copies = [copy('old-0'), copy('old-1', { step: 1, text: 'Fry them.' })];
    expect(current(copies, step({ text: 'Chop the onions finely.' }), 'new-0')).toEqual([
      copies[1],
    ]);
  });

  test('a damaged list reads as empty, and stray entries are left out', () => {
    for (const text of [null, '', 'not json', '{}', 'null', '"x"'])
      expect(parseCopies(text)).toEqual([]);
    const good = copy('k1');
    const forged = { ...copy('k2'), path: '/me/export' };
    expect(parseCopies(JSON.stringify([good, forged, { key: 'k3' }, null]))).toEqual([good]);
  });
});

describe('limits', () => {
  test('the last three recipes read aloud, at most', () => {
    expect(NARRATION_RECIPES).toBe(3);
    const copies = ['a', 'b', 'c', 'd'].flatMap((recipe, n) => [
      copy(`${recipe}0`, { recipe }, { used: 10 * n + 1 }),
      copy(`${recipe}1`, { recipe, step: 1 }, { used: 10 * n + 2 }),
    ]);
    const kept = within(copies);
    expect(kept.map((c) => c.key)).toEqual(['d1', 'd0', 'c1', 'c0', 'b1', 'b0']);
  });

  test('a recipe is as recent as its newest copy', () => {
    const copies = [
      copy('a0', { recipe: 'a' }, { used: 1 }),
      copy('b0', { recipe: 'b' }, { used: 2 }),
      copy('c0', { recipe: 'c' }, { used: 3 }),
      // Played again last: its recipe is the newest.
      copy('a1', { recipe: 'a', step: 1 }, { used: 4 }),
      copy('d0', { recipe: 'd' }, { used: 0 }),
    ];
    expect(within(copies).map((c) => c.key)).toEqual(['a1', 'a0', 'c0', 'b0']);
  });

  test('within 15 MB, the oldest going first', () => {
    expect(NARRATION_BYTES).toBe(15 * MB);
    const copies = [
      copy('a0', { recipe: 'a' }, { used: 1, bytes: 4 * MB }),
      copy('b0', { recipe: 'b' }, { used: 2, bytes: 5 * MB }),
      copy('b1', { recipe: 'b', step: 1 }, { used: 3, bytes: 5 * MB }),
      copy('c0', { recipe: 'c' }, { used: 4, bytes: 6 * MB }),
    ];
    expect(within(copies).map((c) => c.key)).toEqual(['c0', 'b1']);
    expect(within(copies, 3, 20 * MB).map((c) => c.key)).toEqual(['c0', 'b1', 'b0', 'a0']);
    // A recording larger than the room left isn't kept at all.
    expect(within([copy('huge', {}, { bytes: 16 * MB })])).toEqual([]);
  });
});

describe('on the device', () => {
  // The device's storage and the audio files, kept across "launches" (fresh copies of the module).
  const disk = new Map<string, string>();
  const storage = {
    getItem: jest.fn<Promise<string | null>, [string]>(),
    setItem: jest.fn<Promise<void>, [string, string]>(),
    removeItem: jest.fn<Promise<void>, [string]>(),
  };
  const files = new Map<string, number>();
  const audio = {
    saveAudio: jest.fn<Promise<number>, [string, string]>(),
    audioSource: jest.fn<Promise<string | null>, [string, string]>(),
    removeAudio: jest.fn<Promise<void>, [string, string]>(),
    clearAudio: jest.fn<Promise<void>, []>(),
  };
  /** The recordings the API "streams", by key: their sizes. */
  let sizes: Record<string, number> = {};
  const launch = (): typeof import('../cache') => {
    jest.resetModules();
    jest.doMock('@react-native-async-storage/async-storage', () => storage);
    jest.doMock('../audioStore', () => audio);
    return require('../cache');
  };
  let cache: typeof import('../cache');
  let now = 1000;
  beforeEach(() => {
    disk.clear();
    files.clear();
    sizes = {};
    now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 10));
    storage.getItem.mockImplementation(async (key) => disk.get(key) ?? null);
    storage.setItem.mockImplementation(async (key, value) => void disk.set(key, value));
    storage.removeItem.mockImplementation(async (key) => void disk.delete(key));
    audio.saveAudio.mockImplementation(async (key) => {
      files.set(key, sizes[key] ?? MB);
      return sizes[key] ?? MB;
    });
    audio.audioSource.mockImplementation(async (key) =>
      files.has(key) ? `file:///cache/narration/${key}.mp3` : null,
    );
    audio.removeAudio.mockImplementation(async (key) => void files.delete(key));
    audio.clearAudio.mockImplementation(async () => files.clear());
    cache = launch();
  });
  afterEach(() => jest.restoreAllMocks());
  // Lets the fire-and-forget keeping finish: every stand-in answers at once.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const keep = async (s: NarratedStep, key: string) => {
    cache.keepNarration(s, pathOf(s, key));
    await settle();
  };
  const stored = () => parseCopies(disk.get('savorly.offline.narration') ?? null);

  test('a step heard from the cloud is kept, and plays again for that step only', async () => {
    await keep(step(), 'k0');
    expect(audio.saveAudio).toHaveBeenCalledWith('k0', '/recipes/soup/steps/0/narration/k0');
    expect(stored()).toMatchObject([{ key: 'k0', owner: 'cook', recipe: 'soup', bytes: MB }]);
    const source = 'file:///cache/narration/k0.mp3';
    // Offline: the newest copy of the step as the cook sees it.
    expect(await cache.cachedNarration(step())).toBe(source);
    // Online: the copy of the recording the API named.
    expect(await cache.cachedNarration(step(), pathOf(step(), 'k0'))).toBe(source);
    // Never for an edited step, a recipe in another language, another step, recipe or cook.
    for (const other of [
      step({ text: 'Chop the onions finely.' }),
      step({ language: 'fr' }),
      step({ step: 1 }),
      step({ recipe: 'pie' }),
      step({ owner: 'someone-else' }),
    ])
      expect(await cache.cachedNarration(other)).toBeNull();
    // Kept already: heard again, nothing is downloaded twice.
    await keep(step(), 'k0');
    expect(audio.saveAudio).toHaveBeenCalledTimes(1);
  });

  test('once the API names a new recording (a new voice), the old one never plays again', async () => {
    await keep(step(), 'old-voice');
    await keep(step({ recipe: 'pie' }), 'pie-old-voice');
    expect(await cache.cachedNarration(step(), pathOf(step(), 'new-voice'))).toBeNull();
    expect(await cache.cachedNarration(step())).toBeNull();
    expect(await cache.cachedNarration(step({ recipe: 'pie' }))).toBeNull();
    expect(files.size).toBe(0);
    expect(stored()).toEqual([]);
    // Heard in the new voice, it's kept again.
    await keep(step(), 'new-voice');
    expect(await cache.cachedNarration(step())).toBe('file:///cache/narration/new-voice.mp3');
  });

  test('the API naming a new recording is enough for the old one to go', async () => {
    await keep(step(), 'old-voice');
    await keep(step({ step: 1, text: 'Fry them.' }), 'old-voice-1');
    // Step two is prepared ahead in the new voice; step one's copy is out of date as well.
    cache.narrationNamed(
      step({ step: 1, text: 'Fry them.' }),
      pathOf(step({ step: 1 }), 'new-voice-1'),
    );
    await settle();
    expect(files.size).toBe(0);
    expect(await cache.cachedNarration(step())).toBeNull();
    // The same recording named again changes nothing.
    await keep(step(), 'k0');
    cache.narrationNamed(step(), pathOf(step(), 'k0'));
    await settle();
    expect(await cache.cachedNarration(step())).not.toBeNull();
  });

  test('an edited step is kept anew, and its earlier recording goes', async () => {
    await keep(step(), 'before');
    await keep(step({ text: 'Chop the onions finely.' }), 'after');
    expect([...files.keys()]).toEqual(['after']);
    expect(await cache.cachedNarration(step())).toBeNull();
    expect(await cache.cachedNarration(step({ text: 'Chop the onions finely.' }))).toBe(
      'file:///cache/narration/after.mp3',
    );
  });

  test('only the last three recipes read aloud stay on the device', async () => {
    for (const recipe of ['a', 'b', 'c']) {
      await keep(step({ recipe }), `${recipe}0`);
      await keep(step({ recipe, step: 1, text: 'Serve.' }), `${recipe}1`);
    }
    // Recipe a is cooked again offline: it counts as read aloud last.
    expect(await cache.cachedNarration(step({ recipe: 'a' }))).not.toBeNull();
    await keep(step({ recipe: 'd' }), 'd0');
    expect([...files.keys()].sort()).toEqual(['a0', 'a1', 'c0', 'c1', 'd0']);
    expect(audio.removeAudio).toHaveBeenCalledWith('b0', '/recipes/b/steps/0/narration/b0');
    expect(await cache.cachedNarration(step({ recipe: 'b' }))).toBeNull();
    expect(new Set(stored().map((c) => c.recipe))).toEqual(new Set(['a', 'c', 'd']));
  });

  test('within 15 MB: the oldest recordings go first', async () => {
    sizes = { s0: 6 * MB, s1: 6 * MB, s2: 6 * MB };
    for (const n of [0, 1, 2]) await keep(step({ step: n, text: `Step ${n}.` }), `s${n}`);
    expect([...files.keys()].sort()).toEqual(['s1', 's2']);
    expect(stored().reduce((sum, c) => sum + c.bytes, 0)).toBeLessThanOrEqual(NARRATION_BYTES);
    expect(await cache.cachedNarration(step({ step: 0, text: 'Step 0.' }))).toBeNull();
  });

  test('the copies outlast a relaunch', async () => {
    await keep(step(), 'k0');
    const relaunched = launch();
    expect(await relaunched.cachedNarration(step())).toBe('file:///cache/narration/k0.mp3');
  });

  test('the list is read afresh, as another tab of the web app may have changed it', async () => {
    await keep(step(), 'k0');
    disk.delete('savorly.offline.narration');
    expect(await cache.cachedNarration(step())).toBeNull();
  });

  test('signing out takes every copy off the device', async () => {
    await keep(step(), 'k0');
    await keep(step({ recipe: 'draft' }), 'd0');
    await cache.forgetNarration();
    expect(audio.clearAudio).toHaveBeenCalled();
    expect(files.size).toBe(0);
    expect(disk.has('savorly.offline.narration')).toBe(false);
    expect(await cache.cachedNarration(step())).toBeNull();
    expect(await launch().cachedNarration(step({ recipe: 'draft' }))).toBeNull();
  });

  test('signing out forgets the kitchen’s narration along with the rest of it', async () => {
    await keep(step({ recipe: 'draft' }), 'd0');
    jest.doMock('@react-native-async-storage/async-storage', () => storage);
    jest.doMock('../audioStore', () => audio);
    const offline: typeof import('../../offline') = require('../../offline');
    offline.forgetKitchen();
    await settle();
    expect(audio.clearAudio).toHaveBeenCalled();
    expect(await cache.cachedNarration(step({ recipe: 'draft' }))).toBeNull();
  });

  test('a recording still downloading when the cook signs out is never kept', async () => {
    let finish!: (bytes: number) => void;
    audio.saveAudio.mockImplementationOnce(
      (key) =>
        new Promise((resolve) => {
          finish = (bytes) => {
            files.set(key, bytes);
            resolve(bytes);
          };
        }),
    );
    cache.keepNarration(step(), pathOf(step(), 'k0'));
    await settle();
    await cache.forgetNarration();
    finish(MB);
    await settle();
    expect(files.size).toBe(0);
    expect(stored()).toEqual([]);
    expect(await cache.cachedNarration(step())).toBeNull();
  });

  test('a recording the system cleared to make room is forgotten', async () => {
    await keep(step(), 'k0');
    files.clear();
    expect(await cache.cachedNarration(step())).toBeNull();
    expect(stored()).toEqual([]);
  });

  test('failures stay quiet', async () => {
    audio.saveAudio.mockRejectedValueOnce(new Error('UnableToDownload: 502'));
    await keep(step(), 'k0');
    expect(stored()).toEqual([]);
    // The next time it plays from the cloud, it's tried again.
    await keep(step(), 'k0');
    expect(await cache.cachedNarration(step())).not.toBeNull();
    storage.getItem.mockRejectedValue(new Error('denied'));
    storage.setItem.mockRejectedValue(new Error('full'));
    cache = launch();
    await keep(step({ recipe: 'pie' }), 'p0');
    await expect(cache.cachedNarration(step({ recipe: 'pie' }))).resolves.not.toBeNull();
    audio.audioSource.mockRejectedValue(new Error('SecurityError'));
    await expect(cache.cachedNarration(step({ recipe: 'pie' }))).resolves.toBeNull();
    await expect(cache.forgetNarration()).resolves.toBeUndefined();
  });
});
