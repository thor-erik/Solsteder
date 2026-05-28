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
let auditSubMode     = 'all';                       // 'all' (default) | 'shadows'
let _auditCache      = new Map();                   // venueId → { at, via, by? }
let _archiveCache    = new Map();                   // venueId → { archivedAt, reason, note?, by? }
let _filterPanelOpen = false;

// Archive-reason taxonomy. Each entry maps to a downstream rule for
// scripts/fetch-venues-places.mjs (and friends):
//
//   not-a-venue        → permanent skip; place isn't a hospitality venue
//   no-outdoor-seating → permanent skip; venue exists but lacks a terrace
//   closed-permanently → permanent skip + ask Places API to confirm before
//                        re-checking (covers reopens under same place_id)
//   duplicate          → soft skip; admin should merge into the canonical row
//   wrong-location     → re-run geocoding before re-fetching
//   other              → manual review; free-text note recorded alongside
//
// Exported JSON shape (from Export button):
//   { type: 'correction',
//     timestamp: ISO,
//     id, name,
//     before: { auditArchived: false },
//     after:  { auditArchived: true, reason, note? },
//     autoState: 'audit-archive' }
const AUDIT_ARCHIVE_REASONS = {
  'not-a-venue':        'Not a venue',
  'no-outdoor-seating': 'No outdoor seating',
  'closed-permanently': 'Permanently closed',
  'duplicate':          'Duplicate',
  'wrong-location':     'Wrong location',
  'other':              'Other',
};

const AUDIT_KEY         = 'solsteder_audit_v1';
const AUDIT_ARCHIVE_KEY = 'solsteder_audit_archive_v1';

// Status filter chips (multi-select OR). Default: show non-archived.
let auditFilters  = { unreviewed: true, reviewed: true, archived: false };
let auditAiFilter = 'all';   // 'all' | 'ai' (AI-proposed, not yet reviewed)
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
    const raw = JSON.parse(localStorage.getItem(AUDIT_ARCHIVE_KEY) || '{}');
    // Legacy migration: prior versions stored a bare array of ids.
    if (Array.isArray(raw)) {
      const out = new Map();
      for (const id of raw) out.set(_coerceId(id), { archivedAt: null, reason: 'other' });
      return out;
    }
    return new Map(Object.entries(raw).map(([k, v]) => [_coerceId(k), v]));
  } catch { return new Map(); }
}
function _saveArchive() {
  const obj = {};
  for (const [k, v] of _archiveCache) obj[String(k)] = v;
  try { localStorage.setItem(AUDIT_ARCHIVE_KEY, JSON.stringify(obj)); } catch {}
}
// ── Apply archive to VENUES on load ─────────────────────────────────────────
// data.js calls this after VENUES is populated. Idempotent — re-running just
// re-tags. Outside audit mode the rest of the app gates on `v.auditArchived`.
function applyAuditArchiveTags() {
  if (typeof VENUES === 'undefined' || !Array.isArray(VENUES)) return;
  for (const v of VENUES) {
    const entry = _archiveCache.get(v.id);
    v.auditArchived       = !!entry;
    v.auditArchiveReason  = entry?.reason ?? null;
    v.auditArchiveNote    = entry?.note   ?? null;
  }
}

// ── Query ────────────────────────────────────────────────────────────────────
function isVenueAudited(v)    { return v ? _auditCache.has(v.id) : false; }
function venueAuditEntry(v)   { return v ? _auditCache.get(v.id) ?? null : null; }
function venueArchiveEntry(v) { return v ? _archiveCache.get(v.id) ?? null : null; }
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

// ── AI-review status ──────────────────────────────────────────────────────
// The AI is a PROPOSAL engine — its polygons never ship to users until a human
// approves them. A venue is:
//   'manual'        a human polygon is in place (shipped + locked) — reviewed.
//   'ai-unreviewed' the AI proposed a polygon, no human override, not yet
//                   reviewed/archived → needs a human to Approve / Edit / Reject.
//   'none'          no AI polygon and no override (wall heuristic only).
// "Approve" (mark good) on an ai-unreviewed venue promotes the AI polygon into
// a shipped manual override (see markVenueAudited).
function venueAiConfidence(v) {
  return (v && typeof v.seatingPolygonAiConfidence === 'number') ? v.seatingPolygonAiConfidence : null;
}
function venueHasAiProposal(v) {
  const aiRings = (v && typeof asRings === 'function') ? asRings(v.seatingPolygonAi) : [];
  return !!(aiRings.length
    && !v.seatingNotVisible
    && (venueAiConfidence(v) ?? 0) >= 0.5);
}
function venueAiReviewStatus(v) {
  if (!v) return 'none';
  if ((typeof asRings === 'function' ? asRings(v.seatingPolygonOverride).length : 0)) return 'manual';
  if (venueHasAiProposal(v) && !_auditCache.has(v.id) && !v.auditArchived) return 'ai-unreviewed';
  return 'none';
}
function auditAiUnreviewedCount() {
  if (typeof VENUES === 'undefined') return 0;
  let n = 0;
  for (const v of VENUES) if (venueAiReviewStatus(v) === 'ai-unreviewed') n++;
  return n;
}
// Kept (no-op) so any lingering callers don't throw mid-refactor.
function _invalidateCorrCache() {}

// Multi-select filter — venue passes if ANY active status chip matches AND
// (when the AI filter is on) it's an AI-unreviewed proposal AND, when flag
// chips are active, the venue carries at least one selected flag.
function auditMatchesFilter(v) {
  // Status chips (OR among checked):
  let statusMatch = false;
  const reviewed = _auditCache.has(v.id);
  const archived = !!v.auditArchived;
  if (auditFilters.archived   && archived) statusMatch = true;
  if (auditFilters.reviewed   && reviewed && !archived) statusMatch = true;
  if (auditFilters.unreviewed && !reviewed && !archived) statusMatch = true;
  if (!statusMatch) return false;
  // AI filter (single-select): only AI-proposed, not-yet-reviewed venues.
  if (auditAiFilter === 'ai' && venueAiReviewStatus(v) !== 'ai-unreviewed') return false;
  // Flag chips (OR among checked). Empty = no restriction.
  if (auditFlagFilters.size === 0) return true;
  if (typeof venueReviewFlags !== 'function') return true;
  const flags = venueReviewFlags(v) || [];
  for (const f of flags) if (auditFlagFilters.has(f)) return true;
  return false;
}

// ── Mutations ────────────────────────────────────────────────────────────────
function markVenueAudited(venueId, via = 'good') {
  // Approve = lock the SHOWN polygon. When the admin marks a venue "good" with no
  // human override yet, bake whatever polygon the editor is currently showing —
  // the reliable wall-derived default, OR an AI proposal the admin adopted via
  // "Vis AI-forslag" — into a shipped override (training positive, locked from
  // re-detection). It NEVER auto-substitutes the raw AI proposal, so a wrong AI
  // shape can't be baked by a plain approve. Edits bake their own override via
  // exitEditMode. (In practice this fires for street venues, where the default is
  // wall-derived; courtyard/detached already hold their own polygon if any.)
  if (via === 'good' && typeof VENUES !== 'undefined' && typeof getActivePolygons === 'function') {
    const _v = VENUES.find(x => x.id === venueId);
    const hasOverride = !!(_v && typeof asRings === 'function' &&
      (asRings(_v.seatingPolygonOverride).length || asRings(_v.courtyardPolygon).length || asRings(_v.detachedPolygon).length));
    if (_v && !hasOverride) {
      const shown = getActivePolygons(_v).rings;
      if (shown.length && typeof setActivePolygons === 'function') {
        setActivePolygons(_v, shown);   // writes the type's polygon field + test points
        if (typeof saveFacingCache === 'function') {
          saveFacingCache(_v.id, _v.facing, _v.facingSource, _v.terraceWallIndices ?? [], _v.terraceDepth,
            null, _v.terraceType, _v.terraceDetachedLocation, _v.terraceWallTrimStart, _v.terraceWallTrimEnd, _v.seatingPolygonOverride);
        }
        if (typeof saveCorrection === 'function') {
          saveCorrection('correction', {
            id: venueId, name: _v.name, category: _v.category,
            before: { seatingPolygonOverride: null },
            after:  { seatingPolygonOverride: _v.seatingPolygonOverride },
            origin: 'approved', autoState: 'approved',
            buildingNodeCount: _v.buildingGeometry?.length ?? null,
          });
        }
        if (typeof sunWindowCache !== 'undefined' && sunWindowCache.clear) sunWindowCache.clear();
        if (typeof dispatchToWorker === 'function' && typeof datePicker !== 'undefined') dispatchToWorker(datePicker.value);
        // Baked a polygon → it's now a human edit, not a bare "looks good";
        // reclassify so the 'confirmed' branch below doesn't double-save.
        via = 'edited';
      }
    }
  }
  _auditCache.set(venueId, { at: new Date().toISOString(), via });
  _saveAudit();
  if (typeof auditStoreSetState === 'function') auditStoreSetState(venueId, { status: 'reviewed', via });
  // "Looks good" is a positive training signal — the admin is confirming
  // that the venue's current geometry (AI-detected polygon, terrace walls,
  // facing, etc.) is correct. Record a saveCorrection of type 'confirmed'
  // so seating-detection training sees positive examples, not only edits
  // and archives. The 'edited' path already saves its own correction via
  // exitEditMode(), so skip when called from there to avoid duplicates.
  if (via === 'good' && typeof saveCorrection === 'function'
      && typeof VENUES !== 'undefined') {
    const v = VENUES.find(x => x.id === venueId);
    if (v) {
      const snapshot = (typeof _venueEditSnapshot === 'function')
        ? _venueEditSnapshot(v)
        : { terraceType: v.terraceType ?? null, facing: v.facing ?? null };
      saveCorrection('confirmed', {
        id: venueId, name: v.name, category: v.category,
        state: snapshot,
        buildingNodeCount: v.buildingGeometry?.length ?? null,
        autoState: 'audit-confirmed',
      });
    }
  }
  _invalidateCorrCache();
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (auditModeActive && typeof renderList === 'function') renderList();
}
function unmarkVenueAudited(venueId) {
  _auditCache.delete(venueId);
  _saveAudit();
  if (typeof auditStoreSetState === 'function') auditStoreSetState(venueId, null);
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (auditModeActive && typeof renderList === 'function') renderList();
}
// Open an inline reason chooser in the venue's audit-actions row. Each
// preset maps to a downstream rule for the discovery scripts (see
// AUDIT_ARCHIVE_REASONS above).
function beginArchiveVenue(venueId) {
  if (typeof document === 'undefined') return;
  const idArg = typeof venueId === 'number' ? venueId : `'${venueId}'`;
  // Match by attribute selector — works for numeric and string ids.
  const card = document.querySelector(`.venue-card[data-vid="${venueId}"]`);
  const row  = card?.querySelector('.audit-actions');
  if (!row) return;
  const chips = Object.entries(AUDIT_ARCHIVE_REASONS).map(([k, label]) =>
    `<button class="audit-chip" onclick="archiveVenue(${idArg},'${k}')">${label}</button>`
  ).join('');
  row.classList.add('is-choosing-reason');
  row.innerHTML = `
    <span class="audit-state-badge">Why archive?</span>
    ${chips}
    <button class="audit-action-btn audit-undo" onclick="renderList()">Cancel</button>`;
}

function archiveVenue(venueId, reason = 'other', note = null) {
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  if (!v) return;
  if (!(reason in AUDIT_ARCHIVE_REASONS)) reason = 'other';
  if (reason === 'other' && !note) {
    note = prompt(`Archive "${v.name}" — why?`, '');
    if (note == null) { if (typeof renderList === 'function') renderList(); return; }
  }
  const entry = { archivedAt: new Date().toISOString(), reason };
  if (note) entry.note = note.trim();
  _archiveCache.set(venueId, entry);
  _saveArchive();
  if (typeof auditStoreSetState === 'function') auditStoreSetState(venueId, { status: 'archived', archive_reason: reason, archive_note: entry.note ?? null });
  v.auditArchived      = true;
  v.auditArchiveReason = reason;
  v.auditArchiveNote   = entry.note ?? null;
  if (typeof saveCorrection === 'function') {
    saveCorrection('correction', {
      id: venueId, name: v.name,
      before: { auditArchived: false },
      after:  { auditArchived: true, reason, note: entry.note ?? null },
      autoState: 'audit-archive',
    });
  }
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}
function unarchiveVenue(venueId) {
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  const prev = _archiveCache.get(venueId) ?? null;
  _archiveCache.delete(venueId);
  _saveArchive();
  if (typeof auditStoreSetState === 'function') auditStoreSetState(venueId, null);
  if (v) {
    v.auditArchived      = false;
    v.auditArchiveReason = null;
    v.auditArchiveNote   = null;
  }
  if (typeof saveCorrection === 'function' && v) {
    saveCorrection('correction', {
      id: venueId, name: v.name,
      before: { auditArchived: true, reason: prev?.reason ?? null, note: prev?.note ?? null },
      after:  { auditArchived: false },
      autoState: 'audit-unarchive',
    });
  }
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

// (Manual Export + training-stamp tracking retired — corrections now sync to
//  Supabase automatically and the seating-sync Action regenerates the training
//  file. See scripts/sync-seating-from-supabase.mjs.)

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
function setAuditAiFilter(mode) {
  if (!['all', 'ai'].includes(mode)) return;
  auditAiFilter = mode;
  _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}
function setAuditSubMode(mode) {
  if (mode !== 'shadows' && mode !== 'all') return;
  if (auditSubMode === mode) return;
  auditSubMode = mode;
  // Shadows mode = time-based sun simulation → show the FTS scrubber + filter
  // the list to sunny venues. Alle = ignore sun → hide the FTS + show all.
  document.body.classList.toggle('audit-shadows', auditSubMode === 'shadows');
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
  const denom = Math.max(1, total - auditArchivedCount());
  count.textContent = `${done} / ${denom}`;
  const fill = document.getElementById('audit-progress-fill');
  if (fill) fill.style.width = Math.min(100, Math.round((done / denom) * 100)) + '%';

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
    const flagN   = auditFlagFilters.size;
    const aiRes   = auditAiFilter !== 'all' ? 1 : 0;
    const restricted = activeStatuses < 3 || flagN > 0 || aiRes > 0;
    filterBtn.classList.toggle('has-active', restricted);
    const badge = document.getElementById('audit-filter-toggle-badge');
    if (badge) {
      const n = (3 - activeStatuses) + flagN + aiRes;
      badge.textContent = restricted ? n : '';
      badge.style.display = restricted ? '' : 'none';
    }
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
  // AI-review filter chips
  for (const m of ['all', 'ai']) {
    const c = document.getElementById(`audit-ai-chip-${m}`);
    if (c) c.classList.toggle('active', auditAiFilter === m);
  }
  const _aiN = document.getElementById('audit-ai-count');
  if (_aiN) _aiN.textContent = auditAiUnreviewedCount();

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
      <div class="audit-filter-label">AI proposals</div>
      <div class="audit-chip-row">
        <button class="audit-chip" id="audit-ai-chip-all" onclick="setAuditAiFilter('all')">All</button>
        <button class="audit-chip" id="audit-ai-chip-ai"  onclick="setAuditAiFilter('ai')">Needs review<span class="audit-chip-count" id="audit-ai-count">0</span></button>
      </div>
    </div>
    <div class="audit-filter-group">
      <div class="audit-filter-label">Flags (any matching)</div>
      <div class="audit-chip-row">${flagChips}</div>
    </div>
    <div class="audit-filter-group">
      <div class="audit-filter-label">Reset</div>
      <div class="audit-chip-row">
        <button class="audit-chip" onclick="clearAuditFilters()" title="Restore all filters to default">Reset filters</button>
        <button class="audit-chip" onclick="resetAuditProgress()" title="Mark every venue as not-yet-reviewed">Reset review progress</button>
      </div>
    </div>`;
}

// ── Toggle ───────────────────────────────────────────────────────────────────
function toggleAuditMode() {
  if (typeof authIsAdmin === 'function' && !authIsAdmin()) return;
  auditModeActive = !auditModeActive;
  // Body hook so CSS can apply the denser audit-tool styling (compact cards,
  // icon action row) without affecting the consumer venue list.
  document.body.classList.toggle('audit-mode', auditModeActive);
  if (auditModeActive) {
    // Default to Alle (ignore sun) — FTS hidden, full catalog shown.
    auditSubMode = 'all';
    document.body.classList.remove('audit-shadows');
    _auditCache   = _loadAudit();
    _archiveCache = _loadArchive();
    applyAuditArchiveTags();
    auditFilters    = { unreviewed: true, reviewed: true, archived: false };
    auditAiFilter   = 'all';
    auditFlagFilters.clear();
    _filterPanelOpen = false;
    if (typeof refreshReviewFlags === 'function' && typeof datePicker !== 'undefined') {
      refreshReviewFlags(datePicker.value);
    }
    _renderAuditFilterPanel();
    // Pull shared audit state + latest polygons from Supabase (multi-admin
    // continuity) and subscribe to live changes. Hydrate re-renders when done.
    if (typeof auditStoreHydrate === 'function') auditStoreHydrate();
    if (typeof auditStoreSubscribe === 'function') auditStoreSubscribe();
  } else {
    // Leaving audit — restore the styled map if a card-focus had switched it
    // to satellite, and clear the focus highlight.
    document.body.classList.remove('audit-shadows');
    if (typeof _resetAuditSatellite === 'function') _resetAuditSatellite();
    if (typeof auditStoreUnsubscribe === 'function') auditStoreUnsubscribe();
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
