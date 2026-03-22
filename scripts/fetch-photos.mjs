/**
 * fetch-photos.mjs
 * One-time script: fetches Google Places photo CDN URLs for all venues
 * and writes them to data/venue-photos.json.
 *
 * The CDN URLs (lh3.googleusercontent.com) are publicly accessible and
 * don't require an API key at render time — zero runtime cost.
 *
 * Also updates venues.json with any missing googlePlaceId entries.
 *
 * Usage:  node scripts/fetch-photos.mjs
 * Requires: GOOGLE_PLACES_KEY in .env
 *
 * Cost (one-time):
 *   Text Search:   $17/1,000 → ~$0 for <20 venues
 *   Place Details: $17/1,000 → ~$0 for <20 venues
 *   Place Photo:   $7/1,000  → ~$0 for <120 photos
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

// ── Places API (New) helpers ──────────────────────────────────────────────────

async function findPlaceId(name, area, lat, lng) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Goog-Api-Key':  API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName',
    },
    body: JSON.stringify({
      textQuery:    `${name}${area ? ', ' + area : ''}, Oslo`,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 200 } },
      maxResultCount: 1,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Text Search HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.places?.[0]?.id ?? null;
}

async function fetchPhotoNames(placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}?fields=photos&key=${API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Place Details HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.photos ?? []).slice(0, 6).map(p => p.name);
}

async function resolvePhotoUrl(photoName) {
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&skipHttpRedirect=true&key=${API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Photo media HTTP ${resp.status}`);
  const data = await resp.json();
  return data.photoUri ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const venuesPath = join(ROOT, 'data/venues.json');
const photosPath = join(ROOT, 'data/venue-photos.json');

const venues = JSON.parse(readFileSync(venuesPath, 'utf8'));

// Load existing output so we can skip venues already fetched
let existing = {};
try { existing = JSON.parse(readFileSync(photosPath, 'utf8')); } catch (_) {}
// Index by venue id
const existingById = {};
for (const entry of (Array.isArray(existing) ? existing : [])) {
  existingById[entry.id] = entry;
}

const results = [];
let updatedIds = 0;

for (const v of venues) {
  // Skip if already fetched
  if (existingById[v.id]?.photoUrls?.length) {
    console.log(`  ✓ ${v.name} — already fetched (${existingById[v.id].photoUrls.length} photos)`);
    results.push(existingById[v.id]);
    continue;
  }

  console.log(`\nProcessing: ${v.name}`);

  // 1. Find place ID if missing
  if (!v.googlePlaceId) {
    try {
      v.googlePlaceId = await findPlaceId(v.name, v.area, v.coords[0], v.coords[1]);
      if (v.googlePlaceId) {
        console.log(`  → found place ID: ${v.googlePlaceId}`);
        updatedIds++;
      } else {
        console.warn(`  ✗ No place found — skipping`);
        results.push({ id: v.id, placeId: null, photoUrls: [] });
        continue;
      }
    } catch (err) {
      console.warn(`  ✗ Text Search failed: ${err.message}`);
      results.push({ id: v.id, placeId: null, photoUrls: [] });
      continue;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 2. Fetch photo references
  let photoNames;
  try {
    photoNames = await fetchPhotoNames(v.googlePlaceId);
    console.log(`  → ${photoNames.length} photos found`);
  } catch (err) {
    console.warn(`  ✗ Place Details failed: ${err.message}`);
    results.push({ id: v.id, placeId: v.googlePlaceId, photoUrls: [] });
    continue;
  }
  await new Promise(r => setTimeout(r, 200));

  if (!photoNames.length) {
    results.push({ id: v.id, placeId: v.googlePlaceId, photoUrls: [] });
    continue;
  }

  // 3. Resolve each photo reference to a CDN URL
  const photoUrls = [];
  for (const name of photoNames) {
    try {
      const uri = await resolvePhotoUrl(name);
      if (uri) photoUrls.push(uri);
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.warn(`  ✗ Photo resolve failed: ${err.message}`);
    }
  }
  console.log(`  → resolved ${photoUrls.length} CDN URLs`);

  results.push({ id: v.id, placeId: v.googlePlaceId, photoUrls });
}

// Write photos output
writeFileSync(photosPath, JSON.stringify(results, null, 2));
console.log(`\nWritten: data/venue-photos.json`);

// Write back venues.json if any place IDs were discovered
if (updatedIds > 0) {
  writeFileSync(venuesPath, JSON.stringify(venues, null, 2));
  console.log(`Updated: data/venues.json (${updatedIds} new place IDs)`);
}

const withPhotos = results.filter(r => r.photoUrls?.length).length;
console.log(`Done. ${withPhotos}/${venues.length} venues have photos.`);
