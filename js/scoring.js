/**
 * scoring.js — Composite venue score (0–100).
 *
 *   total = sunScore×0.50 + comfortScore×0.35 + distanceScore×0.15
 *
 * sunScore:      discounted future sun hours, capped at 100
 * comfortScore:  feelsLike temperature comfort curve peaking at 19°C
 * distanceScore: exponential decay by km, neutral 50 when no GPS
 *
 * Depends on: solar.js (computeSunWindows), weather.js (venueWindShelter)
 */

// ── feelsLike (°C) ────────────────────────────────────────────────────────────
// Canadian wind chill for cold temps, Rothfusz heat index for hot/humid,
// smoothly blended between 15–27°C.
function feelsLike(tempC, windMs, humidity) {
  const T = tempC;
  const V = windMs * 3.6;     // m/s → km/h
  const H = humidity ?? 60;

  // Canadian wind chill
  let wc = T;
  if (V >= 1.3) {
    wc = 13.12 + 0.6215 * T
       - 11.37  * Math.pow(V, 0.16)
       + 0.3965 * T * Math.pow(V, 0.16);
  }

  // Rothfusz heat index (°C adapted via °F)
  let hi = T;
  if (T >= 27) {
    const F   = T * 9 / 5 + 32;
    const hiF = -42.379
      + 2.04901523  * F
      + 10.14333127 * H
      - 0.22475541  * F * H
      - 0.00683783  * F * F
      - 0.05481717  * H * H
      + 0.00122874  * F * F * H
      + 0.00085282  * F * H * H
      - 0.00000199  * F * F * H * H;
    hi = (hiF - 32) * 5 / 9;
  }

  if (T <= 15) return wc;
  if (T >= 27) return hi;
  // Smooth blend for 15–27°C: wind still cools but heat index not yet dominant
  const blend = (T - 15) / (27 - 15);
  return wc * (1 - blend) + hi * blend;
}

// ── comfortScore (0–100) ──────────────────────────────────────────────────────
// Comfort peaks at 19°C feels-like. Colder side has width 13, warmer side 20,
// so a bit of warmth is tolerated more than cold (people dress for cold, not heat).
function comfortScore(tempC, windMs, shelter, humidity) {
  const effWind = windMs * (1 - (shelter ?? 0.5));
  const fl      = feelsLike(tempC, effWind, humidity);
  const PEAK    = 19;
  const width   = fl < PEAK ? 13 : 20;
  return Math.max(0, 100 * (1 - Math.pow((fl - PEAK) / width, 2)));
}

// ── sunScore (0–100) ──────────────────────────────────────────────────────────
// Sum of discounted upcoming sun windows (within open hours):
//   Σ duration × exp(−waitHours × 0.5)
// Immediate sun worth most; sun an hour away worth ~60%; 3h away ~22%.
// Scaled ×33 so ~3 hours of immediate sun ≈ 100.
function sunScore(v, dateStr, fromHour) {
  const { windows, open, close } = computeSunWindows(v, dateStr);
  let score = 0;
  for (const w of windows) {
    const start    = Math.max(w.start, fromHour, open);
    const end      = Math.min(w.end, close);
    if (end <= start) continue;
    const wait     = Math.max(0, start - fromHour);
    const duration = end - start;
    score += duration * Math.exp(-wait * 0.5);
  }
  return Math.min(100, score * 33);
}

// ── distanceScore (0–100) ─────────────────────────────────────────────────────
// Exponential decay: 300m ≈ 85, 2km ≈ 33, 5km ≈ 6.
// Returns 50 (neutral) when no GPS fix.
function distanceScore(v, userLoc) {
  if (!userLoc) return 50;
  const R    = 6371;
  const dLat = (v.lat - userLoc.lat) * Math.PI / 180;
  const dLng = (v.lng - userLoc.lng) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(userLoc.lat * Math.PI / 180)
             * Math.cos(v.lat * Math.PI / 180)
             * Math.sin(dLng / 2) ** 2;
  const km   = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 100 * Math.exp(-km / 1.8);
}

// ── computeVenueScore ─────────────────────────────────────────────────────────
// ── noiseScore (0–100) ────────────────────────────────────────────────────────
// Converts OSM highway proximity estimate to a 0–100 score.
function noiseScore(v) {
  if (v.noiseScore != null) return Math.round(100 * Math.max(0, 1 - v.noiseScore * 1.3));
  return 50; // neutral when no data
}

/**
 * Compute the composite score for a venue at a given time.
 * Weights: sun×0.45  comfort×0.30  distance×0.15  noise×0.10
 * @param {Object}  v        — venue (needs .facing, .lat, .lng, .noiseScore?)
 * @param {string}  dateStr  — "YYYY-MM-DD"
 * @param {number}  hour     — float hours (e.g. 14.5 = 14:30)
 * @param {Object}  wx       — WeatherSlot from getWeatherAt(), or null
 * @param {Object}  userLoc  — {lat, lng} or null
 * @returns {{ total, sun, comfort, distance, noise, feelsLikeTemp, shelter }}
 */
function computeVenueScore(v, dateStr, hour, wx, userLoc) {
  const sun     = sunScore(v, dateStr, hour);
  const shelter = wx ? venueWindShelter(v.facing, wx.wdir) : 0.5;
  const comfort = wx
    ? comfortScore(wx.temp, wx.wspd, shelter, wx.humidity)
    : 50;
  const dist    = distanceScore(v, userLoc);
  const noise   = noiseScore(v);
  const total   = Math.round(sun * 0.45 + comfort * 0.30 + dist * 0.15 + noise * 0.10);
  const fl      = wx
    ? feelsLike(wx.temp, wx.wspd * (1 - shelter), wx.humidity)
    : null;

  // Raw distance in km for display (null when no GPS)
  let distKm = null;
  if (userLoc) {
    const R    = 6371;
    const dLat = (v.lat - userLoc.lat) * Math.PI / 180;
    const dLng = (v.lng - userLoc.lng) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(userLoc.lat * Math.PI / 180)
               * Math.cos(v.lat * Math.PI / 180)
               * Math.sin(dLng / 2) ** 2;
    distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  return {
    total,
    sun:          Math.round(sun),
    comfort:      Math.round(comfort),
    distance:     Math.round(dist),
    noise:        Math.round(noise),
    distKm,
    feelsLikeTemp: fl != null ? Math.round(fl) : null,
    shelter,
  };
}
