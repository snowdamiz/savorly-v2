import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform } from 'react-native';
import { api, ApiError, initSession, persistSession, unreachable } from './api';
import { Capabilities, Creator, Grocery, Kitchen, Library, Recipe, User } from './types';
import { NotificationsProvider, useNotify } from './notifications';
import { LibraryContext, LibraryState } from './library';
import { FoodContext, FoodState, foodKey, noFood } from './food';
import { unregisterPush } from './push';
import { Feed, parseFeed } from './feed';
import { forgetKitchen, loadSnapshot, saveSnapshot, worthShowing } from './offline';
import { forgetNarration } from './narration/cache';
import { useI18n } from './i18n';
import { firstDayOfWeek, localDate } from './utils';

/**
 * The library comes with only its newest recipes (saved or written), and the ids, cookbooks and
 * counts whole; the shelves and My kitchen page through the rest (useShelf in shelf.ts). Older
 * servers ignore the limit and send everything, which works the same.
 */
export const LIBRARY_LIMIT = 24;
const emptyLibrary: Library = {
  savedIds: [],
  saves: [],
  collections: [],
  followingIds: [],
  recipes: [],
};
const emptyKitchen: Kitchen = { plans: [], groceries: [], pantry: [] };
type Toggle = { key: 'savedIds' | 'followingIds'; id: string; on: boolean };
const toggled = (l: Library, { key, id, on }: Toggle): Library =>
  l === emptyLibrary || l[key].includes(id) === on
    ? l
    : { ...l, [key]: on ? [...l[key], id] : l[key].filter((v) => v !== id) };
type Check = { id: string; checked: boolean };
const checkedOff = (k: Kitchen, { id, checked }: Check): Kitchen =>
  k.groceries.some((g) => g.id === id && g.checked !== checked)
    ? { ...k, groceries: k.groceries.map((g) => (g.id === id ? { ...g, checked } : g)) }
    : k;
// The same ids keep the same array, so a refresh that changes nothing re-renders no bookmark.
const useSameIds = (ids: string[]) => {
  const key = ids.join('\n');
  return useMemo(() => (key ? key.split('\n') : []), [key]);
};
// The same avoid list, diets and pantry keep the same value, so cards don't re-render for a
// kitchen refresh that changed none of them.
const useSameFood = (food: FoodState) => {
  const key = foodKey(food);
  return useMemo<FoodState>(() => {
    const [groups, terms, diets, pantryCover, household] = JSON.parse(key);
    return { avoid: { groups, terms }, household, diets, pantryCover };
  }, [key]);
};
// A cancelled share sheet or picker isn't a failure to report.
const cancelled = (e: unknown) => (e as Error | undefined)?.name === 'AbortError';
/** A span of days, YYYY-MM-DD to YYYY-MM-DD, both included. */
export type KitchenRange = { from: string; to: string };
/**
 * The days the store loads the kitchen's plans for (GET /kitchen?from&to): the week before this
 * one through four weeks ahead, in weeks that start on `firstDay` (0 Sunday, 1 Monday; see
 * firstDayOfWeek). Six weeks, within the API's 62 days.
 */
export function kitchenWindow(firstDay = 1, today = new Date()): KitchenRange {
  const back = ((today.getDay() - firstDay + 7) % 7) + 7;
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6 * 7 - 1);
  return { from: localDate(from), to: localDate(to) };
}
function useAppState() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [kitchen, setKitchen] = useState<Kitchen>(emptyKitchen);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  // The home's shelves from GET /feed; null while unknown, or where the server has none.
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Showing what the device kept, because the API couldn't be reached.
  const [offline, setOffline] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const notify = useNotify();
  // Weeks start where the cook's locale starts them, so the kitchen's window covers whole weeks.
  const { locale } = useI18n();
  const firstDay = useRef(firstDayOfWeek(locale));
  useEffect(() => {
    firstDay.current = firstDayOfWeek(locale);
  }, [locale]);
  const [kitchenRange, setKitchenRange] = useState<KitchenRange>(() =>
    kitchenWindow(firstDayOfWeek(locale)),
  );
  const [authOpen, setAuthShown] = useState(false);
  // Which side of the sign-in sheet opens: signing in, or creating an account.
  const [authMode, setAuthMode] = useState<'signin' | 'register'>('signin');
  const setAuthOpen = useCallback((open: boolean, mode: 'signin' | 'register' = 'signin') => {
    setAuthMode(mode);
    setAuthShown(open);
  }, []);
  // Saves and follows show at once. Until the server confirms one, it is laid over every library
  // refresh, so a slower request finishing first can't flip it back.
  const pending = useRef(new Map<string, Toggle>());
  const refreshLibrary = useCallback(async () => {
    const l = await api<Library>(`/library?limit=${LIBRARY_LIMIT}`);
    setLibrary([...pending.current.values()].reduce(toggled, l));
  }, []);
  // Grocery check-offs work the same way, and kitchen refreshes are numbered: one that started
  // before another but answers after it is out of date and dropped.
  const checks = useRef(new Map<string, Check>());
  const kitchenAsked = useRef(0);
  const kitchenShown = useRef(0);
  // Plans come for a window of weeks (kitchenRange); a planner showing a week outside it asks
  // GET /kitchen?from&to for that week itself.
  const refreshKitchen = useCallback(async () => {
    const n = ++kitchenAsked.current;
    const range = kitchenWindow(firstDay.current);
    const k = await api<Kitchen>(`/kitchen?from=${range.from}&to=${range.to}`);
    if (n < kitchenShown.current) return;
    kitchenShown.current = n;
    setKitchenRange((old) => (old.from === range.from && old.to === range.to ? old : range));
    setKitchen([...checks.current.values()].reduce(checkedOff, k));
  }, []);
  // Signing out empties the lists, and no refresh already on its way may fill them again.
  const clearPrivate = useCallback(() => {
    kitchenShown.current = ++kitchenAsked.current;
    setLibrary(emptyLibrary);
    setKitchen(emptyKitchen);
  }, []);
  const refreshPrivate = useCallback(async () => {
    await Promise.all([refreshLibrary(), refreshKitchen()]);
  }, [refreshLibrary, refreshKitchen]);
  const refreshCreators = useCallback(async () => {
    setCreators(await api<Creator[]>('/creators'));
  }, []);
  // The home's shelves. Without them (an older server, or the request failed) the home works its
  // shelves out from the recipes it has, so a failure here never fails a refresh.
  const refreshFeed = useCallback(async () => {
    try {
      setFeed(parseFeed(await api<unknown>('/feed?limit=12')));
    } catch {
      // Keep what is shown.
    }
  }, []);
  const refreshRecipes = useCallback(async () => {
    await Promise.all([
      api<Recipe[]>('/recipes').then(setRecipes),
      refreshCreators(),
      refreshFeed(),
    ]);
  }, [refreshCreators, refreshFeed]);
  const refreshUser = useCallback(async () => {
    const u = await api<User>('/me');
    setUser(u);
    await refreshPrivate();
  }, [refreshPrivate]);
  // Who is signed in, without a 401 for guests: GET /session answers { user } either way. Servers
  // from before it (a 404, or an answer without `user`) are asked GET /me, as the app used to.
  const loadSession = useCallback(async () => {
    let session: unknown;
    try {
      session = await api<unknown>('/session');
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    // Without a session (it expired, or ended on another device), the narration kept for cooking
    // offline goes at once, as signing out here takes it (offline.ts): it can be of drafts.
    if (session && typeof session === 'object' && 'user' in session) {
      const signedIn = (session as { user: User | null }).user;
      setUser(signedIn);
      if (signedIn) await refreshPrivate();
      else {
        clearPrivate();
        void forgetNarration();
      }
      return;
    }
    try {
      await refreshUser();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      setUser(null);
      clearPrivate();
      void forgetNarration();
    }
  }, [refreshPrivate, refreshUser, clearPrivate]);
  // Everything a launch loads, once initSession has the device's session.
  const fetchAll = useCallback(async () => {
    await Promise.all([refreshRecipes(), api<Capabilities>('/capabilities').then(setCapabilities)]);
    await loadSession();
  }, [refreshRecipes, loadSession]);
  // Without a connection, the kitchen the device kept (offline.ts) stands in for the error page.
  const restore = useCallback(async () => {
    const snapshot = await loadSnapshot();
    if (!worthShowing(snapshot)) return false;
    setRecipes(snapshot.recipes);
    setCreators(snapshot.creators);
    setFeed(snapshot.feed);
    setUser(snapshot.user);
    if (snapshot.user) {
      setLibrary(snapshot.library ?? emptyLibrary);
      setKitchen(snapshot.kitchen ?? emptyKitchen);
    }
    return true;
  }, []);
  const loadData = useCallback(
    () =>
      initSession()
        .then(fetchAll)
        .then(() => setOffline(false))
        .catch(async (e: Error) => {
          if (unreachable(e) && (await restore())) setOffline(true);
          else setError(e.message);
        })
        .finally(() => setLoading(false)),
    [fetchAll, restore],
  );
  useEffect(() => {
    void loadData();
  }, [loadData]);
  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return loadData();
  }, [loadData]);
  // Asks the API again while the device's copy stays on screen. `quietly`: on its own, so a
  // failure says nothing.
  const trying = useRef(false);
  const reconnect = useCallback(
    async (quietly = false) => {
      if (trying.current) return;
      trying.current = true;
      setReconnecting(true);
      try {
        await fetchAll();
        setOffline(false);
      } catch (e) {
        if (!quietly) notify((e as Error).message);
      } finally {
        trying.current = false;
        setReconnecting(false);
      }
    },
    [fetchAll, notify],
  );
  // So does the connection coming back: the browser says so, or a phone returns to the app.
  useEffect(() => {
    if (!offline) return;
    const retry = () => void reconnect(true);
    if (Platform.OS === 'web') {
      window.addEventListener('online', retry);
      return () => window.removeEventListener('online', retry);
    }
    const sub = AppState.addEventListener('change', (state) => state === 'active' && retry());
    return () => sub.remove();
  }, [offline, reconnect]);
  const signedIn = !!user;
  const requireUser = useCallback(
    (action?: () => void) => {
      if (!signedIn) {
        setAuthOpen(true);
        return false;
      }
      action?.();
      return true;
    },
    [signedIn, setAuthOpen],
  );
  const act = useCallback(
    async (fn: () => Promise<unknown>, message?: string) => {
      try {
        await fn();
        if (message) notify(message);
        return true;
      } catch (e) {
        if (cancelled(e)) return false;
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          clearPrivate();
          forgetKitchen();
          setAuthOpen(true);
        }
        notify((e as Error).message);
        return false;
      }
    },
    [notify, setAuthOpen, clearPrivate],
  );
  // Applies a toggle now and runs the request; rolls back if the server says no (unless that
  // signed us out, which empties the library anyway).
  const optimistic = useCallback(
    async (change: Toggle, request: () => Promise<unknown>, message: string) => {
      const slot = `${change.key}:${change.id}`;
      pending.current.set(slot, change);
      setLibrary((l) => toggled(l, change));
      const ok = await act(request, message);
      if (pending.current.get(slot) === change) pending.current.delete(slot);
      if (!ok) setLibrary((l) => toggled(l, { ...change, on: !change.on }));
    },
    [act],
  );
  const savedIds = useSameIds(library.savedIds);
  const followingIds = useSameIds(library.followingIds);
  const toggleSave = useCallback(
    async (recipe: Recipe) => {
      if (!requireUser()) return;
      const saved = savedIds.includes(recipe.id);
      await optimistic(
        { key: 'savedIds', id: recipe.id, on: !saved },
        async () => {
          await api(`/recipes/${recipe.id}/save`, {
            method: saved ? 'DELETE' : 'PUT',
            body: saved ? undefined : {},
          });
          await refreshLibrary();
        },
        saved ? 'Removed from your cookbook' : 'Saved to your cookbook',
      );
    },
    [savedIds, requireUser, optimistic, refreshLibrary],
  );
  const toggleFollow = useCallback(
    async (creator: Creator) => {
      if (!requireUser()) return;
      const following = followingIds.includes(creator.id);
      await optimistic(
        { key: 'followingIds', id: creator.id, on: !following },
        async () => {
          await api(`/creators/${creator.id}/follow`, { method: following ? 'DELETE' : 'PUT' });
          await Promise.all([refreshLibrary(), refreshCreators()]);
        },
        following
          ? 'You’ve unfollowed this kitchen.'
          : 'Following. Their recipes will show up for you.',
      );
    },
    [followingIds, requireUser, optimistic, refreshLibrary, refreshCreators],
  );
  // A check-off shows at once. One item's changes reach the server in the order they were made,
  // and a change the server refuses is undone unless a newer tap has replaced it.
  const sent = useRef(new Map<string, Promise<unknown>>());
  const toggleGrocery = useCallback(
    async (item: Grocery) => {
      const change: Check = { id: item.id, checked: !item.checked };
      checks.current.set(item.id, change);
      setKitchen((k) => checkedOff(k, change));
      const before = sent.current.get(item.id);
      const request = (async () => {
        await before?.catch(() => {});
        await api(`/groceries/${item.id}`, { method: 'PATCH', body: { checked: change.checked } });
      })();
      sent.current.set(item.id, request);
      let saved = false;
      await act(async () => {
        await request;
        saved = true;
        await refreshKitchen();
      });
      if (sent.current.get(item.id) === request) sent.current.delete(item.id);
      if (checks.current.get(item.id) !== change) return;
      checks.current.delete(item.id);
      if (!saved) setKitchen((k) => checkedOff(k, { ...change, checked: !change.checked }));
    },
    [act, refreshKitchen],
  );
  const signOut = useCallback(async () => {
    // While the session lasts: this phone stops getting the account's notifications (web: no-op).
    await unregisterPush();
    await api('/auth/logout', { method: 'POST' });
    await persistSession(null);
    setUser(null);
    clearPrivate();
    forgetKitchen();
    notify('You’ve signed out. See you at the table.');
  }, [notify, clearPrivate]);
  const userId = user?.id ?? null;
  // Signing in or out changes the home's shelves (the kitchens followed); the launch loaded them.
  const feedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (loading) return;
    if (feedFor.current !== undefined && feedFor.current !== userId) void refreshFeed();
    feedFor.current = userId;
  }, [loading, userId, refreshFeed]);
  // What the device keeps for a launch without a connection (offline.ts): the home, and the
  // signed-in kitchen's library and plans. A failed or offline launch has nothing new to keep.
  useEffect(() => {
    if (loading || offline || error) return;
    saveSnapshot({
      recipes,
      creators,
      feed,
      user,
      library: user && library !== emptyLibrary ? library : null,
      kitchen: user ? kitchen : null,
    });
  }, [loading, offline, error, recipes, creators, feed, user, library, kitchen]);
  const shelf = useMemo<LibraryState>(
    () => ({ savedIds, followingIds, userId, toggleSave, toggleFollow }),
    [savedIds, followingIds, userId, toggleSave, toggleFollow],
  );
  const food = useSameFood(
    user
      ? {
          avoid: user.avoid ?? null,
          household: (user.householdAvoid ?? []).map((h) => ({ name: h.name, avoid: h.avoid })),
          diets: user.preferences.diets ?? [],
          pantryCover: kitchen.pantryCover ?? [],
        }
      : noFood,
  );
  return {
    recipes,
    setRecipes,
    creators,
    user,
    library,
    kitchen,
    capabilities,
    /** GET /feed's shelves, or null (see homeShelves in feed.ts). */
    feed,
    loading,
    error,
    /** The API couldn't be reached at launch, so the copy kept on this device is showing. */
    offline,
    reconnecting,
    reconnect,
    /** The days `kitchen.plans` covers: last week through four weeks ahead (kitchenWindow). */
    kitchenRange,
    notify,
    authOpen,
    authMode,
    setAuthOpen,
    refreshPrivate,
    refreshLibrary,
    refreshKitchen,
    refreshCreators,
    refreshRecipes,
    refreshFeed,
    refreshUser,
    requireUser,
    act,
    toggleSave,
    toggleFollow,
    toggleGrocery,
    signOut,
    load,
    /** The bookmark-and-follow slice, also provided on its own (see library.tsx). */
    shelf,
    /** What to warn about and what the pantry has, also provided on its own (see food.ts). */
    food,
  };
}
const Context = createContext<ReturnType<typeof useAppState> | null>(null);
export function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <NotificationsProvider>
      <AppStateProvider>{children}</AppStateProvider>
    </NotificationsProvider>
  );
}
function AppStateProvider({ children }: { children: React.ReactNode }) {
  const value = useAppState();
  return (
    <Context.Provider value={value}>
      <LibraryContext.Provider value={value.shelf}>
        <FoodContext.Provider value={value.food}>{children}</FoodContext.Provider>
      </LibraryContext.Provider>
    </Context.Provider>
  );
}
export function useApp() {
  const c = useContext(Context);
  if (!c) throw new Error('AppProvider missing');
  return c;
}
