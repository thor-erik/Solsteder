/**
 * admin-audit.js — Admin "Polygon audit" mode.
 *
 * Sibling to admin-review.js. Where Review mode shows only *problem* venues,
 * Audit mode shows *every* venue so an admin can walk through the catalog
 * systematically and tick off each outdoor-seating polygon.
 *
 * In audit mode:
 *   - All filters bypassed (search, area, viewport-list-filter, surfacing,
 *     zoom-density on map pins)
 *   - Each venue shows a "Mark good" / "Reviewed" badge in the list card
 *   - Saving an edit OR clicking "Mark good" persists a reviewed flag,
 *     which paints a green check on the pin + green outline on the card.
 *   - Progress indicator (X/Y reviewed) sits in the top-bar pill.
 *
 * Reads:
 *   - VENUES (data.js), authIsAdmin() (auth.js)
 *
 * Writes:
 *   - localStorage[AUDIT_KEY] — { [venueId]: { at: ISO, via: 'good'|'edited' } }
 */

let auditModeActive  = false;
let auditFilter      = 'all';        // 'all' | 'todo' | 'done'
let _auditCache      = new Map();    // venueId → { at, via }

const AUDIT_KEY = 'solsteder_audit_v1';

function _loadAudit() {
  try {
    const raw = JSON.parse(localStorage.getItem(AUDIT_KEY) || '{}');
    return new Map(Object.entries(raw).map(([k, v]) => [_coerceId(k), v]));
  } catch { return new Map(); }
}
function _saveAudit() {
  const obj = {};
  for (const [k, v] of _auditCache) obj[String(k)] = v;
  try { localStorage.setItem(AUDIT_KEY, JSON.stringify(obj)); } catch {}
}
function _coerceId(k) {
  // VENUES use numeric ids; JSON keys come back as strings. Match the
  // venue.id type so Map.get(v.id) works.
  const n = Number(k);
  return Number.isFinite(n) && String(n) === k ? n : k;
}

// ── Query ────────────────────────────────────────────────────────────────────
function isVenueAudited(v)     { return v ? _auditCache.has(v.id) : false; }
function venueAuditEntry(v)    { return v ? _auditCache.get(v.id) ?? null : null; }
function auditTotalCount()     { return (typeof VENUES === 'undefined') ? 0 : VENUES.length; }
function auditReviewedCount()  {
  if (typeof VENUES === 'undefined') return 0;
  let n = 0;
  for (const v of VENUES) if (_auditCache.has(v.id)) n++;
  return n;
}

function auditMatchesFilter(v) {
  if (auditFilter === 'all')  return true;
  const reviewed = _auditCache.has(v.id);
  return auditFilter === 'done' ? reviewed : !reviewed;
}

function setAuditFilter(f) {
  if (!['all', 'todo', 'done'].includes(f)) return;
  auditFilter = f;
  _updateAuditIndicator();
  if (typeof renderList === 'function') renderList();
}

// ── Mutations ────────────────────────────────────────────────────────────────
function markVenueAudited(venueId, via = 'good') {
  _auditCache.set(venueId, { at: new Date().toISOString(), via });
  _saveAudit();
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (auditModeActive && typeof renderList === 'function') renderList();
}

function unmarkVenueAudited(venueId) {
  _auditCache.delete(venueId);
  _saveAudit();
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (auditModeActive && typeof renderList === 'function') renderList();
}

function resetAuditProgress() {
  if (!confirm('Reset polygon audit progress?\n\nThis clears the reviewed flag on every venue.')) return;
  _auditCache.clear();
  _saveAudit();
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// ── Toggle + indicator ──────────────────────────────────────────────────────
function _updateAuditIndicator() {
  const ind   = document.getElementById('audit-mode-indicator');
  const count = document.getElementById('audit-indicator-count');
  if (!ind || !count) return;
  ind.style.display = auditModeActive ? '' : 'none';
  if (!auditModeActive) { count.textContent = ''; return; }
  const total = auditTotalCount();
  const done  = auditReviewedCount();
  const todo  = total - done;
  count.textContent = `${done} / ${total}`;
  for (const f of ['all', 'todo', 'done']) {
    const btn = document.getElementById(`audit-filter-${f}`);
    if (btn) btn.classList.toggle('active', auditFilter === f);
  }
  const _todoSpan = document.getElementById('audit-filter-todo-n');
  const _doneSpan = document.getElementById('audit-filter-done-n');
  if (_todoSpan) _todoSpan.textContent = todo;
  if (_doneSpan) _doneSpan.textContent = done;
}

function toggleAuditMode() {
  if (typeof authIsAdmin === 'function' && !authIsAdmin()) return;
  auditModeActive = !auditModeActive;
  if (auditModeActive) {
    // Lazy-load on first activation; persists across sessions.
    _auditCache = _loadAudit();
    auditFilter = 'all';
    // Audit dominates Review mode — drop it so two top-bar pills don't stack.
    if (typeof reviewModeActive !== 'undefined' && reviewModeActive
        && typeof toggleReviewMode === 'function') {
      toggleReviewMode();
    }
    // Surface admin-review.js's flag heuristics inline on audit cards so the
    // admin can spot likely-broken polygons without leaving audit mode.
    if (typeof refreshReviewFlags === 'function' && typeof datePicker !== 'undefined') {
      refreshReviewFlags(datePicker.value);
    }
  }
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// Lazy-init the cache on script load so isVenueAudited() works before the
// admin first toggles audit mode (the pin/list code path reads it regardless).
_auditCache = _loadAudit();
