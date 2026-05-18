/**
 * Push notifications — subscription management on the client.
 *
 * Single source file for web + native (iOS/Android via Capacitor). Same
 * public API (`pushIsAvailable`, `pushRequestPermission`, `pushDisable`,
 * `pushIsSubscribed`, `pushDismissTag`); the internals branch on
 * `Capacitor.isNativePlatform()` to pick the right delivery channel.
 *
 * Web path:
 *   1. `pushInit()` registers the service worker (sw.js at the site root).
 *   2. `pushRequestPermission()` prompts for Notification permission,
 *      creates a VAPID-keyed PushSubscription via the registration, and
 *      persists it to `push_subscriptions` (platform='web').
 *   3. Server-side `send-push` edge function signs payloads with the VAPID
 *      private key and POSTs to the browser's push endpoint.
 *
 * Native path (iOS APN + Android FCM via @capacitor/push-notifications):
 *   1. `pushInit()` attaches event listeners on the Capacitor plugin.
 *   2. `pushRequestPermission()` calls `PushNotifications.requestPermissions()`
 *      then `PushNotifications.register()` and waits for the `registration`
 *      event to deliver the device token. Persists to `push_subscriptions`
 *      with platform='ios' (apn_token=token) or platform='android'
 *      (fcm_token=token).
 *   3. Server-side `send-push` reads the platform discriminator and POSTs
 *      to api.push.apple.com (signed with the APN .p8) or fcm.googleapis.com
 *      (signed with the FCM service account JWT).
 *
 * VAPID is web-only — it's irrelevant on native. The constant below is
 * checked only on the web path; native availability depends on whether
 * the @capacitor/push-notifications plugin is installed.
 */

const VAPID_PUBLIC_KEY = 'BOAYKO4hXSbw_iaLL80fl-FyoZFET64rfPsklV5znQ3Q1UB1z4MwAkBRRezgAJHw885n90ZiRuszHZLVOMMNrxE';

let _pushRegistration = null;        // web: ServiceWorkerRegistration. null on native.
let _nativeListenersAttached = false; // native: idempotency guard for plugin listeners
let _nativePendingRegister = null;    // native: deferred {resolve, reject} for the
                                      //         current register() awaiting a 'registration'
                                      //         event from the plugin.

// ── Platform detection ──────────────────────────────────────────────────────

function _isNative() {
  return typeof window !== 'undefined' && window.Capacitor &&
         typeof window.Capacitor.isNativePlatform === 'function' &&
         window.Capacitor.isNativePlatform();
}

function _nativePlatform() {
  // Capacitor.getPlatform() → 'ios' | 'android' | 'web'.
  return (typeof window !== 'undefined' && window.Capacitor &&
          typeof window.Capacitor.getPlatform === 'function')
    ? window.Capacitor.getPlatform()
    : 'web';
}

function _nativePushPlugin() {
  return (typeof window !== 'undefined' && window.Capacitor &&
          window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications)
    || null;
}

// ── Public API ──────────────────────────────────────────────────────────────

function pushIsAvailable() {
  if (_isNative()) {
    // Native: depends on the Capacitor PushNotifications plugin being
    // present in the WebView bridge. The plugin is auto-injected by
    // `npx cap sync` when @capacitor/push-notifications is in
    // package.json AND the native target was rebuilt afterwards.
    return !!_nativePushPlugin();
  }
  return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window
      && !!VAPID_PUBLIC_KEY;
}

function pushPermissionState() {
  if (_isNative()) {
    // Plugin permission state is async-only; expose a sync probe based
    // on Notification.permission if the WebView still surfaces it
    // (Capacitor sometimes does), else 'default'. The async truth lives
    // behind pushRequestPermission().
    return (typeof Notification !== 'undefined') ? Notification.permission : 'default';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

async function pushInit() {
  if (_isNative()) {
    const plugin = _nativePushPlugin();
    if (!plugin || _nativeListenersAttached) return;
    _nativeListenersAttached = true;

    // Device token from APN (iOS) or FCM (Android). Fires once after a
    // successful PushNotifications.register() call. The token is the only
    // value we need server-side to address this device.
    plugin.addListener('registration', async (token) => {
      const value = token && token.value;
      try {
        if (value) await _saveNativeSubscription(value);
        if (_nativePendingRegister) _nativePendingRegister.resolve(true);
      } catch (e) {
        if (_nativePendingRegister) _nativePendingRegister.resolve(false);
      } finally {
        _nativePendingRegister = null;
      }
    });

    plugin.addListener('registrationError', (err) => {
      console.warn('[push] native registration error:', err && err.error);
      if (_nativePendingRegister) {
        _nativePendingRegister.resolve(false);
        _nativePendingRegister = null;
      }
    });

    // Foreground push delivery. APN/FCM don't show OS-level UI when the
    // app is in the foreground — the existing in-app toast layer
    // (notifications.js) handles surfacing, identical to how Realtime
    // events flow. Same payload shape so downstream code doesn't care
    // whether the event came from Realtime, polling, or push.
    plugin.addListener('pushNotificationReceived', (notification) => {
      if (typeof window === 'undefined') return;
      // Bubble through the same event the notifications.js evaluator
      // listens for. Notification has {title, body, data, ...}.
      window.dispatchEvent(new CustomEvent('shades:push-received', { detail: notification }));
    });

    // OS notification tapped → app foregrounded. Mirrors what sw.js does
    // for web push in the notificationclick handler: navigate to the
    // payload's url if same-origin, else /.
    plugin.addListener('pushNotificationActionPerformed', (action) => {
      const data = (action && action.notification && action.notification.data) || {};
      const raw = data.url || '/';
      // Same defense-in-depth as sw.js — resolve against our origin and
      // ignore anything cross-origin.
      try {
        const resolved = new URL(raw, location.origin);
        if (resolved.origin === location.origin && location.pathname + location.search !== resolved.pathname + resolved.search) {
          location.assign(resolved.pathname + resolved.search + resolved.hash);
        }
      } catch (e) { /* malformed — stay put */ }
    });

    return;
  }

  // Web path
  if (!('serviceWorker' in navigator)) return;
  try {
    _pushRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('[push] service worker registration failed:', e.message);
  }
}

/** Request permission, subscribe / register, persist server-side.
 *  Returns true on success, false otherwise. */
async function pushRequestPermission() {
  if (!pushIsAvailable()) return false;
  if (typeof authCurrentUser !== 'function' || !authCurrentUser()) return false;

  if (_isNative()) {
    const plugin = _nativePushPlugin();
    if (!plugin) return false;
    if (!_nativeListenersAttached) await pushInit();

    let perm;
    try { perm = await plugin.requestPermissions(); }
    catch (e) { console.warn('[push] requestPermissions failed:', e.message); return false; }
    if (!perm || perm.receive !== 'granted') return false;

    // PushNotifications.register() returns void — the device token arrives
    // asynchronously via the 'registration' event listener attached in
    // pushInit. Set up a deferred so the caller awaits the full round-trip.
    if (_nativePendingRegister) return false; // another register in flight
    const ready = new Promise((resolve) => { _nativePendingRegister = { resolve }; });
    try { await plugin.register(); }
    catch (e) {
      console.warn('[push] native register failed:', e.message);
      _nativePendingRegister = null;
      return false;
    }
    // Safety timeout — if no 'registration' event fires within 15 s,
    // give up so the UI doesn't hang.
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 15000));
    return Promise.race([ready, timeout]);
  }

  // Web path
  if (!_pushRegistration) await pushInit();
  if (!_pushRegistration) return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  let subscription;
  try {
    subscription = await _pushRegistration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await _pushRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
  } catch (e) {
    console.warn('[push] subscribe failed:', e.message);
    return false;
  }

  await _saveWebSubscription(subscription);
  return true;
}

/** Un-subscribe locally + delete the server-side row. */
async function pushDisable() {
  if (_isNative()) {
    const platform = _nativePlatform();
    if (typeof _supabase === 'undefined') return;
    if (typeof authCurrentUser !== 'function' || !authCurrentUser()) return;
    try {
      await _supabase.from('push_subscriptions')
        .delete()
        .eq('user_id', authCurrentUser().id)
        .eq('platform', platform);
    } catch (e) { /* ignore */ }
    // Capacitor doesn't expose a clean "unregister" on iOS — the token
    // stays valid until iOS rotates it. Deleting the DB row stops
    // server-side fan-out, which is the user-visible behavior we need.
    return;
  }

  // Web path
  if (!_pushRegistration) return;
  const subscription = await _pushRegistration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  try { await subscription.unsubscribe(); } catch (e) { /* ignore */ }
  if (typeof _supabase !== 'undefined') {
    try { await _supabase.from('push_subscriptions').delete().eq('endpoint', endpoint); }
    catch (e) { /* ignore */ }
  }
}

/** Whether this device has an active subscription. */
async function pushIsSubscribed() {
  if (!pushIsAvailable()) return false;

  if (_isNative()) {
    // No client-side "is this device registered" call on the Capacitor
    // plugin — the source of truth is our DB row. Query for any row
    // matching this user + platform combination. Imperfect (we don't
    // distinguish multiple devices of the same platform) but accurate
    // for the toggle's purpose: "do I currently get pushes here".
    if (typeof _supabase === 'undefined') return false;
    if (typeof authCurrentUser !== 'function' || !authCurrentUser()) return false;
    try {
      const { count } = await _supabase.from('push_subscriptions')
        .select('id', { head: true, count: 'exact' })
        .eq('user_id', authCurrentUser().id)
        .eq('platform', _nativePlatform());
      return (count || 0) > 0;
    } catch (e) { return false; }
  }

  if (!_pushRegistration) return false;
  try {
    const sub = await _pushRegistration.pushManager.getSubscription();
    return !!sub;
  } catch (e) { return false; }
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function _saveWebSubscription(subscription) {
  if (typeof _supabase === 'undefined') return;
  if (typeof authCurrentUser !== 'function' || !authCurrentUser()) return;
  const json = subscription.toJSON();
  await _supabase.from('push_subscriptions').upsert({
    user_id:    authCurrentUser().id,
    platform:   'web',
    endpoint:   json.endpoint,
    p256dh:     json.keys && json.keys.p256dh,
    auth:       json.keys && json.keys.auth,
    user_agent: navigator.userAgent || null,
  }, { onConflict: 'endpoint' });
}

async function _saveNativeSubscription(token) {
  if (typeof _supabase === 'undefined') return;
  if (typeof authCurrentUser !== 'function' || !authCurrentUser()) return;
  const platform = _nativePlatform(); // 'ios' or 'android'
  const row = {
    user_id:    authCurrentUser().id,
    platform,
    user_agent: navigator.userAgent || null,
  };
  if (platform === 'ios')     row.apn_token = token;
  if (platform === 'android') row.fcm_token = token;
  // Conflict target depends on platform — partial unique indexes on
  // apn_token / fcm_token enforce one-row-per-device.
  const onConflict = (platform === 'ios') ? 'apn_token' : 'fcm_token';
  await _supabase.from('push_subscriptions').upsert(row, { onConflict });
}

// ── Notification dismissal ──────────────────────────────────────────────────
//
// Close any delivered notifications matching the given tag — used when
// the user has interacted with the in-app surface for an event (opened
// the bell, tapped a row) so the lock-screen entry doesn't linger.
//
// Web: SW's getNotifications({tag}).close(). Tag is the SW-side tag.
// Native: Capacitor exposes getDeliveredNotifications() returning the
// full delivered set; we filter by data.tag and call
// removeDeliveredNotifications({notifications: [...]}). Server-side
// puts the same tag string into the APN/FCM payload's data.tag so the
// mapping matches.
async function pushDismissTag(tag) {
  if (!tag) return 0;

  if (_isNative()) {
    const plugin = _nativePushPlugin();
    if (!plugin || typeof plugin.getDeliveredNotifications !== 'function') return 0;
    try {
      const { notifications } = await plugin.getDeliveredNotifications();
      const matching = (notifications || []).filter(n => {
        const t = (n && n.data && n.data.tag) || n.tag;
        return t === tag;
      });
      if (matching.length === 0) return 0;
      await plugin.removeDeliveredNotifications({ notifications: matching });
      return matching.length;
    } catch (e) { return 0; }
  }

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 0;
  try {
    const reg = _pushRegistration || await navigator.serviceWorker.getRegistration();
    if (!reg || typeof reg.getNotifications !== 'function') return 0;
    const notifs = await reg.getNotifications({ tag });
    for (const n of notifs) n.close();
    return notifs.length;
  } catch (e) { return 0; }
}

/** Map a bell-row notif_id (the format public.notifications.notif_id
 *  uses) to the OS push tag the matching server trigger sets. The two
 *  naming conventions are parallel but use different prefixes —
 *  client-side bell rows came first, push tags were added later and
 *  chose a different shape. Both sides carry the same trailing UUID,
 *  so this helper is purely a prefix swap.
 *
 *  Used by auth.js _bellMarkRead + _bellNoteOpened to dismiss the OS
 *  push when the user marks the corresponding bell row as read.
 *  Returns null for ids with no push counterpart (e.g. friend_request
 *  on the recipient side has a separate handling path).
 */
function pushTagForBellId(bellId) {
  if (typeof bellId !== 'string') return null;
  const mappings = [
    ['plan_invite_pending:',    'social_plan_invite_'],
    ['social_invite_accepted_', 'social_plan_response_accepted_'],
    ['social_invite_declined_', 'social_plan_response_declined_'],
    ['plan_cancelled:',         'social_plan_cancelled_'],
    ['friend_accepted:',        'social_friend_accepted_'],
    ['plan_reminder_creator:',  'plan_reminder_creator_'],
    ['plan_reminder_invitee:',  'plan_reminder_invitee_'],
  ];
  for (const [bellPrefix, tagPrefix] of mappings) {
    if (bellId.startsWith(bellPrefix)) {
      return tagPrefix + bellId.substring(bellPrefix.length);
    }
  }
  return null;
}

/** Convert the base64url-encoded VAPID public key into the Uint8Array
 *  shape PushManager.subscribe() expects. Web-path only. */
function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

if (typeof window !== 'undefined') {
  window.pushInit              = pushInit;
  window.pushIsAvailable       = pushIsAvailable;
  window.pushPermissionState   = pushPermissionState;
  window.pushRequestPermission = pushRequestPermission;
  window.pushDisable           = pushDisable;
  window.pushIsSubscribed      = pushIsSubscribed;
  window.pushDismissTag        = pushDismissTag;
  window.pushTagForBellId      = pushTagForBellId;
}
