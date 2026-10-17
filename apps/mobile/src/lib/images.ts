// Width variants of remote photos, so a thumbnail never downloads a full-size cover, and blurred
// previews to show while they load. Unsplash (the sample recipes) resizes through its URL; uploads
// on the media origin go through Cloudflare Image Transformations once
// EXPO_PUBLIC_IMAGE_RESIZE=cloudflare is set for a build whose media domain has them enabled
// (EXPO_PUBLIC_MEDIA_URL, the API's S3_PUBLIC_URL). Every other address is left as it is.

/** The width asked for when nothing better is known. */
export const DEFAULT_IMAGE_WIDTH = 1200;
// A handful of steps instead of every pixel width: each distinct variant is a cache miss on the
// device and at the edge (and a billed transformation at Cloudflare).
const STEPS = [160, 320, 480, 640, 800, 1200, 1600, 2048];

/** The variant width that covers `width` pixels. */
export function variantWidth(width: number) {
  return STEPS.find((step) => step >= width) ?? STEPS[STEPS.length - 1];
}

/** What the build says about uploaded photos: EXPO_PUBLIC_IMAGE_RESIZE and EXPO_PUBLIC_MEDIA_URL. */
export type MediaSetup = { resize?: string; media?: string };
// Written out in full so the build inlines them.
const build: MediaSetup = {
  resize: process.env.EXPO_PUBLIC_IMAGE_RESIZE,
  media: process.env.EXPO_PUBLIC_MEDIA_URL,
};
const unsplash = (url: string) => url.startsWith('https://images.unsplash.com/');
// An upload on the media origin that Cloudflare can transform, as its origin and path.
function transformable(url: string, setup: MediaSetup) {
  if (setup.resize !== 'cloudflare') return null;
  const media = (setup.media || 'https://media.savorly.cooking').replace(/\/+$/, '');
  if (!url.startsWith(media + '/')) return null;
  const origin = /^https?:\/\/[^/]+/.exec(url)?.[0];
  const path = origin ? url.slice(origin.length + 1) : '';
  return origin && path && !path.startsWith('cdn-cgi/') ? { origin, path } : null;
}

/** The address of `url` resized to cover `width` pixels, where its host can resize it. */
export function sized(url: string, width: number, setup: MediaSetup = build): string {
  if (!url || !(width > 0)) return url;
  const w = variantWidth(width);
  if (unsplash(url)) return withQuery(url, { w: String(w), auto: 'format', q: '70' });
  const media = transformable(url, setup);
  if (media) return `${media.origin}/cdn-cgi/image/width=${w},quality=75,format=auto/${media.path}`;
  return url;
}

/**
 * A tiny, blurred copy of `url` to show while the photo itself loads, where its host can make one
 * (the same hosts `sized` resizes on); '' elsewhere. It weighs a few hundred bytes and is cached
 * like any photo, so a card shows the photo's colours at once rather than an empty box.
 */
export function blurred(url: string, setup: MediaSetup = build): string {
  if (!url) return '';
  if (unsplash(url)) return withQuery(url, { w: '32', auto: 'format', q: '30', blur: '200' });
  const media = transformable(url, setup);
  if (media)
    return `${media.origin}/cdn-cgi/image/width=32,quality=30,blur=20,format=auto/${media.path}`;
  return '';
}

// Sets query parameters in place, keeping the others and their order.
function withQuery(url: string, values: Record<string, string>) {
  const hash = url.indexOf('#');
  const fragment = hash < 0 ? '' : url.slice(hash);
  const rest = hash < 0 ? url : url.slice(0, hash);
  const mark = rest.indexOf('?');
  const base = mark < 0 ? rest : rest.slice(0, mark);
  const pending = new Map(Object.entries(values));
  const params = (mark < 0 ? '' : rest.slice(mark + 1))
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const key = pair.split('=')[0];
      const value = pending.get(key);
      if (value === undefined) return pair;
      pending.delete(key);
      return `${key}=${encodeURIComponent(value)}`;
    });
  for (const [key, value] of pending) params.push(`${key}=${encodeURIComponent(value)}`);
  return `${base}?${params.join('&')}${fragment}`;
}
