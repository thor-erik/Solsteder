#!/usr/bin/env node
/**
 * backfill-from-osm.mjs
 * Targeted backfill for known venues that the discovery pipeline misses.
 *
 * Reads data/backfill-input.json — an array of `{ name, lat, lng, [area] }`
 * stubs (typically derived from OSM by hand) — and adds each to
 * venues.json with as much detail as we can resolve via Google Places.
 *
 * Each stub:
 *   1. Skipped if a venue at coords ±50 m already exists in venues.json.
 *   2. Resolved to a Google Place ID via Text Search (tight 80 m bias).
 *   3. Validated against the food-type whitelist (rejects non-food
 *      collisions).
 *   4. Added to venues.json with discoverySignal: 'manual-backfill'.
 *
 * After this runs, follow up with:
 *   - node scripts/fetch-photos.mjs        # photos + any missing place IDs
 *   - node scripts/refresh-opening-hours.mjs  # opening hours
 *   - node scripts/update-geometry.mjs     # facing + building polygon
 *
 * Usage:  node scripts/backfill-from-osm.mjs
 * Requires: GOOGLE_PLACES_KEY (or _SERVER) in .env
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { assignArea } from './lib/areas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const env = readFileSync(join(ROOT, '.env'), 'utf8');
const serverMatch = env.match(/GOOGLE_PLACES_KEY_SERVER=(.+)/) || env.match(/GOOGLE_PLACES_SERVER_KEY=(.+)/);
const clientMatch = env.match(/GOOGLE_PLACES_KEY=(.+)/);
const keyMatch = serverMatch || clientMatch;
if (!keyMatch) { console.error('GOOGLE_PLACES_KEY_SERVER (or GOOGLE_PLACES_KEY) not found in .env'); process.exit(1); }
const API_KEY = keyMatch[1].trim();

const FOOD_TYPES = new Set([
  'restaurant', 'bar', 'cafe', 'pub', 'food',
  'bakery', 'coffee_shop', 'fast_food_restaurant', 'meal_takeaway',
  'meal_delivery', 'sandwich_shop', 'cafeteria', 'food_court', 'deli',
  'diner', 'juice_shop', 'donut_shop', 'bagel_shop',
  'wine_bar', 'night_club', 'tea_house', 'ice_cream_shop',
  'dessert_shop', 'dessert_restaurant', 'bar_and_grill',
  'breakfast_restaurant', 'brunch_restaurant', 'buffet_restaurant',
  'fine_dining_restaurant', 'bbq_restaurant', 'steak_house',
  'cat_cafe', 'dog_cafe',
  'biergarten', 'pizzeria', 'brewery', 'gastropub', 'bistro',
]);
const hasFoodType = types => types.some(t => FOOD_TYPES.has(t) || t.endsWith('_restaurant'));
const categoryFromTypes = types => {
  if (types.includes('bar'))        return 'bar';
  if (types.includes('cafe'))       return 'cafe';
  if (types.includes('pub'))        return 'pub';
  return 'restaurant';
};

function metresBetween(a, b) {
  const dLat = (a[0] - b[0]) * 111_000;
  const dLng = (a[1] - b[1]) * 55_000;
  return Math.hypot(dLat, dLng);
}

async function resolveOSMVenue(stub) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.businessStatus',
    },
    body: JSON.stringify({
      textQuery:    `${stub.name} Oslo`,
      locationBias: { circle: { center: { latitude: stub.lat, longitude: stub.lng }, radius: 80 } },
      maxResultCount: 5,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Text Search HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const candidates = data.places ?? [];
  let best = null, bestDist = Infinity;
  for (const p of candidates) {
    if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
    if (!hasFoodType(p.types ?? [])) continue;
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    if (lat == null || lng == null) continue;
    const d = metresBetween([stub.lat, stub.lng], [lat, lng]);
    if (d < 100 && d < bestDist) { best = p; bestDist = d; }
  }
  return best;
}

const inputPath  = join(ROOT, 'data/backfill-input.json');
const venuesPath = join(ROOT, 'data/venues.json');

const stubs   = JSON.parse(readFileSync(inputPath,  'utf8'));
const venues  = JSON.parse(readFileSync(venuesPath, 'utf8'));
const existingIds = new Set(venues.map(v => v.googlePlaceId).filter(Boolean));
let nextId = Math.max(...venues.map(v => v.id)) + 1;

console.log(`Resolving ${stubs.length} stubs against Google Places…\n`);
const added = [], skipped = [];

for (const stub of stubs) {
  process.stdout.write(`  ${stub.name} (${stub.lat.toFixed(4)}, ${stub.lng.toFixed(4)}) … `);

  // 1. Already in venues.json by name + coord proximity?
  // Coord-alone matching is too aggressive — multiple unrelated venues
  // share an address (ground-floor restaurant + cellar bar). Require the
  // names to share a substring before treating as a duplicate.
  const stubNorm = stub.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const dupeByCoord = venues.find(v => {
    if (metresBetween([stub.lat, stub.lng], v.coords) >= 50) return false;
    const vNorm = v.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return vNorm.includes(stubNorm) || stubNorm.includes(vNorm);
  });
  if (dupeByCoord) {
    console.log(`already exists as "${dupeByCoord.name}" — skipped`);
    skipped.push({ ...stub, reason: 'duplicate-coords', existing: dupeByCoord.name });
    continue;
  }

  // 2. Resolve via Google
  let match;
  try { match = await resolveOSMVenue(stub); }
  catch (err) { console.log(`error: ${err.message}`); skipped.push({ ...stub, reason: 'api-error' }); continue; }

  if (!match) { console.log('no Google match within 100 m'); skipped.push({ ...stub, reason: 'unresolved' }); continue; }

  // 3. Already in venues.json by Place ID?
  if (existingIds.has(match.id)) {
    const existing = venues.find(v => v.googlePlaceId === match.id);
    console.log(`Place ID already in venues.json as "${existing.name}" — skipped`);
    skipped.push({ ...stub, reason: 'duplicate-place-id', existing: existing.name });
    continue;
  }

  // 4. Build venue record
  const loc        = match.location;
  const matchedName = match.displayName?.text ?? stub.name;
  const { area }   = assignArea([loc.latitude, loc.longitude]);

  const venue = {
    id:                 nextId++,
    name:               matchedName,
    address:            match.formattedAddress ?? '',
    coords:             [loc.latitude, loc.longitude],
    category:           categoryFromTypes(match.types ?? []),
    area:               stub.area ?? area ?? 'Oslo',
    rating:             match.rating ?? null,
    facing:             null,
    openingHours:       { open: 11, close: 23 },
    buildingOsmId:      null,
    googlePlaceId:      match.id,
    facingSource:       null,
    discoverySignal:    'manual-backfill',
    businessStatus:     match.businessStatus ?? 'OPERATIONAL',
  };
  venues.push(venue);
  existingIds.add(match.id);
  added.push(venue);
  console.log(`added id=${venue.id} → ${matchedName}`);
  await new Promise(r => setTimeout(r, 150));
}

if (added.length === 0) {
  console.log('\nNothing to add.');
  process.exit(0);
}

writeFileSync(venuesPath, JSON.stringify(venues, null, 2));

const meta = {
  lastMergedAt: new Date().toISOString(),
  count:        venues.length,
  lastMerged:   added.length,
  source:       'backfill-from-osm',
};
writeFileSync(join(ROOT, 'data/venues.meta.json'), JSON.stringify(meta, null, 2));

console.log(`\n✓ Added ${added.length} venues. Skipped ${skipped.length}.`);
console.log('Total venues:', venues.length);

// Validate
console.log('\nValidating…');
try {
  execSync('node scripts/validate-venues.mjs', { stdio: 'inherit', cwd: ROOT });
} catch {
  console.error('\n⚠  Validation failed. Fix errors and re-run.');
  process.exit(1);
}

console.log(`\nNext steps:
  node scripts/fetch-photos.mjs            # photos for new venues
  node scripts/refresh-opening-hours.mjs   # opening hours
  node scripts/update-geometry.mjs         # facing + building polygon
Or trigger the GitHub workflows in that order.`);
