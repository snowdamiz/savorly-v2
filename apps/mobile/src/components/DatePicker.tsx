import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';
import { CalendarDays, ChevronLeft, ChevronRight } from './icons';
import { haptic } from '../lib/haptics';
import { color, font, maxFontScale, radius, s } from '../lib/theme';
import { firstDayOfWeek, formatDay, localDate, parseDay } from '../lib/utils';
import { Button, Dialog, IconButton } from './ui';

const monthOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
// Calendar titles and weekdays start with a capital, as a calendar's do ("Octobre", not "octobre").
const capital = (text: string, locale: string) =>
  text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/**
 * A date field that opens a month calendar in the shared sheet, the same on phones and the web.
 * Its value is a YYYY-MM-DD day, or '' for none; it shows the day in the reader's language, and the
 * calendar follows their locale's month and weekday names and first day of the week.
 */
export function DatePicker({
  label,
  value,
  onChange,
  placeholder,
  style,
}: {
  /** Names the field and titles the calendar. */
  label: string;
  value: string;
  onChange: (day: string) => void;
  placeholder?: string;
  /** For the field, as a Field's `style`. */
  style?: StyleProp<ViewStyle>;
}) {
  const { t: tr, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const shown = formatDay(value, locale);
  // The month on show: the chosen day's when the calendar opens, else this month.
  const [month, setMonth] = useState(() => monthOf(parseDay(value) ?? new Date()));
  const show = () => {
    setMonth(monthOf(parseDay(value) ?? new Date()));
    setOpen(true);
  };
  const choose = (day: string) => {
    haptic.select();
    onChange(day);
    setOpen(false);
  };
  const first = firstDayOfWeek(locale);
  const year = month.getFullYear();
  const index = month.getMonth();
  const today = localDate(new Date());
  // Blank cells before the 1st line it up under its weekday; the last week is padded out the same.
  const lead = (month.getDay() - first + 7) % 7;
  const length = new Date(year, index + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length }, (_, i) => i + 1),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  // 7 January 2024 was a Sunday, so day 7 + n is weekday n.
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    capital(
      new Date(2024, 0, 7 + ((first + i) % 7)).toLocaleDateString(locale, { weekday: 'short' }),
      locale,
    ),
  );
  const turn = (by: number) => setMonth(new Date(year, index + by, 1));
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={shown ? tr('{{v0}}: {{v1}}', { v0: label, v1: shown }) : label}
        onPress={show}
        style={[s.input, s.row, { gap: 10, paddingVertical: 0 }, style]}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            fontFamily: font.medium,
            fontSize: 15,
            color: shown ? color.ink : color.soft,
          }}
        >
          {shown || placeholder || label}
        </Text>
        <CalendarDays size={18} color={color.muted} strokeWidth={1.9} />
      </Pressable>
      <Dialog visible={open} onClose={() => setOpen(false)} title={label}>
        <View style={{ gap: 10 }}>
          <View style={s.between}>
            <IconButton
              icon={ChevronLeft}
              size={40}
              label={tr('Previous month')}
              onPress={() => turn(-1)}
            />
            <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={s.h3}>
              {capital(
                month.toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
                locale,
              )}
            </Text>
            <IconButton
              icon={ChevronRight}
              size={40}
              label={tr('Next month')}
              onPress={() => turn(1)}
            />
          </View>
          {/* Every day says its full date, so the weekday initials are only for the eye. */}
          <View aria-hidden style={s.row}>
            {weekdays.map((name, i) => (
              <Text
                key={i}
                numberOfLines={1}
                maxFontSizeMultiplier={maxFontScale}
                style={[s.small, { flex: 1, textAlign: 'center' }]}
              >
                {name}
              </Text>
            ))}
          </View>
          {weeks.map((week, w) => (
            <View key={w} style={[s.row, { gap: 2 }]}>
              {week.map((day, d) => {
                if (!day) return <View key={d} style={{ flex: 1 }} />;
                const date = new Date(year, index, day);
                const iso = localDate(date);
                const on = iso === value;
                const now = iso === today;
                return (
                  <Pressable
                    key={d}
                    accessibilityRole="button"
                    accessibilityLabel={date.toLocaleDateString(locale, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                    accessibilityState={{ selected: on }}
                    onPress={() => choose(iso)}
                    style={({ pressed }: { pressed: boolean }) => ({
                      flex: 1,
                      minHeight: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: radius.pill,
                      borderWidth: 1.5,
                      borderColor: on || now ? color.ink : 'transparent',
                      backgroundColor: on ? color.ink : pressed ? color.subtle : 'transparent',
                    })}
                  >
                    <Text
                      maxFontSizeMultiplier={maxFontScale}
                      style={{
                        fontFamily: on || now ? font.bold : font.medium,
                        fontSize: 15,
                        color: on ? color.white : color.ink,
                      }}
                    >
                      {day}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          <View style={[s.row, { gap: 10, marginTop: 6 }]}>
            <Button
              title={tr('Today')}
              variant="secondary"
              small
              onPress={() => choose(today)}
              style={{ flex: 1 }}
            />
            <Button
              title={tr('Clear')}
              variant="ghost"
              small
              disabled={!value}
              onPress={() => choose('')}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </Dialog>
    </>
  );
}
