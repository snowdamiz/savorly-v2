import React from 'react';
import { Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { FoodConflict, FoodReason, joinNames } from '../lib/food';
import { dietOptions } from '../lib/profile';
import { Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { AlertTriangle } from './icons';
import { Pill } from './ui';

type Translate = ReturnType<typeof useI18n>['t'];

/** An allergen or diet group's name, as a heading word: "Peanuts", "Gluten", "Pork". */
export function groupName(tr: Translate, group: string) {
  switch (group) {
    case 'milk':
      return tr('Milk');
    case 'egg':
      return tr('Eggs');
    case 'fish':
      return tr('Fish');
    case 'shellfish':
      return tr('Shellfish');
    case 'mollusc':
      return tr('Molluscs');
    case 'treenut':
      return tr('Tree nuts');
    case 'peanut':
      return tr('Peanuts');
    case 'gluten':
      return tr('Gluten');
    case 'soy':
      return tr('Soy');
    case 'sesame':
      return tr('Sesame');
    case 'celery':
      return tr('Celery');
    case 'mustard':
      return tr('Mustard');
    case 'lupin':
      return tr('Lupin');
    case 'sulphite':
      return tr('Sulphites');
    case 'meat':
      return tr('Meat');
    case 'pork':
      return tr('Pork');
    case 'poultry':
      return tr('Poultry');
    case 'alcohol':
      return tr('Alcohol');
    case 'gelatin':
      return tr('Gelatin');
    case 'honey':
      return tr('Honey');
  }
  return group;
}

/** What a conflict is called: its group, or the member's own word for it, as they wrote it. */
export function conflictName(tr: Translate, c: FoodConflict) {
  return c.group ? groupName(tr, c.group) : c.from[0]?.what || c.term || '';
}

/**
 * A reason as the warning lists it: a diet in the app's words, an allergy as its member wrote it,
 * and a housemate's with their name ("Ben: Peanuts").
 */
function reasonText(tr: Translate, r: FoodReason) {
  const what = dietOptions.includes(r.what) ? tr(r.what) : r.what;
  return r.who ? tr('{{v0}}: {{v1}}', { v0: r.who, v1: what }) : what;
}

/**
 * The recipe page's warning: each thing the reader (or a housemate who shares theirs) avoids,
 * with the lines that have it, and what in whose profile led to it. Ingredient names can't say
 * what a packet holds, so it says so too.
 */
export function FoodWarning({ recipe, conflicts }: { recipe: Recipe; conflicts: FoodConflict[] }) {
  const { t: tr, language } = useI18n();
  if (!conflicts.length) return null;
  const list = (names: string[]) => joinNames(names, language);
  const reasons = [...new Set(conflicts.flatMap((c) => c.from.map((r) => reasonText(tr, r))))];
  const housemates = conflicts.some((c) => c.from.some((r) => r.who));
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: color.warningBg, borderRadius: radius.md, padding: 16, gap: 8 }}
    >
      <View style={[s.row, { gap: 8 }]}>
        <AlertTriangle size={17} color={color.warning} strokeWidth={2} />
        <Text style={[s.h3, { color: color.warning, flex: 1 }]}>{tr('Check before you cook')}</Text>
      </View>
      {conflicts.map((c) => (
        <Text key={`${c.group ?? ''}:${c.term ?? ''}`} style={[s.body, { color: color.ink }]}>
          <Text style={{ fontFamily: font.bold }}>{conflictName(tr, c)}</Text>
          {c.ingredients.length
            ? ` · ${list(c.ingredients.map((n) => recipe.ingredients[n]?.name ?? ''))}`
            : ''}
        </Text>
      ))}
      <Text style={s.small}>
        {housemates
          ? tr(
              'From your household’s diets and allergies ({{v0}}), matched by ingredient name. Always check labels and cross-contact risks yourself.',
              { v0: list(reasons) },
            )
          : tr(
              'From your diets and allergies ({{v0}}), matched by ingredient name. Always check labels and cross-contact risks yourself.',
              { v0: list(reasons) },
            )}
      </Text>
    </View>
  );
}

/** A recipe card's note that it has something its reader (or their household) avoids. */
export function AvoidPill({ conflicts }: { conflicts: FoodConflict[] }) {
  const { t: tr, language } = useI18n();
  if (!conflicts.length) return null;
  const names = conflicts.map((c) => conflictName(tr, c));
  const v0 = joinNames(names, language);
  // The reader's own for at least one thing it has, or only their housemates'.
  const mine = conflicts.some((c) => c.from.some((r) => !r.who));
  return (
    <View
      accessible
      accessibilityLabel={
        mine
          ? tr('Contains {{v0}}, which you avoid', { v0 })
          : tr('Contains {{v0}}, which your household avoids', { v0 })
      }
    >
      <Pill
        title={names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]}
        icon={AlertTriangle}
        tone="warning"
      />
    </View>
  );
}
