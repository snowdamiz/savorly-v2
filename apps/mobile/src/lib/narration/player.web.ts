import { API_URL } from '../api';
import type { NarrationPlayer, PlayerEvent } from './controller';

// Handle play() rejection explicitly; mobile Safari can require a second tap
// after an asynchronous initial request. Credentials remain in HttpOnly cookies.
export function narrationPlayer(
  path: string,
  event: (event: PlayerEvent) => void,
): NarrationPlayer {
  const audio = new Audio();
  audio.crossOrigin = 'use-credentials';
  audio.preload = 'auto';
  audio.onplaying = () => event('playing');
  audio.onended = () => event('ended');
  audio.onerror = () => event('error');
  audio.src = `${API_URL}/v1${path}`;
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
