import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Text, View } from 'react-native';
import { Mic, MicOff, Square, Volume2 } from './icons';
import { color, radius, s } from '../lib/theme';
import { Button, animate, motionReduced } from './ui';

// The end of what was just said, from a word boundary, so the newest words stay in view.
function latest(text: string, max = 150) {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const space = cut.indexOf(' ');
  return '…' + (space >= 0 && space < 24 ? cut.slice(space + 1) : cut);
}
// Minutes and seconds, as a call's clock shows them.
function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
// Bars that sway while the microphone is open, and rest while it connects or is muted.
const barHeights = [0.5, 0.9, 0.6, 1, 0.45];
const barBeats = [460, 340, 520, 400, 580];
function VoiceBars({ active }: { active: boolean }) {
  const [bars] = useState(() => barHeights.map((v) => new Animated.Value(v)));
  useEffect(() => {
    if (!active || motionReduced()) {
      bars.forEach((b, i) => b.setValue(active ? barHeights[i] : 0.25));
      return;
    }
    const loops = bars.map((b, i) =>
      Animated.loop(Animated.sequence([animate(b, 1, barBeats[i]), animate(b, 0.3, barBeats[i])])),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, bars]);
  return (
    <View style={[s.row, { gap: 3, height: 22 }]}>
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={{
            width: 4,
            height: 22,
            borderRadius: 2,
            backgroundColor: color.white,
            transform: [{ scaleY: b }],
          }}
        />
      ))}
    </View>
  );
}

/**
 * A live call's controls, in the composer's place under the conversation: who has the floor,
 * the call's clock (or what's left of the plan's voice time), the newest words, and mute and
 * end.
 */
export function StudioVoiceBar({
  connecting,
  muted,
  status,
  seconds,
  limit,
  caption,
  audioBlocked,
  onEnableAudio,
  onMute,
  onEnd,
}: {
  connecting: boolean;
  muted: boolean;
  /** What the call is doing now, in the member's language. */
  status: string;
  /** How long this session has run. */
  seconds: number;
  /** The seconds this session has when the plan's voice time ends with it, else null. */
  limit: number | null;
  caption: { role: 'user' | 'assistant'; text: string } | null;
  audioBlocked: boolean;
  onEnableAudio: () => void;
  onMute: () => void;
  onEnd: () => void;
}) {
  const { t: tr } = useI18n();
  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.ink,
        padding: 16,
        paddingTop: 14,
        gap: 14,
      }}
    >
      <View style={[s.row, { gap: 12, minHeight: 24 }]}>
        {connecting ? (
          <ActivityIndicator size="small" color={color.white} />
        ) : (
          <VoiceBars active={!muted} />
        )}
        <Text
          accessibilityLiveRegion="polite"
          numberOfLines={1}
          style={{ ...s.h3, color: color.white, flex: 1 }}
        >
          {status}
        </Text>
        <Text style={{ ...s.small, color: color.onInk, fontVariant: ['tabular-nums'] }}>
          {limit === null
            ? clock(seconds)
            : tr('{{v0}} left', { v0: clock(Math.max(0, limit - seconds)) })}
        </Text>
      </View>
      {caption?.text.trim() ? (
        <View style={{ gap: 4 }}>
          <Text style={{ ...s.label, color: color.onInk }}>
            {caption.role === 'user' ? tr('You') : tr('Sous-chef')}
          </Text>
          <Text numberOfLines={3} style={{ ...s.body, color: color.white }}>
            {latest(caption.text)}
          </Text>
        </View>
      ) : (
        <Text style={{ ...s.muted, color: color.onInk }}>
          {tr('Talk naturally. Interrupt or correct me anytime.')}
        </Text>
      )}
      {audioBlocked && (
        <Button
          title={tr('Enable assistant audio')}
          icon={Volume2}
          small
          variant="glass"
          onPress={onEnableAudio}
        />
      )}
      <View style={[s.row, { gap: 10 }]}>
        <Button
          title={muted ? tr('Unmute') : tr('Mute')}
          label={muted ? tr('Resume microphone') : tr('Mute microphone')}
          icon={muted ? Mic : MicOff}
          variant="glass"
          disabled={connecting}
          onPress={onMute}
          style={{ flex: 1 }}
        />
        <Button
          title={tr('End voice')}
          icon={Square}
          variant="inverse"
          onPress={onEnd}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}
