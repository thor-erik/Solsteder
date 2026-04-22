/**
 * render-helpers.js — Shared geometry and drawing utilities for canvas rendering.
 * No side effects: only function/constant declarations.
 * Loaded before all other render-*.js files.
 */

// ── Short venue name helper ───────────────────────────────────────────────────
// Strip trailing category/location words but preserve numbers (e.g. "Skur 33").
const _STRIP_CATEGORY = new Set([
  'restaurant', 'bistrobar', 'bistro', 'gastropub', 'pub', 'bar',
  'café', 'cafe', 'brasserie', 'grill', 'kitchen', 'mat', 'spiseri', 'kro',
]);
const _STRIP_AREA = new Set([
  'oslo', 'frogner', 'tjuvholmen', 'sentrum', 'bislett',
  'grünerløkka', 'majorstuen', 'grønland', 'tøyen', 'løkka',
  'aker brygge', 'st. hanshaugen',
]);

function shortName(name, maxLen = 14) {
  const words = name.trim().split(/\s+/);
  let end = words.length;
  while (end > 1) {
    const last  = words[end - 1].toLowerCase();
    if (/^\d/.test(last)) break;                               // never strip numbers
    if (_STRIP_CATEGORY.has(last)) { end--; continue; }
    if (_STRIP_AREA.has(last))     { end--; continue; }
    if (end > 1) {                                             // two-word area phrase
      const two = (words[end - 2] + ' ' + last).toLowerCase();
      if (_STRIP_AREA.has(two)) { end -= 2; continue; }
    }
    break;
  }
  const result = words.slice(0, end).join(' ');
  return result.length > maxLen ? result.slice(0, maxLen - 1) + '…' : result;
}

// ── Clock time formatter ──────────────────────────────────────────────────────
// Converts an hour-as-float (e.g. 15.75) to a clock string ("15:45").
// Does NOT round to 5/15-minute intervals — showing 15:47 is more honest than 15:45.
// (Sprite cache buckets to 5 min separately, so rendering cost stays bounded.)
function formatHourAsClock(hourFloat) {
  const h = Math.floor(hourFloat);
  const m = Math.round((hourFloat - h) * 60);
  if (m === 60) return `${String(h + 1).padStart(2, '0')}:00`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

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
const TERRACE_DEPTH_M = 5;  // metres outward from the terrace wall

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
 * Groups walls into connected chains (endpoints within 10 px after projection).
 * For each chain:
 * - Single wall → rectangle
 * - Connected chain → mitered polygon with convex corners; bevel join for
 *   concave corners (where the miter would go inside the building) and for
 *   extreme angles (miter > 4× depth away from the junction vertex).
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

  // Group into connected chains — 10 px threshold handles projection rounding
  const THRESH = 10;
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
        const anchor   = pass === 0 ? chain[chain.length - 1] : chain[0];
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

  // Build polygon for each chain
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
        const nx  = chain[i + 1];
        const noA = { x: nx.pa.x + nx.normX * depthPx, y: nx.pa.y + nx.normY * depthPx };
        const miter = lineIntersectPx(
          oB.x, oB.y, pb.x - pa.x, pb.y - pa.y,
          noA.x, noA.y, nx.pb.x - nx.pa.x, nx.pb.y - nx.pa.y,
        );

        let useMiter = false;
        if (miter) {
          // Only use the miter if it's on the outward side of the junction vertex
          // (both normals agree) — this rejects concave corners where the miter
          // would fall inside the building.
          const dx = miter.x - pb.x, dy = miter.y - pb.y;
          const outward1 = dx * normX        + dy * normY;
          const outward2 = dx * nx.normX     + dy * nx.normY;
          const dist     = Math.hypot(dx, dy);
          useMiter = outward1 >= 0 && outward2 >= 0 && dist <= depthPx * 4;
        }

        if (useMiter) {
          outer.push(miter);
        } else {
          // Bevel join: emit both outer endpoints at the corner
          outer.push(oB);
          outer.push(noA);
        }
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
