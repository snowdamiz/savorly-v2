import { Linking } from 'react-native';
import { api, API_URL } from './api';

/**
 * A copy of everything the account holds, as JSON (GET /me/export). The browser can't carry the
 * app's bearer token, so the app asks for a single-use link (ten minutes) and the browser
 * downloads the file from it.
 */
export async function downloadMyData() {
  const { url } = await api<{ url: string; expiresAt: string }>('/me/export-link', {
    method: 'POST',
  });
  // The link is relative to the API's base address, which may carry a path (/api).
  await Linking.openURL(`${API_URL}${url}`);
}
