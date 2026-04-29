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
const OSM_CACHE_KEY    = 'solsteder_osm_v10';
const OSM_CACHE_TTL    = 7 * 24 * 60 * 60 * 1000; // 7 days
// Bump this whenever the scoring / geometry pipeline changes so that a
// stale precomputed geometry.json is rejected and the slow path reruns.
const GEOMETRY_VERSION = 3;

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
  node["leisure"="outdoor_seating"](${bbox});
  way["leisure"="outdoor_seating"](${bbox});
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

// ── Single-venue geometry fetch (for candidate venues) ───────────────────────

/**
 * Fetch OSM geometry in a small bbox around a single lat/lng and compute
 * facing, walls, shadows, terrace test points — same as initFacings() but
 * for one venue. Returns the enriched venue object, or null on failure.
 */
async function fetchAndComputeGeometryForVenue(venue) {
  const pad = 0.003; // ~330 m
  const padLng = 0.004;
  const s = (venue.lat - pad).toFixed(6);
  const n = (venue.lat + pad).toFixed(6);
  const w = (venue.lng - padLng).toFixed(6);
  const e = (venue.lng + padLng).toFixed(6);
  const bbox = `${s},${w},${n},${e}`;

  const query = `[out:json][timeout:30];
(
  way["building"](${bbox});
  node["entrance"](${bbox});
  way["highway"~"primary|secondary|tertiary|residential|service|footway|pedestrian|living_street|unclassified"](${bbox});
  way["natural"~"water|coastline"](${bbox});
  way["leisure"~"park|garden"](${bbox});
  way["landuse"~"grass|meadow|recreation_ground|cemetery"](${bbox});
  way["place"~"square"](${bbox});
  node["leisure"="outdoor_seating"](${bbox});
  way["leisure"="outdoor_seating"](${bbox});
);
out geom;`;

  let elements;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await postOverpass(endpoint, query);
      elements = data.elements;
      break;
    } catch (err) {
      console.warn(`OSM single-venue: ${endpoint} failed —`, err.message);
    }
  }
  if (!elements) return null;

  const buildings          = elements.filter(el => el.type === 'way' && el.tags?.building && el.geometry?.length >= 4);
  const openPolygons       = elements.filter(el => el.type === 'way' && !el.tags?.building && el.geometry?.length >= 3
    && (el.tags?.natural || el.tags?.leisure || el.tags?.landuse || el.tags?.place)).map(el => el.geometry);
  const entranceNodes      = elements.filter(el => el.type === 'node' && el.tags?.entrance);
  const highways           = elements.filter(el => el.type === 'way' && el.tags?.highway && el.geometry?.length);
  const outdoorSeatingNodes = elements.filter(el => el.type === 'node' && el.tags?.leisure === 'outdoor_seating');
  const outdoorSeatingAreas = elements.filter(el => el.type === 'way'  && el.tags?.leisure === 'outdoor_seating' && el.geometry?.length >= 3);

  // Find building containing or nearest to venue
  const v = venue;
  let building = buildings.find(b => pointInPolygon(v.lat, v.lng, b.geometry));
  if (!building) {
    const cosLat = Math.cos(v.lat * RAD);
    const px = v.lng * cosLat, py = v.lat;
    let bestD = (50 / 111320) ** 2, bestB = null;
    for (const b of buildings) {
      const g = b.geometry;
      for (let i = 0; i < g.length - 1; i++) {
        const d = distPointToSegmentSq(px, py, g[i].lon * cosLat, g[i].lat, g[i + 1].lon * cosLat, g[i + 1].lat);
        if (d < bestD) { bestD = d; bestB = b; }
      }
    }
    building = bestB;
  }
  if (!building) return null;

  v.buildingGeometry = building.geometry;

  const walls = getWallNormals(building.geometry);
  if (!walls.length) return null;

  v.wallNormals = walls;
  v.nearbyBuildings = findNearbyBuildings(v, buildings, building);

  const autoIndices = computeAutoTerraceWallIndices(v, walls, buildings, building, openPolygons, entranceNodes, highways);
  const bestWall    = walls[autoIndices[0]];

  v.facing               = Math.round(bestWall.bearing);
  v.wallSegment          = bestWall;
  v.facingSource         = 'osm';
  v.autoTerraceDepth       = computeAutoTerraceDepth(bestWall, highways);
  v.autoTerraceWallIndices = autoIndices;
  v.terraceWallIndices     = autoIndices;

  // Find nearby outdoor seating element
  const THRESH = 30 / 111320;
  let osmEl = null, bestOsmD = THRESH;
  for (const node of outdoorSeatingNodes) {
    const d = Math.hypot(node.lat - v.lat, node.lon - v.lng);
    if (d < bestOsmD) { bestOsmD = d; osmEl = node; }
  }
  for (const area of outdoorSeatingAreas) {
    const c = computeCentroid(area.geometry);
    const d = Math.hypot(c.lat - v.lat, c.lon - v.lng);
    if (d < bestOsmD) { bestOsmD = d; osmEl = area; }
  }

  v.terraceTestPoints = computeTerraceTestPoints(v, osmEl);
  v.noiseScore = computeNoiseScore(v, highways);

  return v;
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
 * 200 m: at 10° sun altitude a 35m building casts a ~200m shadow — relevant
 * for Oslo spring mornings and autumn evenings.
 */
function findNearbyBuildings(venue, buildings, excludeBuilding = null, radiusM = 200) {
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

// ── Terrace test-point grid ───────────────────────────────────────────────────

/**
 * When an OSM outdoor_seating area (way) is available, compute the terrace
 * depth by projecting each polygon vertex onto the wall's outward normal and
 * taking the maximum projection distance in metres.
 */
function computeDepthFromOutdoorSeatingArea(wallSegment, polygon) {
  if (!wallSegment || !polygon?.length) return null;
  const br     = wallSegment.bearing * RAD;
  const cosLat = Math.cos(wallSegment.my * RAD);
  const nx     = Math.sin(br), ny = Math.cos(br);
  const ox     = wallSegment.mx * cosLat, oy = wallSegment.my;
  let maxProj  = 0;
  for (const node of polygon) {
    const proj = (node.lon * cosLat - ox) * nx + (node.lat - oy) * ny;
    if (proj > maxProj) maxProj = proj;
  }
  const depthM = maxProj * 111320;
  return depthM > 0.5 ? depthM : null;
}

/**
 * Compute the array of lat/lng points used for shadow testing across the terrace.
 *
 * Priority:
 *   1a. OSM `leisure=outdoor_seating` area (way) within 30 m — centroid used as
 *       test point; polygon extent drives autoTerraceDepth (most accurate)
 *   1b. OSM `leisure=outdoor_seating` node within 30 m — single accurate point
 *   2.  Project a 3-point grid from each selected terrace wall at half depth
 *
 * `osmElement` is the full Overpass element (node or way) or null.
 * Side-effect: sets venue.autoTerraceDepth when derived from an OSM polygon.
 */
function computeTerraceTestPoints(venue, osmElement) {
  // Rooftop: building centroid — entire roof exposed to sky
  if (venue.terraceType === 'rooftop' && venue.buildingGeometry?.length) {
    const c = computeCentroid(venue.buildingGeometry);
    return [{ lat: c.lat, lng: c.lon }];
  }

  // Courtyard: building centroid for display context; sun logic uses altitude cutoff in venueSunState
  if (venue.terraceType === 'courtyard' && venue.buildingGeometry?.length) {
    const c = computeCentroid(venue.buildingGeometry);
    return [{ lat: c.lat, lng: c.lon }];
  }

  // Detached: user-placed coordinate — terrace is separate from the building
  if (venue.terraceType === 'detached' && venue.terraceDetachedLocation) {
    return [{ lat: venue.terraceDetachedLocation.lat, lng: venue.terraceDetachedLocation.lng }];
  }

  // Tier 1a — OSM area polygon: centroid + depth from polygon extent
  if (osmElement?.geometry) {
    const c     = computeCentroid(osmElement.geometry);
    const depth = computeDepthFromOutdoorSeatingArea(venue.wallSegment, osmElement.geometry);
    if (depth) venue.autoTerraceDepth = depth;
    return [{ lat: c.lat, lng: c.lon }];
  }

  // Tier 1b — OSM node: single accurate point
  if (osmElement) {
    return [{ lat: osmElement.lat, lng: osmElement.lng }];
  }

  // Tier 2 — project from wall geometry
  const indices = venue.autoTerraceWallIndices?.length
    ? venue.autoTerraceWallIndices
    : (venue.terraceWallIndices?.length ? venue.terraceWallIndices : null);

  const walls = indices?.length
    ? indices.map(i => venue.wallNormals?.[i]).filter(Boolean)
    : venue.wallSegment ? [venue.wallSegment] : [];

  if (!walls.length) return [{ lat: venue.lat, lng: venue.lng }];

  const depth     = venue.terraceDepth ?? venue.autoTerraceDepth ?? 4;
  const testDepth = Math.max(1.5, depth * 0.5);

  const points = [];
  for (const wall of walls) {
    const br     = wall.bearing * RAD;
    const cosLat = Math.cos(wall.my * RAD);
    for (const f of [0.25, 0.5, 0.75]) {
      const wLat = (1 - f) * wall.aLat + f * wall.bLat;
      const wLng = (1 - f) * wall.aLng + f * wall.bLng;
      points.push({
        lat: wLat + Math.cos(br) * testDepth / 111320,
        lng: wLng + Math.sin(br) * testDepth / (111320 * cosLat),
      });
    }
  }
  return points;
}

// ── Auto terrace wall selection ────────────────────────────────────────────────

function computeAutoTerraceWallIndices(venue, walls, buildings, venueBuilding, openPolygons, entranceNodes, highways) {
  if (!walls.length) return [0];

  const scores    = walls.map(w => scoreWall(w, venue, buildings, venueBuilding, openPolygons, entranceNodes, highways));
  const bestScore = Math.max(...scores);
  if (bestScore <= 0) return [0];

  const bestIdx  = scores.indexOf(bestScore);
  const bestWall = walls[bestIdx];
  const selected = [bestIdx];

  // Entrance location — googleLocation is more precise than the venue point
  const eLat = venue.googleLocation?.lat ?? venue.lat;
  const eLng = venue.googleLocation?.lng ?? venue.lng;

  const VERTEX_M = 2 / 111320;  // walls share a vertex if endpoints within 2 m
  const CORNER_M = 5 / 111320;  // entrance "near corner" threshold: 5 m

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
    if (scores[i2] < bestScore * 0.20) return;       // too weak
    if (!sharesVertex(bestWall, w2)) return;          // not adjacent
    const nearCorner = entranceNearSharedCorner(bestWall, w2);
    if (nearCorner || scores[i2] >= bestScore * 0.40) {
      selected.push(i2);
    }
  });

  return selected;
}

// ── Traffic noise score ───────────────────────────────────────────────────────

const _HW_NOISE = {
  motorway:      1.0,
  trunk:         0.88,
  primary:       0.72,
  secondary:     0.56,
  tertiary:      0.40,
  unclassified:  0.28,
  residential:   0.22,
  living_street: 0.12,
  service:       0.10,
  pedestrian:    0.08,
  footway:       0.04,
};

/**
 * Compute a noise score 0–1 for a venue based on nearby OSM highways.
 * Weights road type × inverse-square distance decay (ref: 30 m).
 * Roads further than 120 m are ignored.
 */
function computeNoiseScore(venue, highways) {
  const REF_M  = 30;
  const MAX_M  = 120;
  const cosLat = Math.cos(venue.lat * RAD);
  const px     = venue.lng * cosLat, py = venue.lat;
  const maxSq  = (MAX_M / 111320) ** 2;

  let total = 0;
  for (const hw of highways) {
    const weight = _HW_NOISE[hw.tags?.highway] ?? 0.04;
    const geom   = hw.geometry || [];
    for (let i = 0; i < geom.length - 1; i++) {
      const a = geom[i], b = geom[i + 1];
      const ax = a.lon * cosLat, ay = a.lat;
      const bx = b.lon * cosLat, by = b.lat;
      // Quick midpoint reject before expensive distPointToSegmentSq
      if (((ax + bx) / 2 - px) ** 2 + ((ay + by) / 2 - py) ** 2 > maxSq * 4) continue;
      const dSq = distPointToSegmentSq(px, py, ax, ay, bx, by);
      if (dSq > maxSq) continue;
      const dM   = Math.sqrt(dSq) * 111320;
      total += weight / (1 + dM / REF_M) ** 2;
    }
  }
  return Math.min(1, total);
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
 * estimated terrace depth in metres.
 *
 * Two-pass approach:
 *   Pass 1 — roads + pedestrian zones only (excludes footway/path/service/steps).
 *             Footways often run directly alongside buildings as covered sidewalks
 *             and give falsely shallow readings (< 1 m) when the terrace extends
 *             further to the road kerb.
 *   Pass 2 — all highways (including footways) with a larger edge buffer.
 *             Used only when no road-type highway is found within 20 m.
 *
 * Minimum returned depth is 2 m (one row of tables + chairs).
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

  const NARROW = new Set(['footway', 'path', 'service', 'steps', 'track', 'cycleway']);

  function raycastDepth(hwList, edgeBuffer) {
    let minT = MAX_T;
    for (const hw of hwList) {
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
    if (minT >= MAX_T) return null;
    return Math.max(2, minT * 111320 - edgeBuffer);
  }

  // Pass 1: roads, pedestrian zones, living streets (not narrow paths)
  const roadHighways = highways.filter(h => !NARROW.has(h.tags?.highway));
  const d1 = raycastDepth(roadHighways, 0.5);
  if (d1 !== null) return d1;

  // Pass 2: include narrow paths — last resort, larger edge buffer
  return raycastDepth(highways, 1.5);
}

/**
 * Score a wall for how likely it is to be the terrace-facing facade.
 * Higher score = more likely to face an open, sunny, street-side space.
 *
 * `venue` is required so walls far from the venue pin can be penalised.
 * This is critical for restaurants in large city-block buildings: the pin
 * marks the entrance corner, so walls on the opposite side of the block
 * should not compete with walls right beside the entrance.
 */
function scoreWall(wall, venue, buildings, venueBuilding, openPolygons, entranceNodes, highways) {
  // Proximity factor: exponential decay with distance from venue pin (decay = 20 m).
  // Example: 10 m away → ×0.61, 20 m → ×0.37, 40 m → ×0.14, 80 m → ×0.02.
  const cosLat  = Math.cos(wall.my * RAD);
  const wallDist = Math.hypot((wall.mx - venue.lng) * cosLat * 111320,
                               (wall.my - venue.lat) * 111320);
  let score = wall.lenM * Math.exp(-wallDist / 20);

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

  // 3. Street-facing boost: highway segment within 15 m of the 20 m probe (×3)
  const p20 = probePoint(wall, 20);
  const cosLatP = Math.cos(p20.lat * RAD);
  const streetThreshSq = (15/111320)**2;
  const px = p20.lng * cosLatP, py = p20.lat;
  outer: for (const hw of highways) {
    const geom = hw.geometry || [];
    for (let i = 0; i < geom.length - 1; i++) {
      const a = geom[i], b = geom[i+1];
      if (distPointToSegmentSq(px, py, a.lon*cosLatP, a.lat, b.lon*cosLatP, b.lat) < streetThreshSq) {
        score *= 3; break outer;
      }
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
 * After loading, terraceTestPoints are derived from the loaded geometry
 * (or from the precomputed field if already present).
 */
async function tryLoadPrecomputed() {
  try {
    const resp = await fetch('data/geometry.json');
    if (!resp.ok) return false;
    const data = await resp.json();
    const version = data.v ?? data.version ?? 1;
    if (version < GEOMETRY_VERSION) {
      console.log('OSM: geometry.json is stale (version mismatch), using live Overpass data');
      return false;
    }

    // v3 compact format: deduplicated building pool + short keys
    if (version >= 3) return _applyCompactGeometry(data);

    // v2 legacy format
    const { venues: precomputed } = data;
    let applied = 0;
    VENUES.forEach(v => {
      const g = precomputed[v.id];
      if (!g) return;
      v.buildingGeometry       = g.buildingGeometry;
      v.wallNormals            = g.wallNormals;
      v.nearbyBuildings        = g.nearbyBuildings;
      v.wallSegment            = g.wallSegment;
      v.autoTerraceDepth       = g.autoTerraceDepth       ?? null;
      v.autoTerraceWallIndices = g.autoTerraceWallIndices ?? null;
      v.facing       = g.facing;
      v.facingSource = g.facingSource;
      saveFacingCache(v.id, g.facing, g.facingSource);
      v.terraceTestPoints = g.terraceTestPoints ?? computeTerraceTestPoints(v, null);
      applied++;
    });
    console.log(`OSM: loaded geometry.json v2 (${applied}/${VENUES.length} venues)`);
    return applied === VENUES.length;
  } catch (_) {
    return false;
  }
}

/** Expand compact v3 geometry into the same venue properties the app expects. */
function _applyCompactGeometry(data) {
  const pool = data.b; // shared building pool: [[lat,lon,lat,lon,...,height], ...]
  const precomputed = data.venues;

  // Pre-expand building pool into {geometry: [{lat,lon},...], height} objects
  const expandedBuildings = pool.map(flat => {
    const height = flat[flat.length - 1];
    const geometry = [];
    for (let i = 0; i < flat.length - 1; i += 2) {
      geometry.push({ lat: flat[i], lon: flat[i + 1] });
    }
    return { geometry, height };
  });

  let applied = 0;
  VENUES.forEach(v => {
    const g = precomputed[v.id];
    if (!g) return;

    // buildingGeometry: [[lat,lon], ...] → [{lat,lon}, ...]
    v.buildingGeometry = g.bg ? g.bg.map(p => ({ lat: p[0], lon: p[1] })) : null;

    // wallNormals: [[aLat,aLng,bLat,bLng,bearing], ...] → full wall objects
    v.wallNormals = g.wn ? g.wn.map(w => _expandWall(w)) : [];

    // nearbyBuildings: [idx, idx, ...] → expanded from pool
    v.nearbyBuildings = g.nb ? g.nb.map(idx => expandedBuildings[idx]) : [];

    // wallSegment: [aLat,aLng,bLat,bLng,bearing] → full wall object
    v.wallSegment = g.ws ? _expandWall(g.ws) : null;

    v.autoTerraceDepth       = g.td ?? null;
    v.autoTerraceWallIndices = g.tw ?? null;
    v.facing       = g.f;
    v.facingSource = g.fs;
    saveFacingCache(v.id, g.f, g.fs);

    // terraceTestPoints: [[lat,lng], ...] → [{lat,lng}, ...]
    v.terraceTestPoints = g.tp
      ? g.tp.map(p => ({ lat: p[0], lng: p[1] }))
      : computeTerraceTestPoints(v, null);

    applied++;
  });
  console.log(`OSM: loaded geometry.json v3 (${applied}/${VENUES.length} venues, ${pool.length} buildings)`);
  return applied === VENUES.length;
}

/** Expand a compact wall array [aLat,aLng,bLat,bLng,bearing] into a full wall object. */
function _expandWall(w) {
  const [aLat, aLng, bLat, bLng, bearing] = w;
  const mx = (aLng + bLng) / 2;
  const my = (aLat + bLat) / 2;
  const cosLat = Math.cos(my * RAD);
  const dLat = (bLat - aLat) * 111320;
  const dLng = (bLng - aLng) * 111320 * cosLat;
  const lenM = Math.sqrt(dLat * dLat + dLng * dLng);
  return { bearing, lenM, mx, my, aLat, aLng, bLat, bLng };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function initFacings() {
  function showMapToast(msg, duration = 3000) {
    const el = document.getElementById('map-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(showMapToast._timer);
    if (duration > 0) showMapToast._timer = setTimeout(() => el.classList.remove('visible'), duration);
  }

  // Fast path: pre-computed geometry.json served from the repo
  if (await tryLoadPrecomputed()) {
    // Hand precise venue data (with nearbyBuildings) to the worker. Don't
    // clear the cache or re-render synchronously here: at ~300 venues the
    // sync recompute is ~22M shadow checks (~1–2 s) and freezes the UI.
    // The cache still holds simple-facing entries from the pre-initFacings
    // worker run — leave them visible as a placeholder until the worker
    // callback overwrites them with precise windows and triggers a redraw.
    dispatchToWorker(datePicker.value);
    if (!sunWorker) {
      // file:// origin: no worker available, must compute on the main thread.
      clearSpriteCache();
      sunWindowCache.clear();
      draw();
      renderList();
    }
    if (typeof updateDetailPanel === 'function') updateDetailPanel();
    return;
  }

  // Slow path: fetch raw geometry from Overpass and compute locally
  let elements;
  try {
    const data = await fetchAllGeometry();
    elements = data.elements;
    console.log(`OSM: fetched ${elements.length} elements`);
  } catch (err) {
    console.error('OSM fetch failed:', err);
    return;
  }

  const buildings          = elements.filter(e => e.type==='way' && e.tags?.building && e.geometry?.length>=4);
  const openPolygons       = elements.filter(e => e.type==='way' && !e.tags?.building && e.geometry?.length>=3
    && (e.tags?.natural||e.tags?.leisure||e.tags?.landuse||e.tags?.place)).map(e => e.geometry);
  const entranceNodes      = elements.filter(e => e.type==='node' && e.tags?.entrance);
  const highways           = elements.filter(e => e.type==='way' && e.tags?.highway && e.geometry?.length);
  const outdoorSeatingNodes = elements.filter(e => e.type==='node' && e.tags?.leisure === 'outdoor_seating');
  const outdoorSeatingAreas = elements.filter(e => e.type==='way'  && e.tags?.leisure === 'outdoor_seating' && e.geometry?.length>=3);

  console.log(`OSM: ${buildings.length} buildings | ${openPolygons.length} open areas | ${entranceNodes.length} entrances | ${highways.length} streets | ${outdoorSeatingNodes.length + outdoorSeatingAreas.length} outdoor_seating`);

  /** Find a community-placed outdoor_seating node/area centroid within 30 m of a venue. */
  /** Return the nearest OSM outdoor_seating element (full node or way) within 30 m. */
  function findOutdoorSeatingElement(venue) {
    const THRESH = 30 / 111320;
    let best = null, bestD = THRESH;
    for (const node of outdoorSeatingNodes) {
      const d = Math.hypot(node.lat - venue.lat, node.lon - venue.lng);
      if (d < bestD) { bestD = d; best = node; }
    }
    for (const area of outdoorSeatingAreas) {
      const c = computeCentroid(area.geometry);
      const d = Math.hypot(c.lat - venue.lat, c.lon - venue.lng);
      if (d < bestD) { bestD = d; best = area; }
    }
    return best; // full Overpass element (has .geometry for ways, .lat/.lon for nodes)
  }

  let computed = 0;
  VENUES.forEach(v => {
    // ── Step 1: find building + wall normals (always — needed for edit tool) ──
    let building = buildings.find(b => pointInPolygon(v.lat, v.lng, b.geometry));
    if (!building) {
      // Fallback: nearest building by closest wall edge (more reliable than centroid)
      const cosLat = Math.cos(v.lat * RAD);
      const px = v.lng * cosLat, py = v.lat;
      let bestD = (50/111320)**2, bestB = null;
      for (const b of buildings) {
        const g = b.geometry;
        for (let i = 0; i < g.length - 1; i++) {
          const d = distPointToSegmentSq(px, py, g[i].lon*cosLat, g[i].lat, g[i+1].lon*cosLat, g[i+1].lat);
          if (d < bestD) { bestD = d; bestB = b; }
        }
      }
      building = bestB;
    }
    if (!building) { console.warn(`${v.name}: no building found`); return; }

    v.buildingGeometry = building.geometry;

    const walls = getWallNormals(building.geometry);
    if (!walls.length) return;

    v.wallNormals = walls;

    // ── Step 2: nearby buildings for shadow casting (exclude own building) ──────
    v.nearbyBuildings = findNearbyBuildings(v, buildings, building);

    // ── Step 3: wall scoring ──────────────────────────────────────────────────
    const autoIndices = computeAutoTerraceWallIndices(v, walls, buildings, building, openPolygons, entranceNodes, highways);
    const bestWall    = walls[autoIndices[0]];

    v.facing               = Math.round(bestWall.bearing);
    v.wallSegment          = bestWall;
    v.facingSource         = 'osm';
    v.autoTerraceDepth       = computeAutoTerraceDepth(bestWall, highways);
    v.autoTerraceWallIndices = autoIndices;
    v.terraceWallIndices     = autoIndices;   // overwrite stale cached indices

    // ── Step 4: terrace test-point grid ──────────────────────────────────────
    // computeTerraceTestPoints may update v.autoTerraceDepth if an OSM area is found
    const osmEl         = findOutdoorSeatingElement(v);
    v.terraceTestPoints = computeTerraceTestPoints(v, osmEl);

    // ── Step 5: traffic noise score ───────────────────────────────────────────
    v.noiseScore = computeNoiseScore(v, highways);
    saveFacingCache(v.id, v.facing, 'osm', autoIndices, null, v.noiseScore);

    computed++;
  });

  // Re-dispatch worker with shadow data now populated. Same rationale as the
  // fast path above: skip the sync re-render when a worker is available so
  // the main thread doesn't freeze on cache-miss compute for ~300 venues.
  dispatchToWorker(datePicker.value);
  if (!sunWorker) {
    clearSpriteCache();
    sunWindowCache.clear();
    draw();
    renderList();
  }
  if (typeof updateDetailPanel === 'function') updateDetailPanel();
  if (typeof _buildAreaIndex === 'function') _buildAreaIndex();
}
