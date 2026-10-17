/// <reference types="jest" />
import { API_URL } from '../../api';
import { audioSource, clearAudio, removeAudio, saveAudio } from '../audioStore';

// jsdom has no fetch, Response, Cache Storage or object URLs: stand-ins for each.
class FakeResponse {
  constructor(
    private body: Blob,
    public init?: ResponseInit,
  ) {}
  async blob() {
    return this.body;
  }
}
/** Cache Storage: the caches by name, each a map of addresses to responses. */
const stored = new Map<string, Map<string, FakeResponse>>();
const caches = {
  open: jest.fn(async (name: string) => {
    const entries = stored.get(name) ?? new Map<string, FakeResponse>();
    stored.set(name, entries);
    return {
      put: async (url: string, response: FakeResponse) => void entries.set(url, response),
      match: async (url: string) => entries.get(url),
      delete: async (url: string) => entries.delete(url),
    };
  }),
  delete: jest.fn(async (name: string) => stored.delete(name)),
};
const fetch = jest.fn();
const createObjectURL = jest.fn();
const revokeObjectURL = jest.fn();
const global = globalThis as unknown as Record<string, unknown>;
const recording = () => new Blob(['ID3 a recording'], { type: 'audio/mpeg' });
const path = (key: string) => `/recipes/r1/steps/0/narration/${key}`;
const address = (key: string) => `${API_URL}/v1${path(key)}`;

beforeEach(() => {
  stored.clear();
  Object.assign(global, { caches, fetch, Response: FakeResponse });
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  let made = 0;
  createObjectURL.mockImplementation(() => `blob:http://localhost/${++made}`);
  fetch.mockImplementation(async () => ({ ok: true, status: 200, blob: async () => recording() }));
});
afterEach(async () => {
  await clearAudio();
  for (const name of ['caches', 'fetch', 'Response']) delete global[name];
});

test('a recording is downloaded with the session cookie and kept in Cache Storage', async () => {
  const bytes = await saveAudio('k1', path('k1'));
  expect(fetch).toHaveBeenCalledWith(
    address('k1'),
    expect.objectContaining({ credentials: 'include', headers: {} }),
  );
  expect(bytes).toBe(recording().size);
  const kept = stored.get('savorly-narration')?.get(address('k1'));
  expect(kept?.init?.headers).toEqual({ 'Content-Type': 'audio/mpeg' });
  // It plays from an object URL, made once a visit.
  const source = await audioSource('k1', path('k1'));
  expect(source).toMatch(/^blob:/);
  expect(await audioSource('k1', path('k1'))).toBe(source);
  expect(createObjectURL).toHaveBeenCalledTimes(1);
});

test('a failed download keeps nothing', async () => {
  fetch.mockResolvedValueOnce({ ok: false, status: 502, blob: async () => recording() });
  await expect(saveAudio('k2', path('k2'))).rejects.toThrow('502');
  fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(saveAudio('k2', path('k2'))).rejects.toThrow('Failed to fetch');
  fetch.mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob([]) });
  await expect(saveAudio('k2', path('k2'))).rejects.toThrow('empty');
  expect(stored.get('savorly-narration')?.size).toBe(0);
  expect(await audioSource('k2', path('k2'))).toBeNull();
});

test('one recording goes, or all of them, with their object URLs', async () => {
  await saveAudio('a', path('a'));
  await saveAudio('b', path('b'));
  const a = await audioSource('a', path('a'));
  const b = await audioSource('b', path('b'));
  await removeAudio('a', path('a'));
  expect(revokeObjectURL).toHaveBeenCalledWith(a);
  expect(await audioSource('a', path('a'))).toBeNull();
  expect(await audioSource('b', path('b'))).toBe(b);
  await clearAudio();
  expect(revokeObjectURL).toHaveBeenCalledWith(b);
  expect(caches.delete).toHaveBeenCalledWith('savorly-narration');
  expect(await audioSource('b', path('b'))).toBeNull();
});

test('a browser without Cache Storage keeps nothing, quietly', async () => {
  delete global.caches;
  await expect(saveAudio('k3', path('k3'))).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(audioSource('k3', path('k3'))).rejects.toThrow();
  await expect(clearAudio()).resolves.toBeUndefined();
});
