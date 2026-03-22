/**
 * busyness.js — Venue busyness estimates and display.
 *
 * Architecture note:
 *   The public surface is getBusynessForDay(venue, dateStr) → Float32Array[24]
 *   where each index is an hour (0–23) and the value is 0–100.
 *
 *   Currently backed by a category-based heuristic model.
 *   To connect live/static Google Places data later, replace the
 *   _heuristicProfile() call in getBusynessForDay() with a lookup
 *   into venue.popularTimes[dayOfWeek] (pre-fetched JSON) or a
 *   Places API response — the rest of the code stays unchanged.
 */

// ── Heuristic profiles by category ───────────────────────────────────────────
// Each profile is a 24-element array (hour 0–23), value 0–100.
// Represents a "typical weekday". Weekend modifier applied separately.

const _PROFILES = {
  café: [
     0, 0, 0, 0, 0, 0,  5, 25, 55, 75, 80, 70,
    55, 60, 65, 50, 35, 20, 15, 10,  5,  0,  0,  0,
  ],
  restaurant: [
     0, 0, 0, 0, 0, 0,  0,  5, 10, 15, 30, 65,
    85, 70, 45, 25, 20, 40, 80, 90, 75, 50, 25, 10,
  ],
  bistro_bar: [
     0, 0, 0, 0, 0, 0,  0,  5, 10, 15, 35, 65,
    80, 65, 45, 30, 35, 55, 75, 85, 80, 60, 35, 15,
  ],
  bar: [
     0, 0, 0, 0, 0, 0,  0,  0,  5, 10, 15, 25,
    30, 25, 20, 20, 30, 50, 70, 85, 90, 85, 65, 35,
  ],
  cocktail_bar: [
     0, 0, 0, 0, 0, 0,  0,  0,  0,  0,  5, 10,
    15, 10,  5, 10, 20, 40, 65, 80, 90, 85, 70, 45,
  ],
  pub: [
     0, 0, 0, 0, 0, 0,  0,  5, 10, 15, 25, 45,
    60, 55, 45, 40, 50, 65, 75, 80, 75, 60, 40, 20,
  ],
  rooftop_bar: [
     0, 0, 0, 0, 0, 0,  0,  0,  0,  5, 10, 20,
    25, 20, 15, 20, 35, 60, 80, 90, 85, 70, 50, 25,
  ],
  brasserie: [
     0, 0, 0, 0, 0, 0,  0,  5, 10, 20, 40, 70,
    85, 70, 50, 35, 30, 50, 80, 90, 80, 55, 30, 10,
  ],
  fine_dining: [
     0, 0, 0, 0, 0, 0,  0,  0,  5, 10, 20, 45,
    75, 80, 65, 40, 25, 35, 65, 85, 90, 75, 45, 15,
  ],
  gastropub: [
     0, 0, 0, 0, 0, 0,  0,  5, 10, 15, 25, 50,
    70, 65, 50, 40, 45, 60, 75, 85, 80, 65, 40, 20,
  ],
};

// Fallback for unknown categories
const _DEFAULT_PROFILE = _PROFILES.restaurant;

// Weekend multiplier per hour (Sat/Sun skew later, generally busier)
const _WEEKEND_BOOST = [
  1.0, 1.0, 1.0, 1.0, 1.0, 1.0,  1.0, 0.8, 0.7, 0.8, 0.9, 1.0,
  1.1, 1.1, 1.2, 1.2, 1.2, 1.2,  1.2, 1.2, 1.3, 1.3, 1.2, 1.1,
];

/**
 * Returns a 24-element Float32Array of estimated busyness (0–100)
 * for the given venue and date.
 *
 * SWAP POINT: replace the heuristic below with real data when available:
 *   if (venue.popularTimes) return _fromPopularTimes(venue.popularTimes, dayOfWeek);
 */
function getBusynessForDay(venue, dateStr) {
  // ── Real data hook (uncomment when popularTimes field is populated) ──────
  // if (venue.popularTimes) return _fromPopularTimes(venue.popularTimes, dateStr);
  // if (venue.googlePlaceId) return _fromPlacesCache(venue.googlePlaceId, dateStr);

  return _heuristicProfile(venue, dateStr);
}

// ── Current busyness (single value) ──────────────────────────────────────────
function getBusynessAt(venue, dateStr, hour) {
  const profile = getBusynessForDay(venue, dateStr);
  const h = Math.floor(hour);
  const frac = hour - h;
  const a = profile[Math.max(0, Math.min(23, h))] ?? 0;
  const b = profile[Math.max(0, Math.min(23, h + 1))] ?? 0;
  return a + (b - a) * frac;
}

// ── Heuristic implementation ──────────────────────────────────────────────────
function _heuristicProfile(venue, dateStr) {
  const base = _PROFILES[venue.category] ?? _DEFAULT_PROFILE;
  const dow  = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun, 6=Sat
  const isWeekend = dow === 0 || dow === 6;

  const out = new Float32Array(24);
  for (let h = 0; h < 24; h++) {
    let v = base[h];
    if (isWeekend) v = Math.min(100, v * _WEEKEND_BOOST[h]);
    // Zero out outside opening hours
    const { open, close } = venue.openingHours;
    if (h < Math.floor(open) || h >= Math.ceil(close)) v = 0;
    out[h] = v;
  }
  return out;
}

// ── Real-data adapters (stubs for future implementation) ─────────────────────

// function _fromPopularTimes(popularTimes, dateStr) {
//   // venue.popularTimes = { "1": [...24 values], ..., "7": [...] }
//   // Day key: 1=Mon … 7=Sun (matching Google's convention)
//   const dow = new Date(dateStr + 'T12:00:00').getDay();
//   const key = String(dow === 0 ? 7 : dow);
//   const arr = popularTimes[key] ?? new Array(24).fill(0);
//   return new Float32Array(arr);
// }

// ── Busyness label ────────────────────────────────────────────────────────────
function busynessLabel(value) {
  if (value >= 80) return 'Very busy';
  if (value >= 60) return 'Busy';
  if (value >= 40) return 'Moderately busy';
  if (value >= 20) return 'Not too busy';
  return 'Quiet';
}
