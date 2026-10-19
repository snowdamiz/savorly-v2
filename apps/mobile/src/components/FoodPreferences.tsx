import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Check, Salad } from './icons';
import { foodIcon } from '../lib/icons';
import { useI18n } from '../lib/i18n';
import { dietOptions, useSaveProfile } from '../lib/profile';
import { useApp } from '../lib/store';
import { s } from '../lib/theme';
import { SettingsRow } from './SettingsRow';
import { Button, Chip, Dialog, Field } from './ui';

/**
 * The cook's diets and allergies, which recipe pages warn about and the sous-chef cooks around.
 * They're saved with the profile (PATCH /me), the rest of which stays as it is.
 */
export function FoodPreferences() {
  const { t } = useI18n();
  const app = useApp();
  const save = useSaveProfile();
  const [open, setOpen] = useState(false);
  const [diets, setDiets] = useState<string[]>([]);
  const [allergies, setAllergies] = useState('');
  const [busy, setBusy] = useState(false);
  const user = app.user;
  if (!user) return null;
  const chosen = [
    ...(user.preferences.diets ?? []).map((d) => t(d)),
    ...(user.preferences.allergies ?? []),
  ];
  return (
    <>
      <SettingsRow
        icon={Salad}
        title={t('Food preferences')}
        text={chosen.length ? chosen.join(', ') : t('Diets and allergies')}
        onPress={() => {
          // Opening starts from what's saved, not from an edit that was left unsaved.
          setDiets(user.preferences.diets ?? []);
          setAllergies(user.preferences.allergies?.join(', ') ?? '');
          setOpen(true);
        }}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Food preferences')}>
        <View style={[s.wrap, { gap: 8 }]}>
          {dietOptions.map((d) => (
            <Chip
              key={d}
              title={t(d)}
              icon={foodIcon(d)}
              active={diets.includes(d)}
              onPress={() =>
                setDiets(diets.includes(d) ? diets.filter((v) => v !== d) : [...diets, d])
              }
            />
          ))}
        </View>
        <Field
          label={t('Allergies (comma separated)')}
          value={allergies}
          onChangeText={setAllergies}
          placeholder={t('Peanuts, shellfish…')}
        />
        <Text style={s.small}>
          {t(
            'Recipe pages warn you about these, and the sous-chef leaves them out of its suggestions. Always check labels and cross-contact risks yourself.',
          )}
        </Text>
        <Button
          title={t('Save')}
          icon={Check}
          busy={busy}
          onPress={() => {
            setBusy(true);
            void app
              .act(async () => {
                await save({
                  preferences: {
                    ...user.preferences,
                    diets,
                    allergies: allergies
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                  },
                });
                setOpen(false);
              }, 'Your food preferences are saved.')
              .finally(() => setBusy(false));
          }}
        />
      </Dialog>
    </>
  );
}
