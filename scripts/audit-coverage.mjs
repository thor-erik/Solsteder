#!/usr/bin/env node
/**
 * audit-coverage.mjs
 * Reports how complete data/venues.json is relative to the universe of
 * restaurants/bars/cafes/pubs in Oslo.
 *
 * Sources:
 *   - data/venues.json          — what we have
 *   - data/oslo-candidates.json — universe (OSM + Google Places, all amenities)
 *
 * Optional flag:
 *   --osm-outdoor  also queries Overpass live for amenities tagged
 *                  outdoor_seating=yes and reports OSM-known terraces
 *                  that are missing from venues.json.
 *
 * Usage:
 *   node scripts/audit-coverage.mjs
 *   node scripts/audit-coverage.mjs --osm-outdoor
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const venues     = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'));
const candidates = JSON.parse(readFileSync(join(ROOT, 'data/oslo-candidates.json'), 'utf8'));

const fetchOutdoor = process.argv.includes('--osm-outdoor');
const writeReport  = process.argv.includes('--write');

// ── Helpers ───────────────────────────────────────────────────────────────────

const cellKey  = (lat, lng, prec = 2) => `${lat.toFixed(prec)},${lng.toFixed(prec)}`;
const normName = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ~111m per 0.001 deg lat; approx for lon at Oslo lat is 111*cos(60°) ≈ 55m.
function metresBetween(a, b) {
  const dLat = (a[0] - b[0]) * 111_000;
  const dLng = (a[1] - b[1]) * 55_000;
  return Math.hypot(dLat, dLng);
}

// Match a candidate (name, lat, lng) against existing venues.
// Considered the same if name normalises identically AND within 150 m,
// or coordinates within 25 m regardless of name.
function findInVenues(name, lat, lng) {
  const n = normName(name);
  for (const v of venues) {
    const d = metresBetween([lat, lng], v.coords);
    if (d < 25) return v;
    if (d < 150 && normName(v.name) === n) return v;
  }
  return null;
}

function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : 'n/a'; }

// ── 1. Top-line counts ────────────────────────────────────────────────────────

console.log('━━━ Coverage audit ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`venues.json:          ${venues.length}`);
console.log(`oslo-candidates.json: ${candidates.length}  (universe of restaurants/bars/cafes)`);
console.log(`raw coverage:         ${pct(venues.length, candidates.length)}`);
console.log('');
console.log('Note: not every candidate has outdoor seating, so raw % is a ceiling, not a target.');

// ── 2. Cell-level gaps (1 km² grid) ───────────────────────────────────────────

const cCell = new Map();
const vCell = new Map();
for (const c of candidates) {
  const k = cellKey(c.lat, c.lng, 2);
  cCell.set(k, (cCell.get(k) ?? 0) + 1);
}
for (const v of venues) {
  const k = cellKey(v.coords[0], v.coords[1], 2);
  vCell.set(k, (vCell.get(k) ?? 0) + 1);
}

const cellRows = [];
for (const [k, n] of cCell) {
  const vn    = vCell.get(k) ?? 0;
  const ratio = n ? vn / n : 0;
  cellRows.push({ cell: k, candidates: n, venues: vn, ratio });
}
cellRows.sort((a, b) => a.ratio - b.ratio || b.candidates - a.candidates);

const dense = cellRows.filter(r => r.candidates >= 10);
const cellsWithCandsNoVenues = cellRows.filter(r => r.venues === 0).length;

console.log('\n━━━ Cell gaps (1 km²) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Total cells with candidates:        ${cellRows.length}`);
console.log(`Cells with candidates but 0 venues: ${cellsWithCandsNoVenues}`);
console.log('');
console.log('Worst dense cells (≥10 candidates) by venue/candidate ratio:');
console.log(`  ${'cell'.padEnd(16)} ${'cand'.padStart(5)} ${'ven'.padStart(4)} ${'ratio'.padStart(7)}`);
for (const r of dense.slice(0, 15)) {
  console.log(`  ${r.cell.padEnd(16)} ${String(r.candidates).padStart(5)} ${String(r.venues).padStart(4)} ${pct(r.venues, r.candidates).padStart(7)}`);
}

// ── 3. Anchor coverage check ──────────────────────────────────────────────────

const ANCHORS = [
  { lat: 59.9138, lng: 10.7387, area: 'Sentrum' },
  { lat: 59.9235, lng: 10.7340, area: 'Grünerløkka' },
  { lat: 59.9175, lng: 10.7600, area: 'Grønland' },
  { lat: 59.9200, lng: 10.7180, area: 'Bislett' },
  { lat: 59.9080, lng: 10.7220, area: 'Frogner' },
  { lat: 59.9060, lng: 10.7490, area: 'Aker Brygge' },
  { lat: 59.9310, lng: 10.7560, area: 'Sagene' },
  { lat: 59.9390, lng: 10.7460, area: 'Nydalen' },
  { lat: 59.9270, lng: 10.7730, area: 'Tøyen' },
  { lat: 59.9330, lng: 10.7900, area: 'Sinsen' },
  { lat: 59.9280, lng: 10.6780, area: 'Majorstuen' },
  { lat: 59.9350, lng: 10.6620, area: 'Vindern' },
  { lat: 59.9040, lng: 10.6940, area: 'Skøyen' },
  { lat: 59.8980, lng: 10.6620, area: 'Ullern' },
  { lat: 59.9120, lng: 10.8180, area: 'Helsfyr' },
  { lat: 59.9000, lng: 10.8400, area: 'Bryn' },
  { lat: 59.8820, lng: 10.8100, area: 'Østensjø' },
  { lat: 59.8680, lng: 10.7760, area: 'Nordstrand' },
  { lat: 59.8560, lng: 10.7560, area: 'Ljan' },
  { lat: 59.8750, lng: 10.7280, area: 'Nordstrand vest' },
];
const ANCHOR_RADIUS_M = 900;

const uncovered = candidates.filter(c =>
  !ANCHORS.some(a => metresBetween([a.lat, a.lng], [c.lat, c.lng]) <= ANCHOR_RADIUS_M)
);

console.log('\n━━━ Anchor coverage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Search anchors:                ${ANCHORS.length} × ${ANCHOR_RADIUS_M} m`);
console.log(`Candidates inside any anchor:  ${candidates.length - uncovered.length} / ${candidates.length}  (${pct(candidates.length - uncovered.length, candidates.length)})`);
console.log(`Candidates OUTSIDE all anchors: ${uncovered.length}`);
if (uncovered.length) {
  console.log('  Sample names (geographically unreachable by current grid):');
  for (const c of uncovered.slice(0, 10)) {
    console.log(`    - ${c.name} (${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}, ${c.amenity})`);
  }
}

// ── 4. Discovery signal stats ─────────────────────────────────────────────────

const sigCount = {};
for (const v of venues) {
  const s = v.discoverySignal ?? '(legacy/manual)';
  sigCount[s] = (sigCount[s] ?? 0) + 1;
}
console.log('\n━━━ Discovery signals in venues.json ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const [s, n] of Object.entries(sigCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(20)} ${n}`);
}

// ── 5. Optional OSM outdoor_seating=yes pass ──────────────────────────────────

if (fetchOutdoor) {
  console.log('\n━━━ Fetching OSM outdoor_seating=yes venues live ━━━━━━━━━━━━━━━━');
  const query = `
[out:json][timeout:120];
area["name"="Oslo"]["admin_level"="4"]->.oslo;
(
  node["amenity"~"^(restaurant|bar|cafe|pub|biergarten)$"]["outdoor_seating"="yes"](area.oslo);
  way["amenity"~"^(restaurant|bar|cafe|pub|biergarten)$"]["outdoor_seating"="yes"](area.oslo);
);
out center tags;
  `;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
  ];
  let elements;
  for (const ep of endpoints) {
    process.stdout.write(`  Trying ${ep} … `);
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'Solsteder/audit (github.com/thor-erik/Solsteder)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(150_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      elements = data.elements;
      console.log(`${elements.length} elements`);
      break;
    } catch (err) {
      console.log(`failed (${err.message})`);
    }
  }
  if (!elements) {
    console.log('  All endpoints failed — skipping OSM outdoor pass.');
  } else {
    const osmOutdoor = elements
      .filter(el => el.tags?.name)
      .map(el => ({
        name:    el.tags.name,
        lat:     el.type === 'node' ? el.lat : el.center?.lat,
        lng:     el.type === 'node' ? el.lon : el.center?.lon,
        amenity: el.tags.amenity,
        osmId:   `${el.type}/${el.id}`,
      }))
      .filter(x => x.lat && x.lng);

    const missing = osmOutdoor.filter(o => !findInVenues(o.name, o.lat, o.lng));

    console.log(`\n  OSM venues tagged outdoor_seating=yes: ${osmOutdoor.length}`);
    console.log(`  Already in venues.json:                ${osmOutdoor.length - missing.length}`);
    console.log(`  Missing from venues.json:              ${missing.length}`);
    if (missing.length) {
      console.log('\n  Sample missing OSM-confirmed terraces:');
      for (const m of missing.slice(0, 25)) {
        console.log(`    - ${m.name.padEnd(32)} (${m.amenity}, ${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}, ${m.osmId})`);
      }
      if (writeReport) {
        const out = join(ROOT, 'data/coverage-osm-outdoor-missing.json');
        writeFileSync(out, JSON.stringify(missing, null, 2));
        console.log(`\n  Written full list → data/coverage-osm-outdoor-missing.json`);
      } else {
        console.log('\n  Re-run with --write to dump the full list to data/coverage-osm-outdoor-missing.json');
      }
    }
  }
}

console.log('\n━━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
