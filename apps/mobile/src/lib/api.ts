import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8080';
/** Where shared recipe links open: the current site on the web, the build's web app on native. */
export const WEB_URL =
  Platform.OS === 'web' && typeof window !== 'undefined'
    ? window.location.origin
    : process.env.EXPO_PUBLIC_WEB_URL || 'https://savorly.cooking';
let nativeToken: string | null = null;
// Audio requests use bearer auth on native and HttpOnly cookies on web.
export function sessionHeaders(): Record<string, string> {
  return nativeToken ? { Authorization: `Bearer ${nativeToken}` } : {};
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server never handled the request (it was starting up), so resending is safe. */
    public unsent = false,
  ) {
    super(message);
  }
}
/** The request never got an answer: no connection, or it timed out. */
export class NetworkError extends Error {
  name = 'NetworkError';
}
/** What `api()` rejects with once the caller's `signal` stops a request: an error named AbortError. */
const cancelled = () =>
  Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
/** Whether the API couldn't be reached at all (rather than answering with an error). */
export const unreachable = (error: unknown) =>
  error instanceof NetworkError ||
  (error instanceof ApiError && error.status >= 502 && error.status <= 504);
export async function initSession() {
  if (Platform.OS !== 'web') nativeToken = await SecureStore.getItemAsync('savorly.session');
}
export async function persistSession(token: string | null) {
  if (Platform.OS === 'web') return;
  nativeToken = token;
  if (token) await SecureStore.setItemAsync('savorly.session', token);
  else await SecureStore.deleteItemAsync('savorly.session');
}
type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Milliseconds before the request is abandoned: 30 seconds unless a large upload needs longer. */
  timeout?: number;
  /** Stops the request, and any retry still to come; `api()` then rejects with an AbortError. */
  signal?: AbortSignal;
  /**
   * False: a read isn't sent again after a gateway error, for one that can start paid work (a
   * recipe's translation), which the cook asks for again instead.
   */
  retry?: boolean;
};
// Server starts and deploys make the API briefly unavailable. Requests wait them out instead of
// failing: reads retry gateway errors, and writes retry only what the server never handled, so
// nothing is submitted twice.
const RETRY_FOR_MS = 120_000;
export async function api<T = void>(path: string, options: RequestOptions = {}): Promise<T> {
  const read = (options.method || 'GET') === 'GET';
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await request<T>(path, options);
    } catch (error) {
      const retry =
        error instanceof ApiError &&
        (error.unsent ||
          (read && options.retry !== false && error.status >= 502 && error.status <= 504));
      if (!retry || Date.now() - started > RETRY_FOR_MS) throw error;
      await pause(Math.min(1000 * attempt, 5000), options.signal);
    }
  }
}
// The wait before a retry, cut short by the caller's signal.
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const stop = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 30000);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  try {
    const isForm = options.body instanceof FormData;
    const response = await fetch(`${API_URL}/v1${path}`, {
      method: options.method || 'GET',
      credentials: 'include',
      signal: controller.signal,
      headers: {
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
        ...(nativeToken ? { Authorization: `Bearer ${nativeToken}` } : {}),
        ...options.headers,
      },
      body:
        options.body === undefined
          ? undefined
          : isForm
            ? (options.body as FormData)
            : JSON.stringify(options.body),
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(response.status, 'The server returned an unexpected response.');
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        result?.error || 'Something went wrong. Please try again.',
        result?.starting === true,
      );
    return result as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw cancelled();
    throw new NetworkError('We couldn’t reach your kitchen. Check your connection and try again.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
