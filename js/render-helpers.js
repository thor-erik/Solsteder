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

// ── Venue name split for the 3-row list card ──────────────────────────────────
// Returns { name, fine, coarse } — row-1 name + row-2 location.
//   coarse = v.area (the reliable, complete coarse-area assignment).
//   fine   = a fine neighborhood the venue names itself with (Tveita, Bjørvika,
//            Solli…) when present and finer than the coarse area, else ''.
//   row 2 renders "fine · coarse" (fine prominent, coarse muted) when a fine
//   neighborhood exists, else just the coarse area. We show BOTH rather than
//   choosing — no toes stepped, and it can't mislabel.
//   name = the venue name with location noise that duplicates the location
//          stripped: a chain branch ("… avd|avdeling|dept Skovveien"), a " - X"
//          dash tail ("Castello Restaurant - Oslo"), and a trailing echo of the
//          fine neighborhood or coarse area ("Sushi Tveita" → "Sushi").
// Only avd/avdeling/dept split — NOT "på"/"i", which live inside real names
// ("Anne på landet", "Jubel på Adamstuen").
const _DEPT_RX = /\s+(?:avd|avdeling|dept)\.?\s+.+$/i;

// Fine Oslo neighborhoods that appear in venue names but aren't coarse areas.
// Confirmed from the area-mismatch report (scripts/area-mismatch-report.mjs),
// excluding the island/square/park sub-spots (Hovedøya/Rådhusplassen/
// Frognerparken). Longest-first so multi-word hits ("Carl Berners plass") win.
const FINE_NEIGHBORHOODS = [
  'Carl Berners plass', 'Bjørvika', 'Sørenga', 'Manglerud', 'Fredensborg',
  'Ullevål', 'Bjølsen', 'Frysja', 'Holtet', 'Tveita', 'Storo', 'Løren',
  'Hasle', 'Solli', 'Vika',
].sort((a, b) => b.length - a.length);

function _fineNeighborhood(name) {
  const hay = ' ' + name.toLowerCase().replace(/[-–,]/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const g of FINE_NEIGHBORHOODS) {
    const esc = g.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^| )' + esc + '( |$)').test(hay)) return g;
  }
  return '';
}

// Cuisine/category descriptors — NOT a venue's identity on their own. If
// stripping the neighborhood would leave only these, the neighborhood is part
// of the real name ("Sushi Tveita", "VIN Bjørvika") and must be kept.
const _GENERIC_WORDS = new Set([
  'sushi', 'pizza', 'pizzeria', 'burger', 'burgers', 'ramen', 'kebab', 'kebabhus',
  'grill', 'bbq', 'bar', 'pub', 'cafe', 'café', 'kafé', 'kaffe', 'kaffebar',
  'restaurant', 'brasserie', 'bistro', 'tapas', 'thai', 'indian', 'kitchen',
  'mat', 'mathall', 'deli', 'bakeri', 'bakery', 'wok', 'noodles', 'curry',
  'taco', 'tacos', 'vin', 'vinbar', 'vinhus', 'gastropub', 'steakhouse',
  'sushibar', 'espressobar', 'chicken', 'sports', 'sport',
]);
const _CONNECTOR_WORDS = new Set(['og', 'the', 'av', 'på', 'i', '&', '-', 'di', 'de', 'la', 'le']);

function _isGenericName(s) {
  const words = s.toLowerCase().split(/[\s\-–,&]+/)
    .map(w => w.replace(/[.()'`’]/g, '')).filter(Boolean)
    .filter(w => !_CONNECTOR_WORDS.has(w));
  if (!words.length) return true;
  return words.every(w => _GENERIC_WORDS.has(w));
}

function splitVenueName(v) {
  const full = ((v && v.name) || '').trim();
  const coarse = ((v && v.area) || '').trim();
  // Fine neighborhood: prefer the coordinate-derived `areaFine` (OSM suburb
  // tier, with the venue's self-name winning on conflict — see
  // scripts/assign-fine-areas.mjs), fall back to the name for venues the
  // pipeline didn't cover. `areaFine` is only set when it differs from `area`.
  const coordFine = ((v && v.areaFine) || '').trim();
  const nameFine = _fineNeighborhood(full);
  const fine = coordFine || nameFine;
  let name = full.replace(_DEPT_RX, '').trim();          // drop chain branch
  name = name.replace(/\s+[-–]\s+.+$/, '').trim();        // drop " - tail"
  // Drop a trailing echo of the neighborhood / coarse area (optionally followed
  // by "plass"/"brygge": "Frenchie Solli Plass" → "Frenchie") — but ONLY if what
  // remains is a real name, not a bare cuisine word. "Sushi Tveita" stays
  // "Sushi Tveita"; "Døgnvill Burger Bjørvika" → "Døgnvill Burger".
  for (const loc of [coordFine, nameFine, coarse]) {
    if (!loc) continue;
    const esc = loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = name.replace(new RegExp('\\s+' + esc + '(\\s+(?:plass|brygge))?$', 'i'), '').trim();
    if (stripped && stripped !== name && !_isGenericName(stripped)) name = stripped;
  }
  if (!name) name = full;                                  // never blank the name
  // Suppress the fine neighborhood from row 2 when it's still in the row-1 name
  // (the name owns it) — avoids showing e.g. "Tveita" twice.
  const nameTokens = ' ' + name.toLowerCase().replace(/[-–,]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const fineEsc = fine.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fineInName = fine && new RegExp('(^| )' + fineEsc + '( |$)').test(nameTokens);
  const showFine = fine && !fineInName && fine.toLowerCase() !== coarse.toLowerCase();
  return { name, fine: showFine ? fine : '', coarse };
}

// ── Shade glyph (brand mark: solid left semicircle + diagonal-striped right) ──
// Shared by the list card (row-3 disruption) and the accept-page timeline
// (TIMELINE_EVENT_GLYPHS.shade). Generated per call with a UNIQUE clipPath id
// so injecting it into many cards never collides on a duplicate DOM id.
let _shadeGlyphN = 0;
function shadeGlyph(size = 14) {
  const id = 'shclip' + (_shadeGlyphN++);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="M12 2 A10 10 0 0 1 12 22 Z"/></clipPath></defs>
    <path d="M12 2 A10 10 0 0 0 12 22 Z"/>
    <g clip-path="url(#${id})">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <g stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none">
        <line x1="2" y1="20" x2="20" y2="2"/>
        <line x1="6" y1="22" x2="22" y2="6"/>
        <line x1="10" y1="24" x2="24" y2="10"/>
        <line x1="14" y1="24" x2="24" y2="14"/>
        <line x1="18" y1="24" x2="24" y2="18"/>
      </g>
    </g>
  </svg>`;
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

/**
 * Merge multiple lat/lng polygons into one. Returns a single [lat,lng] vertex
 * array tracing the convex hull of the input vertices. Convex hull is a
 * coarse but reliable union — good enough for the common case of two terrace
 * polygons on adjacent sides of the same building. For complex L-shapes,
 * users can refine the result with corner / edge handles.
 *
 * Input:  array of lat/lng polygons, e.g. [ [[lat,lng],...], [[lat,lng],...] ]
 * Output: single [lat,lng] polygon, or null if input is empty.
 */
function unionPolygons(polysLatLng) {
  if (!Array.isArray(polysLatLng) || polysLatLng.length === 0) return null;
  if (polysLatLng.length === 1) return polysLatLng[0];
  const all = [];
  polysLatLng.forEach(poly => {
    if (Array.isArray(poly)) poly.forEach(pt => all.push(pt));
  });
  if (all.length < 3) return null;
  // convexHull works on {x,y} — map lng→x, lat→y so the result reads naturally.
  const pts = all.map(([lat, lng]) => ({ x: lng, y: lat }));
  const hull = convexHull(pts);
  return hull.map(({ x, y }) => [y, x]);
}

// ── Polygon ↔ building overlap detection ─────────────────────────────────────
// Used by the editor to reject moves that would push a street / detached
// terrace into a building footprint. Operates in lat/lng directly — at the
// scale of a single building (a few dozen metres) the planar approximation is
// fine.

/** Ray-cast point-in-polygon test. point = [lat, lng], poly = [[lat, lng], ...] */
function _llPointInPolygon([lat, lng], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Strict segment intersection (no shared endpoints). Returns true if AB ∩ CD
 *  meet strictly inside both segments. */
function _llSegmentsIntersect([y1, x1], [y2, x2], [y3, x3], [y4, x4]) {
  const denom = (x4 - x3) * (y2 - y1) - (y4 - y3) * (x2 - x1);
  if (Math.abs(denom) < 1e-12) return false;
  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  return ua > 1e-9 && ua < 1 - 1e-9 && ub > 1e-9 && ub < 1 - 1e-9;
}

/**
 * Returns true if the candidate polygon overlaps the building footprint.
 * Detects:
 *   - any polygon vertex inside the building,
 *   - any building vertex inside the polygon,
 *   - any polygon edge crossing any building edge.
 *
 * polyLatLng:   [[lat, lng], ...]
 * buildingNodes: [{lat, lon}, ...] (the OSM-style node list on v.buildingGeometry)
 */
function polygonOverlapsBuilding(polyLatLng, buildingNodes) {
  if (!Array.isArray(polyLatLng)   || polyLatLng.length   < 3) return false;
  if (!Array.isArray(buildingNodes) || buildingNodes.length < 3) return false;

  const bldg = buildingNodes.map(n => [n.lat, n.lon ?? n.lng]);

  for (const p of polyLatLng) if (_llPointInPolygon(p, bldg))    return true;
  for (const p of bldg)        if (_llPointInPolygon(p, polyLatLng)) return true;

  for (let i = 0; i < polyLatLng.length; i++) {
    const a = polyLatLng[i];
    const b = polyLatLng[(i + 1) % polyLatLng.length];
    for (let j = 0; j < bldg.length; j++) {
      const c = bldg[j];
      const d = bldg[(j + 1) % bldg.length];
      if (_llSegmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
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

// ── Outdoor-seating polygon helpers ───────────────────────────────────────────

/** Project a [[lat,lng], ...] polygon to pixel-space {x,y} vertices. */
function projectSeatingPolygon(latLngPoly) {
  return latLngPoly.map(([lat, lng]) => {
    const p = map.project([lng, lat]);
    return { x: p.x, y: p.y };
  });
}

/** Centroid of a [[lat,lng], ...] polygon. */
function seatingPolygonCentroid(latLngPoly) {
  const n = latLngPoly.length;
  if (!n) return null;
  let sLat = 0, sLng = 0;
  for (const [lat, lng] of latLngPoly) { sLat += lat; sLng += lng; }
  return { lat: sLat / n, lng: sLng / n };
}

/**
 * Generate ~9 sun-shadow test points distributed across the polygon: the
 * centroid plus a 3×3 grid clipped to vertices that fall inside the polygon.
 * Used by venueSunState (solar.js) when an AI/manual polygon is available
 * instead of the wall-projection grid in osm.js.
 */
function seatingPolygonTestPoints(latLngPoly) {
  if (!Array.isArray(latLngPoly) || latLngPoly.length < 3) return [];
  let minLat =  Infinity, maxLat = -Infinity, minLng =  Infinity, maxLng = -Infinity;
  for (const [lat, lng] of latLngPoly) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  // pointInPolygon expects [{lat,lon}, ...] — adapt our [lat,lng] tuples.
  const polyNodes = latLngPoly.map(([lat, lng]) => ({ lat, lon: lng }));
  const pts = [];
  for (let i = 1; i <= 3; i++) {
    for (let j = 1; j <= 3; j++) {
      const lat = minLat + (maxLat - minLat) * (i / 4);
      const lng = minLng + (maxLng - minLng) * (j / 4);
      if (typeof pointInPolygon === 'function' && pointInPolygon(lat, lng, polyNodes)) {
        pts.push({ lat, lng });
      }
    }
  }
  if (!pts.length) {
    const c = seatingPolygonCentroid(latLngPoly);
    if (c) pts.push({ lat: c.lat, lng: c.lng });
  }
  return pts;
}
