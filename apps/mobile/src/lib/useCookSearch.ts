import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Creator } from './types';

/**
 * Every member, those who have published first and then the newest, or those whose name or handle
 * matches `query` (GET /creators?everyone=true). `size` is a page; Show more asks for the next.
 */
export function useCookSearch(query: string, { size = 40, enabled = true } = {}) {
  const [cooks, setCooks] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const parameters = enabled
    ? new URLSearchParams({ everyone: 'true', q: query.trim(), limit: String(size) }).toString()
    : null;
  const [previousParameters, setPreviousParameters] = useState(parameters);
  if (previousParameters !== parameters) {
    setPreviousParameters(parameters);
    setCooks([]);
    setHasMore(false);
    setLoading(enabled);
    setError('');
  }
  useEffect(() => {
    const current = ++generation.current;
    if (parameters === null) return;
    const timer = setTimeout(() => {
      void api<Creator[]>(`/creators?${parameters}`)
        .then((next) => {
          if (current !== generation.current) return;
          setCooks(next);
          setHasMore(next.length === size);
        })
        .catch((e) => {
          if (current === generation.current) setError(e.message);
        })
        .finally(() => {
          if (current === generation.current) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current = current + 1;
    };
  }, [parameters, size]);
  const loadMore = async () => {
    if (parameters === null || loading || !hasMore) return;
    const current = generation.current;
    setLoading(true);
    try {
      const next = await api<Creator[]>(`/creators?${parameters}&offset=${cooks.length}`);
      if (current !== generation.current) return;
      setCooks((old) => [...old, ...next.filter((c) => !old.some((x) => x.id === c.id))]);
      setHasMore(next.length === size);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  return { cooks, loading, error, hasMore, loadMore };
}
