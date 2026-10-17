import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { Sparkles } from './icons';
import { color, radius, s } from '../lib/theme';
import { animate, motionReduced, native } from './ui';

// The sous-chef's conversation pieces, the same wherever it talks: the chat, and the one-off
// requests from a recipe or the editor.

/** The sous-chef's mark beside its name. */
export function SousChefMark() {
  return (
    <View
      style={{
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: color.ink,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Sparkles size={15} color={color.white} strokeWidth={2.2} />
    </View>
  );
}
/** What you asked, on the right. */
export function Asked({ children }: { children: React.ReactNode }) {
  const { t: tr } = useI18n();
  return (
    <View style={[bubble, { alignSelf: 'flex-end', backgroundColor: color.ink }]}>
      <Text style={{ ...s.small, color: color.onInk }}>{tr('You')}</Text>
      <Text selectable style={{ ...s.body, color: color.white }}>
        {children}
      </Text>
    </View>
  );
}
// The thinking bubble's dots and padding, which a reply that ends the wait grows out of.
const dot = 7;
const dotGap = 5;
const thinkingPad = { x: 18, y: 19 };
const thinkingSize = {
  width: thinkingPad.x * 2 + dot * 3 + dotGap * 2,
  height: thinkingPad.y * 2 + dot,
};
// The dots rise one after another; still ones (and reduced motion) rest half lit.
function Dots({ moving }: { moving: boolean }) {
  const [dots] = useState(() => [0, 1, 2].map(() => new Animated.Value(0.5)));
  useEffect(() => {
    if (!moving || motionReduced()) return;
    dots.forEach((d) => d.setValue(0));
    const beat = (d: Animated.Value, toValue: number) =>
      Animated.timing(d, {
        toValue,
        duration: 300,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: native,
      });
    const loop = Animated.loop(
      Animated.sequence([
        Animated.stagger(
          140,
          dots.map((d) => Animated.sequence([beat(d, 1), beat(d, 0)])),
        ),
        Animated.delay(180),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [moving, dots]);
  return (
    <View style={[s.row, { gap: dotGap }]}>
      {dots.map((d, i) => (
        <Animated.View
          key={i}
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: color.ink,
            opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.28, 0.9] }),
            transform: [
              { translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) },
            ],
          }}
        />
      ))}
    </View>
  );
}
/**
 * The sous-chef's turn while it works: three dots in a bubble like its replies. `label` is what
 * screen readers hear.
 */
export function Thinking({ label }: { label?: string }) {
  const { t: tr } = useI18n();
  const [shown] = useState(() => new Animated.Value(0));
  useEffect(() => {
    animate(shown, 1, 260).start();
  }, [shown]);
  return (
    <Animated.View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? tr('Your sous-chef is working…')}
      accessibilityLiveRegion="polite"
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: thinkingPad.x,
        paddingVertical: thinkingPad.y,
        borderRadius: radius.md,
        backgroundColor: color.white,
        opacity: shown,
        transformOrigin: 'bottom left',
        transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
      }}
    >
      <Dots moving />
    </Animated.View>
  );
}
/** A message in the conversation; each side sets its own colour. */
export const bubble = { maxWidth: '92%', padding: 15, borderRadius: radius.md, gap: 5 } as const;
// A sous-chef reply. One that ends a wait takes the thinking bubble's place and stretches from its
// size to the reply's while the dots fade out and the words fade in; the rest simply show. It
// grows once: `onGrown` lets the conversation know, so a reopened panel shows it as it is.
export function Reply({
  grow,
  onGrown,
  children,
}: {
  grow: boolean;
  onGrown?: () => void;
  children: React.ReactNode;
}) {
  const [grows] = useState(grow);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [done, setDone] = useState(false);
  // The shape changes size, which only the JavaScript driver can animate; the fades run natively.
  const [shape] = useState(() => new Animated.Value(0));
  const [words] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!size) return;
    const still = motionReduced();
    const run = Animated.parallel([
      // An even pace, so a sheet that fits its content can keep up as the bubble grows.
      Animated.timing(shape, {
        toValue: 1,
        duration: still ? 0 : 460,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(words, {
        toValue: 1,
        duration: still ? 0 : 300,
        delay: still ? 0 : 200,
        useNativeDriver: native,
      }),
    ]);
    run.start(() => {
      setDone(true);
      onGrown?.();
    });
    return () => run.stop();
  }, [size, shape, words, onGrown]);
  if (!grows)
    return (
      <View style={[bubble, { alignSelf: 'flex-start', backgroundColor: color.white }]}>
        {children}
      </View>
    );
  const growing = !done;
  return (
    <Animated.View
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        // Until the reply is measured the bubble keeps the thinking bubble's size, then grows to it.
        ...(growing && {
          overflow: 'hidden',
          height: size
            ? shape.interpolate({
                inputRange: [0, 1],
                outputRange: [thinkingSize.height, size.height],
              })
            : thinkingSize.height,
        }),
      }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          borderRadius: radius.md,
          backgroundColor: color.white,
          ...(growing
            ? {
                width: size
                  ? shape.interpolate({
                      inputRange: [0, 1],
                      outputRange: [thinkingSize.width, size.width],
                    })
                  : thinkingSize.width,
              }
            : { right: 0 }),
        }}
      />
      {growing && (
        <Animated.View
          style={{
            position: 'absolute',
            top: thinkingPad.y,
            left: thinkingPad.x,
            opacity: words.interpolate({
              inputRange: [0, 0.4],
              outputRange: [1, 0],
              extrapolate: 'clamp',
            }),
          }}
        >
          <Dots moving={false} />
        </Animated.View>
      )}
      <Animated.View
        onLayout={(e) => {
          if (!size)
            setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
        }}
        style={{ padding: bubble.padding, gap: bubble.gap, opacity: growing ? words : 1 }}
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}
