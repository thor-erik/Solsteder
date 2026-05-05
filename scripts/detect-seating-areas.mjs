#!/usr/bin/env node
/**
 * detect-seating-areas.mjs
 *
 * For every venue in data/venues.json, fetches a top-down satellite snapshot
 * via the Mapbox Static Images API and asks Claude (vision) to outline the
 * outdoor-seating polygon. Results are persisted to data/seating-detected.json
 * keyed by venue id, and re-detection only runs when explicitly requested.
 *
 * Cost-aware design:
 *   - Idempotent: a venue with an existing record is skipped unless --force.
 *   - Manual records (source: "manual") are NEVER overwritten by --force-all.
 *   - Per-venue cost ≈ 1 Claude vision call (~$0.005). Mapbox Static API is
 *     free up to 50k requests/month, far above our needs.
 *
 * Usage:
 *   node scripts/detect-seating-areas.mjs                   # only new venues
 *   node scripts/detect-seating-areas.mjs --limit 10        # first 10 missing
 *   node scripts/detect-seating-areas.mjs --ids 1,5,42      # specific subset
 *   node scripts/detect-seating-areas.mjs --force 42        # re-detect one
 *   node scripts/detect-seating-areas.mjs --force-all       # re-detect every AI record
 *   node scripts/detect-seating-areas.mjs --dry-run         # plan only, no API calls
 *
 * Requires in .env:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   MAPBOX_TOKEN=pk.eyJ...
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { imagePixelToLatLng, latLngToImagePixel } from './lib/mercator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────────────────

const SNAPSHOT_ZOOM   = 19;
const SNAPSHOT_W      = 640;
const SNAPSHOT_H      = 640;
const MAPBOX_STYLE    = 'mapbox/satellite-v9';
const CLAUDE_MODEL    = 'claude-sonnet-4-6';
const CONFIDENCE_GATE = 0.5;     // venues below this fall back to the heuristic
const REQUEST_PAUSE_MS = 400;    // gentle on both APIs

// Cache snapshot bytes between runs so a re-detect doesn't refetch Mapbox.
const SNAPSHOT_DIR = join(ROOT, '.cache/seating-snapshots');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name)   { return args.includes(`--${name}`); }
function valueOf(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}

const FORCE_ID    = valueOf('force');
const FORCE_ALL   = flag('force-all');
const LIMIT       = valueOf('limit') ? parseInt(valueOf('limit'), 10) : null;
const DRY_RUN     = flag('dry-run');
const ID_SUBSET   = valueOf('ids')
  ? new Set(valueOf('ids').split(',').map(s => parseInt(s.trim(), 10)))
  : null;

// ── Env / API keys ────────────────────────────────────────────────────────────

let ENV = '';
try { ENV = readFileSync(join(ROOT, '.env'), 'utf8'); } catch (_) {}
function envVal(key) {
  return process.env[key] || (ENV.match(new RegExp(`${key}=(.+)`))?.[1]?.trim() ?? null);
}
const ANTHROPIC_API_KEY = envVal('ANTHROPIC_API_KEY');
const MAPBOX_TOKEN      = envVal('MAPBOX_TOKEN');

if (!DRY_RUN && !ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY (env or .env)'); process.exit(1); }
if (!DRY_RUN && !MAPBOX_TOKEN)      { console.error('Missing MAPBOX_TOKEN (env or .env)');      process.exit(1); }

// ── Inputs ────────────────────────────────────────────────────────────────────

const venuesPath = join(ROOT, 'data/venues.json');
const cachePath  = join(ROOT, 'data/seating-detected.json');
const geomPath   = join(ROOT, 'data/geometry.json');

const venues = JSON.parse(readFileSync(venuesPath, 'utf8'))
  .filter(v => v.businessStatus !== 'CLOSED_PERMANENTLY');

const cache = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, 'utf8'))
  : { version: 1, venues: {} };
if (!cache.venues) cache.venues = {};

const geom = existsSync(geomPath) ? JSON.parse(readFileSync(geomPath, 'utf8')) : null;

if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

// ── Selection logic ───────────────────────────────────────────────────────────

function shouldProcess(v) {
  if (ID_SUBSET && !ID_SUBSET.has(v.id)) return false;
  const rec = cache.venues[String(v.id)];
  if (!rec) return true;
  if (rec.source === 'manual' && !(FORCE_ID && parseInt(FORCE_ID, 10) === v.id)) return false;
  if (FORCE_ALL) return true;
  if (FORCE_ID && parseInt(FORCE_ID, 10) === v.id) return true;
  return false;
}

let queue = venues.filter(shouldProcess);
if (LIMIT) queue = queue.slice(0, LIMIT);

console.log(`Processing ${queue.length} venue(s) of ${venues.length} total ` +
  `(${Object.keys(cache.venues).length} already cached)`);
if (DRY_RUN) {
  for (const v of queue) console.log(`  • [${v.id}] ${v.name}`);
  console.log('Dry run — exiting.');
  process.exit(0);
}

// ── Mapbox Static Image fetch ─────────────────────────────────────────────────

async function fetchSnapshot(v) {
  const cachedFile = join(SNAPSHOT_DIR, `${v.id}.png`);
  if (existsSync(cachedFile)) {
    return readFileSync(cachedFile);
  }
  const [lat, lng] = v.coords;
  const url = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}/static/` +
    `${lng},${lat},${SNAPSHOT_ZOOM},0/` +
    `${SNAPSHOT_W}x${SNAPSHOT_H}@2x` +
    `?access_token=${MAPBOX_TOKEN}&attribution=false&logo=false`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Mapbox HTTP ${resp.status}: ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(cachedFile, buf);
  return buf;
}

// ── Building polygon hint (from geometry.json) ────────────────────────────────

function buildingPixelPolygon(v) {
  if (!geom) return null;
  const g = geom.venues?.[String(v.id)] ?? geom.venues?.[v.id];
  if (!g?.bg) return null;
  const [lat, lng] = v.coords;
  return g.bg.map(([blat, blng]) =>
    latLngToImagePixel(blng, blat, SNAPSHOT_W, SNAPSHOT_H, lng, lat, SNAPSHOT_ZOOM)
  ).map(p => [Math.round(p.x), Math.round(p.y)]);
}

// ── Claude prompt ─────────────────────────────────────────────────────────────

function buildPrompt(v) {
  const bldgPx = buildingPixelPolygon(v);
  const bldgLine = bldgPx
    ? `\nBuilding footprint vertices (image pixel coords, top-left origin): ${JSON.stringify(bldgPx)}`
    : '';
  const center = `(${SNAPSHOT_W / 2}, ${SNAPSHOT_H / 2})`;

  return `You are looking at a top-down satellite image of an outdoor venue in Oslo.

Venue: ${v.name}
Category: ${v.category}
Address: ${v.address ?? '?'}
Image dimensions: ${SNAPSHOT_W}×${SNAPSHOT_H} pixels (top-left origin)
Venue marker location in image: ${center} (center)${bldgLine}

Task: Identify the OUTDOOR SEATING AREA for this venue — the patio, terrace, or
pavement area where chairs and tables are placed outside. It is usually attached
to the building, on a pavement or plaza, and visible as a distinct paved/decked
area, often with parasols, tables, or rectangular shapes.

Return ONLY a JSON object with this exact shape:
{
  "polygon":   [[x, y], [x, y], ...],   // 4–12 vertices in image pixel coords
  "confidence": 0.0–1.0,
  "notVisible": false,                  // true if you cannot see seating clearly
  "reasoning":  "one short sentence"
}

Rules:
- If you cannot identify the seating area with reasonable confidence, set
  notVisible: true and polygon: []. Do not guess.
- Polygon vertices must be ordered (either CW or CCW) and form a simple polygon.
- Coordinates are in pixels of the original ${SNAPSHOT_W}×${SNAPSHOT_H} image.
- Do NOT include the building interior. Only the outdoor area used for seating.
- Output JSON only — no markdown, no commentary.`;
}

// ── Anthropic API call ────────────────────────────────────────────────────────

async function callClaude(imageBytes, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBytes.toString('base64') } },
          { type: 'text',  text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.content?.[0]?.text ?? '';
  // Strip optional markdown fences in case the model adds them despite instructions.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

// ── Polygon conversion ────────────────────────────────────────────────────────

function pixelsToLatLng(polygon, v) {
  const [lat, lng] = v.coords;
  return polygon.map(([px, py]) => {
    const ll = imagePixelToLatLng(px, py, SNAPSHOT_W, SNAPSHOT_H, lng, lat, SNAPSHOT_ZOOM);
    return [Number(ll.lat.toFixed(6)), Number(ll.lng.toFixed(6))];
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let ok = 0, skipped = 0, failed = 0, notVisible = 0;

for (const v of queue) {
  const tag = `[${v.id}] ${v.name}`;
  try {
    const snap = await fetchSnapshot(v);
    const out  = await callClaude(snap, buildPrompt(v));

    const polygon = Array.isArray(out.polygon) ? out.polygon : [];
    const record = {
      polygon:    out.notVisible || polygon.length < 3 ? [] : pixelsToLatLng(polygon, v),
      confidence: typeof out.confidence === 'number' ? out.confidence : 0,
      notVisible: !!out.notVisible || polygon.length < 3,
      detectedAt: new Date().toISOString(),
      model:      CLAUDE_MODEL,
      source:     'ai',
      snapshot:   { zoom: SNAPSHOT_ZOOM, w: SNAPSHOT_W, h: SNAPSHOT_H, style: MAPBOX_STYLE },
      reasoning:  String(out.reasoning ?? '').slice(0, 240),
    };

    cache.venues[String(v.id)] = record;
    if (record.notVisible) { notVisible++; console.log(`  ⊘ ${tag} — not visible`); }
    else                   { ok++;          console.log(`  ✓ ${tag} — ${record.polygon.length} vertices, conf ${record.confidence.toFixed(2)}`); }

    // Persist after each detection so a crash doesn't lose progress.
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    await new Promise(r => setTimeout(r, REQUEST_PAUSE_MS));
  } catch (err) {
    failed++;
    console.warn(`  ✗ ${tag}: ${err.message}`);
  }
}

console.log(`\nDone. ok=${ok} notVisible=${notVisible} failed=${failed} skipped=${skipped}`);
console.log(`Cache: ${cachePath}`);
