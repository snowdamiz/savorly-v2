import { api } from './api';

/** The day in the cook's own time zone, as YYYY-MM-DD. */
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * A copy of everything the account holds, as JSON (GET /me/export), saved by the browser as
 * savorly-export-YYYY-MM-DD.json. The request carries the session cookie like any other.
 */
export async function downloadMyData() {
  const data = await api<unknown>('/me/export', { timeout: 120000 });
  const file = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `savorly-export-${today()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked once the browser has had time to start saving it.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
