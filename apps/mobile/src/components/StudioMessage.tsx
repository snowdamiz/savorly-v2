import { useI18n } from '../lib/i18n';
import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StudioEffect, StudioEvent } from '../lib/types';
import { color, radius, s } from '../lib/theme';
import { FoodImage, Press } from './ui';
import { Reply, bubble } from './ChatBubbles';
import { Receipts, type Receipt } from './Receipts';

/** Consecutive events from one side, shown as one message; receipts remember their event. */
export type StudioMessageGroup = StudioEvent & { receipts: Receipt[]; seqs: number[] };

/**
 * One message of the conversation: the member's in a dark bubble on the right, the sous-chef's
 * as a reply that grows out of the thinking dots, with the recipe cards and receipts it brought.
 */
export function StudioMessage({
  event,
  grow,
  onGrown,
  undoing,
  onOpenRecipe,
  onViewReceipt,
  onUndoReceipt,
}: {
  event: StudioMessageGroup;
  /** Whether this reply grows out of the thinking bubble as it arrives. */
  grow: boolean;
  onGrown: () => void;
  /** The receipt being undone, as `seq:index`. */
  undoing?: string;
  onOpenRecipe: (id: string) => void;
  onViewReceipt: (effect: StudioEffect) => void;
  onUndoReceipt: (receipt: Receipt) => void;
}) {
  const { t: tr } = useI18n();
  // A failed or stopped turn's reply is the server's own sentence, which has a translation.
  const failed = event.role === 'assistant' && !!event.failed;
  const body = (
    <>
      <Text
        style={{
          ...s.small,
          color: event.role === 'user' ? color.onInk : color.muted,
        }}
      >
        {event.role === 'user' ? tr('You') : tr('Sous-chef')}
        {event.imageCount ? tr('recipePhotos', { count: event.imageCount }) : ''}
      </Text>
      <Text
        selectable
        style={{
          ...s.body,
          color: event.role === 'user' ? color.white : failed ? color.error : color.ink,
        }}
      >
        {failed ? tr(event.content) : event.content}
      </Text>
      {!!event.recipes?.length && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, paddingTop: 6 }}
        >
          {event.recipes.map((r) => (
            <Press
              key={r.id}
              accessibilityRole="button"
              accessibilityLabel={tr('Open {{v0}}', { v0: r.title })}
              onPress={() => onOpenRecipe(r.id)}
              style={{ width: 148, gap: 6 }}
            >
              <FoodImage
                uri={r.image}
                style={{ width: 148, height: 104, borderRadius: radius.sm }}
              />
              <Text numberOfLines={2} style={s.h3}>
                {r.title}
              </Text>
              <Text style={s.small}>{tr('minuteCount', { count: r.minutes })}</Text>
            </Press>
          ))}
        </ScrollView>
      )}
      {event.receipts.length > 0 && (
        <Receipts
          receipts={event.receipts}
          undoing={undoing}
          onView={onViewReceipt}
          onUndo={onUndoReceipt}
        />
      )}
    </>
  );
  return event.role === 'user' ? (
    <View style={[bubble, { alignSelf: 'flex-end', backgroundColor: color.ink }]}>{body}</View>
  ) : (
    <Reply grow={grow} onGrown={onGrown} tone={failed ? 'error' : undefined}>
      {body}
    </Reply>
  );
}
