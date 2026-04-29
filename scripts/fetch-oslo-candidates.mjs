#!/usr/bin/env node
/**
 * fetch-oslo-candidates.mjs
 * Builds data/oslo-candidates.json — a lightweight search index of all
 * restaurants, bars, cafes and pubs in Oslo, sourced from:
 *   1. Overpass/OSM (free, ~1,400 results)
 *   2. Google Places API Nearby Search (basic tier, ~$1.30 per run)
 *
 * The union is deduplicated by name + rounded coordinates.
 *
 * Usage:  node scripts/fetch-oslo-candidates.mjs
 * Run periodically (e.g. monthly) to keep the index fresh.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── Google Places API key ────────────────────────────────────────────────────
let API_KEY = null;
try {
  const env = readFileSync(join(ROOT, '.env'), 'utf8');
  const m   = env.match(/GOOGLE_PLACES_KEY=(.+)/);
  if (m) API_KEY = m[1].trim();
} catch (_) {}

// ── Overpass config ──────────────────────────────────────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
const AMENITY_TYPES = 'restaurant|bar|cafe|pub|biergarten|food_court';
const OVERPASS_QUERY = `
[out:json][timeout:120];
area["name"="Oslo"]["admin_level"="4"]->.oslo;
(
  node["amenity"~"^(${AMENITY_TYPES})$"](area.oslo);
  way["amenity"~"^(${AMENITY_TYPES})$"](area.oslo);
);
out center tags;
`;

// ── Google Places search grid (same as fetch-venues-places.mjs) ──────────────
const SEARCH_POINTS = [
  { lat: 59.9138, lng: 10.7387 },
  { lat: 59.9235, lng: 10.7340 },
  { lat: 59.9175, lng: 10.7600 },
  { lat: 59.9200, lng: 10.7180 },
  { lat: 59.9080, lng: 10.7220 },
  { lat: 59.9060, lng: 10.7490 },
  { lat: 59.9310, lng: 10.7560 },
  { lat: 59.9390, lng: 10.7460 },
  { lat: 59.9270, lng: 10.7730 },
  { lat: 59.9330, lng: 10.7900 },
  { lat: 59.9280, lng: 10.6780 },
  { lat: 59.9350, lng: 10.6620 },
  { lat: 59.9040, lng: 10.6940 },
  { lat: 59.8980, lng: 10.6620 },
  { lat: 59.9120, lng: 10.8180 },
  { lat: 59.9000, lng: 10.8400 },
  { lat: 59.8820, lng: 10.8100 },
  { lat: 59.8680, lng: 10.7760 },
  { lat: 59.8560, lng: 10.7560 },
  { lat: 59.8750, lng: 10.7280 },
];
const RADIUS       = 900;
const PLACE_TYPES  = ['restaurant', 'bar', 'cafe'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Overpass fetch ───────────────────────────────────────────────────────────

async function postOverpass(endpoint, query) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   'Solsteder/1.0 (github.com/thor-erik/Solsteder)',
    },
    body:   'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(150_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchOSM() {
  console.log('\n── Pass 1: Overpass/OSM ──────────────────────────────────');
  let elements, lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  Trying ${endpoint} …`);
      const data = await postOverpass(endpoint, OVERPASS_QUERY);
      elements = data.elements;
      console.log(`  ✓ ${elements.length} elements`);
      break;
    } catch (err) {
      console.warn(`  ✗ ${endpoint}: ${err.message}`);
      lastErr = err;
      await sleep(8_000);
    }
  }
  if (!elements) throw lastErr;

  return elements
    .filter(el => el.tags?.name)
    .map(el => {
      const lat = el.type === 'node' ? el.lat : el.center?.lat;
      const lng = el.type === 'node' ? el.lon : el.center?.lon;
      if (!lat || !lng) return null;
      const street  = el.tags['addr:street'] ?? '';
      const num     = el.tags['addr:housenumber'] ?? '';
      const address = [street, num].filter(Boolean).join(' ');
      return {
        name:           el.tags.name,
        lat,
        lng,
        amenity:        el.tags.amenity,
        address,
        source:         'osm',
        osmId:          `${el.type}/${el.id}`,
        outdoorSeating: el.tags.outdoor_seating ?? null, // 'yes' | 'no' | 'seasonal' | null
      };
    })
    .filter(Boolean);
}

// ── Google Places fetch ──────────────────────────────────────────────────────

async function fetchGooglePlaces() {
  if (!API_KEY) {
    console.log('\n── Pass 2: Google Places — SKIPPED (no GOOGLE_PLACES_KEY in .env) ──');
    return [];
  }
  console.log('\n── Pass 2: Google Places Nearby Search ──────────────────');

  const seen = new Map(); // placeId → candidate
  for (const point of SEARCH_POINTS) {
    process.stdout.write(`  (${point.lat.toFixed(3)}, ${point.lng.toFixed(3)}) … `);
    try {
      const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-Goog-Api-Key':   API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus',
        },
        body: JSON.stringify({
          locationRestriction: {
            circle: { center: { latitude: point.lat, longitude: point.lng }, radius: RADIUS },
          },
          includedTypes:  PLACE_TYPES,
          rankPreference: 'DISTANCE',
          maxResultCount: 20,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) { console.log(`HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      const places = data.places ?? [];
      let added = 0;
      for (const p of places) {
        if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        if (seen.has(p.id)) continue;
        const loc = p.location ?? {};
        seen.set(p.id, {
          name:    p.displayName?.text ?? '',
          lat:     loc.latitude ?? 0,
          lng:     loc.longitude ?? 0,
          amenity: categoryFromTypes(p.types ?? []),
          address: p.formattedAddress ?? '',
          source:  'google',
        });
        added++;
      }
      console.log(`${places.length} results, ${added} new`);
    } catch (err) {
      console.warn(`error: ${err.message}`);
    }
    await sleep(200);
  }
  return [...seen.values()];
}

function categoryFromTypes(types = []) {
  if (types.includes('bar'))        return 'bar';
  if (types.includes('cafe'))       return 'cafe';
  if (types.includes('restaurant')) return 'restaurant';
  return 'restaurant';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const osmCandidates    = await fetchOSM();
  const googleCandidates = await fetchGooglePlaces();

  // Merge: OSM first, Google second
  const all = [...osmCandidates, ...googleCandidates];

  // Deduplicate by name (lowercased) + rounded coords
  const seen = new Set();
  const deduped = all.filter(c => {
    const key = `${c.name.toLowerCase()}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort for stable diffs
  deduped.sort((a, b) => a.name.localeCompare(b.name, 'no'));

  const outPath = join(ROOT, 'data/oslo-candidates.json');
  writeFileSync(outPath, JSON.stringify(deduped, null, 2));

  const osmCount    = deduped.filter(c => c.source === 'osm').length;
  const googleCount = deduped.filter(c => c.source === 'google').length;
  console.log(`
Written ${deduped.length} candidates → data/oslo-candidates.json
  OSM:            ${osmCount}
  Google Places:  ${googleCount}
`);
}

main().catch(err => { console.error(err); process.exit(1); });
