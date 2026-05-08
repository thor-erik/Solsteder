/**
 * fetch-venues-places.mjs
 * Discovers restaurant/bar/cafe venues with outdoor terraces across Oslo
 * from the Google Places API + OSM.
 *
 * Strategy (union of three signals to minimise false negatives):
 *   A) Places API v1 Nearby Search — field mask includes outdoorSeating.
 *      Keep venues where outdoorSeating === true.
 *   B) Places API v1 Text Search — keyword "uteservering" per area.
 *      Up to 60 results per anchor (3 paginated pages).
 *   C) Overpass — venues tagged outdoor_seating=yes, resolved to a
 *      Google place via Text Search.
 *   Deduplicates by place_id across all passes.
 *
 * Coverage: anchor grid is built from data/oslo-candidates.json — one
 * anchor per 1.2 km cell with at least 2 candidates (~62 anchors covering
 * 97.5% of the OSM+Google universe). Falls back to a 20-point manual
 * list if the candidates file is missing.
 *
 * Usage:   node scripts/fetch-oslo-candidates.mjs   # refresh universe (free, OSM)
 *          node scripts/fetch-venues-places.mjs
 * Output:  data/venues-fetched.json  (review before merging)
 * Cost:    ~$15–25 (under the $200/mo free credit; run periodically)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { assignArea } from './lib/areas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── API key ───────────────────────────────────────────────────────────────────
const env      = readFileSync(join(ROOT, '.env'), 'utf8');
const keyMatch = env.match(/GOOGLE_PLACES_KEY=(.+)/);
if (!keyMatch) { console.error('GOOGLE_PLACES_KEY not found in .env'); process.exit(1); }
const API_KEY = keyMatch[1].trim();

// ── Search config ─────────────────────────────────────────────────────────────

// Seed anchors — used (a) to provide area names for the auto-generated grid,
// (b) as a fallback if data/oslo-candidates.json is missing.
const SEED_ANCHORS = [
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

// Cell size (degrees) ≈ 1.2 km × 1.2 km at Oslo latitude.
const CELL_LAT = 0.011;
const CELL_LNG = 0.022;
const MIN_CANDIDATES_PER_CELL = 2;

function buildSearchPoints() {
  const candPath = join(ROOT, 'data/oslo-candidates.json');
  let candidates;
  try {
    candidates = JSON.parse(readFileSync(candPath, 'utf8'));
  } catch (_) {
    console.warn('  oslo-candidates.json missing — using 20 seed anchors only.');
    console.warn('  Run `node scripts/fetch-oslo-candidates.mjs` first for full coverage.\n');
    return SEED_ANCHORS;
  }

  const cells = new Map();
  for (const c of candidates) {
    const key = `${Math.floor(c.lat / CELL_LAT)}|${Math.floor(c.lng / CELL_LNG)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(c);
  }

  const points = [];
  for (const list of cells.values()) {
    if (list.length < MIN_CANDIDATES_PER_CELL) continue;
    const lat = list.reduce((s, c) => s + c.lat, 0) / list.length;
    const lng = list.reduce((s, c) => s + c.lng, 0) / list.length;
    const { area } = assignArea([lat, lng]);
    points.push({ lat, lng, area, candidateCount: list.length });
  }
  points.sort((a, b) => b.candidateCount - a.candidateCount);
  console.log(`  Built ${points.length} dense anchors from ${candidates.length} candidates`);
  console.log(`  (${CELL_LAT.toFixed(3)}° × ${CELL_LNG.toFixed(3)}° cells, min ${MIN_CANDIDATES_PER_CELL} candidates per cell)\n`);
  return points;
}

console.log('Building anchor grid…');
const SEARCH_POINTS = buildSearchPoints();

const RADIUS = 900; // metres
const INCLUDED_TYPES = ['restaurant', 'bar', 'cafe'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Places API v1 helpers ─────────────────────────────────────────────────────

/**
 * Nearby Search (Places API v1).
 * Returns up to 20 results per call. No pagination in v1 Nearby Search.
 * Field mask requests outdoorSeating so we can filter on it.
 */
async function nearbySearchV1(lat, lng) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.outdoorSeating,places.businessStatus',
    },
    body: JSON.stringify({
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: RADIUS },
      },
      includedTypes:  INCLUDED_TYPES,
      rankPreference: 'DISTANCE',
      maxResultCount: 20,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Nearby Search HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.places ?? [];
}

/**
 * Text Search for a Norwegian outdoor-seating keyword restricted to a
 * circle around the point. Paginates up to 3 pages (60 results).
 * Google requires a brief delay between page requests.
 */
async function textSearchKeyword(lat, lng, area, keyword) {
  const all = [];
  let pageToken;
  for (let page = 0; page < 3; page++) {
    // searchText (unlike searchNearby) doesn't support
    // excludedPrimaryTypes — adding it returns HTTP 400. Post-response
    // hasFoodType() filtering is the only option for Pass B.
    const body = {
      textQuery:      `${keyword} ${area} Oslo`,
      locationBias:   { circle: { center: { latitude: lat, longitude: lng }, radius: RADIUS * 1.5 } },
      maxResultCount: 20,
    };
    if (pageToken) body.pageToken = pageToken;
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.outdoorSeating,places.businessStatus,nextPageToken',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`Text Search HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    all.push(...(data.places ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    await sleep(1500);
  }
  return all;
}

/**
 * Fetch opening hours for a place (Contact tier only — cheapest).
 */
async function fetchOpeningHours(placeId) {
  const resp = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key':   API_KEY,
      'X-Goog-FieldMask': 'regularOpeningHours',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const periods = data.regularOpeningHours?.periods;
  if (!periods?.length) return null;

  const weekly = {};
  for (const p of periods) {
    if (!p.open || !p.close) continue;
    const day    = String(p.open.day); // 0=Sun
    const openH  = p.open.hour  + (p.open.minute  ?? 0) / 60;
    let   closeH = p.close.hour + (p.close.minute ?? 0) / 60;
    if (closeH === 0 && p.close.day !== p.open.day) closeH = 24;
    weekly[day] = { open: Math.round(openH * 10) / 10, close: Math.round(closeH * 10) / 10 };
  }
  if (!Object.keys(weekly).length) return null;

  const opens  = Object.values(weekly).map(h => h.open);
  const closes = Object.values(weekly).map(h => h.close);
  return { open: Math.min(...opens), close: Math.max(...closes), weekly };
}

function categoryFromTypes(types = []) {
  if (types.includes('bar'))        return 'bar';
  if (types.includes('cafe'))       return 'cafe';
  if (types.includes('restaurant')) return 'restaurant';
  return 'restaurant';
}

// Whitelist of Google Places API v1 types that indicate a food/drink
// venue. Verified against
// https://developers.google.com/maps/documentation/places/web-service/place-types
// (Table A — Eating and Drinking). The post-response check is the only
// type filter for Pass B since searchText doesn't support
// excludedPrimaryTypes.
const FOOD_TYPES = new Set([
  // Core
  'restaurant', 'bar', 'cafe', 'pub', 'food',
  // Quick-service / casual
  'bakery', 'coffee_shop', 'fast_food_restaurant', 'meal_takeaway',
  'meal_delivery', 'sandwich_shop', 'cafeteria', 'food_court', 'deli',
  'diner', 'juice_shop', 'donut_shop', 'bagel_shop',
  // Specialty
  'wine_bar', 'night_club', 'tea_house', 'ice_cream_shop',
  'dessert_shop', 'dessert_restaurant', 'bar_and_grill',
  'breakfast_restaurant', 'brunch_restaurant', 'buffet_restaurant',
  'fine_dining_restaurant', 'bbq_restaurant', 'steak_house',
  'cat_cafe', 'dog_cafe',
  // Harmless legacy / informal types — not currently in v1 Table A but
  // included as a safety net in case Google adds them or returns them
  // for international venues.
  'biergarten', 'pizzeria', 'brewery', 'gastropub', 'bistro',
]);

function hasFoodType(types = []) {
  // The _restaurant suffix catches all cuisine-specific variants
  // (italian_restaurant, sushi_restaurant, etc.) without listing them.
  return types.some(t => FOOD_TYPES.has(t) || t.endsWith('_restaurant'));
}

// (Originally tried server-side exclusion via excludedPrimaryTypes, but
// that field is only supported by searchNearby — searchText returns
// HTTP 400. Post-response hasFoodType() carries the filter for Pass B.)

// ── OSM outdoor_seating=yes (free signal, complements Google) ─────────────────

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
const OSM_OUTDOOR_QUERY = `
[out:json][timeout:120];
area["name"="Oslo"]["admin_level"="4"]->.oslo;
(
  node["outdoor_seating"="yes"](area.oslo);
  way["outdoor_seating"="yes"](area.oslo);
);
out center tags;
`;

async function fetchOSMOutdoor() {
  for (const ep of OVERPASS_ENDPOINTS) {
    process.stdout.write(`  Overpass ${ep} … `);
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'Solsteder/1.0 (github.com/thor-erik/Solsteder)',
        },
        body: 'data=' + encodeURIComponent(OSM_OUTDOOR_QUERY),
        signal: AbortSignal.timeout(150_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      console.log(`${data.elements.length} elements`);
      return data.elements
        .filter(el => el.tags?.name)
        .map(el => ({
          name:    el.tags.name,
          lat:     el.type === 'node' ? el.lat : el.center?.lat,
          lng:     el.type === 'node' ? el.lon : el.center?.lon,
          amenity: el.tags.amenity,
          osmId:   `${el.type}/${el.id}`,
        }))
        .filter(x => x.lat && x.lng);
    } catch (err) {
      console.log(`failed (${err.message})`);
      await sleep(5_000);
    }
  }
  return null;
}

/**
 * Resolve an OSM venue (name + coords) to a Google Place via Text Search.
 * Returns the matched place or null.
 *
 * Uses locationRestriction (a hard 250 m circle) instead of locationBias
 * (a soft hint). For chain venues like "Los Tacos" with 10 branches in
 * Oslo, locationBias caused the response to collapse to the most-popular
 * branch — the specific OSM coords didn't make the top-5. With
 * locationRestriction Google can only return places inside the circle,
 * so each branch resolves independently. maxResultCount bumped to 20 to
 * give a fair chance of finding a food-typed match in dense blocks.
 */
async function resolveOSMToGoogle(osmVenue) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.outdoorSeating,places.businessStatus',
    },
    body: JSON.stringify({
      textQuery: `${osmVenue.name} Oslo`,
      locationRestriction: {
        circle: { center: { latitude: osmVenue.lat, longitude: osmVenue.lng }, radius: 250 },
      },
      maxResultCount: 20,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const candidates = data.places ?? [];
  // Pick the closest food/drink result within 150 m of the OSM
  // coordinates. The food-type filter avoids false matches when the
  // text search lands on a similarly-named parking lot or building.
  let best = null;
  let bestDist = Infinity;
  for (const p of candidates) {
    if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
    if (!hasFoodType(p.types)) continue;
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    if (lat == null || lng == null) continue;
    const dLat = (lat - osmVenue.lat) * 111_000;
    const dLng = (lng - osmVenue.lng) * 55_000;
    const d    = Math.hypot(dLat, dLng);
    if (d < 150 && d < bestDist) { best = p; bestDist = d; }
  }
  return best;
}

const normName = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function metresBetween(a, b) {
  const dLat = (a[0] - b[0]) * 111_000;
  const dLng = (a[1] - b[1]) * 55_000;
  return Math.hypot(dLat, dLng);
}

// ── Main ──────────────────────────────────────────────────────────────────────

// seen: place_id → { place, area, sources: Set<'outdoorSeating'|'uteservering'|'osm'> }
const seen = new Map();
const addSignal = (id, place, area, source) => {
  const e = seen.get(id);
  if (e) { e.sources.add(source); return false; }
  seen.set(id, { place, area, sources: new Set([source]) });
  return true;
};

// Counter for the post-filter so we can see how much noise is being dropped.
let droppedNonFood = 0;

console.log('Pass A: Nearby Search with outdoorSeating filter…\n');
for (const point of SEARCH_POINTS) {
  process.stdout.write(`  ${point.area} … `);
  try {
    const places = await nearbySearchV1(point.lat, point.lng);
    let added = 0;
    for (const p of places) {
      if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
      if (!p.outdoorSeating) continue; // only keep explicit outdoor seating
      if (!hasFoodType(p.types)) { droppedNonFood++; continue; }
      if (addSignal(p.id, p, point.area, 'outdoorSeating')) added++;
    }
    console.log(`${places.length} results, ${added} with outdoorSeating`);
  } catch (err) {
    console.warn(`error: ${err.message}`);
  }
  await sleep(200);
}

// Norwegian outdoor-seating vocabulary. Each keyword catches a different
// cluster of venues — uteservering is canonical, the others surface
// rooftops, courtyards, and venues described with non-standard wording.
const KEYWORDS = ['uteservering', 'terrasse', 'bakgård', 'takterrasse'];

console.log(`\nPass B: Text Search × ${KEYWORDS.length} keywords (${KEYWORDS.join(', ')})…\n`);
for (const keyword of KEYWORDS) {
  console.log(`  Keyword: "${keyword}"`);
  for (const point of SEARCH_POINTS) {
    process.stdout.write(`    ${point.area} … `);
    try {
      const places = await textSearchKeyword(point.lat, point.lng, point.area, keyword);
      let added = 0;
      for (const p of places) {
        if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        if (!hasFoodType(p.types)) { droppedNonFood++; continue; }
        if (addSignal(p.id, p, point.area, keyword)) added++;
      }
      console.log(`${places.length} results, ${added} new`);
    } catch (err) {
      console.warn(`error: ${err.message}`);
    }
    await sleep(200);
  }
}

console.log('\nPass C: OSM outdoor_seating=yes (resolved via Google Text Search)…\n');
const existingForMatch = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'));
const osmUnresolvedList = []; // OSM venues we couldn't resolve to a Google place
const osmVenues = await fetchOSMOutdoor();
if (!osmVenues) {
  console.log('  Overpass unavailable, skipping Pass C.');
} else {
  // Skip OSM venues already in our DB by name+coord proximity.
  const inExisting = osm => existingForMatch.some(v => {
    const d = metresBetween([osm.lat, osm.lng], v.coords);
    if (d < 25) return true;
    if (d < 150 && normName(v.name) === normName(osm.name)) return true;
    return false;
  });
  // Skip OSM venues that match a Google place already in `seen` (by coords + name).
  const inSeen = osm => {
    for (const { place: p } of seen.values()) {
      const lat = p.location?.latitude;
      const lng = p.location?.longitude;
      if (lat == null || lng == null) continue;
      const d = metresBetween([osm.lat, osm.lng], [lat, lng]);
      if (d < 25) return true;
      if (d < 150 && normName(p.displayName?.text ?? '') === normName(osm.name)) return true;
    }
    return false;
  };

  let resolved = 0, alreadyKnown = 0, addedNew = 0, unresolved = 0;
  let j = 0;
  for (const osm of osmVenues) {
    j++;
    if (inExisting(osm)) { alreadyKnown++; continue; }
    if (inSeen(osm))     { alreadyKnown++; continue; }
    process.stdout.write(`  [${j}/${osmVenues.length}] ${osm.name} … `);
    try {
      const match = await resolveOSMToGoogle(osm);
      if (match) {
        resolved++;
        const wasNew = addSignal(match.id, match, 'OSM', 'osm');
        if (wasNew) { addedNew++; console.log('resolved → new'); }
        else        { console.log('resolved → already in seen'); }
      } else {
        unresolved++;
        osmUnresolvedList.push(osm);
        console.log('no Google match within 150 m');
      }
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
    await sleep(150);
  }
  console.log(`\n  OSM outdoor_seating venues:    ${osmVenues.length}`);
  console.log(`  Already in venues.json or seen: ${alreadyKnown}`);
  console.log(`  Resolved to Google place:       ${resolved}`);
  console.log(`  Added (new place ID):           ${addedNew}`);
  console.log(`  Unresolved (no nearby Google):  ${unresolved}`);
}

console.log(`\nTotal unique candidates: ${seen.size}. Fetching opening hours…\n`);

const existingIds = new Set(existingForMatch.map(v => v.googlePlaceId).filter(Boolean));
let nextId = Math.max(...existingForMatch.map(v => v.id)) + 1;

const venues = [];
let i = 0;
for (const [placeId, { place: p, area, sources }] of seen) {
  i++;
  const signal = [...sources].sort().join(',');

  // Skip venues already in venues.json (they're managed by refresh-opening-hours.mjs)
  if (existingIds.has(placeId)) {
    process.stdout.write(`  [${i}/${seen.size}] ${p.displayName?.text} — already in venues.json, skipped\n`);
    continue;
  }

  process.stdout.write(`  [${i}/${seen.size}] ${p.displayName?.text} … `);

  let openingHours = { open: 11, close: 23 };
  let openingHoursWeekly = null;
  try {
    const hours = await fetchOpeningHours(placeId);
    if (hours) {
      openingHours       = { open: hours.open, close: hours.close };
      openingHoursWeekly = hours.weekly;
    }
  } catch (_) { /* keep default */ }
  await sleep(100);

  const loc    = p.location ?? {};
  const coords = [loc.latitude ?? 0, loc.longitude ?? 0];
  // Reverse-geocode area from venue coords (not the anchor's area) so the
  // tag reflects where the venue actually is.
  const venueArea = assignArea(coords).area ?? area;
  venues.push({
    id:                 nextId++,
    name:               p.displayName?.text ?? '',
    address:            p.formattedAddress ?? '',
    coords,
    category:           categoryFromTypes(p.types ?? []),
    area:               venueArea,
    rating:             p.rating ?? null,
    facing:             null,       // computed by update-geometry.mjs
    openingHours,
    openingHoursWeekly: openingHoursWeekly ?? undefined,
    buildingOsmId:      null,
    googlePlaceId:      placeId,
    facingSource:       null,
    discoverySignal:    signal,     // sorted CSV of sources: 'outdoorSeating', 'uteservering', 'osm', or any combination
  });

  console.log(`done (signal: ${signal})`);
}

// ── Partition by confidence ───────────────────────────────────────────────────
// HIGH: Google explicitly flags outdoorSeating, OR ≥2 independent signals
//       (e.g. uteservering+terrasse, or osm+uteservering).
// LOW:  single weak signal — needs human review before merging.
const isHighConfidence = v => {
  const sigs = v.discoverySignal.split(',');
  return sigs.includes('outdoorSeating') || sigs.length >= 2;
};
const high   = venues.filter(isHighConfidence);
const review = venues.filter(v => !isHighConfidence(v));

writeFileSync(join(ROOT, 'data/venues-fetched.json'),        JSON.stringify(high,             null, 2));
writeFileSync(join(ROOT, 'data/venues-review.json'),         JSON.stringify(review,           null, 2));
writeFileSync(join(ROOT, 'data/venues-osm-unresolved.json'), JSON.stringify(osmUnresolvedList, null, 2));

// Provenance metadata for the discovery run — useful for the audit
// script and for spotting stale data.
const meta = {
  lastDiscoveryRun: new Date().toISOString(),
  runStats: {
    anchors:           SEARCH_POINTS.length,
    keywords:          KEYWORDS,
    seenUnique:        seen.size,
    highConfidence:    high.length,
    reviewQueue:       review.length,
    osmUnresolved:     osmUnresolvedList.length,
  },
};
writeFileSync(join(ROOT, 'data/discovery.meta.json'), JSON.stringify(meta, null, 2));

const bySignal = venues.reduce((acc, v) => {
  acc[v.discoverySignal] = (acc[v.discoverySignal] ?? 0) + 1;
  return acc;
}, {});

console.log(`\n━━━ Discovery output ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  High confidence  → data/venues-fetched.json:        ${high.length}`);
console.log(`  Review needed    → data/venues-review.json:         ${review.length}`);
console.log(`  OSM unresolved   → data/venues-osm-unresolved.json: ${osmUnresolvedList.length}`);
console.log(`  (Filtered out ${droppedNonFood} non-food results — parking lots, parks, etc.)`);
console.log(`\nBreakdown by discoverySignal:`);
for (const [s, n] of Object.entries(bySignal).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(40)} ${n}`);
}
console.log(`
Next steps:
  1. Spot-check data/venues-review.json — single-signal hits are
     more likely false positives. Promote keepers to venues-fetched.json.
  2. data/venues-osm-unresolved.json lists OSM-tagged terraces with no
     Google match within 150 m — submit as Google suggestions or add
     manually.
  3. node scripts/merge-venues.mjs       # merges venues-fetched.json
  4. node scripts/update-geometry.mjs    # recomputes building facing
`);
