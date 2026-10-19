import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, font, s } from '../lib/theme';
import { FixDraft } from '../lib/recipeFixes';
import { dropEdit, editDraft, KitchenNote, RecipeEdit } from '../lib/yourVersion';
import { fixTitle } from './RecipeFixes';
import { CookingPot, PenLine, Plus, Send, SlidersHorizontal, Trash2 } from './icons';
import { SettingsRow } from './SettingsRow';
import { ShareCooking } from './CookInsights';
import { Button, Dialog, Field, IconButton } from './ui';

/** Beside a step or ingredient the member changed, in their version. */
export function YoursMark() {
  const { t: tr } = useI18n();
  return <Text style={styles.mark}>{tr('Yours')}</Text>;
}

/**
 * One quiet line where the member keeps changes to the recipe: that it shows their version, how
 * many changes, a switch to the original and back, and the changes themselves.
 */
export function YourVersionBar({
  edits,
  original,
  onToggle,
  onManage,
}: {
  edits: RecipeEdit[];
  original: boolean;
  onToggle: () => void;
  onManage: () => void;
}) {
  const { t: tr } = useI18n();
  if (!edits.length) return null;
  const unfit = edits.filter((e) => !e.fits).length;
  return (
    <View style={[s.row, { gap: 8, paddingHorizontal: 4, flexWrap: 'wrap' }]}>
      <PenLine size={15} color={color.ink} strokeWidth={2} />
      <Text style={[s.small, { color: color.ink }]}>
        {original ? tr('The original recipe') : tr('Your version')}
      </Text>
      <Text style={s.small}>
        {' · '}
        {unfit
          ? tr('changesUnfit', { count: edits.length, unfit })
          : tr('changeCount', { count: edits.length })}
      </Text>
      <Pressable accessibilityRole="button" onPress={onToggle} hitSlop={8}>
        <Text style={[s.small, styles.link]}>
          {original ? tr('Show your version') : tr('Show the original')}
        </Text>
      </Pressable>
      <View style={{ flex: 1 }} />
      <IconButton
        icon={SlidersHorizontal}
        label={tr('Your changes')}
        size={34}
        plain
        onPress={onManage}
      />
    </View>
  );
}

/**
 * The member's changes to a recipe: what each changes and what they said, a way to drop it, to
 * keep one whose step or ingredient changed since, or to suggest it to the recipe's cook, and to
 * add another.
 */
export function YourChanges({
  visible,
  onClose,
  edits,
  author,
  canSuggest,
  onSuggest,
  onAdd,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  edits: RecipeEdit[];
  /** The recipe's cook, whom a change can be suggested to. */
  author: string;
  canSuggest: boolean;
  onSuggest: (draft: FixDraft) => void;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [busy, setBusy] = useState('');
  const run = (id: string, fn: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(id);
    void app
      .act(async () => {
        await fn();
        onChanged();
      }, message)
      .finally(() => setBusy(''));
  };
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={tr('Your changes')}
      footer={<Button title={tr('Add a change')} icon={Plus} variant="secondary" onPress={onAdd} />}
    >
      <Text style={s.muted}>
        {tr(
          'Only you see these. The recipe opens your way, and its cook’s own changes still come through.',
        )}
      </Text>
      {edits.map((e, i) => (
        <View
          key={e.id}
          style={[
            { gap: 6, paddingVertical: 12 },
            i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
          ]}
        >
          <View style={[s.row, { gap: 6 }]}>
            <Text style={[styles.title, { flex: 1 }]}>
              {fixTitle(tr, { ...e, before: e.before, after: e.after })}
            </Text>
            {canSuggest && e.fits && (
              <IconButton
                icon={Send}
                label={tr('Suggest to {{v0}}', { v0: author })}
                size={34}
                plain
                onPress={() => onSuggest(editDraft(e))}
              />
            )}
            <IconButton
              icon={Trash2}
              label={tr('Drop this change')}
              size={34}
              plain
              disabled={busy === e.id}
              onPress={() => run(e.id, () => dropEdit(e.id), 'The change is dropped.')}
            />
          </View>
          {!!e.said && <Text style={styles.quote}>“{e.said}”</Text>}
          {!e.fits && (
            <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
              <Text style={[s.small, { color: color.warning }]}>
                {tr('The recipe changed here since.')}
              </Text>
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={() =>
                  run(
                    e.id,
                    () =>
                      api(`/recipe-edits/${encodeURIComponent(e.id)}`, {
                        method: 'PATCH',
                        body: { keep: true },
                      }),
                    'Your change is kept.',
                  )
                }
              >
                <Text style={[s.small, styles.link]}>{tr('Keep my change')}</Text>
              </Pressable>
            </View>
          )}
        </View>
      ))}
    </Dialog>
  );
}

/**
 * What the sous-chef should know about the member's kitchen and taste, for every recipe ("my
 * oven runs hot"): the notes kept, a way to remove one, and to add one.
 */
export function KitchenNotes({ bare }: { bare?: boolean }) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [notes, setNotes] = useState<KitchenNote[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const signedIn = !!app.user;
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api<{ notes?: KitchenNote[] }>('/me/kitchen-notes')
      .then((v) => live && Array.isArray(v?.notes) && setNotes(v.notes))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [signedIn]);
  if (!signedIn || !notes) return null;
  const add = () => {
    const note = draft.trim();
    if (busy || note.length < 2) return;
    setBusy(true);
    void app
      .act(async () => {
        const kept = await api<KitchenNote>('/me/kitchen-notes', {
          method: 'POST',
          body: { note },
        });
        setNotes((list) => (list?.some((n) => n.id === kept.id) ? list : [...(list ?? []), kept]));
        setDraft('');
      })
      .finally(() => setBusy(false));
  };
  const remove = (n: KitchenNote) =>
    void app.act(async () => {
      await api(`/me/kitchen-notes/${encodeURIComponent(n.id)}`, { method: 'DELETE' });
      setNotes((list) => list?.filter((x) => x.id !== n.id) ?? null);
    });
  return (
    <View style={[!bare && s.card, { gap: 10 }]}>
      <View style={{ gap: 2 }}>
        <Text style={s.h3}>{tr('Kitchen notes')}</Text>
        <Text style={s.muted}>
          {tr('What the sous-chef should know about your kitchen and taste, for every recipe.')}
        </Text>
      </View>
      {notes.map((n) => (
        <View key={n.id} style={[s.row, { gap: 8 }]}>
          <Text style={[s.body, { flex: 1 }]}>{n.note}</Text>
          <IconButton
            icon={Trash2}
            label={tr('Remove {{v0}}', { v0: n.note })}
            size={34}
            plain
            onPress={() => remove(n)}
          />
        </View>
      ))}
      <View style={[s.row, { gap: 8 }]}>
        <Field
          value={draft}
          onChangeText={setDraft}
          placeholder={tr('My oven runs hot')}
          accessibilityLabel={tr('A kitchen note')}
          maxLength={200}
          onSubmitEditing={add}
        />
        <Button
          title={tr('Add')}
          small
          busy={busy}
          disabled={draft.trim().length < 2}
          onPress={add}
        />
      </View>
    </View>
  );
}

/**
 * Settings' row for how the member cooks in Savorly: their kitchen notes, and whether cooking
 * mode shares how their cooking goes (docs/COOK-TESTED.md), in one sheet.
 */
export function YourCooking() {
  const { t: tr } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  if (!app.user) return null;
  return (
    <>
      <SettingsRow
        icon={CookingPot}
        title={tr('Your cooking')}
        text={tr('Kitchen notes, and what cooking mode shares')}
        onPress={() => setOpen(true)}
      />
      <Dialog visible={open} onClose={() => setOpen(false)} title={tr('Your cooking')}>
        <KitchenNotes bare />
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line }}>
          <ShareCooking bare />
        </View>
      </Dialog>
    </>
  );
}

const styles = StyleSheet.create({
  mark: { fontFamily: font.semibold, fontSize: 11, color: color.muted },
  link: { color: color.ink, textDecorationLine: 'underline' },
  title: { color: color.ink, fontFamily: font.semibold, fontSize: 15, lineHeight: 21 },
  quote: { fontFamily: font.regular, fontSize: 14, lineHeight: 21, color: '#3A3A3A' },
});
