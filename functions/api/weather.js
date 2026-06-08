// Cloudflare Pages Function: /api/weather
//
// Proxies MET Norway's locationforecast/2.0/complete with edge-cached
// 30-min TTL. Eliminates every client doing its own met.no fetch and
// lets us set a single identifying User-Agent (met.no's terms-of-use
// ask for caching + UA identifying the app).
//
// Usage: GET /api/weather?lat=59.9125&lon=10.728
//        Defaults to Oslo if lat/lon omitted.
//
// The response is the unmodified met.no JSON so the client (js/weather.js)
// can keep parsing the same shape.
//
// Notes:
//   * Cache key includes lat/lon — the default (Oslo) is shared across
//     every client, which is the common case.
//   * Lat/lon are validated to sane ranges before hitting met.no so a
//     malformed client request can't pollute the upstream or waste calls.
//   * The §5a server cron uses a separate path (fetch-weather edge
//     function → weather_oslo table) for sun-alert evaluation. These
//     two pipelines are intentionally independent: weather_oslo is a
//     SLIM subset, this proxy returns the FULL met.no payload the
//     client needs (cloud layers, wind, temp, humidity, etc.).

const DEFAULT_LAT = 59.9125;
const DEFAULT_LON = 10.728;

// CORS for the Capacitor WebView origin is added uniformly to every /api/*
// response by functions/api/_middleware.js — no per-response header here.
export async function onRequest(context) {
  const { request } = context;
  try {
    const url = new URL(request.url);
    const latParam = url.searchParams.get('lat');
    const lonParam = url.searchParams.get('lon');

    const lat = latParam == null ? DEFAULT_LAT : parseFloat(latParam);
    const lon = lonParam == null ? DEFAULT_LON : parseFloat(lonParam);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90
     || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return new Response('Bad lat/lon', { status: 400 });
    }

    const metUrl = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;

    const resp = await fetch(metUrl, {
      headers: {
        'User-Agent': 'Shades (https://findshades.app)',
        'Accept':     'application/json',
      },
      // 8s upstream timeout — met.no is usually <1s; we'd rather fail
      // fast than hold a Cloudflare worker open if they're slow.
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      return new Response(`met.no HTTP ${resp.status}`, { status: 502 });
    }

    // Stream the JSON back with a 30-min edge + browser cache. The
    // browser cache prevents a hot reload from re-fetching; the edge
    // cache fans out one met.no call across all clients in the window.
    return new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type':  resp.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'public, max-age=1800, s-maxage=1800',
        // Tell intermediaries to vary on the lat/lon query — though
        // Cloudflare already keys on URL, this signals correctness to
        // anything else in the chain.
        'Vary':          'Accept-Encoding',
      },
    });
  } catch (error) {
    return new Response(`Weather proxy error: ${error.message || error}`, { status: 502 });
  }
}
