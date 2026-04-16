/**
 * app.js — Application state, orchestration, map setup, worker glue.
 * Loaded after solar.js and data.js. render.js, ui.js, osm.js load after this.
 * Init (updateRangeFill / update / initFacings) is called from inline script at
 * bottom of index.html after all files are loaded.
 */

// No JS viewport-height fix needed — mobile panels use position:fixed + svh units.

// ── Mutable state ─────────────────────────────────────────────────────────────
let currentSun        = null;   // {az, alt} for the FROM time
let currentSunTable   = null;   // Float64Array built once per date
let currentDateStr    = null;   // tracks which date the table belongs to
let selectedId        = null;
let editingVenueId    = null;
let editHoveredWallIdx = null;
let _editBeforeSnapshot = null;   // venue state captured when entering edit mode
let popup             = null;
let nowMode           = false;
let nowInterval       = null;
let userLocation      = null;
let filterFullSunActive = false;
let filterMapViewActive = true;
let activeArea    = '';
let activeSortBy  = 'score';
let activeIntent  = null;
let panelVisible      = true;
// Consolidated hover/raise state.
//   id       — currently highlighted pin (drives glow ring); null when nothing is hovered
//   source   — 'map' | 'list'
//   raisedId — last list-hovered pin; drives pin lift; persists after cursor leaves sidebar
const highlight = { id: null, source: null, raisedId: null };
let mapLoaded         = false;
let _qcActiveSection  = null; // 'date' | 'time' | null
let _qcArcDragging    = false;
let _navMode          = false; // true after clicking a pin/card — use radius filter instead of map bounds
let _preSelectZoom    = null;  // zoom level saved before zooming into a selected venue
let _preSelectCenter  = null;  // map center saved before zooming into a selected venue
let _frozenBounds     = null;  // map bounds frozen at the moment of venue selection (for list filter)
let _mapMovedWhileDetailOpen = false; // true if user panned/zoomed while detail panel was open

// ── Time animation ────────────────────────────────────────────────────────────
const TIME_ANIM_MS = 520;
let _timeAnimId    = null;
let _timeAnimFrom  = 0;
let _timeAnimTo    = 0;
let _timeAnimStart = 0;

// ── Intro sequence state ──────────────────────────────────────────────────────
let _introMapReady  = false;
let _introGeoReady  = false;
let _introCenter    = [10.728, 59.9125]; // Oslo fallback
let _introRunning   = false;
let _introSeqId     = 0; // incremented on skip to invalidate pending timeouts

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
  antialias: true,
  attributionControl: false,
});

map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

// ── User location dot ─────────────────────────────────────────────────────────
function _updateLocationDot() {
  const el = document.getElementById('user-location-dot');
  if (!el || !mapLoaded) return;
  if (!userLocation) { el.style.display = 'none'; return; }
  const pt = map.project([userLocation.lng, userLocation.lat]);
  el.style.left    = Math.round(pt.x) + 'px';
  el.style.top     = Math.round(pt.y) + 'px';
  el.style.display = '';
}

function locateUser() {
  if (!userLocation) return;
  const btn = document.getElementById('locate-btn');
  if (btn) { btn.classList.add('tracking'); setTimeout(() => btn.classList.remove('tracking'), 1200); }
  map.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 });
}

map.on('move',    _updateLocationDot);
map.on('zoomend', _updateLocationDot);

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

  _introMapReady = true;
  _introCheckReady();
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
  const total = Math.round(h * 60);
  const hr = Math.floor(total / 60), min = total % 60;
  return `${String(hr).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function formatSliderTime(val) {
  const total = Math.round(val * 60);
  const h = Math.floor(total / 60), m = total % 60;
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
const PAD_X_ARC = 20;
let MIN_H_ARC = 4, MAX_H_ARC = 23; // updated dynamically from sunrise/sunset

function _arcTimeToLeft(h, canvasW) {
  return PAD_X_ARC + (h - MIN_H_ARC) / (MAX_H_ARC - MIN_H_ARC) * (canvasW - PAD_X_ARC * 2);
}

function positionPresetButtons() {
  const isToday = datePicker.value === todayStr();
  const sunsetH = currentSunTable ? (findSunCrossingFromTable(currentSunTable, false) ?? 21) : 21;

  document.querySelectorAll('.intent-btn').forEach(btn => {
    if (btn.dataset.intent === 'evening') btn.style.display = sunsetH >= 20 ? '' : 'none';
    if (btn.dataset.intent === 'now')     btn.textContent = isToday ? 'Now' : 'Sunrise';
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
  pill.style.left   = (btnRect.left   - rowRect.left) + 'px';
  pill.style.top    = (btnRect.top    - rowRect.top)  + 'px';
  pill.style.width  = btnRect.width  + 'px';
  pill.style.height = btnRect.height + 'px';
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
        nowInterval = setInterval(() => { if (nowMode) { applyNowTime(); update(); } }, 30000);
      }
      animateToTime(Math.min(23, Math.max(4, currentHour())));
    } else {
      // Future date: animate to sunrise
      if (nowMode) { nowMode = false; clearInterval(nowInterval); nowInterval = null; }
      const sunriseH = currentSunTable ? (findSunCrossingFromTable(currentSunTable, true) ?? 7) : 7;
      animateToTime(Math.max(MIN_H_ARC, Math.min(MAX_H_ARC, sunriseH)));
    }
    return;
  }
  if (nowMode) {
    nowMode = false;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  animateToTime(_PRESET_HOURS[intent]);
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

// ── Date display button + weather strip ──────────────────────────────────────
function updateDateDisplayBtn() {
  const btn = document.getElementById('date-display-btn');
  if (!btn) return;
  const val  = datePicker.value;
  const d    = new Date(val + 'T12:00:00');
  const tod  = todayStr();
  const tom  = new Date(); tom.setDate(tom.getDate() + 1);
  const tomS = tom.toISOString().slice(0, 10);
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (val === tod)  btn.textContent = `Today · ${d.getDate()} ${MONS[d.getMonth()]}`;
  else if (val === tomS) btn.textContent = `Tomorrow · ${d.getDate()} ${MONS[d.getMonth()]}`;
  else btn.textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONS[d.getMonth()]}`;
}

function updateDateWeatherStrip() {
  const el = document.getElementById('date-wx-strip');
  if (!el) return;
  const wx = typeof getWeatherAt === 'function'
    ? getWeatherAt(datePicker.value, parseFloat(timeFromEl.value))
    : null;
  if (!wx) { el.style.display = 'none'; return; }
  el.style.display = '';
  const ARROWS = ['↑','↗','→','↘','↓','↙','←','↖'];
  const arrow   = ARROWS[Math.round(((wx.wdir + 180) % 360) / 45) % 8];
  const rain    = wx.precip >= 0.2
    ? `<span class="wx-rain">🌧 ${wx.precip.toFixed(1)}</span>`
    : '';
  el.innerHTML = `<span>${skyIcon(wx.cloud)}</span>`
    + `<span class="wx-temp-strip">${wx.temp}°</span>`
    + `<span class="wx-sep">·</span>`
    + `<span class="wx-wind">${arrow} ${Math.round(wx.wspd)} m/s</span>`
    + rain;
}

// ── Date calendar picker ──────────────────────────────────────────────────────
function renderDateCalendar() {
  const cal = document.getElementById('date-calendar');
  if (!cal) return;
  const selected = datePicker.value;
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '<div class="dc-grid">';
  for (let i = 0; i < 14; i++) {
    const d    = new Date(); d.setDate(d.getDate() + i);
    const dStr = d.toISOString().slice(0, 10);
    const summ = typeof getDayWeatherSummary === 'function' ? getDayWeatherSummary(dStr) : null;
    let cls = 'dc-tile';
    if (i === 0)        cls += ' today';
    if (dStr === selected) cls += ' selected';
    if (summ) {
      if (summ.avgCloud < 0.30) cls += ' sun-high';
      else if (summ.avgCloud < 0.60) cls += ' sun-mid';
    } else {
      cls += ' no-data';
    }
    const icon = summ ? summ.icon : '·';
    const temp = summ ? `${summ.peakTemp}°` : '';
    html += `<button class="${cls}" onclick="selectCalendarDate('${dStr}')">`
      + `<span class="dc-day">${DAYS[d.getDay()]}</span>`
      + `<span class="dc-num">${d.getDate()}</span>`
      + `<span class="dc-icon">${icon}</span>`
      + `<span class="dc-temp">${temp}</span>`
      + `</button>`;
  }
  html += '</div>';
  cal.innerHTML = html;
}

function toggleDateCalendar() {
  const cal = document.getElementById('date-calendar');
  const btn = document.getElementById('date-display-btn');
  if (!cal) return;
  const isOpen = cal.classList.toggle('open');
  if (btn) btn.classList.toggle('open', isOpen);
  if (isOpen) renderDateCalendar();
}

function selectCalendarDate(dateStr) {
  datePicker.value = dateStr;
  const cal = document.getElementById('date-calendar');
  const btn = document.getElementById('date-display-btn');
  if (cal) cal.classList.remove('open');
  if (btn) btn.classList.remove('open');
  update();
}

// ── Hover from sidebar list ───────────────────────────────────────────────────
function setHoveredVenue(id) {
  if (id !== null) {
    highlight.id = id;
    highlight.source = 'list';
    highlight.raisedId = id;   // persists after cursor leaves sidebar
  } else {
    highlight.id = null;
    highlight.source = null;
    // highlight.raisedId intentionally kept
  }
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
  if (!panel || !btn) return;
  const isOpen = panel.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  if (isOpen) {
    const r = btn.getBoundingClientRect();
    panel.style.top  = (r.bottom + 4) + 'px';
    panel.style.left = r.right + 'px';
    panel.style.transform = 'translateX(-100%)';
  }
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
  _renderListTimer = setTimeout(() => { renderList(); setTimeout(_syncQcPanelHeight, 80); }, 300);
}

// ── QC notice (below date/time picker) ───────────────────────────────────────
function showQcNotice(msg) {
  const el = document.getElementById('qc-notice');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('visible'), 4000);
}

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('visible'), 3500);
}

let _autoAdvancedAfterSunset = false;

// ── Day navigation ────────────────────────────────────────────────────────────
function advanceDay(delta, setHour) {
  const d = new Date(datePicker.value + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  datePicker.value = d.toISOString().slice(0, 10);
  // When jumping forward and sun is currently below horizon, default to noon
  if (setHour === undefined && delta > 0 && currentSun && currentSun.alt < 0) setHour = 12;
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

function _clampHour(t) {
  const snapped = Math.round(t * 4) / 4;
  const minH = (datePicker.value === todayStr()) ? Math.round(currentHour() * 4) / 4 : MIN_H_ARC;
  return Math.max(Math.max(MIN_H_ARC, minH), Math.min(MAX_H_ARC, snapped));
}

function _arcSetTimeFromX(clientX) {
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  const canvasEl = document.getElementById('sun-curve');
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  const t    = MIN_H_ARC + (clientX - rect.left - PAD_X_ARC) / (rect.width - PAD_X_ARC * 2) * (MAX_H_ARC - MIN_H_ARC);
  const hour = _clampHour(t);
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

function animateToTime(targetHour, durationMs) {
  const dur     = durationMs ?? TIME_ANIM_MS;
  const current = parseFloat(timeFromEl.value);
  if (Math.abs(current - targetHour) < 0.02) { update(); return; }
  if (_timeAnimId) cancelAnimationFrame(_timeAnimId);
  _timeAnimFrom  = current;
  _timeAnimTo    = targetHour;
  _timeAnimStart = performance.now();
  function tick() {
    const t    = Math.min(1, (performance.now() - _timeAnimStart) / dur);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; // ease-in-out cubic
    timeFromEl.value = _timeAnimFrom + (_timeAnimTo - _timeAnimFrom) * ease;
    update();
    if (t < 1) { _timeAnimId = requestAnimationFrame(tick); }
    else        { _timeAnimId = null; }
  }
  _timeAnimId = requestAnimationFrame(tick);
}

// ── Quick Controls Bar ────────────────────────────────────────────────────────
function updateQcIndicator(h) {
  const el = document.getElementById('qc-indicator');
  if (!el) return;
  const hour   = h ?? parseFloat(timeFromEl.value);
  const dateStr = datePicker.value;
  const wx      = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, hour) : null;
  const icon    = wx && typeof skyIcon === 'function' ? skyIcon(wx.cloud) : '';
  const ARROWS  = ['↑','↗','→','↘','↓','↙','←','↖'];
  const arrow   = wx ? ARROWS[Math.round(((wx.wdir + 180) % 360) / 45) % 8] : '';
  const wind    = wx ? `${arrow} ${Math.round(wx.wspd)} m/s` : '';
  const temp    = wx ? `${wx.temp}°` : '';
  el.innerHTML = `<span class="qci-time">${formatHour(hour)}</span>`
    + (icon ? `<span class="qci-icon">${icon}</span>` : '')
    + (temp ? `<span class="qci-temp">${temp}</span>` : '')
    + (wind ? `<span class="qci-wind">${wind}</span>` : '');
}

function updateQcLabels() {
  const dateLabel = document.getElementById('qc-date-label');
  const timeLabel = document.getElementById('qc-time-label');
  if (!dateLabel || !timeLabel) return;

  const val  = datePicker.value;
  const tod  = todayStr();
  const tom  = new Date(); tom.setDate(tom.getDate() + 1);
  const tomS = tom.toISOString().slice(0, 10);

  if (val === tod)       dateLabel.textContent = 'Today';
  else if (val === tomS) dateLabel.textContent = 'Tomorrow';
  else {
    const d    = new Date(val + 'T12:00:00');
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateLabel.textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONS[d.getMonth()]}`;
  }

  timeLabel.textContent = formatHour(parseFloat(timeFromEl.value));

  // "Now" only makes sense today — show "Sunrise" on future dates
  const isToday = datePicker.value === todayStr();
  document.querySelectorAll('.qc-preset-btn[data-intent="now"]').forEach(b => {
    b.textContent = isToday ? 'Now' : 'Sunrise';
  });

  // Sync qc preset buttons with main intent
  document.querySelectorAll('.qc-preset-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.intent === activeIntent));
}

function _closeQcPanel() {
  const panel = document.getElementById('qc-panel');
  if (!panel) return;

  // Pills and state reset immediately
  document.getElementById('qc-date-pill')?.classList.remove('active');
  document.getElementById('qc-time-pill')?.classList.remove('active');
  _qcActiveSection = null;

  // Keep sections active so content is present during the closing animation.
  // Remove 'open' — this starts the max-height + opacity transitions.
  panel.classList.remove('open');

  // After the animation ends, remove active from sections (resets display:none)
  const cleanup = e => {
    if (e.propertyName !== 'max-height') return;
    panel.removeEventListener('transitionend', cleanup);
    document.getElementById('qc-date-section')?.classList.remove('active');
    document.getElementById('qc-time-section')?.classList.remove('active');
  };
  panel.addEventListener('transitionend', cleanup);
}

function toggleQcPanel(section) {
  const panel = document.getElementById('qc-panel');
  if (!panel) return;

  if (_qcActiveSection === section) {
    _closeQcPanel();
    return;
  }

  _qcActiveSection = section;
  panel.classList.add('open');
  document.getElementById('qc-date-section')?.classList.toggle('active', section === 'date');
  document.getElementById('qc-time-section')?.classList.toggle('active', section === 'time');
  document.getElementById('qc-date-pill')?.classList.toggle('active', section === 'date');
  document.getElementById('qc-time-pill')?.classList.toggle('active', section === 'time');

  if (section === 'date') {
    renderQcCalendar();
  } else if (section === 'time') {
    setTimeout(() => drawSunCurve(document.getElementById('qc-arc')), 50);
  }
}

function renderQcCalendar() {
  const cal = document.getElementById('qc-cal');
  if (!cal) return;
  const selected = datePicker.value;
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '<div class="dc-grid">';
  for (let i = 0; i < 14; i++) {
    const d    = new Date(); d.setDate(d.getDate() + i);
    const dStr = d.toISOString().slice(0, 10);
    const summ = typeof getDayWeatherSummary === 'function' ? getDayWeatherSummary(dStr) : null;
    let cls = 'dc-tile';
    if (i === 0)           cls += ' today';
    if (dStr === selected) cls += ' selected';
    if (summ) {
      if (summ.avgCloud < 0.30)      cls += ' sun-high';
      else if (summ.avgCloud < 0.60) cls += ' sun-mid';
    } else {
      cls += ' no-data';
    }
    const icon = summ ? summ.icon : '·';
    const temp = summ ? `${summ.peakTemp}°` : '';
    html += `<button class="${cls}" onclick="selectQcDate('${dStr}')">`
      + `<span class="dc-day">${DAYS[d.getDay()]}</span>`
      + `<span class="dc-num">${d.getDate()}</span>`
      + `<span class="dc-icon">${icon}</span>`
      + `<span class="dc-temp">${temp}</span>`
      + `</button>`;
  }
  html += '</div>';
  cal.innerHTML = html;
}

function selectQcDate(dateStr) {
  datePicker.value = dateStr;
  _closeQcPanel();
  update();
}

let _qcPanelHeight = 0; // cached, set on load/resize/list-render

function _syncQcPanelHeight() {
  if (isMobile()) return; // height fixed via CSS on mobile
  const firstCard = document.querySelector('#venue-list .venue-card:not(.skeleton)');
  const qcBar     = document.getElementById('qc-bar');   // bar height is always stable
  const qcPanel   = document.getElementById('qc-panel');
  if (!firstCard || !qcBar || !qcPanel) return;
  // Anchor to the bar's bottom (never changes with panel open/closed)
  const h = Math.max(120, Math.round(firstCard.getBoundingClientRect().bottom - qcBar.getBoundingClientRect().bottom - 8));
  if (h === _qcPanelHeight) return; // no change
  _qcPanelHeight = h;
  const dateSection = document.getElementById('qc-date-section');
  const timeSection = document.getElementById('qc-time-section');
  if (dateSection) dateSection.style.height = h + 'px';
  if (timeSection) timeSection.style.height = h + 'px';
  qcPanel.style.setProperty('--qc-panel-h', (h + 10) + 'px');
}

function _qcArcSetTimeFromX(clientX) {
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  const canvasEl = document.getElementById('qc-arc');
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  const t    = MIN_H_ARC + (clientX - rect.left - PAD_X_ARC) / (rect.width - PAD_X_ARC * 2) * (MAX_H_ARC - MIN_H_ARC);
  const hour = _clampHour(t);
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

  // Dynamic arc range — hug sunrise/sunset so the curve fills the canvas naturally
  if (sunrise != null && sunset != null) {
    MIN_H_ARC = Math.max(3, Math.floor(sunrise - 0.75));
    MAX_H_ARC = Math.min(24, Math.ceil(sunset  + 0.75));
  }

  // Auto-advance to tomorrow after sunset (once per session startup)
  if (!_autoAdvancedAfterSunset && dateStr === todayStr() && sunset != null) {
    const realNow = new Date().getHours() + new Date().getMinutes() / 60;
    if (realNow > sunset) {
      _autoAdvancedAfterSunset = true;
      setTimeout(() => {
        advanceDay(1, 12);
        showQcNotice('Sun has set — showing tomorrow');
      }, 0);
      return;
    }
  }

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

  draw();
  drawSunCompass();
  drawSunCurve(document.getElementById('sun-curve'));
  positionPresetButtons();
  updateWeatherDisplay();
  scheduleRenderList();
  updatePopup();
  updateLightPreset();
  updateSunLighting();

  if (highlight.id != null && tooltip.classList.contains('visible')) {
    const hv = VENUES.find(x => x.id === highlight.id);
    if (hv) tooltip.innerHTML = buildTooltipContent(hv);
  }

  updateDateDisplayBtn();
  updateDateWeatherStrip();
  updateQcLabels();
  updateQcIndicator(null);
  if (_qcActiveSection === 'time') drawSunCurve(document.getElementById('qc-arc'));
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

// ── Shared venue camera animation ────────────────────────────────────────────
// Single place for all venue camera animations — pin clicks AND list clicks.
// Uses easeTo (smooth interpolation) so the animation looks correct whether
// the user is already zoomed in (pin click) or coming from overview (list click).
function _flyToVenue(v) {
  const targetZoom = 17.70;
  const opts = { center: [v.lng, v.lat], zoom: targetZoom, pitch: 45, duration: 600 };

  if (isMobile()) {
    const panelH = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.69);
    opts.padding = { top: 0, bottom: panelH, left: 0, right: 0 };
  } else {
    // On desktop, if the detail panel is already open (venue switching), offset
    // the camera so the venue isn't hidden behind the panel.
    const dp = document.getElementById('detail-panel');
    const padLeft = (dp && dp.classList.contains('open'))
      ? (dp.offsetLeft + dp.offsetWidth) : 0;
    if (padLeft > 0) opts.padding = { left: padLeft, right: 0, top: 60, bottom: 0 };
  }

  const wallBearing   = v.wallSegment?.bearing ?? v.facing;
  const targetBearing = (wallBearing + 180) % 360;
  const curBearing    = ((map.getBearing() % 360) + 360) % 360;
  let   diff          = Math.abs(targetBearing - curBearing);
  if (diff > 180) diff = 360 - diff;
  if (diff > 60) opts.bearing = targetBearing;

  map.easeTo(opts);
}

function selectVenue(id, flyTo) {
  selectedId = id;
  _navMode   = true;   // show all venues in radius, not just current map view
  clearSpriteCache();
  const v = VENUES.find(x => x.id === id);
  if (!v) return;

  if (flyTo) {
    // Save pre-select state (guarded so switching venues while one is open doesn't overwrite)
    if (_preSelectZoom === null) {
      _preSelectZoom   = map.getZoom();
      _preSelectCenter = map.getCenter();
      _frozenBounds    = map.getBounds();
    }
    _mapMovedWhileDetailOpen = false; // reset interaction flag for this new selection
    _flyToVenue(v);
  }

  _switchingVenue = true;
  if (popup) { popup.remove(); popup = null; }
  _switchingVenue = false;

  openDetailPanel(v);

  draw();
  renderList();

  setTimeout(() => {
    const card = document.querySelector(`.venue-card[data-vid="${id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

function updatePopup() {
  updateDetailPanel();
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function openDetailPanel(v) {
  _mapMovedWhileDetailOpen = false; // reset each time a panel opens
  const dp      = document.getElementById('detail-panel');
  const content = document.getElementById('dp-content');
  if (!dp || !content) return;

  if (!authCurrentUser()) {
    content.innerHTML = renderLoginGate(v);
    dp.classList.remove('dp-fullscreen');
    dp.classList.add('open');
    if (isMobile()) {
      const panel = document.getElementById('panel');
      if (panel) {
        panel.classList.remove('mobile-expanded', 'mobile-fullscreen');
        panel.classList.add('mobile-hidden');
      }
      document.getElementById('floating-search')?.classList.add('mobile-ui-hidden');
      document.getElementById('qc-wrap')?.classList.add('mobile-ui-hidden');
    }
    return;
  }

  content.innerHTML = renderDetailPanelContent(v, datePicker.value, parseFloat(timeFromEl.value));
  dp.classList.remove('dp-fullscreen');
  dp.classList.add('open');
  _drawShelterDiagram(v);
  _startWindForVenue(v);
  if (isMobile()) {
    const panel = document.getElementById('panel');
    if (panel) {
      panel.classList.remove('mobile-expanded', 'mobile-fullscreen');
      panel.classList.add('mobile-hidden');
    }
    document.getElementById('floating-search')?.classList.add('mobile-ui-hidden');
    document.getElementById('qc-wrap')?.classList.add('mobile-ui-hidden');
  }
}

function _getWxNow() {
  return typeof getWeatherAt === 'function'
    ? getWeatherAt(datePicker.value, parseFloat(timeFromEl.value))
    : null;
}

function _drawShelterDiagram(v) {
  const canvas = document.getElementById('dp-shelter-canvas');
  if (!canvas) return;
  drawShelterDiagram(v, _getWxNow(), canvas);
}

function _startWindForVenue(v) {
  if (typeof startWindOverlay === 'function') startWindOverlay(v, _getWxNow());
}

function closeDetailPanel(expandList = true) {
if (typeof stopWindOverlay === 'function') stopWindOverlay();
  const dp = document.getElementById('detail-panel');
  if (dp) {
    dp.classList.remove('open', 'dp-fullscreen');
  }
  if (isMobile()) {
    // Delay restoring the venue list until the detail panel has finished its
    // 300ms close animation, so the two panels are never visible at the same time.
    // expandList=true (< Venues back button): restore expanded so the list is immediately browsable.
    // expandList=false (X button / swipe down): restore to peek state.
    setTimeout(() => {
      const panel = document.getElementById('panel');
      if (panel) {
        panel.classList.remove('mobile-hidden', 'mobile-fullscreen');
        if (expandList) panel.classList.add('mobile-expanded');
        else            panel.classList.remove('mobile-expanded');
}
      document.getElementById('floating-search')?.classList.remove('mobile-ui-hidden');
      document.getElementById('qc-wrap')?.classList.remove('mobile-ui-hidden');
    }, 320);
  }
  if (selectedId != null) {
    selectedId = null;
    _frozenBounds  = null;
    clearSpriteCache();
    draw();
    renderList();
    const interacted    = _mapMovedWhileDetailOpen;
    _mapMovedWhileDetailOpen = false;
    const restoreZoom   = _preSelectZoom  ?? map.getZoom();
    const restoreCenter = _preSelectCenter ?? map.getCenter();
    _preSelectZoom   = null;
    _preSelectCenter = null;
    if (interacted) {
      // User panned/zoomed in mini-map while panel was open — keep their position,
      // only reset tilt back to standard.
      map.easeTo({ pitch: 15, bearing: 0, duration: 500,
                   padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    } else {
      map.easeTo({ center: restoreCenter, zoom: restoreZoom, pitch: 15, bearing: 0, duration: 600,
                   padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    }
  }
}

function updateDetailPanel() {
  if (selectedId == null) return;
  const dp      = document.getElementById('detail-panel');
  const content = document.getElementById('dp-content');
  if (!dp || !dp.classList.contains('open') || !content) return;
  if (!authCurrentUser()) return;
  const v = VENUES.find(x => x.id === selectedId);
  if (!v) return;
  content.innerHTML = renderDetailPanelContent(v, datePicker.value, parseFloat(timeFromEl.value));
  _drawShelterDiagram(v);
  _startWindForVenue(v); // restart with updated weather snapshot
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function _venueEditSnapshot(v) {
  return {
    terraceType:             v.terraceType ?? 'street',
    terraceWallIndices:      (v.terraceWallIndices ?? []).slice(),
    terraceDepth:            v.terraceDepth ?? null,
    facing:                  v.facing,
    facingSource:            v.facingSource ?? null,
    terraceDetachedLocation: v.terraceDetachedLocation ? { ...v.terraceDetachedLocation } : null,
  };
}

function enterEditMode(venueId) {
  if (typeof stopWindOverlay === 'function') stopWindOverlay();
  editingVenueId = venueId;
  editHoveredWallIdx = null;
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;

  _editBeforeSnapshot = _venueEditSnapshot(v);

  document.getElementById('edit-overlay').style.display = 'block';
  document.getElementById('floating-search').style.display = 'none';
  document.getElementById('panel').style.display = 'none';
  document.getElementById('detail-panel').style.display = 'none';
  document.getElementById('qc-wrap').style.display = 'none';
  document.getElementById('qc-panel').style.display = 'none';
  document.getElementById('panel-reveal-btn').style.display = 'none';
  document.getElementById('edit-venue-label').textContent = v.name;
  const type = v.terraceType ?? 'street';
  if (type === 'rooftop')   document.getElementById('edit-facing-display').innerHTML = 'Rooftop';
  else if (type === 'courtyard') document.getElementById('edit-facing-display').innerHTML = 'Courtyard';
  else if (type === 'detached')  document.getElementById('edit-facing-display').innerHTML = 'Detached';
  else document.getElementById('edit-facing-display').innerHTML = `${v.facing}° ${bearingToCardinal(v.facing)}`;
  _syncTerraceTypeUI(type);

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
  // Detect and record corrections before clearing state
  if (editingVenueId && _editBeforeSnapshot) {
    const v    = VENUES.find(x => x.id === editingVenueId);
    const after = v ? _venueEditSnapshot(v) : null;
    if (v && after && JSON.stringify(_editBeforeSnapshot) !== JSON.stringify(after)) {
      saveCorrection('correction', {
        id: v.id, name: v.name, category: v.category,
        before: _editBeforeSnapshot,
        after,
        buildingNodeCount: v.buildingGeometry?.length ?? null,
      });
    }
  }
  _editBeforeSnapshot = null;
  editingVenueId = null;
  editHoveredWallIdx = null;
  document.getElementById('edit-overlay').style.display = 'none';
  document.getElementById('floating-search').style.display = '';
  document.getElementById('panel').style.display = '';
  document.getElementById('detail-panel').style.display = '';
  document.getElementById('qc-wrap').style.display = '';
  document.getElementById('qc-panel').style.display = '';
  document.getElementById('panel-reveal-btn').style.display = '';
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

/** User confirmed the model is already correct — record as positive signal and close. */
function confirmEditCorrect() {
  if (editingVenueId && _editBeforeSnapshot) {
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) {
      saveCorrection('confirmed', {
        id: v.id, name: v.name, category: v.category,
        state: _editBeforeSnapshot,
        buildingNodeCount: v.buildingGeometry?.length ?? null,
      });
    }
  }
  exitEditMode();
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

const _TYPE_SUBTITLES = {
  street:    'Click walls to add/remove · drag ● to set depth',
  rooftop:   'Sun based on altitude only — no wall or shadow logic',
  courtyard: 'Sun reaches floor only at high altitude (~midday in summer)',
  detached:  'Click the map to place the terrace location',
};

function _syncTerraceTypeUI(type) {
  document.querySelectorAll('.edit-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  const subtitle = document.getElementById('edit-subtitle');
  if (subtitle) subtitle.textContent = _TYPE_SUBTITLES[type] ?? _TYPE_SUBTITLES.street;
}

function setTerraceType(type) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;
  v.terraceType = type;
  _syncTerraceTypeUI(type);

  const facingEl = document.getElementById('edit-facing-display');

  if (type === 'rooftop' || type === 'courtyard') {
    v.terraceTestPoints = v.buildingGeometry?.length
      ? (() => { const c = computeCentroid(v.buildingGeometry); return [{ lat: c.lat, lng: c.lon }]; })()
      : [{ lat: v.lat, lng: v.lng }];
    facingEl.innerHTML = type === 'rooftop' ? 'Rooftop' : 'Courtyard';
  } else if (type === 'detached') {
    if (!v.terraceDetachedLocation) v.terraceDetachedLocation = { lat: v.lat, lng: v.lng };
    v.terraceTestPoints = [{ ...v.terraceDetachedLocation }];
    facingEl.innerHTML = 'Detached';
  } else {
    // street
    v.terraceTestPoints = computeTerraceTestPoints(v, null);
    const walls = getTerraceWalls(v);
    facingEl.innerHTML = walls.length > 1
      ? `${v.facing}° ${bearingToCardinal(v.facing)} · ${walls.length} walls`
      : `${v.facing}° ${bearingToCardinal(v.facing)}`;
  }

  saveFacingCache(v.id, v.facing, v.facingSource,
    v.terraceWallIndices, v.terraceDepth, v.noiseScore, type, v.terraceDetachedLocation);
  sunWindowCache.clear();
  dispatchToWorker(datePicker.value);
  draw();
  renderList();
}

/** Called from render.js when user clicks/drags the detached pin. */
function setDetachedLocation(lat, lng) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v || v.terraceType !== 'detached') return;
  v.terraceDetachedLocation = { lat, lng };
  v.terraceTestPoints = [{ lat, lng }];
  saveFacingCache(v.id, v.facing, v.facingSource,
    v.terraceWallIndices, v.terraceDepth, v.noiseScore, 'detached', { lat, lng });
  sunWindowCache.clear();
  dispatchToWorker(datePicker.value);
  draw();
}

// ── Sidebar + filters ─────────────────────────────────────────────────────────
function isMobile() { return window.innerWidth < 640; }

function togglePanel() {
  const panel  = document.getElementById('panel');
  const btn    = document.getElementById('panel-toggle');
  const handle = document.getElementById('panel-handle');

  if (isMobile()) {
    if (panel.classList.contains('mobile-expanded')) {
      // expanded → peek
      panel.classList.remove('mobile-expanded');
    } else if (!panel.classList.contains('mobile-hidden')) {
      // peek → expanded
      panel.classList.add('mobile-expanded');
    } else {
      // hidden → peek
      panel.classList.remove('mobile-hidden');
    }
    panelVisible = true;
    if (handle) handle.style.display = 'flex';
    setTimeout(() => { resizeCanvas(); draw(); }, 290);
    return;
  }

  panelVisible = !panelVisible;
  const revealBtn   = document.getElementById('panel-reveal-btn');
  const detailPanel = document.getElementById('detail-panel');
  const qcWrap      = document.getElementById('qc-wrap');
  if (panelVisible) {
    panel.style.transform     = '';
    panel.style.opacity       = '';
    panel.style.pointerEvents = '';
    if (btn) btn.textContent  = '‹';
    if (revealBtn) revealBtn.style.display = 'none';
    if (detailPanel) detailPanel.style.left = '';
    if (qcWrap) qcWrap.style.left = '';
  } else {
    panel.style.transform     = 'translateX(calc(-100% - 20px))';
    panel.style.opacity       = '0';
    panel.style.pointerEvents = 'none';
    if (btn) btn.textContent  = '›';
    if (revealBtn) revealBtn.style.display = 'flex';
    if (detailPanel) detailPanel.style.left = '16px';
    if (qcWrap) qcWrap.style.left = '16px';
  }
  setTimeout(() => { resizeCanvas(); draw(); }, 290);
}

// Show handle on mobile init
let arcHoverH = null;

document.addEventListener('DOMContentLoaded', () => {
  if (isMobile()) {
    const h       = document.getElementById('panel-handle');
    const panelEl = document.getElementById('panel');
    if (h) h.style.display = 'flex';

    // ── Panel drag-to-resize (bottom-sheet) ─────────────────────────────────
    // Three states: peek → expanded → fullscreen
    //
    // Velocity-based (swipe): steps one state in the swipe direction.
    //   Swipe up:   peek→expanded, expanded→fullscreen
    //   Swipe down: fullscreen→expanded, expanded→peek
    //
    // Position-based (slow drag): snaps to nearest state by release Y.
    //
    // Tap (<10px movement): toggles peek↔expanded.
    //
    // Venue list at top + pull-down: drags panel like the handle.
    // Venue list at top + fast swipe (no drag mode started): same state machine.
    if (h && panelEl) {
      let _dragY0 = 0, _dragT0 = 0, _dragActive = false, _dragFromList = false;
      let _dragStartState = 'peek', _dragStartTime = 0;

      function _panelTranslateNow() {
        return new DOMMatrix(getComputedStyle(panelEl).transform).m42;
      }

      function _currentState() {
        if (panelEl.classList.contains('mobile-fullscreen')) return 'fullscreen';
        if (panelEl.classList.contains('mobile-expanded'))   return 'expanded';
        return 'peek';
      }

      function _applyState(state) {
        if (state === 'fullscreen') {
          panelEl.classList.add('mobile-fullscreen', 'mobile-expanded');
        } else if (state === 'expanded') {
          panelEl.classList.add('mobile-expanded');
          panelEl.classList.remove('mobile-fullscreen');
        } else {
          panelEl.classList.remove('mobile-expanded', 'mobile-fullscreen');
        }
      }

      let _dragInitH = 0; // panel height at drag start (px)

      function _beginDrag(y) {
        _dragY0         = y;
        _dragT0         = _panelTranslateNow();
        _dragActive     = true;
        _dragStartState = _currentState();
        _dragStartTime  = Date.now();
        _dragInitH      = panelEl.offsetHeight;
        panelEl.style.transition = 'none';
      }

      function _trackDrag(y) {
        if (!_dragActive) return;
        const dy = y - _dragY0;
        // Pure translateY in both directions — no height changes → no reflow
        // Upward (dy<0): panel slides up, appearing taller (bottom fixed)
        // Downward (dy>0): panel slides down, clamped so ≥80px stays visible
        panelEl.style.transform = `translateY(${Math.min(_dragInitH - 80, _dragT0 + dy)}px)`;
      }

      function _commitDrag(y) {
        if (!_dragActive) return;
        _dragActive   = false;
        _dragFromList = false;

        const dy       = y - _dragY0;
        const dt       = Math.max(1, Date.now() - _dragStartTime);
        const velocity = dy / dt; // px/ms, positive = downward

        panelEl.style.transition = '';
        panelEl.style.transform  = '';
        panelEl.style.height     = '';

        const SWIPE_V = 0.2, SAFE_DY = 40;
        let target;
        if      (velocity < -SWIPE_V)            target = _dragStartState === 'peek' ? 'expanded' : 'fullscreen';
        else if (velocity >  SWIPE_V)            target = _dragStartState === 'fullscreen' ? 'expanded' : 'peek';
        else if (Math.abs(dy) <= SAFE_DY)        target = _dragStartState; // safe zone → snap back
        else if (dy < 0)                         target = _dragStartState === 'peek' ? 'expanded' : 'fullscreen';
        else                                     target = _dragStartState === 'fullscreen' ? 'expanded' : 'peek';

        _applyState(target);
      }

      // Wire a swipe target: touchstart/move/end → panel drag state machine
      function _wireSwipeTarget(el) {
        el.addEventListener('touchstart', e => {
          _beginDrag(e.touches[0].clientY);
        }, { passive: true });

        el.addEventListener('touchmove', e => {
          e.preventDefault();
          _trackDrag(e.touches[0].clientY);
        }, { passive: false });

        el.addEventListener('touchend', e => {
          const totalDy = e.changedTouches[0].clientY - _dragY0;
          if (Math.abs(totalDy) < 10) {
            // Tap: toggle peek ↔ expanded
            _dragActive = false;
            panelEl.style.transition = '';
            panelEl.style.transform  = '';
            const s = _currentState();
            _applyState(s === 'expanded' || s === 'fullscreen' ? 'peek' : 'expanded');
          } else {
            _commitDrag(e.changedTouches[0].clientY);
          }
        }, { passive: true });
      }

      // Wire the drag handle, panel header, and sort row — all above the list
      _wireSwipeTarget(h);
      const panelHeader = document.getElementById('panel-header');
      const sortRow     = document.getElementById('sort-row');
      if (panelHeader) _wireSwipeTarget(panelHeader);
      if (sortRow)     _wireSwipeTarget(sortRow);

      // ── Prevent iOS browser pinch-to-zoom (but not Mapbox's) ──
      document.addEventListener('gesturestart', e => {
        if (!document.getElementById('map-container')?.contains(e.target)) e.preventDefault();
      }, { passive: false });
      document.addEventListener('gesturechange', e => {
        if (!document.getElementById('map-container')?.contains(e.target)) e.preventDefault();
      }, { passive: false });

      // ── Venue list: finger scrolling up past the venue-header zone → drag panel ──
      // When the finger crosses into the venue-header area while scrolling the list,
      // the panel starts following the finger (both up and down). Release logic:
      //   safe zone (< SAFE_DY from start) → snap back; outside → advance/retreat state.
      const venueList = document.getElementById('venue-list');
      if (venueList) {
        let _listStartY = 0, _venueHeaderBottom = 0;
        venueList.addEventListener('touchstart', e => {
          _listStartY = e.touches[0].clientY;
          // Cache header bottom once so touchmove never triggers getBoundingClientRect
          const headerEl = document.getElementById('venue-header') ?? document.getElementById('sort-row');
          _venueHeaderBottom = headerEl ? headerEl.getBoundingClientRect().bottom : 0;
        }, { passive: true });

        venueList.addEventListener('touchmove', e => {
          const cy = e.touches[0].clientY;
          if (!_dragActive) {
            // Early scroll lock: at top of list and moving up → prevent scroll rubber-banding immediately
            if (venueList.scrollTop === 0 && cy < _listStartY) {
              e.preventDefault();
              // Trigger panel drag once finger crosses into the header zone
              if (cy <= _venueHeaderBottom) {
                _dragFromList = true;
                _beginDrag(cy);
              }
            }
          }
          if (_dragActive && _dragFromList) {
            e.preventDefault();
            _trackDrag(cy);
          }
        }, { passive: false });

        venueList.addEventListener('touchend', e => {
          if (_dragActive && _dragFromList) _commitDrag(e.changedTouches[0].clientY);
        }, { passive: true });
      }
    }

    // ── Map canvas touch → collapse panel to peek ──
    // Use capture on the map container so we catch touches before Mapbox
    document.getElementById('map-container')?.addEventListener('touchstart', () => {
      if (panelEl && !panelEl.classList.contains('mobile-hidden')) {
        panelEl.classList.remove('mobile-expanded', 'mobile-fullscreen');
      }
    }, { passive: true, capture: true });

    // ── Detail panel: live-follow drag from handle OR from dp-scroll scrolling into handle ──
    // States: 'normal' (65svh) ↔ 'fullscreen' (100svh), or dismiss.
    // Safe zone: |dy| < SAFE_DY and slow → snap back. Outside: commit to next state.
    const dpHandle = document.getElementById('dp-handle');
    const dpEl     = document.getElementById('detail-panel');
    if (dpHandle && dpEl) {
      let _dpY0 = 0, _dpDragging = false, _dpStartState = 'normal', _dpStartTime = 0, _dpInitH = 0;

      function _dpCurrentState() {
        return dpEl.classList.contains('dp-fullscreen') ? 'fullscreen' : 'normal';
      }
      function _beginDpDrag(y) {
        _dpY0         = y;
        _dpDragging   = true;
        _dpStartState = _dpCurrentState();
        _dpStartTime  = Date.now();
        _dpInitH      = dpEl.offsetHeight;
        dpEl.style.transition = 'none';
      }
      function _trackDpDrag(y) {
        const dy = y - _dpY0;
        // Pure translateY — no height changes → no reflow
        dpEl.style.transform = `translateY(${dy}px)`;
      }
      function _commitDpDrag(y) {
        dpEl.style.transition = '';
        dpEl.style.transform  = '';
        dpEl.style.height     = '';
        _dpDragging = false;

        const dy       = y - _dpY0;
        const dt       = Math.max(1, Date.now() - _dpStartTime);
        const velocity = dy / dt;
        const SWIPE_V  = 0.2, SAFE_DY = 40;

        if (Math.abs(dy) <= SAFE_DY && Math.abs(velocity) < SWIPE_V) return; // safe zone

        if (velocity < -SWIPE_V || dy < -SAFE_DY) {
          if (_dpStartState === 'normal') dpEl.classList.add('dp-fullscreen');
        } else if (velocity > SWIPE_V || dy > SAFE_DY) {
          if (_dpStartState === 'fullscreen') dpEl.classList.remove('dp-fullscreen');
          else closeDetailPanel(false);
        }
      }

      // Handle drag (starts immediately on touch)
      dpHandle.addEventListener('touchstart', e => _beginDpDrag(e.touches[0].clientY), { passive: true });
      dpHandle.addEventListener('touchmove', e => {
        if (!_dpDragging) return;
        e.preventDefault();
        _trackDpDrag(e.touches[0].clientY);
      }, { passive: false });
      dpHandle.addEventListener('touchend', e => {
        if (!_dpDragging) return;
        _commitDpDrag(e.changedTouches[0].clientY);
      }, { passive: true });

      // dp-scroll drag: finger scrolling up into the handle zone triggers panel drag
      const dpScroll = document.getElementById('dp-scroll');
      if (dpScroll) {
        let _dpScrollStartY = 0, _dpHandleBottom = 0;
        dpScroll.addEventListener('touchstart', e => {
          _dpScrollStartY = e.touches[0].clientY;
          // Cache handle bottom once so touchmove never triggers getBoundingClientRect
          _dpHandleBottom = dpHandle.getBoundingClientRect().bottom;
        }, { passive: true });

        dpScroll.addEventListener('touchmove', e => {
          const cy = e.touches[0].clientY;
          if (!_dpDragging) {
            // Early scroll lock: at top of scroll and moving up → prevent rubber-banding
            if (dpScroll.scrollTop === 0 && cy < _dpScrollStartY) {
              e.preventDefault();
              if (cy <= _dpHandleBottom) _beginDpDrag(cy);
            }
          }
          if (_dpDragging) {
            e.preventDefault();
            _trackDpDrag(cy);
          }
        }, { passive: false });

        dpScroll.addEventListener('touchend', e => {
          if (_dpDragging) _commitDpDrag(e.changedTouches[0].clientY);
        }, { passive: true });
      }
    }
  }

  // Position preset buttons after layout settles, then again on resize
  setTimeout(positionPresetButtons, 80);
  new ResizeObserver(() => positionPresetButtons()).observe(document.getElementById('sun-curve') ?? document.body);

  // Push detail panel below qc-wrap when qc-panel expands/collapses
  const _qcWrapEl      = document.getElementById('qc-wrap');
  const _detailPanelEl = document.getElementById('detail-panel');
  if (_qcWrapEl && _detailPanelEl) {
    new ResizeObserver(() => {
      if (!isMobile()) {
        _detailPanelEl.style.top = (_qcWrapEl.offsetTop + _qcWrapEl.offsetHeight + 8) + 'px';
      }
    }).observe(_qcWrapEl);
  }

  // Sync qc panel height on resize
  window.addEventListener('resize', _syncQcPanelHeight);
  setTimeout(_syncQcPanelHeight, 600);

  // qc-arc drag + hover support
  const qcArcEl = document.getElementById('qc-arc');
  if (qcArcEl) {
    qcArcEl.addEventListener('mousedown', e => {
      _qcArcDragging = true;
      // Animate to clicked position; drag mousemove will cancel if user starts dragging
      const rect = qcArcEl.getBoundingClientRect();
      const t    = MIN_H_ARC + (e.clientX - rect.left - PAD_X_ARC) / (rect.width - PAD_X_ARC * 2) * (MAX_H_ARC - MIN_H_ARC);
      const hour = _clampHour(t);
      if (nowMode) {
        nowMode = false;
        nowBtn?.classList.remove('active');
        timeRangeWrap?.classList.remove('now-active');
        clearInterval(nowInterval); nowInterval = null;
      }
      setActiveIntentBtn(null);
      animateToTime(hour, 280);
    });
    qcArcEl.addEventListener('touchstart', e => { e.preventDefault(); _qcArcSetTimeFromX(e.touches[0].clientX); }, { passive: false });
    qcArcEl.addEventListener('touchmove',  e => { e.preventDefault(); _qcArcSetTimeFromX(e.touches[0].clientX); }, { passive: false });
    qcArcEl.addEventListener('mousemove',  e => {
      if (_qcArcDragging) return;
      const rect = qcArcEl.getBoundingClientRect();
      const t = MIN_H_ARC + (e.clientX - rect.left - PAD_X_ARC) / (rect.width - PAD_X_ARC * 2) * (MAX_H_ARC - MIN_H_ARC);
      arcHoverH = _clampHour(t);
      drawSunCurve(qcArcEl);
      updateQcIndicator(arcHoverH);
    });
    qcArcEl.addEventListener('mouseleave', () => { arcHoverH = null; drawSunCurve(qcArcEl); updateQcIndicator(null); });
  }

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
      arcHoverH = _clampHour(t);
      drawSunCurve(arcEl);
    });
    arcEl.addEventListener('mouseleave', () => {
      arcHoverH = null;
      drawSunCurve(arcEl);
    });
  }
  document.addEventListener('mousemove', e => {
    if (_arcDragging)    _arcSetTimeFromX(e.clientX);
    if (_qcArcDragging) _qcArcSetTimeFromX(e.clientX);
  });
  document.addEventListener('mouseup', () => { _arcDragging = false; _qcArcDragging = false; });

  // Close sort panel when clicking outside it
  document.addEventListener('click', e => {
    const btn   = document.getElementById('sort-toggle-btn');
    const panel = document.getElementById('sort-panel');
    if (panel?.classList.contains('open') && !btn?.contains(e.target) && !panel?.contains(e.target)) {
      panel.classList.remove('open');
      btn?.classList.remove('open');
    }
    // Close date calendar when clicking outside it
    const cal       = document.getElementById('date-calendar');
    const dateArea  = document.getElementById('floating-date');
    const displayBtn = document.getElementById('date-display-btn');
    if (cal?.classList.contains('open') && !dateArea?.contains(e.target)) {
      cal.classList.remove('open');
      displayBtn?.classList.remove('open');
    }
    // Close qc-panel when clicking outside it
    const qcPanel = document.getElementById('qc-panel');
    const qcWrap  = document.getElementById('qc-wrap');
    if (qcPanel?.classList.contains('open') && !qcWrap?.contains(e.target)) {
      _closeQcPanel();
    }
  });

  // Request location for distance sorting, intro centering, and live dot on map
  if (navigator.geolocation) {
    const _onGeoPos = pos => {
      const wasNull   = !userLocation;
      userLocation    = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (wasNull) {
        _introCenter   = [pos.coords.longitude, pos.coords.latitude];
        _introGeoReady = true;
        _introCheckReady();
        renderList();
      }
      _updateLocationDot();
    };
    const _onGeoErr = () => {
      if (!userLocation) { _introGeoReady = true; _introCheckReady(); }
    };
    // watchPosition keeps the dot fresh as the user moves
    navigator.geolocation.watchPosition(_onGeoPos, _onGeoErr,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  } else {
    _introGeoReady = true;
    _introCheckReady();
  }
});

function toggleMapView() {
  filterMapViewActive = !filterMapViewActive;
  document.getElementById('map-view-btn').classList.toggle('active', filterMapViewActive);
  renderList();
}

// User dragging = navigating freely → revert to viewport filter
map.on('dragstart', () => {
  _navMode = false;
});

// Track user-initiated map movement while detail panel is open, so we know
// whether to restore pre-select camera position or just reset tilt on close.
map.on('movestart', (e) => {
  if (e.originalEvent && selectedId != null) _mapMovedWhileDetailOpen = true;
});

// Re-render list on map move when viewport filter is active
map.on('moveend', () => {
  if (!filterMapViewActive) return;
  const list = document.getElementById('venue-list');
  if (list) list.dataset.noAnim = '1';
  renderList();
  requestAnimationFrame(() => { if (list) delete list.dataset.noAnim; });
});

// ── Control event listeners ───────────────────────────────────────────────────
datePicker.value = todayStr();
timeFromEl.value = Math.min(23, Math.max(4, currentHour()));

datePicker.addEventListener('change', () => { update(); });

timeFromEl.addEventListener('input', () => {
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
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
  if (e.key === 'Escape') {
    if (editingVenueId) exitEditMode();
    else if (selectedId != null) closeDetailPanel();
  }

  // Pitch controls: [ to decrease, ] to increase
  if (e.key === '[') {
    map.easeTo({ pitch: Math.max(0, map.getPitch() - 10), duration: 200 });
  }
  if (e.key === ']') {
    map.easeTo({ pitch: Math.min(85, map.getPitch() + 10), duration: 200 });
  }
});

// ── Intro sequence ────────────────────────────────────────────────────────────

function _introCheckReady() {
  if (_introMapReady && _introGeoReady && !_introRunning) {
    _introRunning = true;
    _runIntroSequence();
  }
}

function _runIntroSequence() {
  const seqId  = ++_introSeqId;
  const splash = document.getElementById('splash');
  const canvas = document.getElementById('canvas-overlay');
  const search = document.getElementById('floating-search');
  const brand  = document.getElementById('floating-brand');
  const qcWrap = document.getElementById('qc-wrap');
  const panel  = document.getElementById('panel');

  // Compute intro start time: sunrise or sunset, whichever is furthest from now
  const table   = currentSunTable ?? buildSunTable(datePicker.value);
  const sunrise = findSunCrossingFromTable(table, true)  ?? 6;
  const sunset  = findSunCrossingFromTable(table, false) ?? 21;
  const now     = currentHour();
  const introHour = Math.abs(now - sunrise) > Math.abs(now - sunset) ? sunrise : sunset;

  // Set time to intro hour and render shadows at that time
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  timeFromEl.value = Math.max(SOLAR_START, Math.min(23.9, introHour));
  update();

  // Position map at user location, cinematic settings — instant, before splash fades
  map.jumpTo({ center: _introCenter, zoom: 15, pitch: 45, bearing: 0 });

  // Enable skip after 600ms (let splash fade complete before accepting skips)
  let skipEnabled = false;
  setTimeout(() => { if (_introSeqId === seqId) skipEnabled = true; }, 600);

  const skipHandler = () => {
    if (!skipEnabled || _introSeqId !== seqId) return;
    _skipIntro(seqId);
  };
  document.addEventListener('click', skipHandler);
  document.addEventListener('touchstart', skipHandler);

  // Step 1: Fade out splash
  setTimeout(() => {
    if (_introSeqId !== seqId) return;
    splash.classList.add('hidden');

    // Step 2: Scrub time → now (1800ms) + slow zoom in to 15.3 (concurrent)
    animateToTime(Math.min(23, Math.max(4, now)), 1800);
    map.easeTo({ zoom: 15.3, pitch: 45, duration: 1800, easing: t => t * t * (3 - 2 * t) });

    // Step 3: Zoom out + detilt (starts when step 2 ends)
    setTimeout(() => {
      if (_introSeqId !== seqId) return;
      map.easeTo({ zoom: 13, pitch: 15, bearing: 0, duration: 700 });

      // Step 4: Fade in pins
      setTimeout(() => {
        if (_introSeqId !== seqId) return;
        canvas.style.transition = 'opacity 0.4s ease';
        canvas.classList.remove('intro-hidden');

        // Step 5: Fade in UI + slide up panel
        setTimeout(() => {
          if (_introSeqId !== seqId) return;
          _introRevealUI(search, brand, qcWrap, panel);
          document.removeEventListener('click', skipHandler);
          document.removeEventListener('touchstart', skipHandler);
        }, 350);
      }, 700);
    }, 1900);
  }, 80);
}

function _introRevealUI(search, brand, qcWrap, panel) {
  const locateBtn = document.getElementById('locate-btn');
  const isMobile  = window.innerWidth < 640;

  const fadeEls = [search, brand, qcWrap, locateBtn];
  if (!isMobile && panel) fadeEls.push(panel);

  fadeEls.forEach(el => {
    if (!el) return;
    el.style.transition = 'opacity 0.5s ease';
    requestAnimationFrame(() => {
      el.classList.remove('intro-hidden');
      // Restore CSS transitions after fade so subsequent animations (height, transform) still work
      setTimeout(() => { el.style.transition = ''; }, 600);
    });
  });

  if (panel && isMobile) {
    // Mobile: slide up from off-screen — translateY(100%) → natural position (peek state)
    panel.style.transition = 'none';
    panel.style.opacity    = '1';
    panel.style.transform  = 'translateY(100%)';
    panel.classList.remove('intro-hidden');
    panel.getBoundingClientRect();               // force reflow — browser commits start state
    panel.style.transition = 'transform 0.65s cubic-bezier(0.2, 0.8, 0.3, 1)';
    panel.style.transform  = '';
  }
}

function _skipIntro(seqId) {
  if (seqId !== undefined && _introSeqId !== seqId) return;
  ++_introSeqId; // invalidate all pending timeouts

  const splash = document.getElementById('splash');
  const canvas = document.getElementById('canvas-overlay');
  const search = document.getElementById('floating-search');
  const brand  = document.getElementById('floating-brand');
  const qcWrap = document.getElementById('qc-wrap');
  const panel  = document.getElementById('panel');

  // Cancel time animation
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }

  // Set time to now
  timeFromEl.value = Math.min(23, Math.max(4, currentHour()));
  update();

  // Snap map to default view (centered on user location or Oslo)
  map.stop();
  map.easeTo({ center: _introCenter, zoom: 13, pitch: 15, bearing: 0, duration: 400 });

  // Instantly hide splash
  splash.style.transition = 'none';
  splash.classList.add('hidden');

  // Instantly reveal all UI
  const locateBtnEl = document.getElementById('locate-btn');
  [canvas, search, brand, qcWrap, panel, locateBtnEl].forEach(el => {
    if (!el) return;
    el.style.transition = 'none';
    el.classList.remove('intro-hidden');
    // Allow styles to reset on next frame
    requestAnimationFrame(() => { el.style.transition = ''; });
  });
}
