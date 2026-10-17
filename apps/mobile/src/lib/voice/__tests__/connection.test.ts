/// <reference types="jest" />
import { api } from '../../api';
import { connectVoice, VoiceEnvironment, VoiceEvent } from '../connection';

jest.mock('../../api', () => ({ api: jest.fn() }));

type Listener = (event: { data?: unknown; streams?: unknown[] }) => void;
function fakes({ gathered = true } = {}) {
  const track = { enabled: true, stop: jest.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channelListeners: Listener[] = [];
  const channel = {
    readyState: 'open',
    send: jest.fn(),
    close: jest.fn(),
    addEventListener: (_: string, l: Listener) => channelListeners.push(l),
  };
  const peerListeners = new Map<string, Listener[]>();
  const peer = {
    iceGatheringState: gathered ? 'complete' : 'gathering',
    connectionState: 'new',
    localDescription: { sdp: 'offer-sdp' },
    addTrack: jest.fn(),
    addEventListener: (type: string, l: Listener) =>
      peerListeners.set(type, [...(peerListeners.get(type) ?? []), l]),
    removeEventListener: (type: string, l: Listener) =>
      peerListeners.set(
        type,
        (peerListeners.get(type) ?? []).filter((x) => x !== l),
      ),
    createDataChannel: jest.fn(() => channel),
    createOffer: jest.fn(() => Promise.resolve({ type: 'offer', sdp: 'offer-sdp' })),
    setLocalDescription: jest.fn(() => Promise.resolve()),
    setRemoteDescription: jest.fn(() => Promise.resolve()),
    close: jest.fn(),
  };
  const env: VoiceEnvironment = {
    microphone: jest.fn(() => Promise.resolve(stream as unknown as MediaStream)),
    peer: () => peer as unknown as RTCPeerConnection,
    play: jest.fn(() => Promise.resolve()),
    release: jest.fn(() => Promise.resolve()),
  };
  const fire = (type: string) => peerListeners.get(type)?.forEach((l) => l({}));
  const message = (data: unknown) =>
    channelListeners.forEach((l) =>
      l({ data: typeof data === 'string' ? data : JSON.stringify(data) }),
    );
  return { track, channel, peer, env, fire, message };
}
const events: VoiceEvent[] = [];
const options = (signal = new AbortController().signal) => ({
  projectId: 'project-1',
  signal,
  onEvent: (e: VoiceEvent) => events.push(e),
  onAudioBlocked: jest.fn(),
});
const answered = () =>
  jest
    .mocked(api)
    .mockImplementation(
      (path: string, init?: { method?: string }) =>
        Promise.resolve(
          init?.method === 'POST'
            ? { id: 'session-1', sdp: 'answer-sdp', maxSeconds: 600 }
            : undefined,
        ) as never,
    );

beforeEach(() => {
  events.length = 0;
  answered();
});
afterEach(() => jest.useRealTimers());
// Close releases the devices before it talks to the provider.
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('offers the microphone, keeps it silent until the session starts, and answers', async () => {
  const f = fakes();
  const voice = await connectVoice(f.env, options());
  expect(voice.id).toBe('session-1');
  expect(api).toHaveBeenCalledWith('/recipe-studio/project-1/voice', {
    method: 'POST',
    body: { sdp: 'offer-sdp' },
  });
  expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' });
  expect(f.track.enabled).toBe(false);
  f.message({ type: 'session.started' });
  expect(f.track.enabled).toBe(true);
  f.message('not json');
  f.message({ type: 'response.output_text.delta', delta: 'Hi' });
  expect(events.map((e) => e.type)).toEqual(['session.started', 'response.output_text.delta']);
  f.channel.readyState = 'closed';
  await voice.close();
});

test('mute silences the track and tells the provider', async () => {
  const f = fakes();
  const voice = await connectVoice(f.env, options());
  voice.mute(true);
  expect(f.track.enabled).toBe(false);
  expect(f.channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'session.input_audio.mute' }));
  // A session that starts while muted stays muted.
  f.message({ type: 'session.started' });
  expect(f.track.enabled).toBe(false);
  voice.mute(false);
  expect(f.track.enabled).toBe(true);
  f.channel.readyState = 'closed';
  await voice.close();
});

test('closing asks the provider to close, frees the server slot and releases everything once', async () => {
  const f = fakes();
  const voice = await connectVoice(f.env, options());
  const closing = voice.close();
  expect(voice.close()).toBe(closing);
  await settle();
  expect(f.channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'session.close' }));
  f.message({ type: 'session.closed' });
  await closing;
  expect(f.track.stop).toHaveBeenCalled();
  expect(f.env.release).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith('/recipe-studio/voice/session-1', { method: 'DELETE' });
  expect(f.channel.close).toHaveBeenCalled();
  expect(f.peer.close).toHaveBeenCalled();
  // The provider's close still reaches the screen after closing began.
  expect(events.map((e) => e.type)).toContain('session.closed');
});

test('a close the provider never confirms gives up after a moment', async () => {
  jest.useFakeTimers();
  const f = fakes();
  const voice = await connectVoice(f.env, options());
  let done = false;
  void voice.close().then(() => (done = true));
  await jest.advanceTimersByTimeAsync(2400);
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(200);
  expect(done).toBe(true);
});

test('a slow server release delays the next session by at most three seconds', async () => {
  jest.useFakeTimers();
  const f = fakes();
  const voice = await connectVoice(f.env, options());
  jest.mocked(api).mockImplementation(() => new Promise(() => {}) as never);
  f.channel.readyState = 'closed';
  let done = false;
  void voice.close().then(() => (done = true));
  await jest.advanceTimersByTimeAsync(2900);
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(200);
  expect(done).toBe(true);
});

test('long dictation renews ten seconds before the session limit', async () => {
  jest.useFakeTimers();
  const f = fakes();
  await connectVoice(f.env, options());
  await jest.advanceTimersByTimeAsync(589_000);
  expect(events.map((e) => e.type)).not.toContain('connection.renew');
  await jest.advanceTimersByTimeAsync(2_000);
  expect(events.map((e) => e.type)).toContain('connection.renew');
  // The provider has a moment to confirm the close before the connection is torn down.
  await jest.advanceTimersByTimeAsync(3_000);
  expect(f.peer.close).toHaveBeenCalled();
});

test('a failed connection is reported and cleaned up', async () => {
  const f = fakes();
  await connectVoice(f.env, options());
  f.peer.connectionState = 'failed';
  f.fire('connectionstatechange');
  expect(events.map((e) => e.type)).toContain('connection.failed');
  expect(f.env.release).toHaveBeenCalled();
});

test('cancelling before connecting releases the microphone and posts nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fakes();
  await expect(connectVoice(f.env, options(controller.signal))).rejects.toThrow(
    'Connection cancelled.',
  );
  expect(api).not.toHaveBeenCalledWith('/recipe-studio/project-1/voice', expect.anything());
  expect(f.env.release).toHaveBeenCalled();
});

test('cancelling while the network path is gathered stops cleanly', async () => {
  const controller = new AbortController();
  const f = fakes({ gathered: false });
  const connecting = connectVoice(f.env, options(controller.signal));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(connecting).rejects.toThrow('Connection cancelled.');
  expect(f.track.stop).toHaveBeenCalled();
});

test('a network path that never finishes gathering times out with a clear message', async () => {
  jest.useFakeTimers();
  const f = fakes({ gathered: false });
  const connecting = connectVoice(f.env, options());
  const failure = expect(connecting).rejects.toThrow(
    'The microphone connection timed out. Please try again.',
  );
  // Then the failed attempt closes, giving the provider its moment to confirm.
  await jest.advanceTimersByTimeAsync(12_000 + 3_000);
  await failure;
});
