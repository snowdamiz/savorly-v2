import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { joinNames } from '../lib/food';
import { byImportance, shownEquipment, stepEquipment } from '../lib/equipment';
import { Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { EquipmentIcon } from './EquipmentIcon';
import { ChevronDown, CookingPot } from './icons';
import { Press } from './ui';

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

/**
 * What a recipe shows as what you'll need, in the reader's language, and `note`, where it came
 * from when it isn't the cook's list ('' when it is).
 */
export function useShownEquipment(recipe: Recipe) {
  const { t: tr } = useI18n();
  const shown = shownEquipment(recipe, (key) => equipmentName(tr, key));
  const note = shown.guessed
    ? tr('Sous-chef’s guess')
    : shown.detected
      ? tr('From the method')
      : '';
  return { ...shown, note };
}

// How many tools show before "Show all": the ones that matter most (byImportance).
const SHOWN = 3;

/**
 * The recipe page's "You'll need", at the head of the method: a card for each tool, its
 * illustration beside its name, from the cook's list, or the sous-chef's guess (with the steps
 * that use it), or what the method mentions, labelled as such. The three that matter most show,
 * and the rest open under them.
 */
export function RecipeEquipment({ recipe }: { recipe: Recipe }) {
  const { t: tr, language } = useI18n();
  const { tools, note } = useShownEquipment(recipe);
  const [all, setAll] = useState(false);
  if (!tools.length) return null;
  const ranked = byImportance(tools);
  const shown = all ? ranked : ranked.slice(0, SHOWN);
  return (
    <View style={{ gap: 10, marginTop: 6 }}>
      <View style={[s.row, { gap: 8 }]}>
        <Text role="heading" aria-level={3} style={s.h3}>
          {tr('You’ll need')}
        </Text>
        {!!note && (
          <Text style={[s.small, { flex: 1 }]} numberOfLines={1}>
            {`· ${note}`}
          </Text>
        )}
      </View>
      <View role="list" style={{ gap: 8 }}>
        {shown.map((tool) => (
          <View key={tool.name} role="listitem" style={styles.card}>
            <View style={styles.art}>
              <EquipmentIcon kind={tool.kind} size={34} />
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={styles.cardName}>{tool.name}</Text>
              {!!tool.steps?.length && (
                <Text style={s.small}>
                  {tr('equipmentSteps', {
                    count: tool.steps.length,
                    steps: joinNames(tool.steps.map(String), language),
                  })}
                </Text>
              )}
            </View>
          </View>
        ))}
      </View>
      {ranked.length > SHOWN && (
        <Press
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          onPress={() => setAll(!all)}
          style={[s.row, { gap: 6, minHeight: 44, alignSelf: 'flex-start' }]}
        >
          <Text style={[s.small, { color: color.ink, fontFamily: font.semibold }]}>
            {all ? tr('Show fewer') : tr('Show all {{count}}', { count: ranked.length })}
          </Text>
          <ChevronDown
            size={16}
            color={color.ink}
            style={all ? { transform: [{ rotate: '180deg' }] } : undefined}
          />
        </Press>
      )}
    </View>
  );
}

/** Cooking mode's first step: what to get out before starting, so nothing is missing midway. */
export function CookEquipment({ recipe }: { recipe: Recipe }) {
  const { t: tr, language } = useI18n();
  const { names, note } = useShownEquipment(recipe);
  if (!names.length) return null;
  return (
    <View accessible style={styles.cook}>
      <Text style={[s.label, { color: color.onInk }]}>{tr('Before you start')}</Text>
      <Text style={styles.cookNames}>
        {tr('You’ll need: {{v0}}', { v0: joinNames(names, language) })}
      </Text>
      {!!note && <Text style={[s.small, { color: color.onInk }]}>{note}</Text>}
    </View>
  );
}

/**
 * Cooking mode's quiet line under a step: what the sous-chef guesses it uses, when the cook lists
 * no equipment.
 */
export function StepEquipment({ recipe, step }: { recipe: Recipe; step: number }) {
  const { t: tr, language } = useI18n();
  const names = stepEquipment(recipe, step, (key) => equipmentName(tr, key));
  if (!names.length) return null;
  const list = joinNames(names, language);
  return (
    <View
      accessible
      accessibilityLabel={tr('Equipment for this step: {{v0}}', { v0: list })}
      style={[s.row, { gap: 6 }]}
    >
      <CookingPot size={14} color={color.onInk} strokeWidth={2} />
      <Text style={[s.small, { flex: 1, color: color.onInk }]}>{list}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: color.white,
    borderRadius: radius.lg,
    padding: 10,
  },
  art: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardName: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: color.ink },
  cook: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.lg,
    padding: 16,
    gap: 6,
    marginBottom: 6,
  },
  cookNames: { color: color.white, fontFamily: font.semibold, fontSize: 17, lineHeight: 25 },
});
