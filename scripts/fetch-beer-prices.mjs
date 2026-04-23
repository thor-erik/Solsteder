/**
 * fetch-beer-prices.mjs
 * Fetches beer prices from Pilsguiden.no and Pilsjakt.no,
 * matches them against venues.json, and adds beerPrice field.
 *
 * Pilsguiden is the primary source (fresher data, professionally maintained).
 * Pilsjakt is a fallback for venues Pilsguiden doesn't cover.
 *
 * Usage:  node scripts/fetch-beer-prices.mjs
 *         node scripts/fetch-beer-prices.mjs --dry-run   # preview matches without writing
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DRY_RUN   = process.argv.includes('--dry-run');

// ── Pilsguiden: fetch & parse ────────────────────────────────────────────────

const DISTRICTS = [
  'sentrum', 'grunerlokka', 'frogner', 'gamle-oslo', 'sagene',
  'st-hanshaugen', 'nordre-aker', 'ullern', 'nordstrand',
  'ostensjo', 'bjerke', 'alna', 'grorud', 'stovner',
  'sondre-nordstrand', 'vestre-aker'
];

async function fetchPilsguidenDistrict(slug) {
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

async function fetchPilsguiden() {
  console.log('  [Pilsguiden.no]');
  const all = new Map();

  for (const slug of DISTRICTS) {
    process.stdout.write(`    ${slug}...`);
    const bars = await fetchPilsguidenDistrict(slug);
    let added = 0;
    for (const b of bars) {
      if (!all.has(b.id)) {
        all.set(b.id, { name: b.bar, pint: b.pint, source: 'pilsguiden' });
        added++;
      }
    }
    console.log(` ${bars.length} bars (${added} new)`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`    Total: ${all.size} unique bars\n`);
  return [...all.values()];
}

// ── Pilsjakt: fetch & parse ──────────────────────────────────────────────────

async function fetchPilsjakt() {
  console.log('  [Pilsjakt.no]');
  const url = 'https://www.pilsjakt.no/topplista';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) { console.warn(`    ⚠ HTTP ${res.status}`); return []; }

  const html = await res.text();

  // Parse summary elements: <span>Name</span> ... price<!-- -->,- ... (volume)
  const pattern = /<span>([^<]+)<\/span>.*?<span class="min-w-\[3rem\]">(\d+)<!-- -->,- (<!-- -->\*)?<\/span>.*?<span>\(<!-- -->([0-9.]+)<!-- -->\)<\/span>/g;

  const bars = [];
  let m;
  while ((m = pattern.exec(html)) !== null) {
    const [, name, priceStr, , volStr] = m;
    const price = parseInt(priceStr);
    const volume = parseFloat(volStr);
    const pint = volume > 0 ? Math.round(price * 0.5 / volume) : price;
    bars.push({ name, pint, source: 'pilsjakt' });
  }

  console.log(`    Total: ${bars.length} bars\n`);
  return bars;
}

// ── Manual overrides ─────────────────────────────────────────────────────────
// venue name → source bar name (for fuzzy matches verified by hand)

const MANUAL_MATCH = {
  // Pilsguiden matches
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
  // Pilsjakt matches
  'The Highbury Pub':                'The Highbury Pub',
  'Kjøkken og Bar':                  'Kjøkken og Bar',
  'Postkontoret':                    'Postkontoret',
  'Pappabuene':                      'Pappabuene',
  'Evviva':                          'Evviva',
  'Handwerk':                        'Handwerk Botaniske',
  'al dente':                        'Bryn Servering  Al Dente',
  'Karlsrud Mat og Vinhus':          'Karlsrud Mat og Vin',
  'Norlaks sushi':                   'Norlaks Sushi Sæter',
  'Egon':                            'Egon Nordstrand',
};

// venue names that should NOT auto-match (manual overrides still work)
const BLOCK_LIST = new Set([
  'Brygga Bar',          // not Brygg Oslo
  'Arts restaurant',     // not Art Bar Oslo
  'Kanpai Izakaya',      // not Izakaya Oslo
  'Valkyrien Grill',     // not Valkyrien Restaurant
  'Postkontoret',        // not Cafékontoret (Pilsguiden) — matched via Pilsjakt override
  'Südøst Restaurant',   // not Øst (different venue)
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

function matchScore(venueName, barName) {
  const a = normalize(venueName);
  const b = normalize(barName);

  if (a.length < 3 || b.length < 3) return 0;
  if (a === b) return 1.0;

  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.5) return 0.9;

  const wa = new Set(a.split(' ').filter(w => w.length > 1));
  const wb = new Set(b.split(' ').filter(w => w.length > 1));
  const shared = [...wa].filter(w => wb.has(w));
  if (shared.length < 1) return 0;

  const intersection = shared.length;
  const union = new Set([...wa, ...wb]).size;
  const jaccard = intersection / union;

  const fa = [...wa].find(w => w.length > 2);
  const fb = [...wb].find(w => w.length > 2);
  const firstBoost = (fa && fb && fa === fb) ? 0.15 : 0;

  return Math.min(jaccard + firstBoost, 0.99);
}

function findBestMatch(venue, bars) {
  // Manual override always wins (checked before block list)
  const override = MANUAL_MATCH[venue.name];
  if (override) {
    const bar = bars.find(b => b.name === override);
    if (bar) return { bar, score: 1.0 };
  }

  if (BLOCK_LIST.has(venue.name)) return null;

  let best = null, bestScore = 0;
  for (const bar of bars) {
    const score = matchScore(venue.name, bar.name);
    if (score > bestScore) { bestScore = score; best = bar; }
  }
  return bestScore >= 0.9 ? { bar: best, score: bestScore } : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching beer prices...\n');

  // Fetch both sources
  const pilsguidenBars = await fetchPilsguiden();
  const pilsjaktBars   = await fetchPilsjakt();

  // Merge: Pilsguiden first (primary), then Pilsjakt (fallback)
  const allBars = [...pilsguidenBars, ...pilsjaktBars];

  const venuesPath = join(ROOT, 'data', 'venues.json');
  const venues = JSON.parse(readFileSync(venuesPath, 'utf8'));

  console.log(`Matching against ${venues.length} venues...\n`);

  let matched = 0, unmatched = 0;
  const results = [];
  const matchedVenues = new Set();

  // Pass 1: match against Pilsguiden (primary — fresher data)
  for (const venue of venues) {
    const match = findBestMatch(venue, pilsguidenBars);
    if (match) {
      const { bar, score } = match;
      results.push({ venue: venue.name, barName: bar.name, price: bar.pint, score, source: 'pilsguiden' });
      venue.beerPrice = bar.pint;
      matchedVenues.add(venue.name);
      matched++;
    }
  }

  // Pass 2: match remaining venues against Pilsjakt (fallback)
  for (const venue of venues) {
    if (matchedVenues.has(venue.name)) continue;
    const match = findBestMatch(venue, pilsjaktBars);
    if (match) {
      const { bar, score } = match;
      results.push({ venue: venue.name, barName: bar.name, price: bar.pint, score, source: 'pilsjakt' });
      venue.beerPrice = bar.pint;
      matchedVenues.add(venue.name);
      matched++;
    } else {
      unmatched++;
    }
  }

  // Print results grouped by source
  results.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
  const pgResults = results.filter(r => r.source === 'pilsguiden');
  const pjResults = results.filter(r => r.source === 'pilsjakt');

  console.log(`  Pilsguiden matches (${pgResults.length}):`);
  for (const r of pgResults) {
    console.log(`  ✓ ${r.venue} → ${r.barName} (${r.price} kr)`);
  }

  console.log(`\n  Pilsjakt matches (${pjResults.length}):`);
  for (const r of pjResults) {
    console.log(`  + ${r.venue} → ${r.barName} (${r.price} kr)`);
  }

  console.log(`\n  Total: ${matched} / ${venues.length} venues (${unmatched} unmatched)`);
  console.log(`    Pilsguiden: ${pgResults.length}  |  Pilsjakt: ${pjResults.length}`);

  if (DRY_RUN) {
    console.log('\n  --dry-run: not writing to venues.json');
  } else {
    writeFileSync(venuesPath, JSON.stringify(venues, null, 2) + '\n');
    console.log(`\n  ✓ Updated venues.json with beerPrice for ${matched} venues`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
