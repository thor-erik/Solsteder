/**
 * data.js — Venue and category data.
 * Loads from data/venues.json (requires http server).
 * Falls back to FALLBACK_VENUES on file:// or network error.
 */

const CATEGORIES = {
  restaurant:   { label: 'Restaurant',   icon: '🍽' },
  pub:          { label: 'Pub',          icon: '🍺' },
  cocktail_bar: { label: 'Cocktail Bar', icon: '🍸' },
  wine_bar:     { label: 'Wine Bar',     icon: '🍷' },
  bistro_bar:   { label: 'Bistro Bar',   icon: '🥂' },
  brasserie:    { label: 'Brasserie',    icon: '🥐' },
  cafe:         { label: 'Café',         icon: '☕' },
  rooftop_bar:  { label: 'Rooftop Bar',  icon: '🌆' },
  courtyard:    { label: 'Courtyard',    icon: '🌿' },
  beer_garden:  { label: 'Beer Garden',  icon: '🌳' },
  fine_dining:  { label: 'Fine Dining',  icon: '★'  },
};

function catIcon(v)  { return (CATEGORIES[v.category] ?? CATEGORIES.restaurant).icon; }
function catLabel(v) { return (CATEGORIES[v.category] ?? CATEGORIES.restaurant).label; }

// ── Runtime venue array (populated by loadVenues) ─────────────────────────────
// Mutated by initFacings() — adds: buildingGeometry, wallNormals, wallSegment.
let VENUES = [];

// ── Facing cache ──────────────────────────────────────────────────────────────
// Persists computed ('osm') and manual ('manual') facing directions across refreshes.
// This means initFacings() only runs scoreWall once per venue, not every load.
const FACING_CACHE_KEY = 'solsteder_facings_v1';

function loadFacingCache() {
  try { return JSON.parse(localStorage.getItem(FACING_CACHE_KEY) || '{}'); }
  catch (_) { return {}; }
}

function saveFacingCache(venueId, facing, facingSource) {
  const cache = loadFacingCache();
  cache[venueId] = { facing, facingSource };
  try { localStorage.setItem(FACING_CACHE_KEY, JSON.stringify(cache)); }
  catch (_) {}
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
    facing:        v.facing ?? 180,
    facingSource:  v.facingSource ?? null,
    openingHours:  v.openingHours,
    buildingOsmId: v.buildingOsmId ?? null,
    googlePlaceId: v.googlePlaceId ?? null,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────
async function loadVenues() {
  try {
    const resp = await fetch('data/venues.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    VENUES = raw.map(normalizeVenue);
    console.log(`Loaded ${VENUES.length} venues from data/venues.json`);
  } catch (e) {
    console.warn('venues.json unavailable, using built-in data:', e.message);
    VENUES = FALLBACK_VENUES.map(normalizeVenue);
  }

  // Apply persisted facing overrides (OSM-computed or manually set via edit tool).
  // localStorage takes precedence over the JSON defaults, but never overwrites 'manual'
  // entries that are already baked into venues.json.
  const facingCache = loadFacingCache();
  VENUES.forEach(v => {
    const cached = facingCache[v.id];
    if (!cached) return;
    // JSON-level 'manual' beats any localStorage entry (it was intentionally authored)
    if (v.facingSource === 'manual') return;
    v.facing = cached.facing;
    v.facingSource = cached.facingSource;
  });
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
  { id:9,  name:'Hanami',                 address:'Kanalen 3, 0252 Oslo',             coords:[59.908172,10.721338], category:'restaurant',   area:'Tjuvholmen',     rating:4.4, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:10, name:'Villa Paradiso Frogner', address:'Olav Kyrres gate 31, 0266 Oslo',   coords:[59.918644,10.694469], category:'restaurant',   area:'Frogner',        rating:4.5, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:11, name:'Feinschmecker',          address:'Ullevålsveien 14, 0171 Oslo',      coords:[59.923146,10.740944], category:'fine_dining',  area:'Bislett',        rating:4.6, facing:180, openingHours:{ open:12, close:22 }, buildingOsmId:null, googlePlaceId:null },
  { id:12, name:'Palace Grill',           address:'Solligata 2, 0254 Oslo',           coords:[59.914372,10.720479], category:'restaurant',   area:'Frogner',        rating:4.4, facing:180, openingHours:{ open:17, close:23 }, buildingOsmId:null, googlePlaceId:null },
];
