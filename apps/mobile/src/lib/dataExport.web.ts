import { api, API_URL } from './api';

/** The day in the cook's own time zone, as YYYY-MM-DD. */
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Has the browser save `href` without leaving the page. */
function save(href: string, name?: string) {
  const link = document.createElement('a');
  link.href = href;
  if (name) link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * A copy of everything the account holds, as JSON (GET /me/export), saved by the browser as
 * savorly-export-YYYY-MM-DD.json. The request carries the session cookie like any other.
 */
export async function downloadMyData() {
  const data = await api<unknown>('/me/export', { timeout: 120000 });
  const file = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  save(url, `savorly-export-${today()}.json`);
  // Revoked once the browser has had time to start saving it.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Everything as files, one ZIP (GET /me/export/files). Photos can make it large, so the browser
 * downloads it itself, from a single-use link, rather than the page holding it in memory.
 */
export async function downloadMyFiles() {
  const { url } = await api<{ url: string; expiresAt: string }>('/me/export-link', {
    method: 'POST',
    body: { format: 'files' },
  });
  save(`${API_URL}${url}`);
}
