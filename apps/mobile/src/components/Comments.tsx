import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { CornerDownRight, MessageCircle, Trash2 } from './icons';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/store';
import { threads, timeAgo } from '../lib/social';
import { color, font, radius, s } from '../lib/theme';
import type { Recipe, RecipeComment } from '../lib/types';
import { Avatar, Button, Dialog, Field, Press } from './ui';
import { DangerButton } from '../screens/Kitchen';

const PAGE = 20;
const LIMIT = 1000;

/**
 * Questions and tips under a recipe, oldest first, a page at a time. Anyone can read them; posting
 * asks a guest to sign in. Replies go one level deep: replying to a reply joins its conversation.
 */
export function Comments({ recipe, wide }: { recipe: Recipe; wide?: boolean }) {
  const { t: tr, locale, number } = useI18n();
  const app = useApp();
  const [items, setItems] = useState<RecipeComment[]>([]);
  // Comments that came in pages, so the next page starts after them however many were posted or
  // deleted here since.
  const paged = useRef(new Set<string>());
  const [more, setMore] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'off'>('loading');
  const [error, setError] = useState('');
  const [total, setTotal] = useState(recipe.commentCount ?? 0);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<RecipeComment | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'post' | 'reply' | 'more' | 'delete' | null>(null);
  const [doomed, setDoomed] = useState<RecipeComment | null>(null);
  // "5 min ago" counts from when the comments last arrived, so a render never reads the clock.
  const [now, setNow] = useState(0);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  // Each fresh start outdates pages still on their way from an earlier one.
  const generation = useRef(0);
  const id = encodeURIComponent(recipe.id);
  const load = useCallback(
    async (first: boolean) => {
      const asked = first ? ++generation.current : generation.current;
      const offset = first ? 0 : paged.current.size;
      const page = await api<RecipeComment[]>(
        `/recipes/${id}/comments?offset=${offset}&limit=${PAGE}`,
      );
      if (!live.current || asked !== generation.current) return;
      if (first) paged.current.clear();
      const list = Array.isArray(page) ? page : [];
      for (const c of list) paged.current.add(c.id);
      setItems((old) => {
        const fresh = new Set(list.map((c) => c.id));
        return [...(first ? [] : old.filter((c) => !fresh.has(c.id))), ...list];
      });
      setNow(Date.now());
      setMore(list.length === PAGE);
      // Every comment is here once the last page is: count them, rather than trust a count that
      // came with the recipe some time ago.
      if (list.length < PAGE) setTotal(offset + list.length);
      else setTotal((n) => Math.max(n, offset + list.length));
    },
    [id],
  );
  const opening = useCallback(() => {
    const started = load(true);
    // load() has counted this start already; a later one makes it stale.
    const asked = generation.current;
    const current = () => live.current && generation.current === asked;
    return started
      .then(() => current() && setState('ready'))
      .catch((e: Error) => {
        if (!current()) return;
        // A server without comments, or a recipe that isn't public: nothing to show.
        if (e instanceof ApiError && e.status === 404) setState('off');
        else {
          setError(e.message);
          setState('failed');
        }
      });
  }, [load]);
  // Signing in or out changes which comments you may delete.
  const userId = app.user?.id ?? null;
  useEffect(() => {
    void opening();
  }, [opening, userId]);
  const retry = () => {
    setState('loading');
    setError('');
    void opening();
  };
  const showMore = async () => {
    setBusy('more');
    await app.act(() => load(false));
    if (live.current) setBusy(null);
  };
  const post = async (text: string, parent: RecipeComment | null) => {
    if (!app.requireUser()) return;
    const body = text.trim();
    if (!body) return;
    setBusy(parent ? 'reply' : 'post');
    const ok = await app.act(async () => {
      const comment = await api<RecipeComment>(`/recipes/${id}/comments`, {
        method: 'POST',
        body: parent ? { body, parentId: parent.parentId || parent.id } : { body },
      });
      if (!live.current) return;
      setItems((old) => [...old.filter((c) => c.id !== comment.id), comment]);
      setTotal((n) => n + 1);
      setNow(Date.now());
    });
    if (!live.current) return;
    setBusy(null);
    if (!ok) return;
    if (parent) {
      setReply('');
      setReplyTo(null);
    } else setDraft('');
  };
  const remove = async (comment: RecipeComment) => {
    setBusy('delete');
    await app.act(async () => {
      await api(`/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
      if (!live.current) return;
      // A conversation goes with its first comment.
      const gone = new Set([
        comment.id,
        ...items.filter((c) => c.parentId === comment.id).map((c) => c.id),
      ]);
      for (const c of gone) paged.current.delete(c);
      setItems((old) => old.filter((c) => !gone.has(c.id)));
      setTotal((n) => Math.max(0, n - gone.size));
      if (replyTo && gone.has(replyTo.id)) setReplyTo(null);
      setDoomed(null);
    }, 'Comment deleted.');
    if (live.current) setBusy(null);
  };
  if (state === 'off') return null;
  const count = Math.max(total, items.length);
  const conversations = threads(items);
  const entry = (c: RecipeComment, nested: boolean) => (
    <View key={c.id} style={{ gap: 6 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Avatar name={c.author.name} uri={c.author.avatar} size={nested ? 26 : 32} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[s.h3, { fontSize: 14, lineHeight: 19 }]}>
            {c.author.name}
          </Text>
          <Text style={[s.small, { fontFamily: font.medium }]}>
            {timeAgo(c.createdAt, now, tr, locale)}
          </Text>
        </View>
      </View>
      <Text style={[s.body, { marginLeft: nested ? 36 : 42 }]}>{c.body}</Text>
      <View style={[s.row, { marginLeft: nested ? 26 : 32, gap: 2 }]}>
        <Action
          icon={CornerDownRight}
          title={tr('Reply')}
          label={tr('Reply to {{v0}}', { v0: c.author.name })}
          onPress={() =>
            app.requireUser(() => {
              setReplyTo(c.parentId ? (items.find((p) => p.id === c.parentId) ?? c) : c);
              setReply('');
            })
          }
        />
        {c.canDelete && (
          <Action
            icon={Trash2}
            title={tr('Delete')}
            label={tr('Delete comment by {{v0}}', { v0: c.author.name })}
            onPress={() => setDoomed(c)}
          />
        )}
      </View>
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      <View style={[s.row, { gap: 8 }]}>
        <MessageCircle size={20} color={color.ink} strokeWidth={2} />
        <Text role="heading" aria-level={2} style={[s.h2, wide && styles.wideHeading]}>
          {count ? tr('commentCount', { count }) : tr('Comments')}
        </Text>
      </View>
      {state === 'loading' && (
        <ActivityIndicator color={color.ink} style={{ alignSelf: 'flex-start' }} />
      )}
      {state === 'failed' && (
        <View style={{ gap: 8, alignItems: 'flex-start' }}>
          <Text accessibilityRole="alert" style={{ color: color.error }}>
            {tr(error)}
          </Text>
          <Button title={tr('Try again')} variant="secondary" small onPress={retry} />
        </View>
      )}
      {state === 'ready' && !items.length && (
        <Text style={s.muted}>{tr('No comments yet. Ask a question or share a tip.')}</Text>
      )}
      {conversations.map(({ comment, replies }) => (
        <View key={comment.id} style={[s.card, { gap: 14 }, wide && { padding: 24 }]}>
          {entry(comment, false)}
          {(replies.length > 0 || replyTo?.id === comment.id) && (
            <View style={styles.replies}>
              {replies.map((r) => entry(r, true))}
              {replyTo?.id === comment.id && (
                <View style={{ gap: 10 }}>
                  <Field
                    label={tr('Reply to {{v0}}', { v0: comment.author.name })}
                    multiline
                    autoFocus
                    maxLength={LIMIT}
                    placeholder={tr('Write a reply…')}
                    value={reply}
                    onChangeText={setReply}
                    style={styles.input}
                  />
                  <View style={[s.row, { gap: 8, justifyContent: 'flex-end' }]}>
                    <Button
                      title={tr('Cancel')}
                      variant="ghost"
                      small
                      onPress={() => setReplyTo(null)}
                    />
                    <Button
                      title={tr('Post reply')}
                      small
                      busy={busy === 'reply'}
                      disabled={!reply.trim() || (!!busy && busy !== 'reply')}
                      onPress={() => void post(reply, comment)}
                    />
                  </View>
                </View>
              )}
            </View>
          )}
        </View>
      ))}
      {more && (
        <Button
          title={tr('Show more')}
          label={tr('Show more comments')}
          variant="secondary"
          small
          busy={busy === 'more'}
          onPress={() => void showMore()}
          style={{ alignSelf: 'flex-start' }}
        />
      )}
      {state !== 'loading' && (
        <View style={[s.card, { gap: 12 }, wide && { padding: 24 }]}>
          <Field
            label={tr('Your comment')}
            multiline
            maxLength={LIMIT}
            placeholder={tr('Ask a question or share a tip…')}
            value={draft}
            onChangeText={setDraft}
            style={styles.input}
          />
          <View style={[s.row, { gap: 10, justifyContent: 'space-between' }]}>
            <Text style={s.small}>
              {draft.length > LIMIT - 100
                ? tr('{{v0}} of {{v1}} characters', { v0: number(draft.length), v1: number(LIMIT) })
                : ''}
            </Text>
            <Button
              title={tr('Post comment')}
              small
              busy={busy === 'post'}
              disabled={!draft.trim() || (!!busy && busy !== 'post')}
              onPress={() => void post(draft, null)}
            />
          </View>
        </View>
      )}
      <Dialog visible={!!doomed} onClose={() => setDoomed(null)} title={tr('Delete this comment?')}>
        {doomed && (
          <View style={[s.card, { gap: 6, padding: 16 }]}>
            <Text style={[s.small, { fontFamily: font.bold }]}>{doomed.author.name}</Text>
            <Text numberOfLines={6} style={s.body}>
              {doomed.body}
            </Text>
          </View>
        )}
        <DangerButton
          title={tr('Delete comment')}
          busy={busy === 'delete'}
          onPress={() => doomed && void remove(doomed)}
        />
      </Dialog>
    </View>
  );
}
// A small text action under a comment, with a full-size touch target.
function Action({
  icon: Icon,
  title,
  label,
  onPress,
}: {
  icon: typeof Trash2;
  title: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      scale={0.96}
      style={[s.row, { gap: 6, minHeight: 44, paddingHorizontal: 10, borderRadius: radius.pill }]}
    >
      <Icon size={15} color={color.muted} strokeWidth={2} />
      <Text style={[s.small, { fontSize: 13 }]}>{title}</Text>
    </Press>
  );
}
const styles = StyleSheet.create({
  wideHeading: { fontSize: 24, lineHeight: 30, letterSpacing: -0.6 },
  replies: {
    gap: 14,
    marginLeft: 16,
    paddingLeft: 16,
    borderLeftWidth: 2,
    borderColor: color.line,
  },
  input: { minHeight: 84, backgroundColor: color.bg, borderColor: color.border },
});
