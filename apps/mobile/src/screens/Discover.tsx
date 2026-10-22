import { useI18n } from '../lib/i18n';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ArrowRight,
  ArrowUp,
  BadgeCheck,
  Bell,
  CalendarDays,
  Carrot,
  ChevronRight,
  Clock3,
  Leaf,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Soup,
  Sparkles,
  Users,
  Zap,
} from '../components/icons';
import { useApp } from '../lib/store';
import { foodConflicts, useFood } from '../lib/food';
import { AvoidPill } from '../components/FoodWarning';
import { Creator, Recipe, Screen } from '../lib/types';
import { color, font, maxFontScale, radius, s } from '../lib/theme';
import { haptic } from '../lib/haptics';
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  Empty,
  FadeIn,
  FoodImage,
  IconButton,
  PageHeading,
  Pill,
  Press,
  Rail,
  SearchBar,
  SectionTitle,
  Segmented,
  animate,
  motionReduced,
  usePress,
  useChrome,
} from '../components/ui';
import { RecipeGrid, RecipeRow, RecipeTile, Save } from '../components/RecipeCard';
import { FollowPill } from '../components/FollowPill';
import { useRecipeSearch } from '../lib/useRecipeSearch';
import { useCookSearch } from '../lib/useCookSearch';
import { foodIcon } from '../lib/icons';
import { allCuisines } from '../lib/cuisines';
import { homeShelves } from '../lib/feed';
import { linkTo, pressedInApp, recipePath } from '../lib/routes';
import { track } from '../lib/telemetry';
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
// One-tap starting points for the sous-chef: each sends its prompt as the conversation opens.
const ideas = [
  {
    title: 'Dinner in 20 minutes',
    prompt: 'A satisfying dinner I can make in 20 minutes.',
    icon: Zap,
  },
  { title: 'Something cozy', prompt: 'Something cozy and comforting for tonight.', icon: Soup },
  {
    title: 'Use up my vegetables',
    prompt: 'A recipe that uses up the vegetables I have.',
    icon: Carrot,
  },
];
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
const heroHeight = (compact: boolean, width: number) =>
  compact ? Math.min(460, Math.round(width * 1.15)) : 420;
export function Discover({
  explore,
  query,
  onQuery,
  onOpen,
  navigate,
  onCreator,
  onAsk,
  onActivity,
  onAccount,
  onHeader,
}: {
  explore?: boolean;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (r: Recipe) => void;
  navigate: (s: Screen) => void;
  onCreator: (c: Creator) => void;
  /**
   * Opens the sous-chef's conversation, sending `message` when there is one; `recipe` when it asks
   * for a new recipe.
   */
  onAsk: (message?: string, start?: { recipe?: boolean }) => void;
  onActivity: () => void;
  onAccount: () => void;
  /** Height of the phone's black header, so the shell can turn the status bar light past it. */
  onHeader?: (height: number) => void;
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
  // Hiding what the member avoids needs something to avoid.
  const avoids =
    !!user?.avoid && Object.keys({ ...user.avoid.groups, ...user.avoid.terms }).length > 0;
  const [fitsChoice, setFits] = useState(false);
  const fits = avoids && fitsChoice;
  // Only recipes enough cooks really made in Savorly (docs/COOK-TESTED.md).
  const [tested, setTested] = useState(false);
  const listing = !!query || !!explore;
  // Filtering belongs to Explore. Home only searches, so returning to it never leaves the feed
  // stuck as a filtered list, while Explore keeps its filters for the next visit.
  const search = useRecipeSearch(
    explore
      ? { query, category, cuisine, quick, sort, fits, tested }
      : { query, category: 'All recipes', cuisine: allCuisines, quick: false, sort: 'For you' },
    listing,
  );
  const filtered = search.recipes;
  // A name typed into the search finds its cook too, above the recipes.
  const cookSearch = useCookSearch(query, { size: 6, enabled: query.trim().length >= 2 });
  const refined =
    !!explore && (cuisine !== allCuisines || quick || sort !== 'For you' || fits || tested);
  // What people search for, and what finds nothing: each search once, when the typing has paused
  // and its first results have arrived (Show more isn't another search).
  const searched = query.trim();
  const counted = useRef('');
  useEffect(() => {
    if (!searched || search.loading || search.error || counted.current === searched) return;
    const results = filtered.length;
    const timer = setTimeout(() => {
      counted.current = searched;
      track('search', { query: searched.slice(0, 100), results });
    }, 1500);
    return () => clearTimeout(timer);
  }, [searched, search.loading, search.error, filtered.length]);
  // The shelves, from GET /feed (or worked out here without it), each recipe on screen once. Rails
  // on phones hold six; desktop rows show what fits.
  const shelfSize = compact ? 6 : width > 1430 ? 4 : 3;
  const { feed, library } = app;
  const {
    cookAlong,
    hero,
    trending,
    quick: weeknight,
    following,
  } = useMemo(
    () =>
      homeShelves(feed, recipes, user ? library.followingIds : [], {
        trending: shelfSize,
        quick: 4,
        following: user ? shelfSize : 0,
      }),
    [feed, recipes, user, library.followingIds, shelfSize],
  );
  // Everyone who finished the cook-along started it too, unless they started late last Sunday.
  const cooking = cookAlong ? Math.max(cookAlong.started, cookAlong.cooks) : 0;
  const hello = `${tr(greeting())}${user ? `, ${user.name.split(' ')[0]}` : ''}`;
  const reset = () => {
    setCategory('All recipes');
    setCuisine(allCuisines);
    setSort('For you');
    setQuick(false);
    setFits(false);
    setTested(false);
  };
  const tileWidth = Math.min(250, Math.round(width * 0.6));
  // On phones the feed is a light sheet that rises over the black header on rounded top corners.
  const sheet = compact && !explore;
  // On phones the filters live inside the search bar, so Explore opens with one control, not two.
  const filter = compact ? (
    <IconButton
      icon={SlidersHorizontal}
      label={tr('Filter recipes')}
      selected={refined}
      plain={!refined}
      size={40}
      onPress={() => setFilters(true)}
    />
  ) : (
    <Button
      title={tr('Filters')}
      label={tr('Filter recipes')}
      icon={SlidersHorizontal}
      variant={refined ? 'primary' : 'secondary'}
      small
      onPress={() => setFilters(true)}
    />
  );
  return (
    <View style={{ gap: explore ? 24 : 30 }}>
      {sheet ? (
        <View
          onLayout={(e) => onHeader?.(e.nativeEvent.layout.height)}
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
                <Avatar name={user?.name || ''} uri={user?.avatar} size={40} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: color.onInk, fontFamily: font.medium, fontSize: 13 }}>
                  {tr(greeting())}
                </Text>
                <View style={[s.row, { gap: 4 }]}>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: color.white,
                      fontFamily: font.bold,
                      fontSize: 16,
                      flexShrink: 1,
                    }}
                  >
                    {user ? user.name : tr('Sign in to save recipes')}
                  </Text>
                  {!user && <ChevronRight size={16} color={color.onInk} strokeWidth={2.2} />}
                </View>
              </View>
            </Pressable>
            <IconButton icon={Bell} dark label={tr('Kitchen activity')} onPress={onActivity} />
          </View>
          <Text
            role="heading"
            aria-level={1}
            style={[s.display, { color: color.white, fontSize: 31, lineHeight: 37 }]}
          >
            {tr('What would you like to cook today?')}
          </Text>
          <View style={{ flexDirection: 'row' }}>
            <SearchBar bare value={query} onChangeText={onQuery} />
          </View>
        </View>
      ) : (
        <FadeIn offset={10} style={{ gap: compact ? 16 : 18 }}>
          {/* Explore is a tool, not a story: its name, the search, and the ways to narrow it. */}
          <PageHeading
            eyebrow={explore ? undefined : hello}
            title={explore ? tr('Explore') : tr('What would you like to cook today?')}
          >
            {explore && !compact && filter}
          </PageHeading>
          {compact && (
            <View style={{ flexDirection: 'row' }}>
              <SearchBar
                value={query}
                onChangeText={onQuery}
                accessory={explore ? filter : undefined}
              />
            </View>
          )}
          {/* Categories narrow a search, so they sit with it rather than atop the home feed. */}
          {explore && (
            <Rail gap={8}>
              {categories.map(([value, title]) => (
                <Chip
                  key={value}
                  title={tr(title)}
                  icon={foodIcon(value)}
                  active={category === value}
                  onPress={() => {
                    if (category !== value) haptic.select();
                    setCategory(value);
                  }}
                />
              ))}
            </Rail>
          )}
        </FadeIn>
      )}
      <View
        style={[
          { gap: explore ? 24 : 30 },
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
        {explore ? (
          <CuisineBrowser value={cuisine} onChange={setCuisine} />
        ) : (
          // On home a cuisine is a way into Explore, already narrowed to it.
          <CuisineBrowser
            onChange={(next) => {
              reset();
              setCuisine(next);
              navigate('explore');
            }}
            onSeeAll={() => {
              setFilters(true);
              navigate('explore');
            }}
          />
        )}
        {listing && cookSearch.cooks.length > 0 && (
          <FadeIn offset={10}>
            <SectionTitle title={tr('Cooks')} />
            {compact ? (
              <Rail gap={12} pad={14}>
                {cookSearch.cooks.map((c) => (
                  <Cook key={c.id} creator={c} onPress={onCreator} width={156} />
                ))}
              </Rail>
            ) : (
              <View style={[s.row, { gap: 16, alignItems: 'stretch' }]}>
                {cookSearch.cooks.map((c) => (
                  <Cook key={c.id} creator={c} onPress={onCreator} />
                ))}
              </View>
            )}
          </FadeIn>
        )}
        {listing ? (
          <FadeIn key={category} offset={10}>
            {explore ? (
              // The search, chips and tiles above already say what is shown; this only counts it.
              <View style={[s.between, { marginBottom: 14, minHeight: 26 }]}>
                <Text
                  accessibilityLiveRegion="polite"
                  style={[s.muted, { fontFamily: font.semibold }]}
                >
                  {search.loading && !filtered.length
                    ? tr('Searching…')
                    : tr('recipeCount', {
                        count: filtered.length,
                        more: search.hasMore ? '+' : '',
                      })}
                </Text>
                {refined && (
                  <Press
                    accessibilityRole="button"
                    accessibilityLabel={tr('Clear filters')}
                    onPress={reset}
                    hitSlop={10}
                  >
                    <Text style={{ fontFamily: font.bold, fontSize: 14, color: color.ink }}>
                      {tr('Clear filters')}
                    </Text>
                  </Press>
                )}
              </View>
            ) : (
              // Home lists recipes only for a search (filters belong to Explore), so it's titled by it.
              <SectionTitle
                title={tr('Results for “{{v0}}”', { v0: query })}
                subtitle={
                  search.loading && !filtered.length
                    ? tr('Searching…')
                    : tr('recipeCount', { count: filtered.length, more: search.hasMore ? '+' : '' })
                }
                action={refined ? reset : undefined}
                actionTitle={tr('Clear filters')}
              />
            )}
            {!!search.error && (
              <Text style={[s.muted, { color: color.error }]}>{tr(search.error)}</Text>
            )}
            {/* A search that found only its cook found what it was for: no "nothing matches". */}
            {search.loading && !filtered.length ? (
              <TileBones />
            ) : filtered.length ? (
              <RecipeGrid recipes={filtered} onOpen={onOpen} />
            ) : cookSearch.cooks.length ? null : (
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
                    // In the cook's language: it's their own message, and the model's cue.
                    onPress={() =>
                      onAsk(tr('Create a recipe for {{v0}}.', { v0: query }), { recipe: true })
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
                <Hero recipe={hero} onOpen={onOpen} />
              </FadeIn>
            )}
            {cookAlong && (
              <FadeIn delay={45}>
                <SectionTitle
                  title={tr('This week’s cook-along')}
                  subtitle={
                    cooking > 0
                      ? tr('cookingAlong', { count: cooking })
                      : tr('Be the first to cook it this week.')
                  }
                />
                <View style={desktop && { maxWidth: 620 }}>
                  <RecipeRow recipe={cookAlong.recipe} onOpen={onOpen} />
                </View>
              </FadeIn>
            )}
            <FadeIn delay={90}>
              <SectionTitle title={tr('Trending now')} action={() => navigate('explore')} />
              {compact ? (
                <Rail gap={12} snap={tileWidth + 12}>
                  {trending.map((r) => (
                    <RecipeTile
                      key={r.id}
                      recipe={r}
                      onOpen={onOpen}
                      width={tileWidth}
                      height={Math.round(tileWidth * 1.28)}
                    />
                  ))}
                </Rail>
              ) : (
                <RecipeGrid recipes={trending} onOpen={onOpen} />
              )}
            </FadeIn>
            <FadeIn
              delay={180}
              style={[
                {
                  backgroundColor: color.ink,
                  borderRadius: radius.xl,
                  padding: compact ? 22 : 40,
                  gap: compact ? 18 : 48,
                  overflow: 'hidden',
                },
                desktop && { flexDirection: 'row', alignItems: 'center' },
              ]}
            >
              <LinearGradient
                colors={['rgba(255,255,255,0.11)', 'rgba(255,255,255,0)']}
                start={{ x: 1, y: 0 }}
                end={{ x: 0.3, y: 0.8 }}
                style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
              />
              <View style={[{ gap: 14 }, desktop && { flex: 1 }]}>
                <View style={[s.row, { gap: 10 }]}>
                  <View style={styles.spark}>
                    <Sparkles size={16} color={color.ink} strokeWidth={2.2} />
                  </View>
                  <Text style={[s.label, { color: color.onInk }]}>{tr('Sous-chef')}</Text>
                </View>
                <Text
                  role="heading"
                  aria-level={2}
                  style={[
                    s.h1,
                    { color: color.white },
                    compact && { fontSize: 25, lineHeight: 31 },
                  ]}
                >
                  {tr('Not sure what to make?')}
                </Text>
                <Text style={[s.muted, { color: color.onInk, maxWidth: 520 }]}>
                  {tr(
                    'Say what’s in your fridge or what you’re craving. You get a full recipe you can tweak and save.',
                  )}
                </Text>
              </View>
              <View style={[{ gap: 14 }, desktop && { flex: 1.1 }]}>
                <Press
                  accessibilityRole="button"
                  accessibilityLabel={tr('Ask the sous-chef for a recipe')}
                  onPress={() => onAsk()}
                  scale={0.98}
                  style={[
                    s.row,
                    {
                      minHeight: 56,
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
                    maxFontSizeMultiplier={maxFontScale}
                    style={{ flex: 1, color: color.onInk, fontFamily: font.medium, fontSize: 15 }}
                  >
                    {tr('Eggs, spinach, feta…')}
                  </Text>
                  <View style={styles.send}>
                    <ArrowUp size={20} color={color.ink} strokeWidth={2.4} />
                  </View>
                </Press>
                <View style={[s.wrap, { gap: 8, maxWidth: 620 }]}>
                  {ideas.map(({ title, prompt, icon: Icon }) => (
                    <Press
                      key={title}
                      accessibilityRole="button"
                      accessibilityLabel={tr('Ask the sous-chef: {{v0}}', { v0: tr(title) })}
                      onPress={() => onAsk(tr(prompt))}
                      scale={0.95}
                      style={styles.idea}
                    >
                      <Icon size={14} color={color.white} strokeWidth={2} />
                      <Text
                        maxFontSizeMultiplier={maxFontScale}
                        style={{ color: color.white, fontFamily: font.semibold, fontSize: 13 }}
                      >
                        {tr(title)}
                      </Text>
                    </Press>
                  ))}
                </View>
              </View>
            </FadeIn>
            {compact && (
              <FadeIn delay={240} style={[s.row, { gap: 10, alignItems: 'stretch' }]}>
                {[
                  {
                    key: 'planner',
                    title: tr('Planner'),
                    text: tr('Your week'),
                    icon: CalendarDays,
                  },
                  { key: 'pantry', title: tr('Pantry'), text: tr('What you have'), icon: Leaf },
                  { key: 'community', title: tr('Cooks'), text: tr('Find people'), icon: Users },
                ].map(({ key, title, text, icon: Icon }) => (
                  <Press
                    key={key}
                    accessibilityRole="button"
                    accessibilityLabel={tr('Open {{v0}}', { v0: title })}
                    onPress={() => navigate(key as Screen)}
                    style={[s.card, { flex: 1, padding: 14, gap: 12 }]}
                  >
                    <View style={styles.shortcut}>
                      <Icon size={18} color={color.white} strokeWidth={2} />
                    </View>
                    <View style={{ gap: 1 }}>
                      <Text numberOfLines={1} style={[s.h3, { fontSize: 14, lineHeight: 19 }]}>
                        {title}
                      </Text>
                      <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
                        {text}
                      </Text>
                    </View>
                  </Press>
                ))}
              </FadeIn>
            )}
            {following.length > 0 && (
              <FadeIn delay={270}>
                <SectionTitle title={tr('From kitchens you follow')} />
                {compact ? (
                  <Rail gap={12} snap={tileWidth + 12}>
                    {following.map((r) => (
                      <RecipeTile
                        key={r.id}
                        recipe={r}
                        onOpen={onOpen}
                        width={tileWidth}
                        height={Math.round(tileWidth * 1.28)}
                      />
                    ))}
                  </Rail>
                ) : (
                  <RecipeGrid recipes={following} onOpen={onOpen} />
                )}
              </FadeIn>
            )}
            {weeknight.length > 0 && (
              <FadeIn delay={300}>
                <SectionTitle
                  title={tr('Weeknight winners')}
                  subtitle={tr('Fast, forgiving and full of flavor.')}
                  action={() => {
                    reset();
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
                {compact ? (
                  <Rail gap={12} pad={14}>
                    {creators.slice(0, 8).map((c) => (
                      <Cook key={c.id} creator={c} onPress={onCreator} width={156} />
                    ))}
                  </Rail>
                ) : (
                  <View style={[s.row, { gap: 16, alignItems: 'stretch' }]}>
                    {creators.slice(0, 6).map((c) => (
                      <Cook key={c.id} creator={c} onPress={onCreator} />
                    ))}
                  </View>
                )}
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
          <Text style={s.label}>{tr('Tested by cooks')}</Text>
          <View style={[s.wrap, { gap: 8 }]}>
            <Chip title={tr('Any recipe')} active={!tested} onPress={() => setTested(false)} />
            <Chip
              title={tr('Cook-tested only')}
              icon={BadgeCheck}
              active={tested}
              onPress={() => setTested(true)}
            />
          </View>
        </View>
        {avoids && (
          <View style={{ gap: 12 }}>
            <Text style={s.label}>{tr('Diets and allergies')}</Text>
            <View style={[s.wrap, { gap: 8 }]}>
              <Chip title={tr('Show everything')} active={!fits} onPress={() => setFits(false)} />
              <Chip
                title={tr('Hide what I avoid')}
                icon={ShieldCheck}
                active={fits}
                onPress={() => setFits(true)}
              />
            </View>
          </View>
        )}
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
                : tr('showRecipes', {
                    count: filtered.length,
                    more: search.hasMore ? '+' : '',
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
// The daily dish: an editorial cover with the cook's byline, saving without opening it.
function Hero({ recipe, onOpen }: { recipe: Recipe; onOpen: (r: Recipe) => void }) {
  const { t: tr } = useI18n();
  const { compact, width } = useChrome();
  const { avoid, household } = useFood();
  const conflicts = useMemo(
    () => foodConflicts(recipe, avoid, household),
    [recipe, avoid, household],
  );
  const press = usePress(0.985);
  const hover = useState(() => new Animated.Value(0))[0];
  return (
    <Animated.View
      style={[
        {
          height: heroHeight(compact, width),
          borderRadius: radius.xl,
          overflow: 'hidden',
          backgroundColor: color.ink,
        },
        press.style,
      ]}
    >
      {/* A link on the web: crawlable, and a new tab on a middle or modified click. */}
      <Pressable
        {...linkTo(recipePath(recipe.id))}
        accessibilityRole={Platform.OS === 'web' ? 'link' : 'button'}
        accessibilityLabel={tr('Let’s get cooking: {{v0}}', { v0: recipe.title })}
        onPress={(e) => pressedInApp(e) && onOpen(recipe)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        onHoverIn={() => animate(hover, 1, 900).start()}
        onHoverOut={() => animate(hover, 0, 600).start()}
        style={StyleSheet.absoluteFill}
      >
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            right: 0,
            width: compact ? '100%' : '66%',
            transform: [
              { scale: hover.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) },
            ],
          }}
        >
          {/* The page's largest image: fetched first, at about the size it's shown. */}
          <FoodImage
            uri={recipe.image}
            style={StyleSheet.absoluteFill}
            width={compact ? width : Math.round((Math.min(width, 1848) - 328) * 0.66)}
            priority="high"
          />
        </Animated.View>
        {/* Many short stops ease the photo into the ink without a visible band. */}
        <LinearGradient
          colors={
            compact
              ? [
                  'rgba(0,0,0,0.3)',
                  'rgba(0,0,0,0)',
                  'rgba(0,0,0,0.04)',
                  'rgba(0,0,0,0.38)',
                  'rgba(0,0,0,0.72)',
                  'rgba(0,0,0,0.9)',
                ]
              : [
                  color.ink,
                  color.ink,
                  'rgba(13,13,13,0.94)',
                  'rgba(13,13,13,0.74)',
                  'rgba(13,13,13,0.42)',
                  'rgba(13,13,13,0.14)',
                  'rgba(13,13,13,0)',
                ]
          }
          locations={
            compact ? [0, 0.22, 0.38, 0.6, 0.8, 1] : [0, 0.33, 0.41, 0.5, 0.59, 0.67, 0.76]
          }
          start={{ x: 0, y: compact ? 0 : 0.5 }}
          end={{ x: compact ? 0 : 1, y: compact ? 1 : 0.5 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            s.row,
            { position: 'absolute', top: 18, left: 18, gap: 8, pointerEvents: 'none' },
          ]}
        >
          <Pill title={tr('The daily dish')} tone="glass" />
          <AvoidPill conflicts={conflicts} />
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
          <View style={[s.row, { gap: 8 }]}>
            <Avatar uri={recipe.author.avatar} name={recipe.author.name} size={24} />
            <Text numberOfLines={1} style={styles.byline}>
              {tr('by {{v0}}', { v0: recipe.author.name })}
            </Text>
          </View>
          <Text
            role="heading"
            aria-level={2}
            style={[
              s.display,
              {
                color: color.white,
                fontSize: compact ? 30 : 42,
                lineHeight: compact ? 35 : 48,
              },
            ]}
          >
            {recipe.title}
          </Text>
          <Text numberOfLines={2} style={styles.blurb}>
            {recipe.description}
          </Text>
          <View style={[s.row, { gap: 14, marginTop: 6 }]}>
            <View style={[s.row, styles.cta]}>
              <Text
                maxFontSizeMultiplier={maxFontScale}
                style={{ fontFamily: font.bold, fontSize: 14, color: color.ink }}
              >
                {tr('Let’s get cooking')}
              </Text>
              <ArrowRight size={16} color={color.ink} strokeWidth={2.2} />
            </View>
            <View style={[s.row, { gap: 6 }]}>
              <Clock3 size={14} color="rgba(255,255,255,0.8)" />
              <Text style={styles.meta}>
                {`${tr('minuteCount', { count: recipe.minutes })} · ${tr(recipe.difficulty)}`}
              </Text>
            </View>
          </View>
        </View>
      </Pressable>
      <View style={{ position: 'absolute', top: 14, right: 14 }}>
        <Save recipe={recipe} size={40} glass />
      </View>
    </Animated.View>
  );
}
function Cook({
  creator,
  onPress,
  width,
}: {
  creator: Creator;
  onPress: (c: Creator) => void;
  width?: number;
}) {
  const { t: tr } = useI18n();
  const press = usePress(0.97);
  // The card and its follow button are siblings: browsers don't allow a button inside a button.
  return (
    <Animated.View
      style={[
        s.card,
        { alignItems: 'center', gap: 12, padding: 16, paddingTop: 20 },
        width ? { width } : { flex: 1, maxWidth: 300 },
        press.style,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('Meet {{v0}}', { v0: creator.name })}
        onPress={() => onPress(creator)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[StyleSheet.absoluteFill, { borderRadius: radius.lg }]}
      />
      <View style={{ alignItems: 'center', gap: 12, alignSelf: 'stretch', pointerEvents: 'none' }}>
        <Avatar uri={creator.avatar} name={creator.name} size={64} />
        <View style={{ alignItems: 'center', gap: 2, alignSelf: 'stretch' }}>
          <Text numberOfLines={1} style={[s.h3, { fontSize: 15 }]}>
            {creator.name}
          </Text>
          <Text numberOfLines={1} style={s.small}>
            {creator.recipeCount
              ? tr('recipeCount', { count: creator.recipeCount, more: '' })
              : tr('New to Savorly')}
          </Text>
        </View>
      </View>
      <FollowPill creator={creator} stretch />
    </Animated.View>
  );
}
// Placeholder tiles while a search runs.
function usePulse() {
  const a = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (motionReduced()) return;
    const loop = Animated.loop(Animated.sequence([animate(a, 1, 800), animate(a, 0, 800)]));
    loop.start();
    return () => loop.stop();
  }, [a]);
  return a.interpolate({ inputRange: [0, 1], outputRange: [1, 0.5] });
}
function Bone({
  style,
  dark,
  pulse,
}: {
  style: ViewStyle;
  dark?: boolean;
  pulse: Animated.AnimatedInterpolation<number>;
}) {
  return (
    <Animated.View
      style={[
        {
          backgroundColor: dark ? 'rgba(255,255,255,0.1)' : '#E7E7E7',
          borderRadius: radius.pill,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}
function TileBones({ count }: { count?: number }) {
  const { compact } = useChrome();
  const pulse = usePulse();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: compact ? 12 : 20 }}>
      {Array.from({ length: count ?? (compact ? 4 : 8) }, (_, i) => (
        <Bone
          key={i}
          pulse={pulse}
          style={{
            flexGrow: 1,
            flexBasis: compact ? '40%' : '20%',
            aspectRatio: compact ? 1 / 1.3 : 1 / 1.12,
            borderRadius: radius.lg,
          }}
        />
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  spark: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  idea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  shortcut: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  byline: {
    color: 'rgba(255,255,255,0.88)',
    fontFamily: font.semibold,
    fontSize: 13,
    flexShrink: 1,
  },
  blurb: {
    color: 'rgba(255,255,255,0.78)',
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 21,
  },
  cta: {
    gap: 8,
    backgroundColor: color.white,
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
  },
  meta: {
    color: 'rgba(255,255,255,0.8)',
    fontFamily: font.semibold,
    fontSize: 13,
  },
});
