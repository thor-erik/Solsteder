/**
 * Web push notifications — subscription management on the client.
 *
 * Architecture overview:
 *   1. `pushInit()` registers the service worker (sw.js at the site root).
 *   2. `pushRequestPermission()` prompts the user for Notification permission,
 *      creates a PushSubscription via the registration, and persists it to the
 *      `push_subscriptions` Supabase table.
 *   3. `pushDisable()` deletes the subscription locally and removes the
 *      DB row so the server stops trying to deliver to it.
 *   4. Server (Supabase edge function — see sql/010-push-subscriptions.sql)
 *      reads the row at push-send time, signs the request with the VAPID
 *      private key, and POSTs to the user's push endpoint.
 *
 * VAPID setup (one-time, per project):
 *   1. Generate a keypair:
 *        npx web-push generate-vapid-keys
 *      Save the PUBLIC key to window.VAPID_PUBLIC_KEY below; keep the
 *      PRIVATE key as a Supabase secret (`supabase secrets set
 *      VAPID_PRIVATE_KEY=...`) — never ship it to the browser.
 *   2. Run sql/010-push-subscriptions.sql to create the table.
 *   3. Deploy the edge function at supabase/functions/send-push (template
 *      in that file's doc block).
 *
 * iOS caveat: web push only works on iOS 16.4+ AND only when the page
 * has been added to the home screen as a PWA. The permission prompt is
 * suppressed in regular Safari tabs on iOS. The capability check below
 * (Notification + PushManager) covers this gracefully — on unsupported
 * browsers `pushIsAvailable()` returns false and the UI hides the
 * toggle entirely.
 */

// Set this when you generate VAPID keys. Leave empty to keep the push
// UI hidden until the project is configured.
const VAPID_PUBLIC_KEY = 'BOAYKO4hXSbw_iaLL80fl-FyoZFET64rfPsklV5znQ3Q1UB1z4MwAkBRRezgAJHw885n90ZiRuszHZLVOMMNrxE';

let _pushRegistration = null;

function pushIsAvailable() {
  // Inside the Capacitor iOS/Android WebView, Notification/PushManager
  // symbols exist but the WebView has no push entitlement — subscription
  // succeeds silently and no notifications are ever delivered. Hide the
  // toggle entirely on native builds until native APN/FCM is wired up.
  if (typeof window !== 'undefined' && window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform()) return false;
  return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window
      && !!VAPID_PUBLIC_KEY;
}

function pushPermissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

async function pushInit() {
  if (!('serviceWorker' in navigator)) return;
  try {
    _pushRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('[push] service worker registration failed:', e.message);
  }
}

/** Request Notification permission, subscribe to the push service, and
 *  persist the subscription server-side. Returns true on success. */
async function pushRequestPermission() {
  if (!pushIsAvailable()) return false;
  if (typeof authCurrentUser !== 'function' || !authCurrentUser()) return false;
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

  await _savePushSubscription(subscription);
  return true;
}

/** Un-subscribe locally + delete the server-side row. */
async function pushDisable() {
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

/** Whether a subscription is currently active in this browser. Used by
 *  the profile panel toggle to display the correct state. */
async function pushIsSubscribed() {
  if (!pushIsAvailable() || !_pushRegistration) return false;
  try {
    const sub = await _pushRegistration.pushManager.getSubscription();
    return !!sub;
  } catch (e) { return false; }
}

async function _savePushSubscription(subscription) {
  if (typeof _supabase === 'undefined') return;
  if (typeof authCurrentUser !== 'function' || !authCurrentUser()) return;
  const json = subscription.toJSON();
  // Upsert by endpoint so re-subscribing on the same device doesn't
  // create duplicate rows. The user_id pins this subscription to the
  // currently-logged-in identity so server-side fan-out is straightforward.
  await _supabase.from('push_subscriptions').upsert({
    user_id:   authCurrentUser().id,
    endpoint:  json.endpoint,
    p256dh:    json.keys && json.keys.p256dh,
    auth:      json.keys && json.keys.auth,
    user_agent: navigator.userAgent || null,
  }, { onConflict: 'endpoint' });
}

/** Close any OS-level push notifications matching the given tag. Used
 *  when the user has interacted with the in-app surface for an event
 *  (opened the bell, tapped a row) so the lock-screen / notification
 *  shade entry doesn't linger after the user has already seen it.
 *
 *  Returns the number of notifications closed. No-op (returns 0) if
 *  the SW isn't available or there's no registration yet — caller can
 *  ignore the return value.
 *
 *  Notification.close() is purely a UI removal; it doesn't send any
 *  signal back to the push service. The push has already been delivered
 *  to this device and is sitting in the notification shade. */
async function pushDismissTag(tag) {
  if (!tag) return 0;
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
  // Each entry: [bell-row id prefix, push tag prefix]. Server trigger
  // sources for the tag side:
  //   sql/032 notify_plan_invite_created   → 'social_plan_invite_<invite_id>'
  //   sql/032 notify_invite_response       → 'social_plan_response_<status>_<plan_id>'
  //   sql/032 notify_plan_cancelled        → 'social_plan_cancelled_<plan_id>'
  //   sql/037 notify_friend_accepted       → 'social_friend_accepted_<friendship_id>'
  //   sql/032 process_plan_reminders       → 'plan_reminder_{creator,invitee}_<plan_id>'
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
 *  shape PushManager.subscribe() expects. */
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
