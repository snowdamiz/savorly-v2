import React from 'react';
import { Pressable, Text } from 'react-native';
import { color, font, radius } from '../lib/theme';

/** The confirming button of something that can't be undone (deleting, leaving, removing). */
export function DangerButton({
  title,
  onPress,
  busy,
  disabled,
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        minHeight: 52,
        borderRadius: radius.pill,
        backgroundColor: color.error,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled || busy ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: font.bold, fontSize: 15, color: color.white }}>{title}</Text>
    </Pressable>
  );
}
