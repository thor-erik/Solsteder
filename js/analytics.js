// ── Analytics ──────────────────────────────────────────────────────────────────
// Lightweight event tracker. Buffers events in memory and flushes to Supabase
// in batches (every 10 events or 30 s, whichever comes first). Uses sendBeacon
// on page unload so no events are lost. No cookies — session ID lives only in
// memory and resets on every page load.

const _A_BATCH   = 10;      // flush after N buffered events
const _A_INTERVAL = 30000;  // flush every 30 s

let _aSessionId = crypto.randomUUID();
let _aBuffer    = [];
let _aTimer     = null;
let _aDevice    = null;     // captured once at init
let _aDetailOpenTs = null;  // timestamp when detail panel was opened

// ── Device snapshot (sent with every event) ──────────────────────────────────
function _aCaptureDevice() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    sw: screen.width,
    sh: screen.height,
    vw: w,
    vh: h,
    lang: typeof _currentLang !== 'undefined' ? _currentLang : navigator.language,
    mobile: w < 641,
    referrer: document.referrer || null,
  };
}

// ── Parse UTM params from URL ────────────────────────────────────────────────
function _aUtmParams() {
  const p = new URLSearchParams(location.search);
  const out = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
    if (p.has(k)) out[k] = p.get(k);
  }
  return Object.keys(out).length ? out : null;
}

// ── Core tracking function ───────────────────────────────────────────────────
function _aTrack(event, properties) {
  const row = {
    session_id: _aSessionId,
    user_id:    (typeof _currentUser !== 'undefined' && _currentUser) ? _currentUser.id : null,
    event,
    properties: properties || {},
    device:     _aDevice,
    created_at: new Date().toISOString(),
  };
  _aBuffer.push(row);
  if (_aBuffer.length >= _A_BATCH) _aFlush();
}

// ── Flush buffer to Supabase ─────────────────────────────────────────────────
async function _aFlush() {
  if (!_aBuffer.length) return;
  const batch = _aBuffer.splice(0);
  try {
    await _supabase.from('events').insert(batch);
  } catch (_) {
    // Silent fail — analytics must never break the app
  }
}

// ── Beacon flush on page unload ──────────────────────────────────────────────
function _aBeacon() {
  if (!_aBuffer.length) return;
  const batch = _aBuffer.splice(0);
  const url = SUPABASE_URL + '/rest/v1/events';
  const body = JSON.stringify(batch);
  navigator.sendBeacon(url + '?', new Blob([body], { type: 'application/json' }));
  // Note: sendBeacon to Supabase REST requires the anon key as apikey header.
  // Blob-based sendBeacon doesn't support custom headers, so we use the fetch
  // keepalive fallback below instead.
  try {
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer':        'return=minimal',
      },
      body,
      keepalive: true,
    });
  } catch (_) { /* best-effort */ }
}

// ── Init ─────────────────────────────────────────────────────────────────────
function _aInit() {
  _aDevice = _aCaptureDevice();

  // Periodic flush
  _aTimer = setInterval(_aFlush, _A_INTERVAL);

  // Flush on page hide / unload
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _aBeacon();
  });
  window.addEventListener('pagehide', _aBeacon);

  // Session start event
  _aTrack('session_start', {
    utm: _aUtmParams(),
    hash: location.hash || null,
  });
}

// Start immediately (script loads after auth.js, so _supabase is available)
_aInit();
