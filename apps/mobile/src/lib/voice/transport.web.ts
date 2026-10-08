import { connectVoice, VoiceOptions } from './connection';
export async function openVoice(options: VoiceOptions) {
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    throw new Error(
      'Voice needs a supported browser on HTTPS or localhost. You can continue by text.',
    );
  }
  const audio = new Audio();
  audio.autoplay = true;
  return connectVoice(
    {
      microphone: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        }),
      peer: () => new RTCPeerConnection(),
      play: async (stream) => {
        audio.srcObject = stream;
        await audio.play();
      },
      release: async () => {
        audio.pause();
        audio.srcObject = null;
      },
    },
    options,
  );
}
