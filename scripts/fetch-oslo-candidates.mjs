#!/usr/bin/env node
/**
 * fetch-oslo-candidates.mjs
 * Fetches all restaurants, bars, cafes and pubs in Oslo from Overpass/OSM.
 * Writes data/oslo-candidates.json — a lightweight index used by the client
 * to show search results for venues not yet in the curated venues.json.
 *
 * Usage:  node scripts/fetch-oslo-candidates.mjs
 * Run periodically (e.g. monthly) to keep the index fresh.
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

// All food/drink amenity types worth surfacing
const AMENITY_TYPES = 'restaurant|bar|cafe|pub|biergarten|food_court';

// Overpass query: all matching amenities inside the Oslo municipality boundary
const QUERY = `
[out:json][timeout:120];
area["name"="Oslo"]["admin_level"="4"]->.oslo;
(
  node["amenity"~"^(${AMENITY_TYPES})$"](area.oslo);
  way["amenity"~"^(${AMENITY_TYPES})$"](area.oslo);
);
out center tags;
`;

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

async function main() {
  console.log('Fetching Oslo venue candidates from Overpass…');

  let elements;
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  Trying ${endpoint} …`);
      const data = await postOverpass(endpoint, QUERY);
      elements = data.elements;
      console.log(`  ✓ ${elements.length} elements`);
      break;
    } catch (err) {
      console.warn(`  ✗ ${endpoint}: ${err.message}`);
      lastErr = err;
      await new Promise(r => setTimeout(r, 8_000));
    }
  }
  if (!elements) throw lastErr;

  const candidates = elements
    .filter(el => el.tags?.name)
    .map(el => {
      const lat = el.type === 'node' ? el.lat : el.center?.lat;
      const lng = el.type === 'node' ? el.lon : el.center?.lon;
      if (!lat || !lng) return null;

      const street = el.tags['addr:street']       ?? '';
      const num    = el.tags['addr:housenumber']  ?? '';
      const address = [street, num].filter(Boolean).join(' ');

      return {
        osmId:   `${el.type}/${el.id}`,
        name:    el.tags.name,
        lat,
        lng,
        outdoor: el.tags.outdoor_seating === 'yes' || el.tags.outdoor_seating === 'limited',
        amenity: el.tags.amenity,
        address,
      };
    })
    .filter(Boolean);

  // Deduplicate by name + rounded coords (ways and nodes can overlap)
  const seen = new Set();
  const deduped = candidates.filter(c => {
    const key = `${c.name.toLowerCase()}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort for stable diffs
  deduped.sort((a, b) => a.name.localeCompare(b.name, 'no'));

  const outPath = join(ROOT, 'data/oslo-candidates.json');
  writeFileSync(outPath, JSON.stringify(deduped, null, 2));
  console.log(`\nWritten ${deduped.length} candidates → data/oslo-candidates.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
