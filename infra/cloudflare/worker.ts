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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname.startsWith('/api/')) {
      const forwarded = new Request(
        new URL(incoming.pathname.slice(4) + incoming.search, incoming.origin),
        request,
      );
      forwarded.headers.set(clientIPHeader, request.headers.get('CF-Connecting-IP') ?? '');
      // One instance keeps the API's in-process rate limits and job worker consistent.
      const response = await getContainer(env.API).fetch(forwarded);
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      for (const [key, value] of Object.entries(securityHeaders)) result.headers.set(key, value);
      return result;
    }
    const response = await env.ASSETS.fetch(request);
    const result = new Response(response.body, response);
    for (const [key, value] of Object.entries(securityHeaders)) result.headers.set(key, value);
    return result;
  },
};
