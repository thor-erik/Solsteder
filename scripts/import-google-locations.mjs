/**
 * import-google-locations.mjs
 * Enriches venues.json with precise Google Places entrance coordinates.
 *
 * For each venue that lacks a googlePlaceId or googleLocation:
 *   1. Text-searches Google Places using the venue name + city
 *   2. Stores googlePlaceId and googleLocation: {lat, lng}
 *
 * The googleLocation coordinate is placed by Google at or near the actual
 * entrance/storefront — significantly more precise than a manually entered
 * address, and used by update-geometry.mjs to improve wall scoring.
 *
 * Usage:  node scripts/import-google-locations.mjs
 * Requires: GOOGLE_PLACES_KEY in .env
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

// ── Google Places (New) Text Search ───────────────────────────────────────────

async function searchPlace(query, lat, lng) {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.id,places.location,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({
      textQuery:    query,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radiusMeters: 150 } },
      maxResultCount: 3,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.places ?? [];
}

// ── Main ──────────────────────────────────────────────────────────────────────

const venuesPath = join(ROOT, 'data/venues.json');
const venues     = JSON.parse(readFileSync(venuesPath, 'utf8'));

let updated = 0, skipped = 0, failed = 0;

for (const v of venues) {
  if (v.googlePlaceId && v.googleLocation) {
    skipped++;
    continue;
  }

  const query = `${v.name} Oslo`;
  console.log(`Searching: "${query}" …`);

  try {
    const places = await searchPlace(query, v.coords[0], v.coords[1]);
    if (!places.length) {
      console.warn(`  ✗ No results for "${v.name}"`);
      failed++;
      continue;
    }

    const best = places[0];
    const loc  = best.location;

    console.log(`  ✓ ${best.displayName?.text} — ${best.formattedAddress}`);
    console.log(`    location: ${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`);

    v.googlePlaceId  = v.googlePlaceId  ?? best.id;
    v.googleLocation = v.googleLocation ?? { lat: loc.latitude, lng: loc.longitude };
    updated++;
  } catch (err) {
    console.warn(`  ✗ ${v.name}: ${err.message}`);
    failed++;
  }

  // Rate-limit: one request per 200 ms to stay within 5 req/s quota
  await new Promise(r => setTimeout(r, 200));
}

writeFileSync(venuesPath, JSON.stringify(venues, null, 2));
console.log(`\nDone. Updated: ${updated}  Skipped (already had data): ${skipped}  Failed: ${failed}`);
console.log(`Written: data/venues.json`);
