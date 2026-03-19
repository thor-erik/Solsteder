/**
 * solar.js — Pure solar position math.
 * No DOM dependencies — runs on main thread AND in the Web Worker via importScripts.
 */

const RAD         = Math.PI / 180;
const OSLO_LAT    = 59.9139;          // degrees

// Sun table: 15-minute steps from 03:00 → 24:00  (84 slots)
const SOLAR_STEP  = 0.25;
const SOLAR_START = 3;
const SOLAR_END   = 24;
const SOLAR_SLOTS = Math.round((SOLAR_END - SOLAR_START) / SOLAR_STEP); // 84

// ── Core solar position ───────────────────────────────────────────────────────

/**
 * Compute sun azimuth (°, N=0 clockwise) and altitude (°) for Oslo.
 * hour: decimal local Oslo time (e.g. 13.5 = 13:30).
 * Use buildSunTable() + getSunFromTable() instead of calling this in a loop.
 */
function getSun(dateStr, hour) {
  const d   = new Date(dateStr + 'T12:00:00');
  const doy = Math.round((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
  const B   = (360 / 365) * (doy - 81) * RAD;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const tz  = (d.getMonth() >= 2 && d.getMonth() <= 9) ? 2 : 1;
  const noon = 12 - (10.7522 - 15 * tz) / 15 - eot / 60;
  const decl = 23.45 * Math.sin((360 / 365) * (doy - 81) * RAD) * RAD;
  const lat  = OSLO_LAT * RAD;
  const ha   = (hour - noon) * 15 * RAD;
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAlt = Math.cos(altRad) || 1e-6;
  const cosAz  = (Math.sin(decl) - Math.sin(lat) * sinAlt) / (Math.cos(lat) * cosAlt);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
  if (Math.sin(ha) > 0) az = 360 - az;
  return { alt: altRad / RAD, az };
}

/**
 * Returns true if a terrace facing `facing`° is in sun given sun az/alt.
 * ±72° tolerance = 144° window. Used as fallback when shadow data is unavailable.
 */
function venueInSun(facing, sunAz, sunAlt) {
  if (sunAlt < 2) return false;
  let diff = Math.abs(sunAz - facing);
  if (diff > 180) diff = 360 - diff;
  return diff <= 72;
}

// ── Point-in-polygon (also used by shadow testing in worker) ─────────────────
function pointInPolygon(lat, lng, nodes) {
  let inside = false;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) {
    const xi = nodes[i].lon, yi = nodes[i].lat;
    const xj = nodes[j].lon, yj = nodes[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

// ── Building shadow casting ───────────────────────────────────────────────────

/**
 * Extract building height in metres from OSM tags.
 * Prefers explicit building:height, falls back to levels × 3.5 m, then 10.5 m default.
 */
function extractBuildingHeight(tags) {
  if (tags['building:height']) return parseFloat(tags['building:height']);
  const levels     = parseFloat(tags['building:levels'] || 0);
  const roofLevels = parseFloat(tags['roof:levels']     || 0);
  if (levels > 0) return levels * 3.5 + roofLevels * 1.5;
  return 10.5; // ~3 floors, typical Oslo
}

/**
 * Returns true if ground point (lat, lng) is in the shadow cast by `building`
 * given the current sun position.
 *
 * Algorithm: a point is in shadow if it is inside either
 *   (a) the building footprint itself, or
 *   (b) the footprint translated by the shadow vector (height × sun direction).
 * This covers the direct underside and the main shadow lobe.
 * The thin "side-wall" triangles between the two polygons are a minor approximation
 * error acceptable for terrace-level shadow decisions.
 */
function pointInBuildingShadow(lat, lng, building, sunAz, sunAlt) {
  const { geometry: nodes, height } = building;
  if (!nodes || nodes.length < 3 || height <= 0) return false;

  // Inside the building footprint → always shadowed
  if (pointInPolygon(lat, lng, nodes)) return true;

  // Shadow offset: per metre of height, shadow extends this far on the ground
  const tanAlt = Math.tan(sunAlt * RAD);
  if (tanAlt <= 0) return false;
  const avgLat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
  const dLat   = -Math.cos(sunAz * RAD) / (tanAlt * 111320);
  const dLon   = -Math.sin(sunAz * RAD) / (tanAlt * 111320 * Math.cos(avgLat * RAD));

  const shadowNodes = nodes.map(n => ({
    lat: n.lat + height * dLat,
    lon: n.lon + height * dLon,
  }));
  return pointInPolygon(lat, lng, shadowNodes);
}

/**
 * Primary sun-state function used by window computation and live rendering.
 * Uses building shadow casting when nearbyBuildings is populated (after initFacings),
 * falls back to the facing-angle heuristic otherwise.
 */
function venueSunState(venue, sunAz, sunAlt) {
  if (sunAlt < 2) return false;
  if (venue.nearbyBuildings && venue.nearbyBuildings.length > 0) {
    for (const b of venue.nearbyBuildings) {
      if (pointInBuildingShadow(venue.lat, venue.lng, b, sunAz, sunAlt)) return false;
    }
    return true;
  }
  return venueInSun(venue.facing, sunAz, sunAlt);
}

// ── Sun table (pre-computed lookup) ──────────────────────────────────────────

/**
 * Build a flat Float64Array of [az, alt] pairs for every 15-minute slot.
 * Call once per date change; pass to getSunFromTable() for O(1) lookups.
 * The buffer can be transferred zero-copy to the Web Worker.
 */
function buildSunTable(dateStr) {
  const table = new Float64Array(SOLAR_SLOTS * 2);
  for (let i = 0; i < SOLAR_SLOTS; i++) {
    const { az, alt } = getSun(dateStr, SOLAR_START + i * SOLAR_STEP);
    table[i * 2]     = az;
    table[i * 2 + 1] = alt;
  }
  return table;
}

/** O(1) sun position lookup from a pre-built table. */
function getSunFromTable(table, hour) {
  const i   = Math.round((hour - SOLAR_START) / SOLAR_STEP);
  const idx = Math.max(0, Math.min(SOLAR_SLOTS - 1, i));
  return { az: table[idx * 2], alt: table[idx * 2 + 1] };
}

/** Find sunrise or sunset by scanning the table for an altitude zero-crossing. */
function findSunCrossingFromTable(table, rising) {
  for (let i = 0; i < SOLAR_SLOTS - 1; i++) {
    const altA = table[i * 2 + 1],  hA = SOLAR_START + i * SOLAR_STEP;
    const altB = table[(i + 1) * 2 + 1];
    if (rising  && altA <= 0 && altB > 0) return hA + SOLAR_STEP * (-altA)  / (altB - altA);
    if (!rising && altA > 0  && altB <= 0) return hA + SOLAR_STEP *  (altA)  / (altA - altB);
  }
  return null;
}

// ── Window computation (table-based, used by both main thread and worker) ────

/**
 * Compute sun windows for a venue from a pre-built sun table.
 * venue: { facing, openingHours: { open, close } }
 * Returns { windows: [{start, end}], open, close }
 */
function computeSunWindowsFromTable(venue, table) {
  const { open, close } = venue.openingHours;
  const windows = [];
  let inSun = false, winStart = null;

  for (let h = open; h <= close + 0.001; h += SOLAR_STEP) {
    const { az, alt } = getSunFromTable(table, h);
    const sunny = venueSunState(venue, az, alt);
    if (sunny && !inSun)      { inSun = true;  winStart = h; }
    else if (!sunny && inSun) { inSun = false;  windows.push({ start: winStart, end: h }); }
  }
  if (inSun) windows.push({ start: winStart, end: close });
  return { windows, open, close };
}
