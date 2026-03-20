/**
 * osm.js — OSM building geometry fetching and terrace-facing heuristic.
 * Depends on: solar.js (RAD), data.js (VENUES), app.js (clearSpriteCache, sunWindowCache).
 * Called once at init via initFacings().
 */

// ── Overpass config ───────────────────────────────────────────────────────────

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
const OSM_CACHE_KEY = 'solsteder_osm_v2';
const OSM_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Network ───────────────────────────────────────────────────────────────────

async function postOverpass(endpoint, query) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchAllGeometry() {
  const lats = VENUES.map(v => v.lat), lngs = VENUES.map(v => v.lng);
  const s = (Math.min(...lats) - 0.003).toFixed(6);
  const n = (Math.max(...lats) + 0.003).toFixed(6);
  const w = (Math.min(...lngs) - 0.004).toFixed(6);
  const e = (Math.max(...lngs) + 0.004).toFixed(6);
  const bbox = `${s},${w},${n},${e}`;

  // localStorage cache
  try {
    const raw = localStorage.getItem(OSM_CACHE_KEY);
    if (raw) {
      const { ts, bboxKey, elements } = JSON.parse(raw);
      if (bboxKey === bbox && Date.now() - ts < OSM_CACHE_TTL) {
        console.log('OSM: using cached data');
        return { elements };
      }
    }
  } catch (_) {}

  const query = `[out:json][timeout:60];
(
  way["building"](${bbox});
  node["entrance"](${bbox});
  way["highway"~"primary|secondary|tertiary|residential|service|footway|pedestrian|living_street|unclassified"](${bbox});
  way["natural"~"water|coastline"](${bbox});
  way["leisure"~"park|garden"](${bbox});
  way["landuse"~"grass|meadow|recreation_ground|cemetery"](${bbox});
  way["place"~"square"](${bbox});
);
out geom;`;

  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`OSM: trying ${endpoint}`);
      const data = await postOverpass(endpoint, query);
      try {
        localStorage.setItem(OSM_CACHE_KEY, JSON.stringify({
          ts: Date.now(), bboxKey: bbox, elements: data.elements
        }));
      } catch (_) {}
      return data;
    } catch (err) {
      console.warn(`OSM: ${endpoint} failed —`, err.message);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────
// pointInPolygon lives in solar.js (shared with worker). Available here via global scope.

function computeCentroid(nodes) {
  return {
    lat: nodes.reduce((s, n) => s + n.lat, 0) / nodes.length,
    lon: nodes.reduce((s, n) => s + n.lon, 0) / nodes.length,
  };
}

function distPointToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx-ax, dy = by-ay, lenSq = dx*dx+dy*dy;
  if (lenSq === 0) return (px-ax)**2+(py-ay)**2;
  const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/lenSq));
  return (px-(ax+t*dx))**2+(py-(ay+t*dy))**2;
}

/** Returns outward-facing wall normals as bearing + metadata for each wall segment. */
function getWallNormals(nodes) {
  const c = computeCentroid(nodes);
  const walls = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const mx = (a.lon+b.lon)/2, my = (a.lat+b.lat)/2;
    const cosLat = Math.cos(my * RAD);
    // Scale lon by cosLat so the perpendicular is computed in metric space
    const dx = (b.lon - a.lon) * cosLat, dy = b.lat - a.lat;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1e-9) continue;
    const p1x = -dy/len, p1y = dx/len;
    const dot = p1x*(mx-c.lon)*cosLat + p1y*(my-c.lat);
    const ox = dot > 0 ? p1x : -p1x;
    const oy = dot > 0 ? p1y : -p1y;
    const bearing = (Math.atan2(ox, oy)*180/Math.PI+360)%360;
    const lenM = Math.sqrt((b.lon-a.lon)**2*cosLat**2 + (b.lat-a.lat)**2) * 111320;
    walls.push({ bearing, lenM, mx, my, aLat:a.lat, aLng:a.lon, bLat:b.lat, bLng:b.lon });
  }
  return walls;
}

/** Project a point `distM` metres outward from a wall's midpoint along its normal. */
function probePoint(wall, distM) {
  const br = wall.bearing * RAD;
  return {
    lat: wall.my + Math.cos(br)*distM/111320,
    lng: wall.mx + Math.sin(br)*distM/(111320*Math.cos(wall.my*RAD)),
  };
}

/**
 * Find all buildings within radiusM metres of a venue and return them in the
 * slim format needed by the shadow caster: { geometry, height }.
 * 150 m captures shadows at typical Oslo summer sun angles (≥10° altitude).
 */
function findNearbyBuildings(venue, buildings, excludeBuilding = null, radiusM = 150) {
  return buildings
    .filter(b => {
      if (b === excludeBuilding) return false;
      const c = computeCentroid(b.geometry);
      return Math.hypot(c.lat - venue.lat, c.lon - venue.lng) * 111320 <= radiusM;
    })
    .map(b => ({
      geometry: b.geometry,
      height:   extractBuildingHeight(b.tags || {}),
    }));
}

// ── Auto terrace wall selection ────────────────────────────────────────────────

function computeAutoTerraceWallIndices(venue, walls, buildings, venueBuilding, openPolygons, entranceNodes, highways) {
  if (!walls.length) return [0];

  const scores    = walls.map(w => scoreWall(w, buildings, venueBuilding, openPolygons, entranceNodes, highways));
  const bestScore = Math.max(...scores);
  if (bestScore <= 0) return [0];

  const bestIdx  = scores.indexOf(bestScore);
  const bestWall = walls[bestIdx];
  const selected = [bestIdx];

  const eLat = venue.googleLocation?.lat ?? venue.lat;
  const eLng = venue.googleLocation?.lng ?? venue.lng;

  const VERTEX_M = 2 / 111320;
  const CORNER_M = 5 / 111320;

  function sharesVertex(w1, w2) {
    const cl = Math.cos(w1.my * RAD);
    return (
      Math.hypot((w2.aLng - w1.aLng) * cl, w2.aLat - w1.aLat) < VERTEX_M ||
      Math.hypot((w2.aLng - w1.bLng) * cl, w2.aLat - w1.bLat) < VERTEX_M ||
      Math.hypot((w2.bLng - w1.aLng) * cl, w2.bLat - w1.aLat) < VERTEX_M ||
      Math.hypot((w2.bLng - w1.bLng) * cl, w2.bLat - w1.bLat) < VERTEX_M
    );
  }

  function entranceNearSharedCorner(w1, w2) {
    const cl = Math.cos(eLat * RAD);
    const ex = eLng * cl, ey = eLat;
    for (const [lng, lat] of [[w1.aLng, w1.aLat], [w1.bLng, w1.bLat],
                               [w2.aLng, w2.aLat], [w2.bLng, w2.bLat]]) {
      if (Math.hypot(lng * cl - ex, lat - ey) < CORNER_M) return true;
    }
    return false;
  }

  walls.forEach((w2, i2) => {
    if (i2 === bestIdx) return;
    if (scores[i2] < bestScore * 0.20) return;
    if (!sharesVertex(bestWall, w2)) return;
    if (entranceNearSharedCorner(bestWall, w2) || scores[i2] >= bestScore * 0.40) {
      selected.push(i2);
    }
  });

  return selected;
}

// ── Auto terrace depth ────────────────────────────────────────────────────────

function raySegmentIntersect(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((ax - ox) * ey - (ay - oy) * ex) / denom;
  const s = ((ax - ox) * dy - (ay - oy) * dx) / denom;
  if (t > 1e-6 && s >= -0.01 && s <= 1.01) return t;
  return null;
}

/**
 * Raycast outward from three points along the terrace wall and return the
 * nearest highway intersection depth in metres (minus 0.5 m buffer), or
 * null if no highway is found within 20 m.
 */
function computeAutoTerraceDepth(wall, highways) {
  const MAX_DIST_M = 20;
  const br     = wall.bearing * RAD;
  const cosLat = Math.cos(wall.my * RAD);
  const MAX_T  = MAX_DIST_M / 111320;
  const dx = Math.sin(br), dy = Math.cos(br);

  const probeOrigins = [0.25, 0.5, 0.75].map(f => ({
    ox: ((1 - f) * wall.aLng + f * wall.bLng) * cosLat,
    oy:  (1 - f) * wall.aLat + f * wall.bLat,
  }));

  let minT = MAX_T;
  for (const hw of highways) {
    const nodes = hw.geometry || [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const ax = a.lon * cosLat, ay = a.lat;
      const bx = b.lon * cosLat, by = b.lat;
      for (const { ox, oy } of probeOrigins) {
        if (Math.hypot((ax + bx) / 2 - ox, (ay + by) / 2 - oy) > MAX_T * 2) continue;
        const t = raySegmentIntersect(ox, oy, dx, dy, ax, ay, bx, by);
        if (t !== null && t < minT) minT = t;
      }
    }
  }
  return minT < MAX_T ? Math.max(1.5, minT * 111320 - 0.5) : null;
}

/**
 * Score a wall for how likely it is to be the terrace-facing facade.
 * Higher score = more likely to face an open, sunny, street-side space.
 */
function scoreWall(wall, buildings, venueBuilding, openPolygons, entranceNodes, highways) {
  let score = wall.lenM;

  // 1. Adjacent-building penalty: probe at 5 m and 15 m
  for (const dist of [5, 15]) {
    const p = probePoint(wall, dist);
    for (const b of buildings) {
      if (b === venueBuilding || !b.geometry?.length) continue;
      if (pointInPolygon(p.lat, p.lng, b.geometry)) return score * 0.01;
    }
  }

  // 2. Entrance node on this wall → almost certainly the street-facing facade (×10)
  const entrThreshSq = (4/111320)**2;
  for (const node of entranceNodes) {
    if (distPointToSegmentSq(node.lon, node.lat, wall.aLng, wall.aLat, wall.bLng, wall.bLat) < entrThreshSq) {
      score *= 10; break;
    }
  }

  // 3. Street-facing boost: highway node within 15 m of the 20 m probe (×3)
  const p20 = probePoint(wall, 20);
  const streetThreshSq = (15/111320)**2;
  outer: for (const hw of highways) {
    for (const node of (hw.geometry || [])) {
      if ((node.lat-p20.lat)**2+(node.lon-p20.lng)**2 < streetThreshSq) { score *= 3; break outer; }
    }
  }

  // 4. Open-space boost: park / water / plaza 70 m ahead (×4)
  const p70 = probePoint(wall, 70);
  for (const poly of openPolygons) {
    if (pointInPolygon(p70.lat, p70.lng, poly)) { score *= 4; break; }
  }

  return score;
}

// ── Pre-computed geometry (geometry.json) ────────────────────────────────────

/**
 * Try loading data/geometry.json (pre-computed by GitHub Actions).
 * Returns true if all venues were hydrated successfully, false otherwise.
 * 'manual' facingSource in localStorage always takes precedence.
 */
async function tryLoadPrecomputed() {
  try {
    const resp = await fetch('data/geometry.json');
    if (!resp.ok) return false;
    const { venues: precomputed } = await resp.json();
    let applied = 0;
    VENUES.forEach(v => {
      const g = precomputed[v.id];
      if (!g) return;
      v.buildingGeometry  = g.buildingGeometry;
      v.wallNormals       = g.wallNormals;
      v.nearbyBuildings   = g.nearbyBuildings;
      v.wallSegment       = g.wallSegment;
      v.autoTerraceDepth       = g.autoTerraceDepth       ?? null;
      v.autoTerraceWallIndices = g.autoTerraceWallIndices ?? null;
      // Respect manual override from edit tool; otherwise take pre-computed facing
      if (v.facingSource !== 'manual') {
        v.facing       = g.facing;
        v.facingSource = g.facingSource;
        saveFacingCache(v.id, g.facing, g.facingSource);
      } else {
        // Manual facing: find matching wall segment from wallNormals
        v.wallSegment = g.wallNormals.reduce((best, w) =>
          Math.abs(w.bearing - v.facing) < Math.abs(best.bearing - v.facing) ? w : best, g.wallNormals[0]);
      }
      applied++;
    });
    console.log(`OSM: loaded geometry.json (${applied}/${VENUES.length} venues)`);
    return applied === VENUES.length;
  } catch (_) {
    return false;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function initFacings() {
  const statusEl = document.getElementById('facing-status');
  statusEl.textContent = 'Loading building geometry…';

  // Fast path: pre-computed geometry.json served from the repo
  if (await tryLoadPrecomputed()) {
    clearSpriteCache();
    sunWindowCache.clear();
    statusEl.textContent = 'Building geometry loaded';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
    dispatchToWorker(datePicker.value);
    draw();
    renderList();
    return;
  }

  // Slow path: fetch raw geometry from Overpass and compute locally
  statusEl.textContent = 'Fetching building geometry…';
  let elements;
  try {
    const data = await fetchAllGeometry();
    elements = data.elements;
    console.log(`OSM: fetched ${elements.length} elements`);
  } catch (err) {
    console.error('OSM fetch failed:', err);
    statusEl.innerHTML = 'Building data unavailable · <button onclick="initFacings()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;padding:0;text-decoration:underline">Retry</button>';
    return;
  }

  const buildings     = elements.filter(e => e.type==='way' && e.tags?.building && e.geometry?.length>=4);
  const openPolygons  = elements.filter(e => e.type==='way' && !e.tags?.building && e.geometry?.length>=3
    && (e.tags?.natural||e.tags?.leisure||e.tags?.landuse||e.tags?.place)).map(e => e.geometry);
  const entranceNodes = elements.filter(e => e.type==='node' && e.tags?.entrance);
  const highways      = elements.filter(e => e.type==='way' && e.tags?.highway && e.geometry?.length);

  console.log(`OSM: ${buildings.length} buildings | ${openPolygons.length} open areas | ${entranceNodes.length} entrances | ${highways.length} streets`);

  let computed = 0;
  VENUES.forEach(v => {
    // ── Step 1: find building + wall normals (always — needed for edit tool) ──
    let building = buildings.find(b => pointInPolygon(v.lat, v.lng, b.geometry));
    if (!building) {
      building = buildings
        .map(b => ({ b, d: (c => Math.hypot(c.lat-v.lat,c.lon-v.lng))(computeCentroid(b.geometry)) }))
        .filter(x => x.d < 0.001).sort((a,b) => a.d-b.d)[0]?.b ?? null;
    }
    if (!building) { console.warn(`${v.name}: no building found`); return; }

    v.buildingGeometry = building.geometry;

    const walls = getWallNormals(building.geometry);
    if (!walls.length) return;

    v.wallNormals = walls;

    // ── Step 2: nearby buildings for shadow casting (exclude own building) ──────
    v.nearbyBuildings = findNearbyBuildings(v, buildings, building);

    // ── Step 3: score walls (skipped if facing already set) ───────────────────
    // 'manual' = user chose via edit tool → never overwrite.
    // 'osm'    = previously computed and cached → skip redundant re-scoring.
    if (v.facingSource === 'manual' || v.facingSource === 'osm') {
      v.wallSegment = walls.reduce((best, w) =>
        Math.abs(w.bearing - v.facing) < Math.abs(best.bearing - v.facing) ? w : best, walls[0]);
      v.autoTerraceDepth       = computeAutoTerraceDepth(v.wallSegment, highways);
      v.autoTerraceWallIndices = computeAutoTerraceWallIndices(v, walls, buildings, building, openPolygons, entranceNodes, highways);
      return;
    }

    const autoIndices = computeAutoTerraceWallIndices(v, walls, buildings, building, openPolygons, entranceNodes, highways);
    const bestWall = walls[autoIndices[0]];

    v.facing               = Math.round(bestWall.bearing);
    v.wallSegment          = bestWall;
    v.facingSource         = 'osm';
    v.autoTerraceDepth       = computeAutoTerraceDepth(bestWall, highways);
    v.autoTerraceWallIndices = autoIndices;
    saveFacingCache(v.id, v.facing, 'osm');
    computed++;
    console.log(`${v.name}: ${v.facing}° | score ${bestScore.toFixed(0)} | wall ${bestWall.lenM.toFixed(0)} m`);
  });

  clearSpriteCache();
  sunWindowCache.clear();
  statusEl.textContent = computed > 0
    ? `${computed} direction${computed > 1 ? 's' : ''} computed from OSM`
    : 'Building geometry loaded';
  setTimeout(() => { statusEl.textContent = ''; }, 4000);

  // Re-dispatch worker with shadow data now populated
  dispatchToWorker(datePicker.value);
  draw();
  renderList();
}
