// The "Founding creator" mark (docs/CREATOR-FUND.md): a small badge under a founding creator's
// name on their profile. Author lines say it in words beside the name (RecipeRow, the recipe page).
import React from 'react';
import { View } from 'react-native';
import { Award } from './icons';
import { useI18n } from '../lib/i18n';
import { Creator } from '../lib/types';
import { Pill } from './ui';

export function FoundingMark({ creator }: { creator: Pick<Creator, 'founding'> }) {
  const { t } = useI18n();
  if (!creator.founding) return null;
  return (
    <View style={{ alignSelf: 'center' }}>
      <Pill title={t('Founding creator')} icon={Award} />
    </View>
  );
}
