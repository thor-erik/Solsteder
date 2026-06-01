// ── Smart Notification System ──────────────���──────────────────────────────────
// Priority-queued toasts: weather, social, suggestions, onboarding, login/engagement.
// One toast at a time. P0 preempts lower priority. Session rate-limited.

// ── Constants ───────────────────────────────────────────���────────────────────

const _NOTIF_STORAGE_STATE    = 'solsteder_notif_state';
const _NOTIF_STORAGE_SETTINGS = 'solsteder_notif_settings';
const _NOTIF_MAX_EARLY        = 1;      // max toasts in first window after grace
const _NOTIF_EARLY_WINDOW     = 30000;  // 30s initial slow window (after grace)
const _NOTIF_GRACE_PERIOD     = 4000;   // no queued toasts for 4s after init
const _NOTIF_COOLDOWN         = 120000; // 2 min between toasts
const _NOTIF_EVAL_INTERVAL    = 60000;  // re-evaluate every 60s
const _NOTIF_AUTO_P0          = 8000;   // P0 auto-dismiss
const _NOTIF_AUTO_DEFAULT     = 6000;   // other auto-dismiss
const _NOTIF_LEGACY_DISMISS   = 2200;   // legacy _showToast timing

// App-wide kill-switch. Categories listed here are blocked even if the user
// has them enabled in settings, and their toggles are hidden in the profile
// panel. `suggestion` and `login` are retained as a guard — the evaluators
// for those categories were removed (see audit 2026-05-18), so nothing fires
// for them today; the entries here prevent stray re-introductions.
const _NOTIF_DISABLED_CATEGORIES = new Set(['suggestion', 'login']);

// ── Mutable State ─────────────────────────────────────────────��──────────────

let _notifQueue         = [];         // sorted by priority then FIFO
let _notifDismissed     = new Set();  // ids dismissed this session
let _notifCurrent       = null;       // currently shown notification object
let _notifShownCount    = 0;
let _notifLastShownAt   = 0;
let _notifSessionStart  = Date.now();
let _notifAutoTimer     = null;
let _notifLoginShown    = new Set();  // login prompt ids shown this session
let _notifInitDone      = false;
let _notifEvalTimer     = null;

// iOS WKWebView (Capacitor) doesn't reach Apple Color Emoji via font
// fallback for many emoji codepoints — even with VS-16 and an explicit
// `font-family: 'Apple Color Emoji'` declaration. Toasts that use emoji
// icons render them as tofu (the square-with-question-mark glyph). We
// route the known-broken icons through inline SVG so the toast always
// has something to draw.
//
// Add new entries here as users hit additional tofu icons. Each entry
// returns SVG markup; .notif-toast-icon's `svg { width: 18px }` rule in
// index.html sizes them. SVGs use currentColor so they pick up the
// notification's text tone.
function _wxEmojiToSvg(icon) {
  if (typeof icon !== 'string' || !icon) return null;
  // Weather (delegated to weather.js — colored SVG sun/cloud compositions).
  if (typeof skyIconSvg === 'function' && typeof rainIconSvg === 'function') {
    if (icon.includes('🌧') || icon.includes('🌦')) return rainIconSvg();
    if (icon.includes('☀'))                          return skyIconSvg(0.0);
    if (icon.includes('🌤'))                          return skyIconSvg(0.3);
    if (icon.includes('⛅'))                          return skyIconSvg(0.5);
    if (icon.includes('🌥'))                          return skyIconSvg(0.7);
    if (icon.includes('☁'))                          return skyIconSvg(0.9);
  }
  // Social / system icons — monochrome line SVGs in currentColor.
  if (icon.includes('👋')) return _notifSvgWave();
  if (icon.includes('📍')) return _notifSvgPin();
  return null;
}

function _notifSvgPin() {
  // Lucide "map-pin" — check-in / location notifications.
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z"/>`
    + `<circle cx="12" cy="10" r="3"/>`
    + `</svg>`;
}

function _notifSvgWave() {
  // Lucide-style "users" glyph — two overlapping people. More semantically
  // appropriate than a wave hand for "friends are at venue" notifications:
  // the row is about who's there, not a greeting. (Renamed in spirit
  // only — _notifGetSocialSvg keys on '👋' and we keep the function name
  // to avoid touching call sites.)
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>`
    + `<circle cx="9" cy="7" r="4"/>`
    + `<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>`
    + `<path d="M16 3.13a4 4 0 0 1 0 7.75"/>`
    + `</svg>`;
}

// ── localStorage Helpers ─────────��───────────────────────────────────────────

function _notifLoadState() {
  try { return JSON.parse(localStorage.getItem(_NOTIF_STORAGE_STATE) || '{}'); } catch { return {}; }
}

function _notifSaveState(state) {
  try { localStorage.setItem(_NOTIF_STORAGE_STATE, JSON.stringify(state)); } catch { /* ignore */ }
}

function _notifGetSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(_NOTIF_STORAGE_SETTINGS) || 'null'); } catch { /* ignore */ }
  // Defaults. The 'alert' category covers user-opted-in per-venue sun alerts
  // and plan reminders — defaults ON because the user explicitly subscribed.
  // 'weather' defaults ON now that the loud evaluators (lunch, wind) are gone
  // and the survivors (cloud/sunset/rain) have real actions + a 2-min
  // cooldown. Suggestion/login are vestigial — no evaluators feed them, kept
  // so older persisted settings still parse cleanly.
  const defaults = { alert: true, weather: true, social: true, suggestion: true, login: true };
  if (!s) return defaults;
  // Merge so new categories get their default when a user has an older saved
  // settings blob in localStorage.
  return { ...defaults, ...s };
}

function _notifSaveSettings(settings) {
  try { localStorage.setItem(_NOTIF_STORAGE_SETTINGS, JSON.stringify(settings)); } catch { /* ignore */ }
  // Sync to Supabase for logged-in users
  if (typeof saveUserPreference === 'function' && typeof _currentUser !== 'undefined' && _currentUser) {
    saveUserPreference('notif_prefs', settings);
  }
}

// ── Queue Operations ─────────────��────────────────────────────���──────────────

function _notifEnqueue(notif) {
  if (_notifDismissed.has(notif.id)) return;
  // Single-task focus: suppress ambient toasts entirely while the admin is in
  // audit or polygon-edit mode. The bell inbox still records them server-side.
  if (typeof document !== 'undefined' && document.body
      && (document.body.classList.contains('audit-mode')
          || document.body.classList.contains('edit-mode'))) return;
  // If a notif with the same id is already in the queue, REPLACE it
  // rather than drop the new one. Aggregating evaluators (e.g.
  // _evalInviteAccepted, _evalInviteDeclined) produce a fresher notif
  // on each cycle as new acceptors/decliners come in — dropping the
  // new one would lock the queue to the stale bodyVars. The freshest
  // copy wins so the toast (when it eventually shows) and bell entry
  // both reflect the latest count + newest acceptor name.
  if (notif.dedupe) {
    const existingIdx = _notifQueue.findIndex(n => n.id === notif.id);
    if (existingIdx >= 0) {
      notif._queuedAt = _notifQueue[existingIdx]._queuedAt || Date.now();
      _notifQueue[existingIdx] = notif;
      return;
    }
  }
  if (_notifCurrent && _notifCurrent.id === notif.id) return;
  notif._queuedAt = Date.now();
  // Insert sorted: lower priority number first, then FIFO
  let i = _notifQueue.findIndex(n => n.priority > notif.priority);
  if (i === -1) i = _notifQueue.length;
  _notifQueue.splice(i, 0, notif);
}

function _notifDequeue() {
  while (_notifQueue.length) {
    const notif = _notifQueue.shift();
    if (notif.ttl && Date.now() - notif._queuedAt > notif.ttl) continue; // expired
    if (_notifDismissed.has(notif.id)) continue;
    return notif;
  }
  return null;
}

function _notifCanShow(notif) {
  // Visual-conflict gates: always apply regardless of urgency. Showing
  // a toast on top of an open panel is just bad UX, even for P0 events.
  const pp = document.getElementById('profile-panel');
  if (pp && pp.classList.contains('open')) return false;
  if (document.body.classList.contains('plan-preview-active')) return false;
  if (document.body.classList.contains('post-accept-active'))  return false;
  if (document.body.classList.contains('invite-sheet-open'))   return false;
  if (document.body.classList.contains('profile-panel-open'))  return false;
  if (document.body.classList.contains('bell-open'))           return false;

  // Time-based rate limits: skipped for "urgent" notifs. Urgent means the
  // event has a push-notification counterpart (incoming-invite, accept,
  // decline, friend-request) — the OS push has already grabbed the
  // user's attention. The rate limit was designed for cold-start ambient
  // toasts ("3 friends are at Grunerhaven") that the user hadn't asked
  // to see yet. Push-driven events should surface live, not "after a
  // little while".
  if (notif && notif.urgent) return true;

  // Grace period: no queued toasts for first 4s (lets user orient)
  const elapsed = Date.now() - _notifSessionStart;
  if (elapsed < _NOTIF_GRACE_PERIOD) return false;
  // Rate limit: max 1 in first 30s after grace, then 2-min cooldown
  if (elapsed < _NOTIF_GRACE_PERIOD + _NOTIF_EARLY_WINDOW) return _notifShownCount < _NOTIF_MAX_EARLY;
  return !_notifLastShownAt || (Date.now() - _notifLastShownAt) > _NOTIF_COOLDOWN;
}

// Cross-tab dedup: when the user has the app open in multiple tabs,
// each tab runs its own evaluators and would otherwise fire the same
// toast independently. localStorage acts as a shared signal — before
// showing, we check whether ANY tab has shown this notif id in the
// last 60s. After showing, we stamp the same key so the other tabs
// see it and skip. 60s window covers the realistic case of two tabs
// catching the same realtime event simultaneously.
const _NOTIF_CROSSTAB_TTL_MS = 60 * 1000;
function _notifWasShownInOtherTab(id) {
  try {
    const raw = localStorage.getItem('solsteder_notif_shown:' + id);
    if (!raw) return false;
    const t = parseInt(raw, 10);
    return Number.isFinite(t) && (Date.now() - t) < _NOTIF_CROSSTAB_TTL_MS;
  } catch { return false; }
}
function _notifMarkShownGlobal(id) {
  try { localStorage.setItem('solsteder_notif_shown:' + id, String(Date.now())); }
  catch { /* localStorage full / disabled — fail open */ }
}

function _notifAdvance() {
  if (_notifCurrent) return; // one at a time
  // Peek the queue head BEFORE the canShow gate so urgent notifs can
  // bypass the rate-limit checks (rate-limit decisions depend on the
  // specific notif — see _notifCanShow(notif)). Iterative skip of
  // items already shown in another tab; each pass shifts the queue.
  while (_notifQueue.length) {
    const head = _notifQueue[0];
    if (!_notifCanShow(head)) return;
    const notif = _notifDequeue();
    if (!notif) return; // should not happen given the length check
    if (_notifWasShownInOtherTab(notif.id)) {
      if (typeof _bellRecord === 'function') _bellRecord(notif);
      continue;
    }
    _notifMarkShownGlobal(notif.id);
    _notifShow(notif);
    return;
  }
}

// ── Toast UI ──────────────────────────────────────────��──────────────────────

/** Wire swipe-to-dismiss on the toast. Locks to the dominant axis on first
 *  movement (no diagonal drags). Swiping past SWIPE_THRESHOLD on the locked
 *  axis triggers the dismiss; otherwise the toast snaps back. */
function _wireNotifSwipe(el, notif) {
  if (el._swipeWired) return;
  el._swipeWired = true;
  const SWIPE_THRESHOLD = 60;
  const AXIS_LOCK_PX   = 6;   // movement before we commit to an axis
  let startX = 0, startY = 0, dragging = false;
  let axis = null;            // null | 'x' | 'y'
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    dragging = true;
    axis = null;
    el.classList.add('notif-dragging');
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // Lock to the dominant axis once the user has moved past AXIS_LOCK_PX.
    if (!axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    }
    if (axis === 'x') {
      el.style.transform = `translateX(${dx}px)`;
      el.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 180));
    } else {
      // Vertical axis: only honor upward drags; downward is a no-op.
      const dyClamped = Math.min(0, dy);
      el.style.transform = `translateY(${dyClamped}px)`;
      el.style.opacity = String(Math.max(0.3, 1 - Math.abs(dyClamped) / 180));
    }
  }, { passive: true });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('notif-dragging');
    const t = e.changedTouches?.[0];
    if (!t) { el.style.transform = ''; el.style.opacity = ''; axis = null; return; }
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const horizontal = axis === 'x' && Math.abs(dx) > SWIPE_THRESHOLD;
    const upward     = axis === 'y' && dy < -SWIPE_THRESHOLD;
    if (horizontal || upward) {
      // Commit dismiss with a fly-out. Pin the wrap (transform locked to
      // translateY(0) + opacity-only transition via .swipe-dismissing) so
      // removing .show in _notifDismiss can't trigger an upward slide.
      // Leave the inner toast's translated transform AND the wrap's
      // .swipe-dismissing class IN PLACE after dismiss — they get cleared
      // in _notifShow before the next notification renders. This avoids
      // a "snap back to center" frame between the fly-out and disappearance.
      const wrap = document.getElementById('notif-toast-wrap');
      if (wrap) wrap.classList.add('swipe-dismissing');
      el.classList.add('notif-dismissing');
      let elTransform;
      if (horizontal) elTransform = `translateX(${dx > 0 ? '120%' : '-120%'})`;
      else            elTransform = `translateY(-120%)`;
      el.style.transform = elTransform;
      el.style.opacity = '0';
      if (typeof _aTrack === 'function' && !notif.noAnalytics) _aTrack('notification_dismiss', {
        id: notif.id, priority: notif.priority, category: notif.category, method: 'swipe',
      });
      setTimeout(() => { _notifDismiss(notif.id); }, 240);
    } else {
      // Snap back
      el.style.transition = 'transform 0.18s ease-out, opacity 0.18s ease-out';
      el.style.transform = '';
      el.style.opacity = '';
      setTimeout(() => { el.style.transition = ''; }, 200);
    }
    axis = null;
  };
  el.addEventListener('touchend', finish, { passive: true });
  el.addEventListener('touchcancel', finish, { passive: true });
}

function _notifEnsureEl() {
  let el = document.getElementById('notif-toast');
  if (el) return el;
  const wrap = document.getElementById('notif-toast-wrap');
  if (!wrap) return null;
  el = document.createElement('div');
  el.id = 'notif-toast';
  el.innerHTML = `
    <div class="notif-toast-icon"></div>
    <div class="notif-toast-content">
      <div class="notif-toast-body"></div>
    </div>
    <button class="notif-toast-action"></button>
    <button class="notif-toast-close" aria-label="Dismiss">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>`;
  wrap.appendChild(el);
  return el;
}

function _notifStartAutoDismissTimer(notif) {
  clearTimeout(_notifAutoTimer);
  const duration = notif._legacyDismiss || (notif.priority === 0 ? 30000 : _NOTIF_AUTO_DEFAULT);
  _notifAutoTimer = setTimeout(() => {
    if (typeof _aTrack === 'function' && _notifCurrent && !_notifCurrent.noAnalytics) _aTrack('notification_dismiss', {
      id: _notifCurrent.id, priority: _notifCurrent.priority, category: _notifCurrent.category, method: 'auto'
    });
    _notifHide();
  }, duration);
}

function _notifInvokeAction(notif) {
  try { notif.action(); }
  catch (e) { console.warn('[notif] action threw:', notif.id, e); }
  if (typeof _aTrack === 'function' && !notif.noAnalytics) _aTrack('notification_action', {
    id: notif.id, priority: notif.priority, category: notif.category,
  });
  _notifHide();
}

function _notifShow(notif) {
  _notifCurrent = notif;
  const el = _notifEnsureEl();

  // Clear residual swipe-dismiss state from a previous toast so the new one
  // renders at the proper position with the default slide-down animation.
  if (el) {
    el.classList.remove('notif-dismissing');
    el.style.transform = '';
    el.style.opacity = '';
  }
  const wrapForReset = document.getElementById('notif-toast-wrap');
  if (wrapForReset) wrapForReset.classList.remove('swipe-dismissing');

  // Icon — supports either an emoji/text glyph (notif.icon) OR raw SVG
  // markup (notif.iconHtml). iconHtml wins; falls back to text.
  //
  // Weather emoji (☀ ☁ 🌤 🌥 🌧 🌦) have text-default Unicode presentation
  // and iOS WKWebView doesn't reach Apple Color Emoji via font fallback
  // even with VS-16 → they render as tofu. Re-route those to inline SVG.
  const iconEl = el.querySelector('.notif-toast-icon');
  const wxSvg = notif.icon ? _wxEmojiToSvg(notif.icon) : null;
  if (notif.iconHtml)     { iconEl.innerHTML = notif.iconHtml; iconEl.style.display = ''; }
  else if (wxSvg)         { iconEl.innerHTML = wxSvg;          iconEl.style.display = ''; }
  else if (notif.icon)    { iconEl.textContent = notif.icon;   iconEl.style.display = ''; }
  else                    { iconEl.style.display = 'none'; }

  // Body text — support raw text (legacy) or i18n
  const bodyEl = el.querySelector('.notif-toast-body');
  if (notif._rawText) {
    bodyEl.textContent = notif._rawText;
  } else {
    bodyEl.textContent = t(notif.bodyKey, notif.bodyVars || {});
  }

  // Action button
  const actionBtn = el.querySelector('.notif-toast-action');
  if (notif.actionKey && notif.action) {
    actionBtn.textContent = t(notif.actionKey, notif.bodyVars || {});
    actionBtn.style.display = '';
    actionBtn.onclick = () => _notifInvokeAction(notif);
  } else {
    actionBtn.style.display = 'none';
  }

  // Close button
  el.querySelector('.notif-toast-close').onclick = () => {
    if (typeof _aTrack === 'function' && !notif.noAnalytics) _aTrack('notification_dismiss', { id: notif.id, priority: notif.priority, category: notif.category, method: 'close' });
    _notifDismiss(notif.id);
  };

  // Tap on body area also triggers action (if available) for easy mobile use
  el.querySelector('.notif-toast-content').onclick = () => {
    if (notif.action) _notifInvokeAction(notif);
  };

  // Swipe-to-dismiss: up / left / right past 60px commits a dismiss with
  // a fly-out animation. Below threshold the toast snaps back. Vertical
  // down does nothing (don't conflict with native pull-to-refresh).
  _wireNotifSwipe(el, notif);

  const wrap = document.getElementById('notif-toast-wrap');
  if (wrap) {
    wrap.classList.add('show');
    // Publish the toast height as --notif-h so the desktop layout can shift the
    // venue list down by the actual height (CSS rule in index.html that reads
    // body:has(#notif-toast-wrap.show) #panel { top: calc(70px + --notif-h + 8px) }).
    requestAnimationFrame(() => {
      const h = wrap.offsetHeight || 0;
      document.documentElement.style.setProperty('--notif-h', h + 'px');
    });
  }
  _notifShownCount++;
  _notifLastShownAt = Date.now();

  // noAnalytics notifs are suppressed from the events sink entirely. Used by
  // social_checkin: it only fires when the device is within 100m of a venue,
  // so logging even its id server-side would persist a location-derived signal.
  // Keep this guard — removing it re-introduces that signal into events.
  if (typeof _aTrack === 'function' && !notif.noAnalytics) _aTrack('notification_shown', {
    id: notif.id, priority: notif.priority, category: notif.category, queue_depth: _notifQueue.length
  });

  // Per-notification _onShow hook (used by social_invite_accepted to persist
  // dedupe, and by bell-only evaluators to stamp per-day state).
  if (typeof notif._onShow === 'function') {
    try { notif._onShow(); }
    catch (e) { console.warn('[notif] _onShow threw:', notif.id, e); }
  }
  if (typeof _bellRecord === 'function') _bellRecord(notif);

  _notifStartAutoDismissTimer(notif);
}

function _notifHide() {
  clearTimeout(_notifAutoTimer);
  const wrap = document.getElementById('notif-toast-wrap');
  if (wrap) wrap.classList.remove('show');
  document.documentElement.style.setProperty('--notif-h', '0px');
  _notifCurrent = null;
  // Try the next queued toast mid-fade-out (the wrap's CSS opacity
  // transition is 300 ms). v1 waited a full 400 ms after starting
  // fade-out, then triggered another 300 ms fade-in — total ~1 s of
  // dead air between consecutive toasts that read as a glitch, not
  // pacing. 150 ms hand-off interrupts the fade-out around half-way,
  // _notifShow updates the toast contents in place (one DOM node,
  // reused), and the .show class re-triggers the opacity transition
  // upward → reads as a smooth morph from one toast to the next.
  setTimeout(() => _notifAdvance(), 150);
}

// Pause auto-dismiss while a blocking overlay (e.g. full-screen login) is up.
// On resume, restart the timer with a full duration so the user has time to read
// the notification once the overlay is closed.
function notifFreezeAutoDismiss() {
  if (_notifAutoTimer) {
    clearTimeout(_notifAutoTimer);
    _notifAutoTimer = null;
  }
}

function notifResumeAutoDismiss() {
  if (!_notifCurrent || _notifAutoTimer) return;
  _notifStartAutoDismissTimer(_notifCurrent);
}

window.notifFreezeAutoDismiss = notifFreezeAutoDismiss;
window.notifResumeAutoDismiss = notifResumeAutoDismiss;

function _notifDismiss(id) {
  _notifDismissed.add(id);
  if (_notifCurrent && _notifCurrent.id === id) _notifHide();
  else _notifQueue = _notifQueue.filter(n => n.id !== id);
}

/** Immediate show — bypasses queue and rate limiter. For legacy _showToast compat. */
function _notifShowImmediate(notif) {
  // Block all notifications until the intro sequence has finished
  if (!_notifInitDone) return;
  if (_notifCurrent) _notifHide();
  _notifShow(notif);
}

// ── Suspend / resume around search ───────────────────────────────────────────

let _notifSuspended = null;

function _notifSuspendForSearch() {
  if (!_notifCurrent || _notifSuspended) return;
  _notifSuspended = { notif: _notifCurrent };
  clearTimeout(_notifAutoTimer);
  const wrap = document.getElementById('notif-toast-wrap');
  if (wrap) wrap.classList.remove('show');
}

function _notifResumeAfterSearch() {
  if (!_notifSuspended) return;
  const { notif } = _notifSuspended;
  _notifSuspended = null;
  if (!_notifCurrent || _notifCurrent.id !== notif.id) return;
  const wrap = document.getElementById('notif-toast-wrap');
  if (wrap) wrap.classList.add('show');
  _notifStartAutoDismissTimer(notif);
}

// ── Evaluators: P0 Alerts (user-opted-in) ────────────────────────────────────

/**
 * Sun-hits-alerted-venue. Fires when a venue the user explicitly subscribed
 * to (via the bell button on the venue detail) is about to be hit by sun
 * within its configured lead time (default 30 min from sql/004-sun-alerts.sql).
 *
 * Dedupe is per (date, venueId, windowStart) and persisted to localStorage so
 * the alert fires exactly once per sun window across sessions/tabs. Once-per-
 * window is the right granularity: a venue with sun 10:00–11:30 + 13:00–14:30
 * should get two alerts on the same day, not one.
 */
function _evalSunAlerts() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _alertsMap === 'undefined' || !_alertsMap.size) return null;
  if (typeof VENUES === 'undefined' || !VENUES) return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  // Alerts are about real-time arrival, so only fire while viewing today.
  if (datePicker.value !== todayStr()) return null;

  const dateStr = todayStr();
  const now = currentHour();
  const KEY = 'solsteder_sun_alert_fired';
  let fired = {};
  try { fired = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}

  // Weather gate — same pattern as _firstSunWindowStartForVenue (app.js:3622).
  // Without this an alert fires whenever the sun would GEOMETRICALLY hit the
  // venue, regardless of whether it'll be raining/overcast at the time.
  const sundownH = (typeof currentSunTable !== 'undefined' && currentSunTable
                    && typeof findSunCrossingFromTable === 'function')
    ? (findSunCrossingFromTable(currentSunTable, false) ?? 22)
    : 22;
  const wxLookup = (h) => {
    const b = (typeof wxBucket === 'function') ? wxBucket(dateStr, h) : null;
    return { rainy: b === 'regn', overcast: b === 'skyer' };
  };

  // Pick the earliest upcoming window across all alerted venues. The other
  // venues' windows get picked up on subsequent eval cycles within 60s.
  let best = null;
  for (const [vidStr, alert] of _alertsMap) {
    if (alert.enabled === false) continue;
    const leadHours = (alert.notify_minutes_before ?? 30) / 60;
    const venue = VENUES.find(v => String(v.id) === String(vidStr));
    if (!venue) continue;
    const { windows: rawWindows } = computeSunWindows(venue, dateStr) || {};
    if (!rawWindows || !rawWindows.length) continue;
    const dh = (typeof getVenueHoursForDay === 'function')
      ? getVenueHoursForDay(venue, dateStr) : null;
    let qual;
    try {
      qual = (typeof qualifyingWindows === 'function')
        ? qualifyingWindows(rawWindows, wxLookup, {
            selectedHour: now,           // search forward from now
            sundownHour:  sundownH,
            openHour:     dh?.open ?? 0,
            closeHour:    dh?.close ?? 24,
          })
        : null;
    } catch (e) { continue; }
    const windows = qual?.windows || [];
    if (!windows.length) continue;
    for (const w of windows) {
      const hoursUntil = w.start - now;
      // Strictly "incoming" — at least a minute out so we never fire after
      // the window has technically begun.
      if (hoursUntil < 1/60 || hoursUntil > leadHours) continue;
      // Minute-resolution key — toFixed(2) on a float risked rounding collisions.
      const dedupeKey = `${dateStr}:${vidStr}:${Math.round(w.start * 60)}`;
      if (fired[dedupeKey]) continue;
      if (!best || w.start < best.windowStart) {
        best = {
          venue, vidStr,
          minutesUntil: Math.max(1, Math.round(hoursUntil * 60)),
          windowStart: w.start,
          dedupeKey,
        };
      }
    }
  }
  if (!best) return null;

  return {
    id: 'sun_alert_' + best.dedupeKey,
    priority: 0, category: 'alert',
    icon: '☀️',
    bodyKey: 'notif_sun_alert_body',
    bodyVars: { venue: best.venue.name, minutes: best.minutesUntil },
    actionKey: 'notif_go_to_venue',
    action: () => {
      if (typeof selectVenue === 'function') selectVenue(Number(best.venue.id), true);
    },
    ttl: 600000, dedupe: true,
    _onShow: () => {
      try {
        const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
        cur[best.dedupeKey] = Date.now();
        // Prune entries older than 2 days so the map doesn't grow forever.
        const cutoff = Date.now() - 2 * 86400 * 1000;
        for (const k of Object.keys(cur)) if (cur[k] < cutoff) delete cur[k];
        localStorage.setItem(KEY, JSON.stringify(cur));
      } catch {}
    },
  };
}

// Plan-starts-soon reminders are server-driven now: sql/029 process_plan_reminders
// pg_cron writes the bell row + fires push 25–35 min before planned_at, and the
// in-app toast surfaces via auth.js _bellRowToToast (gated to plan_reminder_*
// prefixes) when the Realtime INSERT lands.

// ── Evaluators: P0 Weather ───────────────���─────────────────────────────���─────

function _evalNoSunToday() {
  if (typeof VENUES === 'undefined' || !VENUES || !VENUES.length) return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  if (datePicker.value !== todayStr()) return null;
  // Only record once per calendar day — don't re-stamp the bell entry
  const state = _notifLoadState();
  if (state.noSunShownDate === todayStr()) return null;
  // Check if ANY venue has sun from now onwards (not the whole day)
  const now = currentHour();
  const hasSun = VENUES.some(v => {
    const { windows } = computeSunWindows(v, datePicker.value);
    return windows && windows.some(w => w.end > now);
  });
  if (hasSun) return null;
  // Bell-only: the empty venue list already shows "no sun" visually.
  // A toast would just duplicate the UI. Bell record lets users still
  // see what happened if they check the inbox.
  return {
    id: 'weather_no_sun', priority: 0, category: 'weather',
    icon: '☁️', bodyKey: 'notif_no_sun_body', actionKey: 'notif_open_calendar',
    action: () => { if (typeof _openQcPanel === 'function') _openQcPanel(); },
    ttl: 600000, dedupe: true, bellOnly: true,
    _onShow: () => {
      const s = _notifLoadState();
      s.noSunShownDate = todayStr();
      _notifSaveState(s);
    },
  };
}

function _evalSunSettingSoon() {
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  if (datePicker.value !== todayStr()) return null;
  if (typeof SUNSET_H_ARC === 'undefined' || SUNSET_H_ARC == null) return null;
  const now = currentHour();
  const timeLeft = SUNSET_H_ARC - now;
  // Fire 20–60 min before sunset — wide enough that an app open in the
  // final hour doesn't miss it; tight enough to feel time-sensitive.
  if (timeLeft <= 0 || timeLeft > 1 || timeLeft < 20/60) return null;
  // Suppress if it's already overcast right now — "sun setting soon" reads
  // as misleading when the user can see the sky is grey.
  if (typeof getWeatherAt === 'function') {
    const wxNow = getWeatherAt(datePicker.value, Math.floor(now));
    if (wxNow && (wxNow.sunBlock ?? wxNow.cloud) > 0.5) return null;
  }
  const sunsetTime = formatHour(SUNSET_H_ARC);
  return {
    id: 'weather_sun_setting', priority: 0, category: 'weather',
    icon: '🌅', bodyKey: 'notif_sun_setting_body',
    bodyVars: { time: sunsetTime },
    actionKey: 'notif_show_sun_now',
    // Snap the slider to "now" so the panel shows the venues that still
    // have sun in this last window. The list is already sun-now ranked,
    // so activating now-mode is the most direct path to actionable info.
    action: () => {
      if (typeof _activateNowMode === 'function') _activateNowMode();
    },
    ttl: 600000, dedupe: true,
  };
}

function _evalCloudIncoming() {
  if (typeof getWeatherAt !== 'function') return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  const dateStr = datePicker.value;
  if (dateStr !== todayStr()) return null;
  const now = currentHour();
  const baseHour = Math.floor(now);
  const wxNow = getWeatherAt(dateStr, baseHour);
  // Layer-aware: don't suppress just because of thin high cirrus — the user
  // still has functional sun.
  if (!wxNow || (wxNow.sunBlock ?? wxNow.cloud) > 0.5) return null;
  // Don't bother if sun is setting before the cloud could arrive. Avoids
  // firing "clouds in 2hr" at 20:00 when sunset is 21:00.
  if (typeof SUNSET_H_ARC !== 'undefined' && SUNSET_H_ARC != null && SUNSET_H_ARC - now < 1.5) {
    return null;
  }
  // Require TWO consecutive cloudy hours to call it incoming. A single
  // cloud-prediction flicker in the forecast was triggering false alerts.
  for (let h = 1; h <= 3; h++) {
    const wx1 = getWeatherAt(dateStr, baseHour + h);
    const wx2 = getWeatherAt(dateStr, baseHour + h + 1);
    if (!wx1 || !wx2) continue;
    const c1 = wx1.sunBlock ?? wx1.cloud;
    const c2 = wx2.sunBlock ?? wx2.cloud;
    if (c1 > 0.7 && c2 > 0.7) {
      const cloudArrivesHour = baseHour + h;
      return {
        id: 'weather_cloud_incoming', priority: 0, category: 'weather',
        icon: '🌥️', bodyKey: 'notif_cloud_incoming_body',
        bodyVars: { hour: formatHour(cloudArrivesHour) },
        actionKey: 'notif_show_sun_now',
        // Snap to now-mode so the user immediately sees what still has sun.
        action: () => {
          if (typeof _activateNowMode === 'function') _activateNowMode();
        },
        ttl: 600000, dedupe: true,
      };
    }
  }
  return null;
}


function _evalRainWindow() {
  if (typeof getWeatherAt !== 'function') return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  const dateStr = datePicker.value;
  if (dateStr !== todayStr()) return null;
  const now = Math.floor(currentHour());
  // Find rain start
  let rainStart = null, rainEnd = null;
  for (let h = now; h <= 23; h++) {
    const wx = getWeatherAt(dateStr, h);
    if (!wx) continue;
    if (wx.precip > 0.3 && rainStart === null) rainStart = h;
    if (wx.precip <= 0.3 && rainStart !== null && rainEnd === null) { rainEnd = h; break; }
  }
  if (rainStart === null || rainStart <= now) return null; // already raining or no rain
  if (rainEnd === null) return null; // rain doesn't stop today
  return {
    id: 'weather_rain', priority: 0, category: 'weather',
    icon: '🌧️', bodyKey: 'notif_rain_body',
    bodyVars: { from: formatHour(rainStart), to: formatHour(rainEnd) },
    actionKey: 'notif_skip_rain',
    action: () => {
      if (typeof timeFromEl !== 'undefined' && timeFromEl) {
        timeFromEl.value = rainEnd;
        timeFromEl.dispatchEvent(new Event('input'));
      }
    },
    ttl: 300000, dedupe: true,
  };
}

function _evalBestSunWindow() {
  if (typeof VENUES === 'undefined' || !VENUES || !VENUES.length) return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  const dateStr = datePicker.value;
  if (dateStr !== todayStr()) return null;
  // Once-per-day bell record — re-stamping moves the row to the top of
  // the inbox on every refresh, which reads as spam.
  const state = _notifLoadState();
  if (state.bestSunShownDate === todayStr()) return null;
  const now = currentHour();
  // Too late in the day for a "peak" to be actionable
  if (now >= 18) return null;
  // Count venues with sun per hour
  let bestHour = -1, bestCount = 0;
  for (let h = Math.max(6, Math.ceil(now)); h <= 21; h++) {
    let count = 0;
    for (const v of VENUES) {
      const { windows } = computeSunWindows(v, dateStr);
      if (windows && windows.some(w => w.start <= h && w.end >= h)) count++;
    }
    if (count > bestCount) { bestCount = count; bestHour = h; }
  }
  if (bestHour < 0 || bestCount < 15) return null; // not enough venues with sun
  // Suppress when peak hour is overcast or wet — classified through the
  // canonical wxClassify (ui-shared.js) so this shares one threshold set with
  // the pins/list/FTS/calendar. (skip gating if no weather data)
  if (typeof getWeatherAt === 'function' && typeof wxClassify === 'function') {
    const wx = getWeatherAt(dateStr, bestHour);
    if (wx) {
      const c = wxClassify(wx.sunBlock ?? wx.cloud, wx.precip);
      if (c === 'overcast' || c === 'rain') return null;
    }
  }
  // Find the peak block (contiguous hours with same-ish count)
  let blockStart = bestHour, blockEnd = bestHour;
  for (let h = bestHour - 1; h >= Math.ceil(now); h--) {
    let count = 0;
    for (const v of VENUES) {
      const { windows } = computeSunWindows(v, dateStr);
      if (windows && windows.some(w => w.start <= h && w.end >= h)) count++;
    }
    if (count >= bestCount * 0.7) blockStart = h; else break;
  }
  for (let h = bestHour + 1; h <= 21; h++) {
    let count = 0;
    for (const v of VENUES) {
      const { windows } = computeSunWindows(v, dateStr);
      if (windows && windows.some(w => w.start <= h && w.end >= h)) count++;
    }
    if (count >= bestCount * 0.7) blockEnd = h; else break;
  }
  // Require the peak to be meaningfully better than right now
  const nowH = Math.ceil(now);
  let nowCount = 0;
  for (const v of VENUES) {
    const { windows } = computeSunWindows(v, dateStr);
    if (windows && windows.some(w => w.start <= nowH && w.end >= nowH)) nowCount++;
  }
  if (bestCount < nowCount * 1.3 && bestCount - nowCount < 5) return null;
  // Only show if peak is in the future
  if (blockEnd <= now) return null;
  // Bell-only: the peak hour is already visible in the slider + arc, and a
  // toast would preempt a more time-sensitive social/weather alert. The bell
  // record gives users a tappable "jump to peak" affordance without nagging.
  return {
    id: 'weather_best_sun', priority: 0, category: 'weather',
    icon: '☀️', bodyKey: 'notif_best_sun_body',
    bodyVars: { from: formatHour(blockStart), to: formatHour(blockEnd), hour: formatHour(blockStart) },
    actionKey: 'notif_set_time',
    action: () => {
      if (typeof timeFromEl !== 'undefined' && timeFromEl) {
        timeFromEl.value = blockStart;
        timeFromEl.dispatchEvent(new Event('input'));
      }
    },
    ttl: 600000, dedupe: true, bellOnly: true,
    _onShow: () => {
      const s = _notifLoadState();
      s.bestSunShownDate = todayStr();
      _notifSaveState(s);
    },
  };
}


// ── Evaluators: P1 Social ─────────────────────���───────────────────────────��──

function _evalFriendsAtVenue() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _friendCheckins === 'undefined') return null;
  // Find venue with most friends currently checked in
  let bestVid = null, bestList = [], bestCount = 0;
  for (const [vid, list] of _friendCheckins) {
    // Filter to recent check-ins (last 2 hours)
    const recent = list.filter(c => {
      const ts = c.checkin?.created_at || c.created_at;
      if (!ts) return true; // no timestamp, assume current
      return Date.now() - new Date(ts).getTime() < 2 * 60 * 60 * 1000;
    });
    if (recent.length > bestCount) {
      bestCount = recent.length;
      bestVid = vid;
      bestList = recent;
    }
  }
  if (bestCount === 0 || !bestVid) return null;
  const venueName = (typeof VENUES !== 'undefined' && VENUES.find(v => String(v.id) === String(bestVid)))?.name || '';
  const firstName = bestList[0]?.user?.name?.split(' ')[0] || bestList[0]?.user?.email?.split('@')[0] || '';
  const bodyKey = bestCount === 1 ? 'notif_friend_at_body' : 'notif_friends_at_body';
  return {
    id: 'social_friends_at', priority: 1, category: 'social',
    icon: '👋', bodyKey,
    bodyVars: { name: firstName, venue: venueName, count: bestCount },
    actionKey: 'notif_go_to_venue',
    action: () => { if (typeof selectVenue === 'function') selectVenue(Number(bestVid), true); },
    ttl: 600000, dedupe: true,
  };
}

function _evalCheckinPrompt() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof userLocation === 'undefined' || !userLocation) return null;
  if (typeof VENUES === 'undefined' || !VENUES) return null;
  if (typeof _myCheckin !== 'undefined' && _myCheckin) return null; // already checked in
  // Find nearest venue within 100m
  const R = 6371000; // earth radius meters
  let nearest = null, nearestDist = Infinity;
  for (const v of VENUES) {
    const dlat = (v.lat - userLocation.lat) * Math.PI / 180;
    const dlng = (v.lng - userLocation.lng) * Math.PI / 180;
    const a = Math.sin(dlat/2)**2 + Math.cos(userLocation.lat * Math.PI/180) * Math.cos(v.lat * Math.PI/180) * Math.sin(dlng/2)**2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    if (dist < nearestDist) { nearestDist = dist; nearest = v; }
  }
  if (!nearest || nearestDist > 100) return null;
  // Don't prompt for venues that are closed or whose hours we don't know.
  // Hit a real case where the toast suggested a permanently-closed spot.
  if (nearest.businessStatus && nearest.businessStatus !== 'OPERATIONAL') return null;
  if (!nearest.openingHours && !nearest.openingHoursWeekly) return null;
  if (typeof getVenueHoursForDay === 'function' && typeof currentHour === 'function' && typeof todayStr === 'function') {
    const hours = getVenueHoursForDay(nearest, todayStr());
    const now = currentHour();
    if (!hours || hours.open == null || hours.close == null) return null;
    if (now < hours.open || now > hours.close) return null;
  }
  return {
    id: 'social_checkin', priority: 1, category: 'social',
    icon: '📍', bodyKey: 'notif_checkin_body',
    bodyVars: { venue: nearest.name },
    actionKey: 'notif_checkin_action',
    action: () => { if (typeof checkInToVenue === 'function') checkInToVenue(nearest.id); },
    ttl: 300000, dedupe: true,
    // Proximity-gated (fires only within 100m of a venue) → never log its
    // show/action/dismiss to the events sink, to keep zero location-derived
    // data server-side. See the guard in _notifShow.
    noAnalytics: true,
  };
}

/**
 * Notify the inviter when an invitee accepts. Walks own plans, finds invitees
 * whose status flipped to 'accepted' since last seen, and queues a P1 toast.
 * Persisted dedupe in localStorage keyed `${plan_id}:${user_id}`.
 */
function _evalInviteAccepted() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _plans === 'undefined' || !_plans.length) return null;

  // Dedup via the server-side bell row's read_at, NOT a localStorage
  // seen-cache. The corresponding row in public.notifications has the
  // same id as the toast (notif_id = 'social_invite_accepted_<plan_id>').
  // The sql/030 trigger does ON CONFLICT DO UPDATE that RESETS read_at
  // to NULL on each new accept, so the toast naturally re-fires when
  // another invitee accepts the same plan. Prior versions used a
  // per-(plan, invitee) localStorage map that persisted forever and
  // could silently suppress legitimate fresh toasts when entries
  // carried over from earlier test cycles (the bug behind "no toast
  // when X accepts" even though the bell row was unread).
  for (const p of _plans) {
    if (p.creator_id !== _currentUser.id) continue;
    if (!Array.isArray(p._invitees)) continue;
    const acceptedAll = p._invitees.filter(i => i.status === 'accepted');
    if (!acceptedAll.length) continue;

    const notifId = 'social_invite_accepted_' + p.id;
    if (typeof _bellHistory !== 'undefined' && _bellHistory && _bellHistory.get) {
      const bellEntry = _bellHistory.get(notifId);
      if (bellEntry && bellEntry.readAt) continue;
    }

    const venue = (typeof VENUES !== 'undefined')
      ? VENUES.find(x => String(x.id) === String(p.venue_id)) : null;
    if (!venue) continue;

    // Head = the latest accept (last in DB-load order, freshest accept
    // appears last in the realtime → loadPlans round-trip).
    const head = acceptedAll[acceptedAll.length - 1];
    const u = head.user || {};
    const headName = (u.name || u.email || '').split(' ')[0].split('@')[0] || '…';
    const extra = Math.max(0, acceptedAll.length - 1);

    // Off-plan-time arrival → include the time in the toast (single-
    // accept variant only). Skips for the aggregated multi variant
    // since arrival times would conflict.
    let arrivalTime = null;
    if (extra === 0 && head.arrival_time && p.planned_at) {
      const planMs = new Date(p.planned_at).getTime();
      const arrMs = new Date(head.arrival_time).getTime();
      if (Math.abs(arrMs - planMs) >= 5 * 60 * 1000) {
        const d = new Date(arrMs);
        arrivalTime = (typeof formatHour === 'function')
          ? formatHour(d.getHours() + d.getMinutes() / 60)
          : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
    }
    const bodyKey = extra > 0
      ? 'notif_invite_accepted_multi'
      : (arrivalTime ? 'notif_invite_accepted_at' : 'notif_invite_accepted_body');

    return {
      id: notifId,
      // P0 — event-driven, interrupts ambient P1 toasts (friends-at-venue,
      // friend-planning). An invite-accept is a response to an action the
      // host took; surfacing it behind a "look, friends are at X" ambient
      // toast hid it for users testing both flows simultaneously.
      // urgent: bypass time-based rate limits (grace period + early-window
      // cap) because the matching push has already grabbed the user's
      // attention — the in-app toast should surface live, not "after a
      // little while" once the early-window cooldown clears.
      priority: 0, category: 'social', urgent: true,
      icon: '☀️',
      bodyKey,
      bodyVars: { name: headName, venue: venue.name, extra, time: arrivalTime || '' },
      actionKey: 'notif_open_plan',
      action: () => {
        if (typeof selectVenue === 'function') {
          selectVenue(Number(p.venue_id), true);
        }
      },
      bellAction: () => {
        if (typeof openPlanPreview === 'function') {
          openPlanPreview({ venueId: p.venue_id, plannedAt: p.planned_at });
        } else if (typeof selectVenue === 'function') {
          selectVenue(Number(p.venue_id), true);
        }
      },
      nav: { kind: 'plan', venueId: p.venue_id, plannedAt: p.planned_at },
      ttl: 600000, dedupe: true,
    };
  }
  return null;
}

/**
 * Inviter-side: an invitee declined one of MY plans. Fires for every
 * decliner — friend or not. Names come from the profiles join when the
 * decliner is authenticated; anon decline rows (no joined profile) fall
 * back to the 'attendee_someone' localized string. Dedupes via the same
 * 'seen_invite_responses' map _evalInviteAccepted uses.
 */
function _evalInviteDeclined() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _plans === 'undefined' || !_plans.length) return null;

  // Dedup via the bell row's read_at — same pattern as _evalInviteAccepted
  // above. The localStorage seen-cache used to handle this; it could
  // suppress fresh toasts when entries persisted across sessions.
  for (const p of _plans) {
    if (p.creator_id !== _currentUser.id) continue;
    if (!Array.isArray(p._invitees)) continue;
    const declinedAll = p._invitees.filter(i => i.status === 'declined');
    if (!declinedAll.length) continue;

    const notifId = 'social_invite_declined_' + p.id;
    if (typeof _bellHistory !== 'undefined' && _bellHistory && _bellHistory.get) {
      const bellEntry = _bellHistory.get(notifId);
      if (bellEntry && bellEntry.readAt) continue;
    }

    const venue = (typeof VENUES !== 'undefined')
      ? VENUES.find(x => String(x.id) === String(p.venue_id)) : null;
    if (!venue) continue;

    // Head = newest decline. Prefer a NAMED decliner over an anonymous
    // one — anon rows lack a profile, so an "anon" head reads as
    // "Noen +N har avslått" which is less informative than
    // "Anna +N har avslått" even when Anna isn't the very newest.
    const namedHead = [...declinedAll].reverse().find(d => d.user && (d.user.name || d.user.email));
    const head = namedHead || declinedAll[declinedAll.length - 1];
    const u = head.user || {};
    const headName = (u.name || u.email || '').split(' ')[0].split('@')[0]
      || (declinedAll.length === 1 ? 'Person' : t('attendee_someone'));
    const extra = Math.max(0, declinedAll.length - 1);
    const bodyKey = extra > 0 ? 'notif_invite_declined_multi' : 'notif_invite_declined_body';

    return {
      id: notifId,
      // P0 + urgent — see _evalInviteAccepted above for rationale.
      priority: 0, category: 'social', urgent: true,
      icon: '🙅',
      bodyKey,
      bodyVars: { name: headName, venue: venue.name, extra },
      actionKey: 'notif_open_plan',
      action: () => {
        if (typeof selectVenue === 'function') {
          selectVenue(Number(p.venue_id), true);
        }
      },
      bellAction: () => {
        if (typeof openPlanPreview === 'function') {
          openPlanPreview({ venueId: p.venue_id, plannedAt: p.planned_at });
        } else if (typeof selectVenue === 'function') {
          selectVenue(Number(p.venue_id), true);
        }
      },
      nav: { kind: 'plan', venueId: p.venue_id, plannedAt: p.planned_at },
      ttl: 600000, dedupe: true,
    };
  }
  return null;
}

/**
 * Receiver-side: someone invited ME to a plan. Surfaces a P1 social
 * toast for the freshest pending invite the user hasn't yet read in the
 * bell. Toast id matches the server bell-row id (sql/030
 * notif_on_plan_invite_created writes 'plan_invite_pending:<invite_id>'),
 * so bell-row read state naturally dedupes the toast across sessions.
 * Once the user opens the bell, the row's read_at gets stamped and the
 * toast stops firing for that invite.
 */
function _evalIncomingPlanInvite() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _planInvites === 'undefined' || !Array.isArray(_planInvites) || !_planInvites.length) return null;

  // Walk newest-first so the freshest unread invite wins the toast slot.
  // _planInvites is filtered to FUTURE plans only, so past invites can't
  // surface a "you were invited" toast for an event that's already happened.
  for (let i = _planInvites.length - 1; i >= 0; i--) {
    const inv = _planInvites[i];
    if (!inv || inv.status !== 'pending' || !inv.plan) continue;
    if (inv.plan.cancelled_at) continue;

    const notifId = 'plan_invite_pending:' + inv.id;
    if (typeof _bellHistory !== 'undefined' && _bellHistory && _bellHistory.get) {
      const bellEntry = _bellHistory.get(notifId);
      if (bellEntry && bellEntry.readAt) continue;
    }

    const creator = inv.plan.creator || {};
    const senderName = (creator.name || creator.email || '').split(' ')[0].split('@')[0] || '…';

    let venueName = '';
    if (typeof VENUES !== 'undefined' && Array.isArray(VENUES) && inv.plan.venue_id) {
      const v = VENUES.find(x => String(x.id) === String(inv.plan.venue_id));
      venueName = (v && v.name) || inv.plan.venue_name || '';
    } else {
      venueName = inv.plan.venue_name || '';
    }
    if (!venueName) continue;

    return {
      id: notifId,
      // P0 + urgent — event-driven, push counterpart, bypass rate limits.
      priority: 0, category: 'social', urgent: true,
      icon: '📅',
      bodyKey: 'notif_invite_received_body',
      bodyVars: { name: senderName, venue: venueName },
      actionKey: 'notif_open_plan',
      action: () => {
        if (typeof openPlanPreview === 'function') {
          openPlanPreview({
            venueId:     inv.plan.venue_id,
            plannedAt:   inv.plan.planned_at,
            inviteId:    inv.id,
            inviterName: senderName,
            mode:        'invite',
          });
        }
      },
      bellAction: () => {
        if (typeof openPlanPreview === 'function') {
          openPlanPreview({
            venueId:     inv.plan.venue_id,
            plannedAt:   inv.plan.planned_at,
            inviteId:    inv.id,
            inviterName: senderName,
            mode:        'invite',
          });
        }
      },
      nav: { kind: 'plan', venueId: inv.plan.venue_id, plannedAt: inv.plan.planned_at },
      ttl: 600000, dedupe: true,
    };
  }
  return null;
}

/**
 * Receiver-side: someone sent ME a friend request. Surfaces a P1 social
 * toast that persists across sessions until the request is no longer
 * pending (accepted, rejected, or withdrawn). Action opens the Friends
 * modal where the user can Accept inline. Dedupes on the friendship row
 * id so we don't re-fire on every poll for the same request.
 */
function _evalIncomingFriendRequest() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _pendingRequests === 'undefined' || !Array.isArray(_pendingRequests) || !_pendingRequests.length) return null;
  const head = _pendingRequests[0];
  if (!head || !head.friendshipId) return null;
  const name = (head.name || head.email || '').split(' ')[0].split('@')[0] || '…';
  const extra = _pendingRequests.length - 1;
  const bodyKey = extra > 0 ? 'notif_friend_request_multi' : 'notif_friend_request_body';
  return {
    // Stable id (not per-row) so a dismiss covers ALL pending requests
    // for this session — and the next session re-fires it fresh while
    // any pending row still exists. The body uses {name} +{extra} so a
    // single toast represents the whole pending set.
    id: 'social_friend_request',
    // P0 + urgent — event-driven, push counterpart, bypass rate limits.
    priority: 0, category: 'social', urgent: true,
    icon: '👤',
    bodyKey,
    bodyVars: { name, extra },
    // Inline Accept — single tap turns it into a real friendship; no
    // round-trip through the Friends modal needed. The 'extra > 0' case
    // accepts the head request only; the rest stay pending and re-fire
    // next session.
    actionKey: extra > 0 ? 'notif_open_friends' : 'notif_friend_request_accept',
    action: async () => {
      if (extra > 0) {
        if (typeof openFriendsModal === 'function') openFriendsModal();
        else if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
      } else if (typeof acceptFriendRequest === 'function') {
        await acceptFriendRequest(head.friendshipId);
      }
    },
    // Don't TTL-out the toast: we want it on every session until handled.
    // dedupe still prevents multiple copies in the queue at once.
    dedupe: true,
    nav: { kind: 'friends' },
  };
}

function _evalFriendPlanning() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _planInvites === 'undefined' || !_planInvites.length) return null;
  // Find a friend's plan for today
  const today = todayStr();
  const todayPlan = _planInvites.find(inv => {
    if (!inv.plan) return false;
    const planDate = inv.plan.planned_at?.slice(0, 10);
    return planDate === today && inv.status !== 'declined';
  });
  if (!todayPlan) return null;
  const plan = todayPlan.plan;
  const creator = plan.creator?.name?.split(' ')[0] || plan.creator?.email?.split('@')[0] || '';
  const venueName = (typeof VENUES !== 'undefined' && VENUES.find(v => String(v.id) === plan.venue_id))?.name || '';
  const time = plan.planned_at ? formatHour(new Date(plan.planned_at).getHours() + new Date(plan.planned_at).getMinutes() / 60) : '';
  return {
    id: 'social_friend_plan', priority: 1, category: 'social',
    icon: '📅', bodyKey: 'notif_friend_plan_body',
    bodyVars: { name: creator, venue: venueName, time },
    actionKey: 'notif_go_to_venue',
    action: () => { if (typeof selectVenue === 'function') selectVenue(Number(plan.venue_id), true); },
    // Bell-row override: this is a reminder of YOUR upcoming plan, so
    // plan-preview reads better than just the venue.
    bellAction: () => {
      if (typeof openPlanPreview === 'function') {
        openPlanPreview({ venueId: plan.venue_id, plannedAt: plan.planned_at });
      } else if (typeof selectVenue === 'function') {
        selectVenue(Number(plan.venue_id), true);
      }
    },
    nav: { kind: 'plan', venueId: plan.venue_id, plannedAt: plan.planned_at },
    ttl: 600000, dedupe: true,
  };
}

// ── Evaluator Registry ───────────────���──────────────────────────────────────���

const _notifEvaluators = [
  // P0 Alerts (user-opted-in — bypass kill-switch)
  _evalSunAlerts,
  // _evalPlanReminder removed — server cron (sql/029) drives push + bell, and
  // auth.js _bellRowToToast surfaces the in-app toast from the Realtime INSERT.
  // P0 Weather (bell-only)
  _evalNoSunToday,
  _evalBestSunWindow,
  // P0 Weather (toast)
  _evalSunSettingSoon,
  _evalCloudIncoming,
  _evalRainWindow,
  // P0 Social — event-driven, take precedence over ambient observations
  _evalIncomingPlanInvite,
  _evalInviteAccepted,
  _evalInviteDeclined,
  _evalIncomingFriendRequest,
  // P1 Social — ambient observations (friends nearby, friend's plan)
  _evalFriendsAtVenue,
  _evalCheckinPrompt,
  _evalFriendPlanning,
];

// ── Evaluate & Schedule ──────────────────────────────────────────────────────

function _notifEvaluate() {
  if (!_notifInitDone) return;
  const settings = _notifGetSettings();
  for (const evaluator of _notifEvaluators) {
    try {
      const notif = evaluator();
      if (!notif) continue;
      if (_NOTIF_DISABLED_CATEGORIES.has(notif.category)) continue;
      if (!settings[notif.category]) continue;
      if (_notifDismissed.has(notif.id)) continue;
      // bellOnly: silent inbox record, no toast. Used for ambient state
      // the UI already exposes (no sun today, best-sun summary) where a
      // toast would just duplicate what the user can see.
      if (notif.bellOnly) {
        if (typeof _bellRecord === 'function') _bellRecord(notif);
        if (typeof notif._onShow === 'function') {
          try { notif._onShow(); }
          catch (e) { console.warn('[notif] bellOnly _onShow threw:', notif.id, e); }
        }
        continue;
      }
      _notifEnqueue(notif);
    } catch (e) {
      console.warn('[notif] evaluator error:', evaluator.name, e);
    }
  }
  // If P0 in queue and current toast is lower priority, preempt
  if (_notifCurrent && _notifQueue.length && _notifQueue[0].priority < _notifCurrent.priority) {
    _notifHide(); // will auto-advance to higher priority
  }
  _notifAdvance();
}

// ── Notification Settings Toggle ─────────────────────────────────────────────

function _notifToggle(category) {
  const settings = _notifGetSettings();
  settings[category] = !settings[category];
  _notifSaveSettings(settings);
  if (typeof _aTrack === 'function') _aTrack('notification_settings_change', { category, enabled: settings[category] });
  // Re-render profile panel to update toggle state
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
}

/** Read the live push-subscribed state and reflect it on the toggle. */
async function _notifSyncPushToggleState() {
  const btn = document.getElementById('push-toggle-btn');
  if (!btn) return;
  if (typeof pushIsSubscribed !== 'function') return;
  const on = await pushIsSubscribed();
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-checked', String(!!on));
}

/** Flip the push subscription. Granting permission also subscribes;
 *  flipping it off un-subscribes and deletes the server row. */
async function _notifPushToggle() {
  if (typeof pushIsSubscribed !== 'function') return;
  const wasOn = await pushIsSubscribed();
  if (wasOn) {
    if (typeof pushDisable === 'function') await pushDisable();
  } else {
    if (typeof pushRequestPermission === 'function') await pushRequestPermission();
  }
  await _notifSyncPushToggleState();
}
if (typeof window !== 'undefined') {
  window._notifSyncPushToggleState = _notifSyncPushToggleState;
  window._notifPushToggle = _notifPushToggle;
}

/** Build the notification settings HTML for the profile panel. */
function _notifSettingsHtml() {
  const settings = _notifGetSettings();
  const categories = [
    { key: 'alert',      labelKey: 'notif_cat_alert' },
    { key: 'weather',    labelKey: 'notif_cat_weather' },
    { key: 'social',     labelKey: 'notif_cat_social' },
    { key: 'suggestion', labelKey: 'notif_cat_suggestion' },
  ].filter(c => !_NOTIF_DISABLED_CATEGORIES.has(c.key));
  const activeCount = categories.filter(c => settings[c.key] !== false).length;
  const totalCount  = categories.length;

  // Push toggle (master) — only shows when the browser supports APIs AND
  // a VAPID key is configured. Per-category toggles moved to a sub-view
  // (Stage 4b-3) so adding new types doesn't bloat the main sheet.
  let rows = '';
  const pushAvail = (typeof pushIsAvailable === 'function') && pushIsAvailable();
  if (pushAvail) {
    const denied = (typeof pushPermissionState === 'function') && pushPermissionState() === 'denied';
    if (denied) {
      rows += `<div class="settings-row pref-row is-disabled">
        <span class="settings-row__label">${t('notif_push_label')}</span>
        <span class="settings-row__value">${t('notif_push_blocked')}</span>
      </div>`;
    } else {
      rows += `<div class="settings-row pref-row" id="push-toggle-row">
        <span class="settings-row__label">${t('notif_push_label')}</span>
        <button class="toggle-switch" id="push-toggle-btn"
                role="switch" aria-checked="false"
                aria-label="${t('notif_push_label')}"
                onclick="_notifPushToggle()"></button>
      </div>`;
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(_notifSyncPushToggleState);
      }
    }
  }
  // Drill-in to per-category toggles.
  rows += `<button class="settings-row" onclick="_setProfilePanelView('notif-types')">
    <span class="settings-row__icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span>
    <span class="settings-row__label">Varslingstyper</span>
    <span class="settings-row__value">${activeCount} av ${totalCount} aktive</span>
    <span class="settings-row__chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
  </button>`;

  return `<div>
    <div class="settings-group-label">${t('notif_settings')}</div>
    <div class="settings-group">${rows}</div>
  </div>`;
}

// ── Init ─────────────────────────────────────────���───────────────────────────

function _notifInit() {
  const state = _notifLoadState();
  state.sessionCount = (state.sessionCount || 0) + 1;
  state.lastSessionTs = Date.now();
  _notifSaveState(state);

  _notifInitDone = true;

  _notifEvalTimer = setInterval(_notifEvaluate, _NOTIF_EVAL_INTERVAL);

  setTimeout(_notifEvaluate, 8000);
}

