import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
// Light physical feedback for taps that change something. Web stays silent: the vibration fallback
// buzzes on Android browsers. Builds without the native module simply skip it.
const run = (ios: () => Promise<void>, android: Haptics.AndroidHaptics) => {
  if (Platform.OS === 'ios') ios().catch(() => {});
  else if (Platform.OS === 'android') Haptics.performAndroidHapticsAsync(android).catch(() => {});
};
export const haptic = {
  /** A choice moved: chips, tabs, segments. */
  select: () => run(Haptics.selectionAsync, Haptics.AndroidHaptics.Segment_Tick),
  /** Something was kept or turned on: save, follow. */
  tap: () =>
    run(
      () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
      Haptics.AndroidHaptics.Confirm,
    ),
  /** A pull or gesture crossed its threshold. */
  soft: () =>
    run(
      () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
      Haptics.AndroidHaptics.Gesture_End,
    ),
};
