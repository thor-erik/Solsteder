/**
 * render-editor.js — Building editor canvas overlay.
 * Depends on: map, canvas, ctx, VENUES, editingVenueId, editHoveredWallIdx (app.js)
 *             getTerraceWalls, wallOutwardNormal, getEffectiveDepth, pxPerMetre,
 *             terracePolygons, fillRoundRect, bearingToCardinal,
 *             convexHull (render-helpers.js)
 *             computeCentroid (osm.js)
 */

// ── Depth-drag + detached-pin state ──────────────────────────────────────────
let editDraggingDepth    = false;
let editDragWallObj      = null;
let _detachedDragging    = false;

// ── Width-trim drag state ─────────────────────────────────────────────────────
// editDraggingWidth: 'start' | 'end' | false
let editDraggingWidth    = false;
// The primary wall used for width trimming (first selected wall)
let editWidthWall        = null;

// ── Seating-polygon vertex drag state ─────────────────────────────────────────
// When the venue has a resolved AI/manual polygon, vertices are draggable
// directly on the canvas. editPolyVertexIdx is the index being dragged
// (or null when idle). New positions are written into venue.seatingPolygonOverride
// and persisted to the facing cache + corrections log on mouseup.
let editDraggingPolyVertex = false;
let editPolyVertexIdx      = null;

// ── Building editor overlay ───────────────────────────────────────────────────
function drawBuildingEditor() {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;

  const _dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = 'rgba(10,14,28,0.58)';
  ctx.fillRect(0, 0, canvas.width / _dpr, canvas.height / _dpr);

  if (!v.buildingGeometry || !v.wallNormals) {
    const pt = map.project([v.lng, v.lat]);
    ctx.strokeStyle = 'rgba(255,175,133,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.moveTo(pt.x - 20, pt.y); ctx.lineTo(pt.x + 20, pt.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pt.x, pt.y - 20); ctx.lineTo(pt.x, pt.y + 20); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const nodes    = v.buildingGeometry, walls = v.wallNormals;
  const terrType = v.terraceType ?? 'street';

  // Building polygon — always shown for context
  ctx.beginPath();
  nodes.forEach((n, i) => {
    const pt = map.project([n.lon, n.lat]);
    i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  // Tint varies by type: rooftop = amber, courtyard = purple, detached = dim, street = blue
  const bldFill = { rooftop: 'rgba(255,175,133,0.18)', courtyard: 'rgba(160,100,255,0.20)',
                    detached: 'rgba(24,88,180,0.22)', street: 'rgba(24,88,180,0.45)' };
  ctx.fillStyle = bldFill[terrType] ?? bldFill.street;
  ctx.fill();

  // Detached: draw movable pin + skip wall interaction
  if (terrType === 'detached') {
    const loc = v.terraceDetachedLocation ?? { lat: v.lat, lng: v.lng };
    const pt  = map.project([loc.lng, loc.lat]);
    const R   = _detachedDragging ? 13 : 11;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, R, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(255,175,133,0.18)'; ctx.fill();
    ctx.strokeStyle = '#FFAF85'; ctx.lineWidth = 2.5; ctx.stroke();
    const L = R + 7;
    ctx.beginPath();
    ctx.moveTo(pt.x - L, pt.y); ctx.lineTo(pt.x + L, pt.y);
    ctx.moveTo(pt.x, pt.y - L); ctx.lineTo(pt.x, pt.y + L);
    ctx.strokeStyle = 'rgba(255,175,133,0.70)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '11px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(10,14,28,0.80)';
    fillRoundRect(ctx, pt.x + R + 6, pt.y - 11, 88, 22, 5);
    ctx.fillStyle = '#FFAF85';
    ctx.fillText('Drag to move', pt.x + R + 12, pt.y);
    return;
  }

  // Rooftop / courtyard: show building tint + label, skip wall arrows
  if (terrType === 'rooftop' || terrType === 'courtyard') {
    const cen   = computeCentroid(nodes);
    const cenPx = map.project([cen.lon, cen.lat]);
    ctx.font = 'bold 13px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = terrType === 'rooftop' ? '▲ Rooftop' : '◉ Courtyard';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,14,28,0.80)';
    fillRoundRect(ctx, cenPx.x - tw / 2 - 10, cenPx.y - 13, tw + 20, 26, 7);
    ctx.fillStyle = terrType === 'rooftop' ? '#FFAF85' : '#C07AFF';
    ctx.fillText(label, cenPx.x, cenPx.y);
    return;
  }

  // Street: interactive wall arrows + depth handles
  const currentWalls = getTerraceWalls(v);

  walls.forEach((wall, idx) => {
    const pa = map.project([wall.aLng, wall.aLat]);
    const pb = map.project([wall.bLng, wall.bLat]);
    const isHovered = idx === editHoveredWallIdx;
    const isCurrent = currentWalls.includes(wall);
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;

    // Pixel-space outward perpendicular
    const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
    const wl  = Math.hypot(wdx, wdy) || 1;
    let normX = -wdy / wl, normY = wdx / wl;
    if (v.buildingGeometry) {
      const cen   = computeCentroid(v.buildingGeometry);
      const cenPx = map.project([cen.lon, cen.lat]);
      if (normX * (cenPx.x - mx) + normY * (cenPx.y - my) > 0) { normX = -normX; normY = -normY; }
    }

    // Wall line
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    ctx.strokeStyle = isHovered ? '#FFAF85' : isCurrent ? '#FFCBAA' : 'rgba(120,180,255,0.75)';
    ctx.lineWidth   = isHovered ? 6 : isCurrent ? 4 : 2.5;
    ctx.stroke();

    if (isHovered || isCurrent) {
      [pa, pb].forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, isHovered ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isHovered ? '#FFAF85' : '#FFCBAA'; ctx.fill();
        ctx.strokeStyle = 'rgba(10,14,28,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
      });
    }

    if (isHovered) {
      const arrowLen = 55, ex = mx + normX * arrowLen, ey = my + normY * arrowLen;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
      ctx.strokeStyle = '#FFAF85'; ctx.lineWidth = 2.5; ctx.setLineDash([]); ctx.stroke();
      const hl = 11, pA = Math.atan2(normY, normX);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - hl * Math.cos(pA - 0.4), ey - hl * Math.sin(pA - 0.4));
      ctx.lineTo(ex - hl * Math.cos(pA + 0.4), ey - hl * Math.sin(pA + 0.4));
      ctx.closePath(); ctx.fillStyle = '#FFAF85'; ctx.fill();

      const labelText = `${Math.round(wall.bearing)}°  ${bearingToCardinal(wall.bearing)}`;
      ctx.font = 'bold 12px "Inter", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(labelText).width;
      const lx = ex + normX * 18, ly = ey + normY * 18;
      ctx.fillStyle = 'rgba(10,14,28,0.88)';
      fillRoundRect(ctx, lx - tw / 2 - 8, ly - 12, tw + 16, 24, 6);
      ctx.fillStyle = '#FFAF85'; ctx.fillText(labelText, lx, ly);
    }

    if (isCurrent && !isHovered) {
      const arrowLen = 32, ex = mx + normX * arrowLen, ey = my + normY * arrowLen;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
      ctx.strokeStyle = '#FFCBAA'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // ── Terrace preview + depth handles ────────────────────────────────────────
  if (currentWalls.length > 0) {
    const depth   = getEffectiveDepth(v);
    const pxPerM  = pxPerMetre(v);
    const depthPx = depth * pxPerM;

    // Apply width trim to first wall for terrace preview
    const trimmedWalls = _applyTrimToWalls(v, currentWalls, pxPerM);

    // Mitered terrace preview (one clean polygon per connected chain)
    const polys = terracePolygons(v, trimmedWalls, depthPx);
    polys.forEach(poly => {
      ctx.beginPath();
      poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,175,133,0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,175,133,0.45)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    });

    // Depth handle per wall (each shows depth, drag adjusts shared depth)
    currentWalls.forEach(wall => {
      const { normX, normY, mx, my } = wallOutwardNormal(v, wall);
      const hx = mx + normX * depthPx;
      const hy = my + normY * depthPx;

      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(hx, hy);
      ctx.strokeStyle = 'rgba(255,175,133,0.55)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);

      const draggingThis = editDraggingDepth && editDragWallObj === wall;
      ctx.beginPath(); ctx.arc(hx, hy, draggingThis ? 10 : 8, 0, Math.PI * 2);
      ctx.fillStyle   = draggingThis ? 'rgba(156,189,231,0.9)' : 'rgba(156,189,231,0.7)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,14,28,0.9)'; ctx.lineWidth = 2; ctx.stroke();

      // Depth label
      ctx.font = 'bold 10px "Inter", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lx = hx + normX * 20, ly = hy + normY * 20;
      ctx.fillStyle = 'rgba(10,14,28,0.88)';
      fillRoundRect(ctx, lx - 15, ly - 10, 30, 20, 5);
      ctx.fillStyle = '#FFAF85';
      ctx.fillText(`${Math.round(depth)}m`, lx, ly);
    });

    // Width trim handles on first selected wall (diamond handles at endpoints)
    _drawWidthHandles(v, currentWalls[0], pxPerM);
  }

  // Resolved AI / manual seating polygon: draw on top with draggable vertices.
  // This lets the admin nudge a single corner without re-doing the whole wall
  // selection. Edits are stored as v.seatingPolygonOverride.
  _drawSeatingPolygonHandles(v);
}

// ── Seating-polygon handles (overlay on AI / manual polygon) ──────────────────

function _drawSeatingPolygonHandles(v) {
  if (typeof getSeatingPolygon !== 'function') return;
  const poly = getSeatingPolygon(v);
  if (!poly || poly.length < 3) return;

  const px = poly.map(([lat, lng]) => map.project([lng, lat]));

  // Polygon outline — distinct from the wall-based preview above
  ctx.beginPath();
  px.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle   = 'rgba(120,200,160,0.10)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,200,160,0.85)';
  ctx.lineWidth   = 2; ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);

  // Vertex handles
  px.forEach((p, idx) => {
    const dragging = editDraggingPolyVertex && editPolyVertexIdx === idx;
    const R = dragging ? 8 : 6;
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fillStyle   = dragging ? '#A8E6C5' : 'rgba(168,230,197,0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,28,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

/** Hit-test a seating-polygon vertex. Returns the vertex index, or null. */
function hitTestSeatingPolygonVertex(cx, cy) {
  if (!editingVenueId || typeof getSeatingPolygon !== 'function') return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return null;
  const poly = getSeatingPolygon(v);
  if (!poly || poly.length < 3) return null;
  for (let i = 0; i < poly.length; i++) {
    const [lat, lng] = poly[i];
    const p = map.project([lng, lat]);
    if (Math.hypot(cx - p.x, cy - p.y) < 12) return i;
  }
  return null;
}

/**
 * Move a single polygon vertex to the lat/lng under the cursor and persist
 * the new polygon to the in-memory venue + localStorage facing cache.
 * Test points (used for shadow checks) are recomputed so the change is
 * reflected immediately in the timeline without a worker round-trip.
 */
function updateSeatingPolygonVertex(venueId, vertexIdx, lat, lng) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  const current = (typeof getSeatingPolygon === 'function') ? getSeatingPolygon(v) : null;
  if (!current || vertexIdx < 0 || vertexIdx >= current.length) return;
  const next = current.map((pt, i) => i === vertexIdx ? [lat, lng] : pt);
  v.seatingPolygonOverride = next;
  if (typeof seatingPolygonTestPoints === 'function') {
    const pts = seatingPolygonTestPoints(next);
    if (pts.length) v.terraceTestPoints = pts;
  }
}

// ── Width trim helpers ────────────────────────────────────────────────────────

/**
 * Apply terraceWallTrimStart/End to the first wall of a wall array,
 * returning new wall copies with interpolated lat/lng endpoints.
 */
function _applyTrimToWalls(v, walls, pxPerM) {
  if (!walls.length) return walls;
  const sM = v.terraceWallTrimStart ?? 0;
  const eM = v.terraceWallTrimEnd   ?? 0;
  if (sM === 0 && eM === 0) return walls;

  const result = walls.slice();
  const w = walls[0];
  // Compute wall length in metres
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

/** Compute pixel position of width handle at start or end of wall with trim applied. */
function _getWidthHandlePos(v, wall, side, pxPerM) {
  const pa  = map.project([wall.aLng, wall.aLat]);
  const pb  = map.project([wall.bLng, wall.bLat]);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
  const sM  = v.terraceWallTrimStart ?? 0;
  const eM  = v.terraceWallTrimEnd   ?? 0;
  const sFrac = Math.min(0.48, sM / (len / pxPerM));
  const eFrac = Math.min(0.48, eM / (len / pxPerM));

  if (side === 'start') {
    return { x: pa.x + (pb.x - pa.x) * sFrac, y: pa.y + (pb.y - pa.y) * sFrac };
  } else {
    return { x: pb.x - (pb.x - pa.x) * eFrac, y: pb.y - (pb.y - pa.y) * eFrac };
  }
}

function _drawWidthHandles(v, wall, pxPerM) {
  if (!wall) return;
  for (const side of ['start', 'end']) {
    const { x, y } = _getWidthHandlePos(v, wall, side, pxPerM);
    const dragging  = editDraggingWidth === side && editWidthWall === wall;
    const R = dragging ? 10 : 8;

    // Diamond shape
    ctx.save();
    ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.rect(-R * 0.65, -R * 0.65, R * 1.3, R * 1.3);
    ctx.fillStyle   = dragging ? '#FFAF85' : 'rgba(255,175,133,0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,28,0.9)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();

    // Label: trim amount
    const trimM = side === 'start' ? (v.terraceWallTrimStart ?? 0) : (v.terraceWallTrimEnd ?? 0);
    if (trimM > 0.5) {
      ctx.font = 'bold 10px "Inter", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const pa = map.project([wall.aLng, wall.aLat]);
      const pb = map.project([wall.bLng, wall.bLat]);
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const nx = -(pb.y - pa.y) / len, ny = (pb.x - pa.x) / len;
      ctx.fillStyle = 'rgba(10,14,28,0.85)';
      fillRoundRect(ctx, x + nx * 20 - 14, y + ny * 20 - 10, 28, 20, 5);
      ctx.fillStyle = '#FFAF85';
      ctx.fillText(`${Math.round(trimM)}m`, x + nx * 20, y + ny * 20);
    }
  }
}

/** Hit test for width handles. Returns 'start', 'end', or null. */
function hitTestWidthHandle(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return null;
  const walls = getTerraceWalls(v);
  if (!walls.length) return null;
  const pxPerM = pxPerMetre(v);
  for (const side of ['start', 'end']) {
    const { x, y } = _getWidthHandlePos(v, walls[0], side, pxPerM);
    if (Math.hypot(cx - x, cy - y) < 14) return { side, wall: walls[0] };
  }
  return null;
}
