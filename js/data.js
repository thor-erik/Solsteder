/**
 * data.js — Venue and category data.
 * Loads from data/venues.json (requires http server).
 * Falls back to FALLBACK_VENUES on file:// or network error.
 */

const CATEGORIES = {
  restaurant:   'cat_restaurant',
  pub:          'cat_pub',
  cocktail_bar: 'cat_cocktail_bar',
  wine_bar:     'cat_wine_bar',
  bistro_bar:   'cat_bistro_bar',
  brasserie:    'cat_brasserie',
  cafe:         'cat_cafe',
  rooftop_bar:  'cat_rooftop_bar',
  courtyard:    'cat_courtyard',
  beer_garden:  'cat_beer_garden',
  fine_dining:  'cat_fine_dining',
};

function catLabel(v) { return t(CATEGORIES[v.category] ?? CATEGORIES.restaurant); }

// ── Runtime venue array (populated by loadVenues) ─────────────────────────────
// Mutated by initFacings() — adds: buildingGeometry, wallNormals, wallSegment.
let VENUES = [];

// ── Venue cluster: data-driven "city center" reference ────────────────────────
// Populated by loadVenues(). { center: {lat, lng}, radiusKm } — derived from
// the venue data so the subsystem stays city-agnostic. When data eventually
// covers multiple cities, swap this for a per-cluster lookup.
let VENUE_CLUSTER = { center: { lat: 0, lng: 0 }, radiusKm: 0 };

function computeVenueCluster(venues) {
  if (!venues.length) return { center: { lat: 0, lng: 0 }, radiusKm: 0 };
  const n = venues.length;
  const cLat = venues.reduce((s, v) => s + v.lat, 0) / n;
  const cLng = venues.reduce((s, v) => s + v.lng, 0) / n;
  const cosLat = Math.cos(cLat * Math.PI / 180);
  const maxKm = venues.reduce((m, v) => {
    const dLat = (v.lat - cLat) * 111;
    const dLng = (v.lng - cLng) * 111 * cosLat;
    return Math.max(m, Math.hypot(dLat, dLng));
  }, 0);
  return { center: { lat: cLat, lng: cLng }, radiusKm: maxKm + 30 };
}

// ── Facing cache ──────────────────────────────────────────────────────────────
// Persists computed ('osm') and manual ('manual') facing directions across refreshes.
// This means initFacings() only runs scoreWall once per venue, not every load.
const FACING_CACHE_KEY = 'solsteder_facings_v4';

function loadFacingCache() {
  try { return JSON.parse(localStorage.getItem(FACING_CACHE_KEY) || '{}'); }
  catch (_) { return {}; }
}

function saveFacingCache(venueId, facing, facingSource, terraceWallIndices, terraceDepth, noiseScore, terraceType, terraceDetachedLocation, terraceWallTrimStart, terraceWallTrimEnd, seatingPolygonOverride) {
  const cache = loadFacingCache();
  const prev  = cache[venueId] || {};
  cache[venueId] = {
    facing,
    facingSource,
    // Preserve existing terrace data when callers don't pass it (e.g. auto-OSM scoring)
    terraceWallIndices:      terraceWallIndices      ?? prev.terraceWallIndices      ?? [],
    terraceDepth:            terraceDepth            ?? prev.terraceDepth            ?? null,
    noiseScore:              noiseScore              ?? prev.noiseScore              ?? null,
    terraceType:             terraceType             ?? prev.terraceType             ?? null,
    terraceDetachedLocation: terraceDetachedLocation ?? prev.terraceDetachedLocation ?? null,
    terraceWallTrimStart:    terraceWallTrimStart    ?? prev.terraceWallTrimStart    ?? null,
    terraceWallTrimEnd:      terraceWallTrimEnd      ?? prev.terraceWallTrimEnd      ?? null,
    // Manual seating polygon edit (vertex-drag in render-editor.js).
    // null means "use AI / heuristic"; an explicit array overrides both.
    seatingPolygonOverride:  seatingPolygonOverride  !== undefined ? seatingPolygonOverride : (prev.seatingPolygonOverride ?? null),
  };
  try { localStorage.setItem(FACING_CACHE_KEY, JSON.stringify(cache)); }
  catch (_) {}
}

// ── Corrections log ───────────────────────────────────────────────────────────
// Records every manual edit (correction) or confirmation that the model was right.
// Exported via exportCorrections() for analysis by scripts/analyze-corrections.mjs.
const CORRECTIONS_KEY = 'solsteder_corrections_v1';

function loadCorrections() {
  try { return JSON.parse(localStorage.getItem(CORRECTIONS_KEY) || '[]'); }
  catch (_) { return []; }
}

/**
 * Save one feedback record.
 * @param {'correction'|'confirmed'} type
 * @param {object} venueSnapshot  - { id, name, category, before, after, autoState }
 */
function saveCorrection(type, venueSnapshot) {
  const corrections = loadCorrections();
  corrections.push({ type, timestamp: new Date().toISOString(), ...venueSnapshot });
  try { localStorage.setItem(CORRECTIONS_KEY, JSON.stringify(corrections)); }
  catch (_) {}
}

/**
 * Download all stored corrections as a JSON file.
 * The file can be passed to scripts/analyze-corrections.mjs for pattern analysis.
 */
function exportCorrections() {
  const data = loadCorrections();
  if (!data.length) { alert('No corrections recorded yet.'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `solsteder-corrections-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
}

// ── JSON → runtime format ─────────────────────────────────────────────────────
function normalizeVenue(v) {
  return {
    id:            v.id,
    name:          v.name,
    address:       v.address,
    lat:           v.coords[0],
    lng:           v.coords[1],
    category:      v.category,
    area:          v.area,
    rating:        v.rating,
    facing:             v.facing ?? 180,
    facingSource:       v.facingSource ?? null,
    openingHours:       v.openingHours,
    buildingOsmId:      v.buildingOsmId ?? null,
    googlePlaceId:      v.googlePlaceId ?? null,
    terraceDepth:       v.terraceDepth ?? null,  // null = not manually set; auto-depth used instead
    terraceWallIndices:     v.terraceWallIndices ?? [],
    terraceType:            v.terraceType ?? 'street',
    terraceDetachedLocation: v.terraceDetachedLocation ?? null,
    beerPrice:              v.beerPrice ?? null,
    // Set later by loadSeatingCache(): AI-detected outdoor-seating polygon
    // (lat/lng vertex array) and its confidence. Drives render-seating.js
    // and the shadow test-point grid in osm.js.
    seatingPolygonAi:           null,
    seatingPolygonAiConfidence: null,
    seatingNotVisible:          false,
    seatingPolygonOverride:     null,  // manual edit (vertex drag), beats AI
  };
}

// ── AI seating polygon cache (data/seating-detected.json) ─────────────────────
// Loaded once at boot, then kept in memory. The override layer lives in the
// existing solsteder_facings_v4 localStorage cache so manual edits made in the
// editor persist across reloads without round-tripping a server.
const SEATING_CONFIDENCE_GATE = 0.5;

async function loadSeatingCache() {
  try {
    const resp = await fetch('data/seating-detected.json');
    if (!resp.ok) return;
    const data = await resp.json();
    const records = data.venues ?? {};
    let applied = 0;
    VENUES.forEach(v => {
      const r = records[String(v.id)] ?? records[v.id];
      if (!r) return;
      v.seatingPolygonAi           = Array.isArray(r.polygon) && r.polygon.length >= 3 ? r.polygon : null;
      v.seatingPolygonAiConfidence = typeof r.confidence === 'number' ? r.confidence : null;
      v.seatingNotVisible          = !!r.notVisible;
      applied++;
    });
    console.log(`Seating: loaded ${applied}/${VENUES.length} polygon record(s) from data/seating-detected.json`);
  } catch (e) {
    console.warn('seating-detected.json unavailable:', e.message);
  }
}

/**
 * Resolution order for a venue's outdoor-seating polygon:
 *   1. Manual vertex-drag override (localStorage / committed manual record)
 *   2. AI detection — ONLY when the caller opts in via { includeAi: true },
 *      and only when confidence ≥ gate and not flagged notVisible.
 *   3. null → callers fall back to wall-projection heuristic.
 *
 * AI is opt-in because we are still calibrating: regular users on the public
 * map should see manual polygons and the wall heuristic, but never the
 * AI polygon. The editor passes { includeAi: true } so admins can review
 * the AI proposal as a ghost overlay.
 *
 * Returns an array of [lat, lng] vertices, or null.
 */
function getSeatingPolygon(v, opts = {}) {
  if (Array.isArray(v.seatingPolygonOverride) && v.seatingPolygonOverride.length >= 3) {
    return v.seatingPolygonOverride;
  }
  if (!opts.includeAi) return null;
  if (v.seatingNotVisible) return null;
  if (Array.isArray(v.seatingPolygonAi)
      && v.seatingPolygonAi.length >= 3
      && (v.seatingPolygonAiConfidence ?? 0) >= SEATING_CONFIDENCE_GATE) {
    return v.seatingPolygonAi;
  }
  return null;
}

// id → venue lookup. Replaces ~30 VENUES.find(v => v.id === id) calls in
// the per-frame draw path. Rebuilt whenever VENUES is reassigned (loader,
// admin tools, suggestion approval). Read via venueById(id).
let _venuesById = new Map();
function _rebuildVenuesById() {
  _venuesById = new Map();
  for (const v of VENUES) _venuesById.set(v.id, v);
}
function venueById(id) {
  // Tolerate both numeric and string ids — render-pins.js / ui-detail.js
  // sometimes coerce ids when crossing user-input boundaries.
  if (_venuesById.has(id)) return _venuesById.get(id);
  const s = String(id);
  if (_venuesById.has(s)) return _venuesById.get(s);
  for (const v of VENUES) if (String(v.id) === s) return v;
  return undefined;
}
if (typeof window !== 'undefined') {
  window.venueById = venueById;
  // Call after any external mutation of VENUES (push/splice/replace).
  // Cheap (one Map allocation + iteration) — fine to invoke conservatively.
  window.rebuildVenuesById = _rebuildVenuesById;
}

// ── Loader ────────────────────────────────────────────────────────────────────
async function loadVenues() {
  try {
    const resp = await fetch('data/venues.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    // Drop permanently-closed venues at load time. They stay in venues.json
    // for history and to avoid re-discovering them every monthly run, but
    // are hidden from users.
    const live = raw.filter(v => v.businessStatus !== 'CLOSED_PERMANENTLY');
    VENUES = live.map(normalizeVenue);
    _rebuildVenuesById();
    const skipped = raw.length - live.length;
    console.log(`Loaded ${VENUES.length} venues from data/venues.json${skipped ? ` (${skipped} closed permanently, hidden)` : ''}`);
  } catch (e) {
    console.warn('venues.json unavailable, using built-in data:', e.message);
    VENUES = FALLBACK_VENUES.map(normalizeVenue);
    _rebuildVenuesById();
  }

  // Apply persisted facing overrides (OSM-computed or manually set via edit tool).
  // localStorage takes precedence over the JSON defaults, but never overwrites 'manual'
  // entries that are already baked into venues.json.
  const facingCache = loadFacingCache();
  VENUES.forEach(v => {
    const cached = facingCache[v.id];
    if (!cached) return;
    // Terrace geometry + noise always restored from cache regardless of facingSource
    if (cached.terraceWallIndices?.length) v.terraceWallIndices = cached.terraceWallIndices;
    if (cached.terraceDepth != null)       v.terraceDepth       = cached.terraceDepth;
    if (cached.noiseScore   != null)       v.noiseScore         = cached.noiseScore;
    if (cached.terraceType             != null) v.terraceType             = cached.terraceType;
    if (cached.terraceDetachedLocation != null) v.terraceDetachedLocation = cached.terraceDetachedLocation;
    if (cached.terraceWallTrimStart    != null) v.terraceWallTrimStart    = cached.terraceWallTrimStart;
    if (cached.terraceWallTrimEnd      != null) v.terraceWallTrimEnd      = cached.terraceWallTrimEnd;
    if (Array.isArray(cached.seatingPolygonOverride) && cached.seatingPolygonOverride.length >= 3) {
      v.seatingPolygonOverride = cached.seatingPolygonOverride;
    }
    // JSON-level 'manual' beats any localStorage entry (it was intentionally authored)
    if (v.facingSource === 'manual') return;
    v.facing = cached.facing;
    v.facingSource = cached.facingSource;
  });

  // AI-detected seating polygons — fetched in parallel with venues.json
  // would only save a few ms because we already render the map first; loading
  // here is simple and keeps initialisation linear.
  await loadSeatingCache();

  // Apply the admin's local audit-archive list so archived venues are hidden
  // from the rest of the app before the first render. Inside audit mode they
  // remain visible as red dots; everywhere else they're skipped.
  if (typeof applyAuditArchiveTags === 'function') applyAuditArchiveTags();

  VENUE_CLUSTER = computeVenueCluster(VENUES);
}

// ── Fallback (mirrors venues.json — update both when adding venues) ────────────
const FALLBACK_VENUES = [
  { id:1,  name:'Pastis Bistrobar',       address:'Stranden 3, 0250 Oslo',            coords:[59.910171,10.727808], category:'bistro_bar',   area:'Aker Brygge',    rating:4.3, facing:180, openingHours:{ open:11, close:23 }, buildingOsmId:null, googlePlaceId:null },
  { id:2,  name:'Rorbua Aker Brygge',     address:'Stranden 71, 0250 Oslo',           coords:[59.908798,10.724357], category:'restaurant',   area:'Aker Brygge',    rating:4.2, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:3,  name:'Yokoso Restaurant',      address:'Stranden 63, 0250 Oslo',           coords:[59.909448,10.726599], category:'restaurant',   area:'Aker Brygge',    rating:4.4, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:4,  name:'Jarmann Gastropub',      address:'Stranden 1, 0250 Oslo',            coords:[59.910504,10.728505], category:'pub',          area:'Aker Brygge',    rating:4.1, facing:180, openingHours:{ open:11, close:23 }, buildingOsmId:null, googlePlaceId:null },
  { id:5,  name:'Underbar',               address:'Holmens gate 3, 0250 Oslo',        coords:[59.910709,10.726566], category:'cocktail_bar', area:'Aker Brygge',    rating:4.2, facing:180, openingHours:{ open:14, close:23 }, buildingOsmId:null, googlePlaceId:null },
  { id:6,  name:'Brasserie France',       address:'Øvre Slottsgate 16, 0157 Oslo',    coords:[59.913084,10.742608], category:'brasserie',    area:'Sentrum',        rating:4.5, facing:180, openingHours:{ open:11, close:23 }, buildingOsmId:null, googlePlaceId:null },
  { id:7,  name:'Den Glade Gris',         address:'St. Olavs gate 33, 0166 Oslo',     coords:[59.917876,10.734076], category:'restaurant',   area:'St. Hanshaugen', rating:4.2, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:8,  name:'Nodee Sky',              address:'Dronning Mauds gate 1, 0250 Oslo', coords:[59.912530,10.729961], category:'rooftop_bar',  area:'Aker Brygge',    rating:4.3, facing:180, openingHours:{ open:16, close:23 }, buildingOsmId:null, googlePlaceId:null },
  { id:9,  name:'Hanami',                 address:'Kanalen 3, 0252 Oslo',             coords:[59.908172,10.721338], category:'restaurant',   area:'Aker Brygge',    rating:4.4, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:10, name:'Villa Paradiso Frogner', address:'Olav Kyrres gate 31, 0266 Oslo',   coords:[59.918644,10.694469], category:'restaurant',   area:'Frogner',        rating:4.5, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:11, name:'Feinschmecker',          address:'Ullevålsveien 14, 0171 Oslo',      coords:[59.923146,10.740944], category:'fine_dining',  area:'Bislett',        rating:4.6, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:12, name:'Palace Grill',           address:'Solligata 2, 0254 Oslo',           coords:[59.914372,10.720479], category:'restaurant',   area:'Frogner',        rating:4.4, facing:180, openingHours:{ open:17, close:23 }, buildingOsmId:null, googlePlaceId:null },
];
