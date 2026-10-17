import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Camera, Check, CookingPot, Images, Trash2, X } from './icons';
import { api, ApiError } from '../lib/api';
import { haptic } from '../lib/haptics';
import { pickPhoto, preparePhoto, uploadMedia } from '../lib/photos';
import { timeAgo } from '../lib/social';
import { useApp } from '../lib/store';
import { color, font, radius, s } from '../lib/theme';
import type { Recipe, RecipeCook } from '../lib/types';
import { Avatar, Button, Dialog, Field, FoodImage, IconButton, Press } from './ui';
import { Working } from './ProfilePhoto';

const NOTE_LIMIT = 500;
const SHOWN = 12;

/**
 * "I cooked this": whether you cooked the recipe, with an optional photo and note, how many cooks
 * made it, and the photos they shared. Whether you cooked it comes from the library
 * (`cookedIds`), or from the cooks themselves on a server that doesn't list them there. The
 * recipe page puts the toggle with its other actions and the photos with the reviews, so the
 * state lives here: `CookPhotos` and `CookSheets` show it.
 */
export function useCooked(
  recipe: Recipe,
  /** Changes when another part of the page asks to open the sheet, e.g. after cooking. */
  request?: number,
) {
  const app = useApp();
  const userId = app.user?.id ?? null;
  const [cooks, setCooks] = useState<RecipeCook[] | null>(null);
  const [off, setOff] = useState(false);
  const [count, setCount] = useState(recipe.cookedCount ?? 0);
  // What this page last changed, until the library catches up.
  const [mark, setMark] = useState<boolean | null>(null);
  const [sheet, setSheet] = useState(false);
  // A cook's photo, opened large; `at` is when, for "2 days ago".
  const [open, setOpen] = useState<{ cook: RecipeCook; at: number } | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const opened = useRef(request);
  useEffect(() => {
    if (request === undefined || request === opened.current) return;
    opened.current = request;
    app.requireUser(() => setSheet(true));
  }, [request, app]);
  const id = encodeURIComponent(recipe.id);
  // Only the latest list counts, however the answers arrive.
  const asked = useRef(0);
  const loadCooks = useCallback(() => {
    const n = ++asked.current;
    const latest = () => live.current && n === asked.current;
    return api<RecipeCook[]>(`/recipes/${id}/cooks?limit=${SHOWN}`)
      .then((list) => {
        if (latest()) setCooks(Array.isArray(list) ? list : []);
      })
      .catch((e: Error) => {
        // A server without cooks has nothing to show or keep here.
        if (latest() && e instanceof ApiError && e.status === 404) setOff(true);
      });
  }, [id]);
  useEffect(() => {
    void loadCooks();
  }, [loadCooks]);
  const mine = cooks?.find((c) => c.author.id === userId);
  const listed = app.library.cookedIds;
  const cooked = !!userId && (mark ?? (listed ? listed.includes(recipe.id) : !!mine));
  const shown = Math.max(count, cooks?.length ?? 0, cooked ? 1 : 0);
  return {
    recipe,
    /** The server keeps no cooks, so there's nothing to show or mark. */
    off,
    cooked,
    mine,
    count: shown,
    photos: (cooks ?? []).filter((c) => !!c.photo),
    sheet,
    open,
    /** Opens the sheet that marks the recipe cooked, or changes or takes back the mark. */
    start: () => app.requireUser(() => setSheet(true)),
    view: (cook: RecipeCook) => setOpen({ cook, at: Date.now() }),
    closeSheet: () => setSheet(false),
    closePhoto: () => setOpen(null),
    changed: (next: boolean, total?: number) => {
      const step = next === cooked ? 0 : next ? 1 : -1;
      setMark(next);
      setCount(total ?? Math.max(0, shown + step));
      setSheet(false);
      void loadCooks();
      void app.refreshLibrary().catch(() => {});
    },
  };
}
export type Cooked = ReturnType<typeof useCooked>;

/** How many cooks made the recipe, and the photos they shared. */
export function CookPhotos({ cooked, wide }: { cooked: Cooked; wide?: boolean }) {
  const { t: tr } = useI18n();
  const { photos } = cooked;
  if (cooked.off || (!cooked.count && !photos.length)) return null;
  const thumbs = photos.map((c) => (
    <Press
      key={c.id}
      accessibilityRole="button"
      accessibilityLabel={tr('Photo by {{v0}}', { v0: c.author.name })}
      onPress={() => cooked.view(c)}
      scale={0.96}
    >
      <FoodImage uri={c.photo} style={{ width: 72, height: 72, borderRadius: radius.md }} />
    </Press>
  ));
  return (
    <View style={{ gap: 12 }}>
      {cooked.count > 0 && (
        <View style={[s.row, { gap: 8 }]}>
          <CookingPot size={16} color={color.ink} strokeWidth={2} />
          <Text style={[s.h3, { fontSize: 14, lineHeight: 20 }]}>
            {tr('cookedCount', { count: cooked.count })}
          </Text>
        </View>
      )}
      {photos.length > 0 &&
        (wide ? (
          <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>{thumbs}</View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ gap: 8 }}
          >
            {thumbs}
          </ScrollView>
        ))}
    </View>
  );
}

/** The sheet that marks the recipe cooked, and a cook's photo opened large. */
export function CookSheets({ cooked }: { cooked: Cooked }) {
  const { t: tr, locale } = useI18n();
  const { open } = cooked;
  const viewing = open?.cook;
  return (
    <>
      <CookSheet
        visible={cooked.sheet}
        recipe={cooked.recipe}
        cooked={cooked.cooked}
        mine={cooked.mine}
        onClose={cooked.closeSheet}
        onChanged={cooked.changed}
      />
      <Dialog
        visible={!!open}
        onClose={cooked.closePhoto}
        title={viewing?.author.name}
        leading={
          viewing ? (
            <Avatar name={viewing.author.name} uri={viewing.author.avatar} size={36} />
          ) : null
        }
      >
        {open && viewing && (
          <>
            <FoodImage
              uri={viewing.photo}
              label={tr('Photo by {{v0}}', { v0: viewing.author.name })}
              width={460}
              style={{ width: '100%', aspectRatio: 1, borderRadius: radius.lg }}
            />
            <Text style={s.small}>{timeAgo(viewing.createdAt, open.at, tr, locale)}</Text>
            {!!viewing.note && <Text style={s.body}>{viewing.note}</Text>}
          </>
        )}
      </Dialog>
    </>
  );
}

// Marks the recipe as cooked, with a photo and a note if the cook likes; for a recipe already
// marked, changes them or takes the mark back.
function CookSheet({
  visible,
  recipe,
  cooked,
  mine,
  onClose,
  onChanged,
}: {
  visible: boolean;
  recipe: Recipe;
  cooked: boolean;
  mine?: RecipeCook;
  onClose: () => void;
  onChanged: (cooked: boolean, total?: number) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [photo, setPhoto] = useState('');
  // A local copy shows straight away while the photo uploads.
  const [local, setLocal] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'photo' | 'save' | 'remove' | null>(null);
  const [error, setError] = useState('');
  // Each opening starts from what was shared before.
  const [opened, setOpened] = useState(false);
  if (opened !== visible) {
    setOpened(visible);
    if (visible) {
      setPhoto(cooked ? (mine?.photo ?? '') : '');
      setNote(cooked ? (mine?.note ?? '') : '');
      setLocal('');
      setBusy(null);
      setError('');
    }
  }
  const live = useRef(visible);
  useEffect(() => {
    live.current = visible;
    return () => {
      live.current = false;
    };
  }, [visible]);
  const choose = async (from: 'camera' | 'library') => {
    setError('');
    try {
      const picked = await pickPhoto(from);
      if (!picked || !live.current) return;
      setBusy('photo');
      const ready = await preparePhoto(picked, { max: 2048 });
      if (!live.current) return;
      setLocal(ready.uri);
      const url = await uploadMedia({ uri: ready.uri, fileName: 'cooked.jpg' }, 'image');
      if (live.current) setPhoto(url);
    } catch (e) {
      if (live.current) {
        setLocal('');
        setError((e as Error).message);
      }
    } finally {
      if (live.current) setBusy(null);
    }
  };
  const id = encodeURIComponent(recipe.id);
  const save = async () => {
    setError('');
    setBusy('save');
    // The sheet shows the whole entry, so both always go: the server keeps a field only when it's
    // left out, and an empty one clears it.
    const body = { photo, note: note.trim() };
    let total: number | undefined;
    const ok = await app.act(
      async () => {
        const result = await api<{ cooked: boolean; cookedCount?: number }>(
          `/recipes/${id}/cooked`,
          { method: 'POST', body },
        );
        total = result?.cookedCount;
      },
      cooked ? 'Your photo and note are saved.' : 'Marked as cooked. Enjoy!',
    );
    if (!live.current) return;
    setBusy(null);
    if (!ok) return;
    if (!cooked) haptic.tap();
    onChanged(true, typeof total === 'number' ? total : undefined);
  };
  const remove = async () => {
    setError('');
    setBusy('remove');
    const ok = await app.act(
      () => api(`/recipes/${id}/cooked`, { method: 'DELETE' }),
      'No longer marked as cooked.',
    );
    if (!live.current) return;
    setBusy(null);
    if (ok) onChanged(false);
  };
  const preview = local || photo;
  const changed = photo !== (mine?.photo ?? '') || note.trim() !== (mine?.note ?? '').trim();
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={cooked ? tr('You cooked this') : tr('I cooked this')}
    >
      <Text style={s.muted}>{tr('Add a photo and a note for other cooks, if you like.')}</Text>
      {preview ? (
        <View>
          <FoodImage
            uri={preview}
            label={tr('Your photo')}
            width={460}
            style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: radius.lg }}
          />
          {busy === 'photo' && <Working touch={false} radius={radius.lg} />}
          <View style={{ position: 'absolute', top: 10, right: 10 }}>
            <IconButton
              icon={X}
              glass
              size={38}
              label={tr('Remove photo')}
              disabled={busy === 'photo'}
              onPress={() => {
                setPhoto('');
                setLocal('');
              }}
            />
          </View>
        </View>
      ) : (
        <View style={[s.row, { gap: 10 }]}>
          <Source
            icon={Camera}
            title={tr('Take a photo')}
            disabled={!!busy}
            onPress={() => void choose('camera')}
          />
          <Source
            icon={Images}
            title={tr('Choose a photo')}
            disabled={!!busy}
            onPress={() => void choose('library')}
          />
        </View>
      )}
      <Field
        label={tr('Note')}
        multiline
        maxLength={NOTE_LIMIT}
        placeholder={tr('Add a note (optional)…')}
        value={note}
        onChangeText={setNote}
        style={{ minHeight: 84 }}
      />
      {!!error && (
        <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
          {tr(error)}
        </Text>
      )}
      {(!cooked || changed) && (
        <Button
          title={cooked ? tr('Save changes') : tr('Mark as cooked')}
          icon={Check}
          large
          busy={busy === 'save'}
          disabled={!!busy && busy !== 'save'}
          onPress={() => void save()}
        />
      )}
      {cooked && (
        <Button
          title={tr('Unmark as cooked')}
          icon={Trash2}
          variant="ghost"
          busy={busy === 'remove'}
          disabled={!!busy && busy !== 'remove'}
          onPress={() => void remove()}
        />
      )}
    </Dialog>
  );
}
function Source({
  icon: Icon,
  title,
  disabled,
  onPress,
}: {
  icon: typeof Camera;
  title: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      scale={0.96}
      style={[s.card, { flex: 1, alignItems: 'center', gap: 10, paddingVertical: 18 }]}
    >
      <View style={styles.source}>
        <Icon size={20} color={color.ink} strokeWidth={2} />
      </View>
      <Text numberOfLines={1} style={[s.h3, { fontSize: 14, fontFamily: font.bold }]}>
        {title}
      </Text>
    </Press>
  );
}
const styles = StyleSheet.create({
  source: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
