import React, { useState } from 'react';
import { Platform, Text } from 'react-native';
import { Download, FolderArchive } from './icons';
import { downloadMyData, downloadMyFiles } from '../lib/dataExport';
import { useFormRequest } from '../lib/formRequest';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { font, s } from '../lib/theme';
import { ErrorNote, SettingsRow } from './SettingsRow';
import { Button, Dialog } from './ui';

/**
 * "Download my data": everything the account holds, as files to keep (a ZIP with a folder for
 * each recipe and its photos, and the lists as spreadsheets) or as one JSON file.
 */
export function DataExport() {
  const { t } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useFormRequest();
  const [which, setWhich] = useState<'files' | 'json'>('files');
  if (!app.user) return null;
  const web = Platform.OS === 'web';
  const download = (format: 'files' | 'json') => {
    setWhich(format);
    return run(async () => {
      await (format === 'files' ? downloadMyFiles() : downloadMyData());
      setOpen(false);
      if (web) app.notify('Your data is downloading.');
    });
  };
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
          {t('Everything in your kitchen, yours to keep or to take to another app.')}
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
          title={t('Download as files')}
          icon={FolderArchive}
          busy={busy && which === 'files'}
          disabled={busy}
          onPress={() => void download('files')}
        />
        <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17, marginTop: -6 }]}>
          {t(
            'A ZIP with a folder for each recipe, to read or print, and your lists as spreadsheets.',
          )}
        </Text>
        <Button
          title={t('Download as JSON')}
          icon={Download}
          variant="secondary"
          busy={busy && which === 'json'}
          disabled={busy}
          onPress={() => void download('json')}
        />
        <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17, marginTop: -6 }]}>
          {t('One file with everything, for other apps to read.')}
        </Text>
      </Dialog>
    </>
  );
}
