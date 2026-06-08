/**
 * Service worker for Shades.
 *
 * Two responsibilities:
 *   1. Web push fan-out (push + notificationclick events).
 *   2. Offline-capable app shell (install / activate / fetch).
 *
 * Caching strategy:
 *   * App shell (index.html, manifest, icons) — pre-cached at install.
 *   * Own-origin static assets (JS/CSS/images) — cache-first.
 *   * Own-origin data files (data/*.json) — stale-while-revalidate so
 *     the venue + geometry data shows up instantly from cache and
 *     refreshes in the background.
 *   * Cross-origin (Mapbox tiles, Supabase API, etc.) — passthrough.
 *     The browser handles these directly; we don't try to be cleverer
 *     than third-party CDNs about their own cache headers.
 *
 * Cache version: bump CACHE_VERSION on every deploy that changes
 * any cached resource. The activate handler purges old caches so we
 * don't accumulate stale versioned JS forever (each `?v=` query
 * string is a unique cache key under the same domain).
 */

const CACHE_VERSION = '2026-06-08b';
const CACHE_NAME    = `shades-shell-${CACHE_VERSION}`;

// Pre-cache only path-stable resources. Versioned JS/CSS (`?v=...`)
// caches on first fetch and lives in the same cache; we let old
// entries roll off when CACHE_VERSION bumps.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon-192.png',
  '/apple-touch-icon.png',
];

const ICON_DEFAULT  = '/favicon-192.png';
const BADGE_DEFAULT = '/favicon-192.png';

// ── Install: pre-cache the shell ────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // Use individual add() so one missing file doesn't fail the whole
      // install (e.g. apple-touch-icon.png absent on a future trim).
      await Promise.all(APP_SHELL.map(url =>
        cache.add(url).catch(e => console.warn('[sw] shell prefetch miss:', url, e.message))
      ));
    } catch (e) {
      console.warn('[sw] install failed:', e.message);
    }
    self.skipWaiting();
  })());
});

// ── Activate: drop old caches + claim clients ───────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── Fetch routing ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Cross-origin: don't intercept. Mapbox/Supabase/CDNs have their own
  // cache headers and we don't want to second-guess them or break auth.
  if (url.origin !== self.location.origin) return;

  // Navigation (HTML): network-first, fall back to cached index.html so
  // offline launch from home screen still boots the app shell.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put('/index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // data/*.json — stale-while-revalidate. Venue + geometry data is huge
  // and only changes when the GitHub Action publishes a new build; show
  // the cached copy instantly and refresh in the background.
  if (url.pathname.startsWith('/data/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const network = fetch(req).then(resp => {
        if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
        return resp;
      }).catch(() => null);
      return cached || network || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Own-origin static assets (versioned JS/CSS/images): cache-first.
  // The `?v=...` query string busts the cache when the file changes,
  // so cache-first is safe and instant on repeat visits.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const resp = await fetch(req);
      if (resp.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    } catch (e) {
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});

// ── Push notifications ──────────────────────────────────────────────────────
//
// Push payload contract:
//   {
//     title: string,
//     body:  string,
//     icon?: string,   // absolute URL to a 192x192 PNG
//     url?:  string,   // path/URL to open on click
//     tag?:  string,   // dedupe key — same tag replaces the previous toast
//   }

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (e) { payload = { title: 'Shades', body: (event.data && event.data.text()) || '' }; }

  const title = payload.title || 'Shades';
  const options = {
    body:  payload.body || '',
    icon:  payload.icon  || ICON_DEFAULT,
    badge: payload.badge || BADGE_DEFAULT,
    tag:   payload.tag   || 'shades-default',
    renotify: !!payload.renotify,
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Resolve targetUrl to a same-origin path. The send-push edge function
  // (post sql/037) already rejects external URLs at delivery, but a service
  // worker can outlive any backend tightening — a previously-delivered
  // notification still resident on the device could carry a stale targetUrl
  // from before the gate existed. Defense in depth: never openWindow() or
  // navigate() to a cross-origin URL based on push payload alone.
  const raw = (event.notification.data && event.notification.data.url) || '/';
  let safeUrl = '/';
  try {
    const resolved = new URL(raw, self.location.origin);
    if (resolved.origin === self.location.origin) {
      safeUrl = resolved.pathname + resolved.search + resolved.hash;
    }
  } catch (e) { /* malformed — keep default '/' */ }

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      const url = new URL(w.url);
      if (url.origin === self.location.origin) {
        await w.focus();
        if (safeUrl && safeUrl !== '/' && safeUrl !== url.pathname + url.search + url.hash) {
          try { await w.navigate(safeUrl); } catch (e) { /* some browsers block navigate */ }
        }
        return;
      }
    }
    await self.clients.openWindow(safeUrl);
  })());
});
