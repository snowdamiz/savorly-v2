// The device's speech recognition as hands-free cooking uses it, the same on every platform:
// recognizer.ts (iOS and Android, through expo-speech-recognition) and recognizer.web.ts (the
// browser's Web Speech API) implement it. One session runs at a time; the listener restarts them
// when a platform ends one, and stops them while the app speaks.

/** Why a session failed, in the listener's terms. */
export type RecognitionError =
  /** The microphone or speech recognition isn't allowed. */
  | 'denied'
  /** There's no recognizer to use (or the browser refuses it). */
  | 'unavailable'
  /** The recognizer can't listen in this language. */
  | 'language'
  /** The microphone couldn't be opened. */
  | 'microphone'
  /** Nothing was said, or the session was stopped: the next one starts as usual. */
  | 'quiet'
  /** Anything else (network, busy, interrupted): worth trying again. */
  | 'transient';

export type RecognitionOptions = {
  /** BCP-47, such as fr-FR. */
  language: string;
  /** Phrases the recognizer may favour, where it takes hints. */
  hints: string[];
  onResult: (text: string, final: boolean) => void;
  onError: (error: RecognitionError) => void;
  /** Always the session's last event, after an error too. */
  onEnd: () => void;
};

/** Where speech is turned into text: on the device, or by the platform's online service. */
export type RecognitionPlace = 'device' | 'service';

export type Recognition = {
  /** Whether this device or browser can recognize speech at all. */
  supported: () => boolean;
  /** Where a session in `language` would be recognized. */
  place: (language: string) => Promise<RecognitionPlace>;
  /**
   * Asks for the microphone (and speech recognition, where the platform asks for it apart):
   * `blocked` once the system won't ask again, so only Settings can allow it.
   */
  permission: () => Promise<'granted' | 'denied' | 'blocked'>;
  /** Starts a session, resolving with where it recognizes speech. */
  start: (options: RecognitionOptions) => Promise<RecognitionPlace>;
  /** Ends the running session at once, without a final result. */
  abort: () => void;
};

/**
 * A recognizer's error code in the listener's terms. The Web Speech API and expo-speech-recognition
 * share their codes; the native module adds a few of its own.
 */
export function recognitionError(code: string | undefined): RecognitionError {
  switch (code) {
    case 'not-allowed':
      return 'denied';
    case 'service-not-allowed':
      return 'unavailable';
    case 'language-not-supported':
      return 'language';
    case 'audio-capture':
      return 'microphone';
    case 'no-speech':
    case 'aborted':
    case 'speech-timeout':
    case 'nomatch':
      return 'quiet';
    default:
      return 'transient';
  }
}
