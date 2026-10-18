import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { api, ApiError } from './api';
import { AIJob } from './types';
import { requestKey } from './utils';

/**
 * A photo from the camera or the library, or null if the cook changes their mind. Portraits open
 * the front camera; they're framed afterwards in Savorly's own crop (PhotoCrop), not the system's.
 */
export async function pickPhoto(
  from: 'camera' | 'library',
  portrait?: boolean,
): Promise<string | null> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1 };
  let result: ImagePicker.ImagePickerResult;
  if (from === 'camera') {
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new Error('Savorly needs camera access. You can allow it in Settings.');
    }
    try {
      result = await ImagePicker.launchCameraAsync({
        ...options,
        cameraType: portrait ? ImagePicker.CameraType.front : ImagePicker.CameraType.back,
      });
    } catch {
      // Simulators and some tablets have no camera at all.
      throw new Error('This device can’t take photos. Choose one from your library instead.');
    }
  } else result = await ImagePicker.launchImageLibraryAsync(options);
  return result.canceled ? null : (result.assets?.[0]?.uri ?? null);
}

/** A photo on this device, upright, with its size in pixels. */
export type Photo = { uri: string; width: number; height: number };
/** The part of a photo to keep, in its pixels. */
export type Crop = { originX: number; originY: number; width: number; height: number };

/** A JPEG no larger than `max` on its long side, cut down to `crop` first when there is one. */
export async function preparePhoto(
  uri: string,
  { max, crop }: { max: number; crop?: Crop },
): Promise<Photo> {
  const context = ImageManipulator.manipulate(uri);
  if (crop) context.crop(crop);
  let rendered = await context.renderAsync();
  const { width, height } = rendered;
  if (Math.max(width, height) > max) {
    rendered.release();
    context.resize(width >= height ? { width: max, height: null } : { width: null, height: max });
    rendered = await context.renderAsync();
  }
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.88 });
  rendered.release();
  context.release();
  return { uri: result.uri, width: result.width, height: result.height };
}

/**
 * A form with one local file in it. Phones send it through Expo's fetch, which reads
 * expo-file-system Files rather than React Native's `{ uri }` parts; browsers send a Blob.
 */
export async function fileForm(uri: string, name: string) {
  const form = new FormData();
  if (Platform.OS === 'web') form.append('file', await (await fetch(uri)).blob(), name);
  else form.append('file', new File(uri) as unknown as Blob);
  return form;
}

/** A local file to upload: a picker asset, a prepared photo, or just its address. */
export type LocalMedia = {
  uri: string;
  fileName?: string | null;
  fileSize?: number | null;
  /** What the picker says the file is, when it knows. */
  mimeType?: string | null;
};
export type MediaKind = 'image' | 'video' | 'audio';
/** The largest photo or video the server takes. */
export const MEDIA_LIMIT = 50 * 1024 * 1024;
/** The largest family recording the server takes: what speech-to-text hears in one go. */
export const RECORDING_LIMIT = 25 * 1024 * 1024;
/** Large files on slow connections need far longer than an ordinary request. */
export const UPLOAD_TIMEOUT = 5 * 60_000;
/** A direct upload gives up once no bytes have moved for this long. */
export const UPLOAD_STALL = 60_000;
export type UploadOptions = {
  /** Hears 0 when the transfer starts, the share sent as it goes, and 1 once the file is stored. */
  onProgress?: (fraction: number) => void;
  /** Stops the upload: `uploadMedia` then rejects with an error named AbortError. */
  signal?: AbortSignal;
};

const tooLarge = 'Choose a file smaller than 50 MB.';
const recordingTooLarge = 'Choose a recording smaller than 25 MB.';
const notRecording = 'Use an M4A, WebM or MP3 recording.';
const noRecordings = 'Recordings can’t be uploaded here right now. Please try again later.';
const stopped = 'The upload stopped. Check your connection and try again.';
const refused = 'The upload didn’t finish. Please try again.';
const abortError = () =>
  Object.assign(new Error('The upload was cancelled.'), { name: 'AbortError' });
// What storage takes from a direct upload, by kind. Anything else goes the classic way, where the
// server judges the file by its own bytes.
const directTypes: Record<MediaKind, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/webm'],
  // Recordings only go straight to storage: the classic upload takes photos and videos.
  audio: ['audio/mp4', 'audio/webm', 'audio/mpeg'],
};
const extensionTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  weba: 'audio/webm',
};
// The names devices give recordings, as the server knows them: AAC in MP4, WebM, or MP3. A voice
// memo in a video container is a recording all the same.
const recordingTypes: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp4a-latm': 'audio/mp4',
  'audio/aacp': 'audio/mp4',
  'video/mp4': 'audio/mp4',
  'video/webm': 'audio/webm',
  'audio/mp3': 'audio/mpeg',
};
const typeOf = (...candidates: (string | null | undefined)[]) => {
  const found = candidates.find(Boolean)?.split(';')[0].trim().toLowerCase() || '';
  return found === 'image/jpg' ? 'image/jpeg' : found;
};
/** The file, as this platform sends it, with its exact size and type. */
type Source = { body: unknown; size: number; type: string };
async function sourceOf(media: LocalMedia): Promise<Source> {
  const extension = /\.([a-z0-9]+)$/i.exec((media.fileName || media.uri).split(/[?#]/)[0])?.[1];
  const guess = extensionTypes[extension?.toLowerCase() || ''];
  if (Platform.OS === 'web') {
    const blob = await (await fetch(media.uri)).blob();
    return { body: blob, size: blob.size, type: typeOf(blob.type, media.mimeType, guess) };
  }
  // React Native's XMLHttpRequest sends `{ uri }` straight from the file (streamed on Android,
  // memory-mapped on iOS), so even a 50 MB video never passes through JavaScript.
  let local: { size: number; type: string } | null = null;
  try {
    const file = new File(media.uri);
    local = { size: file.size, type: file.type };
  } catch {
    // An address expo-file-system can't open; the picker's numbers stand.
  }
  return {
    body: { uri: media.uri },
    size: local?.size || media.fileSize || 0,
    type: typeOf(media.mimeType, local?.type, guess),
  };
}
const stopIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError();
};
type Presigned = {
  uploadUrl: string;
  method?: string;
  headers?: Record<string, string>;
  url?: string;
  key: string;
};
/** Where to send the file straight to storage, or null when this server can't sign uploads. */
async function presign(kind: MediaKind, source: Source, signal?: AbortSignal) {
  try {
    const target = await api<Presigned | null>('/media/uploads', {
      method: 'POST',
      body: { kind, contentType: source.type, size: source.size },
      signal,
    });
    const usable =
      typeof target?.uploadUrl === 'string' &&
      /^https?:\/\//i.test(target.uploadUrl) &&
      typeof target.key === 'string' &&
      !!target.key;
    return usable ? target : null;
  } catch (e) {
    // Servers from before direct uploads, and ones whose storage isn't set up for them.
    if (e instanceof ApiError && (e.status === 404 || e.status === 503)) return null;
    throw e;
  }
}
// Why a transfer to storage failed: storage couldn't be reached at all (no route, or a browser
// refusing it for CORS), the connection broke or stalled along the way, or storage said no.
class TransferError extends Error {
  constructor(
    public reason: 'unreachable' | 'stopped' | 'refused',
    message: string,
  ) {
    super(message);
  }
}
/**
 * Sends the file to a presigned address with exactly the headers it was signed with.
 * XMLHttpRequest, unlike fetch, reports upload progress on the web and in React Native alike.
 */
function put(
  target: Presigned,
  source: Source,
  onSent: (fraction: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let moved = false;
    let stalled = false;
    let done = false;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => xhr.abort();
    const settle = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(stall);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve();
    };
    // Any sign of life restarts the clock; a minute of silence gives up.
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_STALL);
    };
    // A failure before any byte moved means storage was never reached.
    const broken = () => new TransferError(moved ? 'stopped' : 'unreachable', stopped);
    xhr.upload.onprogress = (event) => {
      watch();
      if (event.loaded > 0) moved = true;
      const total = event.total || source.size;
      if (total > 0) onSent(Math.min(1, event.loaded / total));
    };
    xhr.onload = () =>
      settle(
        xhr.status >= 200 && xhr.status < 300 ? undefined : new TransferError('refused', refused),
      );
    xhr.onerror = () => settle(broken());
    xhr.ontimeout = () => settle(broken());
    xhr.onabort = () => settle(stalled ? broken() : abortError());
    if (signal?.aborted) return settle(abortError());
    signal?.addEventListener('abort', cancel);
    xhr.open(target.method || 'PUT', target.uploadUrl);
    for (const [name, value] of Object.entries(target.headers || {}))
      xhr.setRequestHeader(name, value);
    watch();
    xhr.send(source.body as XMLHttpRequestBodyInit);
  });
}
/** Uploads straight to storage; null when storage can't be reached and the API should take it. */
async function direct(
  target: Presigned,
  source: Source,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
) {
  let sentAll = false;
  try {
    await put(
      target,
      source,
      (fraction) => {
        sentAll = fraction >= 1;
        onProgress?.(Math.min(fraction, 0.99));
      },
      signal,
    );
  } catch (e) {
    if (!(e instanceof TransferError)) throw e;
    // Before a single byte moved: most likely a bucket without CORS for this site.
    if (e.reason === 'unreachable') return null;
    // Every byte went and only the answer was lost, so storage may well have the file.
    if (e.reason !== 'stopped' || !sentAll) throw new Error(e.message);
  }
  let stored: { url?: string } | null;
  try {
    stored = await api<{ url?: string } | null>('/media/uploads/complete', {
      method: 'POST',
      body: { key: target.key },
      signal,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(stopped);
    throw e;
  }
  const url = stored?.url || target.url;
  if (!url) throw new Error(refused);
  return url;
}
/** The classic way: a multipart POST through the API, for servers that can't sign uploads. */
async function throughApi(media: LocalMedia, kind: MediaKind, signal?: AbortSignal) {
  const form = await fileForm(
    media.uri,
    media.fileName || (kind === 'image' ? 'photo.jpg' : 'video.mp4'),
  );
  stopIfAborted(signal);
  const { url } = await api<{ url: string }>('/media', {
    method: 'POST',
    body: form,
    timeout: UPLOAD_TIMEOUT,
    signal,
  });
  return url;
}

/**
 * Stores a photo, video or family recording and returns its public address. Every upload goes
 * through here. The file goes straight to storage on an address the API signs (`POST
 * /media/uploads`, a PUT, then `POST /media/uploads/complete`), with real progress; servers that
 * can't sign one, and storage this device can't reach (a bucket without CORS for this site), get
 * the classic multipart `POST /media` instead, which takes photos and videos only.
 */
export async function uploadMedia(
  file: LocalMedia | string,
  kind: MediaKind,
  { onProgress, signal }: UploadOptions = {},
) {
  const media: LocalMedia = typeof file === 'string' ? { uri: file } : file;
  const [limit, large] =
    kind === 'audio' ? [RECORDING_LIMIT, recordingTooLarge] : [MEDIA_LIMIT, tooLarge];
  if (media.fileSize && media.fileSize > limit) throw new Error(large);
  stopIfAborted(signal);
  const source = await sourceOf(media);
  if (source.size > limit) throw new Error(large);
  if (kind === 'audio') {
    source.type = recordingTypes[source.type] ?? source.type;
    if (!directTypes.audio.includes(source.type)) throw new Error(notRecording);
  }
  stopIfAborted(signal);
  onProgress?.(0);
  const target =
    source.size > 0 && directTypes[kind].includes(source.type)
      ? await presign(kind, source, signal)
      : null;
  const sent = target ? await direct(target, source, onProgress, signal) : null;
  if (!sent && kind === 'audio') throw new Error(noRecordings);
  const url = sent ?? (await throughApi(media, kind, signal));
  onProgress?.(1);
  return url;
}

/**
 * Asks the AI to retouch a photo the cook already has (better light, color and focus, the same
 * subject) and waits for the result. `live` stops the wait when the screen asking goes away.
 */
export async function touchUpPhoto(url: string, kind: 'avatar' | 'dish', live: () => boolean) {
  let job = await api<AIJob>('/media/touch-up', {
    method: 'POST',
    body: { url, kind },
    headers: { 'Idempotency-Key': requestKey() },
  });
  while (job.status !== 'completed' && job.status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!live()) return null;
    job = await api<AIJob>(`/ai/jobs/${encodeURIComponent(job.id)}`);
  }
  if (job.status === 'failed' || !job.result.url)
    throw new Error(job.error || 'The touch-up didn’t finish. Please try again.');
  return job.result.url;
}
