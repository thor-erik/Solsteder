/**
 * ui-shared.js — Shared UI helpers used across list and detail panel.
 * No side effects: only function declarations.
 * Loaded before all other ui-*.js files.
 * Depends on: computeSunWindows (app.js), getWeatherAt (weather.js)
 */

// ── Venue state model (Task 2) ─────────────────────────────────────────────────
/**
 * Computes a venue's state at the currently selected time.
 * One of: 'sun' (in sun now), 'shadow' (no sun now, but sun later), 'done' (no more sun today).
 * Returns { state, mainText, subText, className }.
 * Duration format: '3t 10m', '1t 45m', '15 min', '5 min'.
 */
function venueState(venue, selectedTime) {
  const dateStr = datePicker?.value || todayStr?.() || '';
  const fromHour = selectedTime ?? 0;

  const { windows } = computeSunWindows(venue, dateStr);
  if (!windows.length) return { state: 'done', mainText: 'Ferdig', subText: '', className: 'state-done' };

  const currentWindow = windows.find(w => fromHour >= w.start && fromHour < w.end);
  const nextWindow = windows.find(w => w.start > fromHour);
  const lastWindow = windows[windows.length - 1];

  // Debug: log first few venues + problematic venues (130=Michaels, 219=Stranden 30)
  if (venue.id <= 3 || venue.id === 130 || venue.id === 219) {
    console.debug(`[venueState] ${venue.name} (ID ${venue.id}) at ${fromHour.toFixed(2)}: windows=${windows.map(w => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(',')}, currentWindow=${currentWindow ? `[${currentWindow.start.toFixed(2)}-${currentWindow.end.toFixed(2)}]` : 'none'}, nextWindow=${nextWindow ? `[${nextWindow.start.toFixed(2)}-${nextWindow.end.toFixed(2)}]` : 'none'}`);
  }

  // Format duration as 3t 10m, 1t 45m, 15 min, 5 min
  const formatDuration = (hours) => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h > 0 && m > 0) return `${h}t ${m}m`;
    if (h > 0) return `${h}t`;
    if (m > 0) return `${m} min`;
    return '5 min'; // Minimum show 5 min for windows < 5 min
  };

  // Weather check: rain or heavy overcast overrides sun geometry
  const wx = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const isRainy    = (wx?.precip ?? 0) > 0.3;
  const isOvercast = !isRainy && (wx?.cloud ?? 0) >= 0.85;

  if (isRainy || isOvercast) {
    const mainText = isRainy ? t('state_rain_now') : t('state_overcast');
    // Check if any sun window starts after now (geometry-wise)
    const futureSun = windows.find(w => w.start > fromHour);
    if (futureSun) {
      return { state: 'rain', mainText, subText: t('state_sun_from', { time: formatHour(futureSun.start) }), className: 'state-rain' };
    }
    // Currently in a sun window but rain overrides, or all sun passed
    const remaining = windows.find(w => w.end > fromHour);
    if (remaining) {
      return { state: 'rain', mainText, subText: t('state_sun_to', { time: formatHour(remaining.end) }), className: 'state-rain' };
    }
    return { state: 'rain', mainText, subText: t('state_no_sun_today'), className: 'state-rain' };
  }

  if (currentWindow) {
    // In sun now — primary: end time, secondary: remaining duration
    const remaining = Math.max(5/60, currentWindow.end - fromHour);
    const mainText = t('state_sun_until_big', { time: formatHour(currentWindow.end) });
    const subText = t('state_time_left', { duration: formatDuration(remaining) });
    return { state: 'sun', mainText, subText, className: 'state-sun' };
  }

  if (nextWindow) {
    // Check if we're in an architectural shadow gap (between two sun windows)
    const prevWindow = [...windows].reverse().find(w => w.end <= fromHour);
    if (prevWindow) {
      // Between windows — building shadow interrupted sun
      const mainText = t('state_in_shadow');
      const subText = t('state_sun_again', { time: formatHour(nextWindow.start) });
      return { state: 'shadow', mainText, subText, className: 'state-shadow' };
    }
    // Sun hasn't arrived yet today
    const timeUntil = Math.max(8/60, nextWindow.start - fromHour);
    const mainText = t('state_sun_in', { duration: formatDuration(timeUntil) });
    const subText = t('state_sun_until', { time: formatHour(lastWindow.end) });
    return { state: 'shadow', mainText, subText, className: 'state-shadow' };
  }

  // Done: no more sun today
  return {
    state: 'done',
    mainText: t('state_no_more_sun'),
    subText: t('state_last_sun', { time: formatHour(lastWindow.end) }),
    className: 'state-done'
  };
}

// ── Opening hours helpers ─────────────────────────────────────────────────────

/**
 * Returns { open, close } for the specific day of dateStr.
 * Uses openingHoursWeekly (day-specific) when available,
 * falls back to the widest-window openingHours.
 */
function getVenueHoursForDay(venue, dateStr) {
  const day = String(new Date(dateStr + 'T12:00:00').getDay()); // 0=Sun … 6=Sat
  return venue.openingHoursWeekly?.[day] ?? venue.openingHours ?? { open: 11, close: 23 };
}

// ── Data helpers for detail panel ──────────────────────────────────────────────

/**
 * Calculate walk time from distance in meters.
 * Assumes 4.8 km/h walking speed (80 meters/min).
 * Returns rounded minutes; under 1 min shows "< 1 min".
 */
function calcWalkTime(distanceMeters) {
  if (!distanceMeters) return null;
  const minutes = Math.round(distanceMeters / 80);
  return minutes < 1 ? '< 1 min' : `${minutes} min`;
}

/**
 * Map noise score (0–100) to a label and description.
 * 0–33: Rolig, 34–66: Moderat trafikkstøy, 67–100: Mye trafikkstøy.
 */
function noiseScoreToBucket(score) {
  if (score == null) return null;
  if (score <= 33) return { label: 'Rolig', score: score };
  if (score <= 66) return { label: 'Moderat trafikkstøy', score: score };
  return { label: 'Mye trafikkstøy', score: score };
}

// ── Venue list helpers ────────────────────────────────────────────────────────

function venueHasSunInRange(v, dateStr, fromHour, toHour) {
  const { windows, open, close } = computeSunWindows(v, dateStr);
  if (toHour < open || fromHour > close) return false;
  // In point mode (fromHour == toHour), use <= so a window starting exactly at
  // the selected hour is counted as "in sun" (fixes dimming of venues at window open)
  const isPoint = Math.abs(fromHour - toHour) < 0.01;
  return windows.some(w => w.end > fromHour && (isPoint ? w.start <= fromHour : w.start < toHour));
}

// ── Weather-aware arc color helper ────────────────────────────────────────────
/**
 * Returns the arc stroke color for a given hour, based on weather data.
 * bright=true → full opacity (future segments); false → dim (past segments).
 */
function wxColor(dateStr, h, bright) {
  const wx = (typeof getWeatherAt === 'function') ? getWeatherAt(dateStr, h) : null;
  const precip = wx?.precip ?? 0;
  const cloud  = wx?.cloud  ?? 0;
  const isRainy    = precip > 0.3;
  const isOvercast = !isRainy && cloud > 0.65;
  const isPartly   = !isRainy && !isOvercast && cloud > 0.38;
  if (bright) {
    if (isRainy)    return 'rgba(156,189,231,0.25)';
    if (isOvercast) return 'rgba(156,189,231,0.45)';
    if (isPartly)   return 'rgba(156,189,231,0.70)';
    return 'rgba(255,175,133,0.85)';
  } else {
    // Past arcs: dimmed versions of the same colors
    if (isRainy)    return 'rgba(156,189,231,0.12)';
    if (isOvercast) return 'rgba(156,189,231,0.22)';
    if (isPartly)   return 'rgba(156,189,231,0.35)';
    return 'rgba(255,175,133,0.40)';
  }
}

/**
 * Splits a sun window [wStart, wEnd] into runs of the same color, each
 * colored by the weather at that hour. Consecutive same-color hours are
 * merged into one path to avoid dot artifacts from stroke-linecap="round".
 * Segments before fromHour use dim colors, at/after use bright colors.
 * Returns an array of SVG <path> strings.
 */
function wxArcPaths(dateStr, wStart, wEnd, fromHour, arcPathFn, sw) {
  // Build color runs by merging consecutive same-color hour sub-segments
  const runs = []; // [{start, end, color}]
  const hFloor = Math.floor(wStart);
  const hCeil  = Math.ceil(wEnd);
  for (let h = hFloor; h < hCeil; h++) {
    const segS = Math.max(wStart, h);
    const segE = Math.min(wEnd, h + 1);
    if (segE <= segS + 0.001) continue;
    const pastE = Math.min(segE, fromHour);
    const futS  = Math.max(segS, fromHour);
    if (pastE > segS + 0.001) {
      const color = wxColor(dateStr, h, false);
      if (runs.length && runs[runs.length - 1].color === color) {
        runs[runs.length - 1].end = pastE;
      } else {
        runs.push({ start: segS, end: pastE, color });
      }
    }
    if (futS < segE - 0.001) {
      const color = wxColor(dateStr, h, true);
      if (runs.length && runs[runs.length - 1].color === color) {
        runs[runs.length - 1].end = segE;
      } else {
        runs.push({ start: futS, end: segE, color });
      }
    }
  }
  return runs.map(r => {
    const d = arcPathFn(r.start, r.end);
    return d ? `<path d="${d}" fill="none" stroke="${r.color}" stroke-width="${sw}" stroke-linecap="round"/>` : '';
  }).filter(Boolean);
}

// ── Google Maps-style SVG icons for detail panel ────────────────────────────────
/**
 * Returns Google Maps-style SVG icon as inline HTML.
 * Icons use thin strokes (1.5-2px), minimal geometry, 24x24 viewBox.
 */
function getMapsIcon(type) {
  const strokeW = 1.5;
  const size = 24;
  const viewBox = `0 0 ${size} ${size}`;

  const icons = {
    people: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M 6 14 Q 6 12 12 12 Q 18 12 18 14 L 18 16 Q 18 18 12 18 Q 6 18 6 16 Z"/></svg>`,

    volume: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M 3 9 L 7 9 L 12 4 L 12 20 L 7 15 L 3 15 Z"/><path d="M 17 7 Q 19 9 19 12 Q 19 15 17 17"/><path d="M 19 4 Q 22 7 22 12 Q 22 17 19 20"/></svg>`,

    clock: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M 12 6 L 12 12 L 16 15"/></svg>`,

    phone: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M 9 3 L 5 7 Q 5 13 11 19 Q 17 25 23 25 L 27 21 L 23 17 Q 21 18 19 16 Q 17 14 18 12 L 22 8 Z" transform="translate(-1, -1) scale(0.9)"/><path d="M 6 3 L 3 6 Q 3 15 12 24 Q 21 33 30 33 L 33 30 L 30 27 Q 27 28 25 26 Q 23 24 24 22 L 27 19 Z" transform="translate(-2, -2) scale(0.65)"/></svg>`,

    globe: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M 2 12 L 22 12"/><path d="M 12 2 Q 16 8 16 12 Q 16 16 12 22 Q 8 16 8 12 Q 8 8 12 2"/></svg>`,

    share: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M 15.88 6.12 L 8.12 10.88"/><path d="M 15.88 17.88 L 8.12 13.12"/></svg>`,

    directions: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.41 2.59a2 2 0 0 0-2.82 0L2.59 10.59a2 2 0 0 0 0 2.82l8 8a2 2 0 0 0 2.82 0l8-8a2 2 0 0 0 0-2.82Z"/><path d="M 8 12 L 12 8 L 16 12"/><path d="M 12 8 L 12 16"/></svg>`,

    beer: `<svg viewBox="${viewBox}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M 7 4 L 7 18 Q 7 20 9 20 L 15 20 Q 17 20 17 18 L 17 4 Z"/><path d="M 17 7 L 19 7 Q 21 7 21 9 L 21 13 Q 21 15 19 15 L 17 15"/><path d="M 7 10 L 17 10"/></svg>`,
  };

  return icons[type] || '';
}
