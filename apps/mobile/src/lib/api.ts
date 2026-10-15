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
export async function initSession() {
  if (Platform.OS !== 'web') nativeToken = await SecureStore.getItemAsync('savorly.session');
}
export async function persistSession(token: string | null) {
  if (Platform.OS === 'web') return;
  nativeToken = token;
  if (token) await SecureStore.setItemAsync('savorly.session', token);
  else await SecureStore.deleteItemAsync('savorly.session');
}
type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
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
        (error.unsent || (read && error.status >= 502 && error.status <= 504));
      if (!retry || Date.now() - started > RETRY_FOR_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
    }
  }
}
async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
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
    throw new Error('We couldn’t reach your kitchen. Check your connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
}
