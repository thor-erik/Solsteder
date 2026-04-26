/**
 * fetch-photos.mjs
 * Fetches Google Places photo *references* for all venues and writes
 * them to data/venue-photos.json.
 *
 * Photos are served at runtime via /api/place-photo?ref=... which
 * proxies through the server-side API key — compliant with Google ToS
 * (no stored CDN URLs that expire).
 *
 * Also updates venues.json with any missing googlePlaceId entries.
 *
 * Usage:  node scripts/fetch-photos.mjs
 * Requires: GOOGLE_PLACES_KEY in .env
 *
 * Cost:
 *   Text Search:   $17/1,000 → ~$0 for <20 venues
 *   Place Details: $17/1,000 → ~$0 for ~110 venues
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── API key ───────────────────────────────────────────────────────────────────

const env      = readFileSync(join(ROOT, '.env'), 'utf8');
// Prefer unrestricted server key; fall back to referrer-restricted client key
const serverMatch = env.match(/GOOGLE_PLACES_SERVER_KEY=(.+)/);
const clientMatch = env.match(/GOOGLE_PLACES_KEY=(.+)/);
const keyMatch = serverMatch || clientMatch;
if (!keyMatch) { console.error('GOOGLE_PLACES_SERVER_KEY (or GOOGLE_PLACES_KEY) not found in .env'); process.exit(1); }
const API_KEY = keyMatch[1].trim();
if (serverMatch) console.log('Using GOOGLE_PLACES_SERVER_KEY (unrestricted)');
else console.warn('⚠ Using GOOGLE_PLACES_KEY (referrer-restricted — may 403 from CLI)');

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

// No longer resolve CDN URLs — store photo references only.
// Photos are served at runtime via /api/place-photo?ref=... proxy.

// ── Main ──────────────────────────────────────────────────────────────────────

const venuesPath = join(ROOT, 'data/venues.json');
const photosPath = join(ROOT, 'data/venue-photos.json');

const venues = JSON.parse(readFileSync(venuesPath, 'utf8'));

// Load existing output to preserve place IDs for venues we already resolved
let existing = {};
try { existing = JSON.parse(readFileSync(photosPath, 'utf8')); } catch (_) {}
const existingById = {};
for (const entry of (Array.isArray(existing) ? existing : [])) {
  existingById[entry.id] = entry;
}

const results = [];
let updatedIds = 0;

for (const v of venues) {
  console.log(`\nProcessing: ${v.name}`);

  // 1. Find place ID if missing (use existing if available)
  if (!v.googlePlaceId && existingById[v.id]?.placeId) {
    v.googlePlaceId = existingById[v.id].placeId;
    console.log(`  → reused place ID: ${v.googlePlaceId}`);
  }
  if (!v.googlePlaceId) {
    try {
      v.googlePlaceId = await findPlaceId(v.name, v.area, v.coords[0], v.coords[1]);
      if (v.googlePlaceId) {
        console.log(`  → found place ID: ${v.googlePlaceId}`);
        updatedIds++;
      } else {
        console.warn(`  ✗ No place found — skipping`);
        results.push({ id: v.id, placeId: null, photoRefs: [] });
        continue;
      }
    } catch (err) {
      console.warn(`  ✗ Text Search failed: ${err.message}`);
      results.push({ id: v.id, placeId: null, photoRefs: [] });
      continue;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 2. Fetch photo references (always re-fetch to keep refs current)
  let photoNames;
  try {
    photoNames = await fetchPhotoNames(v.googlePlaceId);
    console.log(`  → ${photoNames.length} photo refs`);
  } catch (err) {
    console.warn(`  ✗ Place Details failed: ${err.message}`);
    results.push({ id: v.id, placeId: v.googlePlaceId, photoRefs: [] });
    continue;
  }
  await new Promise(r => setTimeout(r, 200));

  results.push({ id: v.id, placeId: v.googlePlaceId, photoRefs: photoNames });
}

// Write photos output
writeFileSync(photosPath, JSON.stringify(results, null, 2));
console.log(`\nWritten: data/venue-photos.json`);

// Write back venues.json if any place IDs were discovered
if (updatedIds > 0) {
  writeFileSync(venuesPath, JSON.stringify(venues, null, 2));
  console.log(`Updated: data/venues.json (${updatedIds} new place IDs)`);
}

const withPhotos = results.filter(r => r.photoRefs?.length).length;
console.log(`Done. ${withPhotos}/${venues.length} venues have photo refs.`);
