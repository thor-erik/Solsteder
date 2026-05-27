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

let _auditStoreChannel = null;

/** True only when a signed-in editor/admin + the supabase client are present. */
function auditStoreActive() {
  return typeof _supabase !== 'undefined'
      && typeof authIsEditor === 'function' && authIsEditor()
      && typeof authCurrentUser === 'function' && !!authCurrentUser();
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
  try {
    if (fields == null) {
      const { error } = await _supabase.from('venue_audit_state').delete().eq('venue_id', vid);
      if (error) console.warn('[audit-store] state delete failed:', error.message);
      return;
    }
    const row = {
      venue_id:       vid,
      status:         fields.status,
      via:            fields.via ?? null,
      archive_reason: fields.archive_reason ?? null,
      archive_note:   fields.archive_note ?? null,
      reviewed_by:    authCurrentUser().id,
      updated_at:     new Date().toISOString(),
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
      .select('venue_id, status, via, archive_reason, archive_note, updated_at');
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
        _archiveCache.set(key, { archivedAt: r.updated_at, reason: r.archive_reason, note: r.archive_note ?? undefined });
      }
      if (typeof _auditCache !== 'undefined') _auditCache.delete(key);
      if (v) { v.auditArchived = true; v.auditArchiveReason = r.archive_reason; v.auditArchiveNote = r.archive_note ?? null; }
    } else if (r.status === 'reviewed') {
      if (typeof _auditCache !== 'undefined') _auditCache.set(key, { at: r.updated_at, via: r.via ?? 'good' });
      if (typeof _archiveCache !== 'undefined') _archiveCache.delete(key);
      if (v) v.auditArchived = false;
    }
  }
}

// ── Realtime (live collaboration) ─────────────────────────────────────────────

/** Subscribe to venue_audit_state changes so another admin's review/archive
 *  greys the card live. Idempotent. */
function auditStoreSubscribe() {
  if (!auditStoreActive() || _auditStoreChannel) return;
  try {
    _auditStoreChannel = _supabase
      .channel('venue_audit_state_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'venue_audit_state' }, _onRemoteStateChange)
      .subscribe();
  } catch (e) { console.warn('[audit-store] subscribe threw:', e.message); }
}

function auditStoreUnsubscribe() {
  if (!_auditStoreChannel) return;
  try { _supabase.removeChannel(_auditStoreChannel); } catch (_) {}
  _auditStoreChannel = null;
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
