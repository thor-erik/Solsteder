/**
 * assign-fine-areas.mjs — coordinate-based fine-neighborhood labeling (Track 2).
 *
 * Method 1 (OSM): fetch Oslo neighborhood POLYGONS + place nodes from Overpass,
 * label every venue by point-in-polygon (smallest containing neighborhood wins),
 * with a nearest-place-node fallback when no polygon contains the point. Then
 * cross-check against the neighborhood the venue uses in its OWN name — and per
 * the agreed priority rule, the venue's self-named neighborhood WINS on conflict.
 *
 * READ-ONLY by default: writes data/area-assign-review.json + prints a summary
 * for review. Does NOT touch data/venues.json. (A future --apply step would
 * write an `areaFine` field after the review; intentionally not wired yet.)
 *
 * Needs network (Overpass). Run on your machine:
 *   node scripts/assign-fine-areas.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const venues = JSON.parse(readFileSync(join(ROOT, 'data', 'venues.json'), 'utf8'));

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
// OSM place tiers: `suburb` is the colloquial neighborhood level venues use
// (Bjørvika, Skøyen, Grünerløkka). `neighbourhood`/`quarter` are micro-blocks
// (Sørengutstikkeren, Sjølyst) — too granular, so we EXCLUDE them: pulling all
// three together is what produced 124 noisy micro-labels. `borough` catches a
// few larger named areas. Oslo kommune's official open data only goes to bydel
// (15 districts) — too coarse — so the suburb tier is the best-fit source.
const QUERY = `
[out:json][timeout:180];
area["name"="Oslo"]["admin_level"="4"]->.oslo;
(
  node["place"~"^(suburb|borough)$"](area.oslo);
  way["place"~"^(suburb|borough)$"](area.oslo);
  relation["place"~"^(suburb|borough)$"](area.oslo);
);
out geom;
`;
const NODE_FALLBACK_MAX_M = 900; // beyond this, no nearest-node guess
const SELF_NAME_MAX_M = 800;     // a self-named neighborhood must be this close,
                                 // else it's a brand coincidence ("Lofthus
                                 // Samvirkelag" ≠ the Lofthus neighborhood)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchOSM() {
  let data, lastErr;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  Overpass: ${ep} …`);
      const resp = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Solsteder/1.0 (github.com/thor-erik/Solsteder)' },
        body: 'data=' + encodeURIComponent(QUERY),
        signal: AbortSignal.timeout(200_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
      console.log(`  ✓ ${data.elements.length} elements`);
      break;
    } catch (e) { console.warn(`  ✗ ${ep}: ${e.message}`); lastErr = e; await sleep(8000); }
  }
  if (!data) throw lastErr;
  return data.elements;
}

// ── geometry helpers ─────────────────────────────────────────────────────────
function haversine(a, b) {
  const R = 6371000, r = (d) => d * Math.PI / 180;
  const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// ring = [[lat,lng], …]; ray-cast point-in-polygon (lng=x, lat=y)
function pointInRing(pt, ring) {
  const [y, x] = pt; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function ringAreaDeg(ring) { // relative shoelace area — only used to rank "smallest"
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][1] * ring[i][0] - ring[i][1] * ring[j][0];
  }
  return Math.abs(a / 2);
}

// ── parse OSM elements → polygons[] {name, ring, area} + nodes[] {name,lat,lng}
function parseOSM(elements) {
  const polygons = [], nodes = [];
  for (const el of elements) {
    const name = el.tags?.name;
    if (!name) continue;
    if (el.type === 'node') {
      nodes.push({ name, lat: el.lat, lng: el.lon });
    } else if (el.type === 'way' && Array.isArray(el.geometry)) {
      const ring = el.geometry.map(g => [g.lat, g.lon]);
      if (ring.length >= 4) polygons.push({ name, ring, area: ringAreaDeg(ring) });
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      // multipolygon: each outer-role member way contributes a ring
      for (const m of el.members) {
        if (m.type === 'way' && (m.role === 'outer' || !m.role) && Array.isArray(m.geometry) && m.geometry.length >= 4) {
          const ring = m.geometry.map(g => [g.lat, g.lon]);
          polygons.push({ name, ring, area: ringAreaDeg(ring) });
        }
      }
    }
  }
  // smallest polygons first so the FINEST containing neighborhood wins
  polygons.sort((a, b) => a.area - b.area);
  return { polygons, nodes };
}

// venue's self-named neighborhood = longest OSM place name contained in its name
function selfNamed(venueName, placeNames) {
  const hay = ' ' + venueName.toLowerCase().replace(/[-–,.]/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const n of placeNames) {
    const esc = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^| )' + esc + '( |$)').test(hay)) return n;
  }
  return '';
}

(async () => {
  console.log('── assign-fine-areas (OSM, review-only) ──────────────────');
  const elements = await fetchOSM();
  const { polygons, nodes } = parseOSM(elements);
  console.log(`  neighborhoods: ${polygons.length} polygon rings, ${nodes.length} place nodes`);
  const allNames = [...new Set([...polygons, ...nodes].map(p => p.name))].sort();
  console.log(`  ${allNames.length} distinct suburb-tier names (the source granularity):`);
  console.log('   ' + allNames.join(', '));
  // gazetteer of names, longest first (multi-word wins)
  const placeNames = [...allNames].sort((a, b) => b.length - a.length);

  const rows = [];
  const counts = { polygon: 0, node: 0, none: 0, conflict: 0, selfOnly: 0 };
  for (const v of venues) {
    const coords = v.coords || (v.lat != null ? [v.lat, v.lng] : null);
    let computed = '', method = 'none', dist = null;
    if (coords) {
      const hit = polygons.find(p => pointInRing(coords, p.ring)); // smallest-first
      if (hit) { computed = hit.name; method = 'polygon'; }
      else {
        let best = null, bd = Infinity;
        for (const n of nodes) { const d = haversine(coords, [n.lat, n.lng]); if (d < bd) { bd = d; best = n; } }
        if (best && bd <= NODE_FALLBACK_MAX_M) { computed = best.name; method = 'node'; dist = Math.round(bd); }
      }
    }
    counts[method]++;
    let named = selfNamed(v.name || '', placeNames);
    // Coordinate sanity-check: a real self-named neighborhood is near the
    // venue. If the nearest node of that name is far, the word is a brand
    // coincidence (chain name == neighborhood name) — don't let it override.
    if (named && coords) {
      let nd = Infinity;
      for (const n of nodes) if (n.name === named) nd = Math.min(nd, haversine(coords, [n.lat, n.lng]));
      if (nd > SELF_NAME_MAX_M) { named = ''; counts.nameCoincidence = (counts.nameCoincidence || 0) + 1; }
    }
    // priority rule: the venue's self-named neighborhood wins on conflict
    let final = computed, source = method;
    if (named) {
      if (computed && named !== computed) { counts.conflict++; final = named; source = 'name-override'; }
      else if (!computed) { counts.selfOnly++; final = named; source = 'name-only'; }
      else { final = named; source = 'name=computed'; }
    }
    rows.push({
      id: v.id, name: v.name, coarse: v.area || '',
      computedFine: computed, method, distM: dist,
      selfNamed: named, finalFine: final && final !== v.area ? final : '',
      conflict: !!(named && computed && named !== computed),
    });
  }

  const outPath = join(ROOT, 'data', 'area-assign-review.json');
  writeFileSync(outPath, JSON.stringify(rows, null, 2));

  const conflicts = rows.filter(r => r.conflict);
  const withFine = rows.filter(r => r.finalFine);
  console.log(`\n  assigned by polygon : ${counts.polygon}`);
  console.log(`  assigned by node    : ${counts.node}  (≤ ${NODE_FALLBACK_MAX_M} m)`);
  console.log(`  no coordinate match : ${counts.none}`);
  console.log(`  venues with a final fine neighborhood : ${withFine.length}/${venues.length}`);
  console.log(`  self-names ignored as brand coincidence : ${counts.nameCoincidence || 0}`);
  console.log(`\n  ⚠ CONFLICTS (name ≠ polygon/node) — review these (${conflicts.length}):`);
  for (const c of conflicts.slice(0, 40)) console.log(`     ${c.name.padEnd(38)} name=${c.selfNamed.padEnd(16)} computed=${c.computedFine}`);
  if (conflicts.length > 40) console.log(`     …and ${conflicts.length - 40} more`);
  console.log(`\n  → wrote ${outPath} (review; venues.json untouched)`);
  console.log('  next: review conflicts together, then decide on --apply (writes areaFine).');
})();
