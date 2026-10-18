import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

/** A recorded clip playing; `stop` ends it early. */
export type ClipPlayback = { stop: () => void };

/**
 * Plays the stretch of a family recording from `startMs` to `endMs`, calling `onEnd` once when it
 * stops by itself (the stretch is over, the recording ended, or it can't play).
 */
export function playClip(
  url: string,
  startMs: number,
  endMs: number,
  onEnd: () => void,
): ClipPlayback {
  const player = createAudioPlayer({ uri: url }, { updateInterval: 100 });
  let started = false;
  let done = false;
  const release = () => {
    if (done) return false;
    done = true;
    sub.remove();
    player.pause();
    player.remove();
    return true;
  };
  const finish = () => release() && onEnd();
  const sub = player.addListener('playbackStatusUpdate', (status) => {
    if (status.error || status.didJustFinish) finish();
    else if (!started && status.isLoaded) {
      started = true;
      void player.seekTo(startMs / 1000).then(() => {
        if (!done) player.play();
      }, finish);
    } else if (started && status.currentTime * 1000 >= endMs) finish();
  });
  void setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    interruptionMode: 'doNotMix',
  }).catch(() => {});
  return { stop: () => void release() };
}
