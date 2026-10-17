/// <reference types="jest" />
import { API_URL } from '../../api';
import { narrationPlayer } from '../player';

beforeEach(() => {
  // jsdom has no media pipeline.
  jest.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => jest.restoreAllMocks());

test('loads the step with cookies and maps media events', () => {
  const events: string[] = [];
  const created: HTMLAudioElement[] = [];
  const RealAudio = window.Audio;
  jest.spyOn(window, 'Audio').mockImplementation(() => {
    const audio = new RealAudio();
    created.push(audio);
    return audio;
  });
  narrationPlayer('/recipes/r1/steps/0/narration/k', (event) => events.push(event));
  const [audio] = created;
  expect(audio.src).toBe(`${API_URL}/v1/recipes/r1/steps/0/narration/k`);
  expect(audio.crossOrigin).toBe('use-credentials');
  audio.onplaying?.(new Event('playing'));
  audio.onended?.(new Event('ended'));
  audio.onerror?.(new Event('error'));
  expect(events).toEqual(['playing', 'ended', 'error']);
});

test('the device’s copy of a recording plays from its object URL', () => {
  const created: HTMLAudioElement[] = [];
  const RealAudio = window.Audio;
  jest.spyOn(window, 'Audio').mockImplementation(() => {
    const audio = new RealAudio();
    created.push(audio);
    return audio;
  });
  narrationPlayer('blob:http://localhost/1', () => {});
  const [audio] = created;
  expect(audio.src).toBe('blob:http://localhost/1');
  // Made by this page: no cookies, and no cross-origin request.
  expect(audio.hasAttribute('crossorigin')).toBe(false);
});

test('replays from the start once loaded, and dispose detaches everything', async () => {
  const created: HTMLAudioElement[] = [];
  const RealAudio = window.Audio;
  jest.spyOn(window, 'Audio').mockImplementation(() => {
    const audio = new RealAudio();
    created.push(audio);
    return audio;
  });
  const narration = narrationPlayer('/p', () => {});
  const [audio] = created;
  Object.defineProperty(audio, 'readyState', { value: 4 });
  audio.currentTime = 12;
  await narration.play();
  expect(audio.currentTime).toBe(0);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  narration.dispose();
  expect(audio.onplaying).toBeNull();
  expect(audio.hasAttribute('src')).toBe(false);
});

test('passes a blocked autoplay through to the controller', async () => {
  jest
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(() =>
      Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })),
    );
  const narration = narrationPlayer('/p', () => {});
  await expect(narration.play()).rejects.toMatchObject({ name: 'NotAllowedError' });
});
