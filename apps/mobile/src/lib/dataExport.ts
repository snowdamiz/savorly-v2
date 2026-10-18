import { Linking } from 'react-native';
import { api, API_URL } from './api';

/**
 * Opens a single-use link (ten minutes) to the export in the browser, which saves the file: the
 * browser can't carry the app's bearer token.
 */
async function openExport(format: 'json' | 'files') {
  const { url } = await api<{ url: string; expiresAt: string }>('/me/export-link', {
    method: 'POST',
    ...(format === 'files' ? { body: { format } } : {}),
  });
  // The link is relative to the API's base address, which may carry a path (/api).
  await Linking.openURL(`${API_URL}${url}`);
}

/** A copy of everything the account holds, as JSON (GET /me/export). */
export const downloadMyData = () => openExport('json');

/**
 * Everything as files, one ZIP (GET /me/export/files): a folder for each recipe with its photos,
 * the lists as spreadsheets, and the JSON file.
 */
export const downloadMyFiles = () => openExport('files');
