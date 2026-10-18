import React from 'react';
import { Text } from 'react-native';
import { useI18n } from '../lib/i18n';
import { s } from '../lib/theme';
import { Button, Dialog } from './ui';
import { SheetError } from './SheetAction';

/**
 * Asks, before a family recipe is published, whether the people it plays the voice of agreed to
 * share it (lib/family.ts). Publishing waits on the cook's yes; the server refuses it until then.
 */
export function RecordingConsent({
  speakers,
  onAgree,
  onClose,
  busy,
  error,
}: {
  /** Whose agreement it waits on; none keeps it closed. */
  speakers: string[];
  onAgree: () => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
}) {
  const { t: tr } = useI18n();
  // Names as the family wrote them; usually one.
  const names = speakers.join(', ');
  return (
    <Dialog
      visible={speakers.length > 0}
      onClose={onClose}
      title={tr('Did {{v0}} agree?', { v0: names })}
    >
      <Text style={s.body}>
        {tr(
          'This recipe plays {{v0}}’s recorded voice. Publish it only if they agreed to share it with everyone on Savorly.',
          { v0: names },
        )}
      </Text>
      <SheetError message={error ?? ''} />
      <Button title={tr('Yes, they agreed')} busy={busy} onPress={onAgree} />
      <Button title={tr('Keep it private')} variant="ghost" onPress={onClose} />
    </Dialog>
  );
}
