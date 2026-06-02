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

// One-time boot cleanup for keys that were owned by client evaluators we've
// since migrated server-side (sql/029, 047, 049, 050). The keys carry no
// behavior anymore; deleting drops a couple KB from localStorage and stops
// the clutter from showing up in DevTools forever.
(function _purgeOrphanedNotifKeys() {
  try {
    for (const k of ['solsteder_sun_alert_fired', 'solsteder_plan_reminders_fired']) {
      localStorage.removeItem(k);
    }
    // The _notifLoadState bag itself stays — other survivors still write to
    // it. Just prune the orphan subkeys (noSunShownDate, bestSunShownDate)
    // from the deleted _evalNoSunToday / _evalBestSunWindow.
    const raw = localStorage.getItem(_NOTIF_STORAGE_STATE);
    if (raw) {
      const state = JSON.parse(raw);
      let dirty = false;
      for (const k of ['noSunShownDate', 'bestSunShownDate']) {
        if (k in state) { delete state[k]; dirty = true; }
      }
      if (dirty) localStorage.setItem(_NOTIF_STORAGE_STATE, JSON.stringify(state));
    }
  } catch { /* ignore — best-effort cleanup */ }
})();

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

// Sun alerts are server-driven now: sql/047 process_sun_alerts pg_cron writes
// the bell row + fires push every 5 min, gated by weather_oslo (sql/046).
// auth.js _bellRowToToast surfaces the in-app toast from the Realtime INSERT
// (allowlist includes 'sun_alert:' prefix).

// Plan-starts-soon reminders are server-driven now: sql/029 process_plan_reminders
// pg_cron writes the bell row + fires push 25–35 min before planned_at, and the
// in-app toast surfaces via auth.js _bellRowToToast (gated to plan_reminder_*
// prefixes) when the Realtime INSERT lands.

// ── Evaluators: P0 Weather ───────────────���─────────────────────────────���─────

// _evalNoSunToday removed — server cron (sql/049) writes a bell row for every
// active user with weather notifs enabled whenever no venue has a window
// ending after now-hour today. Bell-only (no push, matches the prior client
// behavior). Realtime delivers the row via _bellSubscribeRealtime.

// _evalSunSettingSoon, _evalCloudIncoming, _evalRainWindow removed.
// Ambient weather toasts (sunset proximity, incoming clouds, rain window)
// were observational rather than actionable — every signal they carried is
// already visible on the arc, date strip, and FTS row. The user found them
// noisier than useful, so deleting outright rather than migrating to a
// server cron. The remaining bell-only weather alerts (sql/049 noSunToday
// and sql/050 bestSunWindow) cover the once-per-day "what's the weather
// shape today" surface.

// _evalBestSunWindow removed — server cron (sql/050) writes a bell row for
// every active user with weather notifs enabled whenever the peak sun hour
// today (>= 15 venues, weather-clear, meaningfully better than now) is in
// the future. Bell-only (no push, matches the prior client behavior).
// Realtime delivers the row via _bellSubscribeRealtime.


// ── Evaluators: P1 Social ─────────────────────���───────────────────────────��──

// _evalFriendsAtVenue removed — ambient P1 "your friend is at X" toast.
// Friend check-ins are already surfaced on the venue card and the friend
// pin on the map, so the toast was redundant noise rather than new info.

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

// _evalInviteAccepted, _evalInviteDeclined, _evalIncomingPlanInvite removed.
// All three have server-side bell-row twins from sql/048: the cron writes
// 'social_invite_accepted_<plan_id>', 'social_invite_declined_<plan_id>',
// and 'plan_invite_pending:<invite_id>' rows whenever the underlying
// plan_invites trigger fires. Realtime delivers them; auth.js
// _bellRowToToast surfaces the toast (gated by the prefixes above) using
// the lead.bodyKey + lead.bodyVars hybrid payload so the body renders in
// the user's locale.
//
// _bellSubscribeRealtime also listens for UPDATE now, so sql/048's
// ON CONFLICT DO UPDATE (read_at reset to NULL) re-fires the toast when
// another invitee responds — no more 60s eval poll needed.

// _evalIncomingFriendRequest removed — sql/051 extends notify_friend_request
// to write a friend_request:<friendship_id> bell row (in addition to the
// existing push), Realtime delivers it, _bellRowToToast surfaces a per-
// request toast with inline Accept. Each request shows its own toast (no
// more aggregated +N count), which reads more accurately when multiple
// land in quick succession.

// _evalFriendPlanning removed — fired a P1 "friend's plan today" toast.
// Redundant with the plan_invite_pending: toast at invite time + the
// plan_reminder_invitee: toast 30 min before. The day-of "reminder" was
// a third surface for the same information.

// ── Evaluator Registry ───────────────���──────────────────────────────────────���

const _notifEvaluators = [
  // P0 Alerts (user-opted-in — bypass kill-switch)
  // _evalSunAlerts removed — server cron (sql/047) drives push + bell, and
  // auth.js _bellRowToToast surfaces the in-app toast from the Realtime INSERT.
  // _evalPlanReminder removed — server cron (sql/029) drives push + bell, and
  // auth.js _bellRowToToast surfaces the in-app toast from the Realtime INSERT.
  // P0 Weather (bell-only)
  // _evalNoSunToday    removed — server cron (sql/049) drives the bell row.
  // _evalBestSunWindow removed — server cron (sql/050) drives the bell row.
  // P0 Weather (toast)
  // _evalSunSettingSoon / _evalCloudIncoming / _evalRainWindow removed —
  // ambient observational toasts; signal already lives on the arc, date
  // strip, and FTS row.
  // P0 Social — event-driven, take precedence over ambient observations
  // _evalIncomingPlanInvite removed — server bell row (sql/048) → Realtime
  //   → _bellRowToToast (auth.js) drives the in-app toast.
  // _evalInviteAccepted removed — same path, sql/048's ON CONFLICT DO UPDATE
  //   refreshes the row and the UPDATE listener re-fires the toast.
  // _evalInviteDeclined removed — same path.
  // _evalIncomingFriendRequest removed — sql/051 writes the bell row,
  //   _bellRowToToast surfaces the per-request toast with inline Accept.
  // P1 Social — proximity-triggered, actionable
  // _evalFriendsAtVenue removed — same info on the venue card + friend pin.
  // _evalFriendPlanning  removed — redundant with plan_invite_pending + plan_reminder.
  _evalCheckinPrompt,
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

