/**
 * render.js — Canvas drawing: sprites, markers, building editor, map sync.
 * Depends on: map, canvas, ctx, currentSun, selectedId, editingVenueId (app.js)
 *             VENUES, catIcon (data.js) · venueSunState (solar.js)
 */

// ── Terrace wall helpers ──────────────────────────────────────────────────────
/**
 * Returns the array of wall objects that form the terrace for a venue.
 * - If terraceWallIndices is populated, use those indices into wallNormals.
 * - Otherwise fall back to the single best-match wall (wallSegment / closest bearing).
 */
function getTerraceWalls(v) {
  if (!v.wallNormals?.length) return v.wallSegment ? [v.wallSegment] : [];

  // Priority 1: manual selection from editor
  if (v.terraceWallIndices?.length) {
    return v.terraceWallIndices.map(i => v.wallNormals[i]).filter(Boolean);
  }
  // Priority 2: auto-computed (entrance location + scoring + corner adjacency)
  if (v.autoTerraceWallIndices?.length) {
    return v.autoTerraceWallIndices.map(i => v.wallNormals[i]).filter(Boolean);
  }
  // Fallback: single wall closest to v.facing
  const best = v.wallNormals.reduce((b, w) =>
    Math.abs(w.bearing - v.facing) < Math.abs(b.bearing - v.facing) ? w : b);
  return [best];
}

/**
 * Pixel-space outward unit normal for a wall, pointing away from building centroid.
 * Returns { normX, normY, mx, my } in canvas pixel coords.
 */
function wallOutwardNormal(v, wall) {
  const pa = map.project([wall.aLng, wall.aLat]);
  const pb = map.project([wall.bLng, wall.bLat]);
  const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
  const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
  const wl  = Math.hypot(wdx, wdy) || 1;
  let normX = -wdy / wl, normY = wdx / wl;
  if (v.buildingGeometry) {
    const cen   = computeCentroid(v.buildingGeometry);
    const cenPx = map.project([cen.lon, cen.lat]);
    if (normX * (cenPx.x - mx) + normY * (cenPx.y - my) > 0) { normX = -normX; normY = -normY; }
  }
  return { normX, normY, mx, my };
}

/**
 * Effective terrace depth for a venue in metres.
 * Priority: manual drag value → auto-detected highway distance → fallback constant.
 */
function getEffectiveDepth(v) {
  return v.terraceDepth ?? v.autoTerraceDepth ?? TERRACE_DEPTH_M;
}

/** Pixels per metre at the venue's latitude (lat-direction approximation). */
function pxPerMetre(v) {
  const base = map.project([v.lng, v.lat]);
  const ref  = map.project([v.lng, v.lat + 1 / 111320]);
  return Math.abs(ref.y - base.y);
}

// ── Depth-drag state ──────────────────────────────────────────────────────────
let editDraggingDepth = false;
let editDragWallObj   = null;

// ── Sprite cache ──────────────────────────────────────────────────────────────
// Each sprite is an offscreen canvas keyed by (id, facing, sunny, selected).
// draw() does one drawImage per visible venue instead of ~30 canvas ops.
const SPRITE = 72;  // px — fits marker radius 16 + pizza tip 10 + selection ring
const spriteCache = new Map();

function buildSprite(v, sunny, selected) {
  const oc = document.createElement('canvas');
  oc.width = oc.height = SPRITE;
  const c  = oc.getContext('2d');
  const cx = SPRITE / 2, cy = SPRITE / 2;
  const markerR = 16;
  const pAngle  = (v.facing - 90) * RAD;
  const halfA   = 0.40;   // ~23° half-angle
  const markerFill   = sunny ? '#e8a000' : '#1e3060';
  const markerStroke = sunny ? 'rgba(255,220,80,0.8)' : 'rgba(80,110,160,0.6)';

  // Pizza point — triangle drawn first; circle fill covers its base
  const tipDist = markerR + 10;
  c.beginPath();
  c.moveTo(cx + tipDist * Math.cos(pAngle), cy + tipDist * Math.sin(pAngle));
  c.lineTo(cx + markerR  * Math.cos(pAngle - halfA), cy + markerR  * Math.sin(pAngle - halfA));
  c.lineTo(cx + markerR  * Math.cos(pAngle + halfA), cy + markerR  * Math.sin(pAngle + halfA));
  c.closePath();
  c.fillStyle = markerFill; c.fill();

  // Sunny glow
  if (sunny) {
    const glow = c.createRadialGradient(cx, cy, 0, cx, cy, markerR + 10);
    glow.addColorStop(0, 'rgba(255,184,0,0.28)'); glow.addColorStop(1, 'rgba(255,184,0,0)');
    c.beginPath(); c.arc(cx, cy, markerR + 10, 0, Math.PI * 2); c.fillStyle = glow; c.fill();
  }

  // Selection ring
  if (selected) {
    c.beginPath(); c.arc(cx, cy, markerR + 5, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,184,0,0.85)'; c.lineWidth = 2; c.stroke();
  }

  // Circle fill (covers pizza base for seamless join)
  c.beginPath(); c.arc(cx, cy, markerR, 0, Math.PI * 2);
  c.fillStyle = markerFill; c.fill();

  // Arc stroke — skip the pizza attachment zone (~46°)
  c.beginPath();
  c.arc(cx, cy, markerR, pAngle + halfA, pAngle - halfA + Math.PI * 2, false);
  c.strokeStyle = markerStroke; c.lineWidth = 1.5; c.stroke();

  // Category icon
  c.font = `${markerR - 2}px "Apple Color Emoji","Segoe UI Emoji",serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(catIcon(v), cx, cy + 1);

  return oc;
}

function getSprite(v, sunny, selected) {
  const key = `${v.id}-${v.facing}-${sunny ? 1 : 0}-${selected ? 1 : 0}`;
  if (!spriteCache.has(key)) spriteCache.set(key, buildSprite(v, sunny, selected));
  return spriteCache.get(key);
}

function clearSpriteCache() { spriteCache.clear(); }

// ── Canvas utilities ──────────────────────────────────────────────────────────
function fillRoundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);      c.arcTo(x + w, y,     x + w, y + r,     r);
  c.lineTo(x + w, y + h - r);  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);      c.arcTo(x,     y + h, x,     y + h - r, r);
  c.lineTo(x, y + r);          c.arcTo(x,     y,     x + r, y,         r);
  c.closePath(); c.fill();
}

function bearingToCardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW','N'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45)];
}

// ── Canvas resize + map sync ──────────────────────────────────────────────────
function resizeCanvas() {
  const c = document.getElementById('map-container');
  canvas.width  = c.offsetWidth;
  canvas.height = c.offsetHeight;
}

resizeCanvas();
window.addEventListener('resize', () => { resizeCanvas(); draw(); });

map.on('move', draw);
map.on('zoomend', draw);

// ── Sun compass ───────────────────────────────────────────────────────────────
function drawSunCompass() {
  const cc = document.getElementById('sun-compass');
  if (!cc) return;
  const c = cc.getContext('2d');
  const w = cc.width, h = cc.height, cx = w / 2, cy = h / 2;
  const outerR = w / 2 - 2, innerR = outerR - 5;

  c.clearRect(0, 0, w, h);
  c.beginPath(); c.arc(cx, cy, outerR, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.04)'; c.fill();
  c.strokeStyle = 'rgba(255,184,0,0.18)'; c.lineWidth = 1; c.stroke();

  for (let i = 0; i < 8; i++) {
    const angle = (i * 45 - 90) * RAD;
    const len   = i % 2 === 0 ? 5 : 3;
    c.beginPath();
    c.moveTo(cx + (outerR - len) * Math.cos(angle), cy + (outerR - len) * Math.sin(angle));
    c.lineTo(cx + outerR * Math.cos(angle),          cy + outerR * Math.sin(angle));
    c.strokeStyle = i === 0 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.2)';
    c.lineWidth = i % 2 === 0 ? 1.5 : 1; c.stroke();
  }
  c.font = 'bold 7px "DM Sans", sans-serif';
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('N', cx, cy - innerR + 6);

  if (!currentSun) return;

  if (currentSun.alt > 0) {
    const sunAngle = (currentSun.az - 90) * RAD;
    const sr = outerR - 3;
    const sx = cx + sr * Math.cos(sunAngle), sy = cy + sr * Math.sin(sunAngle);
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(sx, sy);
    c.strokeStyle = 'rgba(255,184,0,0.25)'; c.lineWidth = 1; c.stroke();
    const glow = c.createRadialGradient(sx, sy, 0, sx, sy, 9);
    glow.addColorStop(0, 'rgba(255,184,0,0.55)'); glow.addColorStop(1, 'rgba(255,184,0,0)');
    c.beginPath(); c.arc(sx, sy, 9, 0, Math.PI * 2); c.fillStyle = glow; c.fill();
    c.beginPath(); c.arc(sx, sy, 3.5, 0, Math.PI * 2); c.fillStyle = '#FFB800'; c.fill();
  } else {
    c.font = '13px serif';
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('☽', cx, cy + 1);
  }
}

// ── Building editor overlay ───────────────────────────────────────────────────
function drawBuildingEditor() {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;

  ctx.fillStyle = 'rgba(10,14,28,0.58)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!v.buildingGeometry || !v.wallNormals) {
    const pt = map.project([v.lng, v.lat]);
    ctx.strokeStyle = 'rgba(255,184,0,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.moveTo(pt.x - 20, pt.y); ctx.lineTo(pt.x + 20, pt.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pt.x, pt.y - 20); ctx.lineTo(pt.x, pt.y + 20); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const nodes = v.buildingGeometry, walls = v.wallNormals;

  // Building polygon
  ctx.beginPath();
  nodes.forEach((n, i) => {
    const pt = map.project([n.lon, n.lat]);
    i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(24,88,180,0.45)'; ctx.fill();

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
    ctx.strokeStyle = isHovered ? '#FFB800' : isCurrent ? '#FFD060' : 'rgba(120,180,255,0.75)';
    ctx.lineWidth   = isHovered ? 6 : isCurrent ? 4 : 2.5;
    ctx.stroke();

    if (isHovered || isCurrent) {
      [pa, pb].forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, isHovered ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isHovered ? '#FFB800' : '#FFD060'; ctx.fill();
        ctx.strokeStyle = 'rgba(10,14,28,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
      });
    }

    if (isHovered) {
      const arrowLen = 55, ex = mx + normX * arrowLen, ey = my + normY * arrowLen;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
      ctx.strokeStyle = '#FFB800'; ctx.lineWidth = 2.5; ctx.setLineDash([]); ctx.stroke();
      const hl = 11, pA = Math.atan2(normY, normX);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - hl * Math.cos(pA - 0.4), ey - hl * Math.sin(pA - 0.4));
      ctx.lineTo(ex - hl * Math.cos(pA + 0.4), ey - hl * Math.sin(pA + 0.4));
      ctx.closePath(); ctx.fillStyle = '#FFB800'; ctx.fill();

      const labelText = `${Math.round(wall.bearing)}°  ${bearingToCardinal(wall.bearing)}`;
      ctx.font = 'bold 12px "DM Sans", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(labelText).width;
      const lx = ex + normX * 18, ly = ey + normY * 18;
      ctx.fillStyle = 'rgba(10,14,28,0.88)';
      fillRoundRect(ctx, lx - tw / 2 - 8, ly - 12, tw + 16, 24, 6);
      ctx.fillStyle = '#FFB800'; ctx.fillText(labelText, lx, ly);
    }

    if (isCurrent && !isHovered) {
      const arrowLen = 32, ex = mx + normX * arrowLen, ey = my + normY * arrowLen;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
      ctx.strokeStyle = '#FFD060'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke();
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
      ctx.font = 'bold 10px "DM Sans", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lx = hx + normX * 20, ly = hy + normY * 20;
      ctx.fillStyle = 'rgba(10,14,28,0.88)';
      fillRoundRect(ctx, lx - 15, ly - 10, 30, 20, 5);
      ctx.fillStyle = '#64ffb4';
      ctx.fillText(`${Math.round(depth)}m`, lx, ly);
    });
  }
}

// ── Convex hull (Andrew's monotone chain) ─────────────────────────────────────
function convexHull(pts) {
  pts = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// ── Seating area shapes ────────────────────────────────────────────────────────
const TERRACE_DEPTH_M = 7;  // metres outward from the terrace wall

/** 2-D line intersection (pixel space). Point p + t*dir. Returns {x,y} or null if parallel. */
function lineIntersectPx(p1x, p1y, d1x, d1y, p2x, p2y, d2x, d2y) {
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((p2x - p1x) * d2y - (p2y - p1y) * d2x) / denom;
  return { x: p1x + t * d1x, y: p1y + t * d1y };
}

/**
 * Build mitered terrace polygon(s) for a set of walls.
 *
 * Groups walls into connected chains (endpoints within 4 px). For each chain:
 * - Single wall → rectangle (4 pts)
 * - Multiple connected walls → proper mitered polygon: the inner edge follows
 *   the wall line, the outer edge is offset by depthPx with miter joints at
 *   every corner, eliminating gaps/overlaps between angled wall segments.
 *
 * Returns an array of pixel-space polygon vertex arrays (one per chain).
 */
function terracePolygons(v, walls, depthPx) {
  if (!walls.length) return [];

  const enriched = walls.map(wall => {
    const pa = map.project([wall.aLng, wall.aLat]);
    const pb = map.project([wall.bLng, wall.bLat]);
    const { normX, normY } = wallOutwardNormal(v, wall);
    return { wall, pa, pb, normX, normY };
  });

  // Group into connected chains by pixel-space vertex proximity
  const THRESH = 4; // px
  const used   = new Array(enriched.length).fill(false);
  const chains = [];

  for (let start = 0; start < enriched.length; start++) {
    if (used[start]) continue;
    const chain = [enriched[start]];
    used[start] = true;

    for (let pass = 0; pass < 2; pass++) {  // 0 = extend tail, 1 = extend head
      let grew = true;
      while (grew) {
        grew = false;
        const anchor = pass === 0 ? chain[chain.length - 1] : chain[0];
        const anchorPt = pass === 0 ? anchor.pb : anchor.pa;
        for (let i = 0; i < enriched.length; i++) {
          if (used[i]) continue;
          const d = enriched[i];
          let item = null;
          if (Math.hypot(d.pa.x - anchorPt.x, d.pa.y - anchorPt.y) < THRESH) {
            item = d;
          } else if (Math.hypot(d.pb.x - anchorPt.x, d.pb.y - anchorPt.y) < THRESH) {
            item = { ...d, pa: d.pb, pb: d.pa };  // reversed orientation
          }
          if (item) {
            pass === 0 ? chain.push(item) : chain.unshift(item);
            used[i] = true; grew = true; break;
          }
        }
      }
    }
    chains.push(chain);
  }

  // Build mitered polygon for each chain
  return chains.map(chain => {
    const inner = [];
    const outer = [];

    chain.forEach((item, i) => {
      const { pa, pb, normX, normY } = item;
      const oA = { x: pa.x + normX * depthPx, y: pa.y + normY * depthPx };
      const oB = { x: pb.x + normX * depthPx, y: pb.y + normY * depthPx };

      if (i === 0) inner.push(pa);
      inner.push(pb);

      if (i === 0) outer.push(oA);

      if (i < chain.length - 1) {
        const nx = chain[i + 1];
        const noA = { x: nx.pa.x + nx.normX * depthPx, y: nx.pa.y + nx.normY * depthPx };
        const miter = lineIntersectPx(
          oB.x, oB.y, pb.x - pa.x, pb.y - pa.y,
          noA.x, noA.y, nx.pb.x - nx.pa.x, nx.pb.y - nx.pa.y,
        );
        outer.push(miter ?? oB);  // fallback for parallel walls
      } else {
        outer.push(oB);
      }
    });

    return [...inner, ...outer.reverse()];
  });
}

/**
 * Given a bearing (compass degrees) and distance in metres, return the lat/lng
 * delta to add to a reference point.
 */
function meterOffsetDeg(lat, bearingDeg, meters) {
  const br = bearingDeg * RAD;
  return {
    dLat: Math.cos(br) * meters / 111320,
    dLng: Math.sin(br) * meters / (111320 * Math.cos(lat * RAD)),
  };
}

/**
 * Draw terrace footprints for all visible venues at zoom >= 14.
 * - Venues with wallSegment: a rectangle (wall edge + TERRACE_DEPTH_M outward).
 * - Venues without: a fan sector centred on the facing direction.
 * Warm tint = in sun, cool tint = in shade.
 */
function drawSeatingAreas() {
  if (!currentSun) return;
  const zoom = map.getZoom();
  if (zoom < 14) return;
  const bounds = map.getBounds();
  const { az, alt } = currentSun;

  ctx.save();

  VENUES.forEach(v => {
    if (!bounds.contains([v.lng, v.lat])) return;
    if (!shouldShowAtZoom(v, zoom)) return;

    const sunny = venueSunState(v, az, alt);
    const fillSunny   = 'rgba(255,184,0,0.20)';
    const strokeSunny = 'rgba(255,184,0,0.65)';
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
    glow.addColorStop(0, sunny ? 'rgba(255,184,0,0.5)' : 'rgba(100,130,210,0.45)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = glow; ctx.fill();

    ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = sunny ? '#FFB800' : '#6080C8'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.restore();
}

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

// ── Main draw ─────────────────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!currentSun) return;

  if (editingVenueId) {
    ctx.globalAlpha = 0.18;
    VENUES.forEach(v => {
      const pt = map.project([v.lng, v.lat]);
      ctx.drawImage(getSprite(v, venueSunState(v, currentSun.az, currentSun.alt), false), pt.x - SPRITE/2, pt.y - SPRITE/2);
    });
    ctx.globalAlpha = 1;
    drawBuildingEditor();
    return;
  }

  const bounds = map.getBounds();
  const zoom   = map.getZoom();
  let hiddenCount = 0;

  // Terrace footprints (drawn first, below shadow overlay and sprites)
  drawSeatingAreas();

  // Shadow overlay for selected venue (drawn before sprites so pins sit on top)
  if (selectedId) {
    const sel = VENUES.find(v => v.id === selectedId);
    if (sel) drawShadowOverlay(sel);
  }

  // Pass 1: sprites — viewport-culled + zoom-density filtered
  VENUES.forEach(v => {
    if (!bounds.contains([v.lng, v.lat])) return;
    if (!shouldShowAtZoom(v, zoom)) { hiddenCount++; return; }
    const sunny    = venueSunState(v, currentSun.az, currentSun.alt);
    const selected = v.id === selectedId;
    const pt       = map.project([v.lng, v.lat]);
    ctx.drawImage(getSprite(v, sunny, selected), pt.x - SPRITE/2, pt.y - SPRITE/2);
  });

  // Hint when venues are hidden due to zoom density
  if (hiddenCount > 0) {
    const text = `Zoom in to see ${hiddenCount} more venue${hiddenCount > 1 ? 's' : ''}`;
    ctx.font = '11px "DM Sans", sans-serif';
    const tw = ctx.measureText(text).width;
    const pw = tw + 16, ph = 22, px = (canvas.width - pw) / 2, py = canvas.height - 36;
    ctx.fillStyle = 'rgba(16,22,38,0.82)';
    fillRoundRect(ctx, px, py, pw, ph, 11);
    ctx.fillStyle = 'rgba(240,230,211,0.7)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, py + ph / 2);
  }

  // Pass 2: time labels (zoom ≥ 13, culled + density-filtered to match Pass 1)
  if (zoom >= 13) {
    const dateStr = datePicker.value;
    const hour    = parseFloat(timeFromEl.value);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    VENUES.forEach(v => {
      if (!bounds.contains([v.lng, v.lat])) return;
      if (!shouldShowAtZoom(v, zoom)) return;
      const { windows } = computeSunWindows(v, dateStr);
      const lpt = map.project([v.lng, v.lat]);

      let label = null, bgColor, textColor;
      const curWin = windows.find(w => hour >= w.start && hour < w.end);
      if (curWin) {
        const rem = curWin.end - hour;
        const h = Math.floor(rem), m = Math.round((rem - h) * 60);
        label = h > 0 ? `${h}h${m > 0 ? ' '+m+'m' : ''}` : `${m}m`;
        bgColor = 'rgba(232,160,0,0.92)'; textColor = '#1a1a2e';
      } else {
        const next = windows.find(w => w.start > hour);
        if (next) { label = formatHour(next.start); bgColor = 'rgba(70,120,200,0.85)'; textColor = '#e8f0ff'; }
      }
      if (!label) return;

      ctx.font = 'bold 10px "DM Sans", sans-serif';
      const tw = ctx.measureText(label).width;
      const pw = tw + 10, ph = 14;
      const lx = lpt.x, ly = lpt.y + SPRITE / 2 + 8;
      ctx.fillStyle = bgColor;
      fillRoundRect(ctx, lx - pw/2, ly - ph/2, pw, ph, 4);
      ctx.fillStyle = textColor;
      ctx.fillText(label, lx, ly);
    });
  }
}

// ── Hit testing ───────────────────────────────────────────────────────────────
function hitTestVenue(cx, cy) {
  let hit = null;
  VENUES.forEach(v => {
    const pt = map.project([v.lng, v.lat]);
    if (Math.hypot(cx - pt.x, cy - pt.y) <= 20) hit = v;
  });
  return hit;
}

function hitTestDepthHandle(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return null;
  const walls  = getTerraceWalls(v);
  const depth  = getEffectiveDepth(v);
  const pxPerM = pxPerMetre(v);
  for (const wall of walls) {
    const { normX, normY, mx, my } = wallOutwardNormal(v, wall);
    const hx = mx + normX * depth * pxPerM;
    const hy = my + normY * depth * pxPerM;
    if (Math.hypot(cx - hx, cy - hy) <= 14) return wall;
  }
  return null;
}

function hitTestWall(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v?.wallNormals) return null;
  let bestIdx = null, bestDistSq = 100;
  v.wallNormals.forEach((wall, idx) => {
    const pa = map.project([wall.aLng, wall.aLat]);
    const pb = map.project([wall.bLng, wall.bLat]);
    const dSq = distPointToSegmentSq(cx, cy, pa.x, pa.y, pb.x, pb.y);
    if (dSq < bestDistSq) { bestDistSq = dSq; bestIdx = idx; }
  });
  return bestIdx;
}

// ── Canvas event handling ─────────────────────────────────────────────────────
canvas.style.pointerEvents = 'auto';

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    // Depth handle drag takes priority — don't forward to map
    const handle = hitTestDepthHandle(cx, cy);
    if (handle) {
      editDraggingDepth = true;
      editDragWallObj   = handle;
      canvas.style.cursor = 'row-resize';
      return;
    }
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new MouseEvent('mousedown', e));
    return;
  }
  const hit = hitTestVenue(cx, cy);
  if (!hit) {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new MouseEvent('mousedown', e));
  }
});

canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    const wallIdx = hitTestWall(cx, cy);
    if (wallIdx !== null) selectWallByIdx(wallIdx);
    return;
  }
  const hit = hitTestVenue(cx, cy);
  if (hit) {
    selectVenue(hit.id, true);
  } else {
    // Clicked empty map — close popup (close handler resets pitch/bearing/selectedId)
    if (popup) {
      popup.remove();
    } else if (selectedId !== null) {
      selectedId = null;
      clearSpriteCache();
      map.easeTo({ pitch: 15, bearing: 0, duration: 600 });
      draw();
      renderList();
    }
  }
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;

  if (editingVenueId) {
    tooltip.classList.remove('visible');

    // Depth drag in progress
    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
        const walls = getTerraceWalls(v);
        const wallsLabel = walls.length > 1 ? ` · ${walls.length} walls` : '';
        document.getElementById('edit-facing-display').innerHTML =
          `${v.facing}° ${bearingToCardinal(v.facing)}${wallsLabel} · <span style="color:#64ffb4">${Math.round(getEffectiveDepth(v))}m depth</span>`;
      }
      return;
    }

    const handle = hitTestDepthHandle(cx, cy);
    if (handle) { canvas.style.cursor = 'row-resize'; return; }

    const wallIdx = hitTestWall(cx, cy);
    canvas.style.cursor = wallIdx !== null ? 'pointer' : 'default';
    if (wallIdx !== editHoveredWallIdx) {
      editHoveredWallIdx = wallIdx;
      draw();
      const v  = VENUES.find(x => x.id === editingVenueId);
      const el = document.getElementById('edit-facing-display');
      if (wallIdx !== null && v?.wallNormals) {
        const wall = v.wallNormals[wallIdx];
        const sel  = v.terraceWallIndices?.includes(wallIdx) ? ' ✓' : '';
        el.innerHTML = `<span class="preview">${Math.round(wall.bearing)}° ${bearingToCardinal(wall.bearing)}${sel}</span>`;
      } else if (v) {
        const walls = getTerraceWalls(v);
        const wallsLabel = walls.length > 1 ? ` · ${walls.length} walls` : '';
        el.innerHTML = `${v.facing}° ${bearingToCardinal(v.facing)}${wallsLabel}`;
      }
    }
    return;
  }

  const hit = hitTestVenue(cx, cy);
  if (hit) {
    canvas.style.cursor = 'pointer';
    hoveredId = hit.id;
    tooltip.innerHTML = buildTooltipContent(hit);
    const margin = 14;
    let tx = e.clientX + margin, ty = e.clientY - tooltip.offsetHeight - margin;
    if (tx + tooltip.offsetWidth > window.innerWidth - 370) tx = e.clientX - tooltip.offsetWidth - margin;
    if (ty < 8) ty = e.clientY + margin;
    tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    tooltip.classList.add('visible');
  } else {
    hoveredId = null;
    canvas.style.cursor = 'default';
    tooltip.classList.remove('visible');
  }
});

canvas.addEventListener('mouseleave', () => {
  hoveredId = null;
  tooltip.classList.remove('visible');
  if (!editDraggingDepth) canvas.style.cursor = 'default';
});

window.addEventListener('mouseup', () => {
  if (editDraggingDepth) {
    editDraggingDepth = false;
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth);
    editDragWallObj = null;
    canvas.style.cursor = 'default';
  }
});

['wheel', 'touchstart', 'touchmove', 'touchend'].forEach(type => {
  canvas.addEventListener(type, e => {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX || e.touches?.[0]?.clientX, e.clientY || e.touches?.[0]?.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new (e.constructor)(type, e));
  }, { passive: true });
});
