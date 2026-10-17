/// <reference types="jest" />
import { Directory, File, Paths } from 'expo-file-system';
import { API_URL, persistSession } from '../../api';
import { audioSource, clearAudio, removeAudio, saveAudio } from '../audioStore';

// Against the in-memory file system jest-expo puts behind expo-file-system.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const folder = new Directory(Paths.cache, 'narration');
const path = (key: string) => `/recipes/r1/steps/0/narration/${key}`;
beforeEach(() => {
  if (folder.exists) folder.delete();
});
afterEach(() => jest.restoreAllMocks());

test('a recording is downloaded with the bearer token into the app’s cache directory', async () => {
  await persistSession('cook-token');
  const download = jest.spyOn(File, 'downloadFileAsync');
  const bytes = await saveAudio('k1', path('k1'));
  expect(download).toHaveBeenCalledWith(`${API_URL}/v1${path('k1')}`, expect.any(File), {
    headers: { Authorization: 'Bearer cook-token' },
    idempotent: true,
  });
  // The token goes in a header, never in the address.
  expect(download.mock.calls[0][0]).not.toContain('cook-token');
  const kept = new File(folder, 'k1.mp3');
  expect(kept.exists).toBe(true);
  expect(kept.uri.startsWith(Paths.cache.uri)).toBe(true);
  expect(bytes).toBe(kept.size);
  expect(bytes).toBeGreaterThan(0);
  // Downloaded beside it first, then moved into place.
  expect((download.mock.calls[0][1] as File).uri).toBe(new File(folder, 'k1.part').uri);
  expect(new File(folder, 'k1.part').exists).toBe(false);
  expect(await audioSource('k1', path('k1'))).toBe(kept.uri);
  await persistSession(null);
});

test('a download that fails part way leaves nothing behind', async () => {
  jest.spyOn(File, 'downloadFileAsync').mockImplementationOnce(async (_url, to) => {
    // Android streams into the file, so part of it is there when the connection drops.
    (to as File).write('ID3 part of a recording');
    throw new Error('UnableToDownload: the connection was lost');
  });
  await expect(saveAudio('k2', path('k2'))).rejects.toThrow('connection was lost');
  expect(new File(folder, 'k2.part').exists).toBe(false);
  expect(new File(folder, 'k2.mp3').exists).toBe(false);
  expect(await audioSource('k2', path('k2'))).toBeNull();
});

test('an empty answer isn’t kept', async () => {
  jest.spyOn(File, 'downloadFileAsync').mockImplementationOnce(async (_url, to) => {
    (to as File).create();
    return to as File;
  });
  await expect(saveAudio('k3', path('k3'))).rejects.toThrow('empty');
  expect(await audioSource('k3', path('k3'))).toBeNull();
});

test('one recording goes, or all of them', async () => {
  await saveAudio('a', path('a'));
  await saveAudio('b', path('b'));
  await removeAudio('a', path('a'));
  expect(await audioSource('a', path('a'))).toBeNull();
  expect(await audioSource('b', path('b'))).toBe(new File(folder, 'b.mp3').uri);
  await clearAudio();
  expect(folder.exists).toBe(false);
  expect(await audioSource('b', path('b'))).toBeNull();
  // Nothing left to take away is fine too.
  await expect(clearAudio()).resolves.toBeUndefined();
  await expect(removeAudio('a', path('a'))).resolves.toBeUndefined();
});
