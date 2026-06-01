#!/usr/bin/env node
/**
 * precompute-sun-windows.mjs
 *
 * Computes raw geometric sun windows for every venue × every date in the next
 * N days (default 7) and writes data/sun-windows.json keyed by date.
 *
 * No weather coupling — that lives in the consuming SQL (sql/047) which joins
 * these raw windows with weather_oslo at cron time. Pre-baking weather-gated
 * windows would invalidate the bake on every met.no refresh.
 *
 * Math is loaded from js/solar.js via Function() eval so this script and the
 * browser share one source of truth. Geometry overlay mirrors osm.js
 * _applyCompactGeometry — the same shape the live app builds.
 *
 * Usage: node scripts/precompute-sun-windows.mjs [days]
 * Output: data/sun-windows.json
 *         {
 *           "v": 1,
 *           "generated_at": "2026-06-01T...",
 *           "dates": ["2026-06-01", "2026-06-02", ...],
 *           "venues": {
 *             "<venue_id>": {
 *               "<date>": { "windows": [{start, end}, ...], "open": 10, "close": 23 }
 *             }
 *           }
 *         }
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const DAYS = Number(process.argv[2] || 7);

// ── Load solar.js math via Function() eval ──────────────────────────────────
// solar.js is pure JS without DOM dependencies; declaring its top-level
// functions inside a Function() body makes them locals we can return.
const solarSrc = readFileSync(join(ROOT, 'js/solar.js'), 'utf8');
const solar = new Function(
  solarSrc + `;
  return {
    buildSunTable,
    getSunFromTable,
    computeSunWindowsFromTable,
    findSunCrossingFromTable,
    venueSunState,
    venueSunStateSimple,
    pointInBuildingShadow,
  };`
)();

// ── Load venues + geometry (mirror osm.js _applyCompactGeometry) ────────────
const venues = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'))
  .map(v => ({ ...v, lat: v.coords[0], lng: v.coords[1] }));

const geom = JSON.parse(readFileSync(join(ROOT, 'data/geometry.json'), 'utf8'));
const version = geom.v ?? geom.version ?? 1;
if (version < 3) {
  console.error(`geometry.json is v${version}, expected v3+. Re-run scripts/update-geometry.mjs first.`);
  process.exit(1);
}

// Expand shared building pool — same shape osm.js builds at runtime.
const expandedBuildings = (geom.b || []).map(flat => {
  const height = flat[flat.length - 1];
  const geometry = [];
  for (let i = 0; i < flat.length - 1; i += 2) {
    geometry.push({ lat: flat[i], lon: flat[i + 1] });
  }
  return { geometry, height };
});

function expandWall(w) {
  const RAD = Math.PI / 180;
  const [aLat, aLng, bLat, bLng, bearing] = w;
  const mx = (aLng + bLng) / 2;
  const my = (aLat + bLat) / 2;
  const cosLat = Math.cos(my * RAD);
  const dLat = (bLat - aLat) * 111320;
  const dLng = (bLng - aLng) * 111320 * cosLat;
  const lenM = Math.sqrt(dLat * dLat + dLng * dLng);
  return { bearing, lenM, mx, my, aLat, aLng, bLat, bLng };
}

let hydrated = 0;
for (const v of venues) {
  const g = geom.venues[v.id];
  if (!g) continue;
  v.buildingGeometry = g.bg ? g.bg.map(p => ({ lat: p[0], lon: p[1] })) : null;
  v.wallNormals      = g.wn ? g.wn.map(w => expandWall(w)) : [];
  v.nearbyBuildings  = g.nb ? g.nb.map(idx => expandedBuildings[idx]) : [];
  v.wallSegment      = g.ws ? expandWall(g.ws) : null;
  v.autoTerraceDepth       = g.td ?? null;
  v.autoTerraceWallIndices = g.tw ?? null;
  v.facing       = g.f;
  v.facingSource = g.fs;
  v.terraceTestPoints = g.tp ? g.tp.map(p => ({ lat: p[0], lng: p[1] })) : null;
  hydrated++;
}
console.log(`hydrated ${hydrated}/${venues.length} venues from geometry.json`);

// ── Date list (today + next DAYS in Europe/Oslo) ────────────────────────────
function osloToday() {
  // Europe/Oslo via Intl — the cron join compares dates so we need calendar
  // dates as the user sees them in Oslo, not UTC.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const today = osloToday();
const dates = Array.from({ length: DAYS + 1 }, (_, i) => addDays(today, i));
console.log(`computing windows for ${dates.length} dates: ${dates[0]} … ${dates[dates.length - 1]}`);

// ── Compute windows ─────────────────────────────────────────────────────────
const out = { v: 1, generated_at: new Date().toISOString(), dates, venues: {} };
const start = Date.now();
let written = 0, empty = 0;

for (const v of venues) {
  if (!v.openingHours) continue;
  const slot = {};
  for (const date of dates) {
    const table = solar.buildSunTable(date);
    // fast: false → use the full venueSunState (with shadow casting) so the
    // pre-bake is geometrically equivalent to what the worker produces live.
    const { windows, open, close } = solar.computeSunWindowsFromTable(v, table, { fast: false });
    if (windows.length) written++;
    else empty++;
    slot[date] = { windows, open, close };
  }
  out.venues[v.id] = slot;
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`computed ${written} non-empty + ${empty} empty windows across ${venues.length} venues × ${dates.length} dates in ${elapsed}s`);

// ── Write artifact ──────────────────────────────────────────────────────────
const outPath = join(ROOT, 'data/sun-windows.json');
writeFileSync(outPath, JSON.stringify(out));
console.log(`wrote ${outPath}`);
