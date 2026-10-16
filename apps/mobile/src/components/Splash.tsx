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
import artwork from '../../assets/brand-artwork.json';
import { color } from '../lib/theme';
import { brandColors } from './Brand';

const native = Platform.OS !== 'web';
const HOP = 1100;
const BLINK = 3300;
// Long enough to see one hop rather than a flash.
const SHORTEST = 1000;
const size = 112;
// Where the eyes sit in the artwork, so a blink closes them in place.
const eyes = artwork.mascot.eyeOrigin;
// The splash stays mounted across all startup stages, so each loop has one lifetime.
function useLoop(period: number, easing: (t: number) => number) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
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
  }, [v, period, easing]);
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
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
  }, []);
  const hop = useLoop(HOP, linear);
  const blink = useLoop(BLINK, linear);
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
    outputRange: [0.9, 1, 1.04, 1.04, 1, 0.9],
  });
  const stretch = hop.interpolate({
    inputRange: [0, 0.08, 0.2, 0.8, 0.92, 1],
    outputRange: [1.08, 1, 0.97, 0.97, 1, 1.08],
  });
  const shadow = hop.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.62, 1] });
  // Open most of the time; a quick close and open near the end of each cycle.
  const lids = blink.interpolate({
    inputRange: [0, 0.9, 0.93, 0.96, 1],
    outputRange: [1, 1, 0.1, 1, 1],
  });
  const breathe = hop.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.86, 1] });
  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={[
        StyleSheet.absoluteFill,
        styles.screen,
        { opacity: fade, pointerEvents: done ? 'none' : 'auto' },
      ]}
    >
      <StatusBar barStyle="dark-content" />
      <View style={{ alignItems: 'center' }}>
        <Animated.View
          style={{
            width: size,
            height: size,
            opacity: reduced ? breathe : 1,
            transform: reduced
              ? []
              : [{ translateY: lift }, { scaleY: squash }, { scaleX: stretch }],
            transformOrigin: 'center bottom',
          }}
        >
          <Svg width={size} height={size} viewBox={artwork.mascot.viewBox}>
            <Path d={artwork.mascot.path} fill={brandColors.ink} />
            <Path d={artwork.mascot.accents} fill={brandColors.cream} />
          </Svg>
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { transform: [{ scaleY: reduced ? 1 : lids }], transformOrigin: eyes },
            ]}
          >
            <Svg width={size} height={size} viewBox={artwork.mascot.viewBox}>
              <Path d={artwork.mascot.eyes} fill={brandColors.cream} />
              <Path d={artwork.mascot.pupils} fill={brandColors.ink} />
            </Svg>
          </Animated.View>
        </Animated.View>
        <Animated.View style={[styles.shadow, { transform: [{ scaleX: reduced ? 1 : shadow }] }]} />
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
