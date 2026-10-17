/// <reference types="jest" />
import { HandsFreeListener, type ListenerStatus } from '../listener';
import type { Recognition, RecognitionOptions } from '../recognition';

function setup(permission: 'granted' | 'denied' | 'blocked' = 'granted', supported = true) {
  const sessions: RecognitionOptions[] = [];
  let clock = 0;
  const recognition: jest.Mocked<Recognition> = {
    supported: jest.fn(() => supported),
    place: jest.fn(async (_language: string) => 'device' as const),
    permission: jest.fn(async () => permission),
    start: jest.fn(async (options: RecognitionOptions) => {
      sessions.push(options);
      return 'device' as const;
    }),
    abort: jest.fn(),
  };
  const statuses: ListenerStatus[] = [];
  const heard: string[] = [];
  const places: string[] = [];
  const listener = new HandsFreeListener({
    recognition,
    language: 'en-US',
    hints: ['next step'],
    onStatus: (status) => statuses.push(status),
    onUtterance: (text) => heard.push(text),
    onPlace: (place) => places.push(place),
    now: () => clock,
  });
  const latest = () => sessions[sessions.length - 1];
  // Lets `ms` pass on the clock the listener reads and on its timers.
  const pass = async (ms: number) => {
    clock += ms;
    await jest.advanceTimersByTimeAsync(ms);
  };
  return { listener, recognition, sessions, statuses, heard, places, latest, pass };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('listens after permission, hears final results only, and starts the next session when one ends', async () => {
  const { listener, recognition, sessions, statuses, heard, places, latest, pass } = setup();
  await listener.enable();
  expect(recognition.permission).toHaveBeenCalledTimes(1);
  expect(sessions).toHaveLength(1);
  expect(latest()).toMatchObject({ language: 'en-US', hints: ['next step'] });
  await pass(0);
  expect(statuses).toEqual(['starting', 'listening']);
  expect(places).toEqual(['device']);
  latest().onResult('next', false);
  latest().onResult('next step', true);
  expect(heard).toEqual(['next step']);
  // A long session ends (a browser's minute): the next starts a moment later.
  await pass(30_000);
  latest().onEnd();
  expect(sessions).toHaveLength(1);
  await pass(250);
  expect(sessions).toHaveLength(2);
  expect(listener.status).toBe('listening');
});

test('sessions that keep ending at once back off, and hearing something resets that', async () => {
  const { listener, sessions, latest, pass } = setup();
  await listener.enable();
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    const before = sessions.length;
    latest().onEnd();
    let waited = 0;
    while (sessions.length === before) {
      await pass(50);
      waited += 50;
    }
    waits.push(waited);
  }
  expect(waits).toEqual([500, 1000, 2000, 4000, 8000]);
  latest().onResult('hello', true);
  latest().onEnd();
  await pass(250);
  expect(sessions).toHaveLength(7);
});

test('holds pause listening until every reason is released, ignoring the stopped session', async () => {
  const { listener, recognition, sessions, statuses, heard, latest, pass } = setup();
  await listener.enable();
  const first = latest();
  listener.hold('speaking', true);
  expect(recognition.abort).toHaveBeenCalledTimes(1);
  expect(listener.status).toBe('paused');
  listener.hold('narration', true);
  listener.hold('speaking', false);
  await pass(5000);
  expect(sessions).toHaveLength(1);
  expect(listener.status).toBe('paused');
  // The stopped session's late events change nothing.
  first.onResult('next step', true);
  first.onEnd();
  expect(heard).toEqual([]);
  listener.hold('narration', false);
  expect(listener.status).toBe('starting');
  await pass(399);
  expect(sessions).toHaveLength(1);
  await pass(1);
  expect(sessions).toHaveLength(2);
  expect(statuses.slice(-3)).toEqual(['paused', 'starting', 'listening']);
});

test('a hold during the permission prompt keeps the first session until it is released', async () => {
  const { listener, sessions, pass } = setup();
  const enabling = listener.enable();
  listener.hold('call', true);
  await enabling;
  expect(sessions).toHaveLength(0);
  expect(listener.status).toBe('paused');
  listener.hold('call', false);
  await pass(400);
  expect(sessions).toHaveLength(1);
});

test.each([
  ['denied', 'denied'],
  ['blocked', 'blocked'],
] as const)('a %s permission stops before listening', async (permission, status) => {
  const { listener, sessions } = setup(permission);
  await listener.enable();
  expect(sessions).toHaveLength(0);
  expect(listener.status).toBe(status);
});

test('a device without recognition says so without asking for the microphone', async () => {
  const { listener, recognition } = setup('granted', false);
  await listener.enable();
  expect(recognition.permission).not.toHaveBeenCalled();
  expect(listener.status).toBe('unsupported');
});

test.each([
  ['denied', 'denied'],
  ['unavailable', 'unsupported'],
  ['language', 'language'],
  ['microphone', 'microphone'],
] as const)('a %s error stops listening', async (error, status) => {
  const { listener, recognition, sessions, latest, pass } = setup();
  await listener.enable();
  latest().onError(error);
  latest().onEnd();
  await pass(20_000);
  expect(listener.status).toBe(status);
  expect(sessions).toHaveLength(1);
  expect(recognition.abort).toHaveBeenCalled();
});

test('silence is normal, and transient failures retry more slowly until they give up', async () => {
  const { listener, sessions, latest, pass } = setup();
  await listener.enable();
  latest().onError('quiet');
  latest().onEnd();
  await pass(500);
  expect(sessions).toHaveLength(2);
  const waits: number[] = [];
  for (let i = 0; i < 4; i++) {
    await pass(2000);
    const before = sessions.length;
    latest().onError('transient');
    latest().onEnd();
    let waited = 0;
    while (sessions.length === before) {
      await pass(100);
      waited += 100;
    }
    waits.push(waited);
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000]);
  latest().onError('transient');
  expect(listener.status).toBe('failed');
});

test('a session that fails to start counts as a failure and is retried', async () => {
  const { listener, recognition, sessions, pass } = setup();
  recognition.start.mockRejectedValueOnce(new Error('busy'));
  await listener.enable();
  await pass(0);
  expect(sessions).toHaveLength(0);
  await pass(1000);
  expect(sessions).toHaveLength(1);
  expect(listener.status).toBe('listening');
});

test('turning it off stops the session and nothing restarts it', async () => {
  const { listener, recognition, sessions, latest, statuses, pass } = setup();
  await listener.enable();
  const session = latest();
  listener.disable();
  expect(recognition.abort).toHaveBeenCalledTimes(1);
  session.onEnd();
  listener.hold('speaking', true);
  listener.hold('speaking', false);
  await pass(10_000);
  expect(sessions).toHaveLength(1);
  expect(statuses[statuses.length - 1]).toBe('off');
});

test('a new language restarts the session in it', async () => {
  const { listener, sessions, latest, pass } = setup();
  await listener.enable();
  listener.setLanguage('en-US', ['next step']);
  await pass(1000);
  expect(sessions).toHaveLength(1);
  listener.setLanguage('fr-FR', ['étape suivante']);
  await pass(400);
  expect(sessions).toHaveLength(2);
  expect(latest()).toMatchObject({ language: 'fr-FR', hints: ['étape suivante'] });
});
