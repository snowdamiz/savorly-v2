import React from 'react';
import { Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { Recipe } from '../lib/types';
import { color, s } from '../lib/theme';
import { Timer } from './icons';

/**
 * How long the recipe really takes, beside the time its cook gives: the median of verified cooks
 * from cooking mode, which the server sends once 3 of them agree (docs/CREATOR-FUND.md).
 */
export function CookTime({ recipe }: { recipe: Recipe }) {
  const { t: tr } = useI18n();
  const minutes = recipe.cookedMinutes;
  if (!minutes || (recipe.verifiedCooks ?? 0) < 3) return null;
  return (
    // Close under the facts it belongs to, in either layout's column.
    <View style={[s.row, { gap: 8, paddingHorizontal: 4, marginTop: -10 }]}>
      <Timer size={15} color={color.muted} strokeWidth={1.9} />
      <Text style={[s.small, { flex: 1 }]}>{tr('cooksUsuallyTake', { count: minutes })}</Text>
    </View>
  );
}
