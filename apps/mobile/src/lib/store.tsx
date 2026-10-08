import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
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
  const [authOpen, setAuthOpen] = useState(false);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const refreshPrivate = useCallback(async () => {
    const [l, k] = await Promise.all([api<Library>('/library'), api<Kitchen>('/kitchen')]);
    setLibrary(l);
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
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await initSession();
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [refreshRecipes, refreshUser]);
  useEffect(() => {
    void load();
  }, [load]);
  const requireUser = useCallback(
    (action?: () => void) => {
      if (!user) {
        setAuthOpen(true);
        return false;
      }
      action?.();
      return true;
    },
    [user],
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
    [notify],
  );
  const toggleSave = useCallback(
    async (recipe: Recipe) => {
      if (!requireUser()) return;
      const saved = library.savedIds.includes(recipe.id);
      await act(
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
    [library.savedIds, requireUser, act, refreshPrivate],
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
    setAuthOpen,
    refreshPrivate,
    refreshRecipes,
    refreshUser,
    requireUser,
    act,
    toggleSave,
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
