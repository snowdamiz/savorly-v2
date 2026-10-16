import { I18nProvider, useI18n } from './src/lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
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
} from 'lucide-react-native';
import { AppProvider, useApp } from './src/lib/store';
import { api } from './src/lib/api';
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
import { color, font, radius, s, shadow } from './src/lib/theme';
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
  Toast,
  frost,
  native,
  useChrome,
} from './src/components/ui';
import { AnnouncementBanner } from './src/components/Announcement';
import { haptic } from './src/lib/haptics';
import { AuthDialog } from './src/components/AuthDialog';
import { KitchenSetup, Welcome } from './src/components/Onboarding';
import { finishWelcome, useWelcomePending } from './src/lib/welcome';
import { BrandMark } from './src/components/Brand';
import { RecipeDetail } from './src/components/RecipeDetail';
import { RecipeStart } from './src/components/RecipeStart';
import { RecipeStudio } from './src/components/RecipeStudio';
import { SousChef } from './src/components/SousChef';
import { Discover } from './src/screens/Discover';
import { Splash } from './src/components/Splash';
import { Cookbooks, Pantry, Planner } from './src/screens/Kitchen';
import { Editor } from './src/screens/Editor';
import { Community, CreatorDialog, Profile } from './src/screens/Profile';
import { Admin } from './src/screens/admin';
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
function Shell() {
  const { t: tr, locale, setLanguage } = useI18n();
  const app = useApp();
  const { desktop, compact, gutter, top, insets, width } = useChrome();
  const [screen, setScreen] = useState<Screen>('discover');
  useEffect(() => {
    if (Platform.OS === 'web') document.title = `${tr(screenNames[screen])} · Savorly`;
  }, [screen, locale, tr]);
  const [origin, setOrigin] = useState<Screen>('profile');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Recipe | null>(null);
  const [creator, setCreator] = useState<Creator | null>(null);
  const [editor, setEditor] = useState<Recipe | RecipeInput | undefined>();
  const [editorKey, setEditorKey] = useState(0);
  const [ask, setAsk] = useState<AIRequest | null>(null);
  const [askKey, setAskKey] = useState(0);
  const [activity, setActivity] = useState(false);
  const [studioMode, setStudioMode] = useState<StudioMode | null>(null);
  // Minimized keeps a live voice conversation running while the user looks at the app.
  const [studioHidden, setStudioHidden] = useState(false);
  const [cookingStep, setCookingStep] = useState<number | null>(null);
  const [cookCommand, setCookCommand] = useState<CookCommand | null>(null);
  const [pendingStudio, setPendingStudio] = useState<StudioMode | null>(null);
  const [creating, setCreating] = useState(false);
  const welcoming = useWelcomePending();
  // Signing in, from the welcome or anywhere else, counts as having been welcomed.
  useEffect(() => {
    if (app.user && welcoming) finishWelcome();
  }, [app.user, welcoming]);
  const startStudio = (mode: StudioMode) => {
    if (!app.user) {
      setPendingStudio(mode);
      app.setAuthOpen(true);
    } else {
      setStudioMode(mode);
      setStudioHidden(false);
    }
  };
  useEffect(() => {
    if (app.user && pendingStudio) {
      setStudioMode(pendingStudio);
      setPendingStudio(null);
    }
  }, [app.user, pendingStudio]);
  useEffect(() => {
    if (!app.user) setStudioMode(null);
  }, [app.user]);
  useEffect(() => {
    if (!app.authOpen && !app.user) setPendingStudio(null);
  }, [app.authOpen, app.user]);
  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const [headerHeight, setHeaderHeight] = useState(0);
  const [pastHeader, setPastHeader] = useState(false);
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
    setScreen(next);
    setQuery('');
    if (next === 'create') {
      setEditor(undefined);
      setEditorKey((v) => v + 1);
    }
    scroll.current?.scrollTo({ y: 0, animated: false });
    if (Platform.OS === 'web') {
      window.history.pushState({}, '', `/?page=${next}`);
    }
  };
  // Every "create" entry point opens the Add a recipe sheet; writing by hand is one of its choices.
  const navigate = (next: Screen) => (next === 'create' ? setCreating(true) : go(next));
  const create = (choice: StudioMode | 'write') => {
    setCreating(false);
    if (choice === 'write') go('create');
    // Same tick, so the shared sheet morphs from the menu straight into the studio.
    else startStudio(choice);
  };
  const open = (recipe: Recipe, history = true) => {
    setCreator(null);
    setSelected(recipe);
    setCookingStep(null);
    setCookCommand(null);
    if (Platform.OS === 'web' && history) window.history.pushState({}, '', `/?recipe=${recipe.id}`);
  };
  const close = () => {
    setSelected(null);
    setCookingStep(null);
    if (Platform.OS === 'web') window.history.replaceState({}, '', `/?page=${screen}`);
  };
  useEffect(() => {
    const handle = (url: string) => {
      try {
        const u = new URL(url);
        const id = u.searchParams.get('recipe');
        const page = u.searchParams.get('page') as Screen;
        if (id)
          void api<Recipe>(`/recipes/${encodeURIComponent(id)}`)
            .then((r) => open(r, false))
            .catch((e) => app.notify(e.message));
        else {
          setSelected(null);
          if (page && page in screenNames) setScreen(page);
        }
      } catch {}
    };
    if (Platform.OS === 'web') {
      handle(window.location.href);
      const pop = () => handle(window.location.href);
      window.addEventListener('popstate', pop);
      return () => window.removeEventListener('popstate', pop);
    }
    void Linking.getInitialURL().then((url) => url && handle(url));
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, []);
  const openSousChef = () => (studioMode ? setStudioHidden(false) : startStudio('chat'));
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
      void recipeAt(action.recipeId)
        .then((r) => {
          open(r);
          if (action.type === 'start_cooking')
            setCookCommand({ step: action.step || 1, n: Date.now() });
        })
        .catch((e) => app.notify(e.message));
  };
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
    setAsk(request);
    setAskKey((v) => v + 1);
  };
  const edit = (r: Recipe | RecipeInput) => {
    setSelected(null);
    setAsk(null);
    setEditor(r);
    setEditorKey((v) => v + 1);
    setScreen('create');
    scroll.current?.scrollTo({ y: 0, animated: false });
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
          onAI={ai}
          onActivity={() => setActivity(true)}
          onAccount={account}
          onHeader={setHeaderHeight}
        />
      )}
      {screen === 'saved' && <Cookbooks onOpen={open} navigate={navigate} />}
      {screen === 'planner' && <Planner onOpen={open} onAI={ai} />}
      {screen === 'pantry' && <Pantry onOpen={open} onAI={ai} />}
      {screen === 'create' && (
        <Editor
          key={editorKey}
          initial={editor}
          onAI={ai}
          onPublished={(r) => {
            navigate('profile');
            if (r.id) open(r);
          }}
        />
      )}
      {screen === 'profile' && <Profile onOpen={open} navigate={navigate} onRecipe={edit} />}
      {screen === 'community' && <Community onCreator={setCreator} />}
      {screen === 'admin' && <Admin onOpen={open} />}
    </>
  );
  const darkTop = compact && screen === 'discover' && !app.error;
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
  const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
    useNativeDriver: native,
    listener: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      const past = e.nativeEvent.contentOffset.y > sheetTop + radius.xl / 2;
      if (past !== pastHeader) setPastHeader(past);
    },
  });
  const feed = screen === 'discover' || screen === 'explore';
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, paddingTop: desktop ? insets.top : 0 }}>
      <StatusBar
        barStyle={darkTop && (!pastHeader || app.loading) ? 'light-content' : 'dark-content'}
        translucent
        backgroundColor="transparent"
      />
      <View
        aria-hidden={!!selected}
        importantForAccessibility={selected ? 'no-hide-descendants' : 'auto'}
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
              style={[s.row, { marginLeft: 10, marginBottom: 28 }]}
            >
              <BrandMark size={42} />
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
                height: 84,
                paddingHorizontal: gutter,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: color.line,
              }}
            >
              <View style={{ flex: 1 }}>
                <View style={{ maxWidth: 560, flexDirection: 'row' }}>
                  <SearchBar
                    value={query}
                    placeholder={tr('Search recipes, ingredients, cooks…')}
                    onChangeText={(v) => {
                      setQuery(v);
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
              <IconButton
                icon={Bell}
                label={tr('Kitchen activity')}
                onPress={() => setActivity(true)}
              />
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
              paddingTop: top,
              // Clears the tab bar and the sous-chef button above it.
              paddingBottom: compact ? Math.max(16, insets.bottom) + 170 : 100,
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
            ) : page === 'discover' ? (
              pages
            ) : (
              <FadeIn key={page} offset={12}>
                {pages}
              </FadeIn>
            )}
          </Animated.ScrollView>
          {compact && (
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: Math.max(16, insets.bottom),
                alignItems: 'center',
                pointerEvents: 'box-none',
              }}
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
      {/* The sous-chef is one tap away everywhere; recipe pages and sheets cover it. */}
      {!studioMode && (
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
            right: compact ? (width - barWidth) / 2 : 28,
            bottom: compact ? Math.max(16, insets.bottom) + 82 : 28,
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
      <AnnouncementBanner announcement={app.capabilities?.announcement} />
      <Toast message={selected ? '' : app.toast} />
      <AuthDialog />
      <RecipeStart visible={creating} onClose={() => setCreating(false)} onStart={create} />
      {selected && (
        <RecipeDetail
          key={selected.id}
          recipe={selected}
          onClose={close}
          onCreator={(c) => {
            close();
            setCreator(c);
          }}
          onEdit={edit}
          onAI={ai}
          onAsk={openSousChef}
          onCooking={setCookingStep}
          cookCommand={cookCommand}
        />
      )}
      {studioMode && app.user && (
        <RecipeStudio
          initialMode={studioMode}
          hidden={studioHidden}
          onHide={setStudioHidden}
          context={{
            screen,
            recipe: selected ? { id: selected.id, title: selected.title } : null,
            cookingStep: selected ? cookingStep : null,
          }}
          onAction={act}
          onChanged={studioChanged}
          onClose={() => {
            setStudioMode(null);
            setStudioHidden(false);
          }}
          onRecipe={open}
        />
      )}
      {creator && (
        <CreatorDialog creator={creator} onClose={() => setCreator(null)} onOpen={open} />
      )}
      {ask && <SousChef key={askKey} request={ask} onClose={() => setAsk(null)} onRecipe={edit} />}
      {welcoming && !app.loading && !app.error && !app.user && !selected && (
        <Welcome onDone={finishWelcome} />
      )}
      {app.user?.onboarded === false && <KitchenSetup />}
      <Dialog
        visible={activity}
        onClose={() => setActivity(false)}
        title={tr('From kitchens you follow')}
      >
        {app.library.followingIds.length ? (
          app.recipes
            .filter((r) => app.library.followingIds.includes(r.author.id))
            .slice(0, 8)
            .map((r) => (
              <Pressable
                key={r.id}
                accessibilityRole="button"
                onPress={() => {
                  setActivity(false);
                  open(r);
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
      <SheetHost />
      <Splash done={!app.loading} label={tr('Setting the table…')} />
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
        height: 46,
        borderRadius: radius.pill,
        backgroundColor: active ? color.ink : hovered ? color.bg : 'transparent',
      })}
    >
      <Icon size={19} strokeWidth={active ? 2.2 : 1.8} color={active ? color.white : color.muted} />
      <Text
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
function FailureMessage() {
  const { t: tr } = useI18n();
  return (
    <>
      <Text style={s.h2}>{tr('Something needs a little attention.')}</Text>
      <Text style={s.muted}>{tr('Please reopen Savorly to return to your kitchen.')}</Text>
    </>
  );
}
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
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
  const [loaded, error] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });
  // Fonts, then the saved language, then the kitchen: one splash throughout.
  if (!loaded && !error) return <Splash />;
  return (
    <SafeAreaProvider>
      <I18nProvider fallback={<Splash />}>
        <ErrorBoundary>
          <AppProvider>
            <Shell />
          </AppProvider>
        </ErrorBoundary>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
