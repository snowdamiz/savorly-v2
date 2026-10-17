import React from 'react';
import { Text, View } from 'react-native';
import { ChevronRight, LucideIcon } from './icons';
import { color, s } from '../lib/theme';
import { Press } from './ui';

/** A row of My kitchen's settings that opens its sheet, like Language. */
export function SettingsRow({
  icon: Icon,
  title,
  text,
  label,
  onPress,
}: {
  icon: LucideIcon;
  title: string;
  /** The current setting, under the title. */
  text?: string;
  /** What a screen reader says, when it should differ from the title. */
  label?: string;
  onPress: () => void;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label || title}
      onPress={onPress}
      style={[s.card, s.row, { gap: 14, padding: 14 }]}
    >
      <Icon size={24} color={color.ink} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.h3}>{title}</Text>
        {!!text && <Text style={s.small}>{text}</Text>}
      </View>
      <ChevronRight size={18} color={color.soft} />
    </Press>
  );
}

/** A failed request's message, shown where it happened. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <View style={{ backgroundColor: color.errorBg, borderRadius: 16, padding: 14 }}>
      <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
        {message}
      </Text>
    </View>
  );
}
