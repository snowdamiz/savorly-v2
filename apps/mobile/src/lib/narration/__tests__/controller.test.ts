/// <reference types="jest" />
import { CookingNarration, NarrationPlayer, NarrationState, PlayerEvent } from '../controller';

type Fake = NarrationPlayer & { emit: (event: PlayerEvent) => void };
type Options = {
  enabled?: boolean;
  prepare?: jest.Mock;
  /** The device's copies (cache.ts): by step, the cloud path each is a recording of. */
  copies?: Record<number, string>;
};
function setup({ enabled = true, prepare, copies }: Options = {}) {
  const states: NarrationState[] = [];
  const players = new Map<string, Fake>();
  const spoken: { text: string; done: () => void }[] = [];
  const deps = {
    enabled,
    texts: ['Boil water.', 'Add pasta.', 'Drain.'],
    prepare: prepare ?? jest.fn((step: number) => Promise.resolve(`/narration/${step}`)),
    player: jest.fn((path: string, event: (event: PlayerEvent) => void) => {
      const fake: Fake = {
        play: jest.fn(() => Promise.resolve()),
        stop: jest.fn(),
        dispose: jest.fn(),
        emit: event,
      };
      players.set(path, fake);
      return fake;
    }),
    // A copy is found for its step, and once the API has named a recording, only for that one.
    kept: jest.fn((step: number, _text: string, path?: string) =>
      Promise.resolve(
        copies?.[step] !== undefined && (path === undefined || path === copies[step])
          ? `file:///copies/${step}.mp3`
          : null,
      ),
    ),
    keep: jest.fn(),
    unreachable: (error: unknown) => error instanceof Error && error.name === 'NetworkError',
    speak: jest.fn((text: string, done: () => void) => spoken.push({ text, done })),
    stopSpeech: jest.fn(),
    state: jest.fn((state: NarrationState) => states.push(state)),
  };
  // Without copies, the narration has no device copies to fall back on, as before cache.ts.
  const { kept, keep, unreachable, ...cloudOnly } = deps;
  const narration = new CookingNarration(copies ? deps : cloudOnly);
  return { narration, deps, states, players, spoken, kept, keep, unreachable };
}
/** What `prepare` rejects with when the API can't be reached. */
const offline = () =>
  Promise.reject(
    Object.assign(new Error('We couldn’t reach your kitchen.'), { name: 'NetworkError' }),
  );
// Settles the promise chains a step goes through (prepare → player → play).
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('reads a step aloud and preloads the next one once playing', async () => {
  const { narration, deps, states, players } = setup();
  narration.read();
  await flush();
  const first = players.get('/narration/0')!;
  expect(first.play).toHaveBeenCalled();
  first.emit('playing');
  expect(states.at(-1)).toBe('playing');
  await flush();
  expect(deps.prepare).toHaveBeenCalledWith(1, 'Add pasta.');
  first.emit('ended');
  expect(states.at(-1)).toBe('idle');
});

test('falls back to device speech when the natural voice fails', async () => {
  const prepare = jest.fn(() => Promise.reject(new Error('503')));
  const { narration, spoken, states } = setup({ prepare });
  narration.read();
  await flush();
  expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
  expect(states.at(-1)).toBe('playing');
  spoken[0].done();
  expect(states.at(-1)).toBe('idle');
});

test('falls back to device speech when playback never starts', async () => {
  const { narration, spoken } = setup();
  narration.read();
  await flush();
  jest.advanceTimersByTime(12000);
  expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
});

test('speaks directly when natural narration is off', () => {
  const { narration, deps, spoken } = setup({ enabled: false });
  narration.read();
  expect(deps.prepare).not.toHaveBeenCalled();
  expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
});

test('asks for another tap when the browser blocks autoplay', async () => {
  const { narration, deps, states } = setup();
  deps.player.mockImplementationOnce((_path: string, event: (event: PlayerEvent) => void) => ({
    play: jest.fn(() =>
      Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })),
    ),
    stop: jest.fn(),
    dispose: jest.fn(),
    emit: event,
  }));
  narration.read();
  await flush();
  await flush();
  expect(states.at(-1)).toBe('blocked');
});

test('a late answer for an old step never speaks after moving on', async () => {
  let resolve!: (path: string) => void;
  const prepare = jest.fn(() => new Promise<string>((r) => (resolve = r)));
  const { narration, deps, spoken, players } = setup({ prepare });
  narration.read();
  narration.select(1);
  // The neighbouring step stays cached for Previous, but must not start playing.
  resolve('/narration/0');
  await flush();
  jest.advanceTimersByTime(20000);
  expect(deps.player).toHaveBeenCalledTimes(1);
  expect(players.get('/narration/0')!.play).not.toHaveBeenCalled();
  expect(spoken).toEqual([]);
});

test('dispose releases every player and silences late events', async () => {
  const { narration, players, states } = setup();
  narration.read();
  await flush();
  const first = players.get('/narration/0')!;
  narration.dispose();
  expect(first.dispose).toHaveBeenCalled();
  const count = states.length;
  first.emit('playing');
  expect(states.length).toBe(count);
});

describe('the device’s copies of the cloud narration', () => {
  test('a step heard from the cloud is kept on the device, once', async () => {
    const { narration, deps, players } = setup({ copies: {} });
    narration.read();
    await flush();
    expect(deps.keep).not.toHaveBeenCalled();
    // Native players report playing with every status update.
    for (let n = 0; n < 3; n++) players.get('/narration/0')!.emit('playing');
    expect(deps.keep).toHaveBeenCalledTimes(1);
    expect(deps.keep).toHaveBeenCalledWith(0, 'Boil water.', '/narration/0');
    expect(deps.kept).not.toHaveBeenCalled();
  });

  test('offline, a step plays from its copy, and the next step is ready from its own', async () => {
    const { narration, deps, states, players, spoken } = setup({
      prepare: jest.fn(offline),
      copies: { 0: '/narration/0', 1: '/narration/1' },
    });
    narration.read();
    await flush();
    expect(deps.kept).toHaveBeenCalledWith(0, 'Boil water.');
    const first = players.get('file:///copies/0.mp3')!;
    expect(first.play).toHaveBeenCalled();
    first.emit('playing');
    expect(states.at(-1)).toBe('playing');
    await flush();
    // Preloaded from its copy, as the cloud's would be.
    expect(deps.prepare).toHaveBeenCalledWith(1, 'Add pasta.');
    const second = players.get('file:///copies/1.mp3')!;
    expect(second.play).not.toHaveBeenCalled();
    narration.select(1);
    expect(first.stop).toHaveBeenCalled();
    narration.read();
    // At once, within the tap.
    expect(second.play).toHaveBeenCalled();
    second.emit('ended');
    expect(states.at(-1)).toBe('idle');
    expect(spoken).toEqual([]);
    // Copies aren't kept again.
    expect(deps.keep).not.toHaveBeenCalled();
  });

  test('offline, a step without a copy is read by device speech', async () => {
    const { narration, deps, spoken, players } = setup({ prepare: jest.fn(offline), copies: {} });
    narration.read();
    await flush();
    expect(deps.kept).toHaveBeenCalledTimes(1);
    expect(players.size).toBe(0);
    expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
    // Read again, without asking the device twice.
    narration.read();
    await flush();
    expect(deps.kept).toHaveBeenCalledTimes(1);
    expect(spoken.map((s) => s.text)).toEqual(['Boil water.', 'Boil water.']);
  });

  test('a step the API turns down is read by device speech, never from a copy', async () => {
    const prepare = jest.fn(() => Promise.reject(new Error('This recipe has changed.')));
    const { narration, deps, spoken } = setup({ prepare, copies: { 0: '/narration/0' } });
    narration.read();
    await flush();
    expect(deps.kept).not.toHaveBeenCalled();
    expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
  });

  test('when the cloud’s audio fails, the copy of that recording plays instead', async () => {
    const { narration, deps, states, players, spoken } = setup({
      copies: { 0: '/narration/0' },
    });
    narration.read();
    await flush();
    const cloud = players.get('/narration/0')!;
    cloud.emit('error');
    expect(states.at(-1)).toBe('loading');
    await flush();
    expect(deps.kept).toHaveBeenCalledWith(0, 'Boil water.', '/narration/0');
    const copy = players.get('file:///copies/0.mp3')!;
    expect(copy.play).toHaveBeenCalled();
    copy.emit('playing');
    expect(states.at(-1)).toBe('playing');
    expect(spoken).toEqual([]);
    // The cloud's player is let go, and its late events change nothing.
    jest.advanceTimersByTime(0);
    expect(cloud.dispose).toHaveBeenCalled();
    cloud.emit('playing');
    expect(deps.keep).not.toHaveBeenCalled();
    // Read again, the copy plays again.
    narration.stop();
    narration.read();
    expect(copy.play).toHaveBeenCalledTimes(2);
  });

  test('a copy of another recording never stands in once the API has named the step’s', async () => {
    const { narration, players, spoken } = setup({ copies: { 0: '/narration/older-voice' } });
    narration.read();
    await flush();
    players.get('/narration/0')!.emit('error');
    await flush();
    expect(players.has('file:///copies/0.mp3')).toBe(false);
    expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
  });

  test('a cloud that never answers gives way to the copy, and its late answer plays nothing', async () => {
    let answer!: (path: string) => void;
    const prepare = jest.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    const { narration, deps, players, spoken } = setup({
      prepare,
      copies: { 0: '/narration/0' },
    });
    narration.read();
    await flush();
    jest.advanceTimersByTime(12000);
    await flush();
    expect(deps.kept).toHaveBeenCalledWith(0, 'Boil water.', undefined);
    expect(players.get('file:///copies/0.mp3')!.play).toHaveBeenCalled();
    answer('/narration/0');
    await flush();
    expect(players.has('/narration/0')).toBe(false);
    expect(spoken).toEqual([]);
  });

  test('without a copy, a cloud recording that was slow to start stays for the next tap', async () => {
    const { narration, deps, players, spoken } = setup({ copies: {} });
    narration.read();
    await flush();
    const cloud = players.get('/narration/0')!;
    jest.advanceTimersByTime(12000);
    await flush();
    expect(deps.kept).toHaveBeenCalledWith(0, 'Boil water.', '/narration/0');
    expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
    jest.advanceTimersByTime(0);
    expect(cloud.dispose).not.toHaveBeenCalled();
    // Tapped again, the cloud's recording plays, as it did before copies were kept.
    narration.read();
    expect(cloud.play).toHaveBeenCalledTimes(2);
    expect(deps.prepare).toHaveBeenCalledTimes(1);
  });

  test('a copy that fails as well falls back to device speech, once', async () => {
    const { narration, players, spoken } = setup({
      prepare: jest.fn(offline),
      copies: { 0: '/narration/0' },
    });
    narration.read();
    await flush();
    const copy = players.get('file:///copies/0.mp3')!;
    copy.emit('error');
    copy.emit('error');
    expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
  });

  test('a copy that never starts falls back to device speech', async () => {
    const { narration, players, spoken } = setup({
      prepare: jest.fn(offline),
      copies: { 0: '/narration/0' },
    });
    narration.read();
    await flush();
    expect(players.get('file:///copies/0.mp3')!.play).toHaveBeenCalled();
    jest.advanceTimersByTime(12000);
    expect(spoken.map((s) => s.text)).toEqual(['Boil water.']);
  });

  test('moving on while the device is asked plays nothing late', async () => {
    const { narration, players, spoken } = setup({
      prepare: jest.fn(offline),
      copies: { 0: '/narration/0' },
    });
    narration.read();
    narration.select(1);
    await flush();
    expect(players.get('file:///copies/0.mp3')?.play).not.toHaveBeenCalled();
    narration.dispose();
    await flush();
    jest.advanceTimersByTime(20000);
    expect(spoken).toEqual([]);
  });
});
