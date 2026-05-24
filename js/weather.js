/**
 * weather.js — MET Norway Locationforecast 2.0 integration.
 *
 * Free public API (no key required), CORS-enabled, Oslo-native accuracy.
 * Data is cached for 30 min; auto-refreshes in background.
 *
 * Exports (globals):
 *   initWeather()                        — fetch / refresh forecast
 *   getWeatherAt(dateStr, hour)          — WeatherSlot | null
 *   venueWindShelter(facing, windFrom)   — 0 (exposed) → 1 (sheltered)
 *   windCardinal(deg)                    — "N" | "NE" | … | "NW"
 *   skyIcon(cloudFraction)               — ☀ / 🌤 / ⛅ / 🌥 / ☁
 *   skyLabel(cloudFraction)              — "Clear" | "Partly cloudy" | …
 *
 * WeatherSlot: { temp, cloud, cloudLow, cloudMid, cloudHigh, sunBlock,
 *                symbol, wspd, wdir, precip, humidity }
 *   temp      — °C (integer)
 *   cloud     — 0–1 fraction, total cloud area
 *   cloudLow  — 0–1 fraction, low cloud layer (null if unavailable)
 *   cloudMid  — 0–1 fraction, mid cloud layer (null if unavailable)
 *   cloudHigh — 0–1 fraction, high cloud layer (null if unavailable)
 *   sunBlock  — 0–1 layer-weighted "blocks the sun" fraction. Use this
 *               (not raw cloud) for any "is it sunny right now" gate —
 *               thin high cirrus barely blocks; low stratus blocks fully.
 *   symbol    — MET symbol code, e.g. "fair_day", "partlycloudy_day"
 *   wspd      — m/s (float)
 *   wdir      — degrees the wind is coming FROM (0 = N, 90 = E, …)
 *   precip    — mm in next 1 h
 */

// Internal storage: Map<"YYYY-MM-DD-H", WeatherSlot>
let _wxData     = new Map();
let _wxExpiry   = 0;
let _wxFetching = false;

async function initWeather(lat = 59.9125, lng = 10.728) {
  if (_wxFetching || Date.now() < _wxExpiry) return;
  _wxFetching = true;
  try {
    // /complete (not /compact) carries cloud_area_fraction_{low,medium,high}
    // and fog_area_fraction, which sunBlock depends on. /compact returns only
    // the total cloud_area_fraction, so the layer-aware sun assessment would
    // silently fall back to raw total cloud.
    // No custom headers: User-Agent is a forbidden request-header in
    // browsers (silently stripped), and setting it can trigger a CORS
    // preflight on some engines (iOS Chrome WebView has been seen
    // failing the OPTIONS check). met.no accepts unauthenticated
    // browser requests with the browser's own UA.
    const res = await fetch(
      `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const data = new Map();
    for (const ts of json.properties.timeseries) {
      // Use local clock so keys match datePicker values + timeFromEl hours
      const d   = new Date(ts.time);
      const pad = n => String(n).padStart(2, '0');
      const key = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${d.getHours()}`;
      const det = ts.data.instant.details;
      const cloud    = (det.cloud_area_fraction        ?? 0) / 100;
      // Low / medium / high cloud layers (MET provides all three on hourly slots).
      // High cirrus blocks little sun; low stratus/cumulus blocks most. Combine
      // into a "sunBlock" coefficient that better matches what people experience
      // as "sunny" — a 70% high-cirrus day still feels sunny on a terrace, while
      // a 60% low-cloud day does not.
      const cLow     = (det.cloud_area_fraction_low    ?? -1) / 100;
      const cMid     = (det.cloud_area_fraction_medium ?? -1) / 100;
      const cHigh    = (det.cloud_area_fraction_high   ?? -1) / 100;
      const hasLayers = cLow >= 0 && cMid >= 0 && cHigh >= 0;
      const sunBlock = hasLayers
        ? Math.min(1, cLow * 1.0 + cMid * 0.55 + cHigh * 0.18)
        : cloud;  // fallback for forecast slots that omit layer breakdown
      // Symbol code (e.g. "fair_day", "partlycloudy_day") from the next-N-hours
      // summary block. Useful when raw cloud values disagree with the human
      // reading; MET's symbol already accounts for layer thickness.
      const symbol = ts.data.next_1_hours?.summary?.symbol_code
                  ?? ts.data.next_6_hours?.summary?.symbol_code
                  ?? null;
      data.set(key, {
        temp:     Math.round(det.air_temperature),
        cloud,
        cloudLow:  cLow >= 0 ? cLow  : null,
        cloudMid:  cMid >= 0 ? cMid  : null,
        cloudHigh: cHigh >= 0 ? cHigh : null,
        sunBlock,
        symbol,
        wspd:     det.wind_speed,
        wdir:     det.wind_from_direction,
        precip:   ts.data.next_1_hours?.details?.precipitation_amount ?? 0,
        humidity: det.relative_humidity ?? 60,
      });
    }

    _wxData   = data;
    _wxExpiry = Date.now() + 30 * 60 * 1000;
    console.info('[weather] loaded', data.size, 'hourly slots');

    // Re-render once data arrives (update() is defined in app.js)
    if (typeof update === 'function') update();
    if (typeof _notifEvaluate === 'function') _notifEvaluate();

    // Defensive: explicitly refresh every surface that reads weather.
    // update() drives all of these via syncFts() etc., but on first
    // load there's a race where the initial update() ran before
    // weather and update()-triggered syncFts may not repopulate the
    // FTS popup body (compact state stays clear of weather icon /
    // temp / wind). Calling the surfaces directly here makes the
    // first-render-with-weather deterministic.
    try {
      const h = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : null;
      if (h != null && Number.isFinite(h)) {
        if (typeof updateHeaderWxChip === 'function') updateHeaderWxChip(h);
        if (typeof showFtsPopup === 'function' && document.body.classList.contains('fts')) showFtsPopup(h);
      }
      if (typeof updateDateWeatherStrip === 'function') updateDateWeatherStrip();
      if (typeof updateSunSectionBar === 'function') updateSunSectionBar();
      if (typeof renderDateCalendar === 'function') renderDateCalendar();
    } catch (e) { console.warn('[weather] post-load refresh error:', e.message); }

    // Notify any listeners outside the well-known set (no-op if none).
    window.dispatchEvent(new CustomEvent('weather-ready', { detail: { size: data.size } }));
  } catch (err) {
    console.warn('Weather fetch failed:', err.message);
  } finally {
    _wxFetching = false;
  }
}

/**
 * Return the exact integer hours that have weather data for a given date.
 * Used to determine data resolution (hourly → many entries, 6-hourly → few entries).
 * E.g. [0,1,2,...,23] for a near-term day, [0,6,12,18] for a day 3+ days out.
 */
function getWeatherHoursForDate(dateStr) {
  const pad = n => String(n).padStart(2, '0');
  const d   = new Date(dateStr + 'T12:00:00');
  const base = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const hours = [];
  for (let h = 0; h <= 23; h++) {
    if (_wxData.has(`${base}-${h}`)) hours.push(h);
  }
  return hours;
}

/**
 * Return weather for a given local date string ("YYYY-MM-DD") and hour (float).
 * Rounds to the nearest integer hour. Returns null when data is unavailable.
 */
// Synthetic clear-sky slot used when the admin is auditing polygons —
// every venue should render as if weather is perfect so the polygon's
// solar behaviour is judged on its own, not punished by cloud/rain.
const _AUDIT_CLEAR_WEATHER = Object.freeze({
  temp: 22, cloud: 0, precip: 0, wspd: 1.5, wdir: 180,
  humidity: 50, sym: 'clearsky_day',
});

function getWeatherAt(dateStr, hour) {
  if (typeof auditModeActive !== 'undefined' && auditModeActive) {
    return _AUDIT_CLEAR_WEATHER;
  }
  const h   = Math.round(hour);
  const pad = n => String(n).padStart(2, '0');
  const d   = new Date(dateStr + 'T12:00:00');
  const base = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const exact = _wxData.get(`${base}-${h}`);
  if (exact) return exact;
  // Fallback: nearest available slot for this date (API switches to 6-hourly for days 3+)
  let best = null, bestDist = Infinity;
  for (let i = 0; i <= 23; i++) {
    const slot = _wxData.get(`${base}-${i}`);
    if (slot) {
      const dist = Math.abs(i - h);
      if (dist < bestDist) { bestDist = dist; best = slot; }
    }
  }
  return best;
}

/**
 * Shelter factor from wind for a terrace.
 *
 * v.facing = direction the terrace faces outward (e.g. 180° = faces south).
 * windFrom = direction the wind is coming FROM (met. convention).
 *
 * Logic:
 *   diff ≈ 0°   → wind blows from the same direction the terrace faces → exposed
 *   diff ≈ 180° → building stands between wind and terrace → sheltered
 *
 * Returns 0 (fully exposed) → 1 (fully sheltered).
 */
function venueWindShelter(facing, windFrom) {
  if (windFrom == null || facing == null) return 0.5;
  const diff = Math.abs(((facing - windFrom + 540) % 360) - 180);
  return diff / 180;
}

/** 8-point cardinal direction label for a bearing. */
function windCardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Sky condition emoji from sun-blocking fraction (0–1). */
function skyIcon(cf) {
  if (cf < 0.15) return '☀\uFE0F';
  if (cf < 0.40) return '🌤️';
  if (cf < 0.65) return '⛅';
  if (cf < 0.85) return '🌥️';
  return '☁\uFE0F';
}

/** Sky condition as inline SVG — genuine Lucide weather glyphs (outline,
 *  24x24, stroke-width 2.5, round caps). Rendered cream with a dark
 *  legibility casing via the .wx-sky-icon CSS rule so the thin strokes stay
 *  legible over the map / FTS (any background). The 5 sky buckets map onto
 *  4 distinct Lucide marks (sun · cloud-sun · cloudy · cloud); rain = cloud-rain.
 *
 *  TIMELINE_EVENT_GLYPHS in ui-plan-preview.js delegates to these names
 *  (sun → _wxSvgSun, partly → _wxSvgSunCloud, cloud → _wxSvgCloud,
 *  rain → _wxSvgRain), so all six names stay defined. */
function _wxSvg(inner) {
  return `<svg class="wx-sky-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function skyIconSvg(cf) {
  if (cf < 0.15) return _wxSvgSun();
  if (cf < 0.40) return _wxSvgSunSmallCloud();
  if (cf < 0.65) return _wxSvgSunCloud();
  if (cf < 0.85) return _wxSvgCloudSun();
  return _wxSvgCloud();
}

/** Rain icon as inline SVG. Same currentColor + casing contract. */
function rainIconSvg() { return _wxSvgRain(); }

// sun
function _wxSvgSun() {
  return _wxSvg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>');
}
// mostly-sunny + partly both read as cloud-sun
function _wxSvgSunSmallCloud() { return _wxSvgSunCloud(); }
function _wxSvgSunCloud() {
  return _wxSvg('<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>');
}
// mostly cloudy → cloudy (two clouds)
function _wxSvgCloudSun() {
  return _wxSvg('<path d="M17.5 12a1 1 0 1 1 0 9H9.006a7 7 0 1 1 6.702-9z"/><path d="M21.832 9A3 3 0 0 0 19 7h-2.207a5.5 5.5 0 0 0-10.72.61"/>');
}
// overcast → cloud
function _wxSvgCloud() {
  return _wxSvg('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>');
}
// rain → cloud-rain
function _wxSvgRain() {
  return _wxSvg('<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>');
}

/** Short sky condition label. */
function skyLabel(cf) {
  if (cf < 0.15) return 'Clear';
  if (cf < 0.40) return 'Few clouds';
  if (cf < 0.65) return 'Partly cloudy';
  if (cf < 0.85) return 'Mostly cloudy';
  return 'Overcast';
}

/**
 * Aggregate daytime weather for a date → icon, peakTemp, sun-blocking
 * fractions (layer-aware). Scans hours 8..18 so an overcast night doesn't
 * push the average toward "cloudy" on an otherwise sunny day. Returns:
 *   avgCloud     — raw total cloud average (back-compat)
 *   avgSunBlock  — layer-weighted average (drives the icon)
 *   minSunBlock  — sunniest hour of the day. Use this for "does this day
 *                  contain any sun-touched window?" classification —
 *                  averaging hides one good hour between cloudy ones.
 */
function getDayWeatherSummary(dateStr) {
  const pad = n => String(n).padStart(2, '0');
  const d   = new Date(dateStr + 'T12:00:00');
  const base = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  let slots = [];
  for (let h = 8; h <= 18; h++) {
    const w = _wxData.get(`${base}-${h}`);
    if (w) slots.push(w);
  }
  // 6-hourly forecast slots (days 3+) often miss the 8–18 band. Fall back
  // to scanning the full day rather than reporting null.
  if (!slots.length) {
    for (let h = 0; h <= 23; h++) {
      const w = _wxData.get(`${base}-${h}`);
      if (w) slots.push(w);
    }
  }
  if (!slots.length) return null;
  const avgCloud    = slots.reduce((s, w) => s + (w.cloud    ?? 0), 0) / slots.length;
  const sbValues    = slots.map(w => w.sunBlock ?? w.cloud ?? 0);
  const avgSunBlock = sbValues.reduce((s, v) => s + v, 0) / sbValues.length;
  const minSunBlock = Math.min(...sbValues);
  const peakTemp    = Math.max(...slots.map(w => w.temp));
  const totPrecip   = slots.reduce((s, w) => s + w.precip, 0);
  return { avgCloud, avgSunBlock, minSunBlock, peakTemp, totPrecip, icon: skyIcon(avgSunBlock) };
}

// Auto-refresh every 30 min
setInterval(initWeather, 30 * 60 * 1000);
