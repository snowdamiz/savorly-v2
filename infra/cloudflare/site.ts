// Pure helpers behind the Worker's public pages: escaping, recipe metadata (Open Graph tags and a
// schema.org Recipe), robots.txt, the sitemap, the app-link association files, the
// Content-Security-Policy and CSP report lines. Nothing here touches Workers APIs, so
// `npm test` (node --test site.test.mjs) checks it without Cloudflare.

/** What a recipe page needs from GET /v1/recipes/:id, normalized by parseRecipe. */
export type Recipe = {
  id: string;
  title: string;
  description: string;
  cuisine: string;
  minutes: number;
  servings: number;
  image: string;
  photos: string[];
  ingredients: { name: string; amount: number; unit: string }[];
  steps: { title: string; text: string }[];
  tags: string[];
  calories: number;
  createdAt: string;
  rating: number;
  reviewCount: number;
  author: { name: string };
};

/** What a public cookbook page needs from GET /v1/cookbooks/:id, normalized by parseCookbook. */
export type Cookbook = {
  id: string;
  name: string;
  description: string;
  owner: { name: string };
  recipeCount: number;
  images: string[];
};

export const siteName = 'Savorly';

/** Recipe ids are UUIDs, or slugs for the fixture recipes. */
export const recipeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

// One sitemap file holds at most 50,000 URLs (sitemaps.org); the home page takes one.
const maxSitemapUrls = 50_000;

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** Escapes text for HTML or XML content and quoted attribute values. */
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => entities[c]);

/**
 * JSON that is safe inside a <script> element: `<`, `>` and `&` become \u escapes, so text such as
 * `</script>` or `<!--` in a recipe can't end the element early. Line and paragraph separators are
 * escaped as well. JSON parsers read the escapes back as the same characters.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** An ISO 8601 duration (`PT1H30M`) for a cooking time in minutes. */
export function isoDuration(minutes: number): string | undefined {
  const total = Math.round(minutes);
  if (!Number.isFinite(total) || total < 1) return undefined;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `PT${hours ? `${hours}H` : ''}${rest ? `${rest}M` : ''}`;
}

/** Shortens text to `max` characters at a word boundary, for meta descriptions. */
export function summary(value: string, max = 160): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?-]+$/, '')}…`;
}

/** The URL if it is an absolute http(s) URL, else undefined (never javascript: or data:). */
export function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The origin of an http(s) URL, such as S3_PUBLIC_URL, or undefined. */
export function originOf(value: unknown): string | undefined {
  const url = typeof value === 'string' ? httpUrl(value.trim()) : undefined;
  return url && new URL(url).origin;
}

const isoDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const recipeUrl = (origin: string, id: string) =>
  `${origin}/recipes/${encodeURIComponent(id)}`;

/**
 * The web export's bundles and assets (`/_expo/static/…`, `/assets/…`) carry a content hash in
 * their file names, so a new version always has a new URL and browsers can keep them for good.
 */
export const isHashedAsset = (pathname: string) =>
  /^\/(?:_expo\/static|assets)\/.*[.-][0-9a-f]{32}\.[A-Za-z0-9]+$/.test(pathname);

/**
 * Whether a path is one of the export's own files (`/_expo/static/…`, `/assets/…`). None of them
 * is a page, so when one is missing (a tab still running an older version asks for a bundle a
 * deploy replaced) the Worker answers 404, not the app shell: the app's chunk loader then fails
 * cleanly instead of trying to run HTML as JavaScript.
 */
export const isExportFile = (pathname: string) => /^\/(?:_expo\/static|assets)\//.test(pathname);

export const cookbookUrl = (origin: string, id: string) =>
  `${origin}/cookbooks/${encodeURIComponent(id)}`;

/** The public cookbook a page URL is for: `/cookbooks/<id>`. */
export function cookbookIdFrom(url: URL): string | undefined {
  const path = /^\/cookbooks\/([^/]+)\/?$/.exec(url.pathname);
  if (!path) return undefined;
  try {
    const id = decodeURIComponent(path[1]);
    return recipeIdPattern.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Reads an API cookbook; anything but a public cookbook with an id and a name is undefined. */
export function parseCookbook(value: unknown): Cookbook | undefined {
  if (!isObject(value) || value.public !== true) return undefined;
  const id = typeof value.id === 'string' ? value.id : '';
  const name = text(value.name);
  if (!recipeIdPattern.test(id) || !name) return undefined;
  const owner = isObject(value.owner) ? value.owner : {};
  const recipes = list(value.recipes).filter(isObject);
  return {
    id,
    name,
    description: text(value.description),
    owner: { name: text(owner.name) },
    recipeCount: count(value.recipeCount) || recipes.length,
    images: [
      ...new Set(recipes.map((r) => httpUrl(text(r.image))).filter((u): u is string => !!u)),
    ],
  };
}

/** A public cookbook page's <head> additions: title, description, canonical link and preview tags. */
export function cookbookHead(cookbook: Cookbook, origin: string): string {
  const url = cookbookUrl(origin, cookbook.id);
  const by = cookbook.owner.name ? ` by ${cookbook.owner.name}` : '';
  const recipes = `${cookbook.recipeCount} recipe${cookbook.recipeCount === 1 ? '' : 's'}`;
  const description = summary(
    cookbook.description || `A cookbook${by} on ${siteName}: ${recipes}.`,
  );
  const photo = cookbook.images[0];
  const image = photo ?? `${origin}/og-image.png`;
  const meta = (attribute: 'name' | 'property', key: string, content: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(content)}">`;
  return [
    `<title>${escapeHtml(`${cookbook.name} — ${siteName}`)}</title>`,
    meta('name', 'description', description),
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    meta('property', 'og:site_name', siteName),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', cookbook.name),
    meta('property', 'og:description', description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image),
    meta('property', 'og:image:alt', photo ? cookbook.name : siteName),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', cookbook.name),
    meta('name', 'twitter:description', description),
    meta('name', 'twitter:image', image),
  ].join('\n');
}

/** The recipe a page URL is for: `/recipes/<id>`, or `/?recipe=<id>` from links shared earlier. */
export function recipeIdFrom(url: URL): string | undefined {
  let id: string | null = null;
  const path = /^\/recipes\/([^/]+)\/?$/.exec(url.pathname);
  if (path) {
    try {
      id = decodeURIComponent(path[1]);
    } catch {
      return undefined;
    }
  } else if (url.pathname === '/') {
    id = url.searchParams.get('recipe');
  }
  return id && recipeIdPattern.test(id) ? id : undefined;
}

/** Reads an API recipe; anything but a published recipe with an id and a title is undefined. */
export function parseRecipe(value: unknown): Recipe | undefined {
  if (!isObject(value) || value.published !== true) return undefined;
  const id = typeof value.id === 'string' ? value.id : '';
  const title = text(value.title);
  if (!recipeIdPattern.test(id) || !title) return undefined;
  const author = isObject(value.author) ? value.author : {};
  return {
    id,
    title,
    description: text(value.description),
    cuisine: text(value.cuisine),
    minutes: count(value.minutes),
    servings: count(value.servings),
    image: text(value.image),
    photos: list(value.photos).map(text).filter(Boolean),
    ingredients: list(value.ingredients)
      .filter(isObject)
      .map((i) => ({ name: text(i.name), amount: count(i.amount), unit: text(i.unit) }))
      .filter((i) => i.name),
    steps: list(value.steps)
      .filter(isObject)
      .map((s) => ({ title: text(s.title), text: text(s.text) }))
      .filter((s) => s.text),
    tags: list(value.tags).map(text).filter(Boolean),
    calories: count(value.calories),
    createdAt: text(value.createdAt),
    rating: count(value.rating),
    reviewCount: count(value.reviewCount),
    author: { name: text(author.name) },
  };
}

const amount = new Intl.NumberFormat('en', { maximumFractionDigits: 2, useGrouping: false });
/** "200 g Pasta", "1 Lemon", or just the name when there is no amount. */
export const ingredientLine = (i: Recipe['ingredients'][number]) =>
  [i.amount > 0 ? amount.format(i.amount) : '', i.unit, i.name].filter(Boolean).join(' ');

const images = (recipe: Recipe) => [
  ...new Set([recipe.image, ...recipe.photos].map(httpUrl).filter((u): u is string => !!u)),
];

/** A schema.org Recipe (https://schema.org/Recipe) for the page's JSON-LD; undefined values drop out. */
export function recipeJsonLd(recipe: Recipe, url: string): Fields {
  const pictures = images(recipe);
  return {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: recipe.title,
    url,
    description: recipe.description || undefined,
    image: pictures.length ? pictures : undefined,
    author: recipe.author.name ? { '@type': 'Person', name: recipe.author.name } : undefined,
    datePublished: isoDate(recipe.createdAt),
    totalTime: isoDuration(recipe.minutes),
    recipeYield: recipe.servings
      ? `${recipe.servings} ${recipe.servings === 1 ? 'serving' : 'servings'}`
      : undefined,
    recipeCuisine: recipe.cuisine || undefined,
    keywords: recipe.tags.length ? recipe.tags.join(', ') : undefined,
    recipeIngredient: recipe.ingredients.map(ingredientLine),
    recipeInstructions: recipe.steps.map((step) => ({
      '@type': 'HowToStep',
      name: step.title || undefined,
      text: step.text,
    })),
    aggregateRating:
      recipe.reviewCount > 0 && recipe.rating > 0
        ? {
            '@type': 'AggregateRating',
            ratingValue: recipe.rating,
            ratingCount: recipe.reviewCount,
            bestRating: 5,
            worstRating: 1,
          }
        : undefined,
    // Calories are per serving in the app.
    nutrition: recipe.calories
      ? { '@type': 'NutritionInformation', calories: `${recipe.calories} calories` }
      : undefined,
  };
}

/**
 * The recipe page's <head> additions: title, description, canonical link, Open Graph and Twitter
 * card tags, and the JSON-LD Recipe. The Worker removes the app shell's defaults for these first.
 */
export function recipeHead(recipe: Recipe, origin: string): string {
  const url = recipeUrl(origin, recipe.id);
  const description = summary(recipe.description || `${recipe.title}, a recipe on ${siteName}.`);
  const photo = images(recipe)[0];
  const image = photo ?? `${origin}/og-image.png`;
  const meta = (attribute: 'name' | 'property', key: string, content: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(content)}">`;
  return [
    `<title>${escapeHtml(`${recipe.title} — ${siteName}`)}</title>`,
    meta('name', 'description', description),
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    meta('property', 'og:site_name', siteName),
    meta('property', 'og:type', 'article'),
    meta('property', 'og:title', recipe.title),
    meta('property', 'og:description', description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image),
    meta('property', 'og:image:alt', photo ? recipe.title : siteName),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', recipe.title),
    meta('name', 'twitter:description', description),
    meta('name', 'twitter:image', image),
    `<script type="application/ld+json">${jsonForScript(recipeJsonLd(recipe, url))}</script>`,
  ].join('\n');
}

/**
 * The sitemap from GET /v1/sitemap ({"recipes": [{"id", "updatedAt"}], "cookbooks": [...]}): the
 * home page, every recipe page and every public cookbook. Undefined when the response doesn't
 * have that shape.
 */
export function sitemapXml(origin: string, data: unknown): string | undefined {
  if (!isObject(data) || !Array.isArray(data.recipes)) return undefined;
  const urls = [`  <url><loc>${escapeHtml(`${origin}/`)}</loc></url>`];
  const add = (entries: unknown, url: (origin: string, id: string) => string) => {
    for (const entry of list(entries)) {
      if (urls.length >= maxSitemapUrls) break;
      if (!isObject(entry) || typeof entry.id !== 'string' || !recipeIdPattern.test(entry.id))
        continue;
      const modified = isoDate(entry.updatedAt);
      urls.push(
        `  <url><loc>${escapeHtml(url(origin, entry.id))}</loc>${
          modified ? `<lastmod>${modified}</lastmod>` : ''
        }</url>`,
      );
    }
  };
  add(data.recipes, recipeUrl);
  add(data.cookbooks, cookbookUrl);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * robots.txt: everything is crawlable in production (including /api, which crawlers that render
 * the app need for its data). Where NOINDEX is set (staging) nothing is, except the app-link
 * files, which Android's link verification fetches.
 */
export function robotsTxt(origin: string, noindex: boolean): string {
  return noindex
    ? 'User-agent: *\nAllow: /.well-known/\nDisallow: /\n'
    : `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/**
 * /.well-known/apple-app-site-association: recipe pages open in the iOS app. `teamId` is the Apple
 * Developer Team ID (10 characters); `appId` the bundle identifier. Undefined unless both are valid.
 */
export function appleAppSiteAssociation(teamId: unknown, appId: unknown) {
  const team = text(teamId);
  const app = text(appId);
  if (!/^[A-Z0-9]{10}$/.test(team) || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app))
    return undefined;
  return {
    applinks: {
      details: [
        {
          appIDs: [`${team}.${app}`],
          components: [
            { '/': '/recipes/*', comment: 'Recipe pages open in the app.' },
            { '/': '/cookbooks/*', comment: 'Public cookbooks open in the app.' },
          ],
        },
      ],
    },
  };
}

/** "ab:cd:…" or "ABCD…" (SHA-256, 32 bytes) as Android expects it: "AB:CD:…". */
function fingerprint(value: string): string | undefined {
  const hex = value.replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(':') : undefined;
}

/** The entries of a comma-separated list that aren't SHA-256 fingerprints. */
export const invalidFingerprints = (fingerprints: unknown) =>
  text(fingerprints)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && !fingerprint(entry));

/**
 * /.well-known/assetlinks.json: lets Android verify the app's https links. `fingerprints` is a
 * comma-separated list of signing certificate SHA-256 fingerprints. Undefined unless the package
 * name and at least one fingerprint are valid; invalid fingerprints are left out.
 */
export function assetLinks(fingerprints: unknown, packageName: unknown) {
  const prints = text(fingerprints)
    .split(',')
    .map(fingerprint)
    .filter((p): p is string => !!p);
  const app = text(packageName);
  if (!prints.length || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(app))
    return undefined;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: app, sha256_cert_fingerprints: prints },
    },
  ];
}

/**
 * The Content-Security-Policy for the app's HTML, from what it loads:
 * - scripts: the bundle; Sign in with Apple JS (SocialButtons.web.tsx); Cloudflare Turnstile; the
 *   Cloudflare Web Analytics beacon when it is on.
 * - styles: react-native-web injects <style> elements and inline styles, so 'unsafe-inline'.
 * - images: the media origin, plus any https: image recipes and avatars already point at, and
 *   data:/blob: for picked, cropped and placeholder images.
 * - media: recipe videos from the media origin, narration audio from /api (same origin), blob:.
 * - fonts: Manrope from the bundle's assets.
 * - connections: /api on the same origin; blob:/data: because uploads read the picked file with
 *   fetch(); the analytics endpoint. Live voice sends its WebRTC offer through /api, and the media
 *   connection itself isn't subject to CSP, so OpenAI needs no entry; Google sign-in is a top-level
 *   redirect, which CSP doesn't cover either.
 * - frames: Turnstile's challenge.
 */
export function contentSecurityPolicy(options: {
  mediaOrigin?: string;
  analytics?: boolean;
  reportUri?: string;
}): string {
  const media = options.mediaOrigin ? [options.mediaOrigin] : [];
  const analytics = options.analytics ?? false;
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      [
        "'self'",
        'https://appleid.cdn-apple.com',
        'https://challenges.cloudflare.com',
        ...(analytics ? ['https://static.cloudflareinsights.com'] : []),
      ],
    ],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", ...media, 'https:', 'data:', 'blob:']],
    ['media-src', ["'self'", ...media, 'blob:']],
    ['font-src', ["'self'"]],
    [
      'connect-src',
      [
        "'self'",
        ...media,
        'blob:',
        'data:',
        ...(analytics ? ['https://cloudflareinsights.com'] : []),
      ],
    ],
    ['frame-src', ['https://challenges.cloudflare.com']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['report-uri', [options.reportUri ?? '/csp-report']],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

const reportValue = (value: unknown): string | number | undefined =>
  typeof value === 'string' && value
    ? value.slice(0, 300)
    : typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;

/**
 * The violations in a CSP report body, each as a few short fields for one log line. Reads the
 * `report-uri` format ({"csp-report": {...}}) and the Reporting API's (a list of
 * {"type": "csp-violation", "body": {...}}).
 */
export function cspReports(value: unknown): Record<string, string | number>[] {
  const out: Record<string, string | number>[] = [];
  for (const entry of (Array.isArray(value) ? value : [value]).slice(0, 20)) {
    if (!isObject(entry)) continue;
    const legacy = isObject(entry['csp-report']) ? entry['csp-report'] : undefined;
    const body = entry.type === 'csp-violation' && isObject(entry.body) ? entry.body : undefined;
    const fields = legacy
      ? {
          directive: legacy['effective-directive'] ?? legacy['violated-directive'],
          blocked: legacy['blocked-uri'],
          document: legacy['document-uri'],
          source: legacy['source-file'],
          line: legacy['line-number'],
          column: legacy['column-number'],
          sample: legacy['script-sample'],
          disposition: legacy.disposition,
        }
      : body
        ? {
            directive: body.effectiveDirective,
            blocked: body.blockedURL,
            document: body.documentURL,
            source: body.sourceFile,
            line: body.lineNumber,
            column: body.columnNumber,
            sample: body.sample,
            disposition: body.disposition,
          }
        : undefined;
    if (!fields) continue;
    const report: Record<string, string | number> = {};
    for (const [key, raw] of Object.entries(fields)) {
      const value = reportValue(raw);
      if (value !== undefined) report[key] = value;
    }
    if (report.directive) out.push(report);
  }
  return out;
}

/**
 * A SHA-256 hex digest of a set of settings, the same whatever their order, so the Worker can tell
 * whether the API container started with the current secrets and vars without storing them.
 */
export async function settingsFingerprint(settings: Record<string, string>): Promise<string> {
  const entries = Object.entries(settings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(entries)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The Cloudflare Web Analytics beacon for a site token, or undefined without a valid token. */
export function analyticsBeacon(token: unknown): string | undefined {
  const value = text(token);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) return undefined;
  const config = escapeHtml(JSON.stringify({ token: value, spa: true }));
  return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${config}"></script>`;
}
