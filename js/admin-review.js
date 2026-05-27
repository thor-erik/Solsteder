/**
 * admin-review.js — Flag-computing library for the audit feature.
 *
 * Previously this was a standalone "Review terraces" mode with its own
 * toggle, indicator pill, and Mark OK / Hide actions. Audit mode subsumed
 * all of that — the chips and heuristics are now surfaced inline on audit
 * cards. What remains here is the library API:
 *
 *   computeReviewFlags(v, dateStr) → string[]
 *   refreshReviewFlags(dateStr)    — rebuilds the cache (called by audit on date/data change)
 *   venueReviewFlags(v)            → cached string[] | null
 *   reviewFlagCount()              → number
 *   REVIEW_FLAG_LABELS             — { code: humanLabel }
 *   reviewFlagLabel(code)          → string
 *
 * Reads VENUES, computeSunWindows, pointInPolygon. No UI state, no toggles.
 */

let _reviewFlagsCache = new Map();    // venueId → string[]

// ── Heuristics ────────────────────────────────────────────────────────────────
function computeReviewFlags(v, dateStr) {
  const flags = [];

  // Skip rooftops entirely — they have a different sun model (altitude-only)
  // and can't be evaluated by these heuristics.
  if (v.terraceType === 'rooftop') {
    if (!v.buildingGeometry?.length) flags.push('no-geometry');
    return flags;
  }

  const { windows } = (typeof computeSunWindows === 'function')
    ? computeSunWindows(v, dateStr)
    : { windows: [] };
  const totalSunHours = windows.reduce((s, w) => s + (w.end - w.start), 0);

  if (windows.length === 0 && v.terraceType !== 'courtyard') {
    flags.push('no-sun');
  } else if (totalSunHours < 1.5 && v.terraceType !== 'courtyard') {
    flags.push('low-sun');
  }

  if (v.terraceType === 'street' && v.facing != null && v.facingSource !== 'manual') {
    const f = ((v.facing % 360) + 360) % 360;
    if (f >= 315 || f < 45) flags.push('north-facing');
  }

  if (v.terraceType === 'street' && v.terraceTestPoints?.length && v.buildingGeometry?.length) {
    const inBuilding = v.terraceTestPoints.some(p =>
      pointInPolygon(p.lat, p.lng, v.buildingGeometry)
    );
    if (inBuilding) flags.push('points-in-building');
  }

  if (!v.buildingGeometry?.length && v.terraceType !== 'detached') {
    flags.push('no-geometry');
  }

  if (v.terraceType === 'street' && !v.seatingPolygonOverride) {
    if (v.seatingNotVisible) {
      flags.push('seating-not-visible');
    } else if (v.seatingPolygonAi
        && typeof v.seatingPolygonAiConfidence === 'number'
        && v.seatingPolygonAiConfidence < 0.5) {
      flags.push('low-confidence-seating');
    }
  }

  return flags;
}

function refreshReviewFlags(dateStr) {
  _reviewFlagsCache.clear();
  if (typeof VENUES === 'undefined') return;
  for (const v of VENUES) {
    if (v.businessStatus === 'CLOSED_PERMANENTLY') continue;
    if (v.auditArchived) continue;          // archived = out of audit scope
    const flags = computeReviewFlags(v, dateStr);
    if (flags.length) _reviewFlagsCache.set(v.id, flags);
  }
}

function venueReviewFlags(v) { return _reviewFlagsCache.get(v.id) ?? null; }
function reviewFlagCount()   { return _reviewFlagsCache.size; }

// ── Friendly labels for chips (consumed by ui-list.js + admin-audit.js) ──────
// Concise, plain-language flags. Each names the suspected problem so the
// reviewer knows why the venue surfaced, in as few words as possible.
const REVIEW_FLAG_LABELS = {
  'no-sun':                 'No sun',
  'low-sun':                'Low sun',
  'north-facing':           'Faces north',
  'points-in-building':     'Inside building',
  'no-geometry':            'No building',
  'low-confidence-seating': 'Unsure area',
  'seating-not-visible':    'Not visible',
};
function reviewFlagLabel(code) { return REVIEW_FLAG_LABELS[code] ?? code; }
