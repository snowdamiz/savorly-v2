import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  ASSETS: Fetcher;
  API: DurableObjectNamespace<SavorlyApi>;
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

function withHeaders(response: Response, env: Env): Response {
  const result = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders)) result.headers.set(key, value);
  // Staging sets NOINDEX so search engines keep to the production site.
  if (env.NOINDEX === 'true') result.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return result;
}

export class SavorlyApi extends Container<Env> {
  defaultPort = 8080;
  // Long enough for queued AI jobs to finish between requests. Jobs interrupted by sleep are
  // marked failed by the API's recovery loop, and video polling resumes on the next start.
  sleepAfter = '30m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    // One canonical host: www redirects to the bare domain.
    if (incoming.hostname.startsWith('www.')) {
      incoming.hostname = incoming.hostname.slice(4);
      return Response.redirect(incoming.toString(), 301);
    }
    if (incoming.pathname.startsWith('/api/')) {
      const forwarded = new Request(
        new URL(incoming.pathname.slice(4) + incoming.search, incoming.origin),
        request,
      );
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
      result.headers.set('Cache-Control', 'no-store');
      return result;
    }
    return withHeaders(await env.ASSETS.fetch(request), env);
  },
};
