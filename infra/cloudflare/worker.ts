import { Container, getContainer } from '@cloudflare/containers';
import {
  analyticsBeacon,
  appleAppSiteAssociation,
  assetLinks,
  contentSecurityPolicy,
  cookbookHead,
  cookbookIdFrom,
  cspReports,
  invalidFingerprints,
  isExportFile,
  isHashedAsset,
  isRootApiPath,
  originOf,
  parseCookbook,
  parseRecipe,
  recipeHead,
  recipeIdFrom,
  robotsTxt,
  settingsFingerprint,
  sitemapXml,
} from './site';

interface Env {
  ASSETS: Fetcher;
  API: DurableObjectNamespace<SavorlyApi>;
  // Staging sets NOINDEX so search engines keep to the production site.
  NOINDEX?: string;
  // The media bucket's public URL (a secret the API also uses); the CSP allows its origin.
  S3_PUBLIC_URL?: string;
  // App links (wrangler.jsonc): the iOS bundle identifier and Android package, which are the
  // same; the Apple Developer Team ID (also the API's Sign in with Apple setting); and the
  // Android signing certificates' SHA-256 fingerprints, comma separated.
  MOBILE_APP_ID?: string;
  APPLE_TEAM_ID?: string;
  ANDROID_CERT_SHA256?: string;
  // Cloudflare Web Analytics site token; empty leaves the beacon out.
  CF_ANALYTICS_TOKEN?: string;
  // Wrangler vars and secrets: the Go API's environment.
  [key: string]: unknown;
}
const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
// Must match TRUSTED_PROXY_HEADER in wrangler.jsonc. Always overwritten below, so clients cannot spoof it.
const clientIPHeader = 'X-Savorly-Client-IP';

// Starts after sleeping, a deploy or a host move can outlast the library's 8s/20s defaults.
// Requests wait this long, under the app's 30s request timeout, and then ask it to retry.
const startupWaitMs = 25_000;

// Link previews and crawlers give up after a few seconds, so a recipe page waits this long for
// the API (a cold start takes longer) and otherwise serves the plain app. The lookup carries on
// and fills the cache for the next request.
const recipeWaitMs = 4_000;
const recipeCacheSeconds = 300;
const sitemapCacheSeconds = 3_600;

// The app retries `starting` responses for any request, since they never reached the API.
function starting(): Response {
  const error = 'Savorly is starting up. Please try again in a moment.';
  return Response.json({ error, starting: true }, { status: 503, headers: { 'Retry-After': '1' } });
}

// The request may have reached the API before it went away, so only reads are retried.
function unavailable(): Response {
  const error = 'Savorly is restarting. Please try again in a moment.';
  return Response.json({ error }, { status: 503, headers: { 'Retry-After': '1' } });
}

const isHtml = (response: Response) =>
  response.headers.get('Content-Type')?.includes('text/html') ?? false;

function withHeaders(response: Response, env: Env): Response {
  const result = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders)) result.headers.set(key, value);
  // Report-only for now: violations are logged by /csp-report and nothing is blocked.
  if (isHtml(result))
    result.headers.set(
      'Content-Security-Policy-Report-Only',
      contentSecurityPolicy({
        mediaOrigin: originOf(env.S3_PUBLIC_URL),
        analytics: !!analyticsBeacon(env.CF_ANALYTICS_TOKEN),
      }),
    );
  // Staging sets NOINDEX so search engines keep to the production site.
  if (env.NOINDEX === 'true') result.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return result;
}

const log = (level: 'log' | 'warn', message: string, fields: Record<string, unknown> = {}) =>
  console[level](JSON.stringify({ message, ...fields }));

function plain(body: string, status = 200, cache = 'public, max-age=3600'): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': cache },
  });
}

// An API request from the Worker itself: anonymous (no cookie, so only published content), with
// the visitor's address so the API's per-visitor rate limits still apply.
function api(env: Env, path: string, request?: Request): Promise<Response> {
  const headers = new Headers({ Accept: 'application/json' });
  headers.set(clientIPHeader, request?.headers.get('CF-Connecting-IP') ?? '');
  const url = new URL(path, request?.url ?? 'https://savorly.internal');
  return getContainer(env.API).fetch(new Request(url, { headers }));
}

// Adds a page's own <head> tags in place of the app shell's defaults, and the analytics beacon.
function page(response: Response, env: Env, head?: string): Response {
  const beacon = analyticsBeacon(env.CF_ANALYTICS_TOKEN);
  if (!isHtml(response) || (!head && !beacon)) return response;
  const rewriter = new HTMLRewriter();
  if (head) {
    const remove = { element: (element: Element) => void element.remove() };
    for (const selector of [
      'title',
      'meta[name="description"]',
      'link[rel="canonical"]',
      'meta[property^="og:"]',
      'meta[name^="twitter:"]',
    ])
      rewriter.on(selector, remove);
    rewriter.on('head', { element: (element) => void element.append(head, { html: true }) });
  }
  if (beacon)
    rewriter.on('body', { element: (element) => void element.append(beacon, { html: true }) });
  const result = new Response(rewriter.transform(response).body, response);
  result.headers.delete('Content-Length');
  // The shell's validator no longer describes a page with a recipe in it.
  if (head) result.headers.delete('ETag');
  return result;
}

// What a page's link preview is made of, from the API: a published recipe or a public cookbook.
// Cached briefly; a lookup slower than recipeWaitMs carries on and fills the cache for the next one.
async function pageData<T>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  parse: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  const key = new Request(new URL(`/__page-meta${path}`, request.url));
  try {
    const cached = await caches.default.match(key);
    if (cached) return parse(await cached.json());
  } catch {
    // Ask the API instead.
  }
  const lookup = (async () => {
    const response = await api(env, path, request);
    // 404: unknown, private, or its author is suspended. 503: the API is starting.
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const body = await response.text();
    const data = parse(JSON.parse(body));
    if (data)
      await caches.default.put(
        key,
        new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${recipeCacheSeconds}`,
          },
        }),
      );
    return data;
  })().catch((error: unknown) => {
    log('warn', 'page metadata unavailable', { path, error: String(error) });
    return undefined;
  });
  ctx.waitUntil(lookup);
  return Promise.race([
    lookup,
    new Promise<undefined>((resolve) => setTimeout(resolve, recipeWaitMs)),
  ]);
}

// A recipe page is the app with the recipe's title, description, preview tags and JSON-LD in
// it, for search engines and link previews. Without the recipe (unknown, unpublished, or the API
// is slow or down) it is the plain app, which shows the recipe or its own not-found state.
async function recipePage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  id: string,
): Promise<Response> {
  const [shell, recipe] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL('/', url))),
    pageData(request, env, ctx, `/v1/recipes/${encodeURIComponent(id)}`, parseRecipe),
  ]);
  if (!shell.ok) return shell;
  return page(shell, env, recipe && recipeHead(recipe, url.origin));
}

// A public cookbook's shared link gets its name, description and a recipe photo the same way.
async function cookbookPage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  id: string,
): Promise<Response> {
  const [shell, cookbook] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL('/', url))),
    pageData(request, env, ctx, `/v1/cookbooks/${encodeURIComponent(id)}`, parseCookbook),
  ]);
  if (!shell.ok) return shell;
  return page(shell, env, cookbook && cookbookHead(cookbook, url.origin));
}

async function sitemap(request: Request, env: Env, ctx: ExecutionContext, url: URL) {
  const key = new Request(new URL('/sitemap.xml', url));
  const cached = await caches.default.match(key).catch(() => undefined);
  if (cached) return cached;
  let xml: string | undefined;
  try {
    const response = await api(env, '/v1/sitemap', request);
    if (response.ok) xml = sitemapXml(url.origin, await response.json());
    else {
      await response.body?.cancel();
      log('warn', 'sitemap unavailable', { status: response.status });
    }
  } catch (error) {
    log('warn', 'sitemap unavailable', { error: String(error) });
  }
  // An empty sitemap would tell crawlers the recipes are gone; ask them to come back instead.
  if (!xml) {
    const result = plain('The sitemap is temporarily unavailable.\n', 503, 'no-store');
    result.headers.set('Retry-After', '600');
    return result;
  }
  const result = new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${sitemapCacheSeconds}`,
    },
  });
  ctx.waitUntil(caches.default.put(key, result.clone()));
  return result;
}

// App-link association files: JSON at the exact URL, no redirect, or 404 until configured.
function association(body: unknown, setting: string, value: unknown): Response {
  if (body) return Response.json(body, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  if (typeof value === 'string' && value.trim())
    log('warn', `${setting} is set but not valid, so its app-link file isn't served`);
  return plain('Not found\n', 404, 'no-store');
}

// Browsers POST violations of the report-only CSP here; each becomes one log line in Workers Logs.
async function cspReport(request: Request): Promise<Response> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > 0 && length <= 64 * 1024) {
    try {
      for (const report of cspReports(await request.json())) log('log', 'csp violation', report);
    } catch {
      // Not JSON; nothing to record.
    }
  }
  return new Response(null, { status: 204 });
}

// Everything that isn't /api: static assets and the app, plus the pages the Worker writes itself.
async function site(request: Request, env: Env, ctx: ExecutionContext, url: URL) {
  const read = request.method === 'GET' || request.method === 'HEAD';
  switch (url.pathname) {
    case '/csp-report':
      return request.method === 'POST'
        ? cspReport(request)
        : new Response(null, { status: 405, headers: { Allow: 'POST' } });
    case '/robots.txt':
      if (read) return plain(robotsTxt(url.origin, env.NOINDEX === 'true'));
      break;
    case '/sitemap.xml':
      if (read) return sitemap(request, env, ctx, url);
      break;
    case '/.well-known/apple-app-site-association':
      if (read)
        return association(
          appleAppSiteAssociation(env.APPLE_TEAM_ID, env.MOBILE_APP_ID),
          'APPLE_TEAM_ID',
          env.APPLE_TEAM_ID,
        );
      break;
    case '/.well-known/assetlinks.json':
      if (read) {
        const invalid = invalidFingerprints(env.ANDROID_CERT_SHA256).length;
        if (invalid)
          log('warn', 'ANDROID_CERT_SHA256 has entries that are not SHA-256', { invalid });
        return association(
          assetLinks(env.ANDROID_CERT_SHA256, env.MOBILE_APP_ID),
          'ANDROID_CERT_SHA256',
          env.ANDROID_CERT_SHA256,
        );
      }
      break;
  }
  const recipe = request.method === 'GET' ? recipeIdFrom(url) : undefined;
  if (recipe) return recipePage(request, env, ctx, url, recipe);
  const cookbook = request.method === 'GET' ? cookbookIdFrom(url) : undefined;
  if (cookbook) return cookbookPage(request, env, ctx, url, cookbook);
  const response = await env.ASSETS.fetch(request);
  if (isExportFile(url.pathname) && (response.status === 404 || isHtml(response)))
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  if (response.ok && isHashedAsset(url.pathname)) {
    // Cached for good, so repeat visits skip them and expo-font reuses the preloaded fonts
    // (scripts/web-postbuild.mjs) instead of fetching them again.
    const result = new Response(response.body, response);
    result.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return result;
  }
  return page(response, env);
}

// Keeps the API container awake during the day (the cron triggers in wrangler.jsonc), so the
// first visitor after a quiet spell doesn't wait for a cold start, and restarts it when its
// secrets or vars changed since it started. See docs/DEPLOYMENT.md#cold-starts.
async function warmUp(env: Env): Promise<void> {
  try {
    if (await getContainer(env.API).restartIfSettingsChanged()) {
      log('log', 'restarting the API for changed settings');
      // It finishes in-flight requests for up to 10 s and exits; the ping below starts it again.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    const response = await api(env, '/health');
    await response.body?.cancel();
    if (!response.ok) log('warn', 'warm-up ping failed', { status: response.status });
  } catch (error) {
    log('warn', 'warm-up ping failed', { error: String(error) });
  }
}

// Settings only the Worker uses; changing them shouldn't restart the API.
const workerOnly = new Set(['MOBILE_APP_ID', 'ANDROID_CERT_SHA256', 'CF_ANALYTICS_TOKEN']);
// A hash of the settings the running container started with (never the values themselves).
const startedSettings = 'started-settings';

export class SavorlyApi extends Container<Env> {
  defaultPort = 8080;
  // Long enough for queued AI jobs to finish between requests. Jobs interrupted by sleep are
  // marked failed by the API's recovery loop, and video polling resumes on the next start.
  sleepAfter = '30m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !workerOnly.has(entry[0]),
      ),
    );
  }

  override async onStart(): Promise<void> {
    await this.ctx.storage.put(startedSettings, await settingsFingerprint(this.envVars ?? {}));
  }

  // A running container keeps the environment it started with, and a deploy that doesn't change
  // the image leaves it running, so new secrets or vars would wait for it to sleep, which the
  // daytime warm-up delays until night. The warm-up calls this instead: when the settings
  // differ, the API is stopped (SIGTERM; requests in flight get 10 s) and starts again with them.
  async restartIfSettingsChanged(): Promise<boolean> {
    // Not while it is starting: onStart records its settings once it is ready.
    if (!this.ctx.container?.running || (await this.getState()).status !== 'healthy') return false;
    const current = await settingsFingerprint(this.envVars ?? {});
    const started = await this.ctx.storage.get<string>(startedSettings);
    if (started === current) return false;
    if (started === undefined) {
      // Started before this check existed; take its settings to be the current ones.
      await this.ctx.storage.put(startedSettings, current);
      return false;
    }
    await this.stop();
    return true;
  }

  // Waits out a cold start before forwarding, instead of the library's quick plain-text failure.
  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container?.running || (await this.getState()).status !== 'healthy') {
      try {
        await this.startAndWaitForPorts({
          ports: this.defaultPort,
          cancellationOptions: {
            abort: request.signal,
            instanceGetTimeoutMS: startupWaitMs,
            portReadyTimeoutMS: startupWaitMs,
          },
        });
      } catch {
        // The start continues; the app's retry finds it further along.
        return starting();
      }
    }
    return this.containerFetch(request);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const incoming = new URL(request.url);
    // One canonical host: www redirects to the bare domain.
    if (incoming.hostname.startsWith('www.')) {
      incoming.hostname = incoming.hostname.slice(4);
      return Response.redirect(incoming.toString(), 301);
    }
    // The assistants' paths (isRootApiPath) reach the API as they are; the app's under /api.
    const rootApi = isRootApiPath(incoming.pathname);
    if (rootApi || incoming.pathname.startsWith('/api/')) {
      const path = rootApi ? incoming.pathname : incoming.pathname.slice(4);
      const forwarded = new Request(new URL(path + incoming.search, incoming.origin), request);
      forwarded.headers.set(clientIPHeader, request.headers.get('CF-Connecting-IP') ?? '');
      let response: Response;
      try {
        // One instance keeps the API's in-process rate limits and job worker consistent.
        response = await getContainer(env.API).fetch(forwarded);
      } catch {
        // The Durable Object was reset mid-request, as happens when a deploy replaces it.
        response = unavailable();
      }
      // The API always answers errors in JSON; anything else is a plain-text platform error.
      if (
        response.status >= 400 &&
        !response.headers.get('Content-Type')?.includes('application/json')
      ) {
        response = unavailable();
      }
      const result = withHeaders(response, env);
      // Only the discovery documents say they may be kept a while.
      if (!rootApi || !result.headers.has('Cache-Control'))
        result.headers.set('Cache-Control', 'no-store');
      return result;
    }
    return withHeaders(await site(request, env, ctx, incoming), env);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(warmUp(env));
  },
} satisfies ExportedHandler<Env>;
