/// <reference types="jest" />
import { File } from 'expo-file-system';
import { API_URL } from '../api';
import { MEDIA_LIMIT, UPLOAD_STALL, uploadMedia } from '../photos';

jest.mock('expo-file-system', () => ({ File: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// A stand-in for React Native's XMLHttpRequest that lets each test play storage's part.
class FakeXHR {
  static sent: FakeXHR[] = [];
  static answer: (xhr: FakeXHR) => void = () => {};
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  aborted = false;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.sent.push(this);
    FakeXHR.answer(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total });
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
}

type Reply = { status: number; body?: unknown };
const reply = ({ status, body }: Reply) =>
  Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  });
const routes = new Map<string, Reply>();
const calls: { path: string; init: RequestInit }[] = [];
const fetchMock = jest.fn((url: string, init: RequestInit) => {
  const path = url.replace(`${API_URL}/v1`, '');
  calls.push({ path, init });
  return reply(routes.get(path) ?? { status: 404, body: { error: 'Not found.' } });
});
const presigned = {
  uploadUrl: 'https://storage.test/savorly-media/uploads/cook/a.mp4?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'public,max-age=31536000,immutable' },
  url: 'https://media.test/uploads/cook/a.mp4',
  key: 'uploads/cook/a.mp4',
  expiresAt: '2026-10-16T12:15:00Z',
};
const video = {
  uri: 'file:///cache/ImagePicker/clip.mp4',
  fileName: 'clip.mp4',
  fileSize: 3_000_000,
  mimeType: 'video/mp4',
};
const bodyOf = (path: string) =>
  JSON.parse(String(calls.find((call) => call.path === path)?.init.body));

beforeEach(() => {
  FakeXHR.sent = [];
  FakeXHR.answer = () => {};
  routes.clear();
  calls.length = 0;
  global.fetch = fetchMock as unknown as typeof fetch;
  global.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  jest
    .mocked(File)
    .mockImplementation(((uri: string) => ({ uri, size: 3_000_000, type: 'video/mp4' })) as never);
});
afterEach(() => jest.useRealTimers());

test('sends the file straight to storage with the signed headers, reporting progress', async () => {
  routes.set('/media/uploads', { status: 200, body: presigned });
  routes.set('/media/uploads/complete', { status: 200, body: { url: presigned.url } });
  FakeXHR.answer = (xhr) => {
    xhr.progress(1_000_000, 3_000_000);
    xhr.progress(3_000_000, 3_000_000);
    xhr.finish(200);
  };
  const progress: number[] = [];
  await expect(
    uploadMedia(video, 'video', { onProgress: (fraction) => progress.push(fraction) }),
  ).resolves.toBe(presigned.url);
  expect(bodyOf('/media/uploads')).toEqual({
    kind: 'video',
    contentType: 'video/mp4',
    size: 3_000_000,
  });
  const [put] = FakeXHR.sent;
  expect(put.method).toBe('PUT');
  expect(put.url).toBe(presigned.uploadUrl);
  expect(put.headers).toEqual(presigned.headers);
  // React Native reads the file itself, so a large video never passes through JavaScript.
  expect(put.body).toEqual({ uri: video.uri });
  expect(bodyOf('/media/uploads/complete')).toEqual({ key: presigned.key });
  expect(progress[0]).toBe(0);
  expect(progress[1]).toBeCloseTo(1 / 3);
  expect(progress.slice(2)).toEqual([0.99, 1]);
  expect(calls.some((call) => call.path === '/media')).toBe(false);
});

test('takes the size and type of the file on disk for a prepared photo', async () => {
  jest
    .mocked(File)
    .mockImplementation(((uri: string) => ({ uri, size: 420_000, type: '' })) as never);
  routes.set('/media/uploads', {
    status: 200,
    body: { ...presigned, headers: { 'Content-Type': 'image/jpeg' } },
  });
  routes.set('/media/uploads/complete', { status: 200, body: { url: 'https://media.test/p.jpg' } });
  FakeXHR.answer = (xhr) => xhr.finish(200);
  await expect(uploadMedia({ uri: 'file:///cache/ImageManipulator/p.jpg' }, 'image')).resolves.toBe(
    'https://media.test/p.jpg',
  );
  expect(bodyOf('/media/uploads')).toEqual({
    kind: 'image',
    contentType: 'image/jpeg',
    size: 420_000,
  });
});

test('servers without direct uploads get the multipart upload', async () => {
  routes.set('/media', { status: 201, body: { url: 'https://media.test/classic.mp4' } });
  const progress: number[] = [];
  await expect(
    uploadMedia(video, 'video', { onProgress: (fraction) => progress.push(fraction) }),
  ).resolves.toBe('https://media.test/classic.mp4');
  expect(calls.map((call) => call.path)).toEqual(['/media/uploads', '/media']);
  expect(calls[1].init.body).toBeInstanceOf(FormData);
  expect(FakeXHR.sent).toHaveLength(0);
  expect(progress).toEqual([0, 1]);
});

test('storage that isn’t set up for direct uploads falls back too', async () => {
  routes.set('/media/uploads', {
    status: 503,
    body: { error: 'Media storage has not been configured.' },
  });
  routes.set('/media', { status: 201, body: { url: 'https://media.test/classic.mp4' } });
  await expect(uploadMedia(video, 'video')).resolves.toBe('https://media.test/classic.mp4');
  expect(FakeXHR.sent).toHaveLength(0);
});

test('a PUT that can’t reach storage at all (no CORS, no route) goes through the API', async () => {
  routes.set('/media/uploads', { status: 200, body: presigned });
  routes.set('/media', { status: 201, body: { url: 'https://media.test/classic.mp4' } });
  FakeXHR.answer = (xhr) => xhr.onerror?.();
  await expect(uploadMedia(video, 'video')).resolves.toBe('https://media.test/classic.mp4');
  expect(FakeXHR.sent).toHaveLength(1);
  expect(calls.map((call) => call.path)).toEqual(['/media/uploads', '/media']);
});

test('a connection lost halfway is reported, not sent a second time', async () => {
  routes.set('/media/uploads', { status: 200, body: presigned });
  FakeXHR.answer = (xhr) => {
    xhr.progress(1_000_000, 3_000_000);
    xhr.onerror?.();
  };
  await expect(uploadMedia(video, 'video')).rejects.toThrow(
    'The upload stopped. Check your connection and try again.',
  );
  expect(calls.some((call) => call.path === '/media')).toBe(false);
});

test('when only the answer was lost, the upload is confirmed anyway', async () => {
  routes.set('/media/uploads', { status: 200, body: presigned });
  routes.set('/media/uploads/complete', { status: 200, body: { url: presigned.url } });
  FakeXHR.answer = (xhr) => {
    xhr.progress(3_000_000, 3_000_000);
    xhr.onerror?.();
  };
  await expect(uploadMedia(video, 'video')).resolves.toBe(presigned.url);
});

test('storage refusing the file is an error, with no second upload', async () => {
  routes.set('/media/uploads', { status: 200, body: presigned });
  FakeXHR.answer = (xhr) => xhr.finish(403);
  await expect(uploadMedia(video, 'video')).rejects.toThrow(
    'The upload didn’t finish. Please try again.',
  );
  expect(calls.map((call) => call.path)).toEqual(['/media/uploads']);
});

test('an upload that stalls gives up after a minute without progress', async () => {
  jest.useFakeTimers();
  routes.set('/media/uploads', { status: 200, body: presigned });
  FakeXHR.answer = (xhr) => xhr.progress(500_000, 3_000_000);
  const upload = uploadMedia(video, 'video');
  const failed = expect(upload).rejects.toThrow('The upload stopped.');
  await jest.advanceTimersByTimeAsync(UPLOAD_STALL + 10);
  await failed;
  expect(FakeXHR.sent[0].aborted).toBe(true);
});

test('cancelling stops the transfer', async () => {
  routes.set('/media/uploads', { status: 200, body: presigned });
  const controller = new AbortController();
  FakeXHR.answer = (xhr) => {
    xhr.progress(1_000_000, 3_000_000);
    controller.abort();
  };
  await expect(uploadMedia(video, 'video', { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(FakeXHR.sent[0].aborted).toBe(true);
  expect(calls.map((call) => call.path)).toEqual(['/media/uploads']);
});

test('cancelling an upload that goes through the API stops its request', async () => {
  // The server can't sign it (404), so the file goes to POST /media, which takes its time.
  let posted: RequestInit | undefined;
  fetchMock
    .mockImplementationOnce(() => reply({ status: 404, body: { error: 'Not found.' } }))
    .mockImplementationOnce((_url: string, init: RequestInit) => {
      posted = init;
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        ),
      ) as ReturnType<typeof reply>;
    });
  const controller = new AbortController();
  const upload = uploadMedia(video, 'video', { signal: controller.signal });
  while (!posted) await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
  expect(posted.signal?.aborted).toBe(true);
});

test('files over 50 MB are refused before anything is sent', async () => {
  await expect(uploadMedia({ ...video, fileSize: MEDIA_LIMIT + 1 }, 'video')).rejects.toThrow(
    'Choose a file smaller than 50 MB.',
  );
  jest
    .mocked(File)
    .mockImplementation(((uri: string) => ({ uri, size: MEDIA_LIMIT + 1, type: '' })) as never);
  await expect(uploadMedia({ uri: video.uri }, 'video')).rejects.toThrow(
    'Choose a file smaller than 50 MB.',
  );
  expect(calls).toHaveLength(0);
  expect(FakeXHR.sent).toHaveLength(0);
});

test('a format storage won’t sign goes to the API, which reads the bytes', async () => {
  jest.mocked(File).mockImplementation(((uri: string) => ({
    uri,
    size: 2_000,
    type: 'video/quicktime',
  })) as never);
  routes.set('/media', { status: 201, body: { url: 'https://media.test/clip.mp4' } });
  await expect(uploadMedia({ uri: 'file:///cache/clip.mov' }, 'video')).resolves.toBe(
    'https://media.test/clip.mp4',
  );
  expect(calls.map((call) => call.path)).toEqual(['/media']);
});

test('an answer without an upload address falls back to the API', async () => {
  routes.set('/media/uploads', { status: 200, body: [] });
  routes.set('/media', { status: 201, body: { url: 'https://media.test/classic.mp4' } });
  await expect(uploadMedia(video, 'video')).resolves.toBe('https://media.test/classic.mp4');
  expect(FakeXHR.sent).toHaveLength(0);
});
