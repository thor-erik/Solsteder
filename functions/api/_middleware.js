// Cloudflare Pages middleware — runs before every functions/api/* handler.
//
// Adds permissive CORS to all /api/* responses so the native Capacitor app
// can reach these proxies cross-origin. On the web the app is same-origin and
// unaffected; the native WebView is served from Shades://localhost (iOS) /
// https://localhost (Android), where /api/* doesn't exist in the static bundle
// — so js/app.js (window.apiUrl) and js/weather.js point native fetches at
// https://findshades.app/api/*, which requires this Access-Control-Allow-Origin
// header to be readable from the WebView origin.
//
// '*' is safe: every /api/* function returns public, unauthenticated data
// (weather forecast, Google Places lookups, share-link shortening).
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

export async function onRequest(context) {
  const { request, next } = context;

  // Preflight — answered here so it never reaches a handler that would 405 a
  // non-GET/POST method (e.g. /api/shorten gates on method === 'POST').
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Run the matched handler, then graft the CORS header onto its response.
  // Re-wrap so the headers are mutable even when the handler returned an
  // immutable Response (e.g. a streamed met.no / Places photo body).
  const response = await next();
  const wrapped = new Response(response.body, response);
  wrapped.headers.set('Access-Control-Allow-Origin', '*');
  return wrapped;
}
