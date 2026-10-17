/// <reference types="jest" />
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { API_URL, persistSession } from '../../api';
import { narrationPlayer } from '../player';

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

type Status = { error?: string; didJustFinish?: boolean; playing?: boolean; isBuffering?: boolean };
function fakePlayer() {
  let listener: (status: Status) => void = () => {};
  const subscription = { remove: jest.fn() };
  return {
    subscription,
    emit: (status: Status) => listener(status),
    addListener: jest.fn((_: string, l: (status: Status) => void) => {
      listener = l;
      return subscription;
    }),
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(() => Promise.resolve()),
    remove: jest.fn(),
  };
}
let player: ReturnType<typeof fakePlayer>;
beforeEach(() => {
  player = fakePlayer();
  jest.mocked(createAudioPlayer).mockReturnValue(player as never);
});

test('streams the step from the API with the bearer token', async () => {
  await persistSession('cook-token');
  narrationPlayer('/recipes/r1/steps/0/narration/k', () => {});
  expect(createAudioPlayer).toHaveBeenCalledWith(
    {
      uri: `${API_URL}/v1/recipes/r1/steps/0/narration/k`,
      headers: { Authorization: 'Bearer cook-token' },
    },
    expect.objectContaining({ updateInterval: 100 }),
  );
  await persistSession(null);
});

test('the device’s copy of a recording plays from its file, without the session', async () => {
  await persistSession('cook-token');
  narrationPlayer('file:///cache/narration/k.mp3', () => {});
  expect(createAudioPlayer).toHaveBeenCalledWith(
    { uri: 'file:///cache/narration/k.mp3' },
    expect.objectContaining({ updateInterval: 100 }),
  );
  await persistSession(null);
});

test('reports playing, finished and failed playback', () => {
  const events: string[] = [];
  narrationPlayer('/p', (event) => events.push(event));
  player.emit({ playing: true, isBuffering: true });
  player.emit({ playing: true, isBuffering: false });
  player.emit({ didJustFinish: true });
  player.emit({ error: 'decoder failed' });
  expect(events).toEqual(['playing', 'ended', 'error']);
});

test('plays through the speaker even in silent mode, and replays from the start', async () => {
  const narration = narrationPlayer('/p', () => {});
  await narration.play();
  expect(setAudioModeAsync).toHaveBeenCalledWith(
    expect.objectContaining({ playsInSilentMode: true, allowsRecording: false }),
  );
  expect(player.seekTo).not.toHaveBeenCalled();
  expect(player.play).toHaveBeenCalledTimes(1);
  await narration.play();
  expect(player.seekTo).toHaveBeenCalledWith(0);
  expect(player.play).toHaveBeenCalledTimes(2);
});

test('a stop while the audio session is being set up cancels that play', async () => {
  let release!: () => void;
  jest.mocked(setAudioModeAsync).mockReturnValueOnce(new Promise<void>((r) => (release = r)));
  const narration = narrationPlayer('/p', () => {});
  const playing = narration.play();
  narration.stop();
  release();
  await playing;
  expect(player.play).not.toHaveBeenCalled();
  expect(player.pause).toHaveBeenCalled();
});

test('dispose releases the player and ignores later calls', async () => {
  const narration = narrationPlayer('/p', () => {});
  narration.dispose();
  expect(player.subscription.remove).toHaveBeenCalled();
  expect(player.remove).toHaveBeenCalled();
  await narration.play();
  expect(player.play).not.toHaveBeenCalled();
  const pauses = player.pause.mock.calls.length;
  narration.stop();
  expect(player.pause).toHaveBeenCalledTimes(pauses);
});
