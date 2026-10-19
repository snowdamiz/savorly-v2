import React, { useEffect, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useI18n } from '../lib/i18n';
import { sized } from '../lib/images';
import { lineCount, STEP_TYPES, stepType } from '../lib/stepFit';
import { color, font, radius, s } from '../lib/theme';
import { ArrowLeft, Check, LucideIcon, Pause, Play, RotateCcw, X } from './icons';
import { animate, frost, IconButton, Press, useChrome } from './ui';
import { BackdropClip, clipsPlayThemselves, StepClip } from './VideoPlayer';

// The pieces cooking mode is made of, for one recipe and for a meal: the step's picture filling the
// screen under a vignette, a bar with the title and one quiet status line, a step that fits the
// screen without scrolling (its words at the largest size that fits), and the step's timer.

/** Quiet text over the picture: a little brighter than on plain ink, with a soft shadow. */
export const onPhoto = 'rgba(255,255,255,0.72)';
const shade = {
  textShadowColor: 'rgba(0,0,0,0.45)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 12,
};

/** The step's picture: its photo, or its clip, which shows how. */
export type StepMedia = { kind: 'clip' | 'photo'; uri: string; step: number };

/**
 * Behind cooking mode: the step's clip or photo filling the screen, under a vignette that keeps the
 * words and buttons readable. A step without a picture of its own (or a clip that can't play by
 * itself here) shows the recipe's photo, blurred, so the screen keeps its look from step to step.
 */
export function CookBackdrop({ media, cover }: { media?: StepMedia | null; cover?: string }) {
  const { width, height } = useWindowDimensions();
  const clip = media?.kind === 'clip' && clipsPlayThemselves() ? media.uri : '';
  const photo = media?.kind === 'photo' ? media.uri : '';
  const still = clip ? '' : photo || cover || '';
  const soft = !photo;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color.ink }]}>
      {clip ? (
        <BackdropClip key={clip} uri={clip} />
      ) : still ? (
        <Image
          // One image whose source changes, so one step's picture fades into the next.
          source={{ uri: sized(still, soft ? 480 : Math.min(Math.max(width, height) * 2, 1600)) }}
          contentFit="cover"
          blurRadius={soft ? 28 : 0}
          transition={350}
          cachePolicy="memory-disk"
          accessibilityIgnoresInvertColors
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {!!(clip || still) && (
        <>
          {/* Darkest behind the words at the top and the buttons at the bottom. */}
          <LinearGradient
            colors={[
              'rgba(13,13,13,0.88)',
              'rgba(13,13,13,0.58)',
              'rgba(13,13,13,0.42)',
              'rgba(13,13,13,0.94)',
            ]}
            locations={[0, 0.42, 0.62, 1]}
            style={StyleSheet.absoluteFill}
          />
          <Svg
            style={StyleSheet.absoluteFill}
            width="100%"
            height="100%"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <Defs>
              <RadialGradient
                id="cookVignette"
                cx="50"
                cy="50"
                r="71"
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0.45" stopColor="#000" stopOpacity="0" />
                <Stop offset="1" stopColor="#000" stopOpacity="0.7" />
              </RadialGradient>
            </Defs>
            <Rect x="0" y="0" width="100" height="100" fill="url(#cookVignette)" />
          </Svg>
        </>
      )}
    </View>
  );
}

/**
 * The step's photo or clip on its own, whole and unshaded; the back button, or a tap on a photo,
 * goes back to the step.
 */
export function StepMediaView({ media, onClose }: { media: StepMedia; onClose: () => void }) {
  const { t: tr } = useI18n();
  const { insets } = useChrome();
  const [shown] = useState(() => new Animated.Value(0));
  useEffect(() => animate(shown, 1, 260).start(), [shown]);
  const close = () => animate(shown, 0, 180).start(() => onClose());
  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.view, { opacity: shown }]}>
        {media.kind === 'clip' ? (
          <StepClip
            uri={media.uri}
            step={media.step}
            autoPlay
            fit="contain"
            style={{ flex: 1, borderRadius: 0 }}
          />
        ) : (
          <Pressable accessible={false} onPress={close} style={StyleSheet.absoluteFill}>
            <Image
              source={{ uri: sized(media.uri, 1600) }}
              contentFit="contain"
              cachePolicy="memory-disk"
              accessibilityLabel={tr('Photo of step {{v0}}', { v0: media.step })}
              style={StyleSheet.absoluteFill}
            />
          </Pressable>
        )}
      </Animated.View>
      {/* Outside the fade: glass that appears under something see-through never draws. */}
      <View style={{ position: 'absolute', top: insets.top + 12, left: 20 }}>
        <IconButton icon={ArrowLeft} dark label={tr('Back')} onPress={close} />
      </View>
    </View>
  );
}

/**
 * Cooking mode's bar: close, a title if the screen needs one, one quiet line for what's going on
 * (listening, reading, translated), and the actions on the right.
 */
export function CookBar({
  title,
  status = [],
  onClose,
  children,
}: {
  title?: string;
  /** Each a few words or a small row; empty ones are left out, the rest joined with dots. */
  status?: React.ReactNode[];
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const { t: tr } = useI18n();
  const shown = status.filter((item) => item !== null && item !== false && item !== '');
  return (
    <View style={[s.row, { gap: 12 }]}>
      <IconButton icon={X} dark label={tr('Close cooking mode')} onPress={onClose} />
      <View style={{ flex: 1, gap: 2, paddingLeft: 2 }}>
        {!!title && (
          <Text numberOfLines={1} style={[styles.barTitle, shade]}>
            {title}
          </Text>
        )}
        {shown.length > 0 && (
          <View style={[s.row, { gap: 6, overflow: 'hidden' }]}>
            {shown.map((item, i) => (
              <React.Fragment key={i}>
                {i > 0 && <Text style={styles.status}>·</Text>}
                {typeof item === 'string' ? (
                  <Text numberOfLines={1} style={[styles.status, { flexShrink: 1 }]}>
                    {item}
                  </Text>
                ) : (
                  item
                )}
              </React.Fragment>
            ))}
          </View>
        )}
      </View>
      {children}
    </View>
  );
}

/** One quiet line under a step's text; a link when it opens something. */
export type StepNote = {
  key: string;
  icon: LucideIcon;
  text: string;
  /** After the text, quieter, such as where a list came from. */
  aside?: string;
  /** What a screen reader says for it, when the words alone don't say enough. */
  label?: string;
  onPress?: () => void;
};

// Heights (at the system's text size) of what sits around the title and text.
const EYEBROW = 15 + 10 + 10;
const NOTES_GAP = 16;
const NOTE_LINE = 22;
const BELOW = 16 + 96;

/**
 * A step on one screen: the eyebrow, title and text at the largest size that fits, and quiet notes
 * under them. The size is worked out from the words before they're drawn, and taken down a size
 * more if they still run over; a step too long even at the smallest size scrolls.
 */
export function FittedStep({
  eyebrow,
  title,
  text = '',
  notes = [],
  below,
}: {
  eyebrow: React.ReactNode;
  title: string;
  text?: string;
  notes?: StepNote[];
  /** Under the notes, such as the answer to a question asked hands-free. */
  below?: React.ReactNode;
}) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const big = windowWidth > 600;
  const noteText = notes.map((n) => `${n.text}${n.aside ? ` · ${n.aside}` : ''}      `).join('');
  const reserved =
    (EYEBROW +
      (notes.length ? NOTES_GAP + lineCount(noteText, 13, box.width) * NOTE_LINE : 0) +
      (below ? BELOW : 0)) *
    fontScale;
  const base = stepType({
    title,
    text,
    width: box.width,
    height: box.height,
    big,
    reserved,
    fontScale,
  });
  // Everything that changes how the words fit; a change fits them afresh.
  const key = [title, text, box.width, box.height, notes.length, !!below, fontScale].join('\n');
  // The words' height as drawn: their layout reports every change, so it's always the latest.
  const [measured, setMeasured] = useState(0);
  // The estimate errs toward fitting; words measured running over go down a size, once for each
  // measurement, until they fit.
  const [fit, setFit] = useState({ key: '', down: 0, over: 0 });
  const down = fit.key === key ? fit.down : 0;
  const last = STEP_TYPES.length - 1;
  const level = Math.min(base + down, last);
  const type = STEP_TYPES[level];
  const over = !!box.height && measured > box.height + 1 && level < last;
  if (over && (fit.key !== key || fit.over !== measured))
    setFit({ key, down: down + 1, over: measured });
  return (
    <View
      style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width !== box.width || height !== box.height) setBox({ width, height });
      }}
    >
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View
          // Until the room is known, the words would be drawn at a guess.
          style={{ opacity: box.height ? 1 : 0 }}
          onLayout={(e) => setMeasured(e.nativeEvent.layout.height)}
        >
          <View style={{ marginBottom: 10 }}>{eyebrow}</View>
          <Text
            style={[
              s.display,
              shade,
              {
                color: color.white,
                fontSize: type.title,
                lineHeight: type.titleLine,
                letterSpacing: type.title * -0.034,
                marginBottom: 10,
              },
            ]}
          >
            {title}
          </Text>
          {!!text && (
            <Text
              style={[
                shade,
                {
                  color: 'rgba(255,255,255,0.9)',
                  fontFamily: font.medium,
                  fontSize: type.text,
                  lineHeight: type.textLine,
                },
              ]}
            >
              {text}
            </Text>
          )}
          {notes.length > 0 && (
            <View
              style={[s.row, { flexWrap: 'wrap', columnGap: 18, rowGap: 6, marginTop: NOTES_GAP }]}
            >
              {notes.map((note) => (
                <Note key={note.key} note={note} />
              ))}
            </View>
          )}
          {!!below && <View style={{ marginTop: 16 }}>{below}</View>}
        </View>
      </ScrollView>
    </View>
  );
}

/** The step's small label above its title, as quiet as the notes. */
export function StepEyebrow({ children }: { children: string }) {
  return <Text style={[s.label, shade, { color: onPhoto, flexShrink: 1 }]}>{children}</Text>;
}

function Note({ note }: { note: StepNote }) {
  const { icon: Icon, onPress } = note;
  const ink = onPress ? color.white : onPhoto;
  const body = (
    <>
      <Icon size={14} color={ink} strokeWidth={2} />
      <Text style={[styles.note, shade, { color: ink }, onPress && styles.link]}>{note.text}</Text>
      {!!note.aside && (
        <>
          <Text style={[styles.note, shade]}>·</Text>
          <Text style={[styles.note, shade]}>{note.aside}</Text>
        </>
      )}
    </>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={note.label}
      hitSlop={8}
      onPress={onPress}
      style={[s.row, { gap: 6 }]}
    >
      {body}
    </Pressable>
  ) : (
    <View
      accessible={!!note.label}
      accessibilityLabel={note.label}
      style={[s.row, { gap: 6, flexShrink: 1 }]}
    >
      {body}
    </View>
  );
}

const clock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

const RING = 26;
const CIRCUMFERENCE = 2 * Math.PI * RING;

/**
 * A step's timer as a glass bar as wide as the buttons under it: the start and pause button with a
 * ring that empties as the time runs down (green when it's up), the time left in the middle, and a
 * reset once it has moved.
 */
export function StepTimer({
  remaining,
  length,
  running,
  onToggle,
  onReset,
}: {
  remaining: number;
  length: number;
  running: boolean;
  onToggle: () => void;
  onReset: () => void;
}) {
  const { t: tr } = useI18n();
  const { width } = useWindowDimensions();
  const big = width > 600;
  const finished = remaining === 0;
  const left = finished ? 1 : length ? remaining / length : 0;
  const Icon = finished ? Check : running ? Pause : Play;
  return (
    <View style={[styles.timer, frost(24)]}>
      {/* In the middle of the bar, whatever is beside it. */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.middle]}>
        <Text accessibilityLiveRegion="polite" style={[styles.clock, { fontSize: big ? 36 : 32 }]}>
          {clock(remaining)}
        </Text>
      </View>
      <Press
        accessibilityRole="button"
        accessibilityLabel={
          running ? tr('Pause timer') : finished ? tr('Timer finished') : tr('Start timer')
        }
        accessibilityState={{ disabled: finished }}
        aria-disabled={finished}
        onPress={finished ? undefined : onToggle}
        scale={finished ? 1 : 0.94}
        style={styles.timerButton}
      >
        <Svg width={56} height={56} style={StyleSheet.absoluteFill}>
          <Circle
            cx={28}
            cy={28}
            r={RING}
            stroke="rgba(255,255,255,0.2)"
            strokeWidth={3}
            fill="none"
          />
          <Circle
            cx={28}
            cy={28}
            r={RING}
            stroke={finished ? '#3CCB7A' : color.white}
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE}`}
            strokeDashoffset={CIRCUMFERENCE * (1 - left)}
            transform="rotate(-90 28 28)"
          />
        </Svg>
        <View style={styles.timerFace}>
          <Icon
            size={18}
            color={finished ? color.success : color.ink}
            fill={running || finished ? 'none' : color.ink}
            strokeWidth={2.6}
          />
        </View>
      </Press>
      <View style={{ flex: 1 }} />
      {(running || remaining !== length) && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('Reset timer')}
          hitSlop={6}
          onPress={onReset}
          style={styles.reset}
        >
          <RotateCcw size={19} color={onPhoto} strokeWidth={2.2} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  view: { backgroundColor: color.ink, justifyContent: 'center' },
  barTitle: { color: 'rgba(255,255,255,0.9)', fontFamily: font.semibold, fontSize: 14 },
  status: { fontFamily: font.semibold, fontSize: 12, lineHeight: 16, color: onPhoto },
  note: { fontFamily: font.semibold, fontSize: 13, lineHeight: 18, color: onPhoto, flexShrink: 1 },
  link: { textDecorationLine: 'underline' },
  middle: { alignItems: 'center', justifyContent: 'center' },
  timer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 64,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(13,13,13,0.55)',
    borderWidth: 1,
    borderColor: color.glassBorder,
  },
  timerButton: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  timerFace: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clock: {
    fontFamily: font.bold,
    letterSpacing: -1,
    color: color.white,
    fontVariant: ['tabular-nums'],
  },
  reset: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
});
