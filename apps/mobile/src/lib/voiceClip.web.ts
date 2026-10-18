/** A recorded clip playing; `stop` ends it early. */
export type ClipPlayback = { stop: () => void };

/**
 * Plays the stretch of a family recording from `startMs` to `endMs`, calling `onEnd` once when it
 * stops by itself (the stretch is over, the recording ended, or it can't play). It starts from a
 * tap, so the browser lets it play.
 */
export function playClip(
  url: string,
  startMs: number,
  endMs: number,
  onEnd: () => void,
): ClipPlayback {
  const audio = new Audio();
  audio.preload = 'auto';
  let done = false;
  const release = () => {
    if (done) return false;
    done = true;
    audio.pause();
    audio.onloadedmetadata = audio.ontimeupdate = audio.onended = audio.onerror = null;
    audio.removeAttribute('src');
    audio.load();
    return true;
  };
  const finish = () => release() && onEnd();
  audio.onloadedmetadata = () => {
    audio.currentTime = startMs / 1000;
  };
  audio.ontimeupdate = () => {
    if (audio.currentTime * 1000 >= endMs) finish();
  };
  audio.onended = finish;
  audio.onerror = finish;
  // A fragment tells the browser where to start, before the metadata has loaded.
  audio.src = `${url}#t=${startMs / 1000}`;
  audio.play().catch(finish);
  return { stop: () => void release() };
}
