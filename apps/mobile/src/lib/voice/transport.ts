import { connectVoice, VoiceOptions } from './connection';
export async function openVoice(options: VoiceOptions) {
  // Lazy loading keeps text/photo creation available in Expo Go. WebRTC needs a dev build.
  let rtc: typeof import('react-native-webrtc');
  try {
    rtc = await import('react-native-webrtc');
  } catch {
    throw new Error('Voice needs the Savorly development build. You can use photo or text here.');
  }
  const { setAudioModeAsync } = await import('expo-audio');
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    interruptionMode: 'doNotMix',
    shouldRouteThroughEarpiece: false,
  });
  return connectVoice(
    {
      microphone: async () =>
        (await rtc.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        })) as unknown as MediaStream,
      peer: () => new rtc.RTCPeerConnection({ iceServers: [] }) as unknown as RTCPeerConnection,
      play: async () => {
        /* Native WebRTC plays incoming audio through its audio session. */
      },
      release: () => setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false }),
    },
    options,
  );
}
