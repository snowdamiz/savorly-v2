import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { joinNames } from '../lib/food';
import { shownEquipment } from '../lib/equipment';
import { Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { CookingPot } from './icons';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * A piece of equipment the server found in a method, by its key, in the reader's language; '' for
 * a key this version of the app doesn't know yet. The keys are the server's equipment lexicon
 * (services/api/internal/app/equipment_lexicon.go), whose test checks each has a name here.
 */
export function equipmentName(tr: Translate, key: string) {
  switch (key) {
    case 'pot':
      return tr('Pot');
    case 'saucepan':
      return tr('Saucepan');
    case 'frying pan':
      return tr('Frying pan');
    case 'griddle':
      return tr('Griddle');
    case 'wok':
      return tr('Wok');
    case 'dutch oven':
      return tr('Dutch oven');
    case 'roasting pan':
      return tr('Roasting pan');
    case 'sheet pan':
      return tr('Sheet pan');
    case 'baking dish':
      return tr('Baking dish');
    case 'loaf pan':
      return tr('Loaf pan');
    case 'cake pan':
      return tr('Cake pan');
    case 'pie dish':
      return tr('Pie dish');
    case 'muffin pan':
      return tr('Muffin pan');
    case 'oven':
      return tr('Oven');
    case 'grill':
      return tr('Grill');
    case 'slow cooker':
      return tr('Slow cooker');
    case 'pressure cooker':
      return tr('Pressure cooker');
    case 'air fryer':
      return tr('Air fryer');
    case 'deep fryer':
      return tr('Deep fryer');
    case 'microwave':
      return tr('Microwave');
    case 'rice cooker':
      return tr('Rice cooker');
    case 'steamer':
      return tr('Steamer');
    case 'blender':
      return tr('Blender');
    case 'immersion blender':
      return tr('Immersion blender');
    case 'food processor':
      return tr('Food processor');
    case 'stand mixer':
      return tr('Stand mixer');
    case 'hand mixer':
      return tr('Hand mixer');
    case 'whisk':
      return tr('Whisk');
    case 'grater':
      return tr('Grater');
    case 'mandoline':
      return tr('Mandoline');
    case 'rolling pin':
      return tr('Rolling pin');
    case 'sieve':
      return tr('Sieve');
    case 'colander':
      return tr('Colander');
    case 'thermometer':
      return tr('Thermometer');
    case 'kitchen scale':
      return tr('Kitchen scale');
    case 'mortar and pestle':
      return tr('Mortar and pestle');
  }
  return '';
}

/** What a recipe shows as what you'll need, in the reader's language, and where it came from. */
export function useShownEquipment(recipe: Recipe) {
  const { t: tr } = useI18n();
  return shownEquipment(recipe, (key) => equipmentName(tr, key));
}

/**
 * The recipe page's "You'll need", at the head of the method: the cook's list, or what the method
 * mentions, labelled as such.
 */
export function RecipeEquipment({ recipe }: { recipe: Recipe }) {
  const { t: tr } = useI18n();
  const { names, detected } = useShownEquipment(recipe);
  if (!names.length) return null;
  return (
    <View style={{ gap: 10, marginTop: 6 }}>
      <View style={[s.row, { gap: 8 }]}>
        <CookingPot size={16} color={color.ink} />
        <Text role="heading" aria-level={3} style={s.h3}>
          {tr('You’ll need')}
        </Text>
        {detected && (
          <Text style={[s.small, { flex: 1 }]} numberOfLines={1}>
            {`· ${tr('From the method')}`}
          </Text>
        )}
      </View>
      <View role="list" style={[s.wrap, { gap: 8 }]}>
        {names.map((name) => (
          <View key={name} role="listitem" style={styles.item}>
            <Text style={styles.name}>{name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Cooking mode's first step: what to get out before starting, so nothing is missing midway. */
export function CookEquipment({ recipe }: { recipe: Recipe }) {
  const { t: tr, language } = useI18n();
  const { names, detected } = useShownEquipment(recipe);
  if (!names.length) return null;
  return (
    <View accessible style={styles.cook}>
      <Text style={[s.label, { color: color.onInk }]}>{tr('Before you start')}</Text>
      <Text style={styles.cookNames}>
        {tr('You’ll need: {{v0}}', { v0: joinNames(names, language) })}
      </Text>
      {detected && <Text style={[s.small, { color: color.onInk }]}>{tr('From the method')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    backgroundColor: color.white,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  name: { fontFamily: font.semibold, fontSize: 14, color: color.ink },
  cook: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.lg,
    padding: 16,
    gap: 6,
    marginBottom: 6,
  },
  cookNames: { color: color.white, fontFamily: font.semibold, fontSize: 17, lineHeight: 25 },
});
