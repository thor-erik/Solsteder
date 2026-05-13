/**
 * Service worker for web push notifications.
 *
 * Lifecycle:
 *   1. Registered from js/push.js once when the app boots in a secure context.
 *   2. Browser delivers 'push' events here even when the page is closed.
 *   3. 'notificationclick' wakes the app or focuses an existing tab and
 *      opens whatever URL was bundled with the push payload.
 *
 * Push payload shape (sent by the Supabase edge function or your own
 * webhook — see push.js JSDoc for the contract):
 *   {
 *     title: string,
 *     body:  string,
 *     icon?: string,   // absolute URL to a 192x192 PNG
 *     url?:  string,   // relative path or full URL to open on click
 *     tag?:  string,   // dedupe key — same tag replaces the previous toast
 *   }
 */

const ICON_DEFAULT  = '/favicon-192.png';
const BADGE_DEFAULT = '/favicon-192.png';

self.addEventListener('install', (event) => {
  // Activate immediately on first install so the first push after enable
  // doesn't have to wait for the next page navigation.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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
    // renotify=true lets a same-tag push re-buzz the device. Default
    // (false) silently replaces the previous notification's content.
    renotify: !!payload.renotify,
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer focusing an existing app window over opening a new one.
    for (const w of wins) {
      const url = new URL(w.url);
      if (url.origin === self.location.origin) {
        await w.focus();
        // Navigate the existing window if the push asked for a different route.
        if (targetUrl && targetUrl !== '/' && targetUrl !== url.pathname + url.search + url.hash) {
          try { await w.navigate(targetUrl); } catch (e) { /* some browsers block navigate; fall through */ }
        }
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
