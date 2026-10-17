import { useI18n } from '../lib/i18n';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Check, Plus } from './icons';
import { haptic } from '../lib/haptics';
import { useLibrary } from '../lib/library';
import { color, font, maxFontScale, radius, s } from '../lib/theme';
import { Creator } from '../lib/types';
import { Press } from './ui';

/**
 * The small Follow / Following toggle on a cook's card. It follows at once (signing in first when
 * needed), and stays out of the signed-in cook's own card.
 */
export function FollowPill({
  creator,
  stretch,
}: {
  creator: Creator;
  /** Fills the width of its card. */
  stretch?: boolean;
}) {
  const { t: tr } = useI18n();
  const { followingIds, toggleFollow, userId } = useLibrary();
  if (userId === creator.id) return null;
  const following = followingIds.includes(creator.id);
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={
        following
          ? tr('Unfollow {{v0}}', { v0: creator.name })
          : tr('Follow {{v0}}', { v0: creator.name })
      }
      accessibilityState={{ selected: following }}
      onPress={() => {
        if (userId) haptic.tap();
        void toggleFollow(creator);
      }}
      hitSlop={4}
      scale={0.94}
      style={[
        s.row,
        styles.pill,
        stretch && { alignSelf: 'stretch' },
        following
          ? { backgroundColor: color.white, borderColor: color.border }
          : { backgroundColor: color.ink, borderColor: color.ink },
      ]}
    >
      {following ? (
        <Check size={14} color={color.ink} strokeWidth={2.4} />
      ) : (
        <Plus size={14} color={color.white} strokeWidth={2.4} />
      )}
      <Text
        maxFontSizeMultiplier={maxFontScale}
        style={{ fontFamily: font.bold, fontSize: 13, color: following ? color.ink : color.white }}
      >
        {following ? tr('Following') : tr('Follow')}
      </Text>
    </Press>
  );
}

const styles = StyleSheet.create({
  pill: {
    gap: 5,
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
});
