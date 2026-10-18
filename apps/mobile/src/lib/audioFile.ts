import { File } from 'expo-file-system';
import type { LocalMedia } from './photos';

/**
 * A recording the cook picks from the device's files (a voice memo, a message someone sent), or
 * null if they change their mind. The system's own file picker, which expo-file-system opens.
 */
export async function pickAudioFile(): Promise<LocalMedia | null> {
  const picked = await File.pickFileAsync({ mimeTypes: ['audio/*'] });
  if (picked.canceled || !picked.result) return null;
  const file = picked.result;
  return { uri: file.uri, fileName: file.name, fileSize: file.size, mimeType: file.type };
}
