import { I18nProvider, useI18n } from './src/lib/i18n';
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import {
  ArrowLeft,
  Bell,
  Bookmark,
  CalendarDays,
  ChevronRight,
  Compass,
  House,
  Leaf,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
} from './src/components/icons';
import { AppProvider, useApp } from './src/lib/store';
import { api, unreachable } from './src/lib/api';
import {
  AIRequest,
  AppAction,
  CookCommand,
  Creator,
  Recipe,
  RecipeInput,
  Screen,
  StudioMode,
} from './src/lib/types';
import { LanguagePreference } from './src/lib/i18n/core';
import { color, font, maxFontScale, radius, s, shadow } from './src/lib/theme';
import { onPageBack, pushPage, replacePage } from './src/lib/webHistory';
import {
  cookbookPath,
  linkHosts,
  linkTo,
  pagePath,
  parseRoute,
  pressedInApp,
  recipePath,
} from './src/lib/routes';
import { chunk } from './src/lib/chunk';
import { installErrorReporting, reportError, track } from './src/lib/telemetry';
import { cachedRecipe, rememberRecipe } from './src/lib/offline';
import {
  Avatar,
  Button,
  Dialog,
  Empty,
  FadeIn,
  FoodImage,
  GlassSurface,
  IconButton,
  Press,
  SearchBar,
  SheetHost,
  TopBanners,
  UnderSheets,
  frost,
  native,
  passThrough,
  useChrome,
} from './src/components/ui';
import { AnnouncementBanner } from './src/components/Announcement';
import { AppToast } from './src/components/AppToast';
import { UpdateBanner } from './src/components/AppUpdates';
import { haptic } from './src/lib/haptics';
import { AuthDialog } from './src/components/AuthDialog';
import { OfflineBanner } from './src/components/OfflineBanner';
import { finishWelcome, useWelcomePending } from './src/lib/welcome';
import { useGoogleReturn } from './src/lib/auth/googleRedirect';
import { usePushNotifications } from './src/lib/usePushNotifications';
import { BrandMark, BrandWordmark } from './src/components/Brand';
import { RecipeDetail } from './src/components/RecipeDetail';
import { RecipeStart } from './src/components/RecipeStart';
import { useSousChefDock } from './src/components/sousChefDock';
import { SousChef } from './src/components/SousChef';
import { Discover } from './src/screens/Discover';
import { Splash } from './src/components/Splash';
import { Cookbooks, Pantry, Planner } from './src/screens/Kitchen';
import { CookbookPage } from './src/screens/CookbookPage';
import { Community, CreatorDialog, Profile } from './src/screens/Profile';
// Loaded the first time they're needed, so a first visit (often a shared recipe) doesn't download
// them: on the web each becomes a chunk of its own (Metro splits import()), fetched from the
// content-hashed /_expo/static/js/web/ path the Worker caches for good; phones have them in the app.
// A deploy replaces the chunks; chunk() (src/lib/chunk.ts) reloads a tab that misses one.
const Admin = lazy(chunk(() => import('./src/screens/admin').then((m) => ({ default: m.Admin }))));
const Editor = lazy(
  chunk(() => import('./src/screens/Editor').then((m) => ({ default: m.Editor }))),
);
const RecipeStudio = lazy(
  chunk(() => import('./src/components/RecipeStudio').then((m) => ({ default: m.RecipeStudio }))),
);
const onboarding = chunk(() => import('./src/components/Onboarding'));
const Welcome = lazy(() => onboarding().then((m) => ({ default: m.Welcome })));
const KitchenSetup = lazy(() => onboarding().then((m) => ({ default: m.KitchenSetup })));
// Uncaught errors and unhandled rejections are reported from the start (telemetry.ts).
installErrorReporting();
const tabs = [
  { key: 'discover', title: 'Discover', icon: House },
  { key: 'explore', title: 'Explore', icon: Compass },
  { key: 'create', title: 'Create a recipe', icon: Plus },
  { key: 'saved', title: 'Saved', icon: Bookmark },
  { key: 'profile', title: 'My kitchen', icon: UserRound },
] as const;
const navigation = [
  { key: 'discover', title: 'Discover', icon: House },
  { key: 'explore', title: 'Explore recipes', icon: Compass },
  { key: 'saved', title: 'My cookbooks', icon: Bookmark },
  { key: 'planner', title: 'Meal planner', icon: CalendarDays },
  { key: 'pantry', title: 'My pantry', icon: Leaf },
  { key: 'community', title: 'Community', icon: Users },
] as const;
const screenNames: Record<Screen, string> = {
  discover: 'Discover',
  explore: 'Explore recipes',
  saved: 'My cookbooks',
  planner: 'Meal planner',
  pantry: 'My pantry',
  profile: 'My kitchen',
  create: 'Share a recipe',
  community: 'Community',
  admin: 'Admin console',
};
const tabScreens: Screen[] = ['discover', 'explore', 'create', 'saved', 'profile'];
const DESKTOP_HEADER = 84;
function Shell({ onReady }: { onReady: (ready: boolean) => void }) {
  const { t: tr, locale, setLanguage } = useI18n();
  const app = useApp();
  useEffect(() => {
    if (!app.loading) onReady(true);
  }, [app.loading, onReady]);
  useGoogleReturn();
  const { desktop, compact, gutter, top, insets, width, webPage } = useChrome();
  const [screen, setScreen] = useState<Screen>('discover');
  const [selected, setSelected] = useState<Recipe | null>(null);
  // A public cookbook's page (/cookbooks/<id>), shown in place of the screen until one is chosen.
  const [cookbook, setCookbook] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS === 'web')
      document.title = `${selected ? selected.title : tr(screenNames[screen])} · Savorly`;
  }, [screen, selected, locale, tr]);
  const [origin, setOrigin] = useState<Screen>('profile');
  const [query, setQuery] = useState('');
  const [creator, setCreator] = useState<Creator | null>(null);
  const [editor, setEditor] = useState<Recipe | RecipeInput | undefined>();
  const [editorKey, setEditorKey] = useState(0);
  const [ask, setAsk] = useState<AIRequest | null>(null);
  const [askKey, setAskKey] = useState(0);
  const [activity, setActivity] = useState(false);
  // The activity sheet's recipes: the newest from followed kitchens, asked for each time it opens.
  // Without an answer, the ones among the recipes the app already has.
  const [asked, setAsked] = useState<Recipe[] | 'failed' | null>(null);
  const openActivity = () => {
    setAsked(null);
    setActivity(true);
  };
  const followsSomeone = !!app.user && app.library.followingIds.length > 0;
  useEffect(() => {
    if (!activity || !followsSomeone) return;
    let live = true;
    api<Recipe[]>('/recipes?following=true&limit=8')
      .then((recipes) => live && setAsked(recipes))
      .catch(() => live && setAsked('failed'));
    return () => {
      live = false;
    };
  }, [activity, followsSomeone]);
  const followed =
    asked === 'failed'
      ? app.recipes.filter((r) => app.library.followingIds.includes(r.author.id))
      : asked;
  // Each explicit start counts, so Speak or Scan reaches a sous-chef that is already open. A start
  // from a screen's prompt (the home's ideas, the planner) carries the message to send.
  const [studio, setStudio] = useState<{ mode: StudioMode; n: number; message?: string } | null>(
    null,
  );
  // Minimized keeps the conversation (and any live voice) while the user looks at the app.
  const [studioHidden, setStudioHidden] = useState(false);
  const [studioLive, setStudioLive] = useState(false);
  const [cookingStep, setCookingStep] = useState<number | null>(null);
  const [cookCommand, setCookCommand] = useState<CookCommand | null>(null);
  const [pendingStudio, setPendingStudio] = useState<{
    mode: StudioMode;
    message?: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const welcoming = useWelcomePending();
  // Signing in, from the welcome or anywhere else, counts as having been welcomed.
  useEffect(() => {
    if (app.user && welcoming) finishWelcome();
  }, [app.user, welcoming]);
  const startStudio = (mode: StudioMode, message?: string) => {
    if (!app.user) {
      setPendingStudio({ mode, message });
      app.setAuthOpen(true);
    } else {
      track('studio_start', { mode });
      setStudio((old) => ({ mode, n: (old?.n || 0) + 1, message }));
      setStudioHidden(false);
    }
  };
  useEffect(() => {
    if (app.user && pendingStudio) {
      track('studio_start', { mode: pendingStudio.mode });
      setStudio((old) => ({ ...pendingStudio, n: (old?.n || 0) + 1 }));
      setStudioHidden(false);
      setPendingStudio(null);
    }
  }, [app.user, pendingStudio]);
  useEffect(() => {
    if (!app.user) setStudio(null);
  }, [app.user]);
  useEffect(() => {
    if (!app.authOpen && !app.user) setPendingStudio(null);
  }, [app.authOpen, app.user]);
  const scroll = useRef<ScrollView>(null);
  // A desktop browser opens a recipe as a page over the screen it came from, which stays mounted
  // under it: while it's open, that screen is hidden from screen readers and the keyboard.
  const covered = webPage && !!selected;
  useEffect(() => {
    const node = (
      scroll.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null
    )?.getScrollableNode?.();
    if (Platform.OS === 'web' && node) node.inert = covered;
  }, [covered]);
  const scrollY = useRef(new Animated.Value(0)).current;
  const [headerHeight, setHeaderHeight] = useState(0);
  const [pastHeader, setPastHeader] = useState(false);
  // A new page starts at the top, and so does what follows the scroll: the event a jump sends can
  // be dropped (scroll events are throttled), which left the status bar's shadow, and the home's
  // dark header, as the last page had them.
  const toTop = useCallback(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    scrollY.setValue(0);
    setPastHeader(false);
  }, [scrollY]);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    haptic.soft();
    setRefreshing(true);
    try {
      await Promise.all([app.refreshRecipes(), app.user ? app.refreshPrivate() : null]);
    } catch (e) {
      app.notify((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const go = (next: Screen) => {
    if (!tabScreens.includes(next) && tabScreens.includes(screen)) setOrigin(screen);
    // On the web the sidebar stays usable beside an open recipe, so moving on closes it.
    setSelected(null);
    setCookingStep(null);
    setCookbook(null);
    setScreen(next);
    setQuery('');
    if (next === 'create') {
      setEditor(undefined);
      setEditorKey((v) => v + 1);
    }
    toTop();
    pushPage(pagePath(next));
  };
  // Every "create" entry point opens the Add a recipe sheet; writing by hand is one of its choices.
  const navigate = (next: Screen) => (next === 'create' ? setCreating(true) : go(next));
  const create = (choice: StudioMode | 'write') => {
    setCreating(false);
    if (choice === 'write') go('create');
    // Same tick, so the shared sheet morphs from the menu straight into the studio.
    else startStudio(choice);
  };
  // Where a recipe is opened from, for the recipe_open event: the screen, or a search on it.
  const place = useRef({ screen, query, cookbook });
  useEffect(() => {
    place.current = { screen, query, cookbook };
  }, [screen, query, cookbook]);
  /**
   * Shows a recipe. `history`: give it a history entry (/recipes/<id>) on the web. `from`: what
   * opened it, for analytics; by default the screen it was opened on; null records nothing (the
   * browser's Back and Forward return to a recipe rather than open it).
   */
  const open = useCallback((recipe: Recipe, history = true, from?: string | null) => {
    setCreator(null);
    setSelected(recipe);
    setCookingStep(null);
    setCookCommand(null);
    if (history) pushPage(recipePath(recipe.id));
    rememberRecipe(recipe);
    const here = place.current;
    if (from !== null)
      track('recipe_open', {
        recipeId: recipe.id,
        from: from ?? (here.cookbook ? 'cookbook' : here.query ? 'search' : here.screen),
      });
  }, []);
  const notify = app.notify;
  // Opens a recipe known by its id. Without a connection, the copy this device kept opens instead.
  const openById = useCallback(
    (id: string, from: string | null, history = true) =>
      api<Recipe>(`/recipes/${encodeURIComponent(id)}`)
        .then((recipe) => {
          open(recipe, history, from);
          return true;
        })
        .catch(async (e: Error) => {
          const kept = unreachable(e) ? await cachedRecipe(id) : null;
          if (!kept) {
            notify(e.message);
            return false;
          }
          open(kept, history, from);
          notify('Showing the copy saved on this device.');
          return true;
        }),
    [open, notify],
  );
  const openCookbook = useCallback(
    (id: string, history = true) => {
      setSelected(null);
      setCookingStep(null);
      setCookbook(id);
      toTop();
      if (history) pushPage(cookbookPath(id));
    },
    [toTop],
  );
  const closeCookbook = () => {
    setCookbook(null);
    toTop();
    replacePage(pagePath(screen));
  };
  const close = () => {
    setSelected(null);
    setCookingStep(null);
    replacePage(cookbook ? cookbookPath(cookbook) : pagePath(screen));
  };
  // Addresses: the web app's own (on load, and Back and Forward between its pages) and, on phones,
  // links that open the app. routes.ts reads every form, including the older /?recipe=<id>.
  useEffect(() => {
    const handle = (url: string, visit: boolean) => {
      const route = parseRoute(url, Platform.OS === 'web' ? undefined : linkHosts);
      if (!route) return;
      if (route.type === 'recipe') {
        // Older links take the recipe's own address, in place of theirs.
        if (route.legacy) replacePage(recipePath(route.id));
        void openById(route.id, visit ? 'link' : null, false);
      } else if (route.type === 'cookbook') openCookbook(route.id, false);
      else {
        // Another page (not just a recipe closing over the same one) starts at the top.
        const was = place.current;
        if (was.cookbook || (route.screen && route.screen !== was.screen)) toTop();
        setSelected(null);
        setCookbook(null);
        if (route.screen) setScreen(route.screen);
      }
    };
    if (Platform.OS === 'web') {
      handle(window.location.href, true);
      return onPageBack(() => handle(window.location.href, false));
    }
    void Linking.getInitialURL().then((url) => url && handle(url, true));
    const sub = Linking.addEventListener('url', ({ url }) => handle(url, true));
    return () => sub.remove();
  }, [openById, openCookbook, toTop]);
  const openSousChef = () => (studio ? setStudioHidden(false) : startStudio('chat'));
  // The screens' sous-chef cards open the same conversation, with their prompt as the message.
  const askSousChef = (message?: string) =>
    message ? startStudio('chat', message) : openSousChef();
  const recipeAt = (id: string) => api<Recipe>(`/recipes/${encodeURIComponent(id)}`);
  const act = (action: AppAction) => {
    if (action.type === 'set_language') void setLanguage(action.language as LanguagePreference);
    if (action.type === 'go_to') {
      if (selected) close();
      go(action.page);
    }
    if (action.type === 'cooking_step') setCookCommand({ step: action.step, n: Date.now() });
    if (action.type === 'start_timer') setCookCommand({ timerFrom: Date.now(), n: Date.now() });
    if (action.type === 'open_recipe' || action.type === 'start_cooking')
      void openById(action.recipeId, 'sous_chef').then((opened) => {
        if (opened && action.type === 'start_cooking')
          setCookCommand({ step: action.step || 1, n: Date.now() });
      });
  };
  usePushNotifications(act);
  // Cooking mode starting, once per cooking session.
  const cooking = cookingStep !== null;
  const selectedId = selected?.id;
  useEffect(() => {
    if (cooking && selectedId) track('cook_start', { recipeId: selectedId });
  }, [cooking, selectedId]);
  // The sous-chef may have changed what's on screen: lists, cookbooks, or the open recipe.
  const studioChanged = () => {
    void app.refreshPrivate().catch(() => {});
    void app.refreshRecipes().catch(() => {});
    if (selected)
      void recipeAt(selected.id)
        .then((r) => setSelected((s) => (s?.id === r.id ? r : s)))
        .catch(() => setSelected((s) => (s?.id === selected.id ? null : s)));
  };
  const ai = (request: AIRequest) => {
    const enabled =
      request.kind === 'video'
        ? app.capabilities?.videoAI
        : request.kind === 'image'
          ? app.capabilities?.imageAI
          : app.capabilities?.textAI;
    // Automatic requests ask for sign-in in the originating press event, before mounting a job.
    if (request.prompt && enabled && !app.requireUser()) return;
    setAsk(request);
    setAskKey((v) => v + 1);
  };
  const edit = (r: Recipe | RecipeInput) => {
    setSelected(null);
    setCookbook(null);
    setAsk(null);
    setEditor(r);
    setEditorKey((v) => v + 1);
    setScreen('create');
    toTop();
    pushPage(pagePath('create'));
  };
  const account = () => (app.user ? navigate('profile') : app.setAuthOpen(true));
  const activeTab = tabScreens.includes(screen) ? screen : origin;
  const tabIndex = tabs.findIndex((t) => t.key === activeTab);
  const tabSlide = useState(() => new Animated.Value(tabIndex))[0];
  useEffect(() => {
    Animated.spring(tabSlide, {
      toValue: tabIndex,
      damping: 20,
      stiffness: 240,
      mass: 0.8,
      useNativeDriver: native,
    }).start();
  }, [tabIndex, tabSlide]);
  const barWidth = Math.min(width - 32, 400);
  const dock = useSousChefDock();
  const studioOpen = !!studio && !studioHidden;
  // The launcher gives its corner to the desktop panel and to a minimized pill. A sheet only covers
  // it, so it's still there as the sheet slides away.
  const launcher = !studio || (dock.panel ? studioHidden && !studioLive : !studioHidden);
  // Discover and Explore share one component (and its filters), so they share one page key.
  const page = screen === 'explore' ? 'discover' : screen;
  // Every page but Discover rises in; Discover's black header must stay put under the status bar.
  const pages = (
    <>
      {(screen === 'discover' || screen === 'explore') && (
        <Discover
          explore={screen === 'explore'}
          query={query}
          onQuery={setQuery}
          onOpen={open}
          navigate={navigate}
          onCreator={setCreator}
          onAsk={askSousChef}
          onActivity={openActivity}
          onAccount={account}
          onHeader={setHeaderHeight}
        />
      )}
      {screen === 'saved' && <Cookbooks onOpen={open} navigate={navigate} />}
      {screen === 'planner' && <Planner onOpen={open} onAsk={askSousChef} />}
      {screen === 'pantry' && <Pantry onOpen={open} onAsk={askSousChef} />}
      {screen === 'create' && (
        <Suspense fallback={<PageLoading />}>
          <Editor
            key={editorKey}
            initial={editor}
            onAI={ai}
            onPublished={(r) => {
              navigate('profile');
              if (r.id) open(r);
            }}
          />
        </Suspense>
      )}
      {screen === 'profile' && <Profile onOpen={open} navigate={navigate} onRecipe={edit} />}
      {screen === 'community' && <Community onCreator={setCreator} />}
      {screen === 'admin' && (
        <Suspense fallback={<PageLoading />}>
          <Admin onOpen={open} />
        </Suspense>
      )}
    </>
  );
  const darkTop = compact && screen === 'discover' && !cookbook && !app.error;
  // The status bar keeps the black header's color until the light sheet's rounded top has passed
  // under it, then eases to the page color so scrolled content never sits under a black band.
  // The header starts at the top of the scroll content, and the sheet overlaps its last radius.xl.
  // It stays an animated value throughout: a natively driven prop swapped for a plain number keeps
  // its last animated value on screen.
  const sheetTop = headerHeight - radius.xl;
  const measured = !app.loading && headerHeight > 0;
  const inkTop = scrollY.interpolate({
    inputRange: measured ? [sheetTop, sheetTop + radius.xl] : [0, 1],
    outputRange: measured ? [1, 0] : [1, 1],
    extrapolate: 'clamp',
  });
  // Once content scrolls under the status bar, the bar lifts on a soft shadow, so the content
  // tucks under a surface instead of being sliced off (or hazed over, on dark photos) at its edge.
  const settled = darkTop && !app.loading && headerHeight ? sheetTop + radius.xl : 0;
  const lifted = scrollY.interpolate({
    inputRange: [settled, settled + 24],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  // The desktop header floats over the page, and frosts over as content scrolls under it.
  const frosted = scrollY.interpolate({
    inputRange: [0, 24],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
    useNativeDriver: native,
    listener: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      const past = e.nativeEvent.contentOffset.y > sheetTop + radius.xl / 2;
      if (past !== pastHeader) setPastHeader(past);
    },
  });
  const feed = (screen === 'discover' || screen === 'explore') && !cookbook;
  // Phones and tablets slide the recipe over everything; a desktop browser opens it as a page in
  // the content area, under the header and beside the sidebar.
  const recipePage = selected && (
    <RecipeDetail
      key={selected.id}
      recipe={selected}
      onClose={close}
      onCreator={(c) => {
        close();
        setCreator(c);
      }}
      onEdit={edit}
      onOpen={open}
      onAI={ai}
      onAsk={openSousChef}
      onCooking={setCookingStep}
      cookCommand={cookCommand}
    />
  );
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, paddingTop: desktop ? insets.top : 0 }}>
      <StatusBar
        barStyle={darkTop && (!pastHeader || app.loading) ? 'light-content' : 'dark-content'}
        translucent
        backgroundColor="transparent"
      />
      <View
        aria-hidden={!!selected && !webPage}
        importantForAccessibility={selected && !webPage ? 'no-hide-descendants' : 'auto'}
        style={{ flex: 1, flexDirection: 'row' }}
      >
        {desktop && (
          <View
            style={{
              width: 248,
              backgroundColor: color.white,
              borderRightWidth: StyleSheet.hairlineWidth,
              borderColor: color.line,
              paddingHorizontal: 16,
              paddingTop: 28,
              paddingBottom: 20,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tr('Savorly home')}
              onPress={() => navigate('discover')}
              style={[s.row, { gap: 10, marginLeft: 10, marginBottom: 28 }]}
            >
              <BrandMark size={42} />
              {Platform.OS === 'web' && <BrandWordmark />}
            </Pressable>
            <View style={{ gap: 4 }}>
              {navigation.map((item) => (
                <NavItem
                  key={item.key}
                  title={tr(item.title)}
                  icon={item.icon}
                  active={screen === item.key}
                  onPress={() => navigate(item.key)}
                />
              ))}
              {app.user?.admin && (
                <NavItem
                  title={tr('Admin console')}
                  icon={ShieldCheck}
                  active={screen === 'admin'}
                  onPress={() => navigate('admin')}
                />
              )}
            </View>
            <View style={{ flex: 1, minHeight: 40 }} />
            <View
              style={{
                backgroundColor: color.ink,
                borderRadius: radius.lg,
                padding: 18,
                gap: 8,
                marginBottom: 18,
              }}
            >
              <Text style={[s.h3, { color: color.white }]}>{tr('Something worth sharing?')}</Text>
              <Text
                style={[s.small, { color: color.onInk, fontFamily: font.medium, lineHeight: 18 }]}
              >
                {tr('Your next recipe could be someone’s new favorite.')}
              </Text>
              <Button
                title={tr('Share a recipe')}
                icon={Plus}
                small
                variant="inverse"
                onPress={() => navigate('create')}
                style={{ marginTop: 6 }}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tr('Open my kitchen')}
              onPress={() => navigate('profile')}
              style={[s.row, { gap: 10, paddingHorizontal: 6 }]}
            >
              <Avatar name={app.user?.name || ''} uri={app.user?.avatar} size={38} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[s.h3, { fontSize: 14 }]}>
                  {app.user?.name || tr('Your kitchen')}
                </Text>
                <Text style={s.small}>{app.user ? tr('My kitchen') : tr('Sign in to join')}</Text>
              </View>
              <ChevronRight size={16} color={color.muted} />
            </Pressable>
          </View>
        )}
        <View style={{ flex: 1 }}>
          {desktop && (
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 10,
                height: DESKTOP_HEADER,
                paddingHorizontal: gutter,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: color.line,
              }}
            >
              {/* A recipe page opens below the header, so the feed must not show through it then. */}
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  { pointerEvents: 'none' },
                  webPage && recipePage
                    ? { backgroundColor: color.bg }
                    : [
                        {
                          opacity: frosted,
                          backgroundColor: native ? color.bg : 'rgba(244,244,244,0.72)',
                        },
                        frost(24),
                      ],
                ]}
              />
              <View style={{ flex: 1 }}>
                <View style={{ maxWidth: 560, flexDirection: 'row' }}>
                  <SearchBar
                    value={query}
                    placeholder={tr('Search recipes, ingredients, cooks…')}
                    onChangeText={(v) => {
                      setQuery(v);
                      if (selected) close();
                      if (screen !== 'discover' && screen !== 'explore') setScreen('explore');
                    }}
                  />
                </View>
              </View>
              <Button
                title={tr('Create recipe')}
                icon={Plus}
                small
                onPress={() => navigate('create')}
              />
              <IconButton icon={Bell} label={tr('Kitchen activity')} onPress={openActivity} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={app.user ? tr('My profile') : tr('Sign in')}
                onPress={account}
              >
                <Avatar name={app.user?.name || ''} uri={app.user?.avatar} size={44} />
              </Pressable>
            </View>
          )}
          <Animated.ScrollView
            ref={scroll}
            aria-hidden={covered}
            onScroll={onScroll}
            scrollEventThrottle={16}
            refreshControl={
              feed && native && !app.loading && !app.error ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void refresh()}
                  tintColor={darkTop ? color.white : color.ink}
                  colors={[color.ink]}
                />
              ) : undefined
            }
            style={{
              flex: 1,
              marginTop: compact ? insets.top : 0,
              // Pulling down past the black header shows more black (and the refresh spinner),
              // never a band of page color; once scrolled past it the page color returns.
              backgroundColor: darkTop && !pastHeader ? color.ink : undefined,
            }}
            contentContainerStyle={{
              paddingHorizontal: gutter,
              paddingTop: desktop ? DESKTOP_HEADER + top : top,
              // Clears the tab bar and the sous-chef button above it, or in a desktop browser its
              // panel while it's out, so everything on the page can still scroll into view beside it.
              paddingBottom: Math.max(
                compact ? Math.max(16, insets.bottom) + 170 : 100,
                studioOpen && dock.panel ? dock.bottom + dock.panel.height + 24 : 0,
              ),
              maxWidth: 1600,
              width: '100%',
              alignSelf: 'center',
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={desktop}
          >
            {compact && !tabScreens.includes(screen) && (
              <View style={{ marginBottom: 18, alignSelf: 'flex-start' }}>
                <IconButton icon={ArrowLeft} label={tr('Back')} onPress={() => navigate(origin)} />
              </View>
            )}
            {/* The splash covers loading; the page fills in behind it. */}
            {app.loading ? null : app.error ? (
              <Empty
                title={tr('Let’s reconnect your kitchen')}
                text={tr(app.error)}
                action={() => void app.load()}
                actionTitle={tr('Try again')}
              />
            ) : cookbook ? (
              <FadeIn key={`cookbook:${cookbook}`} offset={12}>
                <View testID="cookbook-page">
                  <CookbookPage
                    key={cookbook}
                    id={cookbook}
                    onOpen={(recipe) => open(recipe, true, 'cookbook')}
                    onClose={closeCookbook}
                    onCreator={setCreator}
                  />
                </View>
              </FadeIn>
            ) : page === 'discover' ? (
              pages
            ) : (
              <FadeIn key={page} offset={12}>
                {pages}
              </FadeIn>
            )}
          </Animated.ScrollView>
          {webPage && recipePage && (
            <View
              // Above the header, so cooking mode inside it covers the whole window.
              style={{
                position: 'absolute',
                top: DESKTOP_HEADER,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 20,
              }}
            >
              {recipePage}
            </View>
          )}
          {compact && (
            <View
              style={[
                passThrough,
                {
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: Math.max(16, insets.bottom),
                  alignItems: 'center',
                },
              ]}
            >
              <GlassSurface
                accessibilityRole="tablist"
                dark
                // Keeps the capsule reading as ink over light screens, not mid-grey.
                tint="rgba(13,13,13,0.55)"
                flat={[
                  {
                    backgroundColor: native ? color.ink : 'rgba(13,13,13,0.9)',
                    boxShadow: shadow.float,
                  },
                  frost(20),
                ]}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderRadius: radius.pill,
                  height: 70,
                  paddingHorizontal: 9,
                  width: barWidth,
                }}
              >
                {/* One soft pill glides to the active tab, passing under the create button. */}
                <Animated.View
                  style={{
                    position: 'absolute',
                    left: 9,
                    width: 56,
                    height: 52,
                    borderRadius: 26,
                    backgroundColor: 'rgba(255,255,255,0.14)',
                    transform: [
                      { translateX: Animated.multiply(tabSlide, (barWidth - 18 - 56) / 4) },
                    ],
                  }}
                />
                {tabs.map(({ key, title, icon: Icon }) => {
                  const on = activeTab === key;
                  return (
                    <Press
                      key={key}
                      accessibilityRole="button"
                      accessibilityLabel={tr(title)}
                      accessibilityState={{ selected: on }}
                      onPress={() => {
                        if (key === 'create') haptic.tap();
                        else if (!on) haptic.select();
                        navigate(key);
                      }}
                      scale={0.88}
                      style={{
                        width: 56,
                        height: 52,
                        borderRadius: 26,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: key === 'create' ? color.white : 'transparent',
                      }}
                    >
                      <Icon
                        size={key === 'create' ? 24 : 22}
                        color={key === 'create' ? color.ink : on ? color.white : '#7D7D7D'}
                        strokeWidth={key === 'create' || on ? 2.4 : 1.8}
                      />
                    </Press>
                  );
                })}
              </GlassSurface>
            </View>
          )}
        </View>
      </View>
      {compact && insets.top > 0 && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: insets.top,
            backgroundColor: color.bg,
            boxShadow: '0px 1px 0px rgba(13,13,13,0.05), 0px 8px 22px rgba(13,13,13,0.08)',
            opacity: lifted,
            pointerEvents: 'none',
          }}
        />
      )}
      {compact && insets.top > 0 && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: insets.top,
            backgroundColor: color.bg,
          }}
        >
          {darkTop && (
            <Animated.View
              style={[StyleSheet.absoluteFill, { backgroundColor: color.ink, opacity: inkTop }]}
            />
          )}
        </View>
      )}
      {/* The sous-chef is one tap away everywhere; recipe pages, sheets and cooking cover it. In a
          desktop browser its panel pops out of here and folds back into it, or into a pill while
          voice keeps going; elsewhere a minimized sheet leaves its own pill. */}
      {launcher && cookingStep === null && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Ask your sous-chef')}
          onPress={() => {
            haptic.tap();
            openSousChef();
          }}
          scale={0.9}
          style={{
            position: 'absolute',
            right: dock.right,
            bottom: dock.bottom,
            width: 58,
            height: 58,
            borderRadius: 29,
            backgroundColor: color.ink,
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: shadow.float,
          }}
        >
          <Sparkles size={24} color={color.white} strokeWidth={2} />
        </Press>
      )}
      <TopBanners>
        {app.offline && (
          <OfflineBanner busy={app.reconnecting} onRetry={() => void app.reconnect()} />
        )}
        <AnnouncementBanner announcement={app.capabilities?.announcement} />
        <UpdateBanner />
      </TopBanners>
      <AppToast hidden={!!selected} />
      <AuthDialog />
      <RecipeStart
        visible={creating}
        onClose={() => setCreating(false)}
        onStart={create}
        onImported={edit}
      />
      {!webPage && recipePage}
      {studio && app.user && (
        <Suspense fallback={null}>
          <RecipeStudio
            start={studio}
            hidden={studioHidden}
            onHide={setStudioHidden}
            onLive={setStudioLive}
            context={{
              screen,
              title: tr(screenNames[screen]),
              recipe: selected ? { id: selected.id, title: selected.title } : null,
              cookingStep: selected ? cookingStep : null,
            }}
            onAction={act}
            onChanged={studioChanged}
            onClose={() => {
              setStudio(null);
              setStudioHidden(false);
            }}
            onRecipe={(recipe) => open(recipe, true, 'sous_chef')}
          />
        </Suspense>
      )}
      {creator && (
        <CreatorDialog
          creator={creator}
          onClose={() => setCreator(null)}
          onOpen={(recipe) => open(recipe, true, 'creator')}
          onCookbook={(id) => {
            setCreator(null);
            openCookbook(id);
          }}
        />
      )}
      {ask && <SousChef key={askKey} request={ask} onClose={() => setAsk(null)} onRecipe={edit} />}
      {welcoming && !app.loading && !app.error && !app.user && !selected && (
        <Suspense fallback={<Cover />}>
          <Welcome onDone={finishWelcome} />
        </Suspense>
      )}
      {app.user?.onboarded === false && (
        <Suspense fallback={<Cover />}>
          <KitchenSetup />
        </Suspense>
      )}
      <Dialog
        visible={activity}
        onClose={() => setActivity(false)}
        title={tr('From kitchens you follow')}
      >
        {app.user && app.library.followingIds.length && followed?.length !== 0 ? (
          followed ? (
            followed.slice(0, 8).map((r) => (
              <Pressable
                key={r.id}
                {...linkTo(recipePath(r.id))}
                accessibilityRole={Platform.OS === 'web' ? 'link' : 'button'}
                onPress={(e) => {
                  if (!pressedInApp(e)) return;
                  setActivity(false);
                  open(r, true, 'activity');
                }}
                style={[s.row, { gap: 12 }]}
              >
                <FoodImage uri={r.image} style={{ width: 52, height: 52, borderRadius: 16 }} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={s.h3}>
                    {r.title}
                  </Text>
                  <Text style={s.small}>{tr('New from {{v0}}', { v0: r.author.name })}</Text>
                </View>
                <ChevronRight size={18} color={color.soft} />
              </Pressable>
            ))
          ) : (
            <ActivityIndicator color={color.ink} style={{ paddingVertical: 24 }} />
          )
        ) : (
          <Empty
            title={tr('Find your kind of cooks')}
            text={tr('Follow a few kitchens and their latest recipes will land here.')}
            icon={Users}
            action={() => {
              setActivity(false);
              navigate('community');
            }}
            actionTitle={tr('Meet the community')}
          />
        )}
      </Dialog>
    </View>
  );
}
function NavItem({
  title,
  icon: Icon,
  active,
  onPress,
}: {
  title: string;
  icon: typeof House;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        minHeight: 46,
        borderRadius: radius.pill,
        backgroundColor: active ? color.ink : hovered ? color.bg : 'transparent',
      })}
    >
      <Icon size={19} strokeWidth={active ? 2.2 : 1.8} color={active ? color.white : color.muted} />
      <Text
        maxFontSizeMultiplier={maxFontScale}
        style={{
          fontFamily: active ? font.bold : font.semibold,
          fontSize: 14,
          color: active ? color.white : color.ink,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
// While a screen loaded on first use (the editor, the admin console) arrives.
function PageLoading() {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 80 }}>
      <ActivityIndicator color={color.ink} />
    </View>
  );
}
// Holds a full-screen flow's place while it arrives, so the page under it doesn't flash.
function Cover() {
  return <View style={[StyleSheet.absoluteFill, { zIndex: 500, backgroundColor: color.bg }]} />;
}
function FailureMessage() {
  const { t: tr } = useI18n();
  return (
    <>
      <Text style={s.h2}>{tr('Something needs a little attention.')}</Text>
      <Text style={s.muted}>{tr('Please reopen Savorly to return to your kitchen.')}</Text>
    </>
  );
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onReady: (ready: boolean) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(error, { componentStack: info.componentStack ?? undefined });
    this.props.onReady(true);
  }
  render() {
    if (this.state.failed)
      return (
        <View style={{ flex: 1, justifyContent: 'center', padding: 40, backgroundColor: color.bg }}>
          <FailureMessage />
        </View>
      );
    return this.props.children;
  }
}
export default function App() {
  const [ready, setReady] = useState(false);
  const [loaded, error] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });
  // Keep the same overlay mounted across fonts, language restoration and data loading.
  // Replacing a splash at each stage restarts its animation and flashes the mascot.
  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <SafeAreaProvider>
        <I18nProvider fallback={null}>
          {(loaded || error) && (
            <ErrorBoundary onReady={setReady}>
              <AppProvider>
                <UnderSheets style={{ flex: 1 }}>
                  <Shell onReady={setReady} />
                </UnderSheets>
                {/* Beside the app rather than in it, so the app can be hidden from screen readers
                    while a sheet covers it. */}
                <SheetHost />
              </AppProvider>
            </ErrorBoundary>
          )}
        </I18nProvider>
      </SafeAreaProvider>
      <Splash done={ready} />
    </View>
  );
}
