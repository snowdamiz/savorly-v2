import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { color, s } from '../lib/theme';
import type { Creator, Review, ReviewReply as Reply } from '../lib/types';
import { Button, Field } from './ui';

const LIMIT = 1000;

/**
 * The recipe author's answer under a review: everyone reads it, and the author can write, change
 * or remove it.
 */
export function ReviewReply({
  recipeId,
  review,
  author,
  canReply,
  onChanged,
}: {
  recipeId: string;
  review: Review;
  /** The recipe's author, who answers. */
  author: Creator;
  canReply: boolean;
  onChanged: (reply: Reply | null) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const reply = review.reply;
  const path = `/recipes/${encodeURIComponent(recipeId)}/reviews/${encodeURIComponent(review.id)}/reply`;
  const save = async () => {
    setBusy('save');
    let saved: Reply | null = null;
    const ok = await app.act(async () => {
      saved = (await api<{ reply: Reply }>(path, { method: 'PUT', body: { body: text.trim() } }))
        .reply;
    }, 'Reply posted.');
    setBusy(null);
    if (ok && saved) {
      onChanged(saved);
      setEditing(false);
    }
  };
  const remove = async () => {
    setBusy('remove');
    const ok = await app.act(() => api(path, { method: 'DELETE' }), 'Reply removed.');
    setBusy(null);
    if (ok) onChanged(null);
  };
  if (editing)
    return (
      <View style={[styles.reply, { gap: 10 }]}>
        <Field
          label={tr('Reply to {{v0}}', { v0: review.author.name })}
          multiline
          autoFocus
          maxLength={LIMIT}
          placeholder={tr('Write a reply…')}
          value={text}
          onChangeText={setText}
          style={styles.input}
        />
        <View style={[s.row, { gap: 8, justifyContent: 'flex-end' }]}>
          <Button title={tr('Cancel')} variant="ghost" small onPress={() => setEditing(false)} />
          <Button
            title={tr('Post reply')}
            small
            busy={busy === 'save'}
            disabled={text.trim().length < 2 || !!busy}
            onPress={() => void save()}
          />
        </View>
      </View>
    );
  if (reply)
    return (
      <View style={[styles.reply, { gap: 6 }]}>
        <Text style={[s.small, { color: color.ink }]}>
          {tr('Reply from {{v0}}', { v0: author.name })}
        </Text>
        <Text style={s.body}>{reply.body}</Text>
        {canReply && (
          <View style={[s.row, { gap: 8 }]}>
            <Button
              title={tr('Edit reply')}
              variant="ghost"
              small
              disabled={!!busy}
              onPress={() => {
                setText(reply.body);
                setEditing(true);
              }}
            />
            <Button
              title={tr('Remove reply')}
              variant="ghost"
              small
              busy={busy === 'remove'}
              disabled={!!busy}
              onPress={() => void remove()}
            />
          </View>
        )}
      </View>
    );
  if (!canReply) return null;
  return (
    <View style={{ alignSelf: 'flex-start' }}>
      <Button
        title={tr('Reply')}
        label={tr('Reply to {{v0}}', { v0: review.author.name })}
        variant="secondary"
        small
        onPress={() => {
          setText('');
          setEditing(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  reply: { marginLeft: 16, paddingLeft: 16, borderLeftWidth: 2, borderColor: color.line },
  input: { minHeight: 84, backgroundColor: color.bg, borderColor: color.outline },
});
