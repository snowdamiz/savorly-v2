/// <reference types="jest" />
import { playClip } from '../voiceClip';

// The browser's audio element, standing still until a test moves its time.
class FakeAudio {
  static made: FakeAudio[] = [];
  src = '';
  preload = '';
  currentTime = 0;
  paused = true;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

beforeEach(() => {
  FakeAudio.made = [];
  global.Audio = FakeAudio as unknown as typeof Audio;
});

test('a clip plays its stretch of the recording, and ends there', () => {
  const ended = jest.fn();
  playClip('https://media.test/r1.m4a', 4300, 12500, ended);
  const audio = FakeAudio.made[0];
  expect(audio.src).toBe('https://media.test/r1.m4a#t=4.3');
  audio.onloadedmetadata?.();
  expect(audio.currentTime).toBe(4.3);
  expect(audio.paused).toBe(false);
  audio.currentTime = 9;
  audio.ontimeupdate?.();
  expect(ended).not.toHaveBeenCalled();
  audio.currentTime = 12.5;
  audio.ontimeupdate?.();
  expect(ended).toHaveBeenCalledTimes(1);
  expect(audio.paused).toBe(true);
  // It ends once, however the element carries on.
  audio.onended?.();
  expect(ended).toHaveBeenCalledTimes(1);
});

test('stopping a clip ends it without calling it finished', () => {
  const ended = jest.fn();
  const playback = playClip('https://media.test/r1.m4a', 0, 5000, ended);
  playback.stop();
  expect(FakeAudio.made[0].paused).toBe(true);
  expect(FakeAudio.made[0].src).toBe('');
  expect(ended).not.toHaveBeenCalled();
});
