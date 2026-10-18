import React from 'react';
import { Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { Recipe } from '../lib/types';
import { cookTested, finishedTenths, RecipeInsights } from '../lib/cookInsights';
import { color, font, s } from '../lib/theme';
import { BadgeCheck, Timer } from './icons';

/**
 * What cooking the recipe in Savorly showed, under its facts (docs/COOK-TESTED.md): once 5 cooks
 * verified it, "Cook-tested · 214 cooks · usually 55 min (says 40)"; before that, "Early: 3 cooks"
 * with how long they usually took from 3 of them; and, from 20 sessions, how many who started
 * finished.
 */
export function CookTested({
  recipe,
  insights,
}: {
  recipe: Recipe;
  insights?: RecipeInsights | null;
}) {
  const { t: tr } = useI18n();
  const cooks = recipe.verifiedCooks ?? 0;
  const minutes = cooks >= 3 ? recipe.cookedMinutes : null;
  const rate = insights?.finishRate ?? null;
  if (!cooks && rate === null) return null;
  // The stated time is worth repeating only when cooks' differs from it noticeably.
  const differs =
    !!minutes && Math.abs(minutes - recipe.minutes) >= Math.max(5, recipe.minutes / 10);
  const tested = cookTested(recipe);
  return (
    // Close under the facts it belongs to, in either layout's column.
    <View style={{ gap: 6, paddingHorizontal: 4, marginTop: -10 }}>
      {tested ? (
        <View style={[s.row, { gap: 8 }]}>
          <BadgeCheck size={16} color={color.success} strokeWidth={2.1} />
          <Text style={[s.small, { flex: 1 }]}>
            <Text style={{ fontFamily: font.bold, color: color.ink }}>{tr('Cook-tested')}</Text>
            {' · '}
            {!minutes
              ? tr('verifiedCookCount', { count: cooks })
              : differs
                ? tr('cookTestedSays', { count: cooks, minutes, stated: recipe.minutes })
                : tr('cookTestedUsually', { count: cooks, minutes })}
          </Text>
        </View>
      ) : (
        cooks > 0 && (
          <View style={[s.row, { gap: 8 }]}>
            <Timer size={15} color={color.muted} strokeWidth={1.9} />
            <Text style={[s.small, { flex: 1 }]}>
              {minutes
                ? `${tr('earlyCooks', { count: cooks })} · ${tr('cooksUsuallyTake', { count: minutes })}`
                : tr('earlyCooks', { count: cooks })}
            </Text>
          </View>
        )
      )}
      {rate !== null && (
        <Text style={[s.small, { paddingLeft: 24 }]}>
          {finishedTenths(rate) === 10
            ? tr('Finished by everyone who started')
            : tr('finishedByTenths', { count: finishedTenths(rate) })}
        </Text>
      )}
    </View>
  );
}
