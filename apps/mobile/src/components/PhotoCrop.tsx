import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { Animated, Modal, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Svg, { Circle, Path } from 'react-native-svg';
import { Check, X } from './icons';
import type { Crop, Photo } from '../lib/photos';
import { color, s } from '../lib/theme';
import { Button, IconButton, useChrome } from './ui';

// How far past filling the circle a photo zooms in.
const DEEPEST = 4;
const within = (v: number, limit: number) => Math.min(limit, Math.max(-limit, v));

// Where the photo sits over the circle: its middle's offset from the circle's, and its zoom. It
// lives outside React because gestures move it on every frame.
function framer(tx: Animated.Value, ty: Animated.Value, zoom: Animated.Value) {
  // The circle's diameter and the photo's size at zoom 1, where its short side spans the circle.
  let side = 0;
  let w = 0;
  let h = 0;
  let x = 0;
  let y = 0;
  let z = 1;
  // Gestures report totals; the photo moves by what changed since the last report.
  let dx = 0;
  let dy = 0;
  let scale = 1;
  const place = (nx: number, ny: number, nz: number) => {
    z = Math.min(DEEPEST, Math.max(1, nz));
    x = within(nx, Math.max(0, (w * z - side) / 2));
    y = within(ny, Math.max(0, (h * z - side) / 2));
    tx.setValue(x);
    ty.setValue(y);
    zoom.setValue(z);
  };
  // The middle of the circle stays put while the photo grows or shrinks around it.
  const zoomBy = (factor: number) => {
    const next = Math.min(DEEPEST, Math.max(1, z * factor));
    place((x * next) / z, (y * next) / z, next);
  };
  const pan = Gesture.Pan()
    .runOnJS(true)
    .averageTouches(true)
    .onStart(() => {
      dx = 0;
      dy = 0;
    })
    .onUpdate((e) => {
      place(x + e.translationX - dx, y + e.translationY - dy, z);
      dx = e.translationX;
      dy = e.translationY;
    });
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      scale = 1;
    })
    .onUpdate((e) => {
      zoomBy(e.scale / scale);
      scale = e.scale;
    });
  return {
    gesture: Gesture.Simultaneous(pan, pinch),
    zoomBy,
    /** Starts a photo centered and whole. */
    reset: () => place(0, 0, 1),
    /** A new size on screen keeps the photo where it was, inside the circle. */
    fit(next: { side: number; w: number; h: number }) {
      ({ side, w, h } = next);
      place(x, y, z);
    },
    /** The square inside the circle, in the photo's own pixels. */
    crop(photo: Photo): Crop {
      const px = (side / Math.min(photo.width, photo.height)) * z;
      const size = Math.min(photo.width, photo.height, Math.round(side / px));
      const origin = (span: number, offset: number, pixels: number) =>
        Math.min(pixels - size, Math.max(0, Math.round(((span * z - side) / 2 - offset) / px)));
      return {
        originX: origin(w, x, photo.width),
        originY: origin(h, y, photo.height),
        width: size,
        height: size,
      };
    },
  };
}

/**
 * Frames a photo for a round profile picture, over everything: drag it, pinch (or scroll, on the
 * web) to zoom, and finish when the circle holds what should show. `onDone` gets the square to
 * cut, in the photo's own pixels.
 */
export function PhotoCrop({
  photo,
  onCancel,
  onDone,
}: {
  /** The photo to frame; the crop is open while it's set. */
  photo: Photo | null;
  onCancel: () => void;
  onDone: (crop: Crop) => void;
}) {
  const { t: tr } = useI18n();
  const { insets } = useChrome();
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [tx] = useState(() => new Animated.Value(0));
  const [ty] = useState(() => new Animated.Value(0));
  const [zoom] = useState(() => new Animated.Value(1));
  const [frame] = useState(() => framer(tx, ty, zoom));
  // The crop area once it's on screen, where browsers listen for the scroll wheel.
  const [node, setNode] = useState<View | null>(null);
  const side = Math.max(0, Math.min(area.width - 40, area.height - 40, 420));
  const fit = photo ? side / Math.min(photo.width, photo.height) : 0;
  const w = photo ? photo.width * fit : 0;
  const h = photo ? photo.height * fit : 0;
  useEffect(() => frame.reset(), [frame, photo]);
  useEffect(() => frame.fit({ side, w, h }), [frame, side, w, h]);
  // Desktop browsers zoom with the scroll wheel or a trackpad pinch, which arrive as wheel events.
  useEffect(() => {
    const element = node as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !element) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      frame.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [frame, node]);
  const cx = area.width / 2;
  const cy = area.height / 2;
  const r = side / 2;
  return (
    <Modal
      visible={!!photo}
      animationType="slide"
      onRequestClose={onCancel}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* A modal is its own window on Android, so its gestures need their own root. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.ink }}>
        <StatusBar barStyle="light-content" />
        <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }}>
          <View style={[s.between, { gap: 12, paddingHorizontal: 20 }]}>
            <IconButton icon={X} dark label={tr('Cancel crop')} onPress={onCancel} />
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={[s.h3, { flex: 1, textAlign: 'center', color: color.white }]}
            >
              {tr('Crop your photo')}
            </Text>
            <View style={{ width: 44 }} />
          </View>
          <GestureDetector gesture={frame.gesture}>
            <View
              ref={setNode}
              onLayout={(e) => setArea(e.nativeEvent.layout)}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={tr('Crop your photo')}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
              onAccessibilityAction={(e) =>
                frame.zoomBy(e.nativeEvent.actionName === 'increment' ? 1.25 : 0.8)
              }
              style={{ flex: 1, overflow: 'hidden', marginVertical: 12 }}
            >
              {!!photo && side > 0 && (
                <Animated.Image
                  source={{ uri: photo.uri }}
                  style={{
                    position: 'absolute',
                    left: cx - w / 2,
                    top: cy - h / 2,
                    width: w,
                    height: h,
                    transform: [{ translateX: tx }, { translateY: ty }, { scale: zoom }],
                  }}
                />
              )}
              {side > 0 && (
                // Dims everything outside the circle.
                <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                  <Svg width={area.width} height={area.height}>
                    <Path
                      fill="rgba(13,13,13,0.62)"
                      fillRule="evenodd"
                      d={`M0 0H${area.width}V${area.height}H0Z M${cx - r} ${cy}a${r} ${r} 0 1 0 ${side} 0a${r} ${r} 0 1 0 ${-side} 0Z`}
                    />
                    <Circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill="none"
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={2}
                    />
                  </Svg>
                </View>
              )}
            </View>
          </GestureDetector>
          <View
            style={{
              gap: 14,
              paddingHorizontal: 20,
              width: '100%',
              maxWidth: 520,
              alignSelf: 'center',
            }}
          >
            <Text style={[s.small, { textAlign: 'center', color: color.onInk }]}>
              {Platform.OS === 'web'
                ? tr('Drag to move, scroll or pinch to zoom.')
                : tr('Drag to move, pinch to zoom.')}
            </Text>
            <Button
              title={tr('Finish crop')}
              icon={Check}
              variant="inverse"
              large
              onPress={() => photo && side > 0 && onDone(frame.crop(photo))}
            />
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
