#!/usr/bin/env node
/**
 * evaluate-detection.mjs
 *
 * Compares the AI proposal (record.originalAi.polygon) against the human
 * correction (record.polygon, source:'manual') for every venue with both,
 * using Intersection-over-Union as the quality metric.
 *
 * Output:
 *   - mean IoU across all corrections
 *   - bucketed distribution
 *   - top N worst regressions (lowest IoU — biggest learning targets)
 *   - per-category breakdown
 *   - per-promptHash breakdown (use this to A/B prompt versions)
 *
 * IoU is computed by rasterising both polygons onto a shared grid in
 * lat/lng-projected world-pixel space at zoom 19. Resolution is fixed at
 * 0.5 m / cell — fine enough for a few-metre terrace and fast in pure JS.
 *
 * Usage:
 *   node scripts/evaluate-detection.mjs                # all manual records
 *   node scripts/evaluate-detection.mjs --top 10       # show 10 worst
 *   node scripts/evaluate-detection.mjs --category cafe
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Inlined Web Mercator projection (mirrors scripts/lib/mercator.js) — keeps
// this script runnable on Node 18 without an ESM/CJS interop dance.
const TILE = 256;
function projectMerc(lng, lat, zoom) {
  const ws = TILE * Math.pow(2, zoom);
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360 * ws,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * ws,
  };
}
function latLngToImagePixel(lng, lat, w, h, cLng, cLat, zoom) {
  const c = projectMerc(cLng, cLat, zoom);
  const p = projectMerc(lng, lat, zoom);
  return { x: p.x - c.x + w / 2, y: p.y - c.y + h / 2 };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const args        = process.argv.slice(2);
const TOP_N       = (() => { const i = args.indexOf('--top'); return i >= 0 ? parseInt(args[i+1], 10) : 5; })();
const CAT_FILTER  = (() => { const i = args.indexOf('--category'); return i >= 0 ? args[i+1] : null; })();

const venues = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'));
const cache  = JSON.parse(readFileSync(join(ROOT, 'data/seating-detected.json'), 'utf8'));
const venueById = Object.fromEntries(venues.map(v => [String(v.id), v]));

// ── IoU via rasterisation ─────────────────────────────────────────────────────

const ZOOM        = 19;
const M_PER_WPX   = 95.4 / 640;        // ~0.149 at Oslo's latitude
const CELL_M      = 0.5;
const CELL_PER_WPX = CELL_M / M_PER_WPX; // ~3.36 cells per world-pixel

function projectPoly(poly, centerLng, centerLat) {
  // Project a [[lat,lng], ...] polygon into pixel coords (640-space) centred
  // on the venue. The centre is arbitrary — both polygons use the same one,
  // so the IoU is invariant.
  return poly.map(([lat, lng]) =>
    latLngToImagePixel(lng, lat, 640, 640, centerLng, centerLat, ZOOM)
  );
}

/** Even-odd point-in-polygon for 2D pixel coords. */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const { x: xi, y: yi } = poly[i];
    const { x: xj, y: yj } = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function bbox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function iou(polyA, polyB) {
  if (!polyA?.length || !polyB?.length) return 0;
  const ba = bbox(polyA), bb = bbox(polyB);
  const minX = Math.min(ba.minX, bb.minX) - 1;
  const minY = Math.min(ba.minY, bb.minY) - 1;
  const maxX = Math.max(ba.maxX, bb.maxX) + 1;
  const maxY = Math.max(ba.maxY, bb.maxY) + 1;
  const step = 1 / CELL_PER_WPX; // ~0.3 pixel steps → 0.5 m cells
  let inter = 0, union = 0;
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const inA = pointInPoly(x, y, polyA);
      const inB = pointInPoly(x, y, polyB);
      if (inA && inB) inter++;
      if (inA || inB) union++;
    }
  }
  return union > 0 ? inter / union : 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const records = [];
for (const [id, r] of Object.entries(cache.venues ?? {})) {
  if (r.source !== 'manual') continue;
  if (!r.originalAi?.polygon?.length) continue;
  if (!Array.isArray(r.polygon) || r.polygon.length < 3) continue;
  const v = venueById[id];
  if (!v) continue;
  if (CAT_FILTER && v.category !== CAT_FILTER) continue;
  const [lat, lng] = v.coords;
  const pxManual = projectPoly(r.polygon, lng, lat);
  const pxAi     = projectPoly(r.originalAi.polygon, lng, lat);
  records.push({
    id, name: v.name, category: v.category,
    promptHash: r.originalAi.promptHash ?? '?',
    aiConfidence: r.originalAi.confidence,
    iou: iou(pxManual, pxAi),
  });
}

if (!records.length) {
  console.log('No corrections to evaluate yet.');
  console.log('(Records need source:"manual" with an originalAi.polygon to be scored.)');
  process.exit(0);
}

// ── Reports ───────────────────────────────────────────────────────────────────

const mean    = records.reduce((s, r) => s + r.iou, 0) / records.length;
const buckets = { '<0.3': 0, '0.3-0.5': 0, '0.5-0.7': 0, '>=0.7': 0 };
for (const r of records) {
  const x = r.iou;
  if (x < 0.3)      buckets['<0.3']++;
  else if (x < 0.5) buckets['0.3-0.5']++;
  else if (x < 0.7) buckets['0.5-0.7']++;
  else              buckets['>=0.7']++;
}

const byCat = {};
for (const r of records) {
  (byCat[r.category] ??= []).push(r.iou);
}
const byPrompt = {};
for (const r of records) {
  (byPrompt[r.promptHash] ??= []).push(r.iou);
}
const fmtMean = arr => (arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(3);

console.log(`\nEvaluated ${records.length} correction(s)`);
console.log(`Mean IoU: ${mean.toFixed(3)}`);
console.log(`Distribution:`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v}`);

console.log(`\nBy category:`);
for (const [cat, ious] of Object.entries(byCat).sort((a, b) => fmtMean(a[1]) - fmtMean(b[1]))) {
  console.log(`  ${cat.padEnd(20)} n=${String(ious.length).padStart(3)}  IoU=${fmtMean(ious)}`);
}
console.log(`\nBy prompt hash:`);
for (const [h, ious] of Object.entries(byPrompt)) {
  console.log(`  ${h.padEnd(10)} n=${String(ious.length).padStart(3)}  IoU=${fmtMean(ious)}`);
}

console.log(`\nWorst ${TOP_N} (lowest IoU):`);
records.sort((a, b) => a.iou - b.iou);
for (const r of records.slice(0, TOP_N)) {
  console.log(`  IoU=${r.iou.toFixed(3)}  conf=${r.aiConfidence?.toFixed(2)}  ${r.category.padEnd(14)}  [${r.id}] ${r.name}`);
}
