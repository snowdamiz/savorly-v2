import { api } from '../api';

export type VoiceEvent = {
  type: string;
  delta?: string;
  reason?: string;
  error?: { message?: string };
};
export type VoiceConnection = {
  id: string;
  mute: (muted: boolean) => void;
  close: () => Promise<void>;
  enableAudio: () => Promise<void>;
};
export type VoiceEnvironment = {
  microphone: () => Promise<MediaStream>;
  peer: () => RTCPeerConnection;
  play: (stream: MediaStream) => Promise<void>;
  release: () => Promise<void>;
};
export type VoiceOptions = {
  projectId: string;
  signal: AbortSignal;
  onEvent: (event: VoiceEvent) => void;
  onAudioBlocked: () => void;
};

// The native and web adapters own devices; this owns the provider protocol and cleanup.
export async function connectVoice(
  env: VoiceEnvironment,
  options: VoiceOptions,
): Promise<VoiceConnection> {
  let stream: MediaStream | undefined;
  let remote: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let sessionId = '';
  let closed = false;
  let isMuted = false;
  let providerClosed: (() => void) | undefined;
  let lease: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    void close();
  };
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      clearTimeout(lease);
      options.signal.removeEventListener('abort', abort);
      stream?.getTracks().forEach((track) => track.stop());
      await env.release().catch(() => {});
      const drain = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2500);
        providerClosed = () => {
          clearTimeout(timeout);
          resolve();
        };
        if (channel?.readyState === 'open') {
          try {
            channel.send(JSON.stringify({ type: 'session.close' }));
          } catch {
            providerClosed?.();
          }
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
      if (sessionId)
        void api(`/recipe-studio/voice/${sessionId}`, { method: 'DELETE' }).catch(() => {});
      await drain;
      channel?.close();
      peer?.close();
    })();
    return closePromise;
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal.aborted) throw new Error('Connection cancelled.');
    stream = await env.microphone();
    if (closed || options.signal.aborted) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Connection cancelled.');
    }
    peer = env.peer();
    // Don't send speech before the backend has attached and acknowledged the session.
    stream.getAudioTracks().forEach((track) => {
      track.enabled = false;
      peer!.addTrack(track, stream!);
    });
    peer.addEventListener('track', (event) => {
      remote = event.streams[0];
      if (remote) void env.play(remote).catch(options.onAudioBlocked);
    });
    peer.addEventListener('connectionstatechange', () => {
      if (!closed && peer?.connectionState === 'failed') {
        options.onEvent({ type: 'connection.failed' });
        void close();
      }
    });
    channel = peer.createDataChannel('oai-events');
    channel.addEventListener('message', (message) => {
      try {
        const event = JSON.parse(String(message.data)) as VoiceEvent;
        if (event.type === 'session.closed') {
          providerClosed?.();
          if (!closed) void close();
        }
        if (event.type === 'session.started')
          stream?.getAudioTracks().forEach((t) => {
            t.enabled = !isMuted;
          });
        if (!closed || event.type === 'session.closed') options.onEvent(event);
      } catch {
        /* Non-JSON transport payloads are not application events. */
      }
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await new Promise<void>((resolve, reject) => {
      if (peer!.iceGatheringState === 'complete') return resolve();
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('The microphone connection timed out. Please try again.'));
      }, 12000);
      const changed = () => {
        if (peer!.iceGatheringState === 'complete') {
          cleanup();
          resolve();
        }
      };
      const cancelled = () => {
        cleanup();
        reject(new Error('Connection cancelled.'));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        peer!.removeEventListener('icegatheringstatechange', changed);
        options.signal.removeEventListener('abort', cancelled);
      };
      peer!.addEventListener('icegatheringstatechange', changed);
      options.signal.addEventListener('abort', cancelled, { once: true });
    });
    if (closed) throw new Error('Connection cancelled.');
    const answer = await api<{ id: string; sdp: string; maxSeconds: number }>(
      `/recipe-studio/${options.projectId}/voice`,
      { method: 'POST', body: { sdp: peer.localDescription?.sdp } },
    );
    sessionId = answer.id;
    if (closed) {
      void api(`/recipe-studio/voice/${sessionId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('Connection cancelled.');
    }
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    // Renew long dictation in bounded sessions, retaining the full conversation on the server.
    lease = setTimeout(
      () => {
        options.onEvent({ type: 'connection.renew' });
        void close();
      },
      Math.max(10, answer.maxSeconds - 10) * 1000,
    );
    return {
      id: sessionId,
      close,
      mute: (muted) => {
        isMuted = muted;
        stream?.getAudioTracks().forEach((t) => {
          t.enabled = !muted;
        });
        if (channel?.readyState === 'open')
          channel.send(
            JSON.stringify({
              type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute',
            }),
          );
      },
      enableAudio: async () => {
        if (remote) await env.play(remote);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
