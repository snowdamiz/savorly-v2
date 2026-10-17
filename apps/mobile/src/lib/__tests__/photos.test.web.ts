/// <reference types="jest" />
import { API_URL } from '../api';
import { uploadMedia } from '../photos';

// The browser's XMLHttpRequest, with each test playing storage's part.
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
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  open(_method: string, url: string) {
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
    this.onabort?.();
  }
}

const photo = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });
const calls: { path: string; init?: RequestInit }[] = [];
let routes: Record<string, { status: number; body: unknown }> = {};
const fetchMock = jest.fn((url: string, init?: RequestInit) => {
  // The picked or prepared photo, as a blob: address.
  if (url.startsWith('blob:')) return Promise.resolve({ blob: () => Promise.resolve(photo) });
  const path = url.replace(`${API_URL}/v1`, '');
  calls.push({ path, init });
  const { status, body } = routes[path] ?? { status: 404, body: { error: 'Not found.' } };
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
});
const presigned = {
  uploadUrl: 'https://storage.test/savorly-media/uploads/cook/p.jpg?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public,max-age=31536000,immutable' },
  url: 'https://media.test/uploads/cook/p.jpg',
  key: 'uploads/cook/p.jpg',
};

beforeEach(() => {
  FakeXHR.sent = [];
  calls.length = 0;
  routes = {};
  global.fetch = fetchMock as unknown as typeof fetch;
  global.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
});

test('a browser sends the photo’s blob, signed for its exact size and type', async () => {
  routes = {
    '/media/uploads': { status: 200, body: presigned },
    '/media/uploads/complete': { status: 200, body: { url: presigned.url } },
  };
  FakeXHR.answer = (xhr) => {
    xhr.upload.onprogress?.({ loaded: 2048, total: 2048 });
    xhr.status = 200;
    xhr.onload?.();
  };
  await expect(uploadMedia('blob:http://localhost/photo', 'image')).resolves.toBe(presigned.url);
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    kind: 'image',
    contentType: 'image/jpeg',
    size: 2048,
  });
  expect(FakeXHR.sent[0].body).toBe(photo);
  expect(FakeXHR.sent[0].headers).toEqual(presigned.headers);
});

test('a bucket without CORS for this site still takes uploads, through the API', async () => {
  routes = {
    '/media/uploads': { status: 200, body: presigned },
    '/media': { status: 201, body: { url: 'https://media.test/cook/p.jpg' } },
  };
  // The browser refuses the preflight: an error before a single byte is sent.
  FakeXHR.answer = (xhr) => xhr.onerror?.();
  await expect(uploadMedia('blob:http://localhost/photo', 'image')).resolves.toBe(
    'https://media.test/cook/p.jpg',
  );
  const form = calls.find((call) => call.path === '/media')?.init?.body as FormData;
  expect(form).toBeInstanceOf(FormData);
  expect((form.get('file') as File).size).toBe(2048);
});
