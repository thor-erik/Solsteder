/**
 * area-mismatch-report.mjs — READ-ONLY area-quality report (Track 2, step 1).
 *
 * Does NOT modify data/venues.json. Surfaces, for review, where a venue's
 * assigned `area` is questionable, using three independent lenses:
 *
 *   1. STALE: stored v.area vs the nearest current seed (assignArea). If they
 *      differ, the stored value predates a seed change — re-running
 *      reassign-areas.mjs would flip it. (Coordinate-based, no network.)
 *   2. SELF-NAME: the neighborhood the venue uses in its OWN name vs v.area.
 *      Per the agreed priority rule, the venue's self-named location is the
 *      stronger signal — a disagreement is a likely mislabel.
 *   3. FINE CANDIDATES: neighborhoods that appear in names but aren't areas yet
 *      (Tveita, Bjørvika, Sørenga, Vika, Solli…) — candidates to promote to
 *      real areas so the card can show them.
 *
 * The coordinate/boundary auto-labeling (OSM place nodes via Overpass) is the
 * NEXT step — it needs network and will reuse this report's gazetteer. For now
 * this gives us a concrete artifact to review together before any regen.
 *
 * Run:  node scripts/area-mismatch-report.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SEEDS, AREA_NAMES, assignArea } from './lib/areas.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const venues = JSON.parse(readFileSync(join(ROOT, 'data', 'venues.json'), 'utf8'));

// Fine neighborhoods that appear in venue NAMES but aren't coarse areas yet.
// Grounded in the trailing-token extraction (evidence in the data) + the
// neighborhoods the user named. NOT lat/lng yet — that's the OSM step.
const FINE_NEIGHBORHOODS = [
  'Vika', 'Solli', 'Bjørvika', 'Sørenga', 'Løren', 'Bjølsen', 'Storo',
  'Ullevål', 'Holtet', 'Tveita', 'Hovedøya', 'Frognerparken', 'Manglerud',
  'Frysja', 'Fredensborg', 'Hasle', 'Carl Berners plass', 'Rådhusplassen',
];

// Full gazetteer = coarse areas ∪ fine neighborhoods. Longest match wins so
// "Aker Brygge" / "Carl Berners plass" beat their single-word substrings.
const GAZETTEER = [...new Set([...AREA_NAMES, ...FINE_NEIGHBORHOODS])]
  .sort((a, b) => b.length - a.length);
const COARSE = new Set(AREA_NAMES);
const NOISE = new Set(['oslo']); // city name — never a neighborhood signal

/** Find the neighborhood a venue names itself with (longest gazetteer hit). */
function nameNeighborhood(name) {
  const low = ' ' + name.toLowerCase() + ' ';
  for (const g of GAZETTEER) {
    if (NOISE.has(g.toLowerCase())) continue;
    // word-boundary-ish: surrounded by space / punctuation
    const re = new RegExp('(^|[\\s\\-–,])' + g.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s\\-–,])');
    if (re.test(low)) return g;
  }
  return '';
}

const stale = [], selfName = [], fineHits = new Map(), vikaSolli = [];
let withName = 0;

for (const v of venues) {
  const area = (v.area || '').trim();
  const nm = (v.name || '').trim();
  const coords = v.coords || (v.lat != null ? [v.lat, v.lng] : null);

  // Lens 1 — stale vs nearest seed
  if (coords) {
    const { area: nearest, distance } = assignArea(coords);
    if (nearest && area && nearest !== area) {
      stale.push({ name: nm, stored: area, nearest, m: Math.round(distance) });
    }
  }

  // Lens 2 + 3 — self-named neighborhood
  const nbhd = nameNeighborhood(nm);
  if (nbhd) {
    withName++;
    if (COARSE.has(nbhd)) {
      if (area && nbhd !== area) selfName.push({ name: nm, stored: area, named: nbhd });
    } else {
      // fine neighborhood candidate
      if (!fineHits.has(nbhd)) fineHits.set(nbhd, []);
      fineHits.get(nbhd).push({ name: nm, stored: area });
    }
  }

  // Vika / Solli — named or addressed there but bundled elsewhere
  const hay = (nm + ' ' + (v.address || '')).toLowerCase();
  if ((/\bvika\b/.test(hay) || /\bsolli\b/.test(hay)) && !/bjørvika/.test(hay)) {
    vikaSolli.push({ name: nm, stored: area, addr: v.address || '' });
  }
}

const line = '─'.repeat(72);
console.log(`\n${line}\nAREA MISMATCH REPORT  ·  ${venues.length} venues  ·  read-only (no data changed)\n${line}`);

console.log(`\n① STALE vs nearest seed  (${stale.length}) — stored area ≠ nearest current seed`);
console.log('   (re-running reassign-areas.mjs would change these; review whether the seed or the venue is wrong)');
for (const s of stale.slice(0, 40)) console.log(`   ${s.name.padEnd(38)} stored=${s.stored.padEnd(16)} → nearest=${s.nearest} (${s.m} m)`);
if (stale.length > 40) console.log(`   …and ${stale.length - 40} more`);

console.log(`\n② SELF-NAME mismatch  (${selfName.length}) — name says a different COARSE area than assigned`);
for (const s of selfName) console.log(`   ${s.name.padEnd(38)} stored=${s.stored.padEnd(16)} named=${s.named}`);

console.log(`\n③ FINE-NEIGHBORHOOD candidates — in names, not areas yet (promote?):`);
for (const [nbhd, vs] of [...fineHits.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const storedAreas = [...new Set(vs.map(x => x.stored))].join(', ');
  console.log(`   ${nbhd.padEnd(18)} ${String(vs.length).padStart(2)} venue(s)  currently → ${storedAreas}`);
  for (const x of vs) console.log(`        · ${x.name}`);
}

console.log(`\n④ VIKA / SOLLI candidates  (${vikaSolli.length}) — named/addressed Vika or Solli`);
for (const s of vikaSolli) console.log(`   ${s.name.padEnd(38)} stored=${s.stored.padEnd(12)} ${s.addr}`);

console.log(`\n${line}`);
console.log(`coverage: ${withName}/${venues.length} venues carry a recognized neighborhood in their name`);
console.log(`next step: OSM place-node fetch (Overpass) → coordinate auto-label, cross-checked against these names`);
console.log(`${line}\n`);
