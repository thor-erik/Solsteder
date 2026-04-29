#!/usr/bin/env node
/**
 * Reassigns the `area` field on every venue in data/venues.json based on
 * the venue's coordinates, using a Voronoi-style nearest-seed lookup.
 *
 * Each Oslo neighbourhood gets one or more seed points that hug its
 * actual centre. The closest seed (haversine distance) wins.
 *
 * Run:  node scripts/reassign-areas.mjs
 *
 * The seed table and assignArea() live in ./lib/areas.mjs and are also
 * used by fetch-venues-places.mjs to tag newly-discovered venues at
 * ingest time.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { assignArea } from './lib/areas.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const VENUES_PATH = path.join(__dirname, '..', 'data', 'venues.json');

const venues = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));

const changes = [];
for (const v of venues) {
  const prev = v.area;
  const { area, distance } = assignArea(v.coords);
  if (prev !== area) changes.push({ name: v.name, addr: v.address.split(',')[0], prev, next: area, dist: Math.round(distance) });
  v.area = area;
}

fs.writeFileSync(VENUES_PATH, JSON.stringify(venues, null, 2) + '\n');

console.log(`Reassigned ${changes.length} of ${venues.length} venues.\n`);
const byMove = {};
for (const c of changes) {
  const key = `${c.prev} → ${c.next}`;
  (byMove[key] ??= []).push(c);
}
for (const [k, list] of Object.entries(byMove).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${k}  (${list.length})`);
  for (const c of list.slice(0, 8)) {
    console.log(`  ${c.name}  (${c.addr})  [${c.dist}m]`);
  }
  if (list.length > 8) console.log(`  …and ${list.length - 8} more`);
}

const dist = {};
for (const v of venues) dist[v.area] = (dist[v.area] ?? 0) + 1;
console.log('\nNew area distribution:');
for (const [a, c] of Object.entries(dist).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${a.padEnd(20)} ${c}`);
}
