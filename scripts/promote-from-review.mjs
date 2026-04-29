#!/usr/bin/env node
/**
 * promote-from-review.mjs
 * Moves selected venues from data/venues-review.json into
 * data/venues-fetched.json (so they're auto-merged on the next
 * merge-venues run).
 *
 * Usage:
 *   node scripts/promote-from-review.mjs '["ChIJ...", "ChIJ..."]'
 *
 * The argument is a JSON array of googlePlaceIds — exactly what
 * data/venues-review.html copies to your clipboard when you click
 * "Copy keeper IDs".
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const idsArg = process.argv[2];
if (!idsArg) {
  console.error('Usage: node scripts/promote-from-review.mjs \'["ChIJ...", "ChIJ..."]\'');
  process.exit(1);
}

let ids;
try {
  ids = JSON.parse(idsArg);
  if (!Array.isArray(ids)) throw new Error('not an array');
} catch (e) {
  console.error('Argument must be a JSON array of googlePlaceIds.');
  process.exit(1);
}

const idSet = new Set(ids);
const reviewPath  = join(ROOT, 'data/venues-review.json');
const fetchedPath = join(ROOT, 'data/venues-fetched.json');

const review  = JSON.parse(readFileSync(reviewPath,  'utf8'));
const fetched = JSON.parse(readFileSync(fetchedPath, 'utf8'));

const kept    = review.filter(v => idSet.has(v.googlePlaceId));
const dropped = review.filter(v => !idSet.has(v.googlePlaceId));

if (!kept.length) {
  console.error('No matching entries found in venues-review.json.');
  process.exit(1);
}

// Promote kept entries to fetched (deduplicating on googlePlaceId).
const existingFetchedIds = new Set(fetched.map(v => v.googlePlaceId));
const toAdd = kept.filter(v => !existingFetchedIds.has(v.googlePlaceId));
const merged = [...fetched, ...toAdd];

writeFileSync(fetchedPath, JSON.stringify(merged, null, 2));
writeFileSync(reviewPath,  JSON.stringify(dropped, null, 2));

console.log(`Promoted ${toAdd.length} venues from review → fetched.`);
console.log(`venues-fetched.json: ${fetched.length} → ${merged.length}`);
console.log(`venues-review.json:  ${review.length} → ${dropped.length}`);
console.log(`\nNext: node scripts/merge-venues.mjs`);
