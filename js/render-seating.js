/**
 * render-seating.js — Seating area footprints and building shadow overlay.
 * Depends on: map, canvas, ctx, currentSun, selectedId, VENUES (app.js / data.js)
 *             venueSunState, pointInBuildingShadow (solar.js)
 *             getTerraceWalls, getEffectiveDepth, pxPerMetre,
 *             terracePolygons, convexHull (render-helpers.js)
 */

// ── Zoom-based pin density ────────────────────────────────────────────────────
// At low zoom levels only high-rated venues are shown to prevent an unreadable
// mass of overlapping pins. Thresholds are calibrated for Oslo city scale.
// zoom >= 13 (neighbourhood): show all
// zoom 11–12 (district):      rating >= 4.3
// zoom < 11  (city-wide):     rating >= 4.5
function shouldShowAtZoom(v, zoom) {
  if (zoom >= 13) return true;
  if (zoom >= 11) return v.rating >= 4.3;
  return v.rating >= 4.5;
}

// ── Seating area shapes ────────────────────────────────────────────────────────
/**
 * Draw terrace footprints for all visible venues at zoom >= 16.5.
 * - Venues with wallSegment: a rectangle (wall edge + TERRACE_DEPTH_M outward).
 * - Venues without: a fan sector centred on the facing direction.
 * Warm tint = in sun, cool tint = in shade.
 */
function drawSeatingAreas() {
  if (!currentSun) return;
  const zoom = map.getZoom();
  if (zoom < 16.5) return;
  const bounds = map.getBounds();
  const { az, alt } = currentSun;

  ctx.save();

  VENUES.forEach(v => {
    if (!bounds.contains([v.lng, v.lat])) return;
    if (!shouldShowAtZoom(v, zoom)) return;

    const sunny = venueSunState(v, az, alt);
    const fillSunny   = 'rgba(255,175,133,0.20)';
    const strokeSunny = 'rgba(255,175,133,0.65)';
    const fillShade   = 'rgba(40,80,180,0.13)';
    const strokeShade = 'rgba(80,130,220,0.35)';

    const depth = getEffectiveDepth(v);
    const walls = getTerraceWalls(v);

    if (walls.length > 0 && walls[0].aLat != null) {
      // Mitered polygon(s) — handles single walls, L-shapes, and multi-wall chains
      const polys = terracePolygons(v, walls, depth * pxPerMetre(v));
      polys.forEach(poly => {
        ctx.beginPath();
        poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle   = sunny ? fillSunny   : fillShade;
        ctx.fill();
        ctx.strokeStyle = sunny ? strokeSunny : strokeShade;
        ctx.lineWidth   = 1.5; ctx.setLineDash([]); ctx.stroke();
      });
    } else {
      // Fan fallback: sector in the facing direction
      const pt  = map.project([v.lng, v.lat]);
      const ref = map.project([v.lng, v.lat + depth / 111320]);
      const pxR = Math.max(12, Math.abs(pt.y - ref.y));
      const dir = (v.facing - 90) * RAD;
      const hw  = 40 * RAD;

      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.arc(pt.x, pt.y, pxR, dir - hw, dir + hw);
      ctx.closePath();
      ctx.fillStyle   = sunny ? fillSunny   : fillShade;
      ctx.fill();
      ctx.strokeStyle = sunny ? strokeSunny : strokeShade;
      ctx.lineWidth   = 1;
      ctx.stroke();
    }
  });

  ctx.restore();
}

// ── Shadow overlay ────────────────────────────────────────────────────────────
/**
 * For the selected venue: draw nearby building footprints, their cast shadows,
 * and a probe dot 2 m in front of the terrace wall (yellow = sun, blue = shade).
 */
function drawShadowOverlay(venue) {
  if (!venue.nearbyBuildings?.length || !currentSun) return;
  const { az, alt } = currentSun;
  if (alt < 2) return;

  const tanAlt = Math.tan(alt * RAD);
  if (tanAlt <= 0) return;

  // Probe point (same as venueSunState)
  let testLat = venue.lat, testLng = venue.lng;
  if (venue.wallSegment) {
    const br = venue.wallSegment.bearing * RAD;
    const wy = venue.wallSegment.my;
    testLat = wy + Math.cos(br) * 2 / 111320;
    testLng = venue.wallSegment.mx + Math.sin(br) * 2 / (111320 * Math.cos(wy * RAD));
  }

  // Only visualise buildings within 80 m — beyond that shadows rarely matter visually
  const vizThresh = 80 / 111320;

  ctx.save();

  for (const b of venue.nearbyBuildings) {
    const { geometry: nodes, height } = b;
    if (!nodes || nodes.length < 3 || height <= 0) continue;

    const avgLat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
    const avgLon = nodes.reduce((s, n) => s + n.lon, 0) / nodes.length;
    if (Math.hypot(avgLat - venue.lat, avgLon - venue.lng) > vizThresh) continue;

    const dLat = -Math.cos(az * RAD) / (tanAlt * 111320);
    const dLon = -Math.sin(az * RAD) / (tanAlt * 111320 * Math.cos(avgLat * RAD));

    const casting = pointInBuildingShadow(testLat, testLng, b, az, alt);

    // Convert footprint + shadow nodes to pixel space
    const footPx   = nodes.map(n => { const p = map.project([n.lon, n.lat]); return { x: p.x, y: p.y }; });
    const shadowPx = nodes.map(n => {
      const p = map.project([n.lon + height * dLon, n.lat + height * dLat]);
      return { x: p.x, y: p.y };
    });

    // Unified shadow shape = convex hull of footprint + shadow vertices
    const hull = convexHull([...footPx, ...shadowPx]);

    if (casting) {
      // Full unified shadow
      ctx.beginPath();
      hull.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(10,14,40,0.40)';
      ctx.fill();

      // Building footprint filled on top — distinct from shadow lobe
      ctx.beginPath();
      footPx.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(50,60,120,0.58)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,150,255,0.65)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // Non-casting building — subtle outline only
      ctx.beginPath();
      footPx.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(100,120,180,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Probe dot — 2 m in front of the terrace wall
  if (venue.wallSegment) {
    const br = venue.wallSegment.bearing * RAD;
    const wy = venue.wallSegment.my;
    const tLat = wy + Math.cos(br) * 2 / 111320;
    const tLng = venue.wallSegment.mx + Math.sin(br) * 2 / (111320 * Math.cos(wy * RAD));
    const pt = map.project([tLng, tLat]);
    const sunny = venueSunState(venue, az, alt);

    const glow = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, 13);
    glow.addColorStop(0, sunny ? 'rgba(255,175,133,0.5)' : 'rgba(100,130,210,0.45)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = glow; ctx.fill();

    ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = sunny ? '#FFAF85' : '#6080C8'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.restore();
}
