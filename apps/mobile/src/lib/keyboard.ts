import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  KeyboardEvent,
  LayoutAnimation,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * How far a layout that already keeps clear of the bottom safe area must rise to sit above the
 * on-screen keyboard. iOS reports the keyboard as it starts to move, so the layout travels with it;
 * Android (drawn edge to edge, so nothing resizes for it) once it is up. Browsers resize the page.
 */
export function useKeyboardLift() {
  const insets = useSafeAreaInsets();
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const ios = Platform.OS === 'ios';
    const show = (e: KeyboardEvent) => {
      if (ios && e.duration)
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { duration: e.duration, type: LayoutAnimation.Types.keyboard },
        });
      // iOS measures from the top of the window; Android's height already leaves out the navigation bar.
      setOverlap(
        ios
          ? Math.max(0, Dimensions.get('window').height - e.endCoordinates.screenY)
          : e.endCoordinates.height,
      );
    };
    const hide = (e: KeyboardEvent) => {
      if (ios && e.duration)
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { duration: e.duration, type: LayoutAnimation.Types.keyboard },
        });
      setOverlap(0);
    };
    const subs = ios
      ? [
          Keyboard.addListener('keyboardWillChangeFrame', show),
          Keyboard.addListener('keyboardWillHide', hide),
        ]
      : [
          Keyboard.addListener('keyboardDidShow', show),
          Keyboard.addListener('keyboardDidHide', hide),
        ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);
  return Platform.OS === 'ios' ? Math.max(0, overlap - insets.bottom) : overlap;
}

type Inner = { getInnerViewRef(): Parameters<HostInstance['measureLayout']>[0] | null };
type HostInstance = NonNullable<ReturnType<typeof TextInput.State.currentlyFocusedInput>>;

/** Brings the focused field into view within the nearest keyboard-aware scroller. */
export const RevealFocus = createContext<() => void>(() => {});
export const useRevealFocus = () => useContext(RevealFocus);

/**
 * Keeps the focused field visible in a scroller whose bottom rises with the keyboard: when the
 * keyboard arrives, when the scroller shrinks, and when another field takes focus.
 */
export function useKeyboardScroll(ref: React.RefObject<ScrollView | null>, lift: number) {
  const frame = useRef({ y: 0, height: 0, lift: 0 });
  const reveal = useCallback(() => {
    // Browsers keep focused inputs visible themselves and do not expose this native API.
    if (Platform.OS === 'web' || !frame.current.lift) return;
    // Let the focus and the keyboard's new layout land before measuring.
    setTimeout(() => {
      const scroller = ref.current;
      const input = TextInput.State.currentlyFocusedInput();
      // The content container, so positions are in scroll space (missing from React Native's types).
      const content = (scroller as unknown as Inner | null)?.getInnerViewRef();
      if (!scroller || !input || !content || !frame.current.lift) return;
      input.measureLayout(
        content,
        (_x, y, _w, h) => {
          const { y: top, height: viewport } = frame.current;
          const margin = 28;
          if (y + h + margin > top + viewport)
            scroller.scrollTo({ y: Math.max(0, y + h + margin - viewport), animated: true });
          else if (y - margin < top)
            scroller.scrollTo({ y: Math.max(0, y - margin), animated: true });
        },
        () => {},
      );
    }, 60);
  }, [ref]);
  useEffect(() => {
    frame.current.lift = lift;
    if (lift) reveal();
  }, [lift, reveal]);
  return {
    reveal,
    onLayout: (e: LayoutChangeEvent) => {
      frame.current.height = e.nativeEvent.layout.height;
      if (frame.current.lift) reveal();
    },
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      frame.current.y = e.nativeEvent.contentOffset.y;
    },
  };
}
