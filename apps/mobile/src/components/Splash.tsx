import React, { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as NativeSplash from 'expo-splash-screen';
import artwork from '../../assets/brand-artwork.json';
import { color } from '../lib/theme';
import { splashEyeOrigin, splashSize as size } from '../lib/splashGeometry';
import { brandColors } from './Brand';

const native = Platform.OS !== 'web';
// Keep the launch screen until this overlay has a layout, including before fonts load.
if (native) {
  NativeSplash.setOptions({ fade: false, duration: 0 });
  void NativeSplash.preventAutoHideAsync();
}
const HOP = 1100;
const BLINK = 3300;
// Long enough to see one hop rather than a flash.
const SHORTEST = 1000;
// The splash stays mounted across all startup stages, so each loop has one lifetime.
function useLoop(period: number, easing: (t: number) => number, enabled: boolean) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = (from: number) => {
      v.setValue(from);
      Animated.timing(v, {
        toValue: 1,
        duration: (1 - from) * period,
        easing,
        useNativeDriver: native,
      }).start(({ finished }) => alive && finished && run(0));
    };
    run(0);
    return () => {
      alive = false;
      v.stopAnimation();
    };
  }, [v, period, easing, enabled]);
  return v;
}
const linear = Easing.linear;

/**
 * The loading screen: the chef hopping and blinking now and then. `done` fades it out
 * once it has been up long enough to read as a moment rather than a flicker.
 */
export function Splash({ done = false, label = 'Savorly' }: { done?: boolean; label?: string }) {
  const [gone, setGone] = useState(false);
  // Unmount the animated child so its looping effects stop when the splash is hidden.
  return gone ? null : <SplashContent done={done} label={label} onHidden={setGone} />;
}
function SplashContent({
  done,
  label,
  onHidden,
}: {
  done: boolean;
  label: string;
  onHidden: (hidden: boolean) => void;
}) {
  const [started] = useState(Date.now);
  const [laidOut, setLaidOut] = useState(false);
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
  }, []);
  // Start from the same resting pose as the native launch image. Resolve the
  // motion preference before starting, so reduced motion never briefly hops.
  const animate = laidOut && reduced === false;
  const hop = useLoop(HOP, linear, animate);
  const blink = useLoop(BLINK, linear, animate);
  const [fade] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!done) {
      fade.setValue(1);
      return;
    }
    const wait = Math.max(0, SHORTEST - (Date.now() - started));
    const timer = setTimeout(
      () =>
        Animated.timing(fade, {
          toValue: 0,
          duration: 320,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: native,
        }).start(({ finished }) => {
          if (finished) onHidden(true);
        }),
      wait,
    );
    return () => {
      clearTimeout(timer);
      fade.stopAnimation();
    };
  }, [done, fade, onHidden, started]);
  // Up and down on a sine, with a little squash where it lands.
  const lift = hop.interpolate({
    inputRange: [0, 0.12, 0.5, 0.88, 1],
    outputRange: [0, -4, -18, -4, 0],
  });
  const squash = hop.interpolate({
    inputRange: [0, 0.08, 0.2, 0.8, 0.92, 1],
    outputRange: [1, 0.94, 1.04, 1.04, 0.94, 1],
  });
  const stretch = hop.interpolate({
    inputRange: [0, 0.08, 0.2, 0.8, 0.92, 1],
    outputRange: [1, 1.06, 0.97, 0.97, 1.06, 1],
  });
  const shadow = hop.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.62, 1] });
  // Open most of the time; a quick close and open near the end of each cycle.
  const lids = blink.interpolate({
    inputRange: [0, 0.9, 0.93, 0.96, 1],
    outputRange: [1, 1, 0.1, 1, 1],
  });
  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      onLayout={() => {
        if (laidOut) return;
        if (native) NativeSplash.hide();
        setLaidOut(true);
      }}
      style={[
        StyleSheet.absoluteFill,
        styles.screen,
        { opacity: fade, pointerEvents: done ? 'none' : 'auto' },
      ]}
    >
      <StatusBar barStyle="dark-content" />
      <View style={{ alignItems: 'center' }}>
        <Animated.View
          testID="splash-mascot"
          style={{
            width: size,
            height: size,
            transform: [{ translateY: lift }, { scaleY: squash }, { scaleX: stretch }],
            transformOrigin: [size / 2, size, 0],
          }}
        >
          <Svg width={size} height={size} viewBox={artwork.mascot.viewBox}>
            <Path d={artwork.mascot.path} fill={brandColors.ink} />
            <Path d={artwork.mascot.accents} fill={brandColors.cream} />
          </Svg>
          <Animated.View
            testID="splash-eyes"
            style={[
              StyleSheet.absoluteFill,
              { transform: [{ scaleY: lids }], transformOrigin: splashEyeOrigin },
            ]}
          >
            <Svg width={size} height={size} viewBox={artwork.mascot.viewBox}>
              <Path d={artwork.mascot.eyes} fill={brandColors.cream} />
              <Path d={artwork.mascot.pupils} fill={brandColors.ink} />
            </Svg>
          </Animated.View>
        </Animated.View>
        <Animated.View style={[styles.shadow, { transform: [{ scaleX: shadow }] }]} />
      </View>
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  screen: {
    zIndex: 2000,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shadow: {
    width: 64,
    height: 10,
    marginTop: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(27,28,26,0.16)',
  },
});
