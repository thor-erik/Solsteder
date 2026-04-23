/**
 * fetch-beer-prices.mjs
 * Fetches beer prices from Pilsguiden.no for Oslo districts,
 * matches them against venues.json, and adds beerPrice field.
 *
 * Usage:  node scripts/fetch-beer-prices.mjs
 *         node scripts/fetch-beer-prices.mjs --dry-run   # preview matches without writing
 *
 * Data source: https://pilsguiden.no — prices are per half-liter (pint field).
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DRY_RUN   = process.argv.includes('--dry-run');

// ── Pilsguiden districts for Oslo ────────────────────────────────────────────

const DISTRICTS = [
  'sentrum', 'grunerlokka', 'frogner', 'gamle-oslo', 'sagene',
  'st-hanshaugen', 'nordre-aker', 'ullern', 'nordstrand',
  'ostensjo', 'bjerke', 'alna', 'grorud', 'stovner',
  'sondre-nordstrand', 'vestre-aker'
];

// ── Fetch & parse ────────────────────────────────────────────────────────────

async function fetchDistrict(slug) {
  const url = `https://pilsguiden.no/oslo/${slug}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) { console.warn(`  ⚠ ${slug}: HTTP ${res.status}`); return []; }

  const html = await res.text();

  // SvelteKit embeds data as JS object — find unfilteredBars array
  const idx = html.indexOf('unfilteredBars:');
  if (idx === -1) { console.warn(`  ⚠ ${slug}: no bar data found`); return []; }

  const start = html.indexOf('[', idx);
  let depth = 0, end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') depth--;
    if (depth === 0) { end = i + 1; break; }
  }

  let raw = html.slice(start, end);
  // Convert JS object notation to JSON
  raw = raw.replace(/(?<=[{,])(\w+):/g, '"$1":');
  raw = raw.replace(/void 0/g, 'null');
  raw = raw.replace(/:\.(\d)/g, ':0.$1');

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`  ⚠ ${slug}: JSON parse error — ${e.message}`);
    return [];
  }
}

async function fetchAllPrices() {
  const all = new Map();  // id → bar object (dedupe across districts)

  for (const slug of DISTRICTS) {
    process.stdout.write(`  Fetching ${slug}...`);
    const bars = await fetchDistrict(slug);
    let added = 0;
    for (const b of bars) {
      if (!all.has(b.id)) { all.set(b.id, b); added++; }
    }
    console.log(` ${bars.length} bars (${added} new)`);
    // Be polite
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n  Total unique bars from Pilsguiden: ${all.size}`);
  return [...all.values()];
}

// ── Manual overrides ─────────────────────────────────────────────────────────
// venue name → Pilsguiden bar name (for fuzzy matches verified by hand)

const MANUAL_MATCH = {
  'Fuglen':                          'Fuglen Oslo Sentrum',
  'Mad Goat':                        'Mad Goat Tap Room',
  'Vesper Gastrobar':                'Vesper Bar',
  'Andy\'s Pub':                     'Andys\' Pub Frogner',
  'Munch Deli & Coffee':             'MUNCH deli & kafé',
  'Bella Notte':                     'Bella Notte Carl Berner',
  'Grisen':                          'Grisen Torshov',
  'RED Rooftop Bar and Terrace':     'Radisson RED Rooftop Bar & Terrace',
  'Fyret mat & Drikke - og Noe til Båten AS': 'Fyret Mat & Drikke',
  'Carls':                           'Carls - Storstua på Carl Berners Plass',
  'Renna':                           'Gamle Renna-Rendevouz',
  'Tiffany\'s':                      'Tiffany\'s Bjølsen',
  'El Camino':                       'El Camino Frogner',
  'Mamma Pizza':                     'Mamma Pizza Osteria di Mare Via Vika',
};

// venue names that should NOT be matched (false positives)
const BLOCK_LIST = new Set([
  'Brygga Bar',          // not Brygg Oslo
  'Arts restaurant',     // not Art Bar Oslo
  'Postkontoret',        // not Cafékontoret
  'Kanpai Izakaya',      // not Izakaya Oslo
  'Valkyrien Grill',     // not Valkyrien Restaurant (different venue)
]);

// ── Name matching ────────────────────────────────────────────────────────────

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/\s*[-–—&+/\\|]\s*/g, ' ')
    .replace(/\b(as|restaurant|bar|cafe|café|kafé|pub|oslo|avd\.?)\b/g, '')
    .replace(/[^a-zæøå0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(venueName, pilsName) {
  const a = normalize(venueName);
  const b = normalize(pilsName);

  // Skip if either is too short to be meaningful
  if (a.length < 3 || b.length < 3) return 0;

  // Exact match after normalization
  if (a === b) return 1.0;

  // One contains the other — but only if the shorter string is
  // at least 60% of the longer (prevents "st" matching everything)
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.5) return 0.9;

  // Word overlap (Jaccard) — require at least 2 shared words
  const wa = new Set(a.split(' ').filter(w => w.length > 1));
  const wb = new Set(b.split(' ').filter(w => w.length > 1));
  const shared = [...wa].filter(w => wb.has(w));
  if (shared.length < 1) return 0;

  const intersection = shared.length;
  const union = new Set([...wa, ...wb]).size;
  const jaccard = intersection / union;

  // Boost if first significant word matches
  const fa = [...wa].find(w => w.length > 2);
  const fb = [...wb].find(w => w.length > 2);
  const firstBoost = (fa && fb && fa === fb) ? 0.15 : 0;

  return Math.min(jaccard + firstBoost, 0.99);
}

function findBestMatch(venue, pilsBars) {
  if (BLOCK_LIST.has(venue.name)) return null;

  // Check manual override first
  const override = MANUAL_MATCH[venue.name];
  if (override) {
    const bar = pilsBars.find(b => b.bar === override);
    if (bar) return { bar, score: 1.0 };
  }

  let best = null, bestScore = 0;
  for (const bar of pilsBars) {
    const score = matchScore(venue.name, bar.bar);
    if (score > bestScore) { bestScore = score; best = bar; }
  }
  return bestScore >= 0.9 ? { bar: best, score: bestScore } : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching beer prices from Pilsguiden.no...\n');
  const pilsBars = await fetchAllPrices();

  const venuesPath = join(ROOT, 'data', 'venues.json');
  const venues = JSON.parse(readFileSync(venuesPath, 'utf8'));

  console.log(`\nMatching against ${venues.length} venues...\n`);

  let matched = 0, unmatched = 0;
  const results = [];

  for (const venue of venues) {
    const match = findBestMatch(venue, pilsBars);
    if (match) {
      const { bar, score } = match;
      // Use pint price (half-liter equivalent)
      const price = bar.pint;
      const tag = score >= 0.9 ? '✓' : '~';
      results.push({ venue: venue.name, pilsName: bar.bar, price, score, tag });
      venue.beerPrice = price;
      matched++;
    } else {
      unmatched++;
    }
  }

  // Print results sorted by score
  results.sort((a, b) => b.score - a.score);
  console.log('  Matches:');
  for (const r of results) {
    console.log(`  ${r.tag} ${r.venue} → ${r.pilsName} (${r.price} kr, score ${r.score.toFixed(2)})`);
  }
  console.log(`\n  Matched: ${matched} / ${venues.length} venues (${unmatched} unmatched)`);

  // Show fuzzy matches (score < 0.9) for manual review
  const fuzzy = results.filter(r => r.score < 0.9);
  if (fuzzy.length) {
    console.log(`\n  ⚠ Fuzzy matches (review these):`);
    for (const r of fuzzy) {
      console.log(`    "${r.venue}" → "${r.pilsName}" (score ${r.score.toFixed(2)})`);
    }
  }

  if (DRY_RUN) {
    console.log('\n  --dry-run: not writing to venues.json');
  } else {
    writeFileSync(venuesPath, JSON.stringify(venues, null, 2) + '\n');
    console.log(`\n  ✓ Updated venues.json with beerPrice for ${matched} venues`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
