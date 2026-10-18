import type { LocalMedia } from './photos';

/**
 * A recording the cook picks from their files, or null if they change their mind: the browser's
 * own file chooser, which expo-file-system doesn't open on the web.
 */
export function pickAudioFile(): Promise<LocalMedia | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.m4a,.mp3,.webm';
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(
        file
          ? {
              uri: URL.createObjectURL(file),
              fileName: file.name,
              fileSize: file.size,
              mimeType: file.type,
            }
          : null,
      );
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
