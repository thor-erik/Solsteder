/**
 * render-editor.js — Building editor canvas overlay.
 *
 * The editor is polygon-first: every editable terrace (street / courtyard /
 * detached / AI seating override) is represented as a single closed polygon
 * with two handle types:
 *   • corner handles  → free drag, can change joining angles
 *   • edge-midpoint   → constrained perpendicular drag, moves the whole edge
 *                       (so width and depth share one handle per edge)
 *
 * Street terraces start as "wall + depth" — selecting a wall and adjusting
 * depth synthesises a polygon on the fly via terracePolygons(). The first
 * time the user grabs any polygon handle, the synthesised polygon is "baked"
 * into v.seatingPolygonOverride so subsequent edits are persisted.
 *
 * Depends on: map, canvas, ctx, VENUES, editingVenueId, editHoveredWallIdx (app.js)
 *             getTerraceWalls, wallOutwardNormal, getEffectiveDepth, pxPerMetre,
 *             terracePolygons, fillRoundRect, bearingToCardinal,
 *             convexHull, seatingPolygonTestPoints (render-helpers.js)
 *             getSeatingPolygon (data.js)
 *             computeCentroid (osm.js)
 */

// ── Drag state ────────────────────────────────────────────────────────────────
let editDraggingDepth      = false;     // legacy: wall depth handle (pre-bake)
let editDragWallObj        = null;
let _detachedDragging      = false;     // legacy: detached single-point pin
let editDraggingWidth      = false;     // legacy: wall trim diamond (pre-bake)
let editWidthWall          = null;

// Polygon handle drag state — used for ALL terrace types once a polygon exists
let editDraggingPolyVertex    = false;  // corner handle (free drag)
let editPolyVertexIdx         = null;
let editDraggingPolyEdge      = false;  // edge-midpoint handle (perpendicular)
let editPolyEdgeIdx           = null;
let editDraggingPolyTranslate = false;  // grab interior → translate whole polygon
let _editTranslateStartLL     = null;   // {lat, lng} where the drag began
let _editTranslateStartPoly   = null;   // snapshot of polygon at drag start

// Vertex tool mode: 'add' | 'del' | null
let editVertexMode         = null;

// ── Vertex tool mode (consumed by app.js wiring) ─────────────────────────────
function setEditVertexMode(mode) {
  editVertexMode = (mode === 'add' || mode === 'del') ? mode : null;
  // Reflect in chip buttons + cursor
  const addBtn = document.getElementById('edit-add-vertex-btn');
  const delBtn = document.getElementById('edit-del-vertex-btn');
  if (addBtn) addBtn.classList.toggle('active', editVertexMode === 'add');
  if (delBtn) delBtn.classList.toggle('active', editVertexMode === 'del');
  if (typeof canvas !== 'undefined') {
    canvas.style.cursor = editVertexMode ? 'crosshair' : 'default';
  }
}

function toggleEditVertexMode(mode) {
  setEditVertexMode(editVertexMode === mode ? null : mode);
}

// ── Active-polygon resolver ──────────────────────────────────────────────────
/**
 * Returns { latlng, key } for the venue's currently-editable polygon, or null.
 *   key = 'override' (street override), 'ai' (street AI poly visible),
 *         'courtyard', or 'detached'.
 */
/** All editable rings for a venue's active type as { rings, key }. rings is a
 *  list [[ [lat,lng], … ], … ] (multi-area). key ∈ override/ai/derived/courtyard/
 *  detached/rooftop/null. asRings normalizes single-ring legacy values. */
function getActivePolygons(v) {
  if (!v) return { rings: [], key: null };
  const type = v.terraceType ?? 'street';
  if (type === 'rooftop')   return { rings: [], key: 'rooftop' };
  if (type === 'courtyard') return { rings: asRings(v.courtyardPolygon), key: 'courtyard' };
  if (type === 'detached')  return { rings: asRings(v.detachedPolygon),  key: 'detached' };
  // Street: prefer the manual override, else fall straight to the wall-derived
  // polygon (entrance/facing wall + depth — the reliable default). The AI
  // proposal is NO LONGER the default: it's opt-in via "Vis AI-forslag"
  // (adoptAiProposal), so a wrong AI shape never silently replaces the good
  // wall-derived one or gets baked by an "approve".
  const override = asRings(v.seatingPolygonOverride);
  if (override.length) return { rings: override, key: 'override' };
  // Wall-derived preview (single ring) — seeds the editor before any override.
  if (typeof getTerraceWalls === 'function' && typeof terracePolygons === 'function') {
    const walls = getTerraceWalls(v);
    if (walls.length) {
      const pxPerM  = pxPerMetre(v);
      const depthPx = getEffectiveDepth(v) * pxPerM;
      const trimmed = _applyTrimToWalls(v, walls, pxPerM);
      const polys = terracePolygons(v, trimmed, depthPx);
      if (polys.length) {
        const latlng = polys[0].map(p => { const ll = map.unproject([p.x, p.y]); return [ll.lat, ll.lng]; });
        return { rings: [latlng], key: 'derived' };
      }
    }
  }
  return { rings: [], key: null };
}

/** Single-ring shim (first ring) for legacy callers. */
function getActivePolygon(v) {
  const { rings, key } = getActivePolygons(v);
  return rings.length ? { latlng: rings[0], key } : null;
}

/** Write a ring LIST to the active type's field + recompute the union of test
 *  points across all rings (building-clipped points dropped for street/detached;
 *  see seatingTestPointsForVenue). Empty list → field null. */
function setActivePolygons(v, rings) {
  if (!v) return;
  const list   = asRings(rings);
  const stored = list.length ? list : null;
  const type   = v.terraceType ?? 'street';
  if (type === 'courtyard')      v.courtyardPolygon       = stored;
  else if (type === 'detached')  v.detachedPolygon        = stored;
  else                           v.seatingPolygonOverride = stored;
  if (typeof seatingTestPointsForVenue === 'function') {
    const pts = seatingTestPointsForVenue(v, list);
    if (pts.length) v.terraceTestPoints = pts;
  } else if (typeof seatingPolygonsTestPoints === 'function') {
    const pts = seatingPolygonsTestPoints(list);
    if (pts.length) v.terraceTestPoints = pts;
  }
}

/** Single-ring shim. */
function setActivePolygon(v, latlng) {
  setActivePolygons(v, (Array.isArray(latlng) && latlng.length >= 3) ? [latlng] : []);
}

/** Best-effort terrace-type classification from polygon placement (auto-type):
 *  detached (no/away-from building) → street (hugs a precomputed street-facing
 *  wall, per autoTerraceWallIndices) → courtyard (hugs another building wall).
 *  Never returns 'rooftop' (that stays a manual choice). */
function classifyTerraceType(v, rings) {
  const list = asRings(rings);
  if (!list.length) return null;
  const bld = v && v.buildingGeometry;
  if (!Array.isArray(bld) || bld.length < 3) return 'detached';
  const bldNodes = bld.map(n => ({ lat: n.lat, lon: n.lon }));
  const walls = Array.isArray(v.wallNormals) ? v.wallNormals : [];
  const TOUCH_M = 4;
  let touches = false, nearestWallIdx = -1, nearestD = Infinity;
  for (const ring of list) {
    for (const [lat, lng] of ring) {
      if (typeof pointInPolygon === 'function' && pointInPolygon(lat, lng, bldNodes)) touches = true;
      for (let wi = 0; wi < walls.length; wi++) {
        const d = _distPointToWallM(lat, lng, walls[wi]);
        if (d < nearestD) { nearestD = d; nearestWallIdx = wi; }
      }
    }
  }
  if (nearestD <= TOUCH_M) touches = true;
  if (!touches) return 'detached';
  const streetWalls = Array.isArray(v.autoTerraceWallIndices) ? v.autoTerraceWallIndices : [];
  return streetWalls.includes(nearestWallIdx) ? 'street' : 'courtyard';
}

/** Distance in metres from (lat,lng) to a wall segment (equirectangular approx). */
function _distPointToWallM(lat, lng, w) {
  if (!w) return Infinity;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const ax = w.aLng * cosLat, ay = w.aLat;
  const bx = w.bLng * cosLat, by = w.bLat;
  const px = lng * cosLat,    py = lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-12;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(py - cy, px - cx) * 111320;
}

// ── Polygon seeders (default shapes when a type is first selected) ───────────

/** Build a sizeM × sizeM square centred on (lat, lng). */
function _seedSquarePolygon(centerLat, centerLng, sizeM) {
  const dLat = (sizeM / 2) / 111000;
  const dLng = (sizeM / 2) / (111000 * Math.cos(centerLat * Math.PI / 180));
  return [
    [centerLat + dLat, centerLng - dLng],
    [centerLat + dLat, centerLng + dLng],
    [centerLat - dLat, centerLng + dLng],
    [centerLat - dLat, centerLng - dLng],
  ];
}

function seedCourtyardPolygon(v) {
  const c = v.buildingGeometry?.length
    ? computeCentroid(v.buildingGeometry)
    : { lat: v.lat, lon: v.lng };
  return _seedSquarePolygon(c.lat, c.lon, 6);
}

function seedDetachedPolygon(v) {
  const loc = v.terraceDetachedLocation ?? { lat: v.lat, lng: v.lng };
  return _seedSquarePolygon(loc.lat, loc.lng, 6);
}

/** Bake the wall+depth-derived polygon into seatingPolygonOverride.
 *  Called the moment the user starts dragging any polygon handle on a street
 *  terrace that's still in lazy wall mode. Returns true if a bake happened. */
function bakeStreetPolygon(v) {
  if (!v || v.seatingPolygonOverride) return false;
  if ((v.terraceType ?? 'street') !== 'street') return false;
  const walls = (typeof getTerraceWalls === 'function') ? getTerraceWalls(v) : [];
  if (!walls.length) return false;
  const pxPerM = pxPerMetre(v);
  const depthPx = getEffectiveDepth(v) * pxPerM;
  const trimmed = _applyTrimToWalls(v, walls, pxPerM);
  const polys = terracePolygons(v, trimmed, depthPx);
  if (!polys.length) return false;
  // Use the first chain — Merge button can be used beforehand if needed.
  const polyPx = polys[0];
  const latlng = polyPx.map(p => {
    const ll = map.unproject([p.x, p.y]);
    return [ll.lat, ll.lng];
  });
  v.seatingPolygonOverride = latlng;
  if (typeof seatingPolygonTestPoints === 'function') {
    const pts = seatingPolygonTestPoints(latlng);
    if (pts.length) v.terraceTestPoints = pts;
  }
  return true;
}

// ── Hit tests ────────────────────────────────────────────────────────────────

function hitTestActivePolygonVertex(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return null;
  const ap = getActivePolygon(v);
  if (!ap) return null;
  for (let i = 0; i < ap.latlng.length; i++) {
    const [lat, lng] = ap.latlng[i];
    const p = map.project([lng, lat]);
    if (Math.hypot(cx - p.x, cy - p.y) < 14) return i;
  }
  return null;
}

function hitTestActivePolygonEdge(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return null;
  const ap = getActivePolygon(v);
  if (!ap) return null;
  const px = ap.latlng.map(([lat, lng]) => map.project([lng, lat]));
  for (let i = 0; i < px.length; i++) {
    const a = px[i], b = px[(i + 1) % px.length];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (Math.hypot(cx - mx, cy - my) < 14) return i;
  }
  return null;
}

/** Test if (cx,cy) is on or near a polygon edge (anywhere, not just midpoint).
 *  Returns { edgeIdx, lat, lng } at the closest point on the edge, or null. */
function hitTestActivePolygonEdgeAt(cx, cy, threshold = 12) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return null;
  const ap = getActivePolygon(v);
  if (!ap) return null;
  const px = ap.latlng.map(([lat, lng]) => map.project([lng, lat]));
  let best = null, bestD = threshold * threshold;
  for (let i = 0; i < px.length; i++) {
    const a = px[i], b = px[(i + 1) % px.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy || 1;
    let t = ((cx - a.x) * dx + (cy - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px2 = a.x + t * dx, py2 = a.y + t * dy;
    const d = (cx - px2) * (cx - px2) + (cy - py2) * (cy - py2);
    if (d < bestD) {
      const ll = map.unproject([px2, py2]);
      best = { edgeIdx: i, lat: ll.lat, lng: ll.lng };
      bestD = d;
    }
  }
  return best;
}

// ── Polygon mutations ────────────────────────────────────────────────────────

/**
 * Returns true if the candidate move would push the terrace FURTHER into the
 * building than it already sits. Rooftops sit on top of the building and
 * courtyards live inside it, so both are exempt. Street and detached terraces
 * should stay outside the footprint — but a street terrace is extruded straight
 * off the wall, so its wall-side vertices routinely land a hair inside after
 * projection rounding. An absolute overlap test therefore rejected every drag
 * (the wall-side vertices never leave), freezing the handles. Instead we count
 * vertices inside the building before vs. after: the move is rejected only if it
 * drives a *new* vertex inside, so the polygon "sticks" at the wall while
 * staying freely draggable everywhere else.
 */
function _editWouldViolateBuilding(v, candidate) {
  if (!v || !Array.isArray(candidate) || candidate.length < 3) return false;
  const type = v.terraceType ?? 'street';
  if (type === 'rooftop' || type === 'courtyard') return false;
  if (typeof countVerticesInBuilding !== 'function') return false;
  const bld = v.buildingGeometry;
  if (!Array.isArray(bld) || bld.length < 3) return false;
  const cur = getActivePolygon(v);
  const baseInside = cur ? countVerticesInBuilding(cur.latlng, bld) : 0;
  const candInside = countVerticesInBuilding(candidate, bld);
  return candInside > baseInside;
}

function updatePolygonVertex(venueId, idx, lat, lng) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  bakeStreetPolygon(v);
  const ap = getActivePolygon(v);
  if (!ap || idx < 0 || idx >= ap.latlng.length) return;
  const next = ap.latlng.map((pt, i) => i === idx ? [lat, lng] : pt);
  if (_editWouldViolateBuilding(v, next)) return;
  setActivePolygon(v, next);
}

/** Drag an edge perpendicular to itself (cursor px). */
function shiftPolygonEdge(venueId, edgeIdx, cursorX, cursorY) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  bakeStreetPolygon(v);
  const ap = getActivePolygon(v);
  if (!ap) return;
  const px = ap.latlng.map(([lat, lng]) => map.project([lng, lat]));
  const a  = px[edgeIdx], b = px[(edgeIdx + 1) % px.length];
  const ex = b.x - a.x,   ey = b.y - a.y;
  const len = Math.hypot(ex, ey) || 1;

  // Outward normal: pick the side that points away from polygon centroid.
  let cxC = 0, cyC = 0;
  px.forEach(p => { cxC += p.x; cyC += p.y; });
  cxC /= px.length; cyC /= px.length;
  let nx = -ey / len, ny = ex / len;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  if (nx * (mx - cxC) + ny * (my - cyC) < 0) { nx = -nx; ny = -ny; }

  // Project cursor onto outward normal relative to edge midpoint
  const dist = (cursorX - mx) * nx + (cursorY - my) * ny;
  const nA = { x: a.x + nx * dist, y: a.y + ny * dist };
  const nB = { x: b.x + nx * dist, y: b.y + ny * dist };

  const llA = map.unproject([nA.x, nA.y]);
  const llB = map.unproject([nB.x, nB.y]);
  const next = ap.latlng.slice();
  next[edgeIdx] = [llA.lat, llA.lng];
  next[(edgeIdx + 1) % next.length] = [llB.lat, llB.lng];
  if (_editWouldViolateBuilding(v, next)) return;
  setActivePolygon(v, next);
}

function insertPolygonVertexAt(venueId, edgeIdx, lat, lng) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  bakeStreetPolygon(v);
  const ap = getActivePolygon(v);
  if (!ap) return;
  const next = ap.latlng.slice();
  next.splice(edgeIdx + 1, 0, [lat, lng]);
  if (_editWouldViolateBuilding(v, next)) return;
  setActivePolygon(v, next);
}

function deletePolygonVertex(venueId, idx) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  const ap = getActivePolygon(v);
  if (!ap || ap.latlng.length <= 3) return;
  const next = ap.latlng.filter((_, i) => i !== idx);
  if (_editWouldViolateBuilding(v, next)) return;
  setActivePolygon(v, next);
}

// ── Whole-polygon translate (grab the interior to move the polygon) ──────────

/** Hit-test: is (cx, cy) strictly inside the active polygon, away from any
 *  handle? Returns true → caller should start a polygon-translate drag. */
function hitTestActivePolygonInterior(cx, cy) {
  if (!editingVenueId) return false;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return false;
  const ap = getActivePolygon(v);
  if (!ap) return false;
  // Skip if the cursor is on a handle; corner / edge tests take priority.
  if (hitTestActivePolygonVertex(cx, cy) !== null) return false;
  if (hitTestActivePolygonEdge(cx, cy)   !== null) return false;
  const px = ap.latlng.map(([lat, lng]) => map.project([lng, lat]));
  return _pixPointInPolygon(cx, cy, px);
}

function _pixPointInPolygon(cx, cy, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > cy) !== (yj > cy)) &&
        (cx < (xj - xi) * (cy - yi) / ((yj - yi) || 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Begin a whole-polygon translate. Stores a SNAPSHOT of the polygon and the
 *  cursor lat/lng so subsequent moves apply the cumulative delta against the
 *  snapshot (avoids drift from per-frame rounding). */
function startPolygonTranslate(cursorX, cursorY) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return false;
  bakeStreetPolygon(v);
  const ap = getActivePolygon(v);
  if (!ap) return false;
  const ll = map.unproject([cursorX, cursorY]);
  editDraggingPolyTranslate = true;
  _editTranslateStartLL     = { lat: ll.lat, lng: ll.lng };
  _editTranslateStartPoly   = ap.latlng.map(p => p.slice());
  return true;
}

function moveActivePolygonTo(cursorX, cursorY) {
  if (!editDraggingPolyTranslate) return;
  if (!_editTranslateStartLL || !_editTranslateStartPoly) return;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;
  const ll = map.unproject([cursorX, cursorY]);
  const dLat = ll.lat - _editTranslateStartLL.lat;
  const dLng = ll.lng - _editTranslateStartLL.lng;
  const next = _editTranslateStartPoly.map(([lat, lng]) => [lat + dLat, lng + dLng]);
  if (_editWouldViolateBuilding(v, next)) return;
  setActivePolygon(v, next);
}

function endPolygonTranslate() {
  editDraggingPolyTranslate = false;
  _editTranslateStartLL     = null;
  _editTranslateStartPoly   = null;
}

// Backwards compatibility — older callers used updateSeatingPolygonVertex
function updateSeatingPolygonVertex(venueId, vertexIdx, lat, lng) {
  return updatePolygonVertex(venueId, vertexIdx, lat, lng);
}

// ── Building editor canvas drawing ───────────────────────────────────────────
function drawBuildingEditor() {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;

  // No scrim: the editor works over untouched (bright) satellite imagery so
  // the admin can read what's actually on the ground. Shapes are conveyed by
  // crisp outlines + handles, never by dimming the map.

  if (!v.buildingGeometry || !v.wallNormals) {
    const pt = map.project([v.lng, v.lat]);
    ctx.strokeStyle = 'rgba(245,194,94,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.moveTo(pt.x - 20, pt.y); ctx.lineTo(pt.x + 20, pt.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pt.x, pt.y - 20); ctx.lineTo(pt.x, pt.y + 20); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const nodes    = v.buildingGeometry, walls = v.wallNormals;
  const terrType = v.terraceType ?? 'street';

  // Building polygon — always shown for context, as a crisp outline only (no
  // fill) so the satellite imagery underneath stays fully legible. Type drives
  // the stroke colour. A dark under-stroke keeps the line readable over both
  // light and dark imagery.
  ctx.beginPath();
  nodes.forEach((n, i) => {
    const pt = map.project([n.lon, n.lat]);
    i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  const bldStroke = { rooftop: 'rgba(245,194,94,0.95)', courtyard: 'rgba(192,122,255,0.95)',
                      detached: 'rgba(120,180,255,0.95)', street: 'rgba(120,180,255,0.95)' };
  ctx.strokeStyle = 'rgba(10,14,28,0.55)'; ctx.lineWidth = 3.5; ctx.stroke();
  ctx.strokeStyle = bldStroke[terrType] ?? bldStroke.street; ctx.lineWidth = 1.5; ctx.stroke();

  // Rooftop: tint + label only — not editable
  if (terrType === 'rooftop') {
    const cen   = computeCentroid(nodes);
    const cenPx = map.project([cen.lon, cen.lat]);
    ctx.font = 'bold 13px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = '▲ Tak';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,14,28,0.80)';
    fillRoundRect(ctx, cenPx.x - tw / 2 - 10, cenPx.y - 13, tw + 20, 26, 7);
    ctx.fillStyle = TOKENS.accent;
    ctx.fillText(label, cenPx.x, cenPx.y);
    return;
  }

  // Street: wall arrows are how you pick which building side(s) the terrace is
  // on — and they stay available ALWAYS (even after edits), so you can always
  // re-pick walls. (Type drives the model: street = walls; for a free-form
  // shape, switch the type to Frittstående.)
  if (terrType === 'street') {
    walls.forEach((wall, idx) => {
      const pa = map.project([wall.aLng, wall.aLat]);
      const pb = map.project([wall.bLng, wall.bLat]);
      const isHovered = idx === editHoveredWallIdx;
      const currentWalls = getTerraceWalls(v);
      const isCurrent = currentWalls.includes(wall);
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;

      // Outward perpendicular for the arrow direction
      const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
      const wl  = Math.hypot(wdx, wdy) || 1;
      let normX = -wdy / wl, normY = wdx / wl;
      if (v.buildingGeometry) {
        const cen   = computeCentroid(v.buildingGeometry);
        const cenPx = map.project([cen.lon, cen.lat]);
        if (normX * (cenPx.x - mx) + normY * (cenPx.y - my) > 0) { normX = -normX; normY = -normY; }
      }

      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
      ctx.strokeStyle = isHovered ? TOKENS.accent : isCurrent ? TOKENS.coral200 : 'rgba(120,180,255,0.75)';
      ctx.lineWidth   = isHovered ? 6 : isCurrent ? 4 : 2.5;
      ctx.stroke();

      if (isHovered || isCurrent) {
        [pa, pb].forEach(p => {
          ctx.beginPath(); ctx.arc(p.x, p.y, isHovered ? 5 : 4, 0, Math.PI * 2);
          ctx.fillStyle = isHovered ? TOKENS.accent : TOKENS.coral200; ctx.fill();
          ctx.strokeStyle = 'rgba(10,14,28,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
        });
      }

      if (isHovered) {
        const arrowLen = 55, ex = mx + normX * arrowLen, ey = my + normY * arrowLen;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
        ctx.strokeStyle = TOKENS.accent; ctx.lineWidth = 2.5; ctx.stroke();
        const hl = 11, pA = Math.atan2(normY, normX);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - hl * Math.cos(pA - 0.4), ey - hl * Math.sin(pA - 0.4));
        ctx.lineTo(ex - hl * Math.cos(pA + 0.4), ey - hl * Math.sin(pA + 0.4));
        ctx.closePath(); ctx.fillStyle = TOKENS.accent; ctx.fill();

        const labelText = `${Math.round(wall.bearing)}°  ${bearingToCardinal(wall.bearing)}`;
        ctx.font = 'bold 12px "Inter", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(labelText).width;
        const lx = ex + normX * 18, ly = ey + normY * 18;
        ctx.fillStyle = 'rgba(10,14,28,0.88)';
        fillRoundRect(ctx, lx - tw / 2 - 8, ly - 12, tw + 16, 24, 6);
        ctx.fillStyle = TOKENS.accent; ctx.fillText(labelText, lx, ly);
      }
    });

    // The editable terrace polygon (wall-derived, or any override) is rendered
    // by Mapbox GL Draw now — not on this canvas. The wall arrows above remain
    // as a static reference of which building side(s) the terrace derives from.
  }

  // Courtyard / detached / street-override polygons are all rendered by Mapbox
  // GL Draw (map layers), so nothing further is drawn on this canvas here.
}

// ── Polygon outline + handle drawing ─────────────────────────────────────────

function _drawPolygonOutlinePx(px, key) {
  if (!Array.isArray(px) || px.length < 3) return;
  // Outline only — no fill, so the satellite imagery underneath stays fully
  // legible. A dark under-stroke gives the coloured line contrast on bright
  // imagery; the colour reads the terrace type.
  const strokeStyle = key === 'courtyard' ? 'rgba(192,122,255,0.95)'
                    : key === 'detached'  ? 'rgba(245,194,94,0.95)'
                    : key === 'ai'        ? 'rgba(168,230,197,0.95)'
                    :                       'rgba(245,194,94,0.95)';
  ctx.beginPath();
  px.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.strokeStyle = 'rgba(10,14,28,0.55)'; ctx.lineWidth = 4.5; ctx.stroke();
  ctx.strokeStyle = strokeStyle; ctx.lineWidth = 2; ctx.stroke();
}

function _drawPolygonHandlesPx(px, key) {
  if (!Array.isArray(px) || px.length < 3) return;

  // Edge midpoints — rotated capsule aligned with the edge. Soft drop shadow,
  // hairline rim. Drawn first so corners sit on top.
  for (let i = 0; i < px.length; i++) {
    const a = px[i], b = px[(i + 1) % px.length];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const dragging = editDraggingPolyEdge && editPolyEdgeIdx === i;
    const w = dragging ? 22 : 18;       // along the edge
    const h = dragging ? 9  : 7;        // perpendicular to the edge
    const r = h / 2;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);
    // Soft drop shadow
    ctx.shadowColor   = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur    = 6;
    ctx.shadowOffsetY = 1.5;
    // Cream fill with a vertical highlight gradient — a subtle "lens bead"
    const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    grad.addColorStop(0,   'rgba(255,255,255,0.95)');
    grad.addColorStop(0.55, dragging ? TOKENS.text : 'rgba(255,242,235,0.92)');
    grad.addColorStop(1,   'rgba(220,210,200,0.92)');
    ctx.fillStyle = grad;
    _roundRectPath(ctx, -w / 2, -h / 2, w, h, r);
    ctx.fill();
    // Drop-shadow done; clear it before stroking so the rim stays crisp
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(10,14,28,0.35)';
    ctx.lineWidth   = 0.75;
    _roundRectPath(ctx, -w / 2, -h / 2, w, h, r);
    ctx.stroke();
    ctx.restore();
  }

  // Corner handles — tangerine bead with soft halo + inner highlight
  px.forEach((p, idx) => {
    const dragging = editDraggingPolyVertex && editPolyVertexIdx === idx;
    const R = dragging ? 9 : 7;

    ctx.save();
    // Outer halo (no offset) — felt rather than seen
    ctx.shadowColor   = 'rgba(245,194,94,0.65)';
    ctx.shadowBlur    = dragging ? 14 : 10;
    ctx.shadowOffsetY = 0;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fillStyle = dragging ? TOKENS.accent : '#FFB893';
    ctx.fill();
    // Drop-shadow off for the rest
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    // Inner highlight (top-left, to suggest a glassy bead)
    const ghx = p.x - R * 0.30, ghy = p.y - R * 0.40;
    const ghGrad = ctx.createRadialGradient(ghx, ghy, 0, ghx, ghy, R * 0.85);
    ghGrad.addColorStop(0, 'rgba(255,242,235,0.85)');
    ghGrad.addColorStop(1, 'rgba(255,242,235,0)');
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fillStyle = ghGrad;
    ctx.fill();

    // Hairline rim
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(10,14,28,0.40)';
    ctx.lineWidth   = 0.75;
    ctx.stroke();
    ctx.restore();
  });
}

/** Path helper — manual roundRect because Safari < 16 lacks ctx.roundRect. */
function _roundRectPath(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.arcTo(x + w, y,     x + w, y + r,     r);
  c.lineTo(x + w, y + h - r);
  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);
  c.arcTo(x,     y + h, x,     y + h - r, r);
  c.lineTo(x, y + r);
  c.arcTo(x,     y,     x + r, y,         r);
  c.closePath();
}

// ── Legacy hit tests + helpers (kept for street wall-mode & touch handlers) ──

/** Hit-test the seating-polygon vertex (legacy alias). */
function hitTestSeatingPolygonVertex(cx, cy) {
  return hitTestActivePolygonVertex(cx, cy);
}

/** Apply terraceWallTrimStart/End to the first wall of a wall array. */
function _applyTrimToWalls(v, walls, pxPerM) {
  if (!walls.length) return walls;
  const sM = v.terraceWallTrimStart ?? 0;
  const eM = v.terraceWallTrimEnd   ?? 0;
  if (sM === 0 && eM === 0) return walls;

  const result = walls.slice();
  const w = walls[0];
  const pa = map.project([w.aLng, w.aLat]);
  const pb = map.project([w.bLng, w.bLat]);
  const lenPx = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
  const lenM  = lenPx / pxPerM;

  const sfrac = Math.min(0.48, sM / lenM);
  const efrac = Math.min(0.48, eM / lenM);

  result[0] = {
    ...w,
    aLat: w.aLat + (w.bLat - w.aLat) * sfrac,
    aLng: w.aLng + (w.bLng - w.aLng) * sfrac,
    bLat: w.bLat - (w.bLat - w.aLat) * efrac,
    bLng: w.bLng - (w.bLng - w.aLng) * efrac,
  };
  return result;
}

/** Legacy width-handle hit test (always null now — width handles are gone). */
function hitTestWidthHandle() { return null; }
