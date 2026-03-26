/**
 * fetch-venues-places.mjs
 * Fetches ~50 restaurant/bar/cafe venues with outdoor terraces in Oslo
 * (within Ring 2) from the Google Places Nearby Search API.
 *
 * Strategy:
 *  - 6 search points spread across Ring 2 neighbourhoods
 *  - Keyword "uteservering" (Norwegian for outdoor seating)
 *  - Deduplicates by place_id across all calls
 *  - Writes output to data/venues-fetched.json (review before merging)
 *
 * Usage:   node scripts/fetch-venues-places.mjs
 * Cost:    ~$0.03–0.10 (one-time, well within free $200/mo credit)
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
const API_KEY  = keyMatch[1].trim();

// ── Search config ─────────────────────────────────────────────────────────────
// 6 anchor points spread across Ring 2 neighbourhoods
const SEARCH_POINTS = [
  { lat: 59.9138, lng: 10.7387, area: 'Sentrum' },       // City centre / Stortinget
  { lat: 59.9235, lng: 10.7340, area: 'Grünerløkka' },   // Grünerløkka
  { lat: 59.9175, lng: 10.7600, area: 'Grønland' },      // Grønland / Tøyen
  { lat: 59.9200, lng: 10.7180, area: 'Bislett' },       // Bislett / St. Hanshaugen
  { lat: 59.9080, lng: 10.7220, area: 'Frogner' },       // Frogner / Briskeby
  { lat: 59.9060, lng: 10.7490, area: 'Aker Brygge' },   // Aker Brygge / Tjuvholmen
];
const RADIUS   = 900;   // metres — small radius keeps results dense in each area
const TYPES    = ['restaurant', 'bar', 'cafe'];
const KEYWORD  = 'uteservering';

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function nearbyPage(lat, lng, type, pageToken) {
  const base = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
  const params = pageToken
    ? `pagetoken=${pageToken}&key=${API_KEY}`
    : `location=${lat},${lng}&radius=${RADIUS}&type=${type}&keyword=${KEYWORD}&key=${API_KEY}`;
  const res  = await fetch(`${base}?${params}`);
  return res.json();
}

async function placeDetails(placeId) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${placeId}&fields=name,formatted_address,geometry,rating,opening_hours,types&key=${API_KEY}`;
  const res = await fetch(url);
  return res.json();
}

function categoryFromTypes(types = []) {
  if (types.includes('bar'))        return 'bar';
  if (types.includes('cafe'))       return 'cafe';
  if (types.includes('restaurant')) return 'restaurant';
  return 'restaurant';
}

// ── Main ──────────────────────────────────────────────────────────────────────
const seen    = new Map(); // place_id → raw result
const ordered = [];       // insertion order for stable output

for (const point of SEARCH_POINTS) {
  for (const type of TYPES) {
    let token = null;
    let page  = 0;
    do {
      if (token) await sleep(2200); // Places API requires >2s between page requests
      console.log(`  ${point.area} / ${type} page ${page + 1}…`);
      let data;
      try {
        data = await nearbyPage(point.lat, point.lng, type, token);
      } catch (e) {
        console.warn('    fetch error:', e.message);
        break;
      }
      if (data.status === 'REQUEST_DENIED') {
        console.error('API key error:', data.error_message);
        process.exit(1);
      }
      for (const r of (data.results || [])) {
        if (!seen.has(r.place_id)) {
          seen.set(r.place_id, { result: r, area: point.area });
          ordered.push(r.place_id);
        }
      }
      token = data.next_page_token ?? null;
      page++;
    } while (token && page < 2); // max 2 pages per search point/type
  }
}

console.log(`\nFound ${seen.size} unique venues. Fetching details…\n`);

// Fetch Place Details for opening hours (Nearby Search doesn't include them)
const venues = [];
let idx = 1;
for (const placeId of ordered) {
  const { result: r, area } = seen.get(placeId);
  await sleep(50); // light throttle
  let openHours = { open: 11, close: 23 }; // sensible default
  try {
    const det = await placeDetails(placeId);
    const ph  = det.result?.opening_hours?.periods;
    if (ph) {
      // Find the longest open window across all days as a representative
      const opens  = ph.map(p => p.open?.time  ? parseInt(p.open.time.slice(0,2),10)  : 11);
      const closes = ph.map(p => p.close?.time ? parseInt(p.close.time.slice(0,2),10) : 23);
      openHours = {
        open:  Math.min(...opens),
        close: Math.max(...closes.map(h => h === 0 ? 24 : h)),
      };
    }
  } catch (_) { /* keep default */ }

  venues.push({
    id:           idx++,
    name:         r.name,
    address:      r.vicinity,
    coords:       [r.geometry.location.lat, r.geometry.location.lng],
    category:     categoryFromTypes(r.types),
    area,
    rating:       r.rating ?? null,
    facing:       null,       // must be set manually or via OSM wall-normal calculation
    openingHours: openHours,
    buildingOsmId:  null,
    googlePlaceId:  placeId,
    facingSource:   null,
  });

  if (idx % 10 === 0) console.log(`  ${idx - 1}/${seen.size} done…`);
}

const outPath = join(ROOT, 'data', 'venues-fetched.json');
writeFileSync(outPath, JSON.stringify(venues, null, 2));
console.log(`\nWrote ${venues.length} venues → data/venues-fetched.json`);
console.log('Review the file, then run scripts/merge-venues.mjs to merge into venues.json.');
