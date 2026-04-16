/**
 * ui-shared.js — Shared UI helpers used across list and detail panel.
 * No side effects: only function declarations.
 * Loaded before all other ui-*.js files.
 * Depends on: computeSunWindows (app.js), getWeatherAt (weather.js)
 */

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
