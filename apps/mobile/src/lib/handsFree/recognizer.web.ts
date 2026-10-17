import { recognitionError, type Recognition, type RecognitionPlace } from './recognition';

// Browsers recognize speech through the Web Speech API. Chrome and Safari send the audio to
// their maker's service (Google, Apple) unless the browser offers recognition on the device,
// which newer Chrome does for some languages (`processLocally`); the app says which in its
// explainer. The browser asks for the microphone itself the first time a session starts.

type Alternative = { transcript: string };
type Result = { isFinal: boolean; length: number; [index: number]: Alternative };
type Session = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<Result> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};
type SessionClass = {
  new (): Session;
  /** Chrome: whether a language can be recognized on the device. */
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
};

const browser = () => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SessionClass;
    webkitSpeechRecognition?: SessionClass;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
};

// Whether this browser can keep `language` on the device; a download it would need doesn't count.
async function local(language: string) {
  const Recognizer = browser();
  if (!Recognizer?.available || !('processLocally' in Recognizer.prototype)) return false;
  try {
    return (
      (await Recognizer.available({ langs: [language], processLocally: true })) === 'available'
    );
  } catch {
    return false;
  }
}

let current: Session | null = null;

export const recognition: Recognition = {
  supported: () => !!browser(),
  place: async (language): Promise<RecognitionPlace> =>
    (await local(language)) ? 'device' : 'service',
  async permission() {
    try {
      const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      // A site the visitor blocked isn't asked again: only the browser's settings can allow it.
      if (status?.state === 'denied') return 'blocked';
    } catch {
      // Firefox and older Safari don't know the microphone permission by name.
    }
    return 'granted';
  },
  async start({ language, onResult, onError, onEnd }) {
    const Recognizer = browser();
    if (!Recognizer) throw new Error('Speech recognition is unavailable.');
    const onDevice = await local(language);
    const session = new Recognizer();
    session.lang = language;
    session.continuous = true;
    session.interimResults = true;
    session.maxAlternatives = 1;
    if (onDevice) session.processLocally = true;
    session.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (text.trim()) onResult(text.trim(), result.isFinal);
      }
    };
    session.onerror = (event) => onError(recognitionError(event.error));
    session.onend = () => {
      if (current === session) current = null;
      onEnd();
    };
    current?.abort();
    current = session;
    session.start();
    return onDevice ? 'device' : 'service';
  },
  abort() {
    const session = current;
    current = null;
    session?.abort();
  },
};
