import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { useApp } from './store';
import type { LibraryPage, Recipe } from './types';

const PAGE = 24;
/** One shelf of the library, a page at a time: everything saved, one cookbook, or your own. */
const shelfPath = (shelf: string, offset: number) =>
  `/library/recipes?scope=${shelf === 'mine' ? 'mine' : 'saved'}${
    shelf === 'all' || shelf === 'mine' ? '' : `&collection=${encodeURIComponent(shelf)}`
  }&offset=${offset}&limit=${PAGE}`;
const isPage = (page: unknown): page is LibraryPage =>
  !!page &&
  Array.isArray((page as LibraryPage).recipes) &&
  typeof (page as LibraryPage).hasMore === 'boolean';
/** `list`, then whatever in `more` it doesn't have yet. */
const joined = (list: Recipe[], more: Recipe[]) => {
  const ids = new Set(list.map((r) => r.id));
  return [...list, ...more.filter((r) => !ids.has(r.id))];
};
type Shelf = { key: string; recipes: Recipe[]; hasMore: boolean };
/**
 * A shelf's recipes, paged from the server, since the store holds only the newest of the library
 * (LIBRARY_LIMIT in store.tsx). `active` is `all` (everything saved), `mine` (the cook's own
 * recipes, drafts too) or a cookbook's id.
 * The store still says what's saved where: an unsave hides a recipe at once, and a new save brings
 * the first page in again. A server that can't page leaves the store's list as the shelf.
 */
export function useShelf(active: string) {
  const app = useApp();
  const { act } = app;
  const userId = app.user?.id ?? null;
  const { savedIds, saves, ownIds, recipes: stored } = app.library;
  const member = useCallback(
    (r: Recipe) =>
      active === 'mine'
        ? // Older servers don't list the cook's own ids; their library is whole anyway.
          ownIds
          ? ownIds.includes(r.id)
          : r.author.id === userId
        : active === 'all'
          ? savedIds.includes(r.id)
          : saves.some((v) => v.recipeId === r.id && v.collectionId === active),
    [active, userId, savedIds, saves, ownIds],
  );
  // The shelf as the store knows it; a recipe it hadn't seen before has just arrived.
  const known = (
    active === 'mine'
      ? (ownIds ?? stored.filter(member).map((r) => r.id))
      : active === 'all'
        ? savedIds
        : saves.filter((v) => v.collectionId === active).map((v) => v.recipeId)
  ).join('\n');
  const key = `${userId}:${active}`;
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [unpaged, setUnpaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const own = shelf?.key === key ? shelf : null;
  const first = useRef(0);
  useEffect(() => {
    if (!userId || unpaged) return;
    const n = ++first.current;
    api<LibraryPage>(shelfPath(active, 0))
      .then((page) => {
        if (n !== first.current) return;
        if (isPage(page)) setShelf({ key, recipes: page.recipes, hasMore: page.hasMore });
        else setUnpaged(true);
      })
      .catch(() => {
        if (n === first.current) setUnpaged(true);
      });
  }, [key, active, userId, unpaged]);
  const seen = useRef({ key: '', ids: new Set<string>() });
  useEffect(() => {
    const ids = new Set(known ? known.split('\n') : []);
    const before = seen.current;
    seen.current = { key, ids };
    if (before.key !== key || !own) return;
    const listed = new Set(own.recipes.map((r) => r.id));
    if (![...ids].some((id) => !before.ids.has(id) && !listed.has(id))) return;
    api<LibraryPage>(shelfPath(active, 0))
      .then((page) => {
        if (!isPage(page)) return;
        setShelf((old) => {
          if (old?.key !== key) return old;
          const recipes = joined(page.recipes, old.recipes);
          // Past the first page, the pages already shown still say whether more follow.
          const hasMore = recipes.length > page.recipes.length ? old.hasMore : page.hasMore;
          return { key, recipes, hasMore };
        });
      })
      .catch(() => {});
  }, [known, key, active, own]);
  const recipes = useMemo(() => (own ? own.recipes : stored).filter(member), [own, stored, member]);
  // The next page starts after the recipes still on the shelf; any it repeats are left out.
  const showMore = async () => {
    if (!own?.hasMore || busy) return;
    setBusy(true);
    await act(async () => {
      const page = await api<LibraryPage>(shelfPath(active, recipes.length));
      if (!isPage(page)) return;
      setShelf((old) =>
        old?.key === key
          ? { key, recipes: joined(old.recipes, page.recipes), hasMore: page.hasMore }
          : old,
      );
    });
    setBusy(false);
  };
  return {
    recipes,
    hasMore: !!own?.hasMore,
    /** False while the first page is on its way. */
    settled: !userId || unpaged || !!own,
    busy,
    showMore,
  };
}
