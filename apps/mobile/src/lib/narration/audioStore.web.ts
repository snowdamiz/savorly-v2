import { API_URL, sessionHeaders } from '../api';

// The audio of the narration kept in a browser (cache.ts keeps the list): Cache Storage, under the
// address each recording was downloaded from. A recording plays from an object URL, made once per
// visit and let go when the recording goes. The phone's twin is audioStore.ts.

const CACHE = 'savorly-narration';
const address = (path: string) => `${API_URL}/v1${path}`;
/** Object URLs made this visit, by address. */
const sources = new Map<string, string>();

function storage(): CacheStorage {
  // Missing outside secure contexts, and refused in some private windows.
  if (typeof caches === 'undefined') throw new Error('This browser can’t keep recordings.');
  return caches;
}

function release(url: string) {
  const source = sources.get(url);
  if (source) URL.revokeObjectURL(source);
  sources.delete(url);
}

/**
 * Downloads the recording the API streams at `path` with the cook's session (the cookie, as the
 * player's own request carries it), keeps it, and resolves with its size in bytes.
 */
export async function saveAudio(key: string, path: string): Promise<number> {
  const cache = await storage().open(CACHE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(address(path), {
      credentials: 'include',
      headers: sessionHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The recording couldn’t be downloaded (${response.status}).`);
    const audio = await response.blob();
    if (!audio.size) throw new Error('The recording was empty.');
    release(address(path));
    await cache.put(
      address(path),
      new Response(audio, { headers: { 'Content-Type': audio.type || 'audio/mpeg' } }),
    );
    return audio.size;
  } finally {
    clearTimeout(timer);
  }
}

/** Where the copy of the recording at `path` plays from (an object URL), or null when it's gone. */
export async function audioSource(key: string, path: string): Promise<string | null> {
  const url = address(path);
  const made = sources.get(url);
  if (made) return made;
  const kept = await (await storage().open(CACHE)).match(url);
  if (!kept) return null;
  const source = URL.createObjectURL(await kept.blob());
  sources.set(url, source);
  return source;
}

export async function removeAudio(key: string, path: string): Promise<void> {
  release(address(path));
  await (await storage().open(CACHE)).delete(address(path));
}

/** Takes every recording off the device. */
export async function clearAudio(): Promise<void> {
  for (const url of [...sources.keys()]) release(url);
  if (typeof caches !== 'undefined') await caches.delete(CACHE);
}
