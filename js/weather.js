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
 * WeatherSlot: { temp, cloud, wspd, wdir, precip }
 *   temp   — °C (integer)
 *   cloud  — 0–1 fraction
 *   wspd   — m/s (float)
 *   wdir   — degrees the wind is coming FROM (0 = N, 90 = E, …)
 *   precip — mm in next 1 h
 */

// Internal storage: Map<"YYYY-MM-DD-H", WeatherSlot>
let _wxData     = new Map();
let _wxExpiry   = 0;
let _wxFetching = false;

async function initWeather(lat = 59.9125, lng = 10.728) {
  if (_wxFetching || Date.now() < _wxExpiry) return;
  _wxFetching = true;
  try {
    const res = await fetch(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`,
      { headers: { 'User-Agent': 'Solsteder/1.0 (solsteder.app)' } }
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
      data.set(key, {
        temp:     Math.round(det.air_temperature),
        cloud:    det.cloud_area_fraction / 100,
        wspd:     det.wind_speed,
        wdir:     det.wind_from_direction,
        precip:   ts.data.next_1_hours?.details?.precipitation_amount ?? 0,
        humidity: det.relative_humidity ?? 60,
      });
    }

    _wxData   = data;
    _wxExpiry = Date.now() + 30 * 60 * 1000;

    // Re-render once data arrives (update() is defined in app.js)
    if (typeof update === 'function') update();
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
function getWeatherAt(dateStr, hour) {
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

/** Sky condition emoji from cloud fraction (0–1). */
function skyIcon(cf) {
  if (cf < 0.15) return '☀\uFE0F';
  if (cf < 0.40) return '🌤';
  if (cf < 0.65) return '⛅';
  if (cf < 0.85) return '🌥';
  return '☁\uFE0F';
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
 * Aggregate daytime weather for a date → icon, peakTemp, avgCloud.
 * Samples hours 8, 10, 12, 14, 16. Returns null if no forecast data.
 */
function getDayWeatherSummary(dateStr) {
  // Scan all 24 hours to handle both hourly and 6-hourly forecast intervals
  const pad = n => String(n).padStart(2, '0');
  const d   = new Date(dateStr + 'T12:00:00');
  const base = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const slots = [];
  for (let h = 0; h <= 23; h++) {
    const w = _wxData.get(`${base}-${h}`);
    if (w) slots.push(w);
  }
  if (!slots.length) return null;
  const avgCloud  = slots.reduce((s, w) => s + w.cloud, 0) / slots.length;
  const peakTemp  = Math.max(...slots.map(w => w.temp));
  const totPrecip = slots.reduce((s, w) => s + w.precip, 0);
  return { avgCloud, peakTemp, totPrecip, icon: skyIcon(avgCloud) };
}

// Auto-refresh every 30 min
setInterval(initWeather, 30 * 60 * 1000);
