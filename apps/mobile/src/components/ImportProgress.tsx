import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { ImportBatch, ImportItem, mealimeName, mealimeOwn, progressOf } from '../lib/imports';
import { color, font, s } from '../lib/theme';
import { Check, ChevronRight, CircleAlert, CircleStop, Clock3, Search, X } from './icons';
import { IconButton, Press } from './ui';

// An address as a row shows it: its site and path, without https:// and www.
const shortLink = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
// A long batch shows its first rows until the cook asks for the rest.
const FIRST_ROWS = 6;

/**
 * A bulk import as it's read (lib/imports.ts): a line saying how far it has got, then a row for
 * each link or pasted recipe with what became of it. An imported row opens its draft (`onOpen`);
 * one of Mealime's own recipes looks for similar Savorly recipes (`onSimilar`).
 */
export function ImportProgress({
  batch,
  onStop,
  onOpen,
  onSimilar,
}: {
  batch: ImportBatch;
  onStop?: () => void;
  onOpen: (recipeId: string) => void;
  onSimilar?: (name: string) => void;
}) {
  const { t: tr } = useI18n();
  const [all, setAll] = useState(false);
  const { total, imported, done } = progressOf(batch);
  const finished = !!batch.finishedAt;
  const rows = all ? batch.items : batch.items.slice(0, FIRST_ROWS);
  return (
    <View style={[s.card, { gap: 4, paddingVertical: 14 }]}>
      <View accessibilityLiveRegion="polite" style={[s.row, { gap: 12, minHeight: 44 }]}>
        <Text style={[s.h3, { flex: 1 }]}>
          {finished
            ? imported
              ? tr('importDone', { count: imported })
              : tr('None of these could come over.')
            : tr('importProgress', { count: total, done })}
        </Text>
        {!finished &&
          (onStop && batch.items.some((i) => i.status === 'queued') ? (
            <IconButton icon={CircleStop} label={tr('Stop importing')} onPress={onStop} plain />
          ) : (
            <ActivityIndicator color={color.ink} />
          ))}
      </View>
      {!finished && (
        <Text style={[s.small, { fontFamily: font.medium, marginBottom: 6 }]}>
          {tr('You can leave this page: Savorly keeps reading.')}
        </Text>
      )}
      {rows.map((item, i) => (
        <Row
          key={item.position}
          item={item}
          first={i === 0}
          onOpen={onOpen}
          onSimilar={onSimilar}
        />
      ))}
      {rows.length < batch.items.length && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Show all {{count}}', { count: batch.items.length })}
          onPress={() => setAll(true)}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={[s.small, { color: color.ink }]}>
            {tr('Show all {{count}}', { count: batch.items.length })}
          </Text>
        </Press>
      )}
    </View>
  );
}

function Row({
  item,
  first,
  onOpen,
  onSimilar,
}: {
  item: ImportItem;
  first: boolean;
  onOpen: (recipeId: string) => void;
  onSimilar?: (name: string) => void;
}) {
  const { t: tr } = useI18n();
  // One of Mealime's own recipes goes by the name its link gives it, with a search for others.
  const similar = item.error === mealimeOwn ? mealimeName(item.url) : '';
  const name =
    item.recipe?.title || similar || item.text || shortLink(item.url) || tr('A recipe you pasted');
  const status = {
    queued: tr('Waiting'),
    reading: tr('Reading…'),
    imported: tr('Private draft'),
    failed: similar
      ? tr('One of Mealime’s own recipes')
      : tr(item.error || 'We couldn’t read a recipe from that page.'),
  }[item.status];
  const icon = {
    queued: <Clock3 size={16} color={color.soft} strokeWidth={2} />,
    reading: <ActivityIndicator size="small" color={color.ink} />,
    imported: <Check size={16} color={color.success} strokeWidth={2.6} />,
    // Mealime's own recipes were never going to come over: not an error.
    failed: similar ? (
      <X size={16} color={color.muted} strokeWidth={2.4} />
    ) : (
      <CircleAlert size={16} color={color.error} strokeWidth={2} />
    ),
  }[item.status];
  const body = (
    <>
      <View style={{ width: 20, alignItems: 'center' }}>{icon}</View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={[s.body, { fontFamily: font.semibold }]}>
          {name}
        </Text>
        <Text style={[s.small, { fontFamily: font.medium }]}>{status}</Text>
      </View>
    </>
  );
  const line = [
    s.row,
    { gap: 12, minHeight: 52, paddingVertical: 6 },
    !first && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  ];
  if (item.status === 'imported' && item.recipe) {
    const recipe = item.recipe;
    return (
      <Press
        accessibilityRole="button"
        accessibilityLabel={tr('Open {{v0}}', { v0: recipe.title })}
        onPress={() => onOpen(recipe.id)}
        scale={0.99}
        style={line}
      >
        {body}
        <ChevronRight size={18} color={color.soft} />
      </Press>
    );
  }
  return (
    <View style={line}>
      {body}
      {!!similar && onSimilar && (
        <IconButton
          icon={Search}
          label={tr('Find recipes like {{v0}} on Savorly', { v0: similar })}
          onPress={() => onSimilar(similar)}
          size={38}
        />
      )}
    </View>
  );
}
