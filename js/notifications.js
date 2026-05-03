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
// Per-day cap for weather notifications (smartness budget — avoid nagging).
// Persisted in localStorage state.weatherShownDates[YYYY-MM-DD].
const _NOTIF_WEATHER_DAILY_CAP = 3;
// Extra cooldown applied per category on top of the global 2-min cooldown.
// Currently only weather is throttled — social/login/onboarding stay snappy.
const _NOTIF_CATEGORY_COOLDOWN = { weather: 60 * 60 * 1000 };

// ── Mutable State ─────────────────────────────────────────────��──────────────

let _notifQueue         = [];         // sorted by priority then FIFO
let _notifDismissed     = new Set();  // ids dismissed this session
let _notifCurrent       = null;       // currently shown notification object
let _notifShownCount    = 0;
let _notifLastShownAt   = 0;
let _notifSessionStart  = Date.now();
let _notifAutoTimer     = null;
let _notifLoginShown    = new Set();  // login prompt ids shown this session
let _notifVenueOpens    = 0;          // venue detail opens this session
let _notifInitDone      = false;
let _notifEvalTimer     = null;
let _notifWeatherShownThisSession = false; // track if any P0 weather was shown
let _notifLastByCategory = {};        // category → last-shown timestamp
let _notifConditionsCache = new Map(); // memo for _evalCurrentConditions per tick

// ── localStorage Helpers ─────────��───────────────────────────────────────────

function _notifLoadState() {
  try { return JSON.parse(localStorage.getItem(_NOTIF_STORAGE_STATE) || '{}'); } catch { return {}; }
}

function _notifSaveState(state) {
  try { localStorage.setItem(_NOTIF_STORAGE_STATE, JSON.stringify(state)); } catch { /* ignore */ }
}

function _notifGetSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(_NOTIF_STORAGE_SETTINGS) || 'null');
    if (s) return s;
  } catch { /* ignore */ }
  return { weather: true, social: true, suggestion: true, onboarding: true, login: true, engagement: true };
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
  if (notif.dedupe && _notifQueue.some(n => n.id === notif.id)) return;
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

function _notifCanShow() {
  // Don't show if profile panel is open
  const pp = document.getElementById('profile-panel');
  if (pp && pp.classList.contains('open')) return false;
  // QC calendar panel — opened by `weather_no_sun` action; toast must hide
  // beneath it to keep the user focused on picking a date.
  const qc = document.getElementById('qc-panel');
  if (qc && qc.classList.contains('open')) return false;
  // Suppress while a takeover sheet is up (plan preview, invite sheet) —
  // these own the user's attention and toasts visually conflict with them.
  if (document.body.classList.contains('plan-preview-active')) return false;
  if (document.body.classList.contains('invite-sheet-open'))   return false;
  if (document.body.classList.contains('profile-panel-open'))  return false;
  // Grace period: no queued toasts for first 8s (lets user orient)
  const elapsed = Date.now() - _notifSessionStart;
  if (elapsed < _NOTIF_GRACE_PERIOD) return false;
  // Rate limit: max 1 in first 30s after grace, then 2-min cooldown
  if (elapsed < _NOTIF_GRACE_PERIOD + _NOTIF_EARLY_WINDOW) return _notifShownCount < _NOTIF_MAX_EARLY;
  return !_notifLastShownAt || (Date.now() - _notifLastShownAt) > _NOTIF_COOLDOWN;
}

// Per-category quotas: per-day weather cap (persisted) + per-category cooldown
// (in-memory). Returns true if `notif` is allowed to show right now.
function _notifPassesCategoryGate(notif) {
  if (!notif) return false;
  const cooldown = _NOTIF_CATEGORY_COOLDOWN[notif.category];
  if (cooldown) {
    const last = _notifLastByCategory[notif.category] || 0;
    if (last && Date.now() - last < cooldown) return false;
  }
  if (notif.category === 'weather') {
    const state = _notifLoadState();
    const today = todayStr();
    const counts = state.weatherShownDates || {};
    if ((counts[today] || 0) >= _NOTIF_WEATHER_DAILY_CAP) return false;
  }
  return true;
}

function _notifAdvance() {
  if (_notifCurrent) return; // one at a time
  if (!_notifCanShow()) return;
  // Skip queued items that fail per-category gates without blocking the
  // queue: re-queue items further back in the same priority lane would be
  // overkill. Just drop them — they will re-enqueue on the next eval tick
  // if the underlying condition still holds.
  while (_notifQueue.length) {
    if (_notifPassesCategoryGate(_notifQueue[0])) break;
    _notifQueue.shift();
  }
  const notif = _notifDequeue();
  if (notif) _notifShow(notif);
}

// ── Toast UI ──────────────────────────────────────────��──────────────────────

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
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
    </button>`;
  wrap.appendChild(el);
  return el;
}

function _notifShow(notif) {
  console.log('[notif] showing:', notif.id, notif.bodyKey || notif._rawText);
  _notifCurrent = notif;
  const el = _notifEnsureEl();

  // Icon
  const iconEl = el.querySelector('.notif-toast-icon');
  if (notif.icon) { iconEl.textContent = notif.icon; iconEl.style.display = ''; }
  else { iconEl.style.display = 'none'; }

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
    actionBtn.onclick = () => {
      notif.action();
      if (typeof _aTrack === 'function') _aTrack('notification_action', { id: notif.id, priority: notif.priority, category: notif.category });
      _notifHide();
    };
  } else {
    actionBtn.style.display = 'none';
  }

  // Close button
  el.querySelector('.notif-toast-close').onclick = () => {
    if (typeof _aTrack === 'function') _aTrack('notification_dismiss', { id: notif.id, priority: notif.priority, category: notif.category, method: 'close' });
    _notifDismiss(notif.id);
  };

  // Tap on body area also triggers action (if available) for easy mobile use
  el.querySelector('.notif-toast-content').onclick = () => {
    if (notif.action) {
      notif.action();
      if (typeof _aTrack === 'function') _aTrack('notification_action', { id: notif.id, priority: notif.priority, category: notif.category });
      _notifHide();
    }
  };

  const wrap = document.getElementById('notif-toast-wrap');
  if (wrap) wrap.classList.add('show');
  // Measure the rendered toast and expose its height as `--notif-h` so the
  // venue-list panel can shift down on desktop and avoid overlap. Without
  // this the CSS rule (`body:has(...) #panel { top: calc(70px + var(--notif-h, 0px) + 8px); }`)
  // had no effect because the variable was never set.
  _notifAttachHeightObserver(el);
  _notifShownCount++;
  _notifLastShownAt = Date.now();

  if (typeof _aTrack === 'function') _aTrack('notification_shown', {
    id: notif.id, priority: notif.priority, category: notif.category, queue_depth: _notifQueue.length
  });

  // Track for follow-up notifications
  if (notif.category === 'weather') _notifWeatherShownThisSession = true;

  // Auto-dismiss: P0 gets 30s (long but not forever), others 6s, legacy 2.2s
  clearTimeout(_notifAutoTimer);
  const duration = notif._legacyDismiss || (notif.priority === 0 ? 30000 : _NOTIF_AUTO_DEFAULT);
  _notifAutoTimer = setTimeout(() => {
    if (typeof _aTrack === 'function' && _notifCurrent) _aTrack('notification_dismiss', {
      id: _notifCurrent.id, priority: _notifCurrent.priority, category: _notifCurrent.category, method: 'auto'
    });
    _notifHide();
  }, duration);
}

function _notifHide() {
  clearTimeout(_notifAutoTimer);
  const wrap = document.getElementById('notif-toast-wrap');
  if (wrap) wrap.classList.remove('show');
  // Reset the panel offset so it animates back up alongside the toast fade.
  document.documentElement.style.setProperty('--notif-h', '0px');
  _notifDetachHeightObserver();
  _notifCurrent = null;
  // After hide animation, try next in queue
  setTimeout(() => _notifAdvance(), 400);
}

let _notifHeightObserver = null;
function _notifAttachHeightObserver(el) {
  _notifDetachHeightObserver();
  if (typeof ResizeObserver === 'undefined' || !el) {
    // Fallback: read height once after layout settles.
    requestAnimationFrame(() => {
      const h = el ? el.getBoundingClientRect().height : 0;
      document.documentElement.style.setProperty('--notif-h', h + 'px');
    });
    return;
  }
  _notifHeightObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const h = entry.contentRect ? entry.contentRect.height : entry.target.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--notif-h', h + 'px');
    }
  });
  _notifHeightObserver.observe(el);
}
function _notifDetachHeightObserver() {
  if (_notifHeightObserver) {
    try { _notifHeightObserver.disconnect(); } catch {}
    _notifHeightObserver = null;
  }
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
  const notif = _notifCurrent;
  const duration = notif._legacyDismiss || (notif.priority === 0 ? 30000 : _NOTIF_AUTO_DEFAULT);
  _notifAutoTimer = setTimeout(() => {
    if (typeof _aTrack === 'function' && _notifCurrent) _aTrack('notification_dismiss', {
      id: _notifCurrent.id, priority: _notifCurrent.priority, category: _notifCurrent.category, method: 'auto'
    });
    _notifHide();
  }, duration);
}

window.notifFreezeAutoDismiss = notifFreezeAutoDismiss;
window.notifResumeAutoDismiss = notifResumeAutoDismiss;

function _notifDismiss(id) {
  _notifDismissed.add(id);
  // Persist onboarding dismissals
  if (id.startsWith('onboard_')) {
    const state = _notifLoadState();
    if (!state.dismissed) state.dismissed = [];
    if (!state.dismissed.includes(id)) state.dismissed.push(id);
    _notifSaveState(state);
  }
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
  const duration = notif._legacyDismiss || (notif.priority === 0 ? 30000 : _NOTIF_AUTO_DEFAULT);
  _notifAutoTimer = setTimeout(() => {
    if (typeof _aTrack === 'function' && _notifCurrent) _aTrack('notification_dismiss', {
      id: _notifCurrent.id, priority: _notifCurrent.priority, category: _notifCurrent.category, method: 'auto'
    });
    _notifHide();
  }, duration);
}

// ── Current conditions helper ────────────────────────────────────────────────
// Shared precondition for weather evaluators. Computes whether right now is
// actually sunny/dry/clear, and how many venues are in sun this hour. Memoized
// per `_notifEvaluate` tick because the venues-in-sun scan is O(VENUES) and is
// called by multiple evaluators in the same cycle.

function _venuesInSunAtHour(dateStr, hour) {
  if (typeof VENUES === 'undefined' || !VENUES) return 0;
  let count = 0;
  for (const v of VENUES) {
    const { windows } = computeSunWindows(v, dateStr);
    if (windows && windows.some(w => w.start <= hour && w.end > hour)) count++;
  }
  return count;
}

function _evalCurrentConditions(dateStr, hour) {
  const key = `${dateStr}|${Math.floor(hour)}`;
  const cached = _notifConditionsCache.get(key);
  if (cached) return cached;
  const wxNow = (typeof getWeatherAt === 'function') ? getWeatherAt(dateStr, Math.floor(hour)) : null;
  const cloud  = wxNow ? wxNow.cloud  : 0;
  const precip = wxNow ? wxNow.precip : 0;
  const sunGeometric = (typeof currentSun !== 'undefined' && currentSun) ? currentSun.alt > 0 : true;
  const venuesInSun = sunGeometric ? _venuesInSunAtHour(dateStr, Math.floor(hour)) : 0;
  const qualityScore = (1 - Math.min(cloud, 1)) * (1 - Math.min(precip, 1)) * (sunGeometric ? 1 : 0);
  const cond = {
    wxNow,
    cloudHeavy: cloud > 0.6,
    raining: precip > 0.2,
    sunGeometric,
    venuesInSun,
    qualityScore,
  };
  _notifConditionsCache.set(key, cond);
  return cond;
}

// ── Evaluators: P0 Weather ───────────────────────────────────────────────────

// Fires when (a) no geometric sun remains, OR (b) sun exists on paper but
// every remaining hour today is heavily overcast (cloud > 0.85). Both cases
// share the same once-per-calendar-day persistence (`state.noSunShownDate`).
function _evalNoSunToday() {
  if (typeof VENUES === 'undefined' || !VENUES || !VENUES.length) return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  if (datePicker.value !== todayStr()) return null;
  const state = _notifLoadState();
  if (state.noSunShownDate === todayStr()) return null;
  const dateStr = datePicker.value;
  const now = currentHour();
  // (a) Geometric: any venue has a sun window after `now`?
  const hasGeometricSun = VENUES.some(v => {
    const { windows } = computeSunWindows(v, dateStr);
    return windows && windows.some(w => w.end > now);
  });
  if (!hasGeometricSun) {
    return {
      id: 'weather_no_sun', priority: 0, category: 'weather',
      icon: '☁️', bodyKey: 'notif_no_sun_body', actionKey: 'notif_open_calendar',
      action: () => { if (typeof _openQcPanel === 'function') _openQcPanel(); },
      ttl: 600000, dedupe: true,
    };
  }
  // (b) Weather: heavy overcast for every remaining hour up to sunset.
  if (typeof getWeatherAt !== 'function') return null;
  const sunsetH = (typeof SUNSET_H_ARC !== 'undefined' && SUNSET_H_ARC != null)
    ? Math.min(22, Math.floor(SUNSET_H_ARC))
    : 22;
  const startH = Math.ceil(now);
  if (sunsetH - startH < 2) return null; // not enough remaining hours to claim "all day"
  let allOvercast = true;
  let havePoints = false;
  for (let h = startH; h <= sunsetH; h++) {
    const wx = getWeatherAt(dateStr, h);
    if (!wx) continue;
    havePoints = true;
    if (wx.cloud <= 0.85) { allOvercast = false; break; }
  }
  if (!havePoints || !allOvercast) return null;
  return {
    id: 'weather_overcast_all_day', priority: 0, category: 'weather',
    icon: '☁️', bodyKey: 'notif_overcast_all_day_body', actionKey: 'notif_open_calendar',
    action: () => { if (typeof _openQcPanel === 'function') _openQcPanel(); },
    ttl: 600000, dedupe: true,
  };
}

function _evalSunSettingSoon() {
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  if (datePicker.value !== todayStr()) return null;
  if (typeof SUNSET_H_ARC === 'undefined' || SUNSET_H_ARC == null) return null;
  const now = currentHour();
  const timeLeft = SUNSET_H_ARC - now;
  // Fire when 30–60 min of sun remain
  if (timeLeft <= 0 || timeLeft > 1 || timeLeft < 0.5) return null;
  // No "you're missing it" framing when it's already overcast — there's
  // nothing to miss when the sky is grey.
  const cond = _evalCurrentConditions(datePicker.value, now);
  if (cond.cloudHeavy) return null;
  const sunsetTime = formatHour(SUNSET_H_ARC);
  return {
    id: 'weather_sun_setting', priority: 0, category: 'weather',
    icon: '🌅', bodyKey: 'notif_sun_setting_body',
    bodyVars: { time: sunsetTime },
    actionKey: 'notif_see_tomorrow',
    action: () => { if (typeof advanceDay === 'function') advanceDay(1, 12); },
    ttl: 600000, dedupe: true,
  };
}

function _evalCloudIncoming() {
  if (typeof getWeatherAt !== 'function') return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  const dateStr = datePicker.value;
  if (dateStr !== todayStr()) return null;
  const now = currentHour();
  const wxNow = getWeatherAt(dateStr, Math.floor(now));
  if (!wxNow || wxNow.cloud > 0.5) return null; // already cloudy
  // Don't warn about clouds rolling in if nothing is in sun anyway (e.g.
  // sun is up but every venue is shaded by buildings right now).
  const cond = _evalCurrentConditions(dateStr, now);
  if (cond.venuesInSun < 5) return null;
  for (let h = 1; h <= 3; h++) {
    const wxFuture = getWeatherAt(dateStr, Math.floor(now) + h);
    if (wxFuture && wxFuture.cloud > 0.7) {
      const lastClearHour = Math.floor(now) + h - 1;
      return {
        id: 'weather_cloud_incoming', priority: 0, category: 'weather',
        icon: '🌥️', bodyKey: 'notif_cloud_incoming_body',
        bodyVars: { hour: formatHour(lastClearHour) },
        actionKey: 'notif_set_time',
        action: () => {
          if (typeof timeFromEl !== 'undefined' && timeFromEl) {
            timeFromEl.value = lastClearHour;
            timeFromEl.dispatchEvent(new Event('input'));
          }
        },
        ttl: 300000, dedupe: true,
      };
    }
  }
  return null;
}


// Rain notification — informational only. The previous version offered a
// "Skip to {rainEnd}" CTA that bypassed every sunny hour preceding the rain;
// removing the action removes that failure mode entirely. We surface two
// distinct cases:
//   • imminent (rain ≤ 2h away) and conditions are decent right now
//   • currently raining with sun returning later today
// Otherwise the rain is too far off to be relevant — return null.
function _evalRainWindow() {
  if (typeof getWeatherAt !== 'function') return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  const dateStr = datePicker.value;
  if (dateStr !== todayStr()) return null;
  const now = Math.floor(currentHour());
  // Find first rain block from now onwards
  let rainStart = null, rainEnd = null;
  for (let h = now; h <= 23; h++) {
    const wx = getWeatherAt(dateStr, h);
    if (!wx) continue;
    if (wx.precip > 0.3 && rainStart === null) rainStart = h;
    if (wx.precip <= 0.3 && rainStart !== null && rainEnd === null) { rainEnd = h; break; }
  }
  if (rainStart === null) return null;
  // Currently raining → look for sun returning later
  if (rainStart <= now) {
    if (rainEnd === null) return null; // rain doesn't stop today, nothing helpful to say
    const sunsetH = (typeof SUNSET_H_ARC !== 'undefined' && SUNSET_H_ARC != null) ? SUNSET_H_ARC : 22;
    if (rainEnd >= sunsetH - 1) return null; // sun is gone before rain ends
    return {
      id: 'weather_sun_returns', priority: 0, category: 'weather',
      icon: '🌦️', bodyKey: 'notif_sun_returns_body',
      bodyVars: { time: formatHour(rainEnd) },
      ttl: 300000, dedupe: true,
    };
  }
  // Rain in the future — only fire if it's imminent AND right now is decent
  // enough that "make the most of it before rain" is useful.
  if (rainStart - now > 2) return null;
  const cond = _evalCurrentConditions(dateStr, now);
  if (cond.qualityScore < 0.4) return null;
  return {
    id: 'weather_last_sun_before_rain', priority: 0, category: 'weather',
    icon: '🌧️', bodyKey: 'notif_last_sun_before_rain_body',
    bodyVars: { time: formatHour(rainStart) },
    ttl: 300000, dedupe: true,
  };
}

function _evalBestSunWindow() {
  if (typeof VENUES === 'undefined' || !VENUES || !VENUES.length) return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  const dateStr = datePicker.value;
  if (dateStr !== todayStr()) return null;
  const now = currentHour();
  // Too late in the day for a "peak" to be actionable
  if (now >= 18) return null;
  // Don't suggest jumping forward if right now is already great.
  const cond = _evalCurrentConditions(dateStr, now);
  if (cond.qualityScore > 0.7) return null;
  // Count venues with sun per hour
  let bestHour = -1, bestCount = 0;
  for (let h = Math.max(6, Math.ceil(now)); h <= 21; h++) {
    const count = _venuesInSunAtHour(dateStr, h);
    if (count > bestCount) { bestCount = count; bestHour = h; }
  }
  if (bestHour < 0 || bestCount < 15) return null; // not enough venues with sun
  // Suppress when peak hour is mostly cloudy or wet
  let wxAtPeak = null;
  if (typeof getWeatherAt === 'function') {
    wxAtPeak = getWeatherAt(dateStr, bestHour);
    if (wxAtPeak && (wxAtPeak.cloud > 0.65 || wxAtPeak.precip >= 0.2)) return null;
  }
  // Require a meaningful weather improvement at the peak vs. now —
  // either the cloud cover drops by ≥ 0.2, or it's currently raining and
  // the peak is dry.
  if (wxAtPeak && cond.wxNow) {
    const cloudImproves = (wxAtPeak.cloud + 0.2) < cond.wxNow.cloud;
    const rainStops    = cond.raining && wxAtPeak.precip < 0.1;
    if (!cloudImproves && !rainStops) return null;
  }
  // Find the peak block (contiguous hours with same-ish count)
  let blockStart = bestHour, blockEnd = bestHour;
  for (let h = bestHour - 1; h >= Math.ceil(now); h--) {
    if (_venuesInSunAtHour(dateStr, h) >= bestCount * 0.7) blockStart = h; else break;
  }
  for (let h = bestHour + 1; h <= 21; h++) {
    if (_venuesInSunAtHour(dateStr, h) >= bestCount * 0.7) blockEnd = h; else break;
  }
  // Require the peak to be meaningfully better than right now (venue count)
  const nowH = Math.ceil(now);
  const nowCount = _venuesInSunAtHour(dateStr, nowH);
  if (bestCount < nowCount * 1.3 && bestCount - nowCount < 5) return null;
  // Only show if peak is in the future
  if (blockEnd <= now) return null;
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
    ttl: 600000, dedupe: true,
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
  return {
    id: 'social_checkin', priority: 1, category: 'social',
    icon: '📍', bodyKey: 'notif_checkin_body',
    bodyVars: { venue: nearest.name },
    actionKey: 'notif_checkin_action',
    action: () => { if (typeof checkInToVenue === 'function') checkInToVenue(nearest.id); },
    ttl: 300000, dedupe: true,
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
  const KEY = 'solsteder_seen_invite_responses';
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const newAccepts = []; // [{plan, invitee}]
  for (const p of _plans) {
    if (p.creator_id !== _currentUser.id) continue;
    if (!Array.isArray(p._invitees)) continue;
    for (const inv of p._invitees) {
      if (inv.status !== 'accepted') continue;
      const k = `${p.id}:${inv.user_id}`;
      if (seen[k] === 'accepted') continue;
      newAccepts.push({ plan: p, invitee: inv });
    }
  }
  if (!newAccepts.length) return null;
  const head = newAccepts[0];
  const venue = (typeof VENUES !== 'undefined') ? VENUES.find(x => String(x.id) === String(head.plan.venue_id)) : null;
  if (!venue) return null;
  const u = head.invitee.user || {};
  const name = (u.name || u.email || '').split(' ')[0].split('@')[0] || '…';
  const extra = newAccepts.length - 1;
  // Off-plan-time arrival → include the time in the toast: "Maja sa ja til
  // Egon — kommer 14:00". Skips when arrival_time is null or within 5 min of
  // plan time. Only applies to the single-accept (extra === 0) variant.
  let arrivalTime = null;
  if (extra === 0 && head.invitee.arrival_time && head.plan.planned_at) {
    const planMs = new Date(head.plan.planned_at).getTime();
    const arrMs = new Date(head.invitee.arrival_time).getTime();
    if (Math.abs(arrMs - planMs) >= 5 * 60 * 1000) {
      const d = new Date(arrMs);
      arrivalTime = (typeof formatHour === 'function')
        ? formatHour(d.getHours() + d.getMinutes() / 60)
        : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
  }
  let bodyKey;
  if (extra > 0) bodyKey = 'notif_invite_accepted_multi';
  else if (arrivalTime) bodyKey = 'notif_invite_accepted_at';
  else bodyKey = 'notif_invite_accepted_body';
  return {
    id: 'social_invite_accepted_' + head.plan.id + '_' + head.invitee.user_id,
    priority: 1, category: 'social',
    icon: '☀',
    bodyKey,
    bodyVars: { name, venue: venue.name, extra, time: arrivalTime || '' },
    actionKey: 'notif_open_plan',
    action: () => {
      // Mark all queued accepts as seen (don't keep nagging once user has responded)
      try {
        const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
        for (const a of newAccepts) cur[`${a.plan.id}:${a.invitee.user_id}`] = 'accepted';
        localStorage.setItem(KEY, JSON.stringify(cur));
      } catch {}
      if (typeof openPlanPreview === 'function') {
        openPlanPreview({ venueId: head.plan.venue_id, plannedAt: head.plan.planned_at, mode: 'preview' });
      } else if (typeof selectVenue === 'function') {
        selectVenue(Number(head.plan.venue_id), true);
      }
    },
    ttl: 600000, dedupe: true,
    _onShow: () => {
      // Persist dedupe at show-time so a missed action still doesn't re-fire.
      try {
        const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
        for (const a of newAccepts) cur[`${a.plan.id}:${a.invitee.user_id}`] = 'accepted';
        localStorage.setItem(KEY, JSON.stringify(cur));
      } catch {}
    },
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
    ttl: 600000, dedupe: true,
  };
}

// ── Evaluators: P2 Suggestions ───────────────────────────────────────────────
// The old time-of-day "now is a good moment" suggestions (morgensol / lunsj /
// afterwork / wind-shelter) were removed — they duplicated information already
// visible on the live map and ignored current weather, leading to "morning sun
// recommended while overcast" misfires. Only data-driven suggestions remain.

function _evalBusynessAlert() {
  if (typeof _currentUser === 'undefined' || !_currentUser) return null;
  if (typeof _favoritesSet === 'undefined' || !_favoritesSet.size) return null;
  if (typeof VENUES === 'undefined' || !VENUES) return null;
  if (typeof getBusynessForDay !== 'function') return null;
  const dateStr = datePicker.value;
  if (dateStr !== todayStr()) return null;
  const now = currentHour();
  for (const v of VENUES) {
    if (!_favoritesSet.has(String(v.id))) continue;
    const busy = getBusynessForDay(v, dateStr);
    if (!busy) continue;
    // Find peak hour
    let peakH = 0, peakVal = 0;
    for (let h = 0; h < 24; h++) {
      if (busy[h] > peakVal) { peakVal = busy[h]; peakH = h; }
    }
    // Alert if we're within 1h before peak and peak is high
    if (peakVal >= 60 && now >= peakH - 1 && now < peakH) {
      return {
        id: 'suggest_busyness_' + v.id, priority: 2, category: 'suggestion',
        icon: '⏰', bodyKey: 'notif_busyness_body',
        bodyVars: { venue: v.name, time: formatHour(peakH) },
        actionKey: 'notif_go_to_venue',
        action: () => { if (typeof selectVenue === 'function') selectVenue(v.id, true); },
        ttl: 300000, dedupe: true,
      };
    }
  }
  return null;
}

// ── Evaluators: P3 Onboarding ────────────────────────────────────────────────

function _evalWelcome() {
  const state = _notifLoadState();
  if ((state.sessionCount || 0) > 1) return null;
  if ((state.onboardingSeen?.welcome || 0) >= 1) return null;
  return {
    id: 'onboard_welcome', priority: 3, category: 'onboarding',
    icon: '👋', bodyKey: 'notif_welcome_body',
    actionKey: null, action: null,
    ttl: 120000, dedupe: true,
  };
}

function _evalTimeSliderHint() {
  const state = _notifLoadState();
  if ((state.sessionCount || 0) > 3) return null;
  if ((state.onboardingSeen?.slider || 0) >= 2) return null;
  return {
    id: 'onboard_slider', priority: 3, category: 'onboarding',
    icon: '⏱️', bodyKey: 'notif_slider_hint_body',
    actionKey: null, action: null,
    ttl: 120000, dedupe: true,
  };
}

function _evalFilterHint() {
  const state = _notifLoadState();
  if ((state.sessionCount || 0) > 3) return null;
  if ((state.onboardingSeen?.filter || 0) >= 2) return null;
  return {
    id: 'onboard_filter', priority: 3, category: 'onboarding',
    icon: '📍', bodyKey: 'notif_filter_hint_body',
    actionKey: null, action: null,
    ttl: 120000, dedupe: true,
  };
}

function _evalCalendarHint() {
  const state = _notifLoadState();
  if ((state.sessionCount || 0) > 3) return null;
  if ((state.onboardingSeen?.calendar || 0) >= 2) return null;
  return {
    id: 'onboard_calendar', priority: 3, category: 'onboarding',
    icon: '📅', bodyKey: 'notif_calendar_hint_body',
    actionKey: null, action: null,
    ttl: 120000, dedupe: true,
  };
}

// ── Evaluators: P1 Login Prompts ─────────────────────────────────────────────

function _evalLoginWeather() {
  if (typeof _currentUser !== 'undefined' && _currentUser) return null;
  if (!_notifWeatherShownThisSession) return null;
  if (_notifLoginShown.has('login_weather')) return null;
  return {
    id: 'login_weather', priority: 1, category: 'login',
    icon: '🔔', bodyKey: 'notif_login_weather_body',
    actionKey: 'notif_login_action',
    action: () => { if (typeof toggleProfilePanel === 'function') toggleProfilePanel(); },
    ttl: 120000, dedupe: true,
  };
}

function _evalLoginFriends() {
  if (typeof _currentUser !== 'undefined' && _currentUser) return null;
  const state = _notifLoadState();
  if ((state.sessionCount || 0) < 2) return null;
  if (_notifLoginShown.has('login_friends')) return null;
  return {
    id: 'login_friends', priority: 1, category: 'login',
    icon: '👥', bodyKey: 'notif_login_friends_body',
    actionKey: 'notif_login_action',
    action: () => { if (typeof toggleProfilePanel === 'function') toggleProfilePanel(); },
    ttl: 120000, dedupe: true,
  };
}

function _evalLoginShare() {
  if (typeof _currentUser !== 'undefined' && _currentUser) return null;
  if (_notifVenueOpens < 2) return null;
  if (_notifLoginShown.has('login_share')) return null;
  return {
    id: 'login_share', priority: 1, category: 'login',
    icon: '🔗', bodyKey: 'notif_login_share_body',
    actionKey: 'notif_login_action',
    action: () => { if (typeof toggleProfilePanel === 'function') toggleProfilePanel(); },
    ttl: 120000, dedupe: true,
  };
}

function _evalLoginNewVenues() {
  if (typeof _currentUser !== 'undefined' && _currentUser) return null;
  const state = _notifLoadState();
  if ((state.sessionCount || 0) < 3) return null;
  if (_notifLoginShown.has('login_venues')) return null;
  return {
    id: 'login_venues', priority: 1, category: 'login',
    icon: '✨', bodyKey: 'notif_login_venues_body',
    actionKey: 'notif_login_action',
    action: () => { if (typeof toggleProfilePanel === 'function') toggleProfilePanel(); },
    ttl: 120000, dedupe: true,
  };
}

// ── Evaluator Registry ───────────────���──────────────────────────────────────���

const _notifEvaluators = [
  // P0 Weather (no auto-dismiss — stays until user acts)
  _evalNoSunToday,
  _evalSunSettingSoon,
  _evalCloudIncoming,
  _evalRainWindow,
  _evalBestSunWindow,
  // P1 Social
  _evalFriendsAtVenue,
  _evalCheckinPrompt,
  _evalFriendPlanning,
  _evalInviteAccepted,
  // P1 Login prompts (high priority so they reach anon users)
  _evalLoginWeather,
  _evalLoginFriends,
  _evalLoginShare,
  _evalLoginNewVenues,
  // P2 Suggestions
  _evalBusynessAlert,
  // P3 Onboarding
  _evalWelcome,
  _evalTimeSliderHint,
  _evalFilterHint,
  _evalCalendarHint,
];

// ── Evaluate & Schedule ──────────────────────────────────────────────────────

function _notifEvaluate() {
  if (!_notifInitDone) { console.log('[notif] evaluate skipped: not init'); return; }
  // Invalidate the per-tick conditions memo so re-evaluations see fresh
  // weather/sun data after the user moves the time slider or weather refreshes.
  _notifConditionsCache.clear();
  const settings = _notifGetSettings();
  let enqueued = 0;
  for (const evaluator of _notifEvaluators) {
    try {
      const notif = evaluator();
      if (!notif) continue;
      if (!settings[notif.category]) { console.log('[notif] blocked by settings:', notif.id); continue; }
      if (_notifDismissed.has(notif.id)) { console.log('[notif] dismissed:', notif.id); continue; }
      // Login prompts: max 1 per type per session
      if (notif.category === 'login' && _notifLoginShown.has(notif.id)) continue;
      _notifEnqueue(notif);
      enqueued++;
      console.log('[notif] enqueued:', notif.id, 'p' + notif.priority);
    } catch (e) {
      console.warn('[notif] evaluator error:', evaluator.name, e);
    }
  }
  console.log('[notif] evaluate done. queue:', _notifQueue.length, 'current:', _notifCurrent?.id || 'none', 'canShow:', _notifCanShow());
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

/** Build the notification settings HTML for the profile panel. */
function _notifSettingsHtml() {
  const settings = _notifGetSettings();
  const categories = [
    { key: 'weather',    labelKey: 'notif_cat_weather' },
    { key: 'social',     labelKey: 'notif_cat_social' },
    { key: 'suggestion', labelKey: 'notif_cat_suggestion' },
    { key: 'onboarding', labelKey: 'notif_cat_onboarding' },
  ];
  let rows = `<div class="settings-row pref-row is-disabled">
    <span class="settings-row__label">${t('notif_push_coming_soon')}</span>
    <span class="settings-row__value">${t('push_status_off')}</span>
    <span class="settings-status-pill">${t('notif_coming_soon')}</span>
  </div>`;
  for (const cat of categories) {
    const on = settings[cat.key] !== false;
    rows += `<div class="settings-row pref-row">
      <span class="settings-row__label">${t(cat.labelKey)}</span>
      <button class="toggle-switch${on ? ' is-on' : ''}"
              role="switch" aria-checked="${on}"
              aria-label="${t(cat.labelKey)}"
              onclick="_notifToggle('${cat.key}')"></button>
    </div>`;
  }
  return `<div>
    <div class="settings-group-label">${t('notif_settings')}</div>
    <div class="settings-group">${rows}</div>
  </div>`;
}

// ── Track venue opens (for login_share evaluator) ────────────────────────────

function _notifOnVenueOpen() {
  _notifVenueOpens++;
}

// ── Init ─────────────────────────────────────────���───────────────────────────

function _notifInit() {
  console.log('[notif] init called');
  // Increment session count
  const state = _notifLoadState();
  state.sessionCount = (state.sessionCount || 0) + 1;
  state.lastSessionTs = Date.now();
  if (!state.onboardingSeen) state.onboardingSeen = {};
  _notifSaveState(state);

  // Restore persistent dismissals (onboarding only)
  if (state.dismissed) {
    for (const id of state.dismissed) _notifDismissed.add(id);
  }

  _notifInitDone = true;

  // Start periodic evaluation
  _notifEvalTimer = setInterval(_notifEvaluate, _NOTIF_EVAL_INTERVAL);

  // Initial evaluation after a longer delay — let the user get acquainted with the UI first
  setTimeout(_notifEvaluate, 8000);
}

// Track onboarding seen counts when shown
const _origNotifShow = _notifShow;
_notifShow = function(notif) {
  _origNotifShow(notif);
  if (notif.id.startsWith('onboard_')) {
    const state = _notifLoadState();
    if (!state.onboardingSeen) state.onboardingSeen = {};
    const key = notif.id.replace('onboard_', '');
    state.onboardingSeen[key] = (state.onboardingSeen[key] || 0) + 1;
    _notifSaveState(state);
  }
  if (notif.category === 'login') {
    _notifLoginShown.add(notif.id);
  }
  // Mark "no sun" as shown for today so it doesn't repeat across sessions
  if (notif.id === 'weather_no_sun' || notif.id === 'weather_overcast_all_day') {
    const state = _notifLoadState();
    state.noSunShownDate = todayStr();
    _notifSaveState(state);
  }
  // Per-category cooldown bookkeeping
  _notifLastByCategory[notif.category] = Date.now();
  // Per-day weather cap bookkeeping
  if (notif.category === 'weather') {
    const state = _notifLoadState();
    if (!state.weatherShownDates) state.weatherShownDates = {};
    const today = todayStr();
    state.weatherShownDates[today] = (state.weatherShownDates[today] || 0) + 1;
    // Garbage-collect old entries (keep last 14 days only)
    const keep = Object.keys(state.weatherShownDates).sort().slice(-14);
    state.weatherShownDates = Object.fromEntries(keep.map(k => [k, state.weatherShownDates[k]]));
    _notifSaveState(state);
  }
  // Per-notification _onShow hook (used by social_invite_accepted to persist dedupe)
  if (typeof notif._onShow === 'function') {
    try { notif._onShow(); } catch (e) { /* ignore */ }
  }
};
