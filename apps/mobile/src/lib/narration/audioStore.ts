import { Directory, File, Paths } from 'expo-file-system';
import { API_URL, sessionHeaders } from '../api';

// The audio of the narration kept on a phone (cache.ts keeps the list): a file per recording in
// the app's cache directory, named by the API's key for it. The system may clear the directory
// when space runs low; cache.ts then forgets the copy. The browser's twin is audioStore.web.ts.

const folder = () => new Directory(Paths.cache, 'narration');
const file = (key: string) => new File(folder(), `${key}.mp3`);

/**
 * Downloads the recording the API streams at `path` (its key `key`) with the cook's session, as
 * the player does, and resolves with its size in bytes.
 */
export async function saveAudio(key: string, path: string): Promise<number> {
  const directory = folder();
  directory.create({ intermediates: true, idempotent: true });
  // Into a file of its own first: a download that fails on Android can leave part of one behind.
  const part = new File(directory, `${key}.part`);
  try {
    const done = await File.downloadFileAsync(`${API_URL}/v1${path}`, part, {
      headers: sessionHeaders(),
      idempotent: true,
    });
    const audio = file(key);
    done.moveSync(audio, { overwrite: true });
    const bytes = audio.size;
    if (!bytes) {
      audio.delete();
      throw new Error('The recording was empty.');
    }
    return bytes;
  } finally {
    if (part.exists) part.delete();
  }
}

/** Where the copy of recording `key` plays from (a file address), or null when it's gone. */
export async function audioSource(key: string, path: string): Promise<string | null> {
  const audio = file(key);
  return audio.exists ? audio.uri : null;
}

export async function removeAudio(key: string, path: string): Promise<void> {
  const audio = file(key);
  if (audio.exists) audio.delete();
}

/** Takes every recording off the device. */
export async function clearAudio(): Promise<void> {
  const directory = folder();
  if (directory.exists) directory.delete();
}
