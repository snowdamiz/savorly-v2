import React, { useState } from 'react';
import { Platform, Text } from 'react-native';
import { Download } from './icons';
import { downloadMyData } from '../lib/dataExport';
import { useFormRequest } from '../lib/formRequest';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { s } from '../lib/theme';
import { ErrorNote, SettingsRow } from './SettingsRow';
import { Button, Dialog } from './ui';

/** "Download my data": everything the account holds, as one JSON file. */
export function DataExport() {
  const { t } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useFormRequest();
  if (!app.user) return null;
  const web = Platform.OS === 'web';
  const download = () =>
    run(async () => {
      await downloadMyData();
      setOpen(false);
      if (web) app.notify('Your data is downloading.');
    });
  return (
    <>
      <SettingsRow
        icon={Download}
        title={t('Download my data')}
        text={t('A copy of your recipes, lists and profile')}
        onPress={() => {
          setError('');
          setOpen(true);
        }}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={t('Download my data')}>
        <Text style={s.muted}>
          {t(
            'One JSON file with your profile, recipes, reviews, cookbooks, meal plans, grocery and pantry lists, and sous-chef conversations.',
          )}
        </Text>
        {!web && (
          <Text style={s.muted}>
            {t(
              'It opens in your browser, which saves the file. The link works once, for 10 minutes.',
            )}
          </Text>
        )}
        {!!error && <ErrorNote message={t(error)} />}
        <Button
          title={web ? t('Download my data') : t('Open in the browser')}
          icon={Download}
          busy={busy}
          onPress={() => void download()}
        />
      </Dialog>
    </>
  );
}
