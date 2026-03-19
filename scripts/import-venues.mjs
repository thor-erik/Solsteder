/**
 * import-venues.mjs
 * Searches Google Places for Oslo food/drink venues with outdoor seating.
 * Writes candidates to data/venues-candidates.json for review.
 *
 * Usage: node scripts/import-venues.mjs
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
const API_KEY  = keyMatch[1].trim();

// ── Search areas ──────────────────────────────────────────────────────────────

const AREAS = [
  { name: 'Aker Brygge',     lat: 59.9097, lng: 10.7261, radius: 500 },
  { name: 'Tjuvholmen',      lat: 59.9078, lng: 10.7213, radius: 400 },
  { name: 'Sentrum',         lat: 59.9130, lng: 10.7420, radius: 600 },
  { name: 'Grünerløkka',     lat: 59.9220, lng: 10.7580, radius: 600 },
  { name: 'Frogner',         lat: 59.9180, lng: 10.7000, radius: 600 },
  { name: 'St. Hanshaugen',  lat: 59.9210, lng: 10.7340, radius: 500 },
  { name: 'Majorstuen',      lat: 59.9225, lng: 10.7140, radius: 500 },
  { name: 'Vulkan/Mathallen',lat: 59.9237, lng: 10.7520, radius: 400 },
  { name: 'Grønland',        lat: 59.9095, lng: 10.7630, radius: 500 },
  { name: 'Bygdøy',          lat: 59.9045, lng: 10.6870, radius: 500 },
];

const INCLUDED_TYPES = ['restaurant', 'bar', 'cafe', 'coffee_shop'];

const MIN_RATING = 4.0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapCategory(types) {
  if (types.includes('fine_dining_restaurant')) return 'fine_dining';
  if (types.includes('cocktail_bar'))           return 'cocktail_bar';
  if (types.includes('bar') || types.includes('pub')) return 'bar';
  if (types.includes('cafe') || types.includes('coffee_shop') || types.includes('bakery')) return 'cafe';
  return 'restaurant';
}

function parseOpeningHours(hours) {
  if (!hours?.periods?.length) return { open: 11, close: 22 };
  let minOpen = 24, maxClose = 0;
  for (const p of hours.periods) {
    if (p.open?.hour  != null) minOpen  = Math.min(minOpen,  p.open.hour);
    if (p.close?.hour != null) {
      const h = p.close.hour + (p.close.minute || 0) / 60;
      maxClose = Math.max(maxClose, h === 0 ? 24 : h);
    }
  }
  return {
    open:  minOpen  < 24 ? minOpen          : 11,
    close: maxClose > 0  ? Math.round(maxClose) : 22,
  };
}

async function searchNearby(area) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Goog-Api-Key':  API_KEY,
      'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.regularOpeningHours,places.types,places.outdoorSeating',
    },
    body: JSON.stringify({
      includedTypes:       INCLUDED_TYPES,
      locationRestriction: { circle: { center: { latitude: area.lat, longitude: area.lng }, radius: area.radius } },
      maxResultCount:      20,
      rankPreference:      'POPULARITY',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.places || [];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const existing    = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'));
  const existingIds = new Set(existing.map(v => v.googlePlaceId).filter(Boolean));

  console.log(`Existing venues: ${existing.length}`);
  console.log(`Searching ${AREAS.length} Oslo areas for rating ≥ ${MIN_RATING}...\n`);

  const seen       = new Set(existingIds);
  const candidates = [];

  for (const area of AREAS) {
    process.stdout.write(`  ${area.name.padEnd(20)}`);
    try {
      const places = await searchNearby(area);
      const fresh  = places.filter(p => !seen.has(p.id) && (p.rating ?? 0) >= MIN_RATING);
      fresh.forEach(p => seen.add(p.id));

      candidates.push(...fresh.map(p => ({
        name:         p.displayName?.text ?? 'Unknown',
        address:      p.formattedAddress  ?? '',
        coords:       [p.location.latitude, p.location.longitude],
        category:     mapCategory(p.types ?? []),
        area:         area.name,
        rating:       p.rating,
        facing:       180,
        openingHours: parseOpeningHours(p.regularOpeningHours),
        outdoorSeating: p.outdoorSeating ?? null,
        buildingOsmId:  null,
        googlePlaceId:  p.id,
        facingSource:   null,
      })));

      console.log(`${fresh.length} new  (${places.length} results)`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  candidates.sort((a, b) => b.rating - a.rating);

  const outPath = join(ROOT, 'data/venues-candidates.json');
  writeFileSync(outPath, JSON.stringify(candidates, null, 2));

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Found ${candidates.length} new candidates`);
  console.log(`Written to data/venues-candidates.json`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review data/venues-candidates.json — remove any you don't want`);
  console.log(`  2. node scripts/merge-venues.mjs`);
  console.log(`  3. node scripts/update-geometry.mjs`);
}

main().catch(err => { console.error(err); process.exit(1); });
