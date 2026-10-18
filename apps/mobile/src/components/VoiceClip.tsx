import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { AudioLines, Square } from './icons';
import { useI18n } from '../lib/i18n';
import type { VoiceClip } from '../lib/family';
import { playClip, type ClipPlayback } from '../lib/voiceClip';
import { color, s } from '../lib/theme';
import { IconButton, Press } from './ui';

/**
 * Plays steps' recorded clips (lib/family.ts), one at a time: starting one stops the last, and
 * leaving the screen stops it. `playing` is the key of the step playing, or null.
 */
export function useVoiceClip() {
  const [playing, setPlaying] = useState<string | null>(null);
  const current = useRef<ClipPlayback | null>(null);
  const stop = useCallback(() => {
    current.current?.stop();
    current.current = null;
    setPlaying(null);
  }, []);
  const play = useCallback((key: string, clip: VoiceClip) => {
    current.current?.stop();
    const playback: ClipPlayback = playClip(clip.url, clip.startMs, clip.endMs, () => {
      if (current.current !== playback) return;
      current.current = null;
      setPlaying(null);
    });
    current.current = playback;
    setPlaying(key);
  }, []);
  useEffect(() => () => current.current?.stop(), []);
  return { playing, play, stop };
}

/** Cooking mode's control for a step's clip, beside read-aloud: the speaker's name is its label. */
export function VoiceButton({
  clip,
  playing,
  onPress,
}: {
  clip: VoiceClip;
  playing: boolean;
  onPress: () => void;
}) {
  const { t: tr } = useI18n();
  return (
    <IconButton
      icon={playing ? Square : AudioLines}
      dark
      size={58}
      label={
        playing
          ? tr('Stop {{v0}}’s voice', { v0: clip.speaker })
          : tr('Play {{v0}}’s voice', { v0: clip.speaker })
      }
      onPress={onPress}
    />
  );
}

/** The recipe page's quiet link to a step's clip, on the line under the step. */
export function VoiceLink({
  clip,
  playing,
  onPress,
}: {
  clip: VoiceClip;
  playing: boolean;
  onPress: () => void;
}) {
  const { t: tr } = useI18n();
  const Icon = playing ? Square : AudioLines;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={
        playing
          ? tr('Stop {{v0}}’s voice', { v0: clip.speaker })
          : tr('Play {{v0}}’s voice', { v0: clip.speaker })
      }
      onPress={onPress}
      hitSlop={8}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <Icon size={14} color={color.ink} strokeWidth={2} />
      <Text style={[s.small, { color: color.ink }]}>
        {tr('{{v0}}’s voice', { v0: clip.speaker })}
      </Text>
    </Press>
  );
}
