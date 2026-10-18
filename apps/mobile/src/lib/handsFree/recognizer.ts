import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { recognitionError, type Recognition, type RecognitionPlace } from './recognition';

// iOS and Android recognize speech through expo-speech-recognition (Apple's Speech framework,
// Android's SpeechRecognizer). Both can keep the audio on the phone: iPhones for most languages,
// Android once the language's on-device model is installed; elsewhere the platform's own service
// (Apple, Google) does it. The module is looked up rather than imported, so a build without it
// (an older binary, the unit tests) reports that recognition is unavailable instead of crashing.

type SpeechModule = typeof ExpoSpeechRecognitionModule;
type Subscription = { remove: () => void };

/** Hands-free recognition over the native module, or a recognition that's unavailable. */
export function nativeRecognition(module: SpeechModule | null): Recognition {
  // The module's events are app-wide, so a session listens only until it ends or is stopped.
  let listening: Subscription[] = [];
  const release = () => {
    for (const subscription of listening) subscription.remove();
    listening = [];
  };
  const onDevice = async (language: string) => {
    if (!module) return false;
    try {
      if (!module.supportsOnDeviceRecognition()) return false;
      if (Platform.OS !== 'android') return true;
      // Android recognizes on the device only in languages whose model is installed.
      const { installedLocales } = await module.getSupportedLocales({});
      const tag = language.toLowerCase();
      const base = tag.split('-')[0];
      return installedLocales.some((locale) => {
        const installed = locale.toLowerCase().replace(/_/g, '-');
        return installed === tag || installed.split('-')[0] === base;
      });
    } catch {
      return false;
    }
  };
  return {
    supported: () => {
      try {
        return !!module && module.isRecognitionAvailable();
      } catch {
        return false;
      }
    },
    place: async (language): Promise<RecognitionPlace> =>
      (await onDevice(language)) ? 'device' : 'service',
    async permission() {
      if (!module) return 'denied';
      try {
        // The microphone, and on iOS speech recognition too, which a service fallback needs.
        const status = await module.requestPermissionsAsync();
        return status.granted ? 'granted' : status.canAskAgain ? 'denied' : 'blocked';
      } catch {
        return 'denied';
      }
    },
    async start({ language, hints, onResult, onError, onEnd }) {
      if (!module) throw new Error('Speech recognition is unavailable.');
      const local = await onDevice(language);
      release();
      listening = [
        module.addListener('result', (event) => {
          const text = event.results[0]?.transcript?.trim();
          if (text) onResult(text, event.isFinal);
        }),
        module.addListener('error', (event) => onError(recognitionError(event.error))),
        module.addListener('end', () => {
          release();
          onEnd();
        }),
      ];
      module.start({
        lang: language,
        interimResults: true,
        maxAlternatives: 1,
        // One long session where the platform allows it: iOS, and Android 13 and later, where it
        // also avoids the system's beep at every start. Older Android ends a session per phrase.
        continuous: Platform.OS === 'ios' || Number(Platform.Version) >= 33,
        requiresOnDeviceRecognition: local,
        addsPunctuation: false,
        contextualStrings: hints.slice(0, 100),
        // Google's model for short queries hears one- and two-word commands better.
        androidIntentOptions: { EXTRA_LANGUAGE_MODEL: 'web_search' },
        // Spoken answers and read-alouds stay on the speaker between sessions.
        iosCategory: {
          category: 'playAndRecord',
          categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
          mode: 'measurement',
        },
      });
      return local ? 'device' : 'service';
    },
    abort() {
      // A stopped session's last events go nowhere, so they can't end the next one.
      release();
      module?.abort();
    },
  };
}

export const recognition = nativeRecognition(
  requireOptionalNativeModule<SpeechModule>('ExpoSpeechRecognition'),
);
