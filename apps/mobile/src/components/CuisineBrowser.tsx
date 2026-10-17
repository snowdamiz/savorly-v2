import { useI18n } from '../lib/i18n';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { allCuisines, cuisineFilters } from '../lib/cuisines';
import { haptic } from '../lib/haptics';
import { color, font } from '../lib/theme';
import { CuisineIcon } from './CuisineIcon';
import { Rail, SectionTitle } from './ui';

// Illustrated tiles rather than a row of chips, so cuisines read as places to browse and Explore's
// category chips stay the only filter strip. There is no "All" tile: on home each cuisine is a way
// in; in Explore the chosen one is highlighted and choosing it again goes back to every cuisine.
// Without `onSeeAll` the row sits under the search with no heading of its own.
export function CuisineBrowser({
  value,
  onChange,
  onSeeAll,
}: {
  value?: string;
  onChange: (cuisine: string) => void;
  onSeeAll?: () => void;
}) {
  const { t: tr } = useI18n();
  const names = cuisineFilters.filter((n) => n !== allCuisines);
  return (
    <View>
      {onSeeAll && (
        <SectionTitle
          title={tr('Cuisines')}
          action={onSeeAll}
          actionTitle={tr('See all cuisines')}
        />
      )}
      <Rail gap={6} pad={12}>
        {names.map((name) => {
          const active = value === name;
          return (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={tr('Browse {{v0}} recipes', { v0: tr(name) })}
              accessibilityState={{ selected: active }}
              aria-pressed={active}
              onPress={() => {
                if (!active) haptic.select();
                onChange(active ? allCuisines : name);
              }}
              style={{ width: 78, alignItems: 'center', gap: 8 }}
            >
              {({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => (
                <>
                  <View
                    style={{
                      width: 66,
                      height: 66,
                      borderRadius: 24,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: active ? color.ink : color.white,
                      borderWidth: 1,
                      borderColor: active || hovered ? color.ink : color.outline,
                      boxShadow: active ? '0px 6px 14px rgba(0,0,0,0.16)' : undefined,
                      transform: [{ scale: pressed ? 0.93 : 1 }],
                    }}
                  >
                    <CuisineIcon name={name} size={40} />
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{
                      fontFamily: active ? font.bold : font.semibold,
                      fontSize: 12,
                      lineHeight: 16,
                      textAlign: 'center',
                      color: active ? color.ink : color.muted,
                    }}
                  >
                    {tr(name)}
                  </Text>
                </>
              )}
            </Pressable>
          );
        })}
      </Rail>
    </View>
  );
}
