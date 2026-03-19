/**
 * merge-venues.mjs
 * Merges reviewed venues-candidates.json into venues.json.
 * Assigns sequential IDs to new entries.
 *
 * Usage: node scripts/merge-venues.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = join(__dirname, '..');
const venuesPath   = join(ROOT, 'data/venues.json');
const candidatePath = join(ROOT, 'data/venues-candidates.json');

const existing   = JSON.parse(readFileSync(venuesPath,    'utf8'));
const candidates = JSON.parse(readFileSync(candidatePath, 'utf8'));

if (!candidates.length) {
  console.log('No candidates to merge.');
  process.exit(0);
}

let nextId = Math.max(...existing.map(v => v.id), 0) + 1;

const toAdd = candidates.map(c => ({ id: nextId++, ...c }));
const merged = [...existing, ...toAdd];

writeFileSync(venuesPath, JSON.stringify(merged, null, 2));

console.log(`Added ${toAdd.length} venues. Total: ${merged.length}`);
console.log(`Next: node scripts/update-geometry.mjs`);
