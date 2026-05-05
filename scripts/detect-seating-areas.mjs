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
const SNAPSHOT_W      = 640;     // logical (world-pixel) width
const SNAPSHOT_H      = 640;
const DPR             = 2;       // @2x — sharper imagery for chair/parasol detection
const IMAGE_W         = SNAPSHOT_W * DPR;
const IMAGE_H         = SNAPSHOT_H * DPR;
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

// Mapbox returns JPEG for raster-only styles like satellite-v9, PNG for vector.
// Detect from magic bytes so we send the right media_type to Anthropic and so
// cached files keep working regardless of which extension we used.
function detectImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF'
      && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

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
  // latLngToImagePixel returns world-pixel coords (SNAPSHOT_W-space). Mapbox
  // returns the image at @2x, so Claude sees coords in IMAGE_W-space — scale
  // by DPR before handing the hint to Claude.
  return g.bg.map(([blat, blng]) =>
    latLngToImagePixel(blng, blat, SNAPSHOT_W, SNAPSHOT_H, lng, lat, SNAPSHOT_ZOOM)
  ).map(p => [Math.round(p.x * DPR), Math.round(p.y * DPR)]);
}

// ── Claude prompt ─────────────────────────────────────────────────────────────

function buildPrompt(v) {
  const bldgPx = buildingPixelPolygon(v);
  const bldgBlock = bldgPx
    ? `

EXCLUDE this region — it is the venue's BUILDING. No seating goes inside it.
Building footprint vertices (image pixel coords): ${JSON.stringify(bldgPx)}`
    : '';
  const center = `(${IMAGE_W / 2}, ${IMAGE_H / 2})`;

  return `You are looking at a top-down satellite image of an outdoor venue in Oslo.

Venue: ${v.name}
Category: ${v.category}
Address: ${v.address ?? '?'}
Image dimensions: ${IMAGE_W}×${IMAGE_H} pixels (top-left origin)
Venue marker location in image: ${center} (center)${bldgBlock}

Task: Identify the OUTDOOR SEATING AREA for this venue — the area OUTSIDE the
building where the venue places tables, chairs, and parasols for guests.

Visual cues that ARE seating:
- Tables and chairs (small regularly-spaced shapes)
- Parasols / umbrellas (round or square spots, often in rows)
- Raised wooden decking or platforms adjacent to the building
- Awnings or canopies attached to the building
- Clusters of planters, bollards, or rope barriers fencing off a sidewalk area
- For category 'courtyard' or 'beer_garden': the floor of an enclosed courtyard

Visual cues that are NOT seating:
- The building interior (roof, walls, courtyards inside the building footprint)
- Plain lawn, grass, or trees with no visible furniture
- Parked cars, parking lots, roads
- Public parks or plazas more than ~30m from the marker (those belong to the city, not this venue)
- Plain sidewalks with no demarcation, planters, or chairs

Hard constraints (a polygon that violates any of these is wrong — return notVisible:true instead):
1. The polygon MUST NOT contain any pixel inside the building footprint listed above.
2. The polygon MUST be within ~${150 * DPR} pixels (~30 metres) of the venue marker at the image center.
3. The polygon should be ADJACENT to and OUTSIDE the building footprint.

Decision flow:
1. Scan within ~${150 * DPR} pixels of the marker for seating cues from the lists above.
2. If you find a candidate that is OUTSIDE the building footprint AND within
   range, trace it. Lower-confidence traces (down to ~0.5) are fine — we filter
   at runtime.
3. If your only candidates overlap the building, are too far away, or you only
   see lawn/road/parking with no seating cues, return notVisible:true and an
   empty polygon. A wrong polygon is worse than no polygon.
4. If two valid candidates exist, choose the one closer to the marker.

Return ONLY a JSON object with this exact shape:
{
  "polygon":   [[x, y], [x, y], ...],   // 4–12 vertices in image pixel coords
  "confidence": 0.0–1.0,
  "notVisible": false,                  // true when no valid candidate exists
  "reasoning":  "one short sentence"
}

If notVisible is true, polygon must be []. If notVisible is false, polygon must
have at least 4 vertices.

Polygon vertices must be ordered (CW or CCW) and form a simple (non-self-intersecting) polygon.
Coordinates are in pixels of the original ${IMAGE_W}×${IMAGE_H} image.
Output JSON only — no markdown, no commentary, no preamble.`;
}

// ── Anthropic API call ────────────────────────────────────────────────────────

async function callClaude(imageBytes, prompt) {
  const mediaType = detectImageMime(imageBytes);
  if (!mediaType) throw new Error('Unrecognised image format (not PNG/JPEG/WebP)');
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
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBytes.toString('base64') } },
          { type: 'text',  text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.content?.[0]?.text ?? '';
  return parseJsonResponse(text);
}

// Claude occasionally wraps the JSON in markdown fences or prefixes it with
// prose ("Looking at the image..."). Find the first `{` and extract the
// balanced object instead of relying on the model to obey "JSON only".
function parseJsonResponse(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON object in response: ${text.slice(0, 200)}`);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc)            esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"')  inStr = false;
      continue;
    }
    if (c === '"')      inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`Unbalanced JSON in response: ${text.slice(start, start + 200)}`);
}

// ── Polygon conversion ────────────────────────────────────────────────────────

function pixelsToLatLng(polygon, v) {
  const [lat, lng] = v.coords;
  // Claude returns coords in IMAGE_W (1280-px) space; descale by DPR to
  // match the SNAPSHOT_W (640-px world-pixel) space the projection expects.
  return polygon.map(([px, py]) => {
    const ll = imagePixelToLatLng(px / DPR, py / DPR, SNAPSHOT_W, SNAPSHOT_H, lng, lat, SNAPSHOT_ZOOM);
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
