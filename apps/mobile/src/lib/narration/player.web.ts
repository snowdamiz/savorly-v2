import { API_URL } from '../api';
import type { NarrationPlayer, PlayerEvent } from './controller';

// Handle play() rejection explicitly; mobile Safari can require a second tap
// after an asynchronous initial request. Credentials remain in HttpOnly cookies.
// `source` is an API path, or the object URL of the device's copy of a recording (cache.ts).
export function narrationPlayer(
  source: string,
  event: (event: PlayerEvent) => void,
): NarrationPlayer {
  const audio = new Audio();
  const cloud = source.startsWith('/');
  if (cloud) audio.crossOrigin = 'use-credentials';
  audio.preload = 'auto';
  audio.onplaying = () => event('playing');
  audio.onended = () => event('ended');
  audio.onerror = () => event('error');
  audio.src = cloud ? `${API_URL}/v1${source}` : source;
  audio.load();
  return {
    play: () => {
      if (audio.readyState > 0) audio.currentTime = 0;
      return audio.play();
    },
    stop: () => audio.pause(),
    dispose: () => {
      audio.pause();
      audio.onplaying = audio.onended = audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
    },
  };
}
