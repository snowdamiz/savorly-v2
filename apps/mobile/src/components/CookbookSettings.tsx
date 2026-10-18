import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Share, Switch, Text, View } from 'react-native';
import { Check, Share2 } from './icons';
import { useI18n } from '../lib/i18n';
import { api } from '../lib/api';
import { cookbookUrl } from '../lib/routes';
import { useApp } from '../lib/store';
import { Collection } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { Button, Dialog, Field } from './ui';
import { SheetError, useSheetAction } from './SheetAction';

const DESCRIPTION = 300;

/** Where a cookbook opens for anyone: its page on the web app. */
export const cookbookLink = (id: string) => cookbookUrl(id);

/**
 * Hands a cookbook's link to the share sheet, or to the clipboard in a browser without one.
 * Closing the sheet without sharing rejects with an AbortError, which act() and sheets let pass.
 */
export async function shareCookbook(
  cookbook: { id: string; name: string },
  tr: ReturnType<typeof useI18n>['t'],
) {
  const link = cookbookLink(cookbook.id);
  if (Platform.OS === 'web' && !navigator.share) {
    await navigator.clipboard.writeText(link);
    return 'copied';
  }
  await Share.share({
    message: tr('{{v0}}, a cookbook on Savorly: {{v1}}', { v0: cookbook.name, v1: link }),
  });
  return 'shared';
}

/** Shares a cookbook from a page, where the toast can say the link was copied. */
export function useShareCookbook() {
  const { t: tr } = useI18n();
  const { act, notify } = useApp();
  return useCallback(
    (cookbook: { id: string; name: string }) =>
      act(async () => {
        if ((await shareCookbook(cookbook, tr)) === 'copied')
          notify('Link copied to your clipboard.');
      }),
    [act, notify, tr],
  );
}

/**
 * A cookbook's name, description and whether it's public. Public cookbooks have a page anyone with
 * the link can open, showing the published recipes in them. A cookbook shared with the household
 * opens for everyone in it, the owner's private recipes in it included (lib/family.ts).
 */
export function CookbookSettings({
  cookbook,
  household,
  onClose,
}: {
  /** The cookbook to edit; null keeps the sheet closed. */
  cookbook: Collection | null;
  /** The household's name, when the cook is in one it can be shared with. */
  household?: string | null;
  onClose: () => void;
}) {
  const { t: tr, number } = useI18n();
  const { refreshLibrary, notify } = useApp();
  const { busy, error, setError, run } = useSheetAction();
  const [form, setForm] = useState({ name: '', description: '', public: false, household: false });
  const [copied, setCopied] = useState(false);
  // Each opening starts from the cookbook as it's saved.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const id = cookbook?.id ?? null;
  if (openFor !== id) {
    setOpenFor(id);
    if (cookbook)
      setForm({
        name: cookbook.name,
        description: cookbook.description ?? '',
        public: !!cookbook.public,
        household: !!cookbook.household,
      });
    setError('');
    setCopied(false);
  }
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!cookbook) return null;
  const name = form.name.trim();
  const description = form.description.trim();
  // Only what changed is sent.
  const changes = {
    ...(name !== cookbook.name && { name }),
    ...(description !== (cookbook.description ?? '') && { description }),
    ...(form.public !== !!cookbook.public && { public: form.public }),
    ...(form.household !== !!cookbook.household && { household: form.household }),
  };
  // Older servers can't share a cookbook with the household.
  const shareable = !!household && typeof cookbook.household === 'boolean';
  const save = async () => {
    const madePublic = changes.public === true;
    const madeShared = changes.household === true;
    const saved = await run(async () => {
      await api(`/collections/${encodeURIComponent(cookbook.id)}`, {
        method: 'PATCH',
        body: changes,
      });
      await refreshLibrary();
    });
    if (!saved) return;
    onClose();
    notify(
      madePublic
        ? 'Your cookbook is public. Anyone with the link can open it.'
        : madeShared
          ? 'Shared with your household.'
          : 'Cookbook updated.',
    );
  };
  const share = () =>
    void run(async () => {
      if ((await shareCookbook(cookbook, tr)) === 'copied') setCopied(true);
    });
  return (
    <Dialog visible onClose={onClose} title={tr('Edit cookbook')}>
      <Field
        label={tr('Cookbook name')}
        value={form.name}
        onChangeText={(text) => setForm((f) => ({ ...f, name: text }))}
        maxLength={60}
      />
      <View style={{ gap: 6 }}>
        <Field
          label={tr('Description')}
          placeholder={tr('What’s inside, and when you cook from it')}
          value={form.description}
          onChangeText={(text) => setForm((f) => ({ ...f, description: text }))}
          maxLength={DESCRIPTION}
          multiline
        />
        <Text
          accessibilityLabel={tr('{{v0}} of {{v1}} characters', {
            v0: form.description.length,
            v1: DESCRIPTION,
          })}
          style={[s.small, { alignSelf: 'flex-end' }]}
        >
          {`${number(form.description.length)}/${number(DESCRIPTION)}`}
        </Text>
      </View>
      <View style={[s.card, { gap: 14 }]}>
        <View style={[s.row, { gap: 14 }]}>
          {/* The words toggle it too, for a bigger target; the switch is what screen readers use. */}
          <Pressable
            accessible={false}
            focusable={false}
            onPress={() => setForm((f) => ({ ...f, public: !f.public }))}
            style={{ flex: 1, gap: 2 }}
          >
            <Text style={s.h3}>{tr('Public')}</Text>
            <Text style={s.muted}>
              {tr('Anyone with the link can see this cookbook and the published recipes in it.')}
            </Text>
          </Pressable>
          <Switch
            value={form.public}
            onValueChange={(on) => setForm((f) => ({ ...f, public: on }))}
            accessibilityLabel={tr('Public cookbook')}
            trackColor={{ false: color.line, true: color.ink }}
            thumbColor={color.white}
            {...(Platform.OS === 'web' ? { activeThumbColor: color.white } : {})}
          />
        </View>
        {cookbook.public && form.public && (
          <View
            style={{
              gap: 10,
              padding: 14,
              borderRadius: radius.md,
              backgroundColor: color.bg,
            }}
          >
            <Text selectable numberOfLines={2} style={[s.small, { fontFamily: font.medium }]}>
              {cookbookLink(cookbook.id)}
            </Text>
            <Button
              small
              variant="secondary"
              icon={copied ? Check : Share2}
              title={copied ? tr('Link copied') : tr('Share link')}
              onPress={share}
              style={{ alignSelf: 'flex-start' }}
            />
          </View>
        )}
        {shareable && (
          <View style={[s.row, { gap: 14 }]}>
            <Pressable
              accessible={false}
              focusable={false}
              onPress={() => setForm((f) => ({ ...f, household: !f.household }))}
              style={{ flex: 1, gap: 2 }}
            >
              <Text style={s.h3}>{tr('Share with my household')}</Text>
              <Text style={s.muted}>
                {tr('Everyone in {{v0}} can open it, your private recipes in it too.', {
                  v0: household,
                })}
              </Text>
            </Pressable>
            <Switch
              value={form.household}
              onValueChange={(on) => setForm((f) => ({ ...f, household: on }))}
              accessibilityLabel={tr('Share with my household')}
              trackColor={{ false: color.line, true: color.ink }}
              thumbColor={color.white}
              {...(Platform.OS === 'web' ? { activeThumbColor: color.white } : {})}
            />
          </View>
        )}
      </View>
      <SheetError message={error} />
      <Button
        title={tr('Save changes')}
        disabled={!name || !Object.keys(changes).length}
        busy={busy}
        onPress={() => void save()}
      />
    </Dialog>
  );
}
