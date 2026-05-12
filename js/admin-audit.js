/**
 * admin-audit.js — Admin "Polygon audit" mode.
 *
 * Sibling to admin-review.js. Where Review mode shows only *problem* venues,
 * Audit mode shows *every* venue so an admin can walk the catalog and tick
 * off each outdoor-seating polygon.
 *
 * Three persisted localStorage keys:
 *   - solsteder_audit_v1         → reviewed venues  { [id]: { at, via } }
 *   - solsteder_audit_archive_v1 → archived venues  [id, id, ...] (Set)
 *
 * Two in-session state knobs:
 *   - auditSubMode: 'shadows' (default) — current-sun simulation + shadow overlay
 *                   'all'               — flat dots, neutral polygons, no time
 *   - auditFilters: multi-select status/flag chips
 *
 * Pin overrides:
 *   - reviewed venues → green dot (skip pill pipeline)
 *   - archived venues → red dot   (hidden outside audit)
 */

let auditModeActive  = false;
let auditSubMode     = 'shadows';                   // 'shadows' | 'all'
let _auditCache      = new Map();                   // venueId → { at, via }
let _archiveCache    = new Set();                   // archived venueIds
let _filterPanelOpen = false;

const AUDIT_KEY        = 'solsteder_audit_v1';
const AUDIT_ARCHIVE_KEY = 'solsteder_audit_archive_v1';

// Status filter chips (multi-select OR). Default: show non-archived.
let auditFilters = { unreviewed: true, reviewed: true, archived: false };
// Per-flag filter chips (OR within flag set). Empty = no flag restriction.
let auditFlagFilters = new Set();   // any of admin-review.js REVIEW_FLAG_LABELS keys

// ── Persistence ──────────────────────────────────────────────────────────────
function _coerceId(k) {
  const n = Number(k);
  return Number.isFinite(n) && String(n) === k ? n : k;
}
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
function _loadArchive() {
  try {
    const raw = JSON.parse(localStorage.getItem(AUDIT_ARCHIVE_KEY) || '[]');
    return new Set(raw.map(_coerceId));
  } catch { return new Set(); }
}
function _saveArchive() {
  try {
    localStorage.setItem(AUDIT_ARCHIVE_KEY, JSON.stringify([..._archiveCache]));
  } catch {}
}

// ── Apply archive to VENUES on load ─────────────────────────────────────────
// data.js calls this after VENUES is populated. Idempotent — re-running just
// re-tags. Outside audit mode the rest of the app gates on `v.auditArchived`.
function applyAuditArchiveTags() {
  if (typeof VENUES === 'undefined' || !Array.isArray(VENUES)) return;
  for (const v of VENUES) {
    v.auditArchived = _archiveCache.has(v.id);
  }
}

// ── Query ────────────────────────────────────────────────────────────────────
function isVenueAudited(v)    { return v ? _auditCache.has(v.id) : false; }
function venueAuditEntry(v)   { return v ? _auditCache.get(v.id) ?? null : null; }
function isVenueArchived(v)   { return !!(v && v.auditArchived); }
function auditTotalCount()    { return (typeof VENUES === 'undefined') ? 0 : VENUES.length; }
function auditReviewedCount() {
  if (typeof VENUES === 'undefined') return 0;
  let n = 0;
  for (const v of VENUES) if (_auditCache.has(v.id) && !v.auditArchived) n++;
  return n;
}
function auditUnreviewedCount() {
  if (typeof VENUES === 'undefined') return 0;
  let n = 0;
  for (const v of VENUES) if (!_auditCache.has(v.id) && !v.auditArchived) n++;
  return n;
}
function auditArchivedCount() { return _archiveCache.size; }
function auditFlaggedCount() {
  if (typeof VENUES === 'undefined' || typeof venueReviewFlags !== 'function') return 0;
  let n = 0;
  for (const v of VENUES) if (!v.auditArchived && venueReviewFlags(v)) n++;
  return n;
}

// Multi-select filter — venue passes if ANY active status chip matches AND,
// when flag chips are active, it carries at least one selected flag.
function auditMatchesFilter(v) {
  // Status chips (OR among checked):
  let statusMatch = false;
  const reviewed = _auditCache.has(v.id);
  const archived = !!v.auditArchived;
  if (auditFilters.archived   && archived) statusMatch = true;
  if (auditFilters.reviewed   && reviewed && !archived) statusMatch = true;
  if (auditFilters.unreviewed && !reviewed && !archived) statusMatch = true;
  if (!statusMatch) return false;
  // Flag chips (OR among checked). Empty = no restriction.
  if (auditFlagFilters.size === 0) return true;
  if (typeof venueReviewFlags !== 'function') return true;
  const flags = venueReviewFlags(v) || [];
  for (const f of flags) if (auditFlagFilters.has(f)) return true;
  return false;
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
function archiveVenue(venueId) {
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  if (!v) return;
  if (!confirm(`Archive "${v.name}"?\n\nIt will be hidden from users until you un-archive. The change is local to this device until you commit data/venues.json.`)) return;
  _archiveCache.add(venueId);
  _saveArchive();
  v.auditArchived = true;
  if (typeof saveCorrection === 'function') {
    saveCorrection('correction', {
      id: venueId, name: v.name,
      before: { auditArchived: false },
      after:  { auditArchived: true },
      autoState: 'audit-archive',
    });
  }
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}
function unarchiveVenue(venueId) {
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  _archiveCache.delete(venueId);
  _saveArchive();
  if (v) v.auditArchived = false;
  if (typeof saveCorrection === 'function' && v) {
    saveCorrection('correction', {
      id: venueId, name: v.name,
      before: { auditArchived: true },
      after:  { auditArchived: false },
      autoState: 'audit-unarchive',
    });
  }
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

function resetAuditProgress() {
  if (!confirm('Reset polygon audit progress?\n\nThis clears the reviewed flag on every venue. Archive list is preserved.')) return;
  _auditCache.clear();
  _saveAudit();
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// ── Filter + sub-mode controls ───────────────────────────────────────────────
function toggleAuditStatusFilter(key) {
  if (!(key in auditFilters)) return;
  auditFilters[key] = !auditFilters[key];
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}
function toggleAuditFlagFilter(flag) {
  if (auditFlagFilters.has(flag)) auditFlagFilters.delete(flag);
  else auditFlagFilters.add(flag);
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}
function clearAuditFilters() {
  auditFilters = { unreviewed: true, reviewed: true, archived: false };
  auditFlagFilters.clear();
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}
function toggleAuditFilterPanel() {
  _filterPanelOpen = !_filterPanelOpen;
  _updateAuditIndicator();
}
function setAuditSubMode(mode) {
  if (mode !== 'shadows' && mode !== 'all') return;
  if (auditSubMode === mode) return;
  auditSubMode = mode;
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// ── Indicator ────────────────────────────────────────────────────────────────
function _updateAuditIndicator() {
  const ind   = document.getElementById('audit-mode-indicator');
  const count = document.getElementById('audit-indicator-count');
  if (!ind || !count) return;
  ind.style.display = auditModeActive ? '' : 'none';
  if (!auditModeActive) { count.textContent = ''; return; }
  const total = auditTotalCount();
  const done  = auditReviewedCount();
  count.textContent = `${done} / ${total - auditArchivedCount()}`;

  // Sub-mode segmented control
  const segShadows = document.getElementById('audit-mode-shadows');
  const segAll     = document.getElementById('audit-mode-all');
  if (segShadows) segShadows.classList.toggle('active', auditSubMode === 'shadows');
  if (segAll)     segAll.classList.toggle('active',     auditSubMode === 'all');

  // Filter panel
  const panel = document.getElementById('audit-filter-panel');
  if (panel) panel.style.display = _filterPanelOpen ? '' : 'none';

  // Active chip count on the filter button
  const activeStatuses = Object.values(auditFilters).filter(Boolean).length;
  const filterBtn = document.getElementById('audit-filter-toggle');
  if (filterBtn) {
    const flagN = auditFlagFilters.size;
    const restricted = activeStatuses < 3 || flagN > 0;
    filterBtn.classList.toggle('has-active', restricted);
    const badge = document.getElementById('audit-filter-toggle-badge');
    if (badge) {
      const n = (3 - activeStatuses) + flagN; // "how many away from default"
      badge.textContent = restricted ? n : '';
      badge.style.display = restricted ? '' : 'none';
    }
  }

  // Export-button badge — count of pending corrections that can be exported.
  const exportBtn   = document.getElementById('audit-export-btn');
  const exportCount = document.getElementById('audit-export-count');
  if (exportBtn && exportCount) {
    const n = (typeof loadCorrections === 'function') ? loadCorrections().length : 0;
    exportCount.textContent = n;
    exportBtn.classList.toggle('has-active', n > 0);
  }

  // Status chip counts + active state
  const statusCounts = {
    unreviewed: auditUnreviewedCount(),
    reviewed:   auditReviewedCount(),
    archived:   auditArchivedCount(),
  };
  for (const key of Object.keys(auditFilters)) {
    const chip = document.getElementById(`audit-chip-${key}`);
    if (!chip) continue;
    chip.classList.toggle('active', !!auditFilters[key]);
    const n = chip.querySelector('.audit-chip-count');
    if (n) n.textContent = statusCounts[key];
  }
  // Flag chips
  if (typeof REVIEW_FLAG_LABELS !== 'undefined') {
    const flagCounts = _flagCounts();
    document.querySelectorAll('[data-audit-flag-chip]').forEach(chip => {
      const flag = chip.dataset.auditFlagChip;
      chip.classList.toggle('active', auditFlagFilters.has(flag));
      const n = chip.querySelector('.audit-chip-count');
      if (n) n.textContent = flagCounts[flag] ?? 0;
    });
  }
}

function _flagCounts() {
  const out = {};
  if (typeof VENUES === 'undefined' || typeof venueReviewFlags !== 'function') return out;
  for (const v of VENUES) {
    if (v.auditArchived) continue;
    const flags = venueReviewFlags(v);
    if (!flags) continue;
    for (const f of flags) out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

// ── Build filter panel HTML (called once when indicator mounts) ─────────────
function _renderAuditFilterPanel() {
  const panel = document.getElementById('audit-filter-panel');
  if (!panel) return;
  if (panel.dataset.built === '1') return;
  panel.dataset.built = '1';
  const flagLabels = (typeof REVIEW_FLAG_LABELS !== 'undefined') ? REVIEW_FLAG_LABELS : {};
  const flagChips = Object.keys(flagLabels).map(k =>
    `<button class="audit-chip" data-audit-flag-chip="${k}" onclick="toggleAuditFlagFilter('${k}')">
      ${flagLabels[k]}<span class="audit-chip-count">0</span>
    </button>`).join('');
  panel.innerHTML = `
    <div class="audit-filter-group">
      <div class="audit-filter-label">Status</div>
      <div class="audit-chip-row">
        <button class="audit-chip" id="audit-chip-unreviewed" onclick="toggleAuditStatusFilter('unreviewed')">Not reviewed<span class="audit-chip-count">0</span></button>
        <button class="audit-chip" id="audit-chip-reviewed"   onclick="toggleAuditStatusFilter('reviewed')">Reviewed<span class="audit-chip-count">0</span></button>
        <button class="audit-chip" id="audit-chip-archived"   onclick="toggleAuditStatusFilter('archived')">Archived<span class="audit-chip-count">0</span></button>
      </div>
    </div>
    <div class="audit-filter-group">
      <div class="audit-filter-label">Flags (any matching)</div>
      <div class="audit-chip-row">${flagChips}</div>
    </div>
    <div class="audit-filter-footer">
      <button class="audit-chip" onclick="clearAuditFilters()">Reset filters</button>
    </div>`;
}

// ── Toggle ───────────────────────────────────────────────────────────────────
function toggleAuditMode() {
  if (typeof authIsAdmin === 'function' && !authIsAdmin()) return;
  auditModeActive = !auditModeActive;
  if (auditModeActive) {
    _auditCache   = _loadAudit();
    _archiveCache = _loadArchive();
    applyAuditArchiveTags();
    auditFilters = { unreviewed: true, reviewed: true, archived: false };
    auditFlagFilters.clear();
    _filterPanelOpen = false;
    if (typeof refreshReviewFlags === 'function' && typeof datePicker !== 'undefined') {
      refreshReviewFlags(datePicker.value);
    }
    _renderAuditFilterPanel();
  }
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// ── Boot: load + apply archive immediately (audit-archived venues need their
//     tag set on every page load so the rest of the app filters them out
//     whether or not the admin opens audit mode this session). ───────────────
_auditCache   = _loadAudit();
_archiveCache = _loadArchive();
