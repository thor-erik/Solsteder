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

function _notifAdvance() {
  if (_notifCurrent) return; // one at a time
  if (!_notifCanShow()) return;
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
  _notifCurrent = null;
  // After hide animation, try next in queue
  setTimeout(() => _notifAdvance(), 400);
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

// ── Evaluators: P0 Weather ───────────────���─────────────────────────────���─────

function _evalNoSunToday() {
  if (typeof VENUES === 'undefined' || !VENUES || !VENUES.length) return null;
  if (typeof datePicker === 'undefined' || !datePicker) return null;
  if (datePicker.value !== todayStr()) return null;
  // Only show once per calendar day — don't nag on every session
  const state = _notifLoadState();
  if (state.noSunShownDate === todayStr()) return null;
  // Check if ANY venue has sun from now onwards (not the whole day)
  const now = currentHour();
  const hasSun = VENUES.some(v => {
    const { windows } = computeSunWindows(v, datePicker.value);
    return windows && windows.some(w => w.end > now);
  });
  if (hasSun) return null;
  return {
    id: 'weather_no_sun', priority: 0, category: 'weather',
    icon: '☁️', bodyKey: 'notif_no_sun_body', actionKey: 'notif_open_calendar',
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
  // Suppress when peak hour is mostly cloudy or wet (skip gating if no weather data)
  if (typeof getWeatherAt === 'function') {
    const wx = getWeatherAt(dateStr, bestHour);
    if (wx && (wx.cloud > 0.65 || wx.precip >= 0.2)) return null;
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
  return {
    id: 'social_invite_accepted_' + head.plan.id + '_' + head.invitee.user_id,
    priority: 1, category: 'social',
    icon: '☀',
    bodyKey: extra > 0 ? 'notif_invite_accepted_multi' : 'notif_invite_accepted_body',
    bodyVars: { name, venue: venue.name, extra },
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

function _evalMorningCoffee() {
  if (typeof datePicker === 'undefined' || datePicker.value !== todayStr()) return null;
  const now = currentHour();
  if (now >= 11 || now < 7) return null; // only 7-11
  if (typeof currentSun === 'undefined' || !currentSun || currentSun.alt <= 0) return null;
  return {
    id: 'suggest_morning', priority: 2, category: 'suggestion',
    icon: '☕', bodyKey: 'notif_morning_body',
    actionKey: null, action: null,
    ttl: 120000, dedupe: true,
  };
}

function _evalLunchBreak() {
  if (typeof datePicker === 'undefined' || datePicker.value !== todayStr()) return null;
  const now = currentHour();
  if (now < 11 || now > 13) return null;
  const day = new Date().getDay();
  if (day === 0 || day === 6) return null; // weekdays only
  return {
    id: 'suggest_lunch', priority: 2, category: 'suggestion',
    icon: '🍽️', bodyKey: 'notif_lunch_body',
    bodyVars: { hour: '12:00' },
    actionKey: 'notif_set_time',
    action: () => {
      if (typeof timeFromEl !== 'undefined' && timeFromEl) {
        timeFromEl.value = 12;
        timeFromEl.dispatchEvent(new Event('input'));
      }
    },
    ttl: 120000, dedupe: true,
  };
}

function _evalAfterWork() {
  if (typeof datePicker === 'undefined' || datePicker.value !== todayStr()) return null;
  const now = currentHour();
  if (now < 15 || now > 17) return null;
  const day = new Date().getDay();
  if (day === 0 || day === 6) return null; // weekdays only
  if (typeof currentSun === 'undefined' || !currentSun || currentSun.alt <= 0) return null;
  return {
    id: 'suggest_afterwork', priority: 2, category: 'suggestion',
    icon: '🍻', bodyKey: 'notif_afterwork_body',
    actionKey: null, action: null,
    ttl: 120000, dedupe: true,
  };
}

function _evalWindSheltered() {
  if (typeof getWeatherAt !== 'function') return null;
  if (typeof datePicker === 'undefined') return null;
  if (datePicker.value !== todayStr()) return null;
  const wx = getWeatherAt(datePicker.value, Math.floor(currentHour()));
  if (!wx || wx.wspd <= 8) return null;
  return {
    id: 'suggest_sheltered', priority: 2, category: 'suggestion',
    icon: '🛡️', bodyKey: 'notif_sheltered_body',
    actionKey: null, action: null,
    ttl: 300000, dedupe: true,
  };
}

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
  _evalMorningCoffee,
  _evalLunchBreak,
  _evalAfterWork,
  _evalWindSheltered,
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
  const eyeOn = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  const eyeOff = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
  let html = `<div class="profile-panel-section profile-settings-section">
    <div class="profile-section-label">${t('notif_settings')}</div>`;
  for (const cat of categories) {
    const on = settings[cat.key] !== false;
    html += `<div class="profile-pref-row">
      <span class="profile-pref-label">${t(cat.labelKey)}</span>
      <button class="pref-pill checkin-vis-toggle${on ? ' active' : ''}" onclick="_notifToggle('${cat.key}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${on ? eyeOn : eyeOff}
        </svg>
      </button>
    </div>`;
  }
  // Push notification teaser (greyed out)
  html += `<div class="profile-pref-row" style="opacity:0.4;pointer-events:none">
    <span class="profile-pref-label">${t('notif_push_coming_soon')}</span>
    <span style="font-size:11px;color:var(--muted)">${t('notif_coming_soon')}</span>
  </div>`;
  html += `</div>`;
  return html;
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
  if (notif.id === 'weather_no_sun') {
    const state = _notifLoadState();
    state.noSunShownDate = todayStr();
    _notifSaveState(state);
  }
  // Per-notification _onShow hook (used by social_invite_accepted to persist dedupe)
  if (typeof notif._onShow === 'function') {
    try { notif._onShow(); } catch (e) { /* ignore */ }
  }
};
