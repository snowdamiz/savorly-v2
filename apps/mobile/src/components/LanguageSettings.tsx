import React, { useState } from 'react';
import { Text } from 'react-native';
import { Check, Languages } from './icons';
import { languages, useI18n } from '../lib/i18n';
import { color, s } from '../lib/theme';
import { SettingsRow } from './SettingsRow';
import { Dialog, Press } from './ui';

export function LanguageSettings() {
  const { t, preference, detected, setLanguage, storageError } = useI18n();
  const [open, setOpen] = useState(false);
  const detectedName = languages.find((item) => item.code === detected)!.name;
  const options = [{ code: 'system' as const, name: t('Use device language') }, ...languages];
  const selectedName = options.find((item) => item.code === preference)!.name;
  return (
    <>
      <SettingsRow
        icon={Languages}
        title={t('Language')}
        text={selectedName}
        label={t('Language settings')}
        onPress={() => setOpen(true)}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Language')}>
        <Text style={s.muted}>
          {t('Choose your language, or follow this device. Your choice is saved on this device.')}
        </Text>
        <Text style={s.small}>
          {t('Detected language: {{language}}', { language: detectedName })}
        </Text>
        {options.map((option) => (
          <Press
            key={option.code}
            accessibilityRole="radio"
            aria-checked={preference === option.code}
            accessibilityLabel={option.name}
            accessibilityState={{ checked: preference === option.code }}
            onPress={() => setLanguage(option.code)}
            style={[
              s.row,
              {
                gap: 12,
                padding: 14,
                minHeight: 52,
                borderRadius: 16,
                backgroundColor: preference === option.code ? color.subtle : color.white,
              },
            ]}
          >
            <Text style={[s.body, { flex: 1 }]}>{option.name}</Text>
            {preference === option.code && <Check size={20} color={color.ink} />}
          </Press>
        ))}
        <Text style={s.small}>
          {t(
            'Recipes can be read in your language, translated by AI. Comments and reviews stay in their original language.',
          )}
        </Text>
        {storageError && (
          <Text accessibilityRole="alert" style={{ color: color.error }}>
            {t(
              'Your language changed, but could not be saved. Check device storage and select it again.',
            )}
          </Text>
        )}
      </Dialog>
    </>
  );
}
