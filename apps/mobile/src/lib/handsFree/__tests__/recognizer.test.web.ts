/// <reference types="jest" />
import { recognition } from '../recognizer';

type Fake = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: jest.Mock;
  abort: jest.Mock;
};

// The Web Speech API as Chrome has it: webkitSpeechRecognition, and on newer versions
// recognition on the device for languages that are installed.
function install(local?: string[]) {
  const sessions: Fake[] = [];
  class FakeRecognition {
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: Fake['onresult'] = null;
    onerror: Fake['onerror'] = null;
    onend: Fake['onend'] = null;
    start = jest.fn();
    abort = jest.fn(() => this.onend?.());
    constructor() {
      sessions.push(this as unknown as Fake);
    }
    static available = local
      ? async ({ langs }: { langs: string[] }) =>
          local.includes(langs[0]) ? 'available' : 'downloadable'
      : undefined;
  }
  if (local)
    Object.defineProperty(FakeRecognition.prototype, 'processLocally', {
      value: false,
      writable: true,
    });
  Object.assign(window, { webkitSpeechRecognition: FakeRecognition });
  return sessions;
}

const session = () => ({
  language: 'en-US',
  hints: [],
  onResult: jest.fn(),
  onError: jest.fn(),
  onEnd: jest.fn(),
});

afterEach(() => {
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

test('a browser without the Web Speech API has no recognition', () => {
  expect(recognition.supported()).toBe(false);
});

test('a session listens continuously and passes on final and interim results', async () => {
  const sessions = install();
  expect(recognition.supported()).toBe(true);
  const options = session();
  expect(await recognition.start(options)).toBe('service');
  const [s] = sessions;
  expect(s).toMatchObject({ lang: 'en-US', continuous: true, interimResults: true });
  expect(s.start).toHaveBeenCalled();
  s.onresult?.({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'next step' }], { isFinal: true }),
      Object.assign([{ transcript: 'and' }], { isFinal: false }),
    ],
  });
  expect(options.onResult.mock.calls).toEqual([
    ['next step', true],
    ['and', false],
  ]);
  s.onerror?.({ error: 'network' });
  expect(options.onError).toHaveBeenCalledWith('transient');
  s.onend?.();
  expect(options.onEnd).toHaveBeenCalledTimes(1);
});

test('the browser recognizes on the device when it has the language', async () => {
  const sessions = install(['fr-FR']);
  expect(await recognition.place('fr-FR')).toBe('device');
  expect(await recognition.place('ja-JP')).toBe('service');
  expect(await recognition.start({ ...session(), language: 'fr-FR' })).toBe('device');
  expect(sessions[0].processLocally).toBe(true);
});

test('stopping aborts the running session', async () => {
  const sessions = install();
  await recognition.start(session());
  recognition.abort();
  expect(sessions[0].abort).toHaveBeenCalled();
});
