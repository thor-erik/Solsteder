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
let activeArea    = '';
let activeSortBy  = 'score';
let activeIntent  = null;
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
    id:              v.id,
    facing:          v.facing,
    openingHours:    v.openingHours,
    lat:             v.lat,
    lng:             v.lng,
    nearbyBuildings:  v.nearbyBuildings   ?? null,
    wallSegment:      v.wallSegment       ?? null,
    terraceTestPoints: v.terraceTestPoints ?? null,
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

  const isStandard = !editSatelliteActive;
  if (isStandard) {
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
  }

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
          'cast-shadows': true,
          intensity: 0.9,
          color: alt < 10 ? '#ff9944' : alt < 25 ? '#ffdd88' : '#ffffff',
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

// ── Intent shortcuts ──────────────────────────────────────────────────────────
const _PRESET_HOURS = { lunch: 11, 'after-work': 16, evening: 20 };
const PAD_X_ARC = 38, MIN_H_ARC = 4, MAX_H_ARC = 23;

function _arcTimeToLeft(h, canvasW) {
  return PAD_X_ARC + (h - MIN_H_ARC) / (MAX_H_ARC - MIN_H_ARC) * (canvasW - PAD_X_ARC * 2);
}

function positionPresetButtons() {
  const arcEl = document.getElementById('sun-curve');
  const row   = document.getElementById('time-presets-row');
  if (!arcEl || !row) return;
  const w = arcEl.offsetWidth;
  if (w === 0) return;

  const isToday  = datePicker.value === todayStr();
  const sunriseH = currentSunTable ? (findSunCrossingFromTable(currentSunTable, true)  ?? 7)  : 7;
  const sunsetH  = currentSunTable ? (findSunCrossingFromTable(currentSunTable, false) ?? 21) : 21;
  const nowH     = isToday ? Math.max(MIN_H_ARC, Math.min(MAX_H_ARC, currentHour())) : sunriseH;

  const showEvening = sunsetH >= 20;

  const presets = [
    { intent: 'now',        hour: nowH },
    { intent: 'lunch',      hour: 11   },
    { intent: 'after-work', hour: 16   },
    { intent: 'evening',    hour: 20   },
  ];

  row.querySelectorAll('.intent-btn').forEach(btn => {
    const preset = presets.find(p => p.intent === btn.dataset.intent);
    if (!preset) return;
    if (btn.dataset.intent === 'evening') {
      btn.style.display = showEvening ? '' : 'none';
    }
    btn.style.left = _arcTimeToLeft(preset.hour, w) + 'px';
    if (btn.dataset.intent === 'now') btn.textContent = isToday ? 'Now' : 'Sunrise';
  });

  positionIntentPill();
}

function positionIntentPill() {
  const pill = document.getElementById('intent-pill');
  const row  = document.getElementById('time-presets-row');
  const active = row?.querySelector('.intent-btn.active');
  if (!pill || !active || !row) { if (pill) pill.style.opacity = '0'; return; }
  const rowRect = row.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  pill.style.opacity = '1';
  pill.style.left  = (btnRect.left - rowRect.left) + 'px';
  pill.style.width = btnRect.width + 'px';
}

function setActiveIntentBtn(intent) {
  activeIntent = intent;
  document.querySelectorAll('.intent-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.intent === intent));
  positionIntentPill();
}

function setIntent(intent) {
  setActiveIntentBtn(intent);
  _currentPreset = null;
  if (intent === 'now') {
    const isToday = datePicker.value === todayStr();
    if (isToday) {
      if (!nowMode) {
        nowMode = true;
        nowBtn?.classList.add('active');
        timeRangeWrap?.classList.add('now-active');
        applyNowTime();
        nowInterval = setInterval(() => { if (nowMode) { applyNowTime(); update(); } }, 30000);
      }
    } else {
      // Future date: jump to sunrise
      if (nowMode) { nowMode = false; clearInterval(nowInterval); nowInterval = null; }
      const sunriseH = currentSunTable ? (findSunCrossingFromTable(currentSunTable, true) ?? 7) : 7;
      timeFromEl.value = Math.max(MIN_H_ARC, Math.min(MAX_H_ARC, sunriseH));
    }
    update();
    return;
  }
  if (nowMode) {
    nowMode = false;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  timeFromEl.value = _PRESET_HOURS[intent];
  update();
}

// ── Weather display ───────────────────────────────────────────────────────────
function updateWeatherDisplay() {
  const el = document.getElementById('wx-now');
  if (!el) return;
  const wx = getWeatherAt(datePicker.value, parseFloat(timeFromEl.value));
  if (!wx) { el.classList.remove('loaded'); return; }

  const windLine = wx.wspd >= 1
    ? `<span>${Math.round(wx.wspd)} m/s ${windCardinal(wx.wdir)}</span>`
    : '';
  const rainLine = wx.precip >= 0.1
    ? `<span style="color:#7ab4ff">🌧 ${wx.precip.toFixed(1)} mm</span>`
    : '';

  el.innerHTML = `
    <span class="wx-temp">${wx.temp}°</span>
    <span>${skyIcon(wx.cloud)} ${Math.round(wx.cloud * 100)}%</span>
    ${windLine}
    ${rainLine}
  `;
  el.classList.add('loaded');
}

// ── Hover from sidebar list ───────────────────────────────────────────────────
function setHoveredVenue(id) {
  if (hoveredId === id) return;
  hoveredId = id;
  draw();
}

// ── Area filter ───────────────────────────────────────────────────────────────
function setAreaFilter(area) {
  activeArea = area;
  document.querySelectorAll('.area-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.area === area));
  renderList();
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function toggleSortPanel() {
  const panel = document.getElementById('sort-panel');
  const btn   = document.getElementById('sort-toggle-btn');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  btn?.classList.toggle('open', isOpen);
}

function setSortBy(sort) {
  if (sort === 'distance' && !userLocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        activeSortBy = 'distance';
        updateSortBtns();
        renderList();
      },
      () => {}
    );
    return;
  }
  activeSortBy = sort;
  updateSortBtns();
  // Close panel and update label
  document.getElementById('sort-panel')?.classList.remove('open');
  document.getElementById('sort-toggle-btn')?.classList.remove('open');
  renderList();
}

function updateSortBtns() {
  document.querySelectorAll('.sort-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === activeSortBy));
  const labels = { score: 'Score', rating: 'Rating', distance: 'Near' };
  const labelEl = document.getElementById('sort-label');
  if (labelEl) labelEl.textContent = labels[activeSortBy] ?? 'Score';
}

// ── Debounced list render (avoids jitter when dragging time slider) ────────────
let _renderListTimer = null;
function scheduleRenderList() {
  clearTimeout(_renderListTimer);
  _renderListTimer = setTimeout(renderList, 300);
}

// ── Day navigation ────────────────────────────────────────────────────────────
function advanceDay(delta, setHour) {
  const d = new Date(datePicker.value + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  datePicker.value = d.toISOString().slice(0, 10);
  if (setHour !== undefined) {
    if (nowMode) {
      nowMode = false;
      nowBtn.classList.remove('active');
      timeRangeWrap.classList.remove('now-active');
      clearInterval(nowInterval); nowInterval = null;
    }
    setActiveIntentBtn(null);
    timeFromEl.value = setHour;
  }
  update();
}

// ── Sun curve click → set time ────────────────────────────────────────────────
// ── Arc canvas time interaction ───────────────────────────────────────────────
let _arcDragging = false;

function _arcSetTimeFromX(clientX) {
  const canvasEl = document.getElementById('sun-curve');
  if (!canvasEl) return;
  const rect  = canvasEl.getBoundingClientRect();
  const PAD_X = 38, MIN_H = 4, MAX_H = 23;
  const t     = MIN_H + (clientX - rect.left - PAD_X) / (rect.width - PAD_X * 2) * (MAX_H - MIN_H);
  const hour  = Math.max(MIN_H, Math.min(MAX_H, t));
  if (nowMode) {
    nowMode = false;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  setActiveIntentBtn(null);
  timeFromEl.value = hour;
  update();
}

function handleSunCurveClick(e) { _arcSetTimeFromX(e.clientX); }

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

  // Status bar (elements may be absent if removed from HTML)
  document.getElementById('stat-azimuth')?.textContent != null && (document.getElementById('stat-azimuth').textContent  = currentSun.alt < 0 ? '—' : `${Math.round(currentSun.az)}°`);
  document.getElementById('stat-altitude')?.textContent != null && (document.getElementById('stat-altitude').textContent = currentSun.alt < 0 ? 'Below horizon' : `${Math.round(currentSun.alt)}°`);
  document.getElementById('stat-sunrise')?.textContent != null && (document.getElementById('stat-sunrise').textContent  = formatHour(sunrise));
  document.getElementById('stat-sunset')?.textContent != null && (document.getElementById('stat-sunset').textContent   = formatHour(sunset));

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

  // Arc time display
  const arcTimeEl = document.getElementById('arc-time-display');
  if (arcTimeEl) arcTimeEl.textContent = formatHour(fromHour);

  draw();
  drawSunCompass();
  drawSunCurve(document.getElementById('sun-curve'));
  positionPresetButtons();
  updateWeatherDisplay();
  scheduleRenderList();
  updatePopup();
  updateLightPreset();
  updateSunLighting();

  if (hoveredId != null && tooltip.classList.contains('visible')) {
    const hv = VENUES.find(x => x.id === hoveredId);
    if (hv) tooltip.innerHTML = buildTooltipContent(hv);
  }
}

// ── Popup helpers ─────────────────────────────────────────────────────────────

function popupSunLine(v) {
  const dateStr = datePicker.value;
  const hour    = parseFloat(timeFromEl.value);
  const { windows, open, close } = computeSunWindows(v, dateStr);
  const isOpen  = hour >= open && hour <= close;

  if (!isOpen) {
    const waitToOpen = open - hour;
    if (waitToOpen > 0 && waitToOpen <= 0.75) {
      return `<div class="popup-status opening-soon">Opens at ${formatHour(open)}</div>`;
    }
    return `<div class="popup-status shaded">Closed now</div>`;
  }

  const curWin = windows.find(w => hour >= w.start && hour < w.end);
  if (curWin) {
    const rem = curWin.end - hour;
    const h = Math.floor(rem), m = Math.round((rem - h) * 60);
    const dur = (h > 0 ? h + 'h ' : '') + (m > 0 ? m + 'm' : '');
    return `<div class="popup-status sunny">☀ In sun until ${formatHour(curWin.end)} · ${dur.trim()} left</div>`;
  }

  const next = windows.find(w => w.start > hour);
  if (next) {
    const wait = next.start - hour;
    const h = Math.floor(wait), m = Math.round((wait - h) * 60);
    const dur = (h > 0 ? h + 'h ' : '') + (m > 0 ? m + 'm' : '');
    return `<div class="popup-status shaded">● In shade · Sun at ${formatHour(next.start)} (${dur.trim()})</div>`;
  }

  return `<div class="popup-status shaded">${windows.length ? '● Sun passed for today' : '● No sun today'}</div>`;
}

function popupDirectionsUrl(v) {
  return `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`;
}

function shareVenue(venueId) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  const url = `${location.origin}${location.pathname}#v=${venueId}`;
  if (navigator.share) {
    navigator.share({ title: `${v.name} — ${v.area}`, url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url).then(() => {
      const btn = document.querySelector(`.venue-card[data-vid="${venueId}"] .card-action-btn:last-child`);
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = '⎘ Share', 1500); }
    });
  }
}

const EDIT_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const DIR_ICON  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;

function popupActionsHTML(v) {
  return `
    <div class="popup-actions">
      <a class="popup-directions-btn" href="${popupDirectionsUrl(v)}" target="_blank" rel="noopener">
        ${DIR_ICON} Directions
      </a>
      <button class="popup-edit-btn" onclick="if(popup)popup.remove();enterEditMode(${v.id})">
        ${EDIT_ICON} Edit
      </button>
    </div>`;
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

  // closeOnClick:false so the canvas always receives clicks (popup z-index 800 > canvas 690)
  popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: false, offset: [0, -10] })
    .setLngLat([v.lng, v.lat])
    .setHTML(`
      <div class="popup-name">${catIcon(v)} ${v.name}</div>
      <div class="popup-meta">★ ${v.rating} · ${catLabel(v)}</div>
      <div class="popup-address">${v.address}</div>
      ${popupSunLine(v)}
      ${popupActionsHTML(v)}
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
  popup.setHTML(`
    <div class="popup-name">${catIcon(v)} ${v.name}</div>
    <div class="popup-meta">★ ${v.rating} · ${catLabel(v)}</div>
    <div class="popup-address">${v.address}</div>
    ${popupSunLine(v)}
    ${popupActionsHTML(v)}
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

  // Scroll to + highlight the venue card in the sidebar
  setTimeout(() => {
    const card = document.querySelector(`.venue-card[data-vid="${venueId}"]`);
    if (card) {
      card.classList.add('editing');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 200);

  draw();
}

let editSatelliteActive = false;

function toggleEditSatellite() {
  editSatelliteActive = !editSatelliteActive;
  document.getElementById('edit-satellite-btn').classList.toggle('active', editSatelliteActive);
  map.setStyle(editSatelliteActive
    ? 'mapbox://styles/mapbox/satellite-streets-v12'
    : 'mapbox://styles/mapbox/standard'
  );
}

function exitEditMode() {
  editingVenueId = null;
  editHoveredWallIdx = null;
  document.getElementById('edit-overlay').style.display = 'none';
  document.querySelectorAll('.venue-card.editing').forEach(c => c.classList.remove('editing'));
  if (editSatelliteActive) {
    editSatelliteActive = false;
    document.getElementById('edit-satellite-btn').classList.remove('active');
    map.setStyle('mapbox://styles/mapbox/standard');
  }
  map.easeTo({ pitch: 15, bearing: 0, duration: 500 });
  draw();
  renderList();
}

function selectWallByIdx(idx) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v?.wallNormals) return;

  if (!v.terraceWallIndices) v.terraceWallIndices = [];
  const pos = v.terraceWallIndices.indexOf(idx);
  if (pos >= 0) {
    v.terraceWallIndices.splice(pos, 1);   // deselect
  } else {
    v.terraceWallIndices.push(idx);        // add
  }

  // Primary wall = first selected; fallback to index 0
  const primaryIdx = v.terraceWallIndices[0] ?? 0;
  v.wallSegment    = v.wallNormals[primaryIdx];
  v.facing         = v.terraceWallIndices.length > 0 ? Math.round(v.wallSegment.bearing) : v.facing;
  v.facingSource   = 'manual';

  saveFacingCache(v.id, v.facing, 'manual', v.terraceWallIndices, v.terraceDepth ?? 7);
  clearSpriteCache();
  sunWindowCache.clear();
  const walls = getTerraceWalls(v);
  const label = walls.length > 1
    ? `${v.facing}° ${bearingToCardinal(v.facing)} · ${walls.length} walls`
    : `${v.facing}° ${bearingToCardinal(v.facing)}`;
  document.getElementById('edit-facing-display').innerHTML = label;
  dispatchToWorker(datePicker.value);
  draw();
  renderList();
}

// ── Sidebar + filters ─────────────────────────────────────────────────────────
function isMobile() { return window.innerWidth < 640; }

function togglePanel() {
  panelVisible = !panelVisible;
  const panel  = document.getElementById('panel');
  const btn    = document.getElementById('panel-toggle');
  const handle = document.getElementById('panel-handle');
  if (isMobile()) {
    panel.classList.toggle('mobile-hidden', !panelVisible);
    if (handle) handle.style.display = panelVisible ? 'block' : 'none';
  } else {
    if (panelVisible) {
      panel.style.transform     = '';
      panel.style.opacity       = '';
      panel.style.pointerEvents = '';
      if (btn) btn.textContent  = '‹';
    } else {
      panel.style.transform     = 'translateX(calc(-100% - 20px))';
      panel.style.opacity       = '0';
      panel.style.pointerEvents = 'none';
      if (btn) btn.textContent  = '›';
    }
  }
  setTimeout(() => { resizeCanvas(); draw(); }, 290);
}

// Show handle on mobile init
let arcHoverH = null;

document.addEventListener('DOMContentLoaded', () => {
  if (isMobile()) {
    const h = document.getElementById('panel-handle');
    if (h) h.style.display = 'block';
  }

  // Position preset buttons after layout settles, then again on resize
  setTimeout(positionPresetButtons, 80);
  new ResizeObserver(() => positionPresetButtons()).observe(document.getElementById('sun-curve') ?? document.body);

  // Arc canvas drag + hover support
  const arcEl = document.getElementById('sun-curve');
  if (arcEl) {
    arcEl.addEventListener('mousedown',  e => { _arcDragging = true;  _arcSetTimeFromX(e.clientX); });
    arcEl.addEventListener('touchstart', e => { e.preventDefault(); _arcSetTimeFromX(e.touches[0].clientX); }, { passive: false });
    arcEl.addEventListener('touchmove',  e => { e.preventDefault(); _arcSetTimeFromX(e.touches[0].clientX); }, { passive: false });
    arcEl.addEventListener('mousemove',  e => {
      if (_arcDragging) return; // dragging handled separately
      const rect = arcEl.getBoundingClientRect();
      const t = MIN_H_ARC + (e.clientX - rect.left - PAD_X_ARC) / (rect.width - PAD_X_ARC * 2) * (MAX_H_ARC - MIN_H_ARC);
      arcHoverH = Math.max(MIN_H_ARC, Math.min(MAX_H_ARC, t));
      drawSunCurve(arcEl);
    });
    arcEl.addEventListener('mouseleave', () => {
      arcHoverH = null;
      drawSunCurve(arcEl);
    });
  }
  document.addEventListener('mousemove', e => { if (_arcDragging) _arcSetTimeFromX(e.clientX); });
  document.addEventListener('mouseup',   () => { _arcDragging = false; });

  // Request location on load so distance shows in cards without needing to sort by distance
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        renderList();
      },
      () => {} // silently ignore if denied
    );
  }
});

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
  if (nowMode) {
    nowMode = false;
    nowBtn.classList.remove('active');
    timeRangeWrap.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  setActiveIntentBtn(null);
  updateRangeFill();
  update();
});

document.getElementById('venue-search').addEventListener('input',  () => renderList());

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && editingVenueId) exitEditMode();
});
