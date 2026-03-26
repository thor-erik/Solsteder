#!/usr/bin/env node
/**
 * update-geometry.js
 * Pre-computes building geometry (nearbyBuildings, facing, wallNormals) for all venues.
 * Writes data/geometry.json — consumed by the frontend instead of live Overpass calls.
 *
 * Usage:  node scripts/update-geometry.js
 * Run by: .github/workflows/update-geometry.yml (nightly + manual)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── Venues ───────────────────────────────────────────────────────────────────

const VENUES = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'))
  .map(v => ({ ...v, lat: v.coords[0], lng: v.coords[1] }));

// ── Constants ─────────────────────────────────────────────────────────────────

const RAD = Math.PI / 180;
const NEARBY_RADIUS_M = 150;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

// ── Overpass fetch ────────────────────────────────────────────────────────────

async function postOverpass(endpoint, query) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchGeometry(bbox) {
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
      console.log(`Trying ${endpoint} …`);
      const data = await postOverpass(endpoint, query);
      console.log(`Fetched ${data.elements.length} elements`);
      return data.elements;
    } catch (err) {
      console.warn(`  ✗ ${endpoint}: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function pointInPolygon(lat, lng, nodes) {
  let inside = false;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) {
    const xi = nodes[i].lon, yi = nodes[i].lat;
    const xj = nodes[j].lon, yj = nodes[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

function computeCentroid(nodes) {
  return {
    lat: nodes.reduce((s, n) => s + n.lat, 0) / nodes.length,
    lon: nodes.reduce((s, n) => s + n.lon, 0) / nodes.length,
  };
}

function distPointToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

function extractBuildingHeight(tags) {
  if (tags['building:height']) return parseFloat(tags['building:height']);
  const levels     = parseFloat(tags['building:levels'] || 0);
  const roofLevels = parseFloat(tags['roof:levels']     || 0);
  if (levels > 0) return levels * 3.5 + roofLevels * 1.5;
  return 10.5;
}

function getWallNormals(nodes) {
  const c = computeCentroid(nodes);
  const walls = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const mx = (a.lon + b.lon) / 2, my = (a.lat + b.lat) / 2;
    const cosLat = Math.cos(my * RAD);
    // Scale lon by cosLat so the perpendicular is computed in metric space
    const dx = (b.lon - a.lon) * cosLat, dy = b.lat - a.lat;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) continue;
    const p1x = -dy / len, p1y = dx / len;
    const dot = p1x * (mx - c.lon) * cosLat + p1y * (my - c.lat);
    const ox = dot > 0 ? p1x : -p1x;
    const oy = dot > 0 ? p1y : -p1y;
    const bearing = (Math.atan2(ox, oy) * 180 / Math.PI + 360) % 360;
    const lenM = Math.sqrt((b.lon - a.lon) ** 2 * cosLat ** 2 + (b.lat - a.lat) ** 2) * 111320;
    walls.push({ bearing, lenM, mx, my, aLat: a.lat, aLng: a.lon, bLat: b.lat, bLng: b.lon });
  }
  return walls;
}

function probePoint(wall, distM) {
  const br = wall.bearing * RAD;
  return {
    lat: wall.my + Math.cos(br) * distM / 111320,
    lng: wall.mx + Math.sin(br) * distM / (111320 * Math.cos(wall.my * RAD)),
  };
}

function findNearbyBuildings(venue, buildings, excludeBuilding = null) {
  return buildings
    .filter(b => {
      if (b === excludeBuilding) return false;
      const c = computeCentroid(b.geometry);
      return Math.hypot(c.lat - venue.lat, c.lon - venue.lng) * 111320 <= NEARBY_RADIUS_M;
    })
    .map(b => ({
      geometry: b.geometry,
      height:   extractBuildingHeight(b.tags || {}),
    }));
}

// ── Auto terrace wall selection ────────────────────────────────────────────────

/**
 * Determine which walls should be auto-selected as terrace anchors.
 *
 * Algorithm:
 *  1. Score every wall with scoreWall (existing heuristic).
 *  2. The highest-scoring wall is always selected.
 *  3. For each adjacent wall (shares a vertex with the best wall):
 *     - Include it if it scores ≥ 20% of best AND either:
 *       a) the entrance location (googleLocation > venue coords) is within 5 m
 *          of the shared corner, OR
 *       b) it scores ≥ 40% of best (strong enough on its own).
 *
 * This handles L-shaped / corner terraces without over-selecting.
 */
function computeAutoTerraceWallIndices(venue, walls, buildings, venueBuilding, openPolygons, entranceNodes, highways) {
  if (!walls.length) return [0];

  const scores    = walls.map(w => scoreWall(w, buildings, venueBuilding, openPolygons, entranceNodes, highways));
  const bestScore = Math.max(...scores);
  if (bestScore <= 0) return [0];

  const bestIdx  = scores.indexOf(bestScore);
  const bestWall = walls[bestIdx];
  const selected = [bestIdx];

  // Entrance location — googleLocation is more precise than the venue point
  const eLat = venue.googleLocation?.lat ?? venue.lat;
  const eLng = venue.googleLocation?.lng ?? venue.lng;

  const VERTEX_M  = 2 / 111320;   // walls share a vertex if endpoints within 2 m
  const CORNER_M  = 5 / 111320;   // entrance "near corner" threshold: 5 m

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
    if (scores[i2] < bestScore * 0.20) return;        // too weak
    if (!sharesVertex(bestWall, w2)) return;           // not adjacent
    const nearCorner = entranceNearSharedCorner(bestWall, w2);
    if (nearCorner || scores[i2] >= bestScore * 0.40) {
      selected.push(i2);
    }
  });

  return selected;
}

// ── Auto terrace depth ────────────────────────────────────────────────────────

/**
 * 2-D ray / segment intersection in the (lon*cosLat, lat) coordinate space.
 * Returns the ray parameter t > 0 if they intersect, otherwise null.
 */
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
 * Raycast outward from three points (25 / 50 / 75%) along the terrace wall
 * and return the nearest highway intersection distance in metres, minus a
 * 0.5 m buffer — or null if no highway is found within MAX_DIST_M.
 */
function computeAutoTerraceDepth(wall, highways) {
  const MAX_DIST_M = 20;
  const br         = wall.bearing * RAD;
  const cosLat     = Math.cos(wall.my * RAD);
  const MAX_T      = MAX_DIST_M / 111320;  // in (lon*cosLat, lat) units

  // Unit direction vector in (lon*cosLat, lat) space
  const dx = Math.sin(br), dy = Math.cos(br);

  // Three probe origins along the wall face (25%, 50%, 75%)
  const probeOrigins = [0.25, 0.5, 0.75].map(f => ({
    ox: ((1 - f) * wall.aLng + f * wall.bLng) * cosLat,
    oy:  (1 - f) * wall.aLat + f * wall.bLat,
  }));

  let minT = MAX_T;

  for (const hw of highways) {
    const nodes = hw.geometry || [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const a  = nodes[i], b = nodes[i + 1];
      const ax = a.lon * cosLat, ay = a.lat;
      const bx = b.lon * cosLat, by = b.lat;
      for (const { ox, oy } of probeOrigins) {
        // Quick cull: skip if midpoint of segment is far from probe origin
        if (Math.hypot((ax + bx) / 2 - ox, (ay + by) / 2 - oy) > MAX_T * 2) continue;
        const t = raySegmentIntersect(ox, oy, dx, dy, ax, ay, bx, by);
        if (t !== null && t < minT) minT = t;
      }
    }
  }

  if (minT < MAX_T) {
    return Math.max(1.5, minT * 111320 - 0.5);  // 0.5 m buffer, minimum 1.5 m
  }
  return null;
}

function scoreWall(wall, buildings, venueBuilding, openPolygons, entranceNodes, highways) {
  let score = wall.lenM;

  for (const dist of [5, 15]) {
    const p = probePoint(wall, dist);
    for (const b of buildings) {
      if (b === venueBuilding || !b.geometry?.length) continue;
      if (pointInPolygon(p.lat, p.lng, b.geometry)) return score * 0.01;
    }
  }

  const entrThreshSq = (4 / 111320) ** 2;
  for (const node of entranceNodes) {
    if (distPointToSegmentSq(node.lon, node.lat, wall.aLng, wall.aLat, wall.bLng, wall.bLat) < entrThreshSq) {
      score *= 10; break;
    }
  }

  const p20 = probePoint(wall, 20);
  const streetThreshSq = (15 / 111320) ** 2;
  outer: for (const hw of highways) {
    for (const node of (hw.geometry || [])) {
      if ((node.lat - p20.lat) ** 2 + (node.lon - p20.lng) ** 2 < streetThreshSq) { score *= 3; break outer; }
    }
  }

  const p70 = probePoint(wall, 70);
  for (const poly of openPolygons) {
    if (pointInPolygon(p70.lat, p70.lng, poly)) { score *= 4; break; }
  }

  return score;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const lats = VENUES.map(v => v.lat), lngs = VENUES.map(v => v.lng);
  const s = (Math.min(...lats) - 0.003).toFixed(6);
  const n = (Math.max(...lats) + 0.003).toFixed(6);
  const w = (Math.min(...lngs) - 0.004).toFixed(6);
  const e = (Math.max(...lngs) + 0.004).toFixed(6);
  const bbox = `${s},${w},${n},${e}`;

  console.log(`Fetching geometry for bbox ${bbox} …`);
  const elements = await fetchGeometry(bbox);

  const buildings     = elements.filter(e => e.type === 'way' && e.tags?.building && e.geometry?.length >= 4);
  const openPolygons  = elements.filter(e => e.type === 'way' && !e.tags?.building && e.geometry?.length >= 3
    && (e.tags?.natural || e.tags?.leisure || e.tags?.landuse || e.tags?.place)).map(e => e.geometry);
  const entranceNodes = elements.filter(e => e.type === 'node' && e.tags?.entrance);
  const highways      = elements.filter(e => e.type === 'way' && e.tags?.highway && e.geometry?.length);

  console.log(`${buildings.length} buildings | ${openPolygons.length} open areas | ${entranceNodes.length} entrances | ${highways.length} streets`);

  const output = { version: 2, generated: new Date().toISOString(), venues: {} };

  for (const v of VENUES) {
    let building = buildings.find(b => pointInPolygon(v.lat, v.lng, b.geometry));
    if (!building) {
      building = buildings
        .map(b => ({ b, d: (c => Math.hypot(c.lat - v.lat, c.lon - v.lng))(computeCentroid(b.geometry)) }))
        .filter(x => x.d < 0.001).sort((a, b) => a.d - b.d)[0]?.b ?? null;
    }
    if (!building) {
      console.warn(`  ✗ ${v.name}: no building found`);
      continue;
    }

    const walls         = getWallNormals(building.geometry);
    const nearbyBuildings = findNearbyBuildings(v, buildings, building);

    let facing = v.facing ?? 180;
    let facingSource = v.facingSource;
    let wallSegment;

    let autoTerraceWallIndices;
    if (facingSource !== 'manual') {
      autoTerraceWallIndices = computeAutoTerraceWallIndices(v, walls, buildings, building, openPolygons, entranceNodes, highways);
      const bestIdx = autoTerraceWallIndices[0];
      wallSegment  = walls[bestIdx];
      facing       = Math.round(wallSegment.bearing);
      facingSource = 'osm';
      const extraWalls = autoTerraceWallIndices.length > 1 ? ` + ${autoTerraceWallIndices.length - 1} adjacent` : '';
      console.log(`  ✓ ${v.name}: ${facing}° (wall ${wallSegment.lenM.toFixed(0)} m${extraWalls}, ${nearbyBuildings.length} nearby buildings)${v.googleLocation ? ' [Google loc]' : ''}`);
    } else {
      wallSegment = walls.reduce((best, w) =>
        Math.abs(w.bearing - facing) < Math.abs(best.bearing - facing) ? w : best, walls[0]);
      // Still compute multi-wall selection for manual-facing venues
      autoTerraceWallIndices = computeAutoTerraceWallIndices(v, walls, buildings, building, openPolygons, entranceNodes, highways);
      // But keep the manual primary wall as index 0
      const manualIdx = walls.indexOf(wallSegment);
      autoTerraceWallIndices = [manualIdx, ...autoTerraceWallIndices.filter(i => i !== manualIdx)];
      console.log(`  → ${v.name}: manual facing ${facing}° preserved`);
    }

    const autoTerraceDepth = computeAutoTerraceDepth(wallSegment, highways);
    if (autoTerraceDepth !== null) {
      console.log(`    terrace depth: ${autoTerraceDepth.toFixed(1)} m (street detected)`);
    }

    output.venues[v.id] = {
      facing,
      facingSource,
      wallSegment,
      buildingGeometry:      building.geometry,
      wallNormals:           walls,
      nearbyBuildings,
      autoTerraceDepth,
      autoTerraceWallIndices,
    };
  }

  const outPath = join(ROOT, 'data/geometry.json');
  writeFileSync(outPath, JSON.stringify(output));
  console.log(`\nWritten ${outPath} (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
