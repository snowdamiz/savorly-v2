import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { API_URL, sessionHeaders } from './api';
import { requestKey } from './utils';

// What the app reports about itself, first party and best effort: crashes to POST /client-errors,
// and a few product events to POST /events (docs/API.md). Nothing here may ever break the app or
// get in the cook's way, so every entry point swallows its own failures, sends in the background,
// and gives up quietly when the network or the server says no.

/** The events the API accepts (POST /events), with the props each one carries. */
export type EventName =
  | 'search'
  | 'recipe_open'
  | 'cook_start'
  | 'studio_start'
  | 'share'
  | 'onboarding_step'
  | 'onboarding_done'
  | 'import';
export type EventProps = Record<string, string | number | boolean | null>;
export type QueuedEvent = { name: EventName; props?: EventProps; at: string };

// ---- Pure parts (src/lib/__tests__/telemetry.test.ts) ----

/** At most this many events wait; past it the oldest go, so a long offline spell stays small. */
export const QUEUE_LIMIT = 200;
/** The API takes at most 50 events per request. */
export const BATCH_SIZE = 50;
/** Events wait about this long to travel together. */
export const FLUSH_MS = 10_000;

/** The queue with `event` added at the end, dropping the oldest beyond `limit`. */
export function enqueue(queue: QueuedEvent[], event: QueuedEvent, limit = QUEUE_LIMIT) {
  const next = [...queue, event];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** The next request's events, and what is left for the one after. */
export function nextBatch(queue: QueuedEvent[], size = BATCH_SIZE): [QueuedEvent[], QueuedEvent[]] {
  return [queue.slice(0, size), queue.slice(size)];
}

/** Cuts text to `max` characters, marking the cut. */
export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** An error's message and stack, whatever was thrown (an Error, a string, anything). */
export function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error)
    return { message: error.message || error.name || 'Error', stack: error.stack || undefined };
  if (typeof error === 'string') return { message: error || 'Error' };
  if (error && typeof error === 'object') {
    const { message, stack } = error as { message?: unknown; stack?: unknown };
    if (typeof message === 'string' && message)
      return { message, stack: typeof stack === 'string' ? stack : undefined };
    try {
      return { message: JSON.stringify(error) ?? String(error) };
    } catch {
      return { message: String(error) };
    }
  }
  return { message: String(error) };
}

/**
 * What makes two reports the same problem: the message and the top of the stack (where it was
 * thrown), so a crash that repeats on every render or every tap is reported once.
 */
export function errorKey(message: string, stack?: string) {
  const top = (stack || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(message))
    .slice(0, 3)
    .join('|');
  return `${message}\n${top}`;
}

/**
 * A rate limit: `perMinute` within any 60 seconds and `total` for the whole launch. Returns a
 * check that answers whether one more is allowed at `now`, counting it if so.
 */
export function createLimiter({ perMinute, total }: { perMinute: number; total: number }) {
  const times: number[] = [];
  let count = 0;
  return (now: number) => {
    while (times.length && now - times[0] >= 60_000) times.shift();
    if (count >= total || times.length >= perMinute) return false;
    times.push(now);
    count++;
    return true;
  };
}

// ---- The app's side ----

const web = Platform.OS === 'web' && typeof window !== 'undefined';
// One random id per launch ties a session's events together without identifying anyone.
const session = requestKey();
const endpoint = (path: string) => `${API_URL}/v1${path}`;
const headers = () => ({ 'Content-Type': 'application/json', ...sessionHeaders() });

/** The app's version (app.json), as built into this bundle. */
const appVersion = Constants.expoConfig?.version ?? '';

/**
 * Which JavaScript is running: the EAS update's id on phones (none for the build's own bundle),
 * and on the web the content hash in the bundle's file name, which changes with every deploy.
 */
function release() {
  if (!web) return Updates.updateId ?? (__DEV__ ? 'development' : 'embedded');
  const script = document.querySelector<HTMLScriptElement>('script[src*="/_expo/static/js/"]');
  return /([^/]+)\.js(?:\?|$)/.exec(script?.src ?? '')?.[1] ?? 'development';
}

// Automated browsers (end-to-end tests, scrapers) and search crawlers aren't cooks; their visits
// would only blur what the events are for. Errors are still reported from them. (Named crawlers
// rather than any "bot": some phones' names end in it.)
const automated =
  web &&
  typeof navigator !== 'undefined' &&
  (navigator.webdriver === true ||
    /headless|lighthouse|googlebot|bingbot|applebot|yandexbot|baiduspider|duckduckbot|slurp|petalbot|crawler|spider/i.test(
      navigator.userAgent || '',
    ));

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

// sendBeacon outlives the page. It's used only when the API is on the page's own origin (/api in
// production, so no CORS is involved); elsewhere, as in development, a keepalive fetch does the job.
function beacon(body: string) {
  if (!web || typeof navigator.sendBeacon !== 'function') return false;
  try {
    if (new URL(endpoint('/events'), window.location.href).origin !== window.location.origin)
      return false;
    return navigator.sendBeacon(
      endpoint('/events'),
      new Blob([body], { type: 'application/json' }),
    );
  } catch {
    return false;
  }
}

function send(body: string, leaving: boolean) {
  if (leaving && beacon(body)) return;
  fetch(endpoint('/events'), {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: headers(),
    body,
  }).catch(() => {});
}

/**
 * Sends every waiting event now, in batches of 50. `leaving`: the page is being hidden or closed,
 * so the requests must outlive it.
 */
export function flushEvents(leaving = false) {
  try {
    if (timer) clearTimeout(timer);
    timer = null;
    while (queue.length) {
      const [batch, rest] = nextBatch(queue);
      queue = rest;
      send(JSON.stringify({ session, events: batch }), leaving);
    }
  } catch {
    queue = [];
  }
}

// Events leave when the app goes to the background or the tab is hidden or closed, as well as on
// the timer: a phone may never return to the app, and a closed tab can't.
function listen() {
  if (listening) return;
  listening = true;
  if (web) {
    window.addEventListener('pagehide', () => flushEvents(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushEvents(true);
    });
  } else
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushEvents();
    });
}

/**
 * Records a product event (POST /events): batched, sent about every 10 seconds and when the app
 * is left, never retried. Allowed names and props are in docs/API.md; never put anything personal
 * in props (an id or a search is fine; an email or a note is not).
 */
export function track(name: EventName, props?: EventProps) {
  try {
    if (automated) return;
    listen();
    queue = enqueue(queue, { name, ...(props ? { props } : {}), at: new Date().toISOString() });
    if (queue.length >= BATCH_SIZE) flushEvents();
    else if (!timer) timer = setTimeout(() => flushEvents(), FLUSH_MS);
  } catch {
    // Analytics never get in the way.
  }
}

// A crash loop must not flood the API (it allows 30 a minute from one address), nor a phone's data.
const allowed = createLimiter({ perMinute: 5, total: 30 });
const reportedKeys = new Set<string>();
const reportedErrors = new WeakSet<object>();

/**
 * Reports an error to POST /client-errors: once per distinct error, at most 5 a minute and 30 a
 * launch, in the background, and never throwing. `componentStack` comes from an error boundary.
 */
export function reportError(error: unknown, extra: { componentStack?: string } = {}) {
  try {
    if (error && typeof error === 'object') {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    const { message, stack } = describeError(error);
    const key = errorKey(message, stack);
    if (reportedKeys.has(key) || !allowed(Date.now())) return;
    reportedKeys.add(key);
    const body = {
      message: clip(message, 1000),
      ...(stack ? { stack: clip(stack, 6000) } : {}),
      ...(extra.componentStack ? { componentStack: clip(extra.componentStack, 3000) } : {}),
      platform: Platform.OS,
      appVersion,
      release: release(),
      ...(web ? { url: clip(window.location.href, 500) } : {}),
    };
    fetch(endpoint('/client-errors'), {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: headers(),
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    // Reporting must never become the next error.
  }
}

let installed = false;
/**
 * Reports what nothing else caught: uncaught errors and unhandled promise rejections in the
 * browser, and the JavaScript runtime's global handler on phones, which still runs afterwards (so
 * a fatal error still ends the app the usual way). Errors an error boundary catches arrive through
 * reportError, and the same error object is never sent twice.
 */
export function installErrorReporting() {
  if (installed) return;
  installed = true;
  if (web) {
    window.addEventListener('error', (event) => reportError(event.error ?? event.message));
    window.addEventListener('unhandledrejection', (event) => reportError(event.reason));
    return;
  }
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    reportError(error);
    previous(error, isFatal);
  });
}
