import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { joinNames } from '../lib/food';
import { byImportance, ShownTool, shownEquipment, sizeIn, stepEquipment } from '../lib/equipment';
import { openOrder } from '../lib/groceryCheckout';
import { useApp } from '../lib/store';
import { EquipmentSize, Recipe, UnitChoice } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { EquipmentIcon } from './EquipmentIcon';
import { ChevronDown, CookingPot, ExternalLink } from './icons';
import type { StepNote } from './CookStep';
import { Button, Dialog, Press } from './ui';

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
 * The units sizes show in: the page's choice, or for its original units, the reader's region's
 * (inches and quarts in the United States).
 */
const sizeSystem = (units: UnitChoice, locale: string) =>
  units || (/-US\b/i.test(locale) ? 'imperial' : 'metric');

/** A size as the reader reads it ("At least 5 l", "28 cm", "9 × 13 in"); '' for none. */
export function useSizeText(units: UnitChoice) {
  const { t: tr, locale } = useI18n();
  return (size?: EquipmentSize) => {
    const shown = sizeIn(size, sizeSystem(units, locale));
    if (!shown) return '';
    const n = (v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v);
    const amount = n(shown.value);
    const length = n(shown.length ?? 0);
    switch (`${shown.shape} ${shown.unit}`) {
      case 'least l':
        return tr('At least {{amount}} l', { amount });
      case 'least qt':
        return tr('At least {{amount}} qt', { amount });
      case 'across cm':
        return tr('{{amount}} cm', { amount });
      case 'across in':
        return tr('{{amount}} in', { amount });
      case 'sides cm':
        return tr('{{width}} × {{length}} cm', { width: amount, length });
      default:
        return tr('{{width}} × {{length}} in', { width: amount, length });
    }
  };
}

/** What a store's search is asked for: the name, with the size in its units ("Pot 5 qt"). */
function shopQuery(tool: ShownTool, system: 'metric' | 'imperial') {
  const shown = sizeIn(tool.size, system);
  if (!shown) return tool.name;
  const measure = shown.length ? `${shown.value} x ${shown.length}` : `${shown.value}`;
  return `${tool.name} ${measure} ${shown.unit}`;
}

/**
 * The recipe page's "You'll need", at the head of the method: a card for each tool, its
 * illustration beside its name and its size, from the cook's list, or the sous-chef's guess (with
 * the steps that use it and how big it should be), or what the method mentions, labelled as such.
 * The three that matter most show, and the rest open under them. A card opens the tool larger,
 * with where to buy one when the server has a store (EQUIPMENT_SHOP_URL).
 */
export function RecipeEquipment({ recipe, units = '' }: { recipe: Recipe; units?: UnitChoice }) {
  const { t: tr, language } = useI18n();
  const { tools, note } = useShownEquipment(recipe);
  const sizeText = useSizeText(units);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ShownTool | null>(null);
  if (!tools.length) return null;
  const ranked = byImportance(tools);
  const shown = all ? ranked : ranked.slice(0, SHOWN);
  const detail = (tool: ShownTool) =>
    [
      sizeText(tool.size),
      tool.steps?.length
        ? tr('equipmentSteps', {
            count: tool.steps.length,
            steps: joinNames(tool.steps.map(String), language),
          })
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
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
          <View key={tool.name} role="listitem">
            <Press
              accessibilityRole="button"
              accessibilityLabel={[tool.name, detail(tool)].filter(Boolean).join(', ')}
              accessibilityHint={tr('Shows it larger')}
              onPress={() => setOpen(tool)}
              scale={0.985}
              style={styles.card}
            >
              <View style={styles.art}>
                <EquipmentIcon kind={tool.kind} size={34} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={styles.cardName}>{tool.name}</Text>
                {!!detail(tool) && <Text style={s.small}>{detail(tool)}</Text>}
              </View>
            </Press>
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
      {open && (
        <ToolSheet
          tool={open}
          detail={detail(open)}
          note={note}
          units={units}
          onClose={() => setOpen(null)}
        />
      )}
    </View>
  );
}

/** One tool, larger: its illustration, name, size and steps, and where to buy one. */
function ToolSheet({
  tool,
  detail,
  note,
  units,
  onClose,
}: {
  tool: ShownTool;
  detail: string;
  note: string;
  units: UnitChoice;
  onClose: () => void;
}) {
  const { t: tr, locale } = useI18n();
  const shop = useApp().capabilities?.equipmentShop;
  return (
    <Dialog visible onClose={onClose}>
      <View style={{ alignItems: 'center', gap: 6 }}>
        <View style={styles.bigArt}>
          <EquipmentIcon kind={tool.kind} size={132} />
        </View>
        <Text role="heading" aria-level={2} style={[s.h2, { textAlign: 'center', marginTop: 10 }]}>
          {tool.name}
        </Text>
        {!!detail && <Text style={[s.muted, { textAlign: 'center' }]}>{detail}</Text>}
        {!!note && <Text style={[s.small, { textAlign: 'center' }]}>{note}</Text>}
      </View>
      {!!shop && (
        <View style={{ gap: 8 }}>
          <Button
            title={tr('Find one to buy')}
            icon={ExternalLink}
            variant="secondary"
            onPress={() =>
              void openOrder(
                shop.replace(
                  '{query}',
                  encodeURIComponent(shopQuery(tool, sizeSystem(units, locale))),
                ),
              )
            }
          />
          <Text style={[s.small, { textAlign: 'center' }]}>
            {tr('Savorly may earn a commission on what you buy there.')}
          </Text>
        </View>
      )}
    </Dialog>
  );
}

/**
 * Cooking mode's quiet lines about equipment: on the first step, everything to get out before
 * starting, so nothing is missing midway; on the steps after, what the sous-chef guesses the step
 * uses, when the cook lists no equipment.
 */
export function useEquipmentNotes(recipe: Recipe, step: number): StepNote[] {
  const { t: tr, language } = useI18n();
  const { names, note } = useShownEquipment(recipe);
  if (step === 0)
    return names.length
      ? [
          {
            key: 'equipment',
            icon: CookingPot,
            text: tr('You’ll need: {{v0}}', { v0: joinNames(names, language) }),
            aside: note || undefined,
          },
        ]
      : [];
  const used = stepEquipment(recipe, step, (key) => equipmentName(tr, key));
  if (!used.length) return [];
  const list = joinNames(used, language);
  return [
    {
      key: 'equipment',
      icon: CookingPot,
      text: list,
      label: tr('Equipment for this step: {{v0}}', { v0: list }),
    },
  ];
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
  bigArt: {
    width: 188,
    height: 188,
    borderRadius: radius.xl,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
