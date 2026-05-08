#!/usr/bin/env node
/**
 * expand-chains.mjs
 * Finds chain branches we're missing — without spamming venues.json
 * with mall food courts.
 *
 * Logic:
 *   1. Group venues.json by normalised name prefix → identify chains
 *      (≥2 branches in the app).
 *   2. For each chain, query OSM for all venues with a matching name
 *      across Oslo.
 *   3. For each OSM hit not already in venues.json (by Place ID,
 *      coord proximity + name overlap), resolve to Google Places via
 *      Text Search with locationRestriction.
 *   4. Hit Google Place Details for the resolved place. **Only add if
 *      Google's outdoorSeating flag is true** (this is the precision
 *      gate — owner has opted in to "yes I have outdoor seating").
 *   5. Skip closed venues; validate against the food-type whitelist.
 *
 * Cost: ~$0.02 per Place Details lookup × ~80 missing branches ≈ $1.60.
 *
 * Usage: node scripts/expand-chains.mjs
 * Requires: GOOGLE_PLACES_KEY in .env (server-side key — referrer-locked
 *           website key won't work).
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { assignArea } from './lib/areas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── API key ───────────────────────────────────────────────────────────────────
const env = readFileSync(join(ROOT, '.env'), 'utf8');
const keyMatch = env.match(/GOOGLE_PLACES_KEY=(.+)/);
if (!keyMatch) { console.error('GOOGLE_PLACES_KEY not found in .env'); process.exit(1); }
const API_KEY = keyMatch[1].trim();

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  if (types.includes('bar'))  return 'bar';
  if (types.includes('cafe')) return 'cafe';
  if (types.includes('pub'))  return 'pub';
  return 'restaurant';
};
const normName = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const metresBetween = (a, b) => Math.hypot((a[0] - b[0]) * 111_000, (a[1] - b[1]) * 55_000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── OSM lookup for chain branches ─────────────────────────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

async function osmLookupChainBranches(chainName) {
  // Match name-starts-with so we catch "Kaffebrenneriet avd Storo" as a branch
  // of "Kaffebrenneriet". Case-insensitive.
  const safe = chainName.replace(/"/g, '');
  // Include shop=bakery — bakery chains (Baker Hansen, Åpent Bakeri,
  // Godt Brød) are tagged shop=bakery in OSM, not amenity=*.
  const query = `
    [out:json][timeout:60];
    area["name"="Oslo"]["admin_level"="4"]->.oslo;
    (
      node["amenity"~"^(restaurant|bar|cafe|pub|fast_food|biergarten|food_court|ice_cream|bakery)$"]["name"~"^${safe}",i](area.oslo);
      way["amenity"~"^(restaurant|bar|cafe|pub|fast_food|biergarten|food_court|ice_cream|bakery)$"]["name"~"^${safe}",i](area.oslo);
      node["shop"="bakery"]["name"~"^${safe}",i](area.oslo);
      way["shop"="bakery"]["name"~"^${safe}",i](area.oslo);
    );
    out tags center;
  `;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Solsteder/1.0' },
        body:    'data=' + encodeURIComponent(query),
        signal:  AbortSignal.timeout(75_000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      return (data.elements ?? [])
        .filter(el => el.tags?.name)
        .map(el => ({
          name:    el.tags.name,
          lat:     el.type === 'node' ? el.lat : el.center?.lat,
          lng:     el.type === 'node' ? el.lon : el.center?.lon,
          amenity: el.tags.amenity,
          outdoor: el.tags.outdoor_seating ?? null,
        }))
        .filter(x => x.lat && x.lng);
    } catch (_) { await sleep(2000); continue; }
  }
  return null;
}

// ── Google Places resolve + outdoor-seating verification ─────────────────────
async function resolveOSMToGoogle(stub) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.outdoorSeating,places.businessStatus',
    },
    body: JSON.stringify({
      textQuery: `${stub.name} Oslo`,
      // Soft bias rather than hard restriction — Google's coord for a
      // chain branch can differ from OSM's by >150 m (entrance node vs
      // building centroid). locationRestriction with 200 m dropped every
      // match in the first run. Bias + maxResultCount: 20 + post-distance
      // filter is more forgiving but still anchored to the right branch.
      locationBias: { circle: { center: { latitude: stub.lat, longitude: stub.lng }, radius: 150 } },
      maxResultCount: 20,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const candidates = data.places ?? [];
  let best = null, bestDist = Infinity;
  for (const p of candidates) {
    if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
    if (!hasFoodType(p.types ?? [])) continue;
    const d = metresBetween([stub.lat, stub.lng], [p.location?.latitude, p.location?.longitude]);
    if (d < 150 && d < bestDist) { best = p; bestDist = d; }
  }
  return best;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const venuesPath = join(ROOT, 'data/venues.json');
const venues = JSON.parse(readFileSync(venuesPath, 'utf8'));

// Identify chains: groups of ≥2 venues where venue.name starts with
// the same significant prefix (≥4 chars).
const byPrefix = new Map(); // prefix -> [venues]
for (const v of venues) {
  // Strip common location-suffix patterns ("avd Storo", "Tjuvholmen", "Frogner") to get the chain name
  const base = v.name
    .replace(/\s+(avd|på|i)\b.*/i, '')      // "Kaffebrenneriet avd Storo" → "Kaffebrenneriet"
    .replace(/\s*[-(].*/, '')                // "Olivia - Tjuvholmen" → "Olivia"
    .trim();
  // Use first 2 words as the chain key (handles "Big Horn", "Joe & The Juice")
  const tokens = base.split(/\s+/);
  let key = tokens.slice(0, Math.min(2, tokens.length)).join(' ');
  if (key.length < 4) continue;
  if (!byPrefix.has(key)) byPrefix.set(key, []);
  byPrefix.get(key).push(v);
}

const chains = [...byPrefix.entries()]
  .filter(([_, list]) => list.length >= 2)
  .sort((a, b) => b[1].length - a[1].length);

console.log(`Detected ${chains.length} chains in venues.json (≥2 branches each).\n`);

const existingPlaceIds = new Set(venues.map(v => v.googlePlaceId).filter(Boolean));
let nextId = Math.max(...venues.map(v => v.id)) + 1;
const added = [], skipped = { 'no-flag': 0, 'unresolved': 0, 'duplicate': 0, 'closed-or-non-food': 0 };

for (const [chainName, existing] of chains) {
  console.log(`\n── ${chainName} ── (${existing.length} in app)`);
  const osm = await osmLookupChainBranches(chainName);
  if (!osm) { console.log('  OSM lookup failed, skipping'); continue; }
  console.log(`  OSM: ${osm.length} branches found`);

  for (const stub of osm) {
    // Already in app by coord+name?
    const stubNorm = normName(stub.name);
    const dupe = venues.find(v =>
      metresBetween([stub.lat, stub.lng], v.coords) < 100 &&
      (normName(v.name).includes(stubNorm) || stubNorm.includes(normName(v.name)))
    );
    if (dupe) { skipped.duplicate++; continue; }

    process.stdout.write(`  + ${stub.name} (${stub.lat.toFixed(4)},${stub.lng.toFixed(4)}) … `);
    let match;
    try { match = await resolveOSMToGoogle(stub); }
    catch (err) { console.log(`error ${err.message}`); continue; }

    if (!match) { console.log('no Google match'); skipped.unresolved++; continue; }
    if (existingPlaceIds.has(match.id)) { console.log('place already in app'); skipped.duplicate++; continue; }

    // Precision gate: only add if Google explicitly flags outdoorSeating === true.
    if (match.outdoorSeating !== true) {
      console.log(`outdoorSeating=${match.outdoorSeating} — skipped`);
      skipped['no-flag']++;
      continue;
    }

    const loc  = match.location;
    const area = assignArea([loc.latitude, loc.longitude]).area ?? 'Oslo';
    const venue = {
      id:                 nextId++,
      name:               match.displayName?.text ?? stub.name,
      address:            match.formattedAddress ?? '',
      coords:             [loc.latitude, loc.longitude],
      category:           categoryFromTypes(match.types ?? []),
      area,
      rating:             match.rating ?? null,
      facing:             null,
      openingHours:       { open: 11, close: 23 },
      buildingOsmId:      null,
      googlePlaceId:      match.id,
      facingSource:       null,
      discoverySignal:    'chain-expansion',
      businessStatus:     match.businessStatus ?? 'OPERATIONAL',
    };
    venues.push(venue);
    existingPlaceIds.add(match.id);
    added.push(venue);
    console.log(`✓ added id=${venue.id}`);
    await sleep(120);
  }
  await sleep(300); // be nice to Overpass
}

if (added.length === 0) {
  console.log(`\nNo new venues. Skipped: ${JSON.stringify(skipped)}`);
  process.exit(0);
}

writeFileSync(venuesPath, JSON.stringify(venues, null, 2));
writeFileSync(join(ROOT, 'data/venues.meta.json'), JSON.stringify({
  lastMergedAt: new Date().toISOString(),
  count:        venues.length,
  lastMerged:   added.length,
  source:       'expand-chains',
}, null, 2));

console.log(`\n━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Added:                      ${added.length}`);
console.log(`Skipped (no outdoor flag):  ${skipped['no-flag']}`);
console.log(`Skipped (unresolved):       ${skipped.unresolved}`);
console.log(`Skipped (duplicate):        ${skipped.duplicate}`);
console.log(`Total venues:               ${venues.length}`);

console.log('\nValidating…');
try { execSync('node scripts/validate-venues.mjs', { stdio: 'inherit', cwd: ROOT }); }
catch { console.error('\n⚠  Validation failed.'); process.exit(1); }

console.log(`\nNext: fetch-photos, refresh-opening-hours, update-geometry.`);
