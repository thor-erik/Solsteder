/**
 * audit-store.js — Supabase-backed audit state + corrections (editor/admin only).
 *
 * The shared source of truth for the multi-admin polygon-audit workflow. The
 * existing localStorage keys (solsteder_audit_*, solsteder_corrections_v1,
 * solsteder_facings_v4 overrides) stay as an OFFLINE MIRROR — every existing
 * write still happens; these functions add a Supabase write/read alongside.
 *
 * Two tables (sql/044):
 *   - venue_audit_state    one upserted row per venue (reviewed / archived).
 *                          Drives live collaboration via realtime.
 *   - seating_corrections  append-only log (training corpus + audit trail);
 *                          the latest non-null polygon per venue is the override.
 *
 * Inert for non-admins, when signed out, or when supabase-js isn't present.
 * Couples (deliberately, same feature) to admin-audit.js globals _auditCache /
 * _archiveCache and the render/indicator functions — all share global scope.
 */

let _auditStoreChannel    = null;   // realtime: venue_audit_state changes
let _auditStorePresence   = null;   // realtime presence: who's editing what
const _editingByVenue     = new Map(); // venue_id(str) → editor name (excludes self)

/** True only when a signed-in editor/admin + the supabase client are present. */
function auditStoreActive() {
  return typeof _supabase !== 'undefined'
      && typeof authIsEditor === 'function' && authIsEditor()
      && typeof authCurrentUser === 'function' && !!authCurrentUser();
}

/** Display name for the current admin (for attribution + presence). */
function _auditStoreUserName() {
  const u = (typeof authCurrentUser === 'function') ? authCurrentUser() : null;
  if (!u) return 'admin';
  return (u.user_metadata && u.user_metadata.name)
      || (u.email ? u.email.split('@')[0] : null)
      || 'admin';
}

/** Name of the OTHER admin currently editing this venue, or null. */
function auditEditingBy(venueId) {
  return _editingByVenue.get(String(venueId)) ?? null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Append one correction to the shared log. Fire-and-forget; mirrors whatever
 *  saveCorrection() just wrote to localStorage. */
async function auditStorePushCorrection(rec) {
  if (!auditStoreActive() || !rec) return;
  const uid = authCurrentUser().id;
  const after = rec.after || null;
  const polygon = (after && Array.isArray(after.seatingPolygonOverride))
    ? after.seatingPolygonOverride
    : (rec.polygon ?? null);
  const row = {
    venue_id:   String(rec.id ?? rec.venue_id),
    type:       rec.type || 'correction',
    polygon,
    before:     rec.before ?? rec.state ?? null,
    after,
    origin:     rec.origin ?? rec.autoState ?? null,
    created_by: uid,
  };
  try {
    const { error } = await _supabase.from('seating_corrections').insert(row);
    if (error) console.warn('[audit-store] correction insert failed:', error.message);
  } catch (e) { console.warn('[audit-store] correction insert threw:', e.message); }
}

/** Upsert (fields) or clear (null) the shared review state for a venue. */
async function auditStoreSetState(venueId, fields) {
  if (!auditStoreActive()) return;
  const vid = String(venueId);
  const name = _auditStoreUserName();
  // Patch the local cache's `by` synchronously so the card shows "Sist: <me>"
  // on the immediate re-render (before the async upsert resolves).
  if (fields && typeof _auditCache !== 'undefined') {
    const e = (fields.status === 'reviewed') ? _auditCache.get(venueId) : _archiveCache?.get(venueId);
    if (e) e.by = name;
  }
  try {
    if (fields == null) {
      const { error } = await _supabase.from('venue_audit_state').delete().eq('venue_id', vid);
      if (error) console.warn('[audit-store] state delete failed:', error.message);
      return;
    }
    const row = {
      venue_id:        vid,
      status:          fields.status,
      via:             fields.via ?? null,
      archive_reason:  fields.archive_reason ?? null,
      archive_note:    fields.archive_note ?? null,
      reviewed_by:     authCurrentUser().id,
      reviewed_by_name: name,
      updated_at:      new Date().toISOString(),
    };
    const { error } = await _supabase.from('venue_audit_state').upsert(row, { onConflict: 'venue_id' });
    if (error) console.warn('[audit-store] state upsert failed:', error.message);
  } catch (e) { console.warn('[audit-store] state write threw:', e.message); }
}

// ── Hydrate (audit-mode enter) ────────────────────────────────────────────────

/** Pull shared state + latest polygons from Supabase into the local caches +
 *  venue objects, then re-render. Called on audit-mode enter. */
async function auditStoreHydrate() {
  if (!auditStoreActive()) return;
  try {
    const { data: states, error: e1 } = await _supabase
      .from('venue_audit_state')
      .select('venue_id, status, via, archive_reason, archive_note, reviewed_by_name, updated_at');
    if (e1) console.warn('[audit-store] state load failed:', e1.message);
    else if (Array.isArray(states)) _auditApplyRemoteStates(states);

    // Latest non-null polygon per venue → v.seatingPolygonOverride.
    const { data: corrs, error: e2 } = await _supabase
      .from('seating_corrections')
      .select('venue_id, polygon, created_at')
      .order('created_at', { ascending: false });
    if (e2) console.warn('[audit-store] corrections load failed:', e2.message);
    else if (Array.isArray(corrs) && typeof VENUES !== 'undefined') {
      const seen = new Set();
      for (const c of corrs) {
        if (seen.has(c.venue_id)) continue;
        seen.add(c.venue_id);
        if (!Array.isArray(c.polygon) || c.polygon.length < 3) continue;
        const v = VENUES.find(x => String(x.id) === c.venue_id);
        if (!v) continue;
        v.seatingPolygonOverride = c.polygon;
        if (typeof seatingPolygonTestPoints === 'function') {
          const pts = seatingPolygonTestPoints(c.polygon);
          if (pts.length) v.terraceTestPoints = pts;
        }
      }
    }
  } catch (e) { console.warn('[audit-store] hydrate threw:', e.message); }

  if (typeof sunWindowCache !== 'undefined' && sunWindowCache.clear) sunWindowCache.clear();
  if (typeof _updateAuditIndicator === 'function') _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof renderList === 'function') renderList();
}

/** Merge venue_audit_state rows into the in-memory caches + venue flags so the
 *  existing audit UI reflects the shared state. */
function _auditApplyRemoteStates(rows) {
  if (typeof VENUES === 'undefined') return;
  for (const r of rows) {
    const v = VENUES.find(x => String(x.id) === r.venue_id);
    const key = v ? v.id : r.venue_id;
    if (r.status === 'archived') {
      if (typeof _archiveCache !== 'undefined') {
        _archiveCache.set(key, { archivedAt: r.updated_at, reason: r.archive_reason, note: r.archive_note ?? undefined, by: r.reviewed_by_name ?? undefined });
      }
      if (typeof _auditCache !== 'undefined') _auditCache.delete(key);
      if (v) { v.auditArchived = true; v.auditArchiveReason = r.archive_reason; v.auditArchiveNote = r.archive_note ?? null; }
    } else if (r.status === 'reviewed') {
      if (typeof _auditCache !== 'undefined') _auditCache.set(key, { at: r.updated_at, via: r.via ?? 'good', by: r.reviewed_by_name ?? undefined });
      if (typeof _archiveCache !== 'undefined') _archiveCache.delete(key);
      if (v) v.auditArchived = false;
    }
  }
}

// ── Realtime (live collaboration) ─────────────────────────────────────────────

/** Subscribe to venue_audit_state changes so another admin's review/archive
 *  greys the card live. Idempotent. */
function auditStoreSubscribe() {
  if (!auditStoreActive()) return;
  if (!_auditStoreChannel) {
    try {
      _auditStoreChannel = _supabase
        .channel('venue_audit_state_live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'venue_audit_state' }, _onRemoteStateChange)
        .subscribe();
    } catch (e) { console.warn('[audit-store] subscribe threw:', e.message); }
  }
  // Presence channel: broadcast which venue I'm editing; track everyone else's.
  if (!_auditStorePresence) {
    try {
      const uid = authCurrentUser().id;
      _auditStorePresence = _supabase.channel('audit_presence', { config: { presence: { key: uid } } });
      _auditStorePresence
        .on('presence', { event: 'sync' }, _onPresenceSync)
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try { await _auditStorePresence.track({ venue_id: null, name: _auditStoreUserName() }); } catch (_) {}
          }
        });
    } catch (e) { console.warn('[audit-store] presence subscribe threw:', e.message); }
  }
}

function auditStoreUnsubscribe() {
  if (_auditStoreChannel) {
    try { _supabase.removeChannel(_auditStoreChannel); } catch (_) {}
    _auditStoreChannel = null;
  }
  if (_auditStorePresence) {
    try { _supabase.removeChannel(_auditStorePresence); } catch (_) {}
    _auditStorePresence = null;
  }
  _editingByVenue.clear();
}

/** Tell other admins which venue I'm now editing (call on edit enter/advance). */
function auditStorePresenceTrack(venueId) {
  if (!_auditStorePresence) return;
  try { _auditStorePresence.track({ venue_id: String(venueId), name: _auditStoreUserName() }); } catch (_) {}
}
/** I've stopped editing — clear my venue (call on edit exit). */
function auditStorePresenceClear() {
  if (!_auditStorePresence) return;
  try { _auditStorePresence.track({ venue_id: null, name: _auditStoreUserName() }); } catch (_) {}
}

/** Rebuild _editingByVenue from presence state (excluding myself) + re-render. */
function _onPresenceSync() {
  if (!_auditStorePresence) return;
  const selfId = (typeof authCurrentUser === 'function' && authCurrentUser()) ? authCurrentUser().id : null;
  _editingByVenue.clear();
  let state = {};
  try { state = _auditStorePresence.presenceState() || {}; } catch (_) { state = {}; }
  for (const [key, metas] of Object.entries(state)) {
    if (key === selfId) continue;
    for (const m of (metas || [])) {
      if (m && m.venue_id != null) _editingByVenue.set(String(m.venue_id), m.name || 'En admin');
    }
  }
  if (typeof auditModeActive !== 'undefined' && auditModeActive && typeof renderList === 'function') renderList();
}

function _onRemoteStateChange(payload) {
  const row = payload.new ?? payload.old;
  if (!row || !row.venue_id) return;
  const vid = row.venue_id;
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => String(x.id) === vid) : null;
  const key = v ? v.id : vid;
  if (payload.eventType === 'DELETE') {
    if (typeof _auditCache   !== 'undefined') _auditCache.delete(key);
    if (typeof _archiveCache !== 'undefined') _archiveCache.delete(key);
    if (v) { v.auditArchived = false; v.auditArchiveReason = null; v.auditArchiveNote = null; }
  } else if (payload.new) {
    _auditApplyRemoteStates([payload.new]);
  }
  if (typeof _updateAuditIndicator === 'function') _updateAuditIndicator();
  if (typeof draw === 'function') draw();
  if (typeof auditModeActive !== 'undefined' && auditModeActive && typeof renderList === 'function') renderList();
}

// ── One-time backfill ─────────────────────────────────────────────────────────

/** Push this browser's local corrections + audit/archive state up to Supabase
 *  once, so pre-existing work isn't lost in localStorage. Console-callable by
 *  an admin: `await auditStoreImportLocal()`. Guarded by a localStorage flag so
 *  it can't double-insert if re-run. */
const _AUDIT_IMPORT_FLAG = 'solsteder_audit_imported_v1';
async function auditStoreImportLocal() {
  if (!auditStoreActive()) { console.warn('[audit-store] import: need a signed-in editor/admin.'); return; }
  if (localStorage.getItem(_AUDIT_IMPORT_FLAG)) { console.warn('[audit-store] import already ran in this browser.'); return; }

  let corr = 0, state = 0;
  // 1. Corrections log → seating_corrections (chronological).
  if (typeof loadCorrections === 'function') {
    for (const c of loadCorrections()) { await auditStorePushCorrection(c); corr++; }
  }
  // 2. Reviewed/archived caches → venue_audit_state.
  if (typeof _archiveCache !== 'undefined') {
    for (const [vid, e] of _archiveCache) {
      await auditStoreSetState(vid, { status: 'archived', archive_reason: e?.reason ?? 'other', archive_note: e?.note ?? null });
      state++;
    }
  }
  if (typeof _auditCache !== 'undefined') {
    for (const [vid, e] of _auditCache) {
      if (typeof _archiveCache !== 'undefined' && _archiveCache.has(vid)) continue; // archived wins
      await auditStoreSetState(vid, { status: 'reviewed', via: e?.via ?? 'good' });
      state++;
    }
  }
  localStorage.setItem(_AUDIT_IMPORT_FLAG, new Date().toISOString());
  console.log(`[audit-store] imported ${corr} correction(s) + ${state} state row(s) to Supabase.`);
}
if (typeof window !== 'undefined') window.auditStoreImportLocal = auditStoreImportLocal;
