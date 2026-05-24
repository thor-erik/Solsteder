/**
 * apply-fine-areas.mjs — write the reviewed fine neighborhoods into venues.json.
 *
 * Reads data/area-assign-review.json (produced by assign-fine-areas.mjs, already
 * reviewed) and sets `areaFine` on each matching venue. Offline — no network.
 * Additive: never touches the existing `area` (coarse) field. Venues with no
 * fine neighborhood get `areaFine` removed (so re-runs stay clean).
 *
 *   node scripts/apply-fine-areas.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vPath = join(ROOT, 'data', 'venues.json');
const rPath = join(ROOT, 'data', 'area-assign-review.json');

const venues = JSON.parse(readFileSync(vPath, 'utf8'));
const review = JSON.parse(readFileSync(rPath, 'utf8'));
const byId = new Map(review.map(r => [r.id, r]));

let set = 0, cleared = 0;
for (const v of venues) {
  const r = byId.get(v.id);
  const fine = r && r.finalFine ? r.finalFine : '';
  if (fine) { if (v.areaFine !== fine) set++; v.areaFine = fine; }
  else if ('areaFine' in v) { delete v.areaFine; cleared++; }
}

// Preserve 2-space formatting + no trailing newline to match the existing file.
writeFileSync(vPath, JSON.stringify(venues, null, 2));
console.log(`areaFine set on ${set} venues, cleared on ${cleared}. venues.json updated.`);
