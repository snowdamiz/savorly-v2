import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Recipe } from './types';
import { allCuisines } from './cuisines';
const PAGE_SIZE = 24;
export function useRecipeSearch(params: {
  query: string;
  category: string;
  cuisine: string;
  quick: boolean;
  sort: string;
}) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const parameters = new URLSearchParams({
    q: params.query,
    category: params.cuisine === allCuisines ? '' : params.cuisine,
    tag: params.category === 'All recipes' ? '' : params.category,
    maxMinutes: params.quick ? '20' : '0',
    sort: params.sort,
    limit: String(PAGE_SIZE),
  }).toString();
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
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
      generation.current++;
    };
  }, [parameters]);
  const loadMore = async () => {
    if (loading || !hasMore) return;
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
