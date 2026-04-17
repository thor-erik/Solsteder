/**
 * fetch-venues-places.mjs
 * Discovers restaurant/bar/cafe venues with outdoor terraces across Oslo
 * from the Google Places API.
 *
 * Strategy (union of two signals to minimise false negatives):
 *   A) Places API v1 Nearby Search — field mask includes outdoorSeating.
 *      Keep venues where outdoorSeating === true.
 *   B) Places API v1 Text Search — keyword "uteservering" per area.
 *      Keep all results (keyword implies outdoor seating context).
 *   Deduplicates by place_id across both passes.
 *
 * Coverage: 20 anchor points across all Oslo districts (full municipality).
 *
 * Usage:   node scripts/fetch-venues-places.mjs
 * Output:  data/venues-fetched.json  (review before merging)
 * Cost:    ~$1.50–3 (one-time, well within free $200/mo credit)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── API key ───────────────────────────────────────────────────────────────────
const env      = readFileSync(join(ROOT, '.env'), 'utf8');
const keyMatch = env.match(/GOOGLE_PLACES_KEY=(.+)/);
if (!keyMatch) { console.error('GOOGLE_PLACES_KEY not found in .env'); process.exit(1); }
const API_KEY = keyMatch[1].trim();

// ── Search config ─────────────────────────────────────────────────────────────
// 20 anchor points covering all Oslo municipality districts
const SEARCH_POINTS = [
  // Ring 2 core (existing coverage, kept for density)
  { lat: 59.9138, lng: 10.7387, area: 'Sentrum' },
  { lat: 59.9235, lng: 10.7340, area: 'Grünerløkka' },
  { lat: 59.9175, lng: 10.7600, area: 'Grønland' },
  { lat: 59.9200, lng: 10.7180, area: 'Bislett' },
  { lat: 59.9080, lng: 10.7220, area: 'Frogner' },
  { lat: 59.9060, lng: 10.7490, area: 'Aker Brygge' },

  // Oslo north / inner east
  { lat: 59.9310, lng: 10.7560, area: 'Sagene' },
  { lat: 59.9390, lng: 10.7460, area: 'Nydalen' },
  { lat: 59.9270, lng: 10.7730, area: 'Tøyen' },
  { lat: 59.9330, lng: 10.7900, area: 'Sinsen' },

  // Oslo west
  { lat: 59.9280, lng: 10.6780, area: 'Majorstuen' },
  { lat: 59.9350, lng: 10.6620, area: 'Vindern' },
  { lat: 59.9040, lng: 10.6940, area: 'Skøyen' },
  { lat: 59.8980, lng: 10.6620, area: 'Ullern' },

  // Oslo east
  { lat: 59.9120, lng: 10.8180, area: 'Helsfyr' },
  { lat: 59.9000, lng: 10.8400, area: 'Bryn' },
  { lat: 59.8820, lng: 10.8100, area: 'Østensjø' },

  // Oslo south
  { lat: 59.8680, lng: 10.7760, area: 'Nordstrand' },
  { lat: 59.8560, lng: 10.7560, area: 'Ljan' },
  { lat: 59.8750, lng: 10.7280, area: 'Nordstrand vest' },
];

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
 * Text Search for "uteservering" restricted to a circle around the point.
 * Returns up to 20 results. No pagination needed for this use case.
 */
async function textSearchUteservering(lat, lng, area) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.outdoorSeating,places.businessStatus',
    },
    body: JSON.stringify({
      textQuery:          `uteservering ${area} Oslo`,
      locationBias: {
        circle: { center: { latitude: lat, longitude: lng }, radius: RADIUS * 1.5 },
      },
      includedType:   'restaurant',
      maxResultCount: 20,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Text Search HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.places ?? [];
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

// ── Main ──────────────────────────────────────────────────────────────────────

// seen: place_id → { place, area, signal }
// signal: 'outdoorSeating' | 'uteservering' | 'both'
const seen = new Map();

console.log('Pass A: Nearby Search with outdoorSeating filter…\n');
for (const point of SEARCH_POINTS) {
  process.stdout.write(`  ${point.area} … `);
  try {
    const places = await nearbySearchV1(point.lat, point.lng);
    let added = 0;
    for (const p of places) {
      if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
      if (!p.outdoorSeating) continue; // only keep explicit outdoor seating
      if (!seen.has(p.id)) {
        seen.set(p.id, { place: p, area: point.area, signal: 'outdoorSeating' });
        added++;
      }
    }
    console.log(`${places.length} results, ${added} with outdoorSeating`);
  } catch (err) {
    console.warn(`error: ${err.message}`);
  }
  await sleep(200);
}

console.log('\nPass B: Text Search "uteservering" per area…\n');
for (const point of SEARCH_POINTS) {
  process.stdout.write(`  ${point.area} … `);
  try {
    const places = await textSearchUteservering(point.lat, point.lng, point.area);
    let added = 0;
    for (const p of places) {
      if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
      if (!seen.has(p.id)) {
        seen.set(p.id, { place: p, area: point.area, signal: 'uteservering' });
        added++;
      } else {
        // Already found via outdoorSeating — mark as both signals
        seen.get(p.id).signal = 'both';
      }
    }
    console.log(`${places.length} results, ${added} new`);
  } catch (err) {
    console.warn(`error: ${err.message}`);
  }
  await sleep(200);
}

console.log(`\nTotal unique candidates: ${seen.size}. Fetching opening hours…\n`);

// Load existing venues to avoid re-assigning IDs to known places
const existingPath   = join(ROOT, 'data/venues.json');
const existingVenues = JSON.parse(readFileSync(existingPath, 'utf8'));
const existingIds    = new Set(existingVenues.map(v => v.googlePlaceId).filter(Boolean));
let nextId = Math.max(...existingVenues.map(v => v.id)) + 1;

const venues = [];
let i = 0;
for (const [placeId, { place: p, area, signal }] of seen) {
  i++;
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

  const loc = p.location ?? {};
  venues.push({
    id:                 nextId++,
    name:               p.displayName?.text ?? '',
    address:            p.formattedAddress ?? '',
    coords:             [loc.latitude ?? 0, loc.longitude ?? 0],
    category:           categoryFromTypes(p.types ?? []),
    area,
    rating:             p.rating ?? null,
    facing:             null,       // computed by update-geometry.mjs
    openingHours,
    openingHoursWeekly: openingHoursWeekly ?? undefined,
    buildingOsmId:      null,
    googlePlaceId:      placeId,
    facingSource:       null,
    discoverySignal:    signal,     // 'outdoorSeating' | 'uteservering' | 'both'
  });

  console.log(`done (signal: ${signal})`);
}

const outPath = join(ROOT, 'data/venues-fetched.json');
writeFileSync(outPath, JSON.stringify(venues, null, 2));

const bySignal = venues.reduce((acc, v) => {
  acc[v.discoverySignal] = (acc[v.discoverySignal] ?? 0) + 1;
  return acc;
}, {});

console.log(`
Wrote ${venues.length} new candidates → data/venues-fetched.json
  outdoorSeating only: ${bySignal.outdoorSeating ?? 0}
  uteservering only:   ${bySignal.uteservering ?? 0}
  both signals:        ${bySignal.both ?? 0}

Review the file, then run scripts/merge-venues.mjs to merge into venues.json.
Remember to run scripts/update-geometry.mjs after merging.
`);
