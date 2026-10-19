import React, { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoContentFit, VideoView } from 'expo-video';
import { useI18n } from '../lib/i18n';
import { color, radius } from '../lib/theme';
import { Play } from './icons';
import { motionReduced } from './ui';

type Player = ReturnType<typeof useVideoPlayer>;

/**
 * Starts a player. In a browser it asks the page's video itself, whose answer is a promise that
 * fails when the browser won't play or the video goes away before it starts; neither is an error.
 */
function usePlay(player: Player, view: RefObject<VideoView | null>) {
  return useCallback(() => {
    const video =
      Platform.OS === 'web' ? (view.current?.nativeRef.current as HTMLVideoElement | null) : null;
    if (video) void video.play().catch(() => {});
    else player.play();
  }, [player, view]);
}

/**
 * A video with the platform's own controls, still until it's played, or at once with `autoPlay`
 * for one a tap just asked for. `style` sizes it (280 points tall by default); a fixed aspect
 * ratio keeps the page around it from moving as the video arrives. `label` names it.
 */
export function VideoPlayer({
  uri,
  label,
  style,
  autoPlay,
}: {
  uri: string;
  label?: string;
  style?: StyleProp<ViewStyle>;
  autoPlay?: boolean;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  const view = useRef<VideoView>(null);
  const play = usePlay(player, view);
  useEffect(() => {
    if (autoPlay) play();
  }, [autoPlay, play]);
  return (
    <View
      role={label ? 'group' : undefined}
      aria-label={label}
      style={[styles.frame, style ?? styles.tall]}
    >
      <VideoView
        ref={view}
        player={player}
        style={styles.fill}
        nativeControls
        contentFit="contain"
      />
    </View>
  );
}

// Phones load and buffer a video as soon as it has a player, so a recipe with a clip on every step
// would download them all as it opens; there a clip gets its player when it's first played. A
// browser only reads a video's first frame until then, so the web shows the video straight away.
const playerAtOnce = Platform.OS === 'web';
// On iPhones a video that plays, even a silent one, takes over the app's audio session, which
// would stop a live voice chat with the sous-chef hearing the cook; there clips wait for a tap.
const playsByItself = Platform.OS !== 'ios';

/** Stands in for a clip until it's played: a dark frame with a play button. */
function PlayCover({
  label,
  onPress,
  style,
}: {
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.frame, styles.center, style]}
    >
      <View style={styles.badge}>
        <Play size={20} color={color.white} fill={color.white} strokeWidth={2} />
      </View>
    </Pressable>
  );
}

/**
 * A step's clip on the recipe page, played with the shared player and its controls. It never
 * starts by itself.
 */
export function StepVideo({
  uri,
  step,
  style,
}: {
  uri: string;
  /** The step's number, from 1. */
  step: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { t: tr } = useI18n();
  const [started, setStarted] = useState(playerAtOnce);
  return started ? (
    <VideoPlayer
      uri={uri}
      label={tr('Clip of step {{v0}}', { v0: step })}
      style={style}
      autoPlay={!playerAtOnce}
    />
  ) : (
    <PlayCover
      label={tr('Play the clip of step {{v0}}', { v0: step })}
      onPress={() => setStarted(true)}
      style={style}
    />
  );
}

/**
 * A step's clip as a moving picture: muted and looping, played and paused with a tap. With
 * `autoPlay` it starts by itself, except on iPhones and for a cook who has asked their device
 * for less motion.
 */
export function StepClip({
  uri,
  step,
  autoPlay,
  fit = 'contain',
  style,
}: {
  uri: string;
  /** The step's number, from 1. */
  step: number;
  autoPlay?: boolean;
  fit?: VideoContentFit;
  style?: StyleProp<ViewStyle>;
}) {
  const { t: tr } = useI18n();
  // Whether it plays as soon as it has a player: by itself, or because the cover was tapped.
  const [playNow, setPlayNow] = useState(() => !!autoPlay && playsByItself && !motionReduced());
  return playerAtOnce || playNow ? (
    <LoopingClip uri={uri} step={step} autoPlay={playNow} fit={fit} style={style} />
  ) : (
    <PlayCover
      label={tr('Play the clip of step {{v0}}', { v0: step })}
      onPress={() => setPlayNow(true)}
      style={style}
    />
  );
}

/** Whether a step's clip may start by itself here: not on iPhones, and not with reduced motion. */
export const clipsPlayThemselves = () => playsByItself && !motionReduced();

/**
 * A step's clip behind cooking mode: muted, looping and filling the screen, with nothing to tap.
 * Only where clips may play by themselves (`clipsPlayThemselves`).
 */
export function BackdropClip({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.audioMixingMode = 'mixWithOthers';
  });
  const view = useRef<VideoView>(null);
  const play = usePlay(player, view);
  useEffect(() => play(), [play]);
  return (
    <VideoView
      ref={view}
      player={player}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      nativeControls={false}
      contentFit="cover"
      playsInline
    />
  );
}

function LoopingClip({
  uri,
  step,
  autoPlay,
  fit,
  style,
}: {
  uri: string;
  step: number;
  autoPlay: boolean;
  fit: VideoContentFit;
  style?: StyleProp<ViewStyle>;
}) {
  const { t: tr } = useI18n();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    // Silent, it lets the cook's music, or a step being read aloud, carry on.
    p.audioMixingMode = 'mixWithOthers';
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const view = useRef<VideoView>(null);
  const play = usePlay(player, view);
  useEffect(() => {
    if (autoPlay) play();
  }, [autoPlay, play]);
  return (
    <View style={[styles.frame, style]}>
      <VideoView
        ref={view}
        player={player}
        style={styles.fill}
        nativeControls={false}
        contentFit={fit}
        playsInline
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          isPlaying
            ? tr('Pause the clip of step {{v0}}', { v0: step })
            : tr('Play the clip of step {{v0}}', { v0: step })
        }
        onPress={() => (isPlaying ? player.pause() : play())}
        style={[StyleSheet.absoluteFill, styles.center]}
      >
        {!isPlaying && (
          <View style={styles.badge}>
            <Play size={20} color={color.white} fill={color.white} strokeWidth={2} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: radius.md,
    backgroundColor: color.ink,
  },
  tall: { height: 280 },
  fill: { width: '100%', height: '100%' },
  center: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(13,13,13,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
});
