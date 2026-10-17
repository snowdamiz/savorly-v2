/// <reference types="jest" />
import * as SecureStore from 'expo-secure-store';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

type Api = typeof import('../api');
// The token lives in module state, so every test starts from a fresh module.
function load(): Api {
  let api!: Api;
  jest.isolateModules(() => {
    api = require('../api');
  });
  return api;
}
const reply = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  });
const fetchMock = jest.fn();

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});
afterEach(() => jest.useRealTimers());

test('restores the bearer token from secure storage at launch', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue('stored-token');
  const api = load();
  expect(api.sessionHeaders()).toEqual({});
  await api.initSession();
  expect(SecureStore.getItemAsync).toHaveBeenCalledWith('savorly.session');
  expect(api.sessionHeaders()).toEqual({ Authorization: 'Bearer stored-token' });
});

test('persists a new token and forgets it on sign-out', async () => {
  const api = load();
  await api.persistSession('fresh-token');
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith('savorly.session', 'fresh-token');
  expect(api.sessionHeaders()).toEqual({ Authorization: 'Bearer fresh-token' });
  await api.persistSession(null);
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('savorly.session');
  expect(api.sessionHeaders()).toEqual({});
});

test('sends JSON with the bearer token', async () => {
  const api = load();
  await api.persistSession('fresh-token');
  fetchMock.mockReturnValue(reply(200, { id: 'r1' }));
  await expect(api.api('/recipes', { method: 'POST', body: { title: 'Soup' } })).resolves.toEqual({
    id: 'r1',
  });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`${api.API_URL}/v1/recipes`);
  expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ title: 'Soup' }) });
  expect(init.headers).toMatchObject({
    'Content-Type': 'application/json',
    Authorization: 'Bearer fresh-token',
  });
});

test('leaves the content type to fetch for uploads', async () => {
  const api = load();
  fetchMock.mockReturnValue(reply(200, { url: 'https://media.test/a.jpg' }));
  const form = new FormData();
  await api.api('/media', { method: 'POST', body: form });
  const [, init] = fetchMock.mock.calls[0];
  expect(init.body).toBe(form);
  expect(init.headers['Content-Type']).toBeUndefined();
});

test('surfaces the server message as an ApiError', async () => {
  const api = load();
  fetchMock.mockReturnValue(reply(409, { error: 'That username is taken.' }));
  const failure = api.api('/me', { method: 'PATCH', body: {} });
  await expect(failure).rejects.toBeInstanceOf(api.ApiError);
  await expect(failure).rejects.toMatchObject({ status: 409, message: 'That username is taken.' });
});

test('answers 204 with undefined', async () => {
  const api = load();
  fetchMock.mockReturnValue(reply(204, undefined));
  await expect(api.api('/recipes/r1', { method: 'DELETE' })).resolves.toBeUndefined();
});

test('retries a write only when the server never handled it', async () => {
  jest.useFakeTimers();
  const api = load();
  fetchMock
    .mockReturnValueOnce(reply(503, { error: 'Savorly is starting up.', starting: true }))
    .mockReturnValueOnce(reply(200, { ok: true }));
  const sent = api.api('/recipes', { method: 'POST', body: {} });
  await jest.advanceTimersByTimeAsync(1000);
  await expect(sent).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  fetchMock.mockReset();
  fetchMock.mockReturnValue(reply(503, { error: 'Savorly is restarting.' }));
  await expect(api.api('/recipes', { method: 'POST', body: {} })).rejects.toMatchObject({
    status: 503,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('retries reads through gateway errors', async () => {
  jest.useFakeTimers();
  const api = load();
  fetchMock
    .mockReturnValueOnce(reply(502, { error: 'Bad gateway' }))
    .mockReturnValueOnce(reply(200, []));
  const read = api.api('/recipes');
  await jest.advanceTimersByTimeAsync(1000);
  await expect(read).resolves.toEqual([]);
});

test('explains a network failure in plain words', async () => {
  const api = load();
  fetchMock.mockRejectedValue(new TypeError('Network request failed'));
  await expect(api.api('/recipes', { method: 'POST', body: {} })).rejects.toThrow(
    'We couldn’t reach your kitchen. Check your connection and try again.',
  );
});

test('rejects a response that is not JSON', async () => {
  const api = load();
  fetchMock.mockReturnValue(
    Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('<html>') }),
  );
  await expect(api.api('/recipes')).rejects.toThrow('The server returned an unexpected response.');
});

test('a signal stops the request with an AbortError, not a network error', async () => {
  const api = load();
  // fetch rejects once its own signal fires, as real fetch does.
  fetchMock.mockImplementation(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        ),
      ),
  );
  const controller = new AbortController();
  const upload = api.api('/media', { method: 'POST', body: {}, signal: controller.signal });
  controller.abort();
  await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
  await expect(upload).rejects.not.toBeInstanceOf(api.NetworkError);
});

test('a signal that has already fired sends nothing', async () => {
  const api = load();
  const controller = new AbortController();
  controller.abort();
  await expect(api.api('/recipes', { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a signal stops the wait before a retry', async () => {
  jest.useFakeTimers();
  const api = load();
  fetchMock.mockReturnValue(reply(503, { error: 'Savorly is starting up.', starting: true }));
  const controller = new AbortController();
  const sent = api.api('/recipes', { method: 'POST', body: {}, signal: controller.signal });
  const outcome = expect(sent).rejects.toMatchObject({ name: 'AbortError' });
  await jest.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  controller.abort();
  await outcome;
  await jest.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
