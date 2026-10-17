import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from 'react-native';
import { ChevronRight, ExternalLink, GitFork, Shuffle } from './icons';
import type { LucideIcon } from './icons';
import { api } from '../lib/api';
import { siteName } from '../lib/social';
import { useApp } from '../lib/store';
import { color, font, radius, s } from '../lib/theme';
import type { Creator, Recipe } from '../lib/types';
import { Button, Dialog } from './ui';
import { RecipeRow } from './RecipeCard';

/**
 * Where a recipe comes from and where it went: the recipe it adapts, the site it was imported
 * from, and the cooks' own versions of it. Recipes open in place through `onOpen`; without it the
 * web loads the recipe's address and the apps open its cook's kitchen, which lists it.
 */
export function Lineage({
  recipe,
  onOpen,
  onCreator,
}: {
  recipe: Recipe;
  onOpen?: (recipe: Recipe) => void;
  onCreator: (creator: Creator) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [opening, setOpening] = useState(false);
  const [listing, setListing] = useState(false);
  const [variations, setVariations] = useState<Recipe[] | null>(null);
  const [error, setError] = useState('');
  const origin = recipe.derivedFrom;
  const site = siteName(recipe.sourceUrl);
  const count = recipe.variationCount ?? 0;
  if (!origin && !site && count <= 0) return null;
  const elsewhere = (id: string, author: Creator) => {
    if (Platform.OS === 'web') window.location.assign(`/?recipe=${encodeURIComponent(id)}`);
    else onCreator(author);
  };
  const openOrigin = async () => {
    if (!origin || opening) return;
    const author = { ...origin.author, bio: '', avatar: '' };
    if (!onOpen) return elsewhere(origin.id, author);
    setOpening(true);
    await app.act(async () =>
      onOpen(await api<Recipe>(`/recipes/${encodeURIComponent(origin.id)}`)),
    );
    setOpening(false);
  };
  // The list stays open while the browser loads another page: closing it would step back through
  // its history entry and cancel the load.
  const openVariation = (r: Recipe) => {
    if (!onOpen) return elsewhere(r.id, r.author);
    setListing(false);
    onOpen(r);
  };
  const list = () => {
    setListing(true);
    setError('');
    api<Recipe[]>(`/recipes/${encodeURIComponent(recipe.id)}/variations`)
      .then((found) => setVariations(Array.isArray(found) ? found : []))
      .catch((e: Error) => setError(e.message));
  };
  // The site a recipe was imported from opens outside the app: a new tab on the web (a real link,
  // which can't reach back into this page), the browser on phones.
  const source = recipe.sourceUrl || '';
  const external =
    Platform.OS === 'web'
      ? ({ href: source, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } as object)
      : { onPress: () => void Linking.openURL(source).catch(() => {}) };
  return (
    <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
      {origin && (
        <Line
          icon={GitFork}
          role="link"
          busy={opening}
          text={tr('Adapted from {{title}} by {{name}}', {
            title: origin.title,
            name: origin.author.name,
          })}
          onPress={() => void openOrigin()}
        />
      )}
      {!!site && (
        <Line
          icon={ExternalLink}
          role="link"
          text={tr('From {{site}}', { site })}
          props={external}
        />
      )}
      {count > 0 && (
        <Line
          icon={Shuffle}
          role="button"
          text={tr('Variations ({{v0}})', { v0: count })}
          label={tr('Show the variations of this recipe')}
          onPress={list}
        />
      )}
      <Dialog visible={listing} onClose={() => setListing(false)} title={tr('Variations')}>
        <Text style={s.muted}>{tr('Cooks’ own versions of this recipe.')}</Text>
        {!variations && !error && <ActivityIndicator color={color.ink} />}
        {!!error && (
          <View style={{ gap: 8, alignItems: 'flex-start' }}>
            <Text accessibilityRole="alert" style={{ color: color.error }}>
              {tr(error)}
            </Text>
            <Button title={tr('Try again')} variant="secondary" small onPress={list} />
          </View>
        )}
        {variations?.length === 0 && (
          <Text style={s.body}>{tr('No variations to show right now.')}</Text>
        )}
        <View style={{ gap: 10 }}>
          {variations?.map((r) => (
            <RecipeRow key={r.id} recipe={r} onOpen={openVariation} />
          ))}
        </View>
      </Dialog>
    </View>
  );
}
function Line({
  icon: Icon,
  text,
  label,
  role,
  busy,
  onPress,
  props,
}: {
  icon: LucideIcon;
  text: string;
  label?: string;
  role: 'link' | 'button';
  busy?: boolean;
  onPress?: () => void;
  props?: object;
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label ?? text}
      accessibilityState={{ busy: !!busy }}
      onPress={onPress}
      {...props}
      style={({ pressed }) => [
        s.row,
        {
          gap: 8,
          minHeight: 44,
          maxWidth: '100%',
          paddingHorizontal: 14,
          borderRadius: radius.pill,
          backgroundColor: color.white,
          borderWidth: 1,
          borderColor: color.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color.ink} />
      ) : (
        <Icon size={15} color={color.ink} strokeWidth={2} />
      )}
      <Text
        numberOfLines={2}
        style={{ flexShrink: 1, fontFamily: font.semibold, fontSize: 13, color: color.ink }}
      >
        {text}
      </Text>
      {role === 'button' && <ChevronRight size={15} color={color.ink} strokeWidth={2} />}
    </Pressable>
  );
}
