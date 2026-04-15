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
    const depth  = getEffectiveDepth(v);
    const pxPerM = pxPerMetre(v);
    const depthPx = depth * pxPerM;

    // Mitered terrace preview (one clean polygon per connected chain)
    const polys = terracePolygons(v, currentWalls, depthPx);
    polys.forEach(poly => {
      ctx.beginPath();
      poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(100,255,180,0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(100,255,180,0.55)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    });

    // Depth handle per wall (each shows depth, drag adjusts shared depth)
    currentWalls.forEach(wall => {
      const { normX, normY, mx, my } = wallOutwardNormal(v, wall);
      const hx = mx + normX * depthPx;
      const hy = my + normY * depthPx;

      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(hx, hy);
      ctx.strokeStyle = 'rgba(100,255,180,0.6)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);

      const draggingThis = editDraggingDepth && editDragWallObj === wall;
      ctx.beginPath(); ctx.arc(hx, hy, draggingThis ? 10 : 8, 0, Math.PI * 2);
      ctx.fillStyle   = draggingThis ? '#64ffb4' : 'rgba(100,255,180,0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,14,28,0.9)'; ctx.lineWidth = 2; ctx.stroke();

      // Depth label
      ctx.font = 'bold 10px "Inter", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lx = hx + normX * 20, ly = hy + normY * 20;
      ctx.fillStyle = 'rgba(10,14,28,0.88)';
      fillRoundRect(ctx, lx - 15, ly - 10, 30, 20, 5);
      ctx.fillStyle = '#64ffb4';
      ctx.fillText(`${Math.round(depth)}m`, lx, ly);
    });
  }
}
