import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ArrowRight,
  ArrowUp,
  Bell,
  CalendarDays,
  Clock3,
  Leaf,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react-native';
import { useApp } from '../lib/store';
import { AIRequest, Creator, Recipe, Screen } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  Empty,
  FadeIn,
  FlatGlass,
  FoodImage,
  IconButton,
  PageHeading,
  Pill,
  Press,
  SearchBar,
  SectionTitle,
  Segmented,
  useChrome,
} from '../components/ui';
import { RecipeGrid, RecipeRow, RecipeTile } from '../components/RecipeCard';
import { useRecipeSearch } from '../lib/useRecipeSearch';
import { foodIcon } from '../lib/icons';
import { allCuisines } from '../lib/cuisines';
import { CuisineBrowser } from '../components/CuisineBrowser';
import { CuisinePicker } from '../components/CuisinePicker';
const categories = [
  ['All recipes', 'All'],
  ['Quick & easy', 'Quick & easy'],
  ['Vegetarian', 'Vegetarian'],
  ['Breakfast', 'Breakfast'],
  ['High protein', 'High protein'],
  ['Comfort food', 'Comfort food'],
];
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
export function Discover({
  explore,
  query,
  onQuery,
  onOpen,
  navigate,
  onCreator,
  onAI,
  onActivity,
  onAccount,
}: {
  explore?: boolean;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (r: Recipe) => void;
  navigate: (s: Screen) => void;
  onCreator: (c: Creator) => void;
  onAI: (r: AIRequest) => void;
  onActivity: () => void;
  onAccount: () => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const { recipes, creators, user } = app;
  const { compact, desktop, gutter, top, width } = useChrome();
  const [category, setCategory] = useState('All recipes');
  const [cuisine, setCuisine] = useState<string>(allCuisines);
  const [filters, setFilters] = useState(false);
  const [sort, setSort] = useState('For you');
  const [quick, setQuick] = useState(false);
  const search = useRecipeSearch({ query, category, cuisine, quick, sort });
  const filtered = search.recipes;
  const refined = cuisine !== allCuisines || quick || sort !== 'For you';
  const listing = !!query || !!explore || category !== 'All recipes' || refined;
  const hero = recipes.find((r) => r.id === 'lemon-ricotta-pasta') || recipes[0];
  const trending = recipes
    .filter((r) => r.id !== hero?.id)
    .sort((a, b) => b.saveCount - a.saveCount || b.rating - a.rating)
    .slice(0, 6);
  const weeknight = recipes
    .filter((r) => r.id !== hero?.id && !trending.includes(r))
    .sort((a, b) => a.minutes - b.minutes)
    .slice(0, 4);
  const hello = `${tr(greeting())}${user ? `, ${user.name.split(' ')[0]}` : ''}`;
  const reset = () => {
    setCategory('All recipes');
    setCuisine(allCuisines);
    setSort('For you');
    setQuick(false);
  };
  const fridge: AIRequest = {
    kind: 'recipe',
    title: tr('What are you in the mood for?'),
    placeholder: tr('Eggs, spinach and feta — something quick…'),
    context: app.kitchen.pantry.length
      ? `In my pantry: ${app.kitchen.pantry.map((p) => p.name).join(', ')}`
      : undefined,
  };
  const bleed = compact ? { marginHorizontal: -gutter } : undefined;
  const pad = compact ? { paddingHorizontal: gutter } : undefined;
  const tileWidth = Math.min(250, Math.round(width * 0.6));
  // On phones the feed is a light sheet that rises over the black header on rounded top corners.
  const sheet = compact && !explore;
  return (
    <View style={{ gap: 30 }}>
      {sheet ? (
        <View
          style={{
            marginHorizontal: -gutter,
            marginTop: -top,
            paddingTop: top + 8,
            paddingHorizontal: gutter,
            paddingBottom: 26 + radius.xl,
            backgroundColor: color.ink,
            gap: 20,
          }}
        >
          <View style={[s.between, { gap: 12 }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={user ? tr('My profile') : tr('Sign in')}
              onPress={onAccount}
              style={[s.row, { gap: 12, flex: 1 }]}
            >
              <View
                style={{
                  borderRadius: 24,
                  borderWidth: 1.5,
                  borderColor: color.glassBorder,
                  padding: 2,
                }}
              >
                <Avatar name={user?.name || 'S'} uri={user?.avatar} size={40} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: color.onInk, fontFamily: font.medium, fontSize: 13 }}>
                  {tr(greeting())}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ color: color.white, fontFamily: font.bold, fontSize: 16 }}
                >
                  {user ? user.name : tr('Sign in to save recipes')}
                </Text>
              </View>
            </Pressable>
            <IconButton icon={Bell} dark label={tr('Kitchen activity')} onPress={onActivity} />
          </View>
          <Text style={[s.display, { color: color.white, fontSize: 31, lineHeight: 37 }]}>
            {tr('What would you like to cook today?')}
          </Text>
          <View style={{ flexDirection: 'row' }}>
            <SearchBar bare value={query} onChangeText={onQuery} />
          </View>
        </View>
      ) : (
        <FadeIn offset={10} style={{ gap: 18 }}>
          <PageHeading
            eyebrow={explore ? tr('Every craving, every occasion') : hello}
            title={explore ? tr('Explore') : tr('What would you like to cook today?')}
            subtitle={
              explore
                ? tr('Search by dish, ingredient or cuisine, then narrow it down.')
                : undefined
            }
          />
          {compact && (
            <View style={{ flexDirection: 'row' }}>
              <SearchBar value={query} onChangeText={onQuery} />
            </View>
          )}
        </FadeIn>
      )}
      <View
        style={[
          { gap: 30 },
          sheet && {
            marginHorizontal: -gutter,
            marginTop: -30 - radius.xl,
            paddingHorizontal: gutter,
            paddingTop: 24,
            backgroundColor: color.bg,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
          },
        ]}
      >
        <View style={[s.row, { gap: 10 }]}>
          <IconButton
            icon={SlidersHorizontal}
            label={tr('Filter recipes')}
            selected={refined}
            size={42}
            onPress={() => setFilters(true)}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[{ flex: 1 }, compact && { marginRight: -gutter }]}
            contentContainerStyle={{ gap: 8, paddingRight: compact ? gutter : 0 }}
          >
            {categories.map(([value, title]) => (
              <Chip
                key={value}
                title={tr(title)}
                icon={foodIcon(value)}
                active={category === value}
                onPress={() => setCategory(value)}
              />
            ))}
          </ScrollView>
        </View>
        <CuisineBrowser value={cuisine} onChange={setCuisine} onSeeAll={() => setFilters(true)} />
        {listing ? (
          <FadeIn key={category} offset={10}>
            <SectionTitle
              title={
                query
                  ? tr('Results for “{{v0}}”', { v0: query })
                  : category !== 'All recipes'
                    ? tr(category)
                    : cuisine !== allCuisines
                      ? tr('{{v0}} recipes', { v0: tr(cuisine) })
                      : explore
                        ? tr('All recipes')
                        : tr('Recipes')
              }
              subtitle={
                search.loading && !filtered.length
                  ? tr('Searching…')
                  : tr('recipeCount', { count: filtered.length, more: search.hasMore ? '+' : '' })
              }
              action={refined ? reset : undefined}
              actionTitle={tr('Clear filters')}
            />
            {!!search.error && (
              <Text style={[s.muted, { color: color.error }]}>{tr(search.error)}</Text>
            )}
            {search.loading && !filtered.length ? (
              <ActivityIndicator color={color.ink} style={{ paddingVertical: 60 }} />
            ) : filtered.length ? (
              <RecipeGrid recipes={filtered} onOpen={onOpen} />
            ) : (
              <View style={{ alignItems: 'center' }}>
                <Empty
                  title={tr('Nothing matches yet')}
                  text={tr('Try another ingredient, or clear your filters.')}
                  icon={Search}
                  action={() => {
                    reset();
                    onQuery('');
                  }}
                  actionTitle={tr('Clear search')}
                />
                {!!query && (
                  <Button
                    title={tr('Create “{{v0}}” with the sous-chef', { v0: query })}
                    icon={Sparkles}
                    variant="secondary"
                    small
                    onPress={() =>
                      onAI({
                        ...fridge,
                        title: tr('A recipe for {{v0}}', { v0: query }),
                        prompt: `Create a recipe for ${query}.`,
                      })
                    }
                  />
                )}
              </View>
            )}
            {search.hasMore && (
              <Button
                title={tr('Show more')}
                variant="secondary"
                busy={search.loading}
                onPress={() => void search.loadMore()}
                style={{ marginTop: 22, alignSelf: 'center' }}
              />
            )}
          </FadeIn>
        ) : (
          <>
            {hero && (
              <FadeIn>
                <Press
                  accessibilityRole="button"
                  accessibilityLabel={tr('Let’s get cooking')}
                  onPress={() => onOpen(hero)}
                  scale={0.985}
                  style={{
                    height: compact ? Math.min(460, Math.round(width * 1.15)) : 420,
                    borderRadius: radius.xl,
                    overflow: 'hidden',
                    backgroundColor: color.ink,
                  }}
                >
                  <View
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      right: 0,
                      width: compact ? '100%' : '66%',
                    }}
                  >
                    <FoodImage uri={hero.image} style={StyleSheet.absoluteFill} />
                  </View>
                  <LinearGradient
                    colors={
                      compact
                        ? ['rgba(0,0,0,0.1)', 'rgba(0,0,0,0.1)', 'rgba(0,0,0,0.86)']
                        : [color.ink, color.ink, 'rgba(13,13,13,0)']
                    }
                    locations={compact ? [0, 0.35, 1] : [0, 0.36, 0.7]}
                    start={{ x: 0, y: compact ? 0 : 0.5 }}
                    end={{ x: compact ? 0 : 1, y: compact ? 1 : 0.5 }}
                    style={StyleSheet.absoluteFill}
                  />
                  <View style={{ position: 'absolute', top: 18, left: 18 }}>
                    <Pill title={tr('The daily dish')} tone="glass" />
                  </View>
                  <View
                    style={{
                      position: 'absolute',
                      left: compact ? 22 : 40,
                      right: compact ? 22 : '45%',
                      bottom: compact ? 22 : 40,
                      gap: 12,
                    }}
                  >
                    <Text
                      style={[
                        s.display,
                        {
                          color: color.white,
                          fontSize: compact ? 30 : 40,
                          lineHeight: compact ? 35 : 46,
                        },
                      ]}
                    >
                      {hero.title}
                    </Text>
                    <Text
                      numberOfLines={2}
                      style={{
                        color: 'rgba(255,255,255,0.78)',
                        fontFamily: font.medium,
                        fontSize: 14,
                        lineHeight: 21,
                      }}
                    >
                      {hero.description}
                    </Text>
                    <View style={[s.row, { gap: 12, marginTop: 6 }]}>
                      <View
                        style={[
                          s.row,
                          {
                            gap: 8,
                            backgroundColor: color.white,
                            height: 48,
                            paddingHorizontal: 20,
                            borderRadius: radius.pill,
                          },
                        ]}
                      >
                        <Text style={{ fontFamily: font.bold, fontSize: 14, color: color.ink }}>
                          {tr('Let’s get cooking')}
                        </Text>
                        <ArrowRight size={16} color={color.ink} strokeWidth={2.2} />
                      </View>
                      <View style={[s.row, { gap: 6 }]}>
                        <Clock3 size={14} color="rgba(255,255,255,0.8)" />
                        <Text
                          style={{
                            color: 'rgba(255,255,255,0.8)',
                            fontFamily: font.semibold,
                            fontSize: 13,
                          }}
                        >
                          {tr('{{v0}} min', { v0: hero.minutes })}
                        </Text>
                      </View>
                    </View>
                  </View>
                </Press>
              </FadeIn>
            )}
            <FadeIn delay={90}>
              <SectionTitle title={tr('Trending now')} action={() => navigate('explore')} />
              {compact ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  snapToInterval={tileWidth + 12}
                  decelerationRate="fast"
                  style={[{ flexGrow: 0 }, bleed]}
                  contentContainerStyle={[pad, { gap: 12, paddingBottom: 8 }]}
                >
                  <FlatGlass>
                    {trending.map((r) => (
                      <RecipeTile
                        key={r.id}
                        recipe={r}
                        onOpen={onOpen}
                        width={tileWidth}
                        height={Math.round(tileWidth * 1.28)}
                      />
                    ))}
                  </FlatGlass>
                </ScrollView>
              ) : (
                <RecipeGrid recipes={trending.slice(0, width > 1430 ? 4 : 3)} onOpen={onOpen} />
              )}
            </FadeIn>
            <FadeIn
              delay={180}
              style={{
                backgroundColor: color.ink,
                borderRadius: radius.xl,
                padding: compact ? 22 : 32,
                gap: 14,
                overflow: 'hidden',
              }}
            >
              <LinearGradient
                colors={['rgba(255,255,255,0.09)', 'rgba(255,255,255,0)']}
                start={{ x: 1, y: 0 }}
                end={{ x: 0.3, y: 0.8 }}
                style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
              />
              <View style={[s.row, { gap: 10 }]}>
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: color.white,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Sparkles size={16} color={color.ink} strokeWidth={2.2} />
                </View>
                <Text style={[s.label, { color: color.onInk }]}>{tr('Sous-chef')}</Text>
              </View>
              <Text style={[s.h1, { color: color.white, fontSize: 25, lineHeight: 31 }]}>
                {tr('Not sure what to make?')}
              </Text>
              <Text style={[s.muted, { color: color.onInk, maxWidth: 520 }]}>
                {tr(
                  'Say what’s in your fridge or what you’re craving. You get a full recipe you can tweak and save.',
                )}
              </Text>
              <Press
                accessibilityRole="button"
                accessibilityLabel={tr('Ask the sous-chef for a recipe')}
                onPress={() => onAI(fridge)}
                scale={0.98}
                style={[
                  s.row,
                  {
                    height: 56,
                    marginTop: 4,
                    borderRadius: radius.pill,
                    backgroundColor: color.glass,
                    borderWidth: 1,
                    borderColor: color.glassBorder,
                    paddingLeft: 20,
                    paddingRight: 6,
                    maxWidth: 560,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, color: color.onInk, fontFamily: font.medium, fontSize: 15 }}
                >
                  {tr('Eggs, spinach, feta…')}
                </Text>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: color.white,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <ArrowUp size={20} color={color.ink} strokeWidth={2.4} />
                </View>
              </Press>
            </FadeIn>
            {compact && (
              <FadeIn delay={240} style={[s.row, { gap: 10, alignItems: 'stretch' }]}>
                {[
                  { key: 'planner', title: tr('Planner'), text: 'Your week', icon: CalendarDays },
                  { key: 'pantry', title: tr('Pantry'), text: 'What you have', icon: Leaf },
                  { key: 'community', title: tr('Cooks'), text: 'Find people', icon: Users },
                ].map(({ key, title, text, icon: Icon }) => (
                  <Press
                    key={key}
                    accessibilityRole="button"
                    accessibilityLabel={tr('Open {{v0}}', { v0: title })}
                    onPress={() => navigate(key as Screen)}
                    style={[s.card, { flex: 1, padding: 14, gap: 10 }]}
                  >
                    <View
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 19,
                        backgroundColor: color.bg,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon size={18} color={color.ink} strokeWidth={1.9} />
                    </View>
                    <View>
                      <Text style={[s.h3, { fontSize: 14 }]}>{title}</Text>
                      <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
                        {text}
                      </Text>
                    </View>
                  </Press>
                ))}
              </FadeIn>
            )}
            {weeknight.length > 0 && (
              <FadeIn delay={300}>
                <SectionTitle
                  title={tr('Weeknight winners')}
                  subtitle={tr('Fast, forgiving and full of flavor.')}
                  action={() => {
                    setSort('Quickest');
                    navigate('explore');
                  }}
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                  {weeknight.map((r) => (
                    <View key={r.id} style={{ flexGrow: 1, flexBasis: desktop ? 380 : '100%' }}>
                      <RecipeRow recipe={r} onOpen={onOpen} />
                    </View>
                  ))}
                </View>
              </FadeIn>
            )}
            {creators.length > 0 && (
              <FadeIn delay={360}>
                <SectionTitle title={tr('Cooks to follow')} action={() => navigate('community')} />
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={[{ flexGrow: 0 }, bleed]}
                  contentContainerStyle={[pad, { gap: 12, paddingBottom: 8 }]}
                >
                  {creators.slice(0, 8).map((c) => (
                    <Press
                      key={c.id}
                      accessibilityRole="button"
                      accessibilityLabel={tr('Meet {{v0}}', { v0: c.name })}
                      onPress={() => onCreator(c)}
                      style={[s.card, { width: 148, alignItems: 'center', gap: 10, padding: 18 }]}
                    >
                      <Avatar uri={c.avatar} name={c.name} size={60} />
                      <View style={{ alignItems: 'center', gap: 2 }}>
                        <Text numberOfLines={1} style={[s.h3, { fontSize: 14 }]}>
                          {c.name}
                        </Text>
                        <Text style={s.small}>
                          {tr('{{v0}} recipes', { v0: c.recipeCount ?? 0 })}
                        </Text>
                      </View>
                    </Press>
                  ))}
                </ScrollView>
              </FadeIn>
            )}
          </>
        )}
      </View>
      <Dialog visible={filters} onClose={() => setFilters(false)} title={tr('Filters')}>
        <View style={{ gap: 12 }}>
          <Text style={s.label}>{tr('Cuisine')}</Text>
          <CuisinePicker value={cuisine} onChange={setCuisine} includeAll />
        </View>
        <View style={{ gap: 12 }}>
          <Text style={s.label}>{tr('Time')}</Text>
          <View style={[s.wrap, { gap: 8 }]}>
            <Chip title={tr('Any time')} active={!quick} onPress={() => setQuick(false)} />
            <Chip
              title={tr('20 minutes or less')}
              icon={Zap}
              active={quick}
              onPress={() => setQuick(true)}
            />
          </View>
        </View>
        <View style={{ gap: 12 }}>
          <Text style={s.label}>{tr('Sort by')}</Text>
          <Segmented
            value={sort}
            onChange={setSort}
            options={['For you', 'Quickest', 'Top rated'].map((v) => ({ value: v, label: tr(v) }))}
          />
        </View>
        <View style={[s.row, { gap: 10, marginTop: 6 }]}>
          <Button title={tr('Reset')} variant="secondary" onPress={reset} />
          <Button
            title={
              search.loading
                ? tr('Searching…')
                : tr('Show {{v0}}{{v1}} recipes', {
                    v0: filtered.length,
                    v1: search.hasMore ? '+' : '',
                  })
            }
            style={{ flex: 1 }}
            onPress={() => setFilters(false)}
          />
        </View>
      </Dialog>
    </View>
  );
}
