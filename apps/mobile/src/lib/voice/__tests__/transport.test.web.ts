/// <reference types="jest" />
import { connectVoice } from '../connection';
import { openVoice } from '../transport';

jest.mock('../connection', () => ({ connectVoice: jest.fn((transport) => transport) }));

const options = {} as Parameters<typeof openVoice>[0];
afterEach(() => {
  jest.restoreAllMocks();
  delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

test('asks for a supported browser when WebRTC or the microphone API is missing', async () => {
  await expect(openVoice(options)).rejects.toThrow(
    'Voice needs a supported browser on HTTPS or localhost. You can continue by text.',
  );
  expect(connectVoice).not.toHaveBeenCalled();
});

test('uses the browser microphone with echo cancellation and plays the reply', async () => {
  const getUserMedia = jest.fn(() => Promise.resolve('mic'));
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = jest.fn();
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const transport = (await openVoice(options)) as unknown as {
    microphone: () => Promise<unknown>;
    play: (stream: unknown) => Promise<void>;
    release: () => Promise<void>;
  };
  await transport.microphone();
  expect(getUserMedia).toHaveBeenCalledWith({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  await transport.play(null);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  await transport.release();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});
