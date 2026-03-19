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

function findNearbyBuildings(venue, buildings) {
  return buildings
    .filter(b => {
      const c = computeCentroid(b.geometry);
      return Math.hypot(c.lat - venue.lat, c.lon - venue.lng) * 111320 <= NEARBY_RADIUS_M;
    })
    .map(b => ({
      geometry: b.geometry,
      height:   extractBuildingHeight(b.tags || {}),
    }));
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

  const output = { generated: new Date().toISOString(), venues: {} };

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
    const nearbyBuildings = findNearbyBuildings(v, buildings);

    let facing = v.facing ?? 180;
    let facingSource = v.facingSource;

    if (facingSource !== 'manual') {
      let bestWall = walls[0], bestScore = -Infinity;
      for (const wall of walls) {
        const s = scoreWall(wall, buildings, building, openPolygons, entranceNodes, highways);
        if (s > bestScore) { bestScore = s; bestWall = wall; }
      }
      facing = Math.round(bestWall.bearing);
      facingSource = 'osm';
      console.log(`  ✓ ${v.name}: ${facing}° (score ${bestScore.toFixed(0)}, wall ${bestWall.lenM.toFixed(0)} m, ${nearbyBuildings.length} nearby buildings)`);
    } else {
      console.log(`  → ${v.name}: manual facing ${facing}° preserved`);
    }

    output.venues[v.id] = {
      facing,
      facingSource,
      buildingGeometry: building.geometry,
      wallNormals:      walls,
      nearbyBuildings,
    };
  }

  const outPath = join(ROOT, 'data/geometry.json');
  writeFileSync(outPath, JSON.stringify(output));
  console.log(`\nWritten ${outPath} (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
