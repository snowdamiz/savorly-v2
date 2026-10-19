import React, { createContext, useContext } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, LucideIcon } from './icons';
import { color, s } from '../lib/theme';
import { Press } from './ui';

// Inside a SettingsGroup, rows share its card and a line between them, rather than a card each.
const Grouped = createContext(false);

/**
 * A section of the Settings page: a quiet heading over one card of rows. Rows that render nothing
 * (a setting this device or server doesn't have) leave no gap and no stray line.
 */
export function SettingsGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      {title && (
        <Text role="heading" aria-level={2} style={[s.label, { marginLeft: 4 }]}>
          {title}
        </Text>
      )}
      <View style={[s.card, { padding: 0, overflow: 'hidden' }]}>
        {/* Each row draws the line above it; the first one's sits just outside the card. */}
        <View style={{ marginTop: -StyleSheet.hairlineWidth }}>
          <Grouped.Provider value>{children}</Grouped.Provider>
        </View>
      </View>
    </View>
  );
}

/** A row of settings that opens its sheet, like Language. */
export function SettingsRow({
  icon: Icon,
  title,
  text,
  detail,
  label,
  busy,
  danger,
  action,
  onPress,
}: {
  icon: LucideIcon;
  title: string;
  /** The current setting, under the title. */
  text?: string;
  /** A fainter line under that, for details only support needs. */
  detail?: string;
  /** What a screen reader says, when it should differ from the title. */
  label?: string;
  /** Working: a spinner in place of the chevron. */
  busy?: boolean;
  /** Something that can't be undone, like deleting the account. */
  danger?: boolean;
  /** Done at once, like signing out, rather than opening a sheet: no chevron. */
  action?: boolean;
  onPress: () => void;
}) {
  const grouped = useContext(Grouped);
  const tint = danger ? color.error : color.ink;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label || title}
      onPress={onPress}
      scale={grouped ? 1 : undefined}
      style={[
        !grouped && s.card,
        s.row,
        { gap: 14, padding: 14 },
        grouped && {
          paddingHorizontal: 16,
          minHeight: 60,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderColor: color.border,
        },
      ]}
    >
      <Icon size={grouped ? 22 : 24} color={tint} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.h3, grouped && { fontSize: 15 }, danger && { color: tint }]}>{title}</Text>
        {!!text && <Text style={s.small}>{text}</Text>}
        {!!detail && <Text style={[s.small, { color: color.soft }]}>{detail}</Text>}
      </View>
      {busy ? (
        <ActivityIndicator color={color.soft} />
      ) : (
        !action && <ChevronRight size={18} color={color.soft} />
      )}
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
