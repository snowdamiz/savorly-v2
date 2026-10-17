import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Recipe } from './types';
import { allCuisines } from './cuisines';
const PAGE_SIZE = 24;
export function useRecipeSearch(
  params: {
    query: string;
    category: string;
    cuisine: string;
    quick: boolean;
    sort: string;
    /** Only recipes without what the signed-in member avoids. */
    fits?: boolean;
  },
  enabled = true,
) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const parameters = enabled
    ? new URLSearchParams({
        q: params.query,
        category: params.cuisine === allCuisines ? '' : params.cuisine,
        tag: params.category === 'All recipes' ? '' : params.category,
        maxMinutes: params.quick ? '20' : '0',
        sort: params.sort,
        limit: String(PAGE_SIZE),
        ...(params.fits ? { fits: 'me' } : {}),
      }).toString()
    : null;
  const [previousParameters, setPreviousParameters] = useState(parameters);
  if (previousParameters !== parameters) {
    setPreviousParameters(parameters);
    setRecipes([]);
    setHasMore(false);
    setLoading(enabled);
    setError('');
  }
  useEffect(() => {
    const current = ++generation.current;
    if (parameters === null) return;
    const timer = setTimeout(() => {
      void api<Recipe[]>(`/recipes?${parameters}`)
        .then((next) => {
          if (current !== generation.current) return;
          setRecipes(next);
          setHasMore(next.length === PAGE_SIZE);
        })
        .catch((e) => {
          if (current === generation.current) {
            setError(e.message);
            setRecipes([]);
          }
        })
        .finally(() => {
          if (current === generation.current) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current = current + 1;
    };
  }, [parameters]);
  const loadMore = async () => {
    if (parameters === null || loading || !hasMore) return;
    const current = generation.current;
    setLoading(true);
    try {
      const next = await api<Recipe[]>(`/recipes?${parameters}&offset=${recipes.length}`);
      if (current !== generation.current) return;
      setRecipes((old) => [...old, ...next.filter((r) => !old.some((x) => x.id === r.id))]);
      setHasMore(next.length === PAGE_SIZE);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  return { recipes, loading, error, hasMore, loadMore };
}
