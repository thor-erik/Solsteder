/**
 * admin-review.js — Admin "Review terraces" toggle.
 *
 * Surfaces venues whose terrace data is suspect (no sun all day, very
 * little sun, suspicious facing, or test points inside the building),
 * so admins can fix them via the existing terrace editor without
 * trial-and-error clicking.
 *
 * Visible only when authIsAdmin() is true.
 *
 * Reads:
 *   - VENUES (data.js)
 *   - computeSunWindows(v, dateStr)   (app.js)
 *   - pointInPolygon(lat, lng, nodes) (solar.js)
 *   - authIsAdmin()                   (auth.js)
 *   - saveCorrection()                (data.js)
 *
 * Writes:
 *   - localStorage[DISMISSED_KEY] — venue IDs the admin marked OK
 *   - venue.businessStatus on Hide
 */

let reviewModeActive   = false;
let _reviewFlagsCache  = new Map(); // venueId -> string[] reason codes

const DISMISSED_KEY = 'solsteder_review_dismissed_v1';

function loadDismissed() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}'))); }
  catch { return new Map(); }
}
function saveDismissed(map) {
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(Object.fromEntries(map)));
}

// ── Heuristics ────────────────────────────────────────────────────────────────

function computeReviewFlags(v, dateStr) {
  const flags = [];

  // Skip rooftops entirely — they have a different sun model
  // (altitude-only) and can't be evaluated by these heuristics.
  if (v.terraceType === 'rooftop') {
    if (!v.buildingGeometry?.length) flags.push('no-geometry');
    return flags;
  }

  const { windows } = (typeof computeSunWindows === 'function')
    ? computeSunWindows(v, dateStr)
    : { windows: [] };
  const totalSunHours = windows.reduce((s, w) => s + (w.end - w.start), 0);

  // Zero sun all day (skip courtyards — legitimately sun-poor)
  if (windows.length === 0 && v.terraceType !== 'courtyard') {
    flags.push('no-sun');
  } else if (totalSunHours < 1.5 && v.terraceType !== 'courtyard') {
    flags.push('low-sun');
  }

  // North-facing street terrace, not manually set — likely auto-detection
  // picked the wrong wall.
  if (v.terraceType === 'street' && v.facing != null && v.facingSource !== 'manual') {
    const f = ((v.facing % 360) + 360) % 360;
    if (f >= 315 || f < 45) flags.push('north-facing');
  }

  // Test points inside the venue's own building footprint — definite bug.
  if (v.terraceType === 'street' && v.terraceTestPoints?.length && v.buildingGeometry?.length) {
    const inBuilding = v.terraceTestPoints.some(p =>
      pointInPolygon(p.lat, p.lng, v.buildingGeometry)
    );
    if (inBuilding) flags.push('points-in-building');
  }

  // Missing geometry entirely (the SUGAR & SPICE / Wright case).
  if (!v.buildingGeometry?.length && v.terraceType !== 'detached') {
    flags.push('no-geometry');
  }

  return flags;
}

function refreshReviewFlags(dateStr) {
  const dismissed = loadDismissed();
  _reviewFlagsCache.clear();
  if (typeof VENUES === 'undefined') return;
  for (const v of VENUES) {
    if (dismissed.has(String(v.id))) continue;
    if (v.businessStatus === 'CLOSED_PERMANENTLY') continue;
    const flags = computeReviewFlags(v, dateStr);
    if (flags.length) _reviewFlagsCache.set(v.id, flags);
  }
  _updateReviewIndicator();
}

function venueReviewFlags(v) { return _reviewFlagsCache.get(v.id) ?? null; }
function reviewFlagCount()   { return _reviewFlagsCache.size; }

// ── Admin actions ─────────────────────────────────────────────────────────────

function dismissReviewFlag(venueId, reasonNote = '') {
  const d = loadDismissed();
  d.set(String(venueId), { at: new Date().toISOString(), note: reasonNote });
  saveDismissed(d);
  _reviewFlagsCache.delete(venueId);
  _updateReviewIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

function undismissReviewFlag(venueId) {
  const d = loadDismissed();
  d.delete(String(venueId));
  saveDismissed(d);
  if (reviewModeActive && typeof datePicker !== 'undefined') {
    refreshReviewFlags(datePicker.value);
  }
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

function hideVenueFromMap(venueId) {
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  if (!v) return;
  if (!confirm(`Hide "${v.name}" from the map?\n\nThis sets businessStatus = CLOSED_PERMANENTLY locally.\nYou'll still need to export corrections + commit data/venues.json to make it permanent.`)) return;
  const before = { businessStatus: v.businessStatus ?? null };
  v.businessStatus = 'CLOSED_PERMANENTLY';
  if (typeof saveCorrection === 'function') {
    saveCorrection('correction', {
      id: venueId, name: v.name,
      before, after: { businessStatus: 'CLOSED_PERMANENTLY' },
      autoState: 'review-hide',
    });
  }
  _reviewFlagsCache.delete(venueId);
  // Drop from in-memory list. The loader at js/data.js already filters
  // CLOSED_PERMANENTLY at load time, so this matches what'd happen on reload.
  if (typeof VENUES !== 'undefined') {
    VENUES = VENUES.filter(x => x.businessStatus !== 'CLOSED_PERMANENTLY');
  }
  _updateReviewIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// ── Toggle + indicator ────────────────────────────────────────────────────────

function _updateReviewIndicator() {
  const ind   = document.getElementById('review-mode-indicator');
  const count = document.getElementById('review-indicator-count');
  if (!ind || !count) return;
  ind.style.display = reviewModeActive ? '' : 'none';
  count.textContent = reviewModeActive ? `(${reviewFlagCount()})` : '';
}

function toggleReviewMode() {
  if (typeof authIsAdmin === 'function' && !authIsAdmin()) return;
  reviewModeActive = !reviewModeActive;
  if (reviewModeActive && typeof datePicker !== 'undefined') {
    refreshReviewFlags(datePicker.value);
  } else {
    _reviewFlagsCache.clear();
  }
  _updateReviewIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// ── Friendly labels for chips (consumed by ui-list.js) ────────────────────────

const REVIEW_FLAG_LABELS = {
  'no-sun':             '0h sun',
  'low-sun':            '<1.5h sun',
  'north-facing':       'facing N (auto)',
  'points-in-building': 'test pts in wall',
  'no-geometry':        'missing geometry',
};
function reviewFlagLabel(code) { return REVIEW_FLAG_LABELS[code] ?? code; }
