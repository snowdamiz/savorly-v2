interface Env { ASSETS: Fetcher; API_ORIGIN: string }
interface Fetcher { fetch(request: Request): Promise<Response> }
const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname.startsWith('/api/')) {
      if (!env.API_ORIGIN) return Response.json({ error: 'The kitchen API is not configured.' }, { status: 503 });
      const origin = new URL(env.API_ORIGIN);
      if (origin.protocol !== 'https:') return Response.json({ error: 'The API origin must use HTTPS.' }, { status: 503 });
      const target = new URL(incoming.pathname.slice(4) + incoming.search, origin);
      const forwarded = new Request(target, request);
      // Keep authentication cookies on the same site as the exported Expo application.
      const response = await fetch(forwarded, { redirect: 'manual' });
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
