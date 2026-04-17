/**
 * refresh-opening-hours.mjs
 * Refreshes opening hours for all venues in venues.json.
 *
 * Strategy (cheapest first):
 *   1. OSM Overpass API — free, no key. Query amenity nodes near venue coords.
 *   2. Google Places API v1 — Contact tier only (businessStatus + regularOpeningHours).
 *      Only called when OSM has no data.
 *
 * Also checks businessStatus: CLOSED_PERMANENTLY and writes a separate
 * report so the operator can decide which venues to remove.
 *
 * Schema written to venues.json:
 *   openingHours: { open: number, close: number }  — widest window across all days
 *   openingHoursWeekly: { "0": {open,close}, … "6": {open,close} }  — per JS day (0=Sun)
 *   businessStatus: "OPERATIONAL" | "CLOSED_PERMANENTLY" | "CLOSED_TEMPORARILY" | null
 *
 * Usage:   node scripts/refresh-opening-hours.mjs
 * Requires: GOOGLE_PLACES_KEY in .env
 *
 * Cost:
 *   OSM Overpass: free
 *   Google Places (Contact tier): $17/1,000 — only for venues without OSM hours
 *   Worst case (0 OSM hits, 109 venues): ~$1.85
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── API key ───────────────────────────────────────────────────────────────────
const env      = readFileSync(join(ROOT, '.env'), 'utf8');
const keyMatch = env.match(/GOOGLE_PLACES_KEY=(.+)/);
if (!keyMatch) { console.error('GOOGLE_PLACES_KEY not found in .env'); process.exit(1); }
const API_KEY = keyMatch[1].trim();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── OSM Overpass ──────────────────────────────────────────────────────────────

const OVERPASS = 'https://overpass-api.de/api/interpreter';

async function osmHoursNear(lat, lng, name) {
  const query = `
    [out:json][timeout:10];
    (
      node["amenity"]["opening_hours"](around:60,${lat},${lng});
      way["amenity"]["opening_hours"](around:60,${lat},${lng});
    );
    out body;
  `;
  try {
    const resp = await fetch(OVERPASS, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const elements = data.elements ?? [];
    if (!elements.length) return null;

    // Pick the element whose name best matches our venue name
    const norm = s => s.toLowerCase().replace(/[^a-zæøå0-9]/g, '');
    const target = norm(name);
    let best = null, bestScore = 0;
    for (const el of elements) {
      const elName = norm(el.tags?.name ?? '');
      if (!elName) continue;
      // Simple overlap score: how many chars of target appear in elName
      const score = target.split('').filter(c => elName.includes(c)).length / target.length;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    // Require at least 60% character overlap
    if (!best || bestScore < 0.6) return null;

    const raw = best.tags['opening_hours'];
    return raw ? parseOsmHours(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Parse OSM opening_hours string into { open, close, weekly }.
 * Handles the most common patterns:
 *   "Mo-Fr 11:00-22:00; Sa-Su 12:00-00:00"
 *   "11:00-23:00"
 *   "Mo-Su 10:00-23:00"
 */
function parseOsmHours(raw) {
  const DAY_MAP = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 };
  const DAY_NAMES = ['su','mo','tu','we','th','fr','sa'];

  // weekly: JS day (0=Sun) → {open, close}
  const weekly = {};

  // Split on ';' for day-range segments
  const segments = raw.toLowerCase().split(';').map(s => s.trim()).filter(Boolean);

  for (const seg of segments) {
    // Match optional day spec + time range
    const m = seg.match(/^([a-z,\-\s]+?)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/) ||
              seg.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) continue;

    let daySpec, openStr, closeStr;
    if (m.length === 4) {
      [, daySpec, openStr, closeStr] = m;
    } else {
      // No day spec → applies to all days
      daySpec = 'mo-su';
      [, openStr, closeStr] = m;
    }

    const openH  = parseFloat(openStr.replace(':', '.').replace(/\.(\d{2})/, (_, mm) => '.' + (parseInt(mm)/60).toFixed(3).slice(2)));
    let closeH = parseFloat(closeStr.replace(':', '.').replace(/\.(\d{2})/, (_, mm) => '.' + (parseInt(mm)/60).toFixed(3).slice(2)));
    if (closeH === 0) closeH = 24; // midnight closing

    // Resolve day range
    const affectedDays = [];
    const dayParts = daySpec.split(',').map(d => d.trim());
    for (const part of dayParts) {
      const rangeMatch = part.match(/^([a-z]{2})-([a-z]{2})$/);
      if (rangeMatch) {
        const from = DAY_NAMES.indexOf(rangeMatch[1]);
        const to   = DAY_NAMES.indexOf(rangeMatch[2]);
        if (from === -1 || to === -1) continue;
        // Mo-Su range: from < to means simple span; wrap around if needed
        if (from <= to) {
          for (let i = from; i <= to; i++) affectedDays.push(DAY_MAP[DAY_NAMES[i]]);
        } else {
          for (let i = from; i < DAY_NAMES.length; i++) affectedDays.push(DAY_MAP[DAY_NAMES[i]]);
          for (let i = 0; i <= to; i++) affectedDays.push(DAY_MAP[DAY_NAMES[i]]);
        }
      } else {
        const single = DAY_MAP[part.slice(0,2)];
        if (single != null) affectedDays.push(single);
      }
    }

    for (const day of affectedDays) {
      weekly[String(day)] = { open: Math.round(openH * 10) / 10, close: Math.round(closeH * 10) / 10 };
    }
  }

  if (!Object.keys(weekly).length) return null;

  // Derive representative open/close as widest window
  const opens  = Object.values(weekly).map(h => h.open);
  const closes = Object.values(weekly).map(h => h.close);
  return {
    open:   Math.min(...opens),
    close:  Math.max(...closes),
    weekly,
    source: 'osm',
  };
}

// ── Google Places API v1 ──────────────────────────────────────────────────────

async function googleHours(placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const resp = await fetch(url, {
    headers: {
      'X-Goog-Api-Key':   API_KEY,
      'X-Goog-FieldMask': 'businessStatus,regularOpeningHours',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Places API HTTP ${resp.status}`);
  const data = await resp.json();

  const status = data.businessStatus ?? null;

  const periods = data.regularOpeningHours?.periods;
  if (!periods?.length) return { status, hours: null };

  // periods[].open/close: { day: 0-6 (Sun=0), hour, minute }
  const weekly = {};
  for (const p of periods) {
    if (!p.open || !p.close) continue;
    const day   = String(p.open.day);
    const openH  = p.open.hour  + (p.open.minute  ?? 0) / 60;
    let closeH   = p.close.hour + (p.close.minute ?? 0) / 60;
    if (closeH === 0 && p.close.day !== p.open.day) closeH = 24;
    weekly[day] = { open: Math.round(openH * 10) / 10, close: Math.round(closeH * 10) / 10 };
  }

  if (!Object.keys(weekly).length) return { status, hours: null };

  const opens  = Object.values(weekly).map(h => h.open);
  const closes = Object.values(weekly).map(h => h.close);
  return {
    status,
    hours: {
      open:   Math.min(...opens),
      close:  Math.max(...closes),
      weekly,
      source: 'google',
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const venuesPath = join(ROOT, 'data/venues.json');
const venues     = JSON.parse(readFileSync(venuesPath, 'utf8'));

const closed   = []; // CLOSED_PERMANENTLY — reported for manual removal
let osmHits    = 0;
let googleHits = 0;
let noData     = 0;
let googleCalls = 0;

console.log(`Refreshing opening hours for ${venues.length} venues…\n`);

for (const v of venues) {
  process.stdout.write(`  ${v.name} … `);

  // 1. Try OSM
  const osmResult = await osmHoursNear(v.coords[0], v.coords[1], v.name);
  await sleep(300); // be polite to Overpass

  if (osmResult) {
    v.openingHours       = { open: osmResult.open, close: osmResult.close };
    v.openingHoursWeekly = osmResult.weekly;
    v.hoursSource        = 'osm';
    osmHits++;
    console.log(`OSM ✓  (${osmResult.open}–${osmResult.close})`);
    continue;
  }

  // 2. Fall back to Google Places
  if (!v.googlePlaceId) {
    noData++;
    console.log('no placeId — skipped');
    continue;
  }

  try {
    await sleep(100);
    const { status, hours } = await googleHours(v.googlePlaceId);
    googleCalls++;

    v.businessStatus = status;

    if (status === 'CLOSED_PERMANENTLY') {
      closed.push({ id: v.id, name: v.name, address: v.address });
      console.log('CLOSED_PERMANENTLY ⚠');
    } else if (hours) {
      v.openingHours       = { open: hours.open, close: hours.close };
      v.openingHoursWeekly = hours.weekly;
      v.hoursSource        = 'google';
      googleHits++;
      console.log(`Google ✓  (${hours.open}–${hours.close})${status !== 'OPERATIONAL' ? '  [' + status + ']' : ''}`);
    } else {
      noData++;
      console.log('no hours data');
    }
  } catch (err) {
    noData++;
    console.log(`Google error: ${err.message}`);
  }
}

// ── Write results ─────────────────────────────────────────────────────────────

writeFileSync(venuesPath, JSON.stringify(venues, null, 2));
console.log(`\nUpdated: data/venues.json`);

if (closed.length) {
  const reportPath = join(ROOT, 'data/closed-venues-report.json');
  writeFileSync(reportPath, JSON.stringify(closed, null, 2));
  console.log(`\n⚠  ${closed.length} venue(s) marked CLOSED_PERMANENTLY — review data/closed-venues-report.json`);
  for (const v of closed) console.log(`   • ${v.name} (id ${v.id})`);
}

console.log(`
Summary:
  OSM hits:      ${osmHits}
  Google hits:   ${googleHits}  (${googleCalls} API calls, ~$${(googleCalls * 0.017).toFixed(2)})
  No data:       ${noData}
  Closed:        ${closed.length}
`);
