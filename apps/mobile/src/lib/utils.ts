export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** A YYYY-MM-DD day as a local date at midnight, or null when it isn't a real calendar day. */
export function parseDay(day: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return localDate(date) === day ? date : null;
}
/** Whole calendar days from `from` to `to`, ignoring the time of day (and daylight saving). */
export function daysBetween(from: Date, to: Date) {
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}
/** A YYYY-MM-DD day written for the reader's locale (by default "Oct 22, 2026"), or ''. */
export function formatDay(
  day: string | null | undefined,
  locale: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
) {
  return parseDay(day)?.toLocaleDateString(locale, options) ?? '';
}
// Where Intl can't say (no Intl.Locale week data), CLDR's first day of the week by region; the rest
// of the world starts on Monday. A language without a region takes its usual one.
const sundayFirst = new Set(
  'AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(
    ' ',
  ),
);
const saturdayFirst = new Set('AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '));
const usualRegion: Record<string, string> = {
  en: 'US',
  fr: 'FR',
  de: 'DE',
  ru: 'RU',
  es: 'ES',
  it: 'IT',
  pt: 'BR',
  zh: 'CN',
  ja: 'JP',
};
/** The locale's first day of the week, as Date#getDay counts: 0 is Sunday, 1 is Monday. */
export function firstDayOfWeek(locale: string) {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    // ECMA-402 counts 1 (Monday) to 7 (Sunday); older engines expose a getter instead.
    const first = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    if (first && first >= 1 && first <= 7) return first % 7;
  } catch {}
  const tags = locale.replace(/_/g, '-').split('-');
  const region =
    tags
      .slice(1)
      .find((t) => /^[A-Za-z]{2}$/.test(t))
      ?.toUpperCase() ?? usualRegion[tags[0].toLowerCase()];
  return sundayFirst.has(region) ? 0 : saturdayFirst.has(region) ? 6 : region === 'MV' ? 5 : 1;
}
/** The seven days of a week, starting on `firstDay` (see firstDayOfWeek); `offset` counts weeks. */
export function weekDays(offset = 0, firstDay = 1) {
  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - ((today.getDay() - firstDay + 7) % 7) + offset * 7,
  );
  return Array.from(
    { length: 7 },
    (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
}
/** A fresh idempotency key: a v4 UUID, which every API route accepts (the studio requires one). */
export function requestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    })
  );
}
