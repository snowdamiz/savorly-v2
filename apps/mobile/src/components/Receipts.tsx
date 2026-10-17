import { useI18n } from '../lib/i18n';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  BookOpen,
  Bookmark,
  CalendarDays,
  Check,
  ChefHat,
  CookingPot,
  Flag,
  Globe,
  ImagePlus,
  Leaf,
  LucideIcon,
  PenLine,
  ShoppingBasket,
  Square,
  Star,
  Trash2,
  UserMinus,
  UserPlus,
  UserRound,
} from './icons';
import { color, font, s } from '../lib/theme';
import type { StudioEffect } from '../lib/types';

/** One receipt and the reply event it belongs to, which Undo names. */
export type Receipt = { seq: number; index: number; effect: StudioEffect };

const icons: Record<StudioEffect['kind'], LucideIcon> = {
  groceries: ShoppingBasket,
  plan: CalendarDays,
  pantry: Leaf,
  saved: Bookmark,
  unsaved: Bookmark,
  followed: UserPlus,
  unfollowed: UserMinus,
  cookbook: BookOpen,
  checked: Check,
  unchecked: Square,
  removed: Trash2,
  recipe: PenLine,
  deleted: Trash2,
  draft: ChefHat,
  published: Globe,
  profile: UserRound,
  review: Star,
  report: Flag,
  media: ImagePlus,
  cooked: CookingPot,
};

type Translate = ReturnType<typeof useI18n>['t'];

function receiptText(tr: Translate, f: StudioEffect) {
  const title = f.title ?? '';
  switch (f.kind) {
    case 'groceries':
      return tr('groceriesAdded', { count: f.count ?? 1 });
    case 'removed':
      return tr('itemsRemoved', { count: f.count ?? 1 });
    case 'plan':
      return tr('Planned {{title}}', { title });
    case 'pantry':
      return tr('Updated {{title}} in your pantry', { title });
    case 'saved':
      return tr('Saved {{title}}', { title });
    case 'unsaved':
      return tr('Unsaved {{title}}', { title });
    case 'followed':
      return tr('Following {{title}}', { title });
    case 'unfollowed':
      return tr('Unfollowed {{title}}', { title });
    case 'cookbook':
      return tr('Created the cookbook {{title}}', { title });
    case 'checked':
      return tr('Checked off {{title}}', { title });
    case 'unchecked':
      return tr('Unchecked {{title}}', { title });
    case 'recipe':
      return tr('Updated {{title}}', { title });
    case 'deleted':
      return tr('Deleted {{title}}', { title });
    case 'draft':
      return tr('Saved the draft {{title}}', { title });
    case 'published':
      return tr('Published {{title}}', { title });
    case 'profile':
      return tr('Updated your profile');
    case 'review':
      return tr('Posted your review of {{title}}', { title });
    case 'report':
      return tr('Reported {{title}}', { title });
    case 'media':
      return tr('Making new media for {{title}}', { title });
    case 'cooked':
      return tr('Marked {{title}} as cooked', { title });
  }
}

/** Whether a receipt has somewhere to go: the recipe it touched, or the page that lists it. */
export const canView = (f: StudioEffect) =>
  (!!f.recipe && f.kind !== 'deleted') || (!!f.page && !f.undone);

/**
 * What a reply's turn did to the member's data, each with a way to see it and, where the server
 * can take it back, Undo.
 */
export function Receipts({
  receipts,
  onView,
  onUndo,
  undoing,
}: {
  receipts: Receipt[];
  onView: (effect: StudioEffect) => void;
  onUndo: (receipt: Receipt) => void;
  /** The receipt being undone, as `seq:index`. */
  undoing?: string;
}) {
  const { t: tr } = useI18n();
  return (
    <View style={{ gap: 8, paddingTop: 6 }}>
      {receipts.map((r) => {
        const { effect } = r;
        const Icon = icons[effect.kind] ?? Check;
        const key = `${r.seq}:${r.index}`;
        return (
          <View key={key} style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
            <Icon size={15} color={effect.undone ? color.soft : color.ink} strokeWidth={2} />
            <Text
              style={[
                s.small,
                { flex: 1, minWidth: 120, color: effect.undone ? color.soft : color.ink },
                effect.undone && { textDecorationLine: 'line-through' },
              ]}
            >
              {receiptText(tr, effect)}
            </Text>
            {canView(effect) && (
              <TextLink
                title={tr('View')}
                label={`${tr('View')}: ${receiptText(tr, effect)}`}
                onPress={() => onView(effect)}
              />
            )}
            {effect.undoable && (
              <TextLink
                title={tr('Undo')}
                label={`${tr('Undo')}: ${receiptText(tr, effect)}`}
                disabled={undoing === key}
                onPress={() => onUndo(r)}
              />
            )}
            {effect.undone && <Text style={s.small}>{tr('Undone')}</Text>}
          </View>
        );
      })}
    </View>
  );
}

/** A small underlined text button; label names it in full for screen readers. */
export function TextLink({
  title,
  label,
  onPress,
  disabled,
}: {
  title: string;
  label?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Text
        style={{
          fontFamily: font.bold,
          fontSize: 12,
          color: color.ink,
          textDecorationLine: 'underline',
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
