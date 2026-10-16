import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { api } from './api';
import { AIJob } from './types';
import { requestKey } from './utils';

/**
 * A photo from the camera or the library, or null if the cook changes their mind. Portraits open
 * the front camera and, on phones, the system's square crop.
 */
export async function pickPhoto(
  from: 'camera' | 'library',
  portrait?: boolean,
): Promise<string | null> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 1,
    allowsEditing: !!portrait && Platform.OS !== 'web',
    aspect: [1, 1],
  };
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

/** A JPEG no larger than `max` on its long side; portraits are cropped square around the middle. */
export async function preparePhoto(
  uri: string,
  { max, square }: { max: number; square?: boolean },
) {
  const context = ImageManipulator.manipulate(uri);
  let rendered = await context.renderAsync();
  const { width, height } = rendered;
  const side = Math.min(width, height);
  const crop = !!square && width !== height;
  const long = crop ? side : Math.max(width, height);
  if (crop || long > max) {
    rendered.release();
    if (crop)
      context.crop({
        originX: Math.floor((width - side) / 2),
        originY: Math.floor((height - side) / 2),
        width: side,
        height: side,
      });
    if (long > max)
      context.resize(
        width >= height || crop ? { width: max, height: null } : { width: null, height: max },
      );
    rendered = await context.renderAsync();
  }
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.88 });
  rendered.release();
  context.release();
  return result.uri;
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

/** Stores a local photo and returns its public address. */
export async function uploadPhoto(uri: string, name = 'photo.jpg') {
  const form = await fileForm(uri, name);
  return (await api<{ url: string }>('/media', { method: 'POST', body: form })).url;
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
