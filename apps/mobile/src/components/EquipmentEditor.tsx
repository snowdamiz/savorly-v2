import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { api } from '../lib/api';
import { EQUIPMENT_MAX, EQUIPMENT_NAME_MAX, moved, withSuggestions } from '../lib/equipment';
import { RecipeInput } from '../lib/types';
import { color, s } from '../lib/theme';
import { equipmentName } from './Equipment';
import { ArrowDown, ArrowUp, CookingPot, Plus, Trash2 } from './icons';
import { Button, Field, IconButton } from './ui';

// The boxes match the editor's ingredient rows.
const box = {
  backgroundColor: color.bg,
  borderColor: color.bg,
  minHeight: 46,
  paddingVertical: 11,
  paddingHorizontal: 12,
  borderRadius: 14,
};

/**
 * The editor's equipment list: names as the cook writes them, in the order they'd get them out,
 * and a tap that adds what the method mentions. The method is read by the server (the same
 * lexicon that reads saved recipes), from the steps as they are now, saved or not.
 */
export function EquipmentEditor({
  recipe,
  onChange,
}: {
  recipe: RecipeInput;
  onChange: (equipment: string[]) => void;
}) {
  const { t: tr } = useI18n();
  const list = Array.isArray(recipe.equipment) ? recipe.equipment : [];
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  // The list as it is when the server answers, which typing may have changed meanwhile.
  const latest = useRef(list);
  useEffect(() => {
    latest.current = list;
  });
  const set = (n: number, name: string) => onChange(list.map((x, k) => (k === n ? name : x)));
  const method = recipe.steps.some((st) => st.title.trim() || st.text.trim());
  const full = list.length >= EQUIPMENT_MAX;
  const suggest = async () => {
    if (reading) return;
    setReading(true);
    setNote(null);
    try {
      const found = await api<{ equipment: string[] }>('/recipes/equipment', {
        method: 'POST',
        body: {
          steps: recipe.steps.map(({ title, text }) => ({ title, text })),
          language: recipe.language ?? '',
        },
      });
      const names = found.equipment.map((key) => equipmentName(tr, key)).filter(Boolean);
      const { equipment, added } = withSuggestions(latest.current, names);
      if (added) onChange(equipment);
      setNote({
        text: added
          ? tr('equipmentAdded', { count: added })
          : names.length
            ? tr('Your list already has what the method mentions.')
            : tr('The method doesn’t mention any equipment we know.'),
      });
    } catch (e) {
      setNote({ text: tr((e as Error).message), error: true });
    } finally {
      setReading(false);
    }
  };
  return (
    <View style={{ gap: 12 }}>
      {list.map((name, n) => (
        <View key={n} style={[s.row, { gap: 2 }]}>
          <View style={{ flex: 1, marginRight: 4 }}>
            <Field
              accessibilityLabel={tr('Equipment {{v0}}', { v0: n + 1 })}
              placeholder={tr('Large pot, blender…')}
              value={name}
              maxLength={EQUIPMENT_NAME_MAX}
              onChangeText={(v) => set(n, v)}
              style={box}
            />
          </View>
          <IconButton
            icon={ArrowUp}
            plain
            size={38}
            label={tr('Move equipment {{v0}} up', { v0: n + 1 })}
            disabled={n === 0}
            onPress={() => onChange(moved(list, n, -1))}
          />
          <IconButton
            icon={ArrowDown}
            plain
            size={38}
            label={tr('Move equipment {{v0}} down', { v0: n + 1 })}
            disabled={n === list.length - 1}
            onPress={() => onChange(moved(list, n, 1))}
          />
          <IconButton
            icon={Trash2}
            plain
            size={38}
            label={tr('Remove equipment {{v0}}', { v0: n + 1 })}
            onPress={() => onChange(list.filter((_, k) => k !== n))}
          />
        </View>
      ))}
      <View style={[s.wrap, { gap: 10 }]}>
        <Button
          title={tr('Add equipment')}
          icon={Plus}
          variant="secondary"
          disabled={full}
          style={{ flexGrow: 1 }}
          onPress={() => onChange([...list, ''])}
        />
        <Button
          title={tr('Add what the method mentions')}
          icon={CookingPot}
          variant="secondary"
          busy={reading}
          disabled={full || !method}
          style={{ flexGrow: 1 }}
          onPress={() => void suggest()}
        />
      </View>
      {!!note && (
        <Text
          accessibilityLiveRegion="polite"
          role={note.error ? 'alert' : undefined}
          style={[s.small, note.error && { color: color.error }]}
        >
          {note.text}
        </Text>
      )}
    </View>
  );
}
