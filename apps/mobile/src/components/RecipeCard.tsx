import { useI18n } from '../lib/i18n';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BadgeCheck, Bookmark, Clock3, Play, Sparkles, Star } from './icons';
import { cookTested } from '../lib/cookInsights';
import { Recipe } from '../lib/types';
import { foodIcon } from '../lib/icons';
import { haptic } from '../lib/haptics';
import { useLibrary } from '../lib/library';
import { linkTo, pressedInApp, recipePath } from '../lib/routes';
import { color, font, radius, s, shadow } from '../lib/theme';
import { FoodImage, IconButton, Pill, animate, native, usePress, useChrome } from './ui';
import { foodConflicts, useFood } from '../lib/food';
import { AvoidPill } from './FoodWarning';
const web = Platform.OS === 'web';
export function Save({
  recipe,
  size = 38,
  glass,
  plain,
}: {
  recipe: Recipe;
  size?: number;
  glass?: boolean;
  plain?: boolean;
}) {
  const { t: tr } = useI18n();
  // Only the saved ids, not the whole store: a bookmark re-renders when saves change, and not for
  // a kitchen refresh or a new recipe list around it.
  const { savedIds, toggleSave, userId } = useLibrary();
  const saved = savedIds.includes(recipe.id);
  // The bookmark gives a little pop the moment it's kept.
  const pop = useState(() => new Animated.Value(1))[0];
  const was = useRef(saved);
  useEffect(() => {
    if (saved && !was.current) {
      pop.setValue(0.72);
      Animated.spring(pop, {
        toValue: 1,
        speed: 16,
        bounciness: 14,
        useNativeDriver: native,
      }).start();
    }
    was.current = saved;
  }, [saved, pop]);
  return (
    <Animated.View style={{ transform: [{ scale: pop }] }}>
      <IconButton
        icon={Bookmark}
        label={
          saved
            ? tr('Unsave {{v0}}', { v0: recipe.title })
            : tr('Save {{v0}}', { v0: recipe.title })
        }
        onPress={() => {
          if (userId) haptic.tap();
          void toggleSave(recipe);
        }}
        selected={saved}
        size={size}
        glass={glass}
        plain={plain}
      />
    </Animated.View>
  );
}
// The average with how many reviews it comes from ("4.8 · 12"), so a single five-star review
// doesn't read as better than a dozen 4.8s. Screen readers hear it as a sentence.
function useRating(recipe: Recipe) {
  const { t: tr, number } = useI18n();
  const rating = number(recipe.rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const count = recipe.reviewCount ?? 0;
  return {
    text: count > 0 ? `${rating} · ${number(count)}` : rating,
    label: count > 0 ? tr('ratingSummary', { rating, count }) : rating,
  };
}
// What the reader avoids that a recipe has, for its card.
function useConflicts(recipe: Recipe) {
  const { avoid, household } = useFood();
  return useMemo(() => foodConflicts(recipe, avoid, household), [recipe, avoid, household]);
}
function Badge({ recipe }: { recipe: Recipe }) {
  const { t: tr } = useI18n();
  const rating = useRating(recipe);
  // Something the reader avoids comes before anything else the card could say, and then that
  // cooks have really made it (docs/COOK-TESTED.md).
  const conflicts = useConflicts(recipe);
  return conflicts.length ? (
    <AvoidPill conflicts={conflicts} />
  ) : cookTested(recipe) ? (
    <Pill title={tr('Cook-tested')} icon={BadgeCheck} tone="dark" />
  ) : recipe.rating > 0 ? (
    <View accessible accessibilityRole={web ? 'image' : 'text'} accessibilityLabel={rating.label}>
      <Pill title={rating.text} icon={Star} fill />
    </View>
  ) : recipe.aiGenerated ? (
    <Pill title={tr('AI assisted')} icon={Sparkles} tone="glass" />
  ) : (
    <Pill
      title={tr(recipe.tags[0] || recipe.difficulty)}
      icon={foodIcon(recipe.tags[0] || '')}
      tone="glass"
    />
  );
}
// Full-bleed photo card with the title set on the image, like the hero of a native feed.
export const RecipeTile = memo(function RecipeTile({
  recipe,
  onOpen,
  width,
  height,
}: {
  recipe: Recipe;
  onOpen: (recipe: Recipe) => void;
  width?: number;
  height: number;
}) {
  const { t: tr } = useI18n();
  const press = usePress(0.97);
  // Desktop pointers get a slow push-in on the photo.
  const hover = useState(() => new Animated.Value(0))[0];
  return (
    <Animated.View
      style={[
        {
          width: width ?? '100%',
          height,
          borderRadius: radius.lg,
          overflow: 'hidden',
          backgroundColor: color.ink,
        },
        press.style,
      ]}
    >
      {/* A link on the web (/recipes/<id>): crawlable, and a new tab on a middle or modified
          click, while a plain click opens the recipe in the app. */}
      <Pressable
        {...linkTo(recipePath(recipe.id))}
        accessibilityRole={web ? 'link' : 'button'}
        accessibilityLabel={tr('View {{v0}}', { v0: recipe.title })}
        onPress={(e) => pressedInApp(e) && onOpen(recipe)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        onHoverIn={() => animate(hover, 1, 700).start()}
        onHoverOut={() => animate(hover, 0, 500).start()}
        style={StyleSheet.absoluteFill}
      >
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              transform: [
                { scale: hover.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }) },
              ],
            },
          ]}
        >
          <FoodImage uri={recipe.image} style={StyleSheet.absoluteFill} width={width ?? 300} />
        </Animated.View>
        <LinearGradient
          colors={[
            'rgba(0,0,0,0.28)',
            'rgba(0,0,0,0)',
            'rgba(0,0,0,0.03)',
            'rgba(0,0,0,0.4)',
            'rgba(0,0,0,0.8)',
          ]}
          locations={[0, 0.26, 0.44, 0.7, 1]}
          style={StyleSheet.absoluteFill}
        />
        {!!recipe.video && (
          <View
            style={{
              position: 'absolute',
              top: '38%',
              alignSelf: 'center',
              width: 46,
              height: 46,
              borderRadius: 23,
              backgroundColor: 'rgba(0,0,0,0.42)',
              borderWidth: 1,
              borderColor: color.glassBorder,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Play size={18} color="white" fill="white" />
          </View>
        )}
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16, gap: 7 }}>
          <Text
            role="heading"
            aria-level={3}
            numberOfLines={2}
            style={{
              fontFamily: font.bold,
              fontSize: 17,
              lineHeight: 22,
              letterSpacing: -0.3,
              color: color.white,
            }}
          >
            {recipe.title}
          </Text>
          <View style={[s.row, { gap: 6 }]}>
            <Clock3 size={13} color="rgba(255,255,255,0.8)" strokeWidth={2} />
            <Text
              style={{ fontFamily: font.semibold, fontSize: 12, color: 'rgba(255,255,255,0.8)' }}
            >
              {`${tr('minuteCount', { count: recipe.minutes })} · ${tr(recipe.difficulty)}`}
            </Text>
          </View>
        </View>
      </Pressable>
      <View style={{ position: 'absolute', top: 12, left: 12, pointerEvents: 'none' }}>
        <Badge recipe={recipe} />
      </View>
      <View style={{ position: 'absolute', top: 10, right: 10 }}>
        <Save recipe={recipe} size={36} glass />
      </View>
    </Animated.View>
  );
});
// Compact list row for secondary feeds and search results on small screens.
export const RecipeRow = memo(function RecipeRow({
  recipe,
  onOpen,
}: {
  recipe: Recipe;
  onOpen: (r: Recipe) => void;
}) {
  const { t: tr } = useI18n();
  const press = usePress(0.98);
  const rating = useRating(recipe);
  const conflicts = useConflicts(recipe);
  return (
    <Animated.View
      style={[
        s.row,
        {
          backgroundColor: color.white,
          borderRadius: radius.lg,
          padding: 10,
          paddingRight: 8,
          gap: 8,
          boxShadow: shadow.card,
        },
        press.style,
      ]}
    >
      <Pressable
        {...linkTo(recipePath(recipe.id))}
        accessibilityRole={web ? 'link' : 'button'}
        accessibilityLabel={tr('View {{v0}}', { v0: recipe.title })}
        onPress={(e) => pressedInApp(e) && onOpen(recipe)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[s.row, { flex: 1, gap: 14 }]}
      >
        <FoodImage uri={recipe.image} style={{ width: 76, height: 76, borderRadius: 20 }} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text role="heading" aria-level={3} numberOfLines={1} style={s.h3}>
            {recipe.title}
          </Text>
          <Text numberOfLines={1} style={[s.small, { fontFamily: font.medium }]}>
            {tr('by {{v0}}', { v0: recipe.author.name })}
          </Text>
          <View style={[s.row, { gap: 6 }]}>
            <Clock3 size={12} color={color.muted} strokeWidth={2} />
            <Text style={s.small}>
              {`${tr('minuteCount', { count: recipe.minutes })} · ${tr(recipe.difficulty)}`}
            </Text>
            {recipe.rating > 0 && (
              <View
                accessible
                accessibilityRole={web ? 'image' : 'text'}
                accessibilityLabel={rating.label}
                style={[s.row, { gap: 3, marginLeft: 4 }]}
              >
                <Star size={12} color={color.ink} fill={color.ink} />
                <Text style={[s.small, { color: color.ink }]}>{rating.text}</Text>
              </View>
            )}
            {cookTested(recipe) && (
              <View
                accessible
                accessibilityRole={web ? 'image' : 'text'}
                accessibilityLabel={tr('Cook-tested')}
                style={{ marginLeft: 4 }}
              >
                <BadgeCheck size={13} color={color.success} strokeWidth={2.2} />
              </View>
            )}
          </View>
          <AvoidPill conflicts={conflicts} />
        </View>
      </Pressable>
      <Save recipe={recipe} size={40} plain />
    </Animated.View>
  );
});
export const RecipeGrid = memo(function RecipeGrid({
  recipes,
  onOpen,
}: {
  recipes: Recipe[];
  onOpen: (recipe: Recipe) => void;
}) {
  const { width, desktop, gutter } = useChrome();
  const [gridWidth, setGridWidth] = useState(() =>
    Math.max(1, Math.min(1600, width - (desktop ? 248 : 0)) - gutter * 2),
  );
  const columns = gridWidth > 1100 ? 4 : gridWidth > 760 ? 3 : 2;
  const gap = desktop ? 20 : 12;
  const cardWidth = Math.floor((gridWidth - gap * (columns - 1)) / columns);
  return (
    <View
      onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}
    >
      {recipes.map((recipe) => (
        <RecipeTile
          key={recipe.id}
          recipe={recipe}
          onOpen={onOpen}
          width={cardWidth}
          height={Math.round(cardWidth * (columns === 2 ? 1.3 : 1.12))}
        />
      ))}
    </View>
  );
});
