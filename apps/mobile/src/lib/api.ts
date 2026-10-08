import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8080';
let nativeToken: string | null = null;
// Audio requests use bearer auth on native and HttpOnly cookies on web.
export function sessionHeaders(): Record<string, string> {
  return nativeToken ? { Authorization: `Bearer ${nativeToken}` } : {};
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
export async function api<T = void>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
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
      );
    return result as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('We couldn’t reach your kitchen. Check your connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
}
