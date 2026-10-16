import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, initSession, persistSession } from './api';
import { Capabilities, Creator, Kitchen, Library, Recipe, User } from './types';
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
function useAppState() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [kitchen, setKitchen] = useState<Kitchen>(emptyKitchen);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [authOpen, setAuthShown] = useState(false);
  // Which side of the sign-in sheet opens: signing in, or creating an account.
  const [authMode, setAuthMode] = useState<'signin' | 'register'>('signin');
  const setAuthOpen = useCallback((open: boolean, mode: 'signin' | 'register' = 'signin') => {
    setAuthMode(mode);
    setAuthShown(open);
  }, []);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  // Saves and follows show at once. Until the server confirms one, it is laid over every library
  // refresh, so a slower request finishing first can't flip it back.
  const pending = useRef(new Map<string, Toggle>());
  const refreshPrivate = useCallback(async () => {
    const [l, k] = await Promise.all([api<Library>('/library'), api<Kitchen>('/kitchen')]);
    setLibrary([...pending.current.values()].reduce(toggled, l));
    setKitchen(k);
  }, []);
  const refreshRecipes = useCallback(async () => {
    const [r, c] = await Promise.all([api<Recipe[]>('/recipes'), api<Creator[]>('/creators')]);
    setRecipes(r);
    setCreators(c);
  }, []);
  const refreshUser = useCallback(async () => {
    const u = await api<User>('/me');
    setUser(u);
    await refreshPrivate();
  }, [refreshPrivate]);
  const loadData = useCallback(
    () =>
      initSession()
        .then(async () => {
          await Promise.all([
            refreshRecipes(),
            api<Capabilities>('/capabilities').then(setCapabilities),
          ]);
          try {
            await refreshUser();
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 401)) throw e;
            setUser(null);
            setLibrary(emptyLibrary);
            setKitchen(emptyKitchen);
          }
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false)),
    [refreshRecipes, refreshUser],
  );
  useEffect(() => {
    void loadData();
  }, [loadData]);
  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return loadData();
  }, [loadData]);
  const requireUser = useCallback(
    (action?: () => void) => {
      if (!user) {
        setAuthOpen(true);
        return false;
      }
      action?.();
      return true;
    },
    [user, setAuthOpen],
  );
  const act = useCallback(
    async (fn: () => Promise<unknown>, message?: string) => {
      try {
        await fn();
        if (message) notify(message);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          setLibrary(emptyLibrary);
          setKitchen(emptyKitchen);
          setAuthOpen(true);
        }
        notify((e as Error).message);
        return false;
      }
    },
    [notify, setAuthOpen],
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
  const toggleSave = useCallback(
    async (recipe: Recipe) => {
      if (!requireUser()) return;
      const saved = library.savedIds.includes(recipe.id);
      await optimistic(
        { key: 'savedIds', id: recipe.id, on: !saved },
        async () => {
          await api(`/recipes/${recipe.id}/save`, {
            method: saved ? 'DELETE' : 'PUT',
            body: saved ? undefined : {},
          });
          await refreshPrivate();
        },
        saved ? 'Removed from your cookbook' : 'Saved to your cookbook',
      );
    },
    [library.savedIds, requireUser, optimistic, refreshPrivate],
  );
  const toggleFollow = useCallback(
    async (creator: Creator) => {
      if (!requireUser()) return;
      const following = library.followingIds.includes(creator.id);
      await optimistic(
        { key: 'followingIds', id: creator.id, on: !following },
        async () => {
          await api(`/creators/${creator.id}/follow`, { method: following ? 'DELETE' : 'PUT' });
          await Promise.all([refreshPrivate(), refreshRecipes()]);
        },
        following
          ? 'You’ve unfollowed this kitchen.'
          : 'Following. Their recipes will show up for you.',
      );
    },
    [library.followingIds, requireUser, optimistic, refreshPrivate, refreshRecipes],
  );
  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    await persistSession(null);
    setUser(null);
    setLibrary(emptyLibrary);
    setKitchen(emptyKitchen);
    notify('You’ve signed out. See you at the table.');
  }, [notify]);
  return {
    recipes,
    setRecipes,
    creators,
    user,
    library,
    kitchen,
    capabilities,
    loading,
    error,
    toast,
    notify,
    authOpen,
    authMode,
    setAuthOpen,
    refreshPrivate,
    refreshRecipes,
    refreshUser,
    requireUser,
    act,
    toggleSave,
    toggleFollow,
    signOut,
    load,
  };
}
const Context = createContext<ReturnType<typeof useAppState> | null>(null);
export function AppProvider({ children }: { children: React.ReactNode }) {
  const value = useAppState();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useApp() {
  const c = useContext(Context);
  if (!c) throw new Error('AppProvider missing');
  return c;
}
