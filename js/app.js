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
const map = L.map('map', { center: [59.9125, 10.728], zoom: 13, zoomControl: false });

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas-overlay');
const ctx    = canvas.getContext('2d');

// ── DOM refs (all defined after DOMContentLoaded since scripts are at end of body) ──
const datePicker      = document.getElementById('date-picker');
const timeFromEl      = document.getElementById('time-from');
const timeToEl        = document.getElementById('time-to');
const timeRangeFillEl = document.getElementById('time-range-fill');
const timeDisplayFrom = document.getElementById('time-display-from');
const timeDisplayTo   = document.getElementById('time-display-to');
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
  const fv  = parseFloat(timeFromEl.value), tv = parseFloat(timeToEl.value);
  const fp  = (fv - min) / (max - min) * 100;
  const tp  = (tv - min) / (max - min) * 100;
  timeRangeFillEl.style.left  = fp.toFixed(2) + '%';
  timeRangeFillEl.style.width = Math.max(0, tp - fp).toFixed(2) + '%';
  timeDisplayFrom.textContent = formatSliderTime(fv);
  timeDisplayFrom.style.left  = `calc(${fp.toFixed(2)}% - ${(fp / 100 * 14 - 7).toFixed(2)}px)`;
  const isPoint = Math.abs(fv - tv) < 0.01;
  timeDisplayTo.textContent   = isPoint ? '' : formatSliderTime(tv);
  timeDisplayTo.style.left    = `calc(${tp.toFixed(2)}% - ${(tp / 100 * 14 - 7).toFixed(2)}px)`;
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
  const h = Math.min(23, Math.max(4, currentHour()));
  timeFromEl.value = h;
  if (parseFloat(timeToEl.value) < h) timeToEl.value = Math.min(23, h + 2);
  updateRangeFill();
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

  // Sun window highlight on dual slider
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
  renderList();
  updatePopup();

  if (hoveredId != null && tooltip.classList.contains('visible')) {
    const hv = VENUES.find(x => x.id === hoveredId);
    if (hv) tooltip.innerHTML = buildTooltipContent(hv);
  }
}

// ── Venue selection + popup ───────────────────────────────────────────────────
function selectVenue(id, flyTo) {
  selectedId = id;
  clearSpriteCache();
  const v = VENUES.find(x => x.id === id);
  if (!v) return;

  if (flyTo) map.flyTo([v.lat, v.lng], Math.max(map.getZoom(), 15), { duration: 0.8 });

  if (popup) map.closePopup(popup);
  const sunny = currentSun ? venueSunState(v, currentSun.az, currentSun.alt) : false;
  popup = L.popup({ closeButton: true, offset: [0, -10] })
    .setLatLng([v.lat, v.lng])
    .setContent(`
      <div class="popup-name">${catIcon(v)} ${v.name}</div>
      <div class="popup-meta">★ ${v.rating} · ${catLabel(v)}</div>
      <div class="popup-address">${v.address}</div>
      <div class="popup-status ${sunny ? 'sunny' : 'shaded'}">${sunny ? '☀ Currently in sun' : '● In shade right now'}</div>
      <button class="popup-edit-btn" onclick="map.closePopup();enterEditMode(${v.id})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit direction
      </button>
    `)
    .openOn(map);

  draw();
  renderList();

  setTimeout(() => {
    const card = document.querySelector(`.venue-card[data-vid="${id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

function updatePopup() {
  if (!popup || !popup.isOpen() || selectedId == null) return;
  const v = VENUES.find(x => x.id === selectedId);
  if (!v) return;
  const sunny = currentSun ? venueSunState(v, currentSun.az, currentSun.alt) : false;
  popup.setContent(`
    <div class="popup-name">${catIcon(v)} ${v.name}</div>
    <div class="popup-meta">★ ${v.rating} · ${catLabel(v)}</div>
    <div class="popup-address">${v.address}</div>
    <div class="popup-status ${sunny ? 'sunny' : 'shaded'}">${sunny ? '☀ Currently in sun' : '● In shade right now'}</div>
    <button class="popup-edit-btn" onclick="map.closePopup();enterEditMode(${v.id})">
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

  if (popup) { map.closePopup(popup); popup = null; }
  tooltip.classList.remove('visible');

  if (v.buildingGeometry) {
    const lats = v.buildingGeometry.map(n => n.lat);
    const lons = v.buildingGeometry.map(n => n.lon);
    map.flyToBounds(
      L.latLngBounds([Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]),
      { padding: [110, 110], maxZoom: 19, duration: 0.9 }
    );
  } else {
    map.flyTo([v.lat, v.lng], 19, { duration: 0.9 });
  }
  draw();
}

function exitEditMode() {
  editingVenueId = null;
  editHoveredWallIdx = null;
  document.getElementById('edit-overlay').style.display = 'none';
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
  setTimeout(() => { map.invalidateSize(); resizeCanvas(); draw(); }, 290);
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

// ── Popup pointer-event fix ───────────────────────────────────────────────────
// Canvas (z-index 690) blocks Leaflet popup close button; toggle around popup lifecycle.
map.on('popupopen',  () => { canvas.style.pointerEvents = 'none'; });
map.on('popupclose', () => { popup = null; canvas.style.pointerEvents = 'auto'; });

// Venue click via Leaflet map event (works when canvas pointer-events is none)
map.on('click', e => {
  if (editingVenueId) return;
  const cp = map.latLngToContainerPoint(e.latlng);
  let hit = null;
  VENUES.forEach(v => {
    const pt = map.latLngToContainerPoint([v.lat, v.lng]);
    if (Math.hypot(cp.x - pt.x, cp.y - pt.y) <= 20) hit = v;
  });
  if (hit) selectVenue(hit.id, true);
});

// ── Control event listeners ───────────────────────────────────────────────────
datePicker.value = todayStr();
const initHour = Math.min(23, Math.max(4, currentHour()));
timeFromEl.value = initHour;
timeToEl.value   = Math.min(23, initHour + 3);

datePicker.addEventListener('change', () => { update(); });

timeFromEl.addEventListener('input', () => {
  if (nowMode) { nowMode = false; nowBtn.classList.remove('active'); timeRangeWrap.classList.remove('now-active'); }
  if (parseFloat(timeFromEl.value) > parseFloat(timeToEl.value)) timeToEl.value = timeFromEl.value;
  updateRangeFill(); update();
});

timeToEl.addEventListener('input', () => {
  if (nowMode) { nowMode = false; nowBtn.classList.remove('active'); timeRangeWrap.classList.remove('now-active'); }
  if (parseFloat(timeToEl.value) < parseFloat(timeFromEl.value)) timeFromEl.value = timeToEl.value;
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
