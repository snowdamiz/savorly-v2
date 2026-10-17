/// <reference types="jest" />
import {
  BATCH_SIZE,
  FLUSH_MS,
  QUEUE_LIMIT,
  type QueuedEvent,
  clip,
  createLimiter,
  describeError,
  enqueue,
  errorKey,
  nextBatch,
} from '../telemetry';

const event = (n: number): QueuedEvent => ({
  name: 'recipe_open',
  props: { recipeId: `r${n}`, from: 'discover' },
  at: new Date(2026, 9, 16, 12, 0, n).toISOString(),
});

describe('the event queue', () => {
  test('keeps order and drops the oldest past its limit', () => {
    let queue: QueuedEvent[] = [];
    for (let n = 0; n < QUEUE_LIMIT + 5; n++) queue = enqueue(queue, event(n));
    expect(queue).toHaveLength(QUEUE_LIMIT);
    expect(queue[0]).toEqual(event(5));
    expect(queue[queue.length - 1]).toEqual(event(QUEUE_LIMIT + 4));
    expect(enqueue([event(1)], event(2), 1)).toEqual([event(2)]);
  });

  test('leaves in batches the API accepts', () => {
    const queue = Array.from({ length: 120 }, (_, n) => event(n));
    const [first, rest] = nextBatch(queue);
    expect(BATCH_SIZE).toBe(50);
    expect(first).toEqual(queue.slice(0, 50));
    const [second, last] = nextBatch(rest);
    expect(second).toEqual(queue.slice(50, 100));
    expect(nextBatch(last)).toEqual([queue.slice(100), []]);
    expect(nextBatch([])).toEqual([[], []]);
  });
});

describe('error reports', () => {
  test('describe whatever was thrown', () => {
    const error = new TypeError('x is undefined');
    expect(describeError(error)).toEqual({ message: 'x is undefined', stack: error.stack });
    expect(describeError(new Error(''))).toMatchObject({ message: 'Error' });
    expect(describeError('plain text')).toEqual({ message: 'plain text' });
    expect(describeError({ message: 'shaped like one', stack: 'at here' })).toEqual({
      message: 'shaped like one',
      stack: 'at here',
    });
    expect(describeError({ code: 42 })).toEqual({ message: '{"code":42}' });
    expect(describeError(undefined)).toEqual({ message: 'undefined' });
    expect(describeError(null)).toEqual({ message: 'null' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular).message).toBe('[object Object]');
  });

  test('the same problem has the same key: its message and where it was thrown', () => {
    const stack =
      'TypeError: boom\n    at Tile (Card.tsx:10:5)\n    at Grid (Card.tsx:40:9)\n    at Shelf (Home.tsx:7:3)';
    // Deeper callers don't make it another problem.
    expect(errorKey('boom', stack)).toBe(errorKey('boom', `${stack}\n    at App (App.tsx:1:1)`));
    expect(errorKey('boom', stack)).not.toBe(errorKey('boom', stack.replace('10:5', '11:5')));
    expect(errorKey('boom', stack)).not.toBe(errorKey('bang', stack));
    expect(errorKey('boom')).toBe(errorKey('boom', ''));
  });

  test('a limit per minute and per launch', () => {
    const allowed = createLimiter({ perMinute: 2, total: 3 });
    expect(allowed(0)).toBe(true);
    expect(allowed(1000)).toBe(true);
    expect(allowed(2000)).toBe(false);
    // A minute after the first, one more fits; then the launch's total is spent.
    expect(allowed(60_000)).toBe(true);
    expect(allowed(200_000)).toBe(false);
  });

  test('long text is cut', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(clip('a'.repeat(20), 10)).toHaveLength(10);
  });
});

describe('sending', () => {
  let fetchMock: jest.Mock;
  let telemetry: typeof import('../telemetry');
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    telemetry = require('../telemetry');
  });
  afterEach(() => jest.useRealTimers());
  const sent = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);

  test('events travel together, about every ten seconds', () => {
    telemetry.track('search', { query: 'lemon', results: 3 });
    telemetry.track('recipe_open', { recipeId: 'r1', from: 'search' });
    expect(fetchMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/v1\/events$/);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'include' });
    const body = sent(0);
    expect(typeof body.session).toBe('string');
    expect(body.events.map((e: QueuedEvent) => e.name)).toEqual(['search', 'recipe_open']);
    expect(body.events[0].props).toEqual({ query: 'lemon', results: 3 });
    expect(new Date(body.events[0].at).toString()).not.toBe('Invalid Date');
    // The same launch keeps its session.
    telemetry.track('cook_start', { recipeId: 'r1' });
    jest.advanceTimersByTime(FLUSH_MS);
    expect(sent(1).session).toBe(body.session);
  });

  test('a full batch leaves at once, and a failure is silent', () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    for (let n = 0; n < BATCH_SIZE; n++) telemetry.track('search', { query: `q${n}`, results: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0).events).toHaveLength(BATCH_SIZE);
    jest.advanceTimersByTime(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('leaving the app sends what waits at once', () => {
    for (let n = 0; n < 49; n++) telemetry.track('share', { recipeId: `r${n}` });
    telemetry.track('import', { method: 'link' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    telemetry.track('share', { recipeId: 'late' });
    telemetry.flushEvents(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).events).toEqual([expect.objectContaining({ name: 'share' })]);
    // Nothing is left for the timer.
    jest.advanceTimersByTime(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('an error is reported once, with what is known about the app', () => {
    const error = new Error('Render failed');
    telemetry.reportError(error, { componentStack: '\n    in Tile\n    in Grid' });
    telemetry.reportError(error);
    // The same error thrown again (same message, same place) is the same problem.
    const again = () => new Error('Render failed again');
    for (let n = 0; n < 3; n++) telemetry.reportError(again());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/v1\/client-errors$/);
    expect(init.method).toBe('POST');
    expect(sent(0)).toMatchObject({
      message: 'Render failed',
      componentStack: '\n    in Tile\n    in Grid',
      platform: expect.stringMatching(/^(ios|android|web)$/),
    });
    expect(sent(0).stack).toContain('Render failed');
    expect(typeof sent(0).appVersion).toBe('string');
    expect(typeof sent(0).release).toBe('string');
  });

  test('a burst of different errors stops at five a minute', () => {
    for (let n = 0; n < 8; n++) telemetry.reportError(new Error(`problem ${n}`));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    jest.setSystemTime(Date.now() + 61_000);
    telemetry.reportError(new Error('problem later'));
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test('reporting never throws, even when sending does', () => {
    fetchMock.mockImplementation(() => {
      throw new Error('fetch exploded');
    });
    expect(() => telemetry.reportError(new Error('one'))).not.toThrow();
    expect(() => telemetry.track('search', { query: 'x', results: 1 })).not.toThrow();
    expect(() => jest.advanceTimersByTime(FLUSH_MS)).not.toThrow();
  });
});
