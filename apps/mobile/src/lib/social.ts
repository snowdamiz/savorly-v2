// Pure helpers for the recipe page's community parts: comments, cooks, reviews and attribution.
type Translate = (key: string, variables?: Record<string, string | number>) => string;

/**
 * How long ago something happened, in the reader's language: "Just now", "5 min ago", "3 hours
 * ago", "2 days ago", then the date ("12 Oct", with the year once it isn't this one). Catalog keys
 * rather than Intl.RelativeTimeFormat, which Hermes doesn't have.
 */
export function timeAgo(iso: string, now: number, t: Translate, locale: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('daysAgo', { count: days });
  const date = new Date(at);
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== new Date(now).getFullYear() && { year: 'numeric' }),
  });
}

/** Whether something was changed after it was written: more than a minute later. */
export function wasEdited(createdAt: string, updatedAt?: string | null) {
  if (!updatedAt) return false;
  return Date.parse(updatedAt) - Date.parse(createdAt) > 60_000;
}

/** The site a web address belongs to ("example.com"), or '' for anything but http(s). */
export function siteName(url: string | null | undefined) {
  const match = /^https?:\/\/(?:[^@/?#\s]*@)?([^:/?#\s]+)/i.exec((url || '').trim());
  return match ? match[1].toLowerCase().replace(/^www\./, '') : '';
}

type Threaded = { id: string; parentId: string | null; createdAt: string };
/**
 * Comments as conversations, oldest first: each top-level comment with its replies. A reply whose
 * comment isn't loaded (or is gone) stands on its own; one to a reply joins that reply's thread.
 */
export function threads<T extends Threaded>(items: T[]) {
  const time = (c: T) => Date.parse(c.createdAt) || 0;
  const sorted = items
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => time(a.comment) - time(b.comment) || a.index - b.index)
    .map(({ comment }) => comment);
  const byId = new Map(sorted.map((c) => [c.id, c]));
  const root = (c: T) => {
    let top = c;
    const seen = new Set<string>();
    while (top.parentId && byId.has(top.parentId) && !seen.has(top.id)) {
      seen.add(top.id);
      top = byId.get(top.parentId)!;
    }
    return top;
  };
  const list: { comment: T; replies: T[] }[] = [];
  const index = new Map<string, { comment: T; replies: T[] }>();
  for (const c of sorted) {
    const top = root(c);
    if (top === c) {
      const thread = { comment: c, replies: [] };
      index.set(c.id, thread);
      list.push(thread);
    }
  }
  for (const c of sorted) {
    const top = root(c);
    if (top !== c) index.get(top.id)?.replies.push(c);
  }
  return list;
}
