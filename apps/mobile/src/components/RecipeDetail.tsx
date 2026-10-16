import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ArrowLeft,
  Bookmark,
  BookmarkPlus,
  CalendarDays,
  ChefHat,
  Check,
  Clock3,
  Flag,
  Flame,
  Gauge,
  Minus,
  Pencil,
  Play,
  Plus,
  Repeat2,
  Share2,
  ShoppingBasket,
  Sparkles,
  Star,
  Timer,
  Users,
} from 'lucide-react-native';
import { AIRequest, CookCommand, Creator, Recipe, Review } from '../lib/types';
import { api, WEB_URL } from '../lib/api';
import { useApp } from '../lib/store';
import { color, font, radius, s } from '../lib/theme';
import {
  Avatar,
  Button,
  CheckRow,
  Chip,
  Dialog,
  FadeIn,
  Field,
  FoodImage,
  GlassSurface,
  IconButton,
  Pill,
  Press,
  Segmented,
  Toast,
  animate,
  motionReduced,
  native,
  useChrome,
  useSlideOver,
} from './ui';
import { CookMode } from './CookMode';
import { VideoPlayer } from './VideoPlayer';
import { localDate } from '../lib/utils';
import { foodIcon } from '../lib/icons';
import { CuisineIcon } from './CuisineIcon';
const twists = [
  ['Vegetarian', 'Make this recipe vegetarian.'],
  ['Dairy-free', 'Make this recipe dairy-free.'],
  ['Gluten-free', 'Make this recipe gluten-free.'],
  ['More protein', 'Adapt this recipe to be higher in protein.'],
  ['Quicker', 'Make a faster weeknight version of this recipe.'],
];
export function RecipeDetail({
  recipe,
  onClose,
  onCreator,
  onEdit,
  onAI,
  onAsk,
  onCooking,
  cookCommand,
}: {
  recipe: Recipe;
  onClose: () => void;
  onCreator: (c: Creator) => void;
  onEdit: (r: Recipe) => void;
  onAI: (request: AIRequest) => void;
  /** Opens the sous-chef, which already knows this recipe is open. */
  onAsk: () => void;
  /** Reports the cooking-mode step (1-based), or null when not cooking. */
  onCooking: (step: number | null) => void;
  cookCommand?: CookCommand | null;
}) {
  const { t: tr, number, locale } = useI18n();
  const app = useApp();
  const page = useSlideOver(onClose);
  const { width, height, insets, gutter } = useChrome();
  const wide = width > 900;
  const [tab, setTab] = useState<'ingredients' | 'method' | 'reviews'>('ingredients');
  const [servings, setServings] = useState(recipe.servings);
  const [checked, setChecked] = useState<string[]>([]);
  const [cook, setCook] = useState(false);
  // A sous-chef command opens cooking mode until the cook closes it.
  const [closedCommand, setClosedCommand] = useState<number>();
  const cooking = cook || (!!cookCommand && cookCommand.n !== closedCommand);
  const [watch, setWatch] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewError, setReviewError] = useState('');
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [plan, setPlan] = useState(false);
  const [day, setDay] = useState(localDate(new Date()));
  const [meal, setMeal] = useState('Dinner');
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState('');
  const [collections, setCollections] = useState(false);
  const [busy, setBusy] = useState(false);
  const [titleBottom, setTitleBottom] = useState(0);
  const saved = app.library.savedIds.includes(recipe.id);
  const following = app.library.followingIds.includes(recipe.author.id);
  const mine = app.user?.id === recipe.author.id;
  const heroHeight = wide
    ? Math.min(560, Math.round(height * 0.6))
    : Math.min(470, Math.round(height * 0.55));
  // The bar fades in over the last stretch before the sheet's edge slides under it, tied to the
  // scroll position so it never snaps.
  const barEnd = heroHeight - radius.xl - insets.top - 44;
  const barStart = barEnd - 110;
  const scrollY = useState(() => new Animated.Value(0))[0];
  const settle = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    animate(settle, 1, 1400).start();
  }, [settle]);
  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: native,
      }),
    [scrollY],
  );
  // Memoized so re-renders mid-scroll reuse the same native nodes; rebuilding them restarts each
  // one from the last JS-side offset and makes the photo and bar jump for a frame.
  const bar = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [barStart, barEnd],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    [scrollY, barStart, barEnd],
  );
  // The small title takes over as the large one slides under the bar.
  const titleGone = heroHeight - radius.xl + 26 + titleBottom - insets.top - 64;
  const titleIn = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [titleGone - 28, titleGone + 6],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    [scrollY, titleGone],
  );
  const titleRise = useMemo(
    () => titleIn.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }),
    [titleIn],
  );
  const still = motionReduced();
  const heroMotion = useMemo(
    () =>
      still
        ? undefined
        : {
            transform: [
              {
                translateY: scrollY.interpolate({
                  inputRange: [-heroHeight, 0, heroHeight],
                  outputRange: [-heroHeight / 2, 0, heroHeight * 0.45],
                  extrapolate: 'clamp',
                }),
              },
              // Pulling down past the top stretches the photo instead of exposing a gap.
              {
                scale: scrollY.interpolate({
                  inputRange: [-heroHeight, 0],
                  outputRange: [2, 1],
                  extrapolateRight: 'clamp',
                }),
              },
              { scale: settle.interpolate({ inputRange: [0, 1], outputRange: [1.08, 1] }) },
            ],
          },
    [still, scrollY, settle, heroHeight],
  );
  const loadReviews = useCallback(
    () =>
      api<Review[]>(`/recipes/${recipe.id}/reviews`)
        .then(setReviews)
        .catch((e) => setReviewError(e.message)),
    [recipe.id],
  );
  useEffect(() => {
    void loadReviews();
  }, [loadReviews]);
  const perform = async (fn: () => Promise<unknown>, message: string) => {
    if (busy || !app.requireUser()) return;
    setBusy(true);
    await app.act(fn, message);
    setBusy(false);
  };
  const context = JSON.stringify({
    title: recipe.title,
    servings,
    ingredients: recipe.ingredients.map((i) => `${i.amount} ${i.unit} ${i.name}`.trim()),
    steps: recipe.steps.map((st) => `${st.title}: ${st.text}`),
  });
  const ask = (request: AIRequest) => onAI({ ...request, context });
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return d;
  });
  const stats = [
    { icon: Clock3, value: tr('{{v0}} min', { v0: recipe.minutes }), label: tr('Time') },
    { icon: Users, value: number(recipe.servings), label: tr('Servings') },
    recipe.calories
      ? { icon: Flame, value: number(recipe.calories), label: tr('kcal') }
      : {
          icon: Sparkles,
          value: 'Estimate',
          label: tr('Nutrition'),
          onPress: () =>
            ask({
              kind: 'nutrition',
              title: tr('Nutrition estimate'),
              prompt:
                'Estimate nutrition per serving: calories, protein, carbohydrates, fat and fiber.',
            }),
        },
    { icon: Gauge, value: recipe.difficulty, label: tr('Level') },
  ];
  const ingredients = (
    <View style={{ gap: 14 }}>
      <View style={[s.between, { gap: 12 }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.h2}>{tr('Ingredients')}</Text>
          <Text style={s.muted}>{tr('servingHint', { count: servings })}</Text>
        </View>
        <View
          style={[
            s.row,
            { backgroundColor: color.white, borderRadius: radius.pill, padding: 4, gap: 2 },
          ]}
        >
          <IconButton
            icon={Minus}
            plain
            size={34}
            label={tr('Fewer servings')}
            onPress={() => setServings(Math.max(1, servings - 1))}
          />
          <Text style={[s.h3, { minWidth: 22, textAlign: 'center' }]}>{servings}</Text>
          <IconButton
            icon={Plus}
            plain
            size={34}
            label={tr('More servings')}
            onPress={() => setServings(Math.min(100, servings + 1))}
          />
        </View>
      </View>
      <View style={[s.card, { paddingVertical: 4, paddingRight: 8 }]}>
        {recipe.ingredients.map((i, n) => (
          <View
            key={n}
            style={[
              s.row,
              n > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
            ]}
          >
            <View style={{ flex: 1 }}>
              <CheckRow
                checked={checked.includes(i.name)}
                onPress={() =>
                  setChecked(
                    checked.includes(i.name)
                      ? checked.filter((v) => v !== i.name)
                      : [...checked, i.name],
                  )
                }
              >
                <View style={[s.between, { gap: 10 }]}>
                  <Text style={[s.body, { flex: 1 }]}>{i.name}</Text>
                  <Text style={[s.muted, { color: color.ink, fontFamily: font.semibold }]}>
                    {number((i.amount * servings) / recipe.servings)} {i.unit}
                  </Text>
                </View>
              </CheckRow>
            </View>
            <IconButton
              icon={Repeat2}
              plain
              size={34}
              label={tr('Swap {{v0}}', { v0: i.name })}
              onPress={() =>
                ask({
                  kind: 'substitute',
                  title: tr('Swap {{v0}}', { v0: i.name }),
                  prompt: `What can I use instead of ${i.name}, and how much?`,
                })
              }
            />
          </View>
        ))}
      </View>
      <Button
        title={tr('Add to grocery list')}
        icon={ShoppingBasket}
        variant="secondary"
        busy={busy}
        onPress={() =>
          void perform(async () => {
            await api(`/recipes/${recipe.id}/groceries`, { method: 'POST', body: { servings } });
            await app.refreshPrivate();
          }, 'Ingredients added to your grocery list.')
        }
      />
      {/* Twists change the ingredients, so they sit with them rather than above the tabs. */}
      <View style={{ gap: 12, marginTop: 10 }}>
        <View style={[s.row, { gap: 8 }]}>
          <Sparkles size={16} color={color.ink} />
          <Text style={s.h3}>{tr('Make it yours')}</Text>
          <Text style={[s.small, { flex: 1 }]} numberOfLines={1}>
            {tr('· a new version in seconds')}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginHorizontal: wide ? 0 : -gutter }}
          contentContainerStyle={{ paddingHorizontal: wide ? 0 : gutter, gap: 8 }}
        >
          {twists.map(([title, prompt]) => (
            <Chip
              key={title}
              title={tr(title)}
              icon={foodIcon(title)}
              onPress={() =>
                ask({
                  kind: 'adapt',
                  title: tr('A {{v0}} version', { v0: tr(title) }),
                  prompt,
                })
              }
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
  const method = (
    <View style={{ gap: 12 }}>
      <Text style={[s.h2, { marginBottom: 2 }]}>{tr('Let’s make it')}</Text>
      {recipe.steps.map((st, i) => (
        <View key={i} style={[s.card, { flexDirection: 'row', gap: 14 }]}>
          <View
            style={{
              backgroundColor: color.ink,
              width: 32,
              height: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: color.white, fontFamily: font.bold, fontSize: 13 }}>{i + 1}</Text>
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={s.h3}>{st.title}</Text>
            <Text style={[s.body, { color: '#3A3A3A' }]}>{st.text}</Text>
            {st.seconds > 0 && (
              <View style={[s.row, { gap: 6, marginTop: 2 }]}>
                <Timer size={14} color={color.muted} />
                <Text style={s.small}>
                  {tr('{{v0}} min timer in cooking mode', { v0: Math.round(st.seconds / 60) })}
                </Text>
              </View>
            )}
          </View>
        </View>
      ))}
    </View>
  );
  const table = (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 2 }}>
        <Text style={s.h2}>{tr('Around the table')}</Text>
        <Text style={s.muted}>{tr('Made it? Share a note with the next cook.')}</Text>
      </View>
      {!!reviewError && <Text style={{ color: color.error }}>{tr(reviewError)}</Text>}
      {reviews.map((r) => (
        <View key={r.id} style={[s.card, { gap: 10 }]}>
          <View style={[s.row, { gap: 10 }]}>
            <Avatar name={r.author.name} uri={r.author.avatar} size={32} />
            <Text style={[s.h3, { flex: 1, fontSize: 14 }]}>{r.author.name}</Text>
            <View style={[s.row, { gap: 2 }]}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  size={12}
                  color={n <= r.rating ? color.ink : color.line}
                  fill={n <= r.rating ? color.ink : color.line}
                />
              ))}
            </View>
          </View>
          <Text style={s.body}>{r.body}</Text>
        </View>
      ))}
      {!mine && (
        <View style={[s.card, { gap: 14 }]}>
          <Text style={s.h3}>{tr('How did it turn out?')}</Text>
          <View style={[s.row, { gap: 6 }]}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Pressable
                key={n}
                accessibilityRole="button"
                accessibilityLabel={tr('Rate {{v0}} stars', { v0: n })}
                onPress={() => setRating(n)}
                hitSlop={4}
                style={{ padding: 4 }}
              >
                <Star size={26} color={color.ink} fill={n <= rating ? color.ink : 'none'} />
              </Pressable>
            ))}
          </View>
          <Field
            label={tr('Your cooking notes')}
            multiline
            placeholder={tr('Any tips or little twists?')}
            value={body}
            onChangeText={setBody}
            style={{ backgroundColor: color.bg, borderColor: color.bg }}
          />
          <Button
            title={tr('Share your review')}
            disabled={body.trim().length < 3}
            busy={busy}
            onPress={() =>
              void perform(async () => {
                await api(`/recipes/${recipe.id}/review`, {
                  method: 'PUT',
                  body: { rating, body },
                });
                setBody('');
                await loadReviews();
                await app.refreshRecipes();
              }, 'Thanks for sharing a little kitchen wisdom.')
            }
          />
        </View>
      )}
    </View>
  );
  const actions = [
    {
      icon: CalendarDays,
      title: tr('Plan'),
      label: tr('Plan this meal'),
      onPress: () => app.requireUser(() => setPlan(true)),
    },
    {
      icon: BookmarkPlus,
      title: tr('Cookbook'),
      label: tr('Add to cookbook'),
      onPress: () => app.requireUser(() => setCollections(true)),
    },
    ...(recipe.video
      ? [
          {
            icon: Play,
            title: tr('Video'),
            label: tr('Watch video'),
            onPress: () => setWatch(true),
          },
        ]
      : []),
    { icon: Sparkles, title: tr('Ask'), label: tr('Ask the sous-chef'), onPress: onAsk },
  ];
  return (
    <Animated.View aria-modal style={page.style}>
      <ScrollStatusBar y={scrollY} past={barEnd - 40} />
      <View style={{ flex: 1, backgroundColor: color.bg }}>
        <Animated.ScrollView
          scrollEventThrottle={16}
          onScroll={onScroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ height: heroHeight, backgroundColor: color.ink }}>
            {/* The scrim rides with the photo so an overscroll never shows its edge. */}
            <Gallery
              photos={[recipe.image, ...(recipe.photos || [])]}
              width={width}
              height={heroHeight}
              motion={heroMotion}
            />
          </View>
          <View
            style={{
              marginTop: -radius.xl,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              backgroundColor: color.bg,
              paddingTop: 26,
              paddingHorizontal: gutter,
            }}
          >
            <View style={{ width: '100%', maxWidth: 1080, alignSelf: 'center', gap: 22 }}>
              <FadeIn delay={60} style={{ gap: 12 }}>
                <View style={[s.row, { gap: 6, flexWrap: 'wrap' }]}>
                  <Pill
                    title={
                      recipe.rating > 0
                        ? `${number(recipe.rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} · ${recipe.reviewCount}`
                        : tr('New')
                    }
                    icon={Star}
                    fill
                  />
                  <Pill
                    title={tr(recipe.cuisine)}
                    leading={<CuisineIcon name={recipe.cuisine} size={22} />}
                  />
                  {/* One line of badges on phones; the tags are all in the recipe anyway. */}
                  {recipe.tags.slice(0, wide ? 2 : 1).map((t) => (
                    <Pill key={t} title={tr(t)} icon={foodIcon(t)} />
                  ))}
                  {recipe.aiGenerated && (
                    <Pill title={tr('AI assisted')} icon={Sparkles} tone="dark" />
                  )}
                </View>
                <Text
                  onLayout={(e) =>
                    setTitleBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)
                  }
                  style={[s.display, !wide && { fontSize: 29, lineHeight: 35 }]}
                >
                  {recipe.title}
                </Text>
                <View style={[s.row, { gap: 12, marginVertical: 2 }, wide && { maxWidth: 620 }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={tr('Visit {{v0}}’s kitchen', { v0: recipe.author.name })}
                    onPress={() => onCreator(recipe.author)}
                    style={[s.row, { gap: 10, flex: 1 }]}
                  >
                    <Avatar name={recipe.author.name} uri={recipe.author.avatar} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[s.h3, { fontSize: 15, lineHeight: 20 }]}>
                        {recipe.author.name}
                      </Text>
                      <Text numberOfLines={1} style={s.small}>
                        {recipe.author.followerCount
                          ? tr('{{v0}} followers', { v0: recipe.author.followerCount })
                          : `@${recipe.author.handle}`}
                      </Text>
                    </View>
                  </Pressable>
                  {mine ? (
                    <Button
                      title={tr('Edit')}
                      label={tr('Edit recipe')}
                      icon={Pencil}
                      variant="secondary"
                      small
                      onPress={() => onEdit(recipe)}
                    />
                  ) : (
                    <Button
                      title={following ? tr('Following') : tr('Follow')}
                      icon={following ? Check : undefined}
                      variant={following ? 'secondary' : 'primary'}
                      small
                      onPress={() =>
                        void perform(async () => {
                          await api(`/creators/${recipe.author.id}/follow`, {
                            method: following ? 'DELETE' : 'PUT',
                          });
                          await app.refreshPrivate();
                        }, 'Your community is updated.')
                      }
                    />
                  )}
                </View>
                {!!recipe.description && (
                  <Text style={[s.muted, { fontSize: 15, lineHeight: 23 }]}>
                    {recipe.description}
                  </Text>
                )}
              </FadeIn>
              {/* The facts in one card and the things to do in one row, so the page goes
                  straight from the story to the cooking. */}
              <FadeIn
                delay={130}
                style={[
                  s.row,
                  {
                    alignItems: 'stretch',
                    backgroundColor: color.white,
                    borderRadius: radius.lg,
                    paddingVertical: 14,
                  },
                  wide && { maxWidth: 620 },
                ]}
              >
                {stats.map((x, i) => {
                  const Icon = x.icon;
                  const fact = (
                    <View
                      style={{
                        flex: 1,
                        alignItems: 'center',
                        gap: 5,
                        paddingHorizontal: 4,
                        borderLeftWidth: i > 0 ? StyleSheet.hairlineWidth : 0,
                        borderColor: color.line,
                      }}
                    >
                      <Icon size={17} color={color.ink} strokeWidth={1.8} />
                      <Text numberOfLines={1} style={[s.h3, { fontSize: 14, lineHeight: 18 }]}>
                        {tr(x.value)}
                      </Text>
                      <Text numberOfLines={1} style={[s.small, { fontSize: 11, lineHeight: 14 }]}>
                        {tr(x.label)}
                      </Text>
                    </View>
                  );
                  return 'onPress' in x && x.onPress ? (
                    <Pressable
                      key={tr(x.label)}
                      accessibilityRole="button"
                      accessibilityLabel={tr('Estimate nutrition')}
                      onPress={x.onPress}
                      style={{ flex: 1, display: 'flex' }}
                    >
                      {fact}
                    </Pressable>
                  ) : (
                    <React.Fragment key={tr(x.label)}>{fact}</React.Fragment>
                  );
                })}
              </FadeIn>
              <FadeIn delay={200} style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
                {actions.map((a) => {
                  const Icon = a.icon;
                  return (
                    <Press
                      key={tr(a.title)}
                      accessibilityRole="button"
                      accessibilityLabel={tr(a.label)}
                      onPress={a.onPress}
                      scale={0.97}
                      style={[
                        s.row,
                        styles.action,
                        wide
                          ? { paddingHorizontal: 20 }
                          : { flexGrow: 1, flexBasis: actions.length > 3 ? '40%' : 'auto' },
                      ]}
                    >
                      <Icon size={17} color={color.ink} strokeWidth={2} />
                      <Text numberOfLines={1} style={styles.actionText}>
                        {tr(a.title)}
                      </Text>
                    </Press>
                  );
                })}
              </FadeIn>
              {wide ? (
                <View style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start' }}>
                  <View style={{ flex: 0.9 }}>{ingredients}</View>
                  <View style={{ flex: 1.2 }}>{method}</View>
                </View>
              ) : (
                <>
                  <Segmented
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: 'ingredients', label: tr('Ingredients') },
                      { value: 'method', label: tr('Method') },
                      {
                        value: 'reviews',
                        label: tr('{{v0}}{{v1}}', {
                          v0: tr('Reviews'),
                          v1: reviews.length ? ` · ${reviews.length}` : '',
                        }),
                      },
                    ]}
                  />
                  <FadeIn key={tab} offset={10}>
                    {tab === 'ingredients' ? ingredients : tab === 'method' ? method : table}
                  </FadeIn>
                </>
              )}
              {wide && table}
              <Button
                title={tr('Report a problem with this recipe')}
                variant="ghost"
                icon={Flag}
                small
                style={{ alignSelf: 'center' }}
                onPress={() => app.requireUser(() => setReport(true))}
              />
            </View>
          </View>
        </Animated.ScrollView>
        <View
          style={[
            s.between,
            {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              paddingTop: insets.top + 10,
              paddingBottom: 10,
              paddingHorizontal: gutter,
              gap: 12,
            },
          ]}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: color.bg,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: color.line,
                opacity: bar,
              },
            ]}
          />
          <IconButton icon={ArrowLeft} label={tr('Close recipe')} onPress={page.leave} glass />
          <Animated.Text
            numberOfLines={1}
            style={[
              s.h3,
              {
                flex: 1,
                textAlign: 'center',
                opacity: titleIn,
                transform: [{ translateY: titleRise }],
              },
            ]}
          >
            {recipe.title}
          </Animated.Text>
          <View style={[s.row, { gap: 10 }]}>
            <IconButton
              icon={Share2}
              glass
              label={tr('Share recipe')}
              onPress={() =>
                void app.act(async () => {
                  await Share.share({
                    message: `${recipe.title} — ${recipe.minutes} minutes. ${WEB_URL}/?recipe=${recipe.id}`,
                  });
                })
              }
            />
            <IconButton
              icon={Bookmark}
              glass
              label={tr('Save recipe')}
              selected={saved}
              onPress={() => void app.toggleSave(recipe)}
            />
          </View>
        </View>
        <FadeIn
          delay={220}
          offset={40}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: gutter,
            paddingTop: 26,
            paddingBottom: insets.bottom + 14,
          }}
        >
          <LinearGradient
            colors={['rgba(244,244,244,0)', color.bg]}
            locations={[0, 0.5]}
            style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
          />
          <Button
            title={tr('Start cooking')}
            icon={ChefHat}
            large
            onPress={() => setCook(true)}
            style={{
              width: '100%',
              maxWidth: 520,
              alignSelf: 'center',
              boxShadow: '0px 10px 30px rgba(0,0,0,0.22)',
            }}
          />
        </FadeIn>
        <Toast message={app.toast} bottom={insets.bottom + 96} />
      </View>
      {cooking && (
        <CookMode
          recipe={recipe}
          command={cookCommand}
          onStep={onCooking}
          onAsk={onAsk}
          onClose={() => {
            setCook(false);
            setClosedCommand(cookCommand?.n);
            onCooking(null);
          }}
        />
      )}
      <Dialog visible={watch} onClose={() => setWatch(false)} title={tr('Watch and cook')}>
        {watch && recipe.video ? <VideoPlayer uri={recipe.video} /> : null}
      </Dialog>
      <Dialog visible={plan} onClose={() => setPlan(false)} title={tr('Plan this meal')}>
        <ScrollView
          horizontal
          style={{ flexGrow: 0 }}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {days.map((d, i) => (
            <Chip
              key={localDate(d)}
              title={
                i === 0
                  ? tr('Today')
                  : i === 1
                    ? tr('Tomorrow')
                    : d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' })
              }
              active={day === localDate(d)}
              onPress={() => setDay(localDate(d))}
            />
          ))}
        </ScrollView>
        <Segmented
          value={meal}
          onChange={setMeal}
          options={['Breakfast', 'Lunch', 'Dinner'].map((m) => ({ value: m, label: tr(m) }))}
        />
        <View style={[s.card, s.row, { gap: 12, padding: 12 }]}>
          <FoodImage uri={recipe.image} style={{ width: 52, height: 52, borderRadius: 16 }} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={s.h3}>
              {recipe.title}
            </Text>
            <Text style={s.small}>{tr('{{v0}} servings', { v0: servings })}</Text>
          </View>
        </View>
        {app.kitchen.plans.some((p) => p.day === day && p.meal === meal) && (
          <Text style={[s.small, { color: color.warning }]}>
            {tr('This replaces the meal already planned for this slot.')}
          </Text>
        )}
        <Button
          title={tr('Add to my week')}
          icon={Check}
          busy={busy}
          onPress={() =>
            void perform(async () => {
              await api('/planner', {
                method: 'POST',
                body: { recipeId: recipe.id, day, meal, servings },
              });
              await app.refreshPrivate();
              setPlan(false);
            }, 'A delicious plan. Added to your week.')
          }
        />
      </Dialog>
      <Dialog
        visible={collections}
        onClose={() => setCollections(false)}
        title={tr('Add to a cookbook')}
      >
        {!app.library.collections.length && (
          <Text style={s.muted}>
            {tr('Create named cookbooks in Saved. You can keep this in All saved for now.')}
          </Text>
        )}
        <View style={[s.card, { paddingVertical: 4 }]}>
          {[{ id: '', name: 'All saved' }, ...app.library.collections].map((c, n) => (
            <Pressable
              key={c.id}
              accessibilityRole="button"
              onPress={() =>
                void perform(
                  async () => {
                    await api(`/recipes/${recipe.id}/save`, {
                      method: 'PUT',
                      body: { collectionId: c.id || null },
                    });
                    await app.refreshPrivate();
                    setCollections(false);
                  },
                  tr('Saved to {{v0}}', { v0: c.name }),
                )
              }
              style={[
                s.between,
                { paddingVertical: 16 },
                n > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
              ]}
            >
              <Text style={s.body}>{c.name}</Text>
              <Plus size={18} color={color.ink} />
            </Pressable>
          ))}
        </View>
      </Dialog>
      <Dialog visible={report} onClose={() => setReport(false)} title={tr('Report this recipe')}>
        <Field
          label={tr('What needs a closer look?')}
          value={reason}
          onChangeText={setReason}
          multiline
          placeholder={tr('Tell us what happened…')}
        />
        <Button
          title={tr('Submit report')}
          disabled={reason.trim().length < 5}
          busy={busy}
          onPress={() =>
            void perform(async () => {
              await api(`/recipes/${recipe.id}/report`, { method: 'POST', body: { reason } });
              setReport(false);
            }, 'Your report has been recorded for review.')
          }
        />
      </Dialog>
    </Animated.View>
  );
}
// Flips the status bar on its own so crossing the threshold never re-renders the page mid-scroll.
function ScrollStatusBar({ y, past }: { y: Animated.Value; past: number }) {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const id = y.addListener(({ value }) => setDark(value > past));
    return () => y.removeListener(id);
  }, [y, past]);
  return <StatusBar barStyle={dark ? 'dark-content' : 'light-content'} animated />;
}
// The cover and any extra photos side by side; a white dot glides over the dim ones as you swipe.
function Gallery({
  photos,
  width,
  height,
  motion,
}: {
  photos: string[];
  width: number;
  height: number;
  motion?: object;
}) {
  const { t: tr } = useI18n();
  const [x] = useState(() => new Animated.Value(0));
  const list = useRef<ScrollView>(null);
  const onScroll = useMemo(
    () => Animated.event([{ nativeEvent: { contentOffset: { x } } }], { useNativeDriver: native }),
    [x],
  );
  const shown = photos.filter(Boolean);
  const many = shown.length > 1;
  const step = 12;
  return (
    <>
      {/* The scrim rides with the photos so an overscroll never shows its edge. */}
      <Animated.View style={[StyleSheet.absoluteFill, motion]}>
        <Animated.ScrollView
          ref={list}
          horizontal
          pagingEnabled
          scrollEnabled={many}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          style={StyleSheet.absoluteFill}
        >
          {(shown.length ? shown : ['']).map((uri, i) => (
            <FoodImage key={i} uri={uri} style={{ width, height }} />
          ))}
        </Animated.ScrollView>
        <LinearGradient
          colors={['rgba(0,0,0,0.42)', 'rgba(0,0,0,0)']}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 150,
            pointerEvents: 'none',
          }}
        />
      </Animated.View>
      {many && (
        // A small capsule keeps the dots readable over bright photos.
        <GlassSurface
          dark
          tint="rgba(0,0,0,0.32)"
          flat={{ backgroundColor: 'rgba(0,0,0,0.28)' }}
          style={{
            position: 'absolute',
            bottom: radius.xl + 12,
            alignSelf: 'center',
            padding: 4,
            borderRadius: radius.pill,
          }}
        >
          <View style={{ flexDirection: 'row' }}>
            {shown.map((_, i) => (
              <Pressable
                key={i}
                accessibilityRole="button"
                accessibilityLabel={tr('Show photo {{v0}} of {{v1}}', {
                  v0: i + 1,
                  v1: shown.length,
                })}
                hitSlop={6}
                onPress={() => list.current?.scrollTo({ x: i * width, animated: true })}
                style={{ width: step, height: 12, alignItems: 'center', justifyContent: 'center' }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: 'rgba(255,255,255,0.45)',
                  }}
                />
              </Pressable>
            ))}
            <Animated.View
              style={{
                position: 'absolute',
                top: 3,
                left: 3,
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: color.white,
                pointerEvents: 'none',
                transform: [
                  {
                    translateX: x.interpolate({
                      inputRange: [0, width * (shown.length - 1)],
                      outputRange: [0, step * (shown.length - 1)],
                      extrapolate: 'clamp',
                    }),
                  },
                ],
              }}
            />
          </View>
        </GlassSurface>
      )}
    </>
  );
}
const styles = StyleSheet.create({
  action: {
    justifyContent: 'center',
    gap: 7,
    height: 46,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.border,
  },
  actionText: { fontFamily: font.bold, fontSize: 13, color: color.ink, flexShrink: 1 },
});
