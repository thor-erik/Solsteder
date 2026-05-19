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

/** Sky condition as inline SVG. Restored the 5-variant top-bar glyph set
 *  (Sun · SunSmallCloud · SunCloud · CloudSun · Cloud) — user reverted
 *  the timeline-style 3-variant unification. Sun + cloud silhouettes are
 *  now currentColor so the .wx-sky-icon CSS rule renders them white with
 *  the same drop-shadow backdrop the timeline glyphs use.
 *
 *  TIMELINE_EVENT_GLYPHS in ui-plan-preview.js delegates to these shapes
 *  (sun → _wxSvgSun, partly → _wxSvgSunCloud, cloud → _wxSvgCloud,
 *  rain → _wxSvgRain) so the FTS popup / thumb / panel timelines now
 *  show the same detailed silhouettes the top bar uses. */
function skyIconSvg(cf) {
  if (cf < 0.15) return _wxSvgSun();
  if (cf < 0.40) return _wxSvgSunSmallCloud();
  if (cf < 0.65) return _wxSvgSunCloud();
  if (cf < 0.85) return _wxSvgCloudSun();
  return _wxSvgCloud();
}

/** Rain icon as inline SVG. Same currentColor + drop-shadow contract. */
function rainIconSvg() { return _wxSvgRain(); }

function _wxSvgSun() {
  return `<svg class="wx-sky-icon" viewBox="0 0 16 16" aria-hidden="true">`
    + `<circle cx="8" cy="8" r="3" fill="currentColor"/>`
    + `<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">`
    + `<line x1="8" y1="1.5" x2="8" y2="2.8"/>`
    + `<line x1="8" y1="13.2" x2="8" y2="14.5"/>`
    + `<line x1="1.5" y1="8" x2="2.8" y2="8"/>`
    + `<line x1="13.2" y1="8" x2="14.5" y2="8"/>`
    + `<line x1="3.3" y1="3.3" x2="4.2" y2="4.2"/>`
    + `<line x1="11.8" y1="11.8" x2="12.7" y2="12.7"/>`
    + `<line x1="3.3" y1="12.7" x2="4.2" y2="11.8"/>`
    + `<line x1="11.8" y1="4.2" x2="12.7" y2="3.3"/>`
    + `</g></svg>`;
}

function _wxSvgSunSmallCloud() {
  return `<svg class="wx-sky-icon" viewBox="0 0 16 16" aria-hidden="true">`
    + `<circle cx="6" cy="6" r="2.5" fill="currentColor"/>`
    + `<g stroke="currentColor" stroke-width="1.1" stroke-linecap="round">`
    + `<line x1="6" y1="1.2" x2="6" y2="2.2"/>`
    + `<line x1="1.2" y1="6" x2="2.2" y2="6"/>`
    + `<line x1="2.6" y1="2.6" x2="3.2" y2="3.2"/>`
    + `</g>`
    + `<path d="M7.2 13.5 Q5.5 13.5 5.5 12 Q5.5 10.6 7 10.6 Q7.4 9 9.2 9 Q11 9 11.4 10.6 Q13 10.6 13 12 Q13 13.5 11.4 13.5 Z" fill="currentColor"/>`
    + `</svg>`;
}

function _wxSvgSunCloud() {
  return `<svg class="wx-sky-icon" viewBox="0 0 16 16" aria-hidden="true">`
    + `<circle cx="5.2" cy="5.2" r="2.4" fill="currentColor"/>`
    + `<g stroke="currentColor" stroke-width="1" stroke-linecap="round">`
    + `<line x1="5.2" y1="0.8" x2="5.2" y2="1.7"/>`
    + `<line x1="0.8" y1="5.2" x2="1.7" y2="5.2"/>`
    + `<line x1="2" y1="2" x2="2.6" y2="2.6"/>`
    + `</g>`
    + `<path d="M5 13.6 Q3 13.6 3 12 Q3 10.4 4.7 10.4 Q5.2 8.4 7.7 8.4 Q10.3 8.4 10.8 10.4 Q12.6 10.4 12.6 12 Q12.6 13.6 10.8 13.6 Z" fill="currentColor"/>`
    + `</svg>`;
}

function _wxSvgCloudSun() {
  return `<svg class="wx-sky-icon" viewBox="0 0 16 16" aria-hidden="true">`
    + `<circle cx="3.8" cy="4.4" r="1.6" fill="currentColor"/>`
    + `<path d="M3.5 12.6 Q1.5 12.6 1.5 11 Q1.5 9.3 3.4 9.3 Q3.9 7.2 6.6 7.2 Q9.4 7.2 9.9 9.3 Q11.8 9.3 11.8 11 Q11.8 12.6 9.9 12.6 Z" fill="currentColor"/>`
    + `</svg>`;
}

function _wxSvgCloud() {
  return `<svg class="wx-sky-icon" viewBox="0 0 16 16" aria-hidden="true">`
    + `<path d="M3.8 12 Q1.6 12 1.6 10.2 Q1.6 8.4 3.6 8.4 Q4.2 5.8 7.7 5.8 Q11.3 5.8 11.8 8.4 Q13.8 8.4 13.8 10.2 Q13.8 12 11.8 12 Z" fill="currentColor"/>`
    + `</svg>`;
}

function _wxSvgRain() {
  return `<svg class="wx-sky-icon" viewBox="0 0 16 16" aria-hidden="true">`
    + `<path d="M3.5 9.5 Q1.7 9.5 1.7 8 Q1.7 6.5 3.6 6.5 Q4 4.5 7 4.5 Q10 4.5 10.5 6.5 Q12.3 6.5 12.3 8 Q12.3 9.5 10.5 9.5 Z" fill="currentColor"/>`
    + `<g fill="currentColor">`
    + `<ellipse cx="4.6" cy="12.3" rx="0.7" ry="1.4"/>`
    + `<ellipse cx="7" cy="13" rx="0.7" ry="1.4"/>`
    + `<ellipse cx="9.4" cy="12.3" rx="0.7" ry="1.4"/>`
    + `</g></svg>`;
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
