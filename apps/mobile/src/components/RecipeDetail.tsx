import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
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
  Printer,
  Repeat2,
  Share2,
  ShoppingBasket,
  Sparkles,
  Star,
  Timer,
  Trash2,
  Users,
} from './icons';
import { AIRequest, CookCommand, Creator, Ingredient, Recipe, Review } from '../lib/types';
import { api } from '../lib/api';
import { recipeUrl } from '../lib/routes';
import { track } from '../lib/telemetry';
import { useApp } from '../lib/store';
import { color, font, maxFontScale, radius, s } from '../lib/theme';
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
  animate,
  motionReduced,
  native,
  useChrome,
  useSlideOver,
  webPosition,
} from './ui';
import { CookMode } from './CookMode';
import { AppToast } from './AppToast';
import { StepVideo, VideoPlayer } from './VideoPlayer';
import { localDate } from '../lib/utils';
import { foodIcon } from '../lib/icons';
import { CuisineIcon } from './CuisineIcon';
import { knownUnit, showAmount } from '../lib/units';
import { siteName, wasEdited } from '../lib/social';
import { ReviewReply } from './ReviewReply';
import { canPrint, printRecipe } from '../lib/printRecipe';
import { amountText, UnitsSwitch, useUnits } from './Units';
import { Comments } from './Comments';
import { CookedIt } from './CookedIt';
import { Lineage } from './Variations';
import { DangerButton } from '../screens/Kitchen';
import { RevealFocus, useKeyboardLift, useKeyboardScroll } from '../lib/keyboard';
// Each twist asks in the cook's language: the request is their own message, and the model's cue.
const twists = (tr: (key: string) => string) => [
  ['Vegetarian', tr('Make this recipe vegetarian.')],
  ['Dairy-free', tr('Make this recipe dairy-free.')],
  ['Gluten-free', tr('Make this recipe gluten-free.')],
  ['More protein', tr('Adapt this recipe to be higher in protein.')],
  ['Quicker', tr('Make a faster weeknight version of this recipe.')],
];
// The page's account actions; each one spins only its own button while it runs.
type Action = 'groceries' | 'review' | 'unreview' | 'plan' | 'cookbook' | 'report' | 'follow';
export function RecipeDetail({
  recipe,
  onClose,
  onCreator,
  onOpen,
  onEdit,
  onAI,
  onAsk,
  onCooking,
  cookCommand,
}: {
  recipe: Recipe;
  onClose: () => void;
  onCreator: (c: Creator) => void;
  /** Opens another recipe in place of this one, such as the one it adapts or a variation. */
  onOpen?: (r: Recipe) => void;
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
  const { width, height, insets, gutter, webPage } = useChrome();
  const wide = width > 900;
  // The web page shows one photo at a time with thumbnails, and fades in rather than sliding up.
  const [photo, setPhoto] = useState(0);
  const [shown] = useState(() => new Animated.Value(webPage ? 0 : 1));
  useEffect(() => {
    if (webPage) animate(shown, 1, 200).start();
  }, [webPage, shown]);
  const [tab, setTab] = useState<'ingredients' | 'method' | 'reviews'>('ingredients');
  const [servings, setServings] = useState(recipe.servings);
  const [units, setUnits] = useUnits();
  const [checked, setChecked] = useState<string[]>([]);
  const [cook, setCook] = useState(false);
  // A sous-chef command opens cooking mode until the cook closes it.
  const [closedCommand, setClosedCommand] = useState<number>();
  const cooking = cook || (!!cookCommand && cookCommand.n !== closedCommand);
  const [watch, setWatch] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  // Cooking mode's "I cooked this" opens the sheet on the page it returns to.
  const [cookedRequest, setCookedRequest] = useState(0);
  const [reviewError, setReviewError] = useState('');
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [unreview, setUnreview] = useState(false);
  const [plan, setPlan] = useState(false);
  const [day, setDay] = useState(localDate(new Date()));
  const [meal, setMeal] = useState('Dinner');
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState('');
  const [collections, setCollections] = useState(false);
  const [busy, setBusy] = useState<Partial<Record<Action, boolean>>>({});
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
  const lift = useKeyboardLift();
  const scroller = useRef<ScrollView>(null);
  const keyboard = useKeyboardScroll(scroller, lift);
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
  const perform = async (action: Action, fn: () => Promise<unknown>, message: string) => {
    if (busy[action] || !app.requireUser()) return;
    setBusy((b) => ({ ...b, [action]: true }));
    await app.act(fn, message);
    setBusy((b) => ({ ...b, [action]: false }));
  };
  const link = recipeUrl(recipe.id);
  // Desktop browsers mostly have no share sheet, so there the link goes to the clipboard. Closing
  // the share sheet isn't a failure: iOS reports it as Share.dismissedAction, and browsers reject
  // with an AbortError, which act() lets pass without a toast.
  const share = () =>
    void app.act(async () => {
      track('share', { recipeId: recipe.id });
      if (Platform.OS === 'web' && !navigator.share) {
        await navigator.clipboard.writeText(link);
        app.notify('Link copied to your clipboard.');
      } else
        await Share.share({
          message: tr('shareMessage', { title: recipe.title, count: recipe.minutes, link }),
        });
    });
  // An ingredient's amount for the servings on screen, in the units the cook picked.
  const amountOf = (i: Ingredient) =>
    amountText(tr, showAmount(i, { servings, base: recipe.servings, units, locale }));
  // The web prints a page of its own: the recipe in the units and servings on screen.
  const print = () => {
    const site = siteName(recipe.sourceUrl);
    printRecipe({
      lang: locale,
      title: recipe.title,
      byline: tr('by {{v0}}', { v0: recipe.author.name }),
      facts: [
        tr('minuteCount', { count: recipe.minutes }),
        tr('servingCount', { count: servings }),
      ],
      description: recipe.description,
      image: recipe.image,
      ingredientsTitle: tr('Ingredients'),
      ingredients: recipe.ingredients.map((i) => ({ name: i.name, amount: amountOf(i) })),
      methodTitle: tr('Method'),
      steps: recipe.steps.map((st) => ({ title: st.title, text: st.text })),
      credits: [
        recipe.derivedFrom
          ? tr('Adapted from {{title}} by {{name}}', {
              title: recipe.derivedFrom.title,
              name: recipe.derivedFrom.author.name,
            })
          : '',
        site ? `${tr('From {{site}}', { site })} · ${recipe.sourceUrl}` : '',
      ].filter(Boolean),
      link,
    });
  };
  const context = JSON.stringify({
    title: recipe.title,
    servings,
    ingredients: recipe.ingredients.map((i) => `${i.amount} ${i.unit} ${i.name}`.trim()),
    steps: recipe.steps.map((st) => `${st.title}: ${st.text}`),
  });
  // A new version of the recipe (a twist, a swap) credits this one when it is saved.
  const ask = (request: AIRequest) =>
    onAI({
      ...request,
      context,
      ...((request.kind === 'adapt' || request.kind === 'substitute') && {
        derivedFrom: recipe.id,
      }),
    });
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return d;
  });
  const stats = [
    { icon: Clock3, value: tr('minuteCount', { count: recipe.minutes }), label: tr('Time') },
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
              prompt: tr(
                'Estimate nutrition per serving: calories, protein, carbohydrates, fat and fiber.',
              ),
            }),
        },
    { icon: Gauge, value: recipe.difficulty, label: tr('Level') },
  ];
  const twistChips = twists(tr).map(([title, prompt]) => (
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
  ));
  const ingredients = (
    <View style={{ gap: 14 }}>
      <View style={[s.between, { gap: 12 }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text role="heading" aria-level={2} style={s.h2}>
            {tr('Ingredients')}
          </Text>
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
      {/* Only amounts with a size to convert need the choice; eggs and cloves don't. */}
      {recipe.ingredients.some((i) => knownUnit(i.unit)) && (
        <UnitsSwitch value={units} onChange={setUnits} />
      )}
      {/* The web page frames the whole column in one card, so the list sits straight in it. */}
      <View
        style={webPage ? { marginRight: -8 } : [s.card, { paddingVertical: 4, paddingRight: 8 }]}
      >
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
                  <Text
                    style={[
                      s.muted,
                      { color: color.ink, fontFamily: font.semibold, textAlign: 'right' },
                    ]}
                  >
                    {amountOf(i)}
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
                  prompt: tr('What can I use instead of {{v0}}, and how much?', { v0: i.name }),
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
        busy={busy.groceries}
        onPress={() =>
          void perform(
            'groceries',
            async () => {
              await api(`/recipes/${recipe.id}/groceries`, { method: 'POST', body: { servings } });
              await app.refreshKitchen();
            },
            'Ingredients added to your grocery list.',
          )
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
        {webPage ? (
          <View style={[s.row, { flexWrap: 'wrap', gap: 8 }]}>{twistChips}</View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, marginHorizontal: wide ? 0 : -gutter }}
            contentContainerStyle={{ paddingHorizontal: wide ? 0 : gutter, gap: 8 }}
          >
            {twistChips}
          </ScrollView>
        )}
      </View>
    </View>
  );
  // A card per step on phones; on the web page, one card of steps divided by lines, set larger
  // for reading at a distance from the stove.
  const method = (
    <View style={{ gap: webPage ? 16 : 12 }}>
      <Text
        role="heading"
        aria-level={2}
        style={[s.h2, { marginBottom: 2 }, webPage && styles.webHeading]}
      >
        {tr('Let’s make it')}
      </Text>
      <View style={webPage ? [s.card, { paddingVertical: 6, paddingHorizontal: 28 }] : { gap: 12 }}>
        {recipe.steps.map((st, i) => (
          <View
            key={i}
            style={
              webPage
                ? [
                    { flexDirection: 'row', gap: 20, paddingVertical: 22 },
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
                  ]
                : [s.card, { flexDirection: 'row', gap: 14 }]
            }
          >
            <View
              style={{
                backgroundColor: color.ink,
                width: webPage ? 36 : 32,
                height: webPage ? 36 : 32,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{ color: color.white, fontFamily: font.bold, fontSize: webPage ? 15 : 13 }}
              >
                {i + 1}
              </Text>
            </View>
            <View style={{ flex: 1, gap: webPage ? 8 : 6 }}>
              <Text
                role="heading"
                aria-level={3}
                style={[s.h3, webPage && { fontSize: 18, lineHeight: 24 }]}
              >
                {st.title}
              </Text>
              <Text
                style={[s.body, { color: '#3A3A3A' }, webPage && { fontSize: 16, lineHeight: 26 }]}
              >
                {st.text}
              </Text>
              {!!st.image && (
                <FoodImage
                  uri={st.image}
                  label={tr('Photo of step {{v0}}', { v0: i + 1 })}
                  width={Math.min(width - gutter * 2, 480)}
                  style={{
                    width: '100%',
                    maxWidth: 480,
                    aspectRatio: 3 / 2,
                    borderRadius: radius.md,
                    marginTop: 4,
                  }}
                />
              )}
              {!!st.video && (
                <StepVideo
                  uri={st.video}
                  step={i + 1}
                  style={{ maxWidth: 480, aspectRatio: 16 / 9, marginTop: 4 }}
                />
              )}
              {st.seconds > 0 && (
                <View style={[s.row, { gap: 6, marginTop: 2 }]}>
                  <Timer size={14} color={color.muted} />
                  <Text style={s.small}>
                    {tr('timerHint', { count: Math.round(st.seconds / 60) })}
                  </Text>
                </View>
              )}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
  const table = (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 2 }}>
        <Text role="heading" aria-level={2} style={[s.h2, webPage && styles.webHeading]}>
          {tr('Around the table')}
        </Text>
        <Text style={s.muted}>{tr('Made it? Share a note with the next cook.')}</Text>
      </View>
      {!!reviewError && <Text style={{ color: color.error }}>{tr(reviewError)}</Text>}
      {reviews.map((r) => (
        <View key={r.id} style={[s.card, { gap: 10 }, webPage && { padding: 24 }]}>
          <View style={[s.row, { gap: 10 }]}>
            <Avatar name={r.author.name} uri={r.author.avatar} size={32} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[s.h3, { fontSize: 14 }]}>
                {r.author.name}
              </Text>
              {wasEdited(r.createdAt, r.updatedAt) && <Text style={s.small}>{tr('Edited')}</Text>}
            </View>
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
            {!!app.user && r.author.id === app.user.id && (
              <IconButton
                icon={Trash2}
                plain
                size={34}
                label={tr('Delete your review')}
                onPress={() => setUnreview(true)}
              />
            )}
          </View>
          <Text style={s.body}>{r.body}</Text>
          <ReviewReply
            recipeId={recipe.id}
            review={r}
            author={recipe.author}
            canReply={mine}
            onChanged={(reply) =>
              setReviews((list) => list.map((x) => (x.id === r.id ? { ...x, reply } : x)))
            }
          />
        </View>
      ))}
      {!mine && (
        <View style={[s.card, { gap: 14 }, webPage && { padding: 24 }]}>
          <Text style={s.h3}>{tr('How did it turn out?')}</Text>
          <View style={[s.row, { gap: 6 }]}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Pressable
                key={n}
                accessibilityRole="button"
                accessibilityLabel={tr('rateStars', { count: n })}
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
            busy={busy.review}
            onPress={() =>
              void perform(
                'review',
                async () => {
                  await api(`/recipes/${recipe.id}/review`, {
                    method: 'PUT',
                    body: { rating, body },
                  });
                  setBody('');
                  await loadReviews();
                  await app.refreshRecipes();
                },
                'Thanks for sharing a little kitchen wisdom.',
              )
            }
          />
        </View>
      )}
    </View>
  );
  // Cooking mode and the sheets, shared by both layouts.
  const overlays = (
    <>
      {cooking && (
        <CookMode
          recipe={recipe}
          command={cookCommand}
          onStep={onCooking}
          onAsk={onAsk}
          onCooked={() => setCookedRequest((n) => n + 1)}
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
            <Text style={s.small}>{tr('servingCount', { count: servings })}</Text>
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
          busy={busy.plan}
          onPress={() =>
            void perform(
              'plan',
              async () => {
                await api('/planner', {
                  method: 'POST',
                  body: { recipeId: recipe.id, day, meal, servings },
                });
                await app.refreshKitchen();
                setPlan(false);
              },
              'A delicious plan. Added to your week.',
            )
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
          {[{ id: '', name: tr('All saved') }, ...app.library.collections].map((c, n) => (
            <Pressable
              key={c.id}
              accessibilityRole="button"
              disabled={busy.cookbook}
              onPress={() =>
                void perform(
                  'cookbook',
                  async () => {
                    await api(`/recipes/${recipe.id}/save`, {
                      method: 'PUT',
                      body: { collectionId: c.id || null },
                    });
                    await app.refreshLibrary();
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
          busy={busy.report}
          onPress={() =>
            void perform(
              'report',
              async () => {
                await api(`/recipes/${recipe.id}/report`, { method: 'POST', body: { reason } });
                setReport(false);
              },
              'Your report has been recorded for review.',
            )
          }
        />
      </Dialog>
      <Dialog
        visible={unreview}
        onClose={() => setUnreview(false)}
        title={tr('Delete your review?')}
      >
        <Text style={s.body}>{tr('Your rating and note are removed from this recipe.')}</Text>
        <DangerButton
          title={tr('Delete review')}
          busy={busy.unreview}
          onPress={() =>
            void perform(
              'unreview',
              async () => {
                await api(`/recipes/${recipe.id}/review`, { method: 'DELETE' });
                setUnreview(false);
                await loadReviews();
                await app.refreshRecipes();
              },
              'Your review is deleted.',
            )
          }
        />
      </Dialog>
    </>
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
  const photos = [recipe.image, ...(recipe.photos || [])].filter(Boolean);
  const pills = (
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
      <Pill title={tr(recipe.cuisine)} leading={<CuisineIcon name={recipe.cuisine} size={22} />} />
      {/* One line of badges on phones; the tags are all in the recipe anyway. */}
      {recipe.tags.slice(0, webPage ? 3 : wide ? 2 : 1).map((t) => (
        <Pill key={t} title={tr(t)} icon={foodIcon(t)} />
      ))}
      {recipe.aiGenerated && <Pill title={tr('AI assisted')} icon={Sparkles} tone="dark" />}
    </View>
  );
  const byline = (
    <View style={[s.row, { gap: 12, marginVertical: 2 }, wide && { maxWidth: 620 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('Visit {{v0}}’s kitchen', { v0: recipe.author.name })}
        onPress={() => onCreator(recipe.author)}
        style={[s.row, { gap: 10, flex: 1 }]}
      >
        <Avatar name={recipe.author.name} uri={recipe.author.avatar} size={webPage ? 44 : 36} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[s.h3, { fontSize: 15, lineHeight: 20 }]}>
            {recipe.author.name}
          </Text>
          <Text numberOfLines={1} style={s.small}>
            {recipe.author.followerCount
              ? tr('followerCount', { count: recipe.author.followerCount })
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
          busy={busy.follow}
          onPress={() =>
            void perform(
              'follow',
              async () => {
                await api(`/creators/${recipe.author.id}/follow`, {
                  method: following ? 'DELETE' : 'PUT',
                });
                await app.refreshLibrary();
              },
              'Your community is updated.',
            )
          }
        />
      )}
    </View>
  );
  const lineage = <Lineage recipe={recipe} onOpen={onOpen} onCreator={onCreator} />;
  const facts = (
    <View
      style={[
        s.row,
        {
          alignItems: 'stretch',
          backgroundColor: color.white,
          borderRadius: radius.lg,
          paddingVertical: webPage ? 18 : 14,
        },
        wide && !webPage && { maxWidth: 620 },
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
            <Text
              numberOfLines={1}
              style={[s.h3, { fontSize: webPage ? 16 : 14, lineHeight: webPage ? 21 : 18 }]}
            >
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
    </View>
  );
  const actionButtons = actions.map((a) => {
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
        <Text numberOfLines={1} maxFontSizeMultiplier={maxFontScale} style={styles.actionText}>
          {tr(a.title)}
        </Text>
      </Press>
    );
  });
  // A desktop browser gets a page inside the app's sidebar and header: the photo beside the story
  // and the things to do, then the ingredients held in view beside the method as it scrolls.
  // Narrower windows (beside the 248px sidebar) stack them instead.
  const split = width - 248 - gutter * 2 >= 880;
  if (webPage)
    return (
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: color.bg, opacity: shown }]}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 20, paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ width: '100%', maxWidth: 1200, alignSelf: 'center', gap: 28 }}>
            <View style={s.between}>
              <Button
                title={tr('Back')}
                icon={ArrowLeft}
                variant="ghost"
                small
                onPress={onClose}
                style={{ marginLeft: -12 }}
              />
              <View style={[s.row, { gap: 8 }]}>
                {canPrint && (
                  <Button
                    title={tr('Print')}
                    label={tr('Print recipe')}
                    icon={Printer}
                    variant="secondary"
                    small
                    onPress={print}
                  />
                )}
                <Button
                  title={tr('Share')}
                  label={tr('Share recipe')}
                  icon={Share2}
                  variant="secondary"
                  small
                  onPress={share}
                />
                <Button
                  title={saved ? tr('In your cookbooks') : tr('Save')}
                  label={saved ? tr('In your cookbooks') : tr('Save recipe')}
                  icon={Bookmark}
                  variant={saved ? 'primary' : 'secondary'}
                  small
                  onPress={() => void app.toggleSave(recipe)}
                />
              </View>
            </View>
            <View style={{ flexDirection: split ? 'row' : 'column', gap: split ? 48 : 28 }}>
              <View style={split ? { flex: 1.1, gap: 12 } : { gap: 12 }}>
                <FoodImage
                  uri={photos[photo] || ''}
                  label={recipe.title}
                  priority="high"
                  style={{
                    width: '100%',
                    aspectRatio: split ? 4 / 3 : 16 / 9,
                    borderRadius: radius.xl,
                  }}
                />
                {photos.length > 1 && (
                  <View style={[s.row, { gap: 10, flexWrap: 'wrap' }]}>
                    {photos.map((uri, i) => (
                      <Press
                        key={uri}
                        accessibilityRole="button"
                        accessibilityLabel={tr('Show photo {{v0}} of {{v1}}', {
                          v0: i + 1,
                          v1: photos.length,
                        })}
                        accessibilityState={{ selected: i === photo }}
                        onPress={() => setPhoto(i)}
                        scale={0.96}
                        style={{
                          borderRadius: radius.md,
                          borderWidth: 2,
                          borderColor: i === photo ? color.ink : 'transparent',
                          padding: 2,
                        }}
                      >
                        <FoodImage uri={uri} style={{ width: 76, height: 60, borderRadius: 15 }} />
                      </Press>
                    ))}
                  </View>
                )}
              </View>
              <View style={split ? { flex: 1, gap: 20, paddingTop: 4 } : { gap: 20 }}>
                {pills}
                <Text
                  role="heading"
                  aria-level={1}
                  style={[s.display, { fontSize: 44, lineHeight: 50, letterSpacing: -1.6 }]}
                >
                  {recipe.title}
                </Text>
                {!!recipe.description && (
                  <Text style={[s.muted, { fontSize: 17, lineHeight: 27 }]}>
                    {recipe.description}
                  </Text>
                )}
                {byline}
                {lineage}
                {facts}
                <View style={{ gap: 10 }}>
                  <Button
                    title={tr('Start cooking')}
                    icon={ChefHat}
                    large
                    onPress={() => setCook(true)}
                  />
                  <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>{actionButtons}</View>
                </View>
                <CookedIt recipe={recipe} wide request={cookedRequest} />
              </View>
            </View>
            <View
              style={{
                flexDirection: split ? 'row' : 'column',
                gap: 48,
                alignItems: split ? 'flex-start' : 'stretch',
                marginTop: 24,
              }}
            >
              <View style={split && [{ width: 380 }, webPosition('sticky', { top: 24 })]}>
                <View style={[s.card, { padding: 24 }]}>{ingredients}</View>
              </View>
              <View style={{ flex: split ? 1 : undefined, gap: 48, maxWidth: 760 }}>
                {method}
                {table}
                <Comments recipe={recipe} wide />
                <Button
                  title={tr('Report a problem with this recipe')}
                  variant="ghost"
                  icon={Flag}
                  small
                  style={{ alignSelf: 'flex-start', marginLeft: -12 }}
                  onPress={() => app.requireUser(() => setReport(true))}
                />
              </View>
            </View>
          </View>
        </ScrollView>
        <AppToast />
        {overlays}
      </Animated.View>
    );
  return (
    <Animated.View aria-modal style={page.style}>
      <ScrollStatusBar y={scrollY} past={barEnd - 40} />
      {/* The page ends above the keyboard, and a field being typed in (a comment, a review)
          scrolls into view. */}
      <View style={{ flex: 1, backgroundColor: color.bg, paddingBottom: lift }}>
        <Animated.ScrollView
          ref={scroller}
          onLayout={keyboard.onLayout}
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
                {pills}
                <Text
                  role="heading"
                  aria-level={1}
                  onLayout={(e) =>
                    setTitleBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)
                  }
                  style={[s.display, !wide && { fontSize: 29, lineHeight: 35 }]}
                >
                  {recipe.title}
                </Text>
                {byline}
                {!!recipe.description && (
                  <Text style={[s.muted, { fontSize: 15, lineHeight: 23 }]}>
                    {recipe.description}
                  </Text>
                )}
                {lineage}
              </FadeIn>
              {/* The facts in one card and the things to do in one row, so the page goes
                  straight from the story to the cooking. */}
              <FadeIn delay={130}>{facts}</FadeIn>
              <FadeIn delay={200} style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
                {actionButtons}
              </FadeIn>
              <CookedIt recipe={recipe} wide={wide} request={cookedRequest} />
              {wide ? (
                <View style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start' }}>
                  <View style={{ flex: 0.9 }}>{ingredients}</View>
                  <View style={{ flex: 1.2 }}>{method}</View>
                </View>
              ) : (
                <RevealFocus.Provider value={keyboard.reveal}>
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
                </RevealFocus.Provider>
              )}
              <RevealFocus.Provider value={keyboard.reveal}>
                {wide && table}
                <Comments recipe={recipe} />
              </RevealFocus.Provider>
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
            {canPrint && (
              <IconButton icon={Printer} glass label={tr('Print recipe')} onPress={print} />
            )}
            <IconButton icon={Share2} glass label={tr('Share recipe')} onPress={share} />
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
        <AppToast bottom={insets.bottom + 96} />
      </View>
      {overlays}
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
    minHeight: 46,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.border,
  },
  actionText: { fontFamily: font.bold, fontSize: 13, color: color.ink, flexShrink: 1 },
  webHeading: { fontSize: 24, lineHeight: 30, letterSpacing: -0.6 },
});
