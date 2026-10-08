import { useI18n } from '../lib/i18n';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { allCuisines, cuisineFilters } from '../lib/cuisines';
import { color, font, radius } from '../lib/theme';
import { CuisineIcon } from './CuisineIcon';
import { SectionTitle, useChrome } from './ui';

export function CuisineBrowser({
  value,
  onChange,
  onSeeAll,
}: {
  value: string;
  onChange: (cuisine: string) => void;
  onSeeAll: () => void;
}) {
  const { t: tr } = useI18n();
  const { compact, gutter } = useChrome();
  return (
    <View>
      <SectionTitle title={tr('Cuisines')} action={onSeeAll} actionTitle={tr('See all cuisines')} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginHorizontal: compact ? -gutter : 0 }}
        contentContainerStyle={{ gap: 10, paddingHorizontal: compact ? gutter : 0 }}
      >
        {cuisineFilters.map((name) => {
          const active = value === name;
          return (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={
                name === allCuisines
                  ? tr('Browse all cuisines')
                  : tr('Browse {{v0}} recipes', { v0: tr(name) })
              }
              accessibilityState={{ selected: active }}
              aria-pressed={active}
              onPress={() => onChange(name)}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
                minHeight: 44,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: active ? color.ink : color.border,
                backgroundColor: active ? color.ink : color.white,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                paddingHorizontal: 14,
                paddingVertical: 6,
                gap: 7,
                opacity: hovered ? 0.86 : 1,
                transform: [{ scale: pressed ? 0.96 : 1 }],
              })}
            >
              <CuisineIcon name={name} size={28} />
              <Text
                style={{
                  fontFamily: font.semibold,
                  fontSize: 13,
                  lineHeight: 18,
                  textAlign: 'center',
                  color: active ? color.white : color.ink,
                }}
              >
                {name === allCuisines ? tr('All cuisines') : tr(name)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
