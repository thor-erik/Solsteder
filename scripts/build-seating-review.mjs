#!/usr/bin/env node
/**
 * build-seating-review.mjs
 * Static HTML grid for QC-reviewing AI-detected outdoor-seating polygons.
 * Each tile shows the cached satellite snapshot with the detected polygon
 * overlaid in SVG, plus confidence + reasoning + a "force re-detect" link.
 *
 * Output: data/seating-review.html  (open in a browser)
 *
 * Usage:
 *   node scripts/build-seating-review.mjs
 *   node scripts/build-seating-review.mjs --include-manual
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const args            = process.argv.slice(2);
const INCLUDE_MANUAL  = args.includes('--include-manual');

const venues = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'));
const cache  = JSON.parse(readFileSync(join(ROOT, 'data/seating-detected.json'), 'utf8'));

const SNAPSHOT_DIR     = join(ROOT, '.cache/seating-snapshots');
const REVIEW_ASSET_DIR = join(ROOT, 'data/seating-review-assets');
if (!existsSync(REVIEW_ASSET_DIR)) mkdirSync(REVIEW_ASSET_DIR, { recursive: true });

const venueById = Object.fromEntries(venues.map(v => [String(v.id), v]));

const escape = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
);

// Sort: low-confidence first (most likely to need review), then notVisible, then by id.
const records = Object.entries(cache.venues ?? {})
  .filter(([id]) => venueById[id])
  .filter(([, r]) => INCLUDE_MANUAL || r.source !== 'manual')
  .sort(([, a], [, b]) => {
    if (a.notVisible !== b.notVisible) return a.notVisible ? -1 : 1;
    return (a.confidence ?? 0) - (b.confidence ?? 0);
  });

const SNAP_W = 640, SNAP_H = 640, SNAP_ZOOM = 19;
const DPR    = 2;                          // Mapbox @2x — actual image is 1280×1280
const IMG_W  = SNAP_W * DPR, IMG_H = SNAP_H * DPR;

// Same Mercator helpers as the pipeline — re-implemented here so the review
// page works without importing the script's lib (keeps the HTML self-contained).
const TILE = 256;
function project(lng, lat, zoom) {
  const ws = TILE * Math.pow(2, zoom);
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360 * ws,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * ws,
  };
}
function latLngToImagePixel(lng, lat, w, h, cLng, cLat, zoom) {
  const c = project(cLng, cLat, zoom);
  const p = project(lng, lat, zoom);
  return { x: p.x - c.x + w / 2, y: p.y - c.y + h / 2 };
}

const tiles = records.map(([id, rec]) => {
  const v = venueById[id];
  const [lat, lng] = v.coords;

  // Copy snapshot into the assets dir so the HTML can reference it relatively.
  const srcSnap = join(SNAPSHOT_DIR, `${id}.png`);
  let snapHref  = '';
  if (existsSync(srcSnap)) {
    const dst = join(REVIEW_ASSET_DIR, `${id}.png`);
    copyFileSync(srcSnap, dst);
    snapHref = `seating-review-assets/${id}.png`;
  }

  // Project polygon (lat/lng) → world-pixel coords → image-pixel coords (×DPR)
  // so the SVG aligns with the @2x satellite snapshot.
  const polyPx = (rec.polygon ?? []).map(([plat, plng]) => {
    const p = latLngToImagePixel(plng, plat, SNAP_W, SNAP_H, lng, lat, SNAP_ZOOM);
    return { x: p.x * DPR, y: p.y * DPR };
  });
  const polyPoints = polyPx.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const conf       = (rec.confidence ?? 0).toFixed(2);
  const confColor  = rec.notVisible ? '#888'
                   : (rec.confidence ?? 0) < 0.5 ? '#e54'
                   : (rec.confidence ?? 0) < 0.75 ? '#fa3' : '#2c8';
  const sourceTag  = rec.source === 'manual' ? '<span class="tag manual">manual</span>' : '';
  const detectedAt = (rec.detectedAt ?? '').slice(0, 10);

  return `
    <article class="tile" data-id="${id}">
      <header>
        <b>${escape(v.name)}</b>
        <span class="meta">${escape(v.area ?? '')} · ${escape(v.category ?? '')}</span>
      </header>
      <div class="canvas">
        ${snapHref ? `<img src="${snapHref}" width="${SNAP_W / 2}" height="${SNAP_H / 2}" alt="">` : '<div class="missing">no snapshot</div>'}
        ${polyPx.length >= 3 ? `<svg viewBox="0 0 ${IMG_W} ${IMG_H}" preserveAspectRatio="none"><polygon points="${polyPoints}" /></svg>` : ''}
      </div>
      <footer>
        <span class="conf" style="color:${confColor}">conf ${conf}${rec.notVisible ? ' · not visible' : ''}</span>
        ${sourceTag}
        <span class="date">${detectedAt}</span>
      </footer>
      <p class="reasoning">${escape(rec.reasoning ?? '')}</p>
      <p class="actions">
        <a href="https://www.google.com/maps/@${lat},${lng},20z" target="_blank" rel="noopener">Maps</a> ·
        <code>node scripts/detect-seating-areas.mjs --force ${id}</code>
      </p>
    </article>
  `;
}).join('');

const stats = {
  total:      records.length,
  notVisible: records.filter(([, r]) => r.notVisible).length,
  lowConf:    records.filter(([, r]) => !r.notVisible && (r.confidence ?? 0) < 0.5).length,
  manual:     records.filter(([, r]) => r.source === 'manual').length,
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Seating detection QC (${stats.total})</title>
<style>
  body { font: 13px/1.45 -apple-system, sans-serif; margin: 0; background: #1a1f2c; color: #eee; }
  header.page { padding: 12px 18px; background: #11161f; border-bottom: 1px solid #2a3142; position: sticky; top: 0; z-index: 5; }
  header.page h1 { font-size: 15px; margin: 0 0 4px; }
  header.page .stats { color: #9ab; font-size: 12px; }
  main { display: grid; gap: 14px; padding: 14px; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
  .tile { background: #232a39; border: 1px solid #2e3648; border-radius: 8px; padding: 10px; }
  .tile header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .tile header b { font-size: 13px; }
  .tile .meta { color: #8ca1c0; font-size: 11px; }
  .canvas { position: relative; width: ${SNAP_W / 2}px; height: ${SNAP_H / 2}px; background: #000; }
  .canvas img { display: block; }
  .canvas svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .canvas svg polygon { fill: rgba(255,175,133,0.30); stroke: #ffaf85; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .canvas .missing { display: flex; align-items: center; justify-content: center; height: 100%; color: #678; font-size: 11px; }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; }
  footer .conf { font-weight: 600; }
  footer .date { color: #678; }
  .tag { padding: 1px 6px; border-radius: 4px; background: #314; color: #eaf; font-size: 10px; }
  .tag.manual { background: #251; color: #ade; }
  .reasoning { margin: 6px 0 4px; color: #9ab; font-size: 11px; }
  .actions { margin: 0; font-size: 11px; color: #678; }
  .actions a { color: #6cf; }
  .actions code { background: #11161f; padding: 1px 4px; border-radius: 3px; color: #fc9; }
</style>
</head>
<body>
<header class="page">
  <h1>Seating detection QC</h1>
  <div class="stats">
    ${stats.total} records · ${stats.notVisible} not visible ·
    ${stats.lowConf} low-confidence (&lt; 0.5) · ${stats.manual} manual
  </div>
</header>
<main>${tiles}</main>
</body>
</html>`;

const outPath = join(ROOT, 'data/seating-review.html');
writeFileSync(outPath, html);
console.log(`Wrote ${outPath} (${stats.total} records)`);
