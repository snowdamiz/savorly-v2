/// <reference types="jest" />
import { Platform } from 'react-native';
import { nativeRecognition } from '../recognizer';

type Listener = (event: never) => void;

// A stand-in for expo-speech-recognition's native module: it records what it was asked and lets the
// test send its events.
function fakeModule(options: { onDevice?: boolean; installed?: string[] } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const module = {
    isRecognitionAvailable: jest.fn(() => true),
    supportsOnDeviceRecognition: jest.fn(() => options.onDevice ?? true),
    getSupportedLocales: jest.fn(async () => ({
      locales: [],
      installedLocales: options.installed ?? [],
    })),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    start: jest.fn(),
    abort: jest.fn(),
    addListener: jest.fn((name: string, listener: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return { remove: () => listeners.get(name)!.delete(listener) };
    }),
  };
  const emit = (name: string, event?: unknown) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(event as never);
  };
  const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { module, emit, count };
}

const session = () => ({
  language: 'fr-FR',
  hints: ['étape suivante'],
  onResult: jest.fn(),
  onError: jest.fn(),
  onEnd: jest.fn(),
});

test('without the native module, recognition is unavailable rather than a crash', async () => {
  const recognition = nativeRecognition(null);
  expect(recognition.supported()).toBe(false);
  expect(await recognition.permission()).toBe('denied');
  await expect(recognition.start(session())).rejects.toThrow();
});

test('a session recognizes on the device when it can, with the app language and hints', async () => {
  const { module, emit } = fakeModule({ installed: ['fr-FR'] });
  const recognition = nativeRecognition(module as never);
  const options = session();
  expect(await recognition.start(options)).toBe('device');
  expect(module.start).toHaveBeenCalledWith(
    expect.objectContaining({
      lang: 'fr-FR',
      interimResults: true,
      requiresOnDeviceRecognition: true,
      contextualStrings: ['étape suivante'],
    }),
  );
  emit('result', { isFinal: false, results: [{ transcript: 'étape' }] });
  emit('result', { isFinal: true, results: [{ transcript: ' étape suivante ' }] });
  expect(options.onResult.mock.calls).toEqual([
    ['étape', false],
    ['étape suivante', true],
  ]);
  emit('error', { error: 'no-speech' });
  emit('error', { error: 'not-allowed' });
  expect(options.onError.mock.calls).toEqual([['quiet'], ['denied']]);
  emit('end');
  expect(options.onEnd).toHaveBeenCalledTimes(1);
});

test('a stopped session hears nothing more, so its last events cannot end the next one', async () => {
  const { module, emit, count } = fakeModule();
  const recognition = nativeRecognition(module as never);
  const first = session();
  await recognition.start(first);
  recognition.abort();
  expect(module.abort).toHaveBeenCalledTimes(1);
  expect(count()).toBe(0);
  emit('end');
  expect(first.onEnd).not.toHaveBeenCalled();
  const second = session();
  await recognition.start(second);
  emit('result', { isFinal: true, results: [{ transcript: 'suivant' }] });
  expect(first.onResult).not.toHaveBeenCalled();
  expect(second.onResult).toHaveBeenCalledWith('suivant', true);
});

test('permission says whether the system will ask again', async () => {
  const { module } = fakeModule();
  const recognition = nativeRecognition(module as never);
  expect(await recognition.permission()).toBe('granted');
  module.requestPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: true });
  expect(await recognition.permission()).toBe('denied');
  module.requestPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });
  expect(await recognition.permission()).toBe('blocked');
});

test('Android uses its speech service unless the language model is on the phone', async () => {
  const { module } = fakeModule({ installed: ['de-DE'] });
  const recognition = nativeRecognition(module as never);
  const expected = Platform.OS === 'android' ? 'service' : 'device';
  expect(await recognition.place('fr-FR')).toBe(expected);
  expect(await recognition.place('de-DE')).toBe('device');
  module.supportsOnDeviceRecognition.mockReturnValue(false);
  expect(await recognition.place('de-DE')).toBe('service');
});
