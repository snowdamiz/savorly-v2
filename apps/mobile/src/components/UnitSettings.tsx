import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Check, Ruler } from './icons';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, s } from '../lib/theme';
import { Units } from '../lib/types';
import { SettingsRow } from './SettingsRow';
import { Dialog, Press } from './ui';

/** How recipe amounts show: as their cooks wrote them, or in metric or imperial units. */
export function UnitSettings() {
  const { t } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  // The choice shows at once; the server's answer settles it.
  const [choosing, setChoosing] = useState<Units | null>(null);
  if (!app.user) return null;
  const units = choosing ?? app.user.preferences.units ?? '';
  const options: { value: Units; title: string; text: string }[] = [
    { value: '', title: t('As written'), text: t('Amounts as each cook wrote them') },
    { value: 'metric', title: t('Metric'), text: t('Grams, milliliters and degrees Celsius') },
    { value: 'imperial', title: t('Imperial'), text: t('Cups, ounces and degrees Fahrenheit') },
  ];
  const choose = async (value: Units) => {
    if (value === units) return;
    setChoosing(value);
    await app.act(async () => {
      await api('/me/preferences', { method: 'PATCH', body: { units: value } });
      await app.refreshUser();
    });
    setChoosing(null);
  };
  return (
    <>
      <SettingsRow
        icon={Ruler}
        title={t('Measurements')}
        text={options.find((o) => o.value === units)?.title}
        label={t('Measurement settings')}
        onPress={() => setOpen(true)}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Measurements')}>
        <Text style={s.muted}>
          {t('Choose how recipes show their amounts. Your choice is saved with your account.')}
        </Text>
        {options.map((option) => {
          const selected = units === option.value;
          return (
            <Press
              key={option.value || 'written'}
              accessibilityRole="radio"
              aria-checked={selected}
              accessibilityLabel={option.title}
              accessibilityHint={option.text}
              accessibilityState={{ checked: selected }}
              onPress={() => void choose(option.value)}
              style={[
                s.row,
                {
                  gap: 12,
                  padding: 14,
                  minHeight: 52,
                  borderRadius: 16,
                  backgroundColor: selected ? color.subtle : color.white,
                },
              ]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.body}>{option.title}</Text>
                <Text style={s.small}>{option.text}</Text>
              </View>
              {selected && <Check size={20} color={color.ink} />}
            </Press>
          );
        })}
      </Dialog>
    </>
  );
}
