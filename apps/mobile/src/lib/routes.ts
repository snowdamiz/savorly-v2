import { Platform } from 'react-native';
import { WEB_URL } from './api';
import type { Screen } from './types';

// The app's addresses. In a browser the address bar follows the page (webHistory.ts); on phones
// links arrive through Linking: https://savorly.cooking/recipes/<id> (and the staging site's) once
// a build has the app links, and savorly://recipes/<id> always. Recipes used to be shared as
// /?recipe=<id>, so those links still open, and the web app rewrites them to the new form. Screens
// keep /?page=<screen>. Parsing is done here, by hand, because React Native's URL only reads http
// addresses, and every platform must read a link the same way.

/** The screens a `?page=` address can name. */
export const screens: readonly Screen[] = [
  'discover',
  'explore',
  'saved',
  'planner',
  'pantry',
  'profile',
  'create',
  'community',
  'admin',
  'mealime',
  'own-site',
];

// Recipe and cookbook ids: UUIDs, or slugs for the sample recipes (the Worker's recipeIdPattern).
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const hostOf = (site: string) => /^https?:\/\/([^/?#:]+)/i.exec(site)?.[1]?.toLowerCase();

/**
 * The sites whose links open in the phone apps: production, its www alias, staging, and the site
 * the build shares links to (EXPO_PUBLIC_WEB_URL).
 */
export const linkHosts: readonly string[] = [
  ...new Set(
    ['savorly.cooking', 'www.savorly.cooking', 'staging.savorly.cooking', hostOf(WEB_URL)].filter(
      (host): host is string => !!host,
    ),
  ),
];

export type Route =
  /**
   * A recipe page; `legacy` when the link was the older `/?recipe=<id>`, and `cook` when it asks
   * for cooking mode (`?cook=1`), as the links ChatGPT and Claude give do.
   */
  | { type: 'recipe'; id: string; legacy: boolean; cook?: true }
  /** A public cookbook's page. */
  | { type: 'cookbook'; id: string }
  /** The page where an assistant asks to connect (`/oauth/authorize`), with its request as sent. */
  | { type: 'authorize'; query: string }
  /** A screen (`/?page=<screen>`), or for `/` whichever screen is showing (null). */
  | { type: 'page'; screen: Screen | null };

/** A recipe page's path, `/recipes/<id>`. */
export const recipePath = (id: string) => `/recipes/${encodeURIComponent(id)}`;
/** A link that opens a recipe straight in cooking mode. */
export const cookPath = (id: string) => `${recipePath(id)}?cook=1`;
/** A public cookbook's path, `/cookbooks/<id>`. */
export const cookbookPath = (id: string) => `/cookbooks/${encodeURIComponent(id)}`;
/** A screen's path, `/?page=<screen>`. */
export const pagePath = (screen: Screen) => `/?page=${screen}`;

const site = (base: string) => base.replace(/\/+$/, '');
/**
 * The link to share for a recipe: on the site the web app is running on, or on phones the build's
 * web app (EXPO_PUBLIC_WEB_URL, savorly.cooking by default), whose recipe links open the app.
 */
export const recipeUrl = (id: string, base: string = WEB_URL) => site(base) + recipePath(id);
/** The link to share for a public cookbook. */
export const cookbookUrl = (id: string, base: string = WEB_URL) => site(base) + cookbookPath(id);

// Percent-decoding that answers null for malformed escapes; in a query, + is a space.
const decode = (value: string, query = false) => {
  try {
    return decodeURIComponent(query ? value.replace(/\+/g, ' ') : value);
  } catch {
    return null;
  }
};

// The first value of each query parameter.
function parameters(search: string) {
  const values = new Map<string, string>();
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const key = decode(at < 0 ? pair : pair.slice(0, at), true);
    const value = decode(at < 0 ? '' : pair.slice(at + 1), true);
    if (key !== null && value !== null && !values.has(key)) values.set(key, value);
  }
  return values;
}

/**
 * The page an address is for, or null when it isn't one of the app's: another scheme or site, or
 * a path the app doesn't have. Takes full addresses (https://, savorly://) and paths (`/recipes/x`).
 * `hosts` limits http(s) addresses to those sites, for phones (see linkHosts); without it any site
 * counts, as when the web app reads its own address.
 */
export function parseRoute(address: string, hosts?: readonly string[]): Route | null {
  const text = address.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(text);
  let rest: string;
  if (!scheme) {
    if (!text.startsWith('/') || text.startsWith('//')) return null;
    rest = text;
  } else {
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https') {
      const authority = /^\/\/([^/?#]*)(.*)$/.exec(scheme[2]);
      if (!authority) return null;
      const host = authority[1]
        .replace(/^[^@]*@/, '')
        .replace(/:\d*$/, '')
        .toLowerCase();
      if (hosts && !hosts.some((allowed) => allowed.toLowerCase() === host)) return null;
      rest = authority[2];
    } else if (name === 'savorly') {
      // savorly://recipes/<id>: here what an https link calls the host is the path's first part.
      rest = `/${scheme[2].replace(/^\/+/, '')}`;
    } else return null;
  }
  const [beforeHash] = rest.split('#');
  const mark = beforeHash.indexOf('?');
  const path = mark < 0 ? beforeHash : beforeHash.slice(0, mark);
  const query = parameters(mark < 0 ? '' : beforeHash.slice(mark + 1));
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) {
    const legacy = query.get('recipe');
    if (legacy && idPattern.test(legacy)) return { type: 'recipe', id: legacy, legacy: true };
    const page = query.get('page') as Screen | undefined;
    return { type: 'page', screen: page && screens.includes(page) ? page : null };
  }
  if (parts.length === 2 && (parts[0] === 'recipes' || parts[0] === 'cookbooks')) {
    const id = decode(parts[1]);
    if (!id || !idPattern.test(id)) return null;
    if (parts[0] === 'cookbooks') return { type: 'cookbook', id };
    return query.get('cook') === '1'
      ? { type: 'recipe', id, legacy: false, cook: true }
      : { type: 'recipe', id, legacy: false };
  }
  if (parts.length === 2 && parts[0] === 'oauth' && parts[1] === 'authorize')
    return { type: 'authorize', query: mark < 0 ? '' : beforeHash.slice(mark + 1) };
  return null;
}

/**
 * On the web, props that make a pressable a real link to `path` (an <a href>), which crawlers
 * follow and which opens in a new tab on a middle or modified click; nothing on phones. Pair it
 * with `pressedInApp` in onPress, and give the pressable the 'link' role on the web.
 */
export const linkTo = (path: string): { href?: string } =>
  Platform.OS === 'web' ? { href: path } : {};

type Click = {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  button?: number;
  preventDefault?: () => void;
  nativeEvent?: Click;
};
/**
 * For a link's onPress: whether the app opens the page itself (a plain click or tap; the browser's
 * own navigation is then stopped) or leaves it to the browser (a click with a modifier key, for a
 * new tab or window). Always true on phones.
 */
export function pressedInApp(event?: unknown): boolean {
  if (Platform.OS !== 'web' || !event || typeof event !== 'object') return true;
  const click = event as Click;
  const keys = click.nativeEvent ?? click;
  if (keys.altKey || keys.ctrlKey || keys.metaKey || keys.shiftKey || (keys.button ?? 0) !== 0)
    return false;
  click.preventDefault?.();
  return true;
}
