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

  // Debug: log first few venues to understand window structure
  if (venue.id <= 3) {
    console.debug(`[venueState] ${venue.name} at ${fromHour.toFixed(2)}: windows=${windows.map(w => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(',')}, currentWindow=${currentWindow ? `[${currentWindow.start.toFixed(2)}-${currentWindow.end.toFixed(2)}]` : 'none'}, nextWindow=${nextWindow ? `[${nextWindow.start.toFixed(2)}-${nextWindow.end.toFixed(2)}]` : 'none'}`);
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

  if (currentWindow) {
    // In sun now
    const remaining = Math.max(5/60, currentWindow.end - fromHour); // At least 5 min
    const mainText = `☼ ${formatDuration(remaining)}`;
    const subText = `til ${formatHour(lastWindow.end)}`;
    return { state: 'sun', mainText, subText, className: 'state-sun' };
  }

  if (nextWindow) {
    // Shadow: sun coming later
    const timeUntil = Math.max(8/60, nextWindow.start - fromHour); // At least 8 min shown
    const mainText = `Sol om ${formatDuration(timeUntil)}`;
    const subText = `til ${formatHour(lastWindow.end)}`;
    return { state: 'shadow', mainText, subText, className: 'state-shadow' };
  }

  // Done: no more sun today
  return {
    state: 'done',
    mainText: 'Ferdig',
    subText: `sist ${formatHour(lastWindow.end)}`,
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
  return venue.openingHoursWeekly?.[day] ?? venue.openingHours;
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
