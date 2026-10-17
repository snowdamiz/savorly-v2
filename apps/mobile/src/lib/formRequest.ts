import { useState } from 'react';
import { ApiError } from './api';
import { useApp } from './store';

/**
 * A form's request, with its error shown in the form rather than as a toast. A wrong password
 * answers 403 and stays in the form; a lost session (401) still signs out, as everywhere else.
 */
export function useFormRequest() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (request: () => Promise<void>, failed?: () => void) => {
    setBusy(true);
    setError('');
    try {
      await request();
    } catch (e) {
      failed?.();
      if (e instanceof ApiError && e.status === 401) void app.act(() => Promise.reject(e));
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
