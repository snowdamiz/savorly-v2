import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { API_URL, sessionHeaders } from '../api';
import type { NarrationPlayer, PlayerEvent } from './controller';

// `source` is an API path, streamed with the session's bearer token, or the address of the
// device's copy of a recording (a file, cache.ts), which plays as it is.
export function narrationPlayer(
  source: string,
  event: (event: PlayerEvent) => void,
): NarrationPlayer {
  const player = createAudioPlayer(
    source.startsWith('/')
      ? { uri: `${API_URL}/v1${source}`, headers: sessionHeaders() }
      : { uri: source },
    {
      updateInterval: 100,
      preferredForwardBufferDuration: 1,
    },
  );
  let version = 0;
  let attempted = false;
  let disposed = false;
  const sub = player.addListener('playbackStatusUpdate', (status) => {
    if (status.error) event('error');
    else if (status.didJustFinish) event('ended');
    else if (status.playing && !status.isBuffering) event('playing');
  });
  const stop = () => {
    version++;
    if (!disposed) player.pause();
  };
  return {
    play: async () => {
      const current = ++version;
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'doNotMix',
      });
      if (current !== version || disposed) return;
      if (attempted) await player.seekTo(0);
      if (current !== version || disposed) return;
      attempted = true;
      player.play();
    },
    stop,
    dispose: () => {
      stop();
      disposed = true;
      sub.remove();
      player.remove();
    },
  };
}
