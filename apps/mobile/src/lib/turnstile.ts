// Cloudflare Turnstile, the check that keeps scripts away from sign-up and password-reset email
// (services/api/internal/app/turnstile.go). The server turns it on by reporting a site key in
// /v1/capabilities; the web renders the widget in the page (Turnstile.web.tsx) and the apps in a
// small web view on the site's own address (Turnstile.tsx), since a site key accepts tokens only
// from the hostnames it lists.
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/

/** Loaded from exactly this address, as Cloudflare requires; rendered explicitly. */
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// Turnstile's own names for the app's languages.
const languages: Record<string, string> = { pt: 'pt-br', zh: 'zh-cn' };

/** Flexible fills a form from 300 points up; a narrower one gets the compact square. */
export const turnstileSize = (width: number) => (width < 300 ? 'compact' : 'flexible');

/**
 * The widget's options. Its mode (managed or invisible) comes from the site key; it shows only
 * when the visitor must interact, as wide as the form, and light like the app.
 */
export const turnstileOptions = (siteKey: string, language: string, size: string) => ({
  sitekey: siteKey,
  theme: 'light',
  size,
  appearance: 'interaction-only',
  language: languages[language] ?? language,
});

/**
 * The page the apps show in their web view. It reports to the app through
 * `window.ReactNativeWebView.postMessage`: `{type: 'token', token}` when the check passes,
 * `{type: 'expired'}` when the token lapses (the widget renews it), `{type: 'error'}`, and
 * `{type: 'height', height}` as the widget appears and goes. `window.resetChallenge()` asks for a
 * fresh token, since each one works once.
 */
export function turnstilePage(siteKey: string, language: string, size: string) {
  // Escaped so nothing in it can close the script element it sits in.
  const options = JSON.stringify(turnstileOptions(siteKey, language, size)).replace(
    /</g,
    '\\u003c',
  );
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}#box{display:flex;justify-content:center}</style>
<script>
function post(message){window.ReactNativeWebView.postMessage(JSON.stringify(message))}
function start(){
  var box=document.getElementById('box');
  new ResizeObserver(function(){post({type:'height',height:box.offsetHeight})}).observe(box);
  var options=${options};
  options.callback=function(token){post({type:'token',token:token})};
  options['expired-callback']=function(){post({type:'expired'})};
  options['timeout-callback']=function(){post({type:'expired'})};
  options['error-callback']=function(){post({type:'error'})};
  var id=turnstile.render(box,options);
  window.resetChallenge=function(){turnstile.reset(id)};
}
</script>
<script src="${TURNSTILE_SCRIPT}?render=explicit&onload=start" async defer onerror="post({type:'error'})"></script>
</head><body><div id="box"></div></body></html>`;
}
