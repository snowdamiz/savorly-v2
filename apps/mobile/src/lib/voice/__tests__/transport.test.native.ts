/// <reference types="jest" />
import { setAudioModeAsync } from 'expo-audio';
import { connectVoice } from '../connection';
import { openVoice } from '../transport';

jest.mock('expo-audio', () => ({ setAudioModeAsync: jest.fn(() => Promise.resolve()) }));
jest.mock('../connection', () => ({ connectVoice: jest.fn((transport) => transport) }));
jest.mock('react-native-webrtc', () => ({
  mediaDevices: { getUserMedia: jest.fn(() => Promise.resolve('microphone-stream')) },
  RTCPeerConnection: jest.fn(function (this: object, config: unknown) {
    Object.assign(this, { config });
  }),
}));

type Transport = {
  microphone: () => Promise<unknown>;
  peer: () => unknown;
  play: (stream: unknown) => Promise<void>;
  release: () => Promise<void>;
};
const options = {} as Parameters<typeof openVoice>[0];

test('opens the audio session for a two-way conversation before connecting', async () => {
  const transport = (await openVoice(options)) as unknown as Transport;
  expect(setAudioModeAsync).toHaveBeenCalledWith(
    expect.objectContaining({ allowsRecording: true, playsInSilentMode: true }),
  );
  expect(connectVoice).toHaveBeenCalledWith(expect.any(Object), options);
  const rtc = jest.requireMock('react-native-webrtc');
  await expect(transport.microphone()).resolves.toBe('microphone-stream');
  expect(rtc.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
  expect(transport.peer()).toMatchObject({ config: { iceServers: [] } });
});

test('hands the audio session back when the conversation ends', async () => {
  const transport = (await openVoice(options)) as unknown as Transport;
  jest.mocked(setAudioModeAsync).mockClear();
  await transport.release();
  expect(setAudioModeAsync).toHaveBeenCalledWith(
    expect.objectContaining({ allowsRecording: false }),
  );
});

// Last: it swaps the module registry for one without WebRTC (as in Expo Go).
test('explains that voice needs the development build when WebRTC is missing', async () => {
  jest.resetModules();
  jest.doMock('react-native-webrtc', () => {
    throw new Error('Native module not found');
  });
  const { openVoice: open } = require('../transport') as typeof import('../transport');
  await expect(open(options)).rejects.toThrow(
    'Voice needs the Savorly development build. You can use photo or text here.',
  );
});
