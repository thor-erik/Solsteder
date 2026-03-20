/**
 * app.js — Application state, orchestration, map setup, worker glue.
 * Loaded after solar.js and data.js. render.js, ui.js, osm.js load after this.
 * Init (updateRangeFill / update / initFacings) is called from inline script at
 * bottom of index.html after all files are loaded.
 */

// ── Mutable state ─────────────────────────────────────────────────────────────
let currentSun        = null;   // {az, alt} for the FROM time
let currentSunTable   = null;   // Float64Array built once per date
let currentDateStr    = null;   // tracks which date the table belongs to
let selectedId        = null;
let editingVenueId    = null;
let editHoveredWallIdx = null;
let popup             = null;
let nowMode           = false;
let nowInterval       = null;
let userLocation      = null;
let filterFullSunActive = false;
let filterMapViewActive = false;
let panelVisible      = true;
let hoveredId         = null;
let mapLoaded         = false;

// ── Sun window cache ──────────────────────────────────────────────────────────
// Keyed by `${venueId}-${dateStr}`. Populated by the worker (background) and
// by computeSunWindows() on cache miss (sync fallback on the main thread).
const sunWindowCache = new Map();

/**
 * Get sun windows for a venue, using cache if available.
 * Falls back to sync computation on cache miss (worker will overwrite later).
 */
function computeSunWindows(venue, dateStr) {
  const key = `${venue.id}-${dateStr}`;
  if (sunWindowCache.has(key)) return sunWindowCache.get(key);
  if (!currentSunTable) currentSunTable = buildSunTable(dateStr);
  const result = computeSunWindowsFromTable(venue, currentSunTable);
  sunWindowCache.set(key, result);
  return result;
}

// ── Web Worker ────────────────────────────────────────────────────────────────
// Workers require a server origin (http://). On file:// the constructor throws a
// SecurityError, so we wrap it and fall back to sync computation gracefully.
let sunWorker = null;
try {
  sunWorker = new Worker('js/worker.js');
  sunWorker.onmessage = function(e) {
    const { type, dateStr, result } = e.data;
    if (type !== 'result') return;
    // Discard stale results if the user changed the date while the worker was running
    if (dateStr !== datePicker.value) return;
    for (const [idStr, windows] of Object.entries(result)) {
      sunWindowCache.set(`${idStr}-${dateStr}`, windows);
    }
    // Re-render with worker-computed data (usually identical to sync fallback)
    draw();
    renderList();
  };
} catch (e) {
  console.warn('Web Worker unavailable (run via http:// for background computation):', e.message);
}

function dispatchToWorker(dateStr) {
  if (!sunWorker || !currentSunTable) return;
  const venues = VENUES.map(v => ({
    id:             v.id,
    facing:         v.facing,
    openingHours:   v.openingHours,
    lat:            v.lat,
    lng:            v.lng,
    nearbyBuildings: v.nearbyBuildings ?? null,
    wallSegment:     v.wallSegment     ?? null,
  }));
  // Slice the buffer so we transfer a copy, keeping currentSunTable intact on main thread
  const transferBuf = currentSunTable.buffer.slice(0);
  sunWorker.postMessage({ type: 'compute', venues, sunTableBuffer: transferBuf, dateStr }, [transferBuf]);
}

// ── Map ───────────────────────────────────────────────────────────────────────
mapboxgl.accessToken = MAPBOX_TOKEN; // defined in js/config.js (gitignored)
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  center: [10.728, 59.9125],
  zoom: 13,
  pitch: 15,
  antialias: true
});

map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

map.on('style.load', () => {
  mapLoaded = true;
  map.setConfigProperty('basemap', 'showPointOfInterestLabels', false);
  map.setConfigProperty('basemap', 'showTransitLabels', false);

  // Boost ambient occlusion on building extrusions so they read clearly from the ground
  map.getStyle().layers.forEach(layer => {
    if (layer.type === 'fill-extrusion') {
      map.setPaintProperty(layer.id, 'fill-extrusion-ambient-occlusion-intensity', 0.8);
      map.setPaintProperty(layer.id, 'fill-extrusion-ambient-occlusion-radius', 6);
      map.setPaintProperty(layer.id, 'fill-extrusion-opacity', 1.0);
    }
  });

  map.setFog({
    range: [1, 10],
    color: 'rgba(160, 180, 210, 0.25)',
    'horizon-blend': 0.04,
    'high-color': '#1a3a6e',
    'space-color': '#0a0a1e',
    'star-intensity': 0.2
  });
  updateLightPreset();
  updateSunLighting();
});

// ── Light preset (atmosphere + sky) ──────────────────────────────────────────
let _currentPreset = null;
function updateLightPreset() {
  if (!mapLoaded || !currentSun || !currentSunTable) return;
  const hour    = parseFloat(timeFromEl.value);
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);
  let preset;
  if (currentSun.alt < 0) {
    preset = 'night';
  } else if (sunrise && hour < sunrise + 1.5) {
    preset = 'dawn';
  } else if (sunset && hour > sunset - 1.5) {
    preset = 'dusk';
  } else {
    preset = 'day';
  }
  if (preset === _currentPreset) return; // only fire on actual change so Mapbox transition plays fully
  _currentPreset = preset;
  map.setConfigProperty('basemap', 'lightPreset', preset);
}

// ── Sun lighting (Mapbox GL v3) ───────────────────────────────────────────────
function updateSunLighting() {
  if (!mapLoaded || !currentSun) return;
  const { az, alt } = currentSun;
  if (alt > 0) {
    map.setLights([
      {
        id: 'sun',
        type: 'directional',
        properties: {
          direction: [az, 90 - alt],
          'direction-transition': { duration: 600, delay: 0 },
          'cast-shadows': true,
          intensity: 0.9,
          'intensity-transition': { duration: 400, delay: 0 },
          color: alt < 10 ? '#ff9944' : alt < 25 ? '#ffdd88' : '#ffffff',
          'color-transition': { duration: 600, delay: 0 }
        }
      },
      {
        id: 'ambient',
        type: 'ambient',
        properties: { intensity: 0.08, color: '#ffffff' }
      }
    ]);
  } else {
    map.setLights([
      {
        id: 'ambient',
        type: 'ambient',
        properties: { intensity: 0.4, color: '#8899cc' }
      }
    ]);
  }
}

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas-overlay');
const ctx    = canvas.getContext('2d');

// ── DOM refs (all defined after DOMContentLoaded since scripts are at end of body) ──
const datePicker      = document.getElementById('date-picker');
const timeFromEl      = document.getElementById('time-from');
const timeDisplayFrom = document.getElementById('time-display-from');
const nowBtn          = document.getElementById('now-btn');
const timeRangeWrap   = document.getElementById('time-range-wrap');
const tooltip         = document.getElementById('hover-tooltip');

// ── Utility formatters ────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
function currentHour() { const n = new Date(); return n.getHours() + n.getMinutes() / 60; }

function formatHour(h) {
  if (h == null) return '—';
  const hr = Math.floor(h), min = Math.round((h - hr) * 60);
  return `${String(hr).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function formatSliderTime(val) {
  const h = Math.floor(val), m = Math.round((val - h) * 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ── Slider ────────────────────────────────────────────────────────────────────
function updateRangeFill() {
  const min = 4, max = 23;
  const fv  = parseFloat(timeFromEl.value);
  const fp  = (fv - min) / (max - min) * 100;
  timeDisplayFrom.textContent = formatSliderTime(fv);
  timeDisplayFrom.style.left  = `calc(${fp.toFixed(2)}% - ${(fp / 100 * 14 - 7).toFixed(2)}px)`;
}

function toggleNowMode() {
  if (nowMode) {
    nowMode = false;
    clearInterval(nowInterval); nowInterval = null;
    nowBtn.classList.remove('active');
    timeRangeWrap.classList.remove('now-active');
  } else {
    nowMode = true;
    nowBtn.classList.add('active');
    timeRangeWrap.classList.add('now-active');
    applyNowTime();
    nowInterval = setInterval(() => { if (nowMode) { applyNowTime(); update(); } }, 30000);
  }
  update();
}

function applyNowTime() {
  timeFromEl.value = Math.min(23, Math.max(4, currentHour()));
  updateRangeFill();
}

// ── Debounced list render (avoids jitter when dragging time slider) ────────────
let _renderListTimer = null;
function scheduleRenderList() {
  clearTimeout(_renderListTimer);
  _renderListTimer = setTimeout(renderList, 120);
}

// ── Main update cycle ─────────────────────────────────────────────────────────
function update() {
  const fromHour = parseFloat(timeFromEl.value);
  const dateStr  = datePicker.value;
  updateRangeFill();

  // Rebuild sun table once per date change, then reuse for all lookups
  if (!currentSunTable || currentDateStr !== dateStr) {
    currentSunTable  = buildSunTable(dateStr);
    currentDateStr   = dateStr;
    sunWindowCache.clear();
    dispatchToWorker(dateStr);
  }

  currentSun = getSunFromTable(currentSunTable, fromHour);
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);

  // Status bar
  document.getElementById('stat-azimuth').textContent  = currentSun.alt < 0 ? '—' : `${Math.round(currentSun.az)}°`;
  document.getElementById('stat-altitude').textContent = currentSun.alt < 0 ? 'Below horizon' : `${Math.round(currentSun.alt)}°`;
  document.getElementById('stat-sunrise').textContent  = formatHour(sunrise);
  document.getElementById('stat-sunset').textContent   = formatHour(sunset);

  // Sunrise–sunset highlight on slider track
  const sunBg = document.getElementById('time-range-sun-bg');
  if (sunBg && sunrise != null && sunset != null) {
    const slMin = 4, slMax = 23;
    const sp = Math.max(0, (sunrise - slMin) / (slMax - slMin) * 100);
    const ep = Math.min(100, (sunset  - slMin) / (slMax - slMin) * 100);
    sunBg.style.left    = sp.toFixed(2) + '%';
    sunBg.style.width   = Math.max(0, ep - sp).toFixed(2) + '%';
    sunBg.style.display = 'block';
  } else if (sunBg) { sunBg.style.display = 'none'; }

  draw();
  drawSunCompass();
  scheduleRenderList();
  updatePopup();
  updateLightPreset();
  updateSunLighting();

  if (hoveredId != null && tooltip.classList.contains('visible')) {
    const hv = VENUES.find(x => x.id === hoveredId);
    if (hv) tooltip.innerHTML = buildTooltipContent(hv);
  }
}

// ── Venue selection + popup ───────────────────────────────────────────────────
let _switchingVenue = false;

function selectVenue(id, flyTo) {
  selectedId = id;
  clearSpriteCache();
  const v = VENUES.find(x => x.id === id);
  if (!v) return;

  // Only rotate to face the wall if we're more than 90° off — otherwise leave bearing alone
  if (flyTo) {
    const targetBearing = (v.facing + 180) % 360;
    const curBearing    = ((map.getBearing() % 360) + 360) % 360;
    let   diff          = Math.abs(targetBearing - curBearing);
    if (diff > 180) diff = 360 - diff;
    const flyOpts = { center: [v.lng, v.lat], zoom: Math.max(map.getZoom(), 15), pitch: 45, duration: 800 };
    if (diff > 90) flyOpts.bearing = targetBearing;
    map.flyTo(flyOpts);
  }

  _switchingVenue = true;
  if (popup) { popup.remove(); popup = null; }
  _switchingVenue = false;

  const sunny = currentSun ? venueSunState(v, currentSun.az, currentSun.alt) : false;
  // closeOnClick:false so the canvas always receives clicks (popup z-index 800 > canvas 690)
  popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: false, offset: [0, -10] })
    .setLngLat([v.lng, v.lat])
    .setHTML(`
      <div class="popup-name">${catIcon(v)} ${v.name}</div>
      <div class="popup-meta">★ ${v.rating} · ${catLabel(v)}</div>
      <div class="popup-address">${v.address}</div>
      <div class="popup-status ${sunny ? 'sunny' : 'shaded'}">${sunny ? '☀ Currently in sun' : '● In shade right now'}</div>
      <button class="popup-edit-btn" onclick="if(popup)popup.remove();enterEditMode(${v.id})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit direction
      </button>
    `)
    .addTo(map);
  popup.on('close', () => {
    popup = null;
    if (!_switchingVenue) {
      selectedId = null;
      clearSpriteCache();
      draw();
      renderList();
      map.easeTo({ pitch: 15, bearing: 0, duration: 600 });
    }
  });

  draw();
  renderList();

  setTimeout(() => {
    const card = document.querySelector(`.venue-card[data-vid="${id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

function updatePopup() {
  if (!popup || selectedId == null) return;
  const v = VENUES.find(x => x.id === selectedId);
  if (!v) return;
  const sunny = currentSun ? venueSunState(v, currentSun.az, currentSun.alt) : false;
  popup.setHTML(`
    <div class="popup-name">${catIcon(v)} ${v.name}</div>
    <div class="popup-meta">★ ${v.rating} · ${catLabel(v)}</div>
    <div class="popup-address">${v.address}</div>
    <div class="popup-status ${sunny ? 'sunny' : 'shaded'}">${sunny ? '☀ Currently in sun' : '● In shade right now'}</div>
    <button class="popup-edit-btn" onclick="if(popup)popup.remove();enterEditMode(${v.id})">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Edit direction
    </button>
  `);
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function enterEditMode(venueId) {
  editingVenueId = venueId;
  editHoveredWallIdx = null;
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;

  document.getElementById('edit-overlay').style.display = 'block';
  document.getElementById('edit-venue-label').textContent = `${catIcon(v)} ${v.name}`;
  document.getElementById('edit-facing-display').innerHTML = `${v.facing}° ${bearingToCardinal(v.facing)}`;

  if (popup) { popup.remove(); popup = null; }
  tooltip.classList.remove('visible');

  if (v.buildingGeometry) {
    const lats = v.buildingGeometry.map(n => n.lat);
    const lons = v.buildingGeometry.map(n => n.lon);
    map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 110, maxZoom: 19, pitch: 0, duration: 900 }
    );
  } else {
    map.flyTo({ center: [v.lng, v.lat], zoom: 19, pitch: 0, duration: 900 });
  }
  draw();
}

function exitEditMode() {
  editingVenueId = null;
  editHoveredWallIdx = null;
  document.getElementById('edit-overlay').style.display = 'none';
  map.easeTo({ pitch: 15, bearing: 0, duration: 500 });
  draw();
  renderList();
}

function selectWallByIdx(idx) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v?.wallNormals) return;
  const wall = v.wallNormals[idx];
  v.facing = Math.round(wall.bearing);
  v.wallSegment = wall;
  v.facingSource = 'manual';
  saveFacingCache(v.id, v.facing, 'manual');
  clearSpriteCache();
  sunWindowCache.clear();
  document.getElementById('edit-facing-display').innerHTML = `${v.facing}° ${bearingToCardinal(v.facing)}`;
  dispatchToWorker(datePicker.value);
  draw();
  renderList();
}

// ── Sidebar + filters ─────────────────────────────────────────────────────────
function togglePanel() {
  panelVisible = !panelVisible;
  const panel = document.getElementById('panel');
  const btn   = document.getElementById('panel-toggle');
  panel.style.width          = panelVisible ? '360px' : '0';
  panel.style.borderLeftWidth = panelVisible ? '' : '0';
  btn.textContent = panelVisible ? '›' : '‹';
  setTimeout(() => { map.resize(); resizeCanvas(); draw(); }, 290);
}

function toggleFullSun() {
  filterFullSunActive = !filterFullSunActive;
  document.getElementById('full-sun-btn').classList.toggle('active', filterFullSunActive);
  renderList();
}

function toggleMapView() {
  filterMapViewActive = !filterMapViewActive;
  document.getElementById('map-view-btn').classList.toggle('active', filterMapViewActive);
  renderList();
}

// Re-render list on map move when viewport filter is active
map.on('moveend', () => { if (filterMapViewActive) renderList(); });

// ── Control event listeners ───────────────────────────────────────────────────
datePicker.value = todayStr();
timeFromEl.value = Math.min(23, Math.max(4, currentHour()));

datePicker.addEventListener('change', () => { update(); });

timeFromEl.addEventListener('input', () => {
  if (nowMode) { nowMode = false; nowBtn.classList.remove('active'); timeRangeWrap.classList.remove('now-active'); }
  updateRangeFill(); update();
});

document.getElementById('venue-search').addEventListener('input',  () => renderList());
document.getElementById('filter-type').addEventListener('change',  () => renderList());
document.getElementById('filter-area').addEventListener('change',  () => renderList());
document.getElementById('filter-rating').addEventListener('change', () => renderList());

document.getElementById('sort-by').addEventListener('change', () => {
  if (document.getElementById('sort-by').value === 'distance' && !userLocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; renderList(); },
      ()  => { document.getElementById('sort-by').value = 'sun'; renderList(); }
    );
    return;
  }
  renderList();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && editingVenueId) exitEditMode();
});
