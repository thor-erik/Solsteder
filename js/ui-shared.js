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
  const isFuture = typeof todayStr === 'function' && dateStr > todayStr();

  const { windows } = computeSunWindows(venue, dateStr);
  if (!windows.length) return { state: 'done', mainText: t('state_done'), subText: '', className: 'state-done' };

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
    const mainText = isFuture
      ? (isRainy ? t('state_rain_future') : t('state_overcast_future'))
      : (isRainy ? t('state_rain_now') : t('state_overcast'));
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
      const mainText = isFuture ? t('state_in_shadow_future') : t('state_in_shadow');
      const subText = t('state_sun_again', { time: formatHour(nextWindow.start) });
      return { state: 'shadow', mainText, subText, className: 'state-shadow' };
    }
    // Sun hasn't arrived yet
    if (isFuture) {
      const mainText = t('state_sun_in_future', { time: formatHour(nextWindow.start) });
      const subText = t('state_sun_until', { time: formatHour(lastWindow.end) });
      return { state: 'shadow', mainText, subText, className: 'state-shadow' };
    }
    const timeUntil = Math.max(8/60, nextWindow.start - fromHour);
    const mainText = t('state_sun_in', { duration: formatDuration(timeUntil) });
    const subText = t('state_sun_until', { time: formatHour(lastWindow.end) });
    return { state: 'shadow', mainText, subText, className: 'state-shadow' };
  }

  // Done: no more sun
  return {
    state: 'done',
    mainText: isFuture ? t('state_no_sun_future') : t('state_no_more_sun'),
    subText: t('state_last_sun', { time: formatHour(lastWindow.end) }),
    className: 'state-done'
  };
}

// ── Card pill builder ─────────────────────────────────────────────────────────
//
// Produces the 1- or 2-pill chronological narrative shown in the new card row 3.
// Pills read left→right as a small day timeline: state at selectedHour → state
// at sundown. Pill color always agrees with its verbal subject (sun pill is
// orange, shadow pill is gray, etc.), per the design spec.
//
// `qual` is the result of qualifyingWindows() — caller must already have
// filtered the venue down to a surfaced state. `sundownH` is the actual sun
// crossing for the date; `dateStr` is needed for weather lookups when the
// caller wants the state pill colored by current cloud/rain conditions.
function buildCardPills(venue, qual, selectedHour, sundownH, dateStr) {
  if (!qual || !qual.earliest) return [];
  const earliest = qual.earliest;
  const fmt = (h) => (typeof formatHour === 'function') ? formatHour(h) : `${Math.floor(h)}:00`;
  const sunUntilPill = (endH) => (sundownH != null && endH >= sundownH - 5/60)
    ? { kind: 'sol', label: t('pill_sun_until_sundown'), time: sundownH }
    : { kind: 'sol', label: t('pill_sun_until', { time: fmt(endH) }), time: endH };

  // Determine the non-sun state at a given hour: weather first (regn/skyer),
  // else 'skygge' (geometric shadow / no direct sun).
  const stateAt = (h) => {
    if (h >= sundownH) return null;
    const wx = (typeof wxBucket === 'function') ? wxBucket(dateStr, h) : null;
    if (wx === 'regn')  return 'regn';
    if (wx === 'skyer') return 'skyer';
    return 'skygge';
  };
  const stateLabel = (kind) => kind === 'regn'  ? t('pill_state_regn')
                            : kind === 'skyer' ? t('pill_state_skyer')
                            : t('pill_state_skygge');

  const inSunNow = earliest.start <= selectedHour + 0.001;

  if (inSunNow) {
    // Single-pill exception: continuous sun all the way to (or near) sundown.
    if (sundownH != null && earliest.end >= sundownH - 5/60) {
      return [{ kind: 'sol', label: t('pill_sun_until_sundown'), time: sundownH }];
    }
    // Pill 1: orange — when the current sun ends.
    const pill1 = { kind: 'sol', label: t('pill_sun_until', { time: fmt(earliest.end) }), time: earliest.end };
    // Pill 2: state-color — what comes after, until next change before sundown.
    const afterKind = stateAt(earliest.end + 0.001) ?? 'skygge';
    const nextWin = qual.windows.find(w => w.start > earliest.start + 0.001);
    const pill2 = nextWin
      ? { kind: afterKind, label: t('pill_state_until', { state: stateLabel(afterKind), time: fmt(nextWin.start) }), time: nextWin.start }
      : { kind: afterKind, label: t('pill_state_until_sundown', { state: stateLabel(afterKind) }), time: sundownH };
    return [pill1, pill2];
  }

  // Sol senere: state at selectedHour → sun arrival → end.
  const stateNowKind = stateAt(selectedHour) ?? 'skygge';
  const pill1 = {
    kind: stateNowKind,
    label: t('pill_state_until', { state: stateLabel(stateNowKind), time: fmt(earliest.start) }),
    time: earliest.start,
  };
  return [pill1, sunUntilPill(earliest.end)];
}

// ── v2 anchor + pill builders + fill-bar geometry ────────────────────────────
//
// The redesigned list card stops telling a chronological pill story and
// instead says: this venue has X sun, until Y. Pills surface only the things
// the duration + anchor line cannot say alone — in-window disruptions,
// binding opening hours, and overflow indicators.

/**
 * Anchor text for row 2's right column.
 *   • `now` bucket  → "til 21:00" or "til solnedgang"
 *   • `later` bucket → "fra 14:00 · til 21:00" or "fra 14:00 · til solnedgang"
 * Returns '' if the qual has no surfaced earliest window.
 */
function formatAnchor(qual, bucket, sundownH) {
  if (!qual || !qual.earliest) return '';
  const fmt = (typeof formatHour === 'function') ? formatHour : (h) => `${Math.floor(h)}:00`;
  const w = qual.earliest;
  const endsAtSundown = sundownH != null && w.end >= sundownH - 5/60;
  if (bucket === 'later') {
    return endsAtSundown
      ? t('anchor_fra_til_sundown', { start: fmt(w.start) })
      : t('anchor_fra_til', { start: fmt(w.start), end: fmt(w.end) });
  }
  return endsAtSundown
    ? t('anchor_til_sundown')
    : t('anchor_til', { time: fmt(w.end) });
}

/**
 * v2 pill builder. Produces an ordered, capped list of typed pill descriptors
 * for the list card. Three categories, in priority order:
 *
 *  1. Disruption pills — ≥15-min gaps inside the surfaced window. The
 *     gap kind comes from qualifyingWindows() (skygge / skyer / regn).
 *  2. Hours pills — only when the venue's opening hours are the binding
 *     constraint on the window's edges (`Stenger HH:MM` / `Åpner HH:MM`).
 *  3. Overflow / opportunity pill — sun-token color:
 *       • If qual.windows.length > 1: "+ X sol fra HH:MM" (single extra)
 *         or "+ N sol senere" (multi-extra).
 *       • If priority pills overflow the 3-pill cap, replace the third+
 *         with "+ N mer".
 *
 * Hard cap: 3 visible pills. Returns array of { kind, label }.
 */
function buildCardPillsV2(venue, qual, opts) {
  if (!qual || !qual.earliest) return [];
  const {
    sundownH, dayHours, rawWindowStart, geometricEndAfterClose,
  } = opts || {};
  const fmt = (typeof formatHour === 'function') ? formatHour : (h) => `${Math.floor(h)}:00`;
  const stateLabel = (kind) => kind === 'regn'  ? t('pill_state_regn')
                            : kind === 'skyer' ? t('pill_state_skyer')
                            : t('pill_state_skygge');

  const w = qual.earliest;
  const candidates = [];

  // 1. Disruption pills — already pre-classified by qualifyingWindows().
  // Carry `time` (gap start) so the timeline-labels row can place a label
  // above each disruption event.
  for (const g of (w.gaps || [])) {
    candidates.push({
      kind: g.kind,  // 'skygge' | 'skyer' | 'regn' — maps to existing pill-* CSS
      label: t('pill_disrupt_range', {
        state: stateLabel(g.kind),
        start: fmt(g.start),
        end: fmt(g.end),
      }),
      time: g.start,
    });
  }

  // 2. Hours pills — only when binding.
  if (dayHours && geometricEndAfterClose && w.end <= dayHours.close + 0.001) {
    candidates.push({ kind: 'stenger', label: t('pill_stenger', { time: fmt(dayHours.close) }), time: dayHours.close });
  }
  if (dayHours && rawWindowStart != null && rawWindowStart < dayHours.open - 0.001
      && w.start >= dayHours.open - 0.001) {
    candidates.push({ kind: 'aapner', label: t('pill_aapner', { time: fmt(dayHours.open) }), time: dayHours.open });
  }

  // 3. Overflow / opportunity pill from additional qualifying windows.
  const extraWindows = (qual.windows || []).slice(1);
  if (extraWindows.length === 1) {
    const ex = extraWindows[0];
    const dur = _formatPillDur(ex.durationMin);
    candidates.push({
      kind: 'overflow',
      label: t('pill_overflow_one', { dur, time: fmt(ex.start) }),
      time: ex.start,
    });
  } else if (extraWindows.length > 1) {
    candidates.push({
      kind: 'overflow',
      label: t('pill_overflow_many', { n: extraWindows.length }),
    });
  }

  // Hard cap: 3 visible. If we have > 3, render first 2 + "+N mer".
  if (candidates.length <= 3) return candidates;
  const overflowCount = candidates.length - 2;
  return [
    candidates[0],
    candidates[1],
    { kind: 'overflow', label: t('pill_more_count', { n: overflowCount }) },
  ];
}

/**
 * Minimal duration formatter for pill text — "45m", "1h", "2h 30m" (en);
 * "45m", "1t", "2t 30m" (no/sv/da). Hour suffix is locale-aware via
 * unit_h_short; minute suffix is the language-neutral 'm' so the
 * notation stays consistently short. Local helper; keeps ui-shared
 * independent of ui-list._formatDurationFromMin.
 */
function _formatPillDur(minutes) {
  const m = Math.round(minutes);
  const hu = (typeof t === 'function') ? t('unit_h_short') : 't';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m - h * 60;
  return rem === 0 ? `${h}${hu}` : `${h}${hu} ${rem}m`;
}

/**
 * Net sun fraction for the bottom fill bar — `netSunMinutes / minutes
 * (selectedTime → sundown)`, clamped to [0, 1]. The bar is drawn as a
 * single contiguous fill from the left (a level meter, per spec); gap
 * detail lives in the disruption pills, not in the bar.
 */
function fillBarFraction(qual, selectedHour, sundownH) {
  if (!qual || !qual.earliest || sundownH == null) return 0;
  const total = (sundownH - selectedHour) * 60;
  if (total <= 0) return 0;
  const net = qual.earliest.durationMin ?? 0;
  return Math.max(0, Math.min(1, net / total));
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
 * Classify weather at a given hour into one of four buckets.
 * 'sol' = clear, 'skyer' = cloudy/overcast, 'regn' = raining.
 * 'skygge' is intentionally NOT decided here — it's a geometric state (no
 * direct sun on the venue) that the caller layers on top of this classification.
 * Returns null when weather data is unavailable.
 *
 * Used by:
 *  - wxColor() below (to pick stroke color)
 *  - qualifyingWindows() (rainy/overcast = wet, dropped from windows)
 *  - buildCardPills() in ui-list.js (to pick pill color)
 */
function wxBucket(dateStr, h) {
  const wx = (typeof getWeatherAt === 'function') ? getWeatherAt(dateStr, h) : null;
  if (!wx) return null;
  const precip = wx.precip ?? 0;
  const cloud  = wx.cloud  ?? 0;
  // 'skyer' = truly overcast (cloud ≥ 0.85), matching the threshold venueState
  // already uses for its overcast display state. Partly cloudy / sub-overcast
  // hours still count as 'sol' so a venue with sun behind a few clouds isn't
  // wrongly filtered out of the list. The wxColor() helper above keeps a
  // finer 4-step gradient for the timeline-bar paint — that's a visual ramp,
  // not a filter input.
  if (precip > 0.3)  return 'regn';
  if (cloud  >= 0.85) return 'skyer';
  return 'sol';
}

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

// ── Shared timeline renderer ───────────────────────────────────────────────────
//
// Single canvas-based renderer used by BOTH the floating time slider (FTS) and
// the venue-card mini-timelines, so the two read identically. Layers are opt-in
// via flags so callers can skip pieces that don't apply (e.g. cards skip the
// thumb; cards pass `compact: true` to skip the lens sheen).
//
// Caller responsibilities:
//  - Size the canvas to its container in CSS px and scale by devicePixelRatio
//    for crisp rendering. drawTimeline assumes ctx has been ctx.scale(dpr,dpr)'d
//    and the canvas's bitmap is `cssW*dpr x cssH*dpr`. drawTimeline only knows
//    about CSS px.
//  - Make sure `currentSunTable` and `getSunFromTable` are reachable from
//    global scope (true in this app).

function drawTimeline(ctx, opts) {
  const {
    cssW, cssH,
    bleed = 0,                      // px above/below for thumb glow overflow
    minH, maxH,
    dateStr,
    sunTable,                       // pass currentSunTable
    nowH = null, isToday = false,
    openHour = null, closeHour = null,   // venue's open hours (dim outside)
    sunWindows = null,                   // [{start,end}] — dim shadow gaps
    drawSheen = true,                    // top-light + bottom-shade gradients
    drawThumb = false,
    thumbHour = null, thumbActive = false,
    springOffset = 0,
  } = opts;

  if (!sunTable) return;
  const TRACK_H = cssH - bleed * 2;
  const TRACK_R = Math.floor(TRACK_H / 2);
  const BAR_W   = cssW;
  const timeToX = t => (t - minH) / (maxH - minH) * BAR_W;

  function trackPath() {
    ctx.beginPath();
    ctx.roundRect(0, bleed, BAR_W, TRACK_H, TRACK_R);
  }

  // Inside the rounded clip — segments + sheen + dims + shadow overlay.
  ctx.save();
  trackPath(); ctx.clip();

  // 1. Night background (visible only at the rounded ends if no segments cover them)
  ctx.fillStyle = TOKENS.weatherNight;
  ctx.fillRect(0, bleed, BAR_W, TRACK_H);

  // 2. Hourly weather segments (only where sun is up)
  const hasWx = (typeof getWeatherAt === 'function') &&
                (typeof getWeatherHoursForDate !== 'function' ||
                 getWeatherHoursForDate(dateStr).length > 0);
  const segments = [];
  for (let h = Math.floor(minH); h < Math.ceil(maxH); h++) {
    const sun = getSunFromTable(sunTable, h + 0.5);
    if (sun.alt <= 0) continue;
    let color = TOKENS.weatherClear;
    if (hasWx) {
      const wx   = getWeatherAt(dateStr, h + 0.5);
      const rain = wx ? (wx.precip ?? wx.prec ?? 0) > 0.3 : false;
      const cf   = wx ? (wx.cloud ?? 0) : 0;
      if      (rain)       color = TOKENS.weatherRain;
      else if (cf < 0.15)  color = TOKENS.weatherClear;
      else if (cf < 0.40)  color = TOKENS.weatherClearSoft;
      else if (cf < 0.65)  color = TOKENS.weatherPartly;
      else if (cf < 0.85)  color = TOKENS.weatherCloudy;
      else                 color = TOKENS.weatherOvercast;
    }
    const x1 = Math.round(timeToX(Math.max(h, minH)));
    const x2 = Math.round(timeToX(Math.min(h + 1, maxH)));
    if (x2 <= x1) continue;
    segments.push({ x1, x2, color });
  }
  if (segments.length > 0) {
    const first = segments[0];
    const last  = segments[segments.length - 1];
    if (first.x1 > 0) { ctx.fillStyle = first.color; ctx.fillRect(0, bleed, first.x1, TRACK_H); }
    if (last.x2 < BAR_W) { ctx.fillStyle = last.color; ctx.fillRect(last.x2, bleed, BAR_W - last.x2, TRACK_H); }
  }
  for (const seg of segments) {
    ctx.fillStyle = seg.color;
    ctx.fillRect(seg.x1, bleed, seg.x2 - seg.x1, TRACK_H);
  }

  // 3. Lens sheen (skip on small heights — sheen dominates < ~16px)
  if (drawSheen && TRACK_H >= 16) {
    const sheen = ctx.createLinearGradient(0, bleed, 0, bleed + TRACK_H * 0.55);
    sheen.addColorStop(0,    'rgba(255,242,235,0.28)');
    sheen.addColorStop(0.55, 'rgba(255,242,235,0.06)');
    sheen.addColorStop(1,    'rgba(255,242,235,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, bleed, BAR_W, TRACK_H * 0.55);
    const topHL = ctx.createLinearGradient(0, bleed, 0, bleed + 1.5);
    topHL.addColorStop(0, 'rgba(255,255,255,0.55)');
    topHL.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = topHL;
    ctx.fillRect(0, bleed, BAR_W, 1.5);
    const shade = ctx.createLinearGradient(0, bleed + TRACK_H * 0.65, 0, bleed + TRACK_H);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, bleed + TRACK_H * 0.65, BAR_W, TRACK_H * 0.35);
  }

  // 4. Past-hour dim (today only)
  if (isToday && nowH != null && nowH > minH) {
    const pastX = Math.min(Math.round(timeToX(nowH)), BAR_W);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(0, bleed, pastX, TRACK_H);
  }

  // 5. Shadow gaps overlay — dim portions where the venue is in shadow
  if (sunWindows) {
    const wins = sunWindows.windows || [];
    const sOpen  = sunWindows.open  ?? minH;
    const sClose = sunWindows.close ?? maxH;
    const gaps = [];
    if (wins.length > 0) {
      if (wins[0].start > sOpen + 0.01) gaps.push({ start: sOpen, end: wins[0].start });
      for (let i = 0; i < wins.length - 1; i++) {
        if (wins[i + 1].start > wins[i].end + 0.01) {
          gaps.push({ start: wins[i].end, end: wins[i + 1].start });
        }
      }
      const lastEnd = wins[wins.length - 1].end;
      if (lastEnd < sClose - 0.01) gaps.push({ start: lastEnd, end: sClose });
    } else if (sClose > sOpen) {
      gaps.push({ start: sOpen, end: sClose });
    }
    for (const gap of gaps) {
      const gx1 = Math.round(timeToX(Math.max(minH, gap.start)));
      const gx2 = Math.round(timeToX(Math.min(maxH, gap.end)));
      if (gx2 <= gx1) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(gx1, bleed, gx2 - gx1, TRACK_H);
    }
  }

  // 6. Opening-hours dim — outside the venue's open window. Stacks on top of
  //    weather + shadow so closed portions read as "unavailable" regardless
  //    of sun state. Skipped if open/close span exceeds the timeline domain.
  if (openHour != null && closeHour != null && closeHour > openHour) {
    if (openHour > minH) {
      const ox = Math.min(Math.round(timeToX(Math.min(openHour, maxH))), BAR_W);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, bleed, ox, TRACK_H);
    }
    if (closeHour < maxH) {
      const cx = Math.max(Math.round(timeToX(Math.max(closeHour, minH))), 0);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(cx, bleed, BAR_W - cx, TRACK_H);
    }
  }

  ctx.restore(); // exit rounded-rect clip — tick + thumb draw unclipped

  // 7. NÅ tick — dashed vertical at wall-clock time (today only, not at thumb)
  if (isToday && nowH != null && nowH >= minH && nowH <= maxH) {
    const nx = timeToX(nowH);
    const showTick = !drawThumb || (() => {
      const thumbX = Math.max(TRACK_R, Math.min(BAR_W - TRACK_R, timeToX(thumbHour)));
      return Math.abs(thumbX - nx) >= TRACK_R;
    })();
    if (showTick) {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(156,189,231,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(nx, bleed);
      ctx.lineTo(nx, bleed + TRACK_H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // 8. Thumb — FTS only. We don't gate on thumbHour ∈ [minH, maxH]: the
  // sx clamp below already keeps the thumb visually pinned to the nearest
  // track edge, so an out-of-range value (page load before the first
  // update() clamps timeFromEl, drag overshoot past either end) still
  // renders rather than disappearing.
  if (drawThumb && thumbHour != null) {
    const rawX = timeToX(thumbHour) + springOffset;
    const sx   = Math.max(TRACK_R, Math.min(BAR_W - TRACK_R, rawX));
    const cy_  = bleed + TRACK_H / 2;
    const R    = TRACK_H * 0.42;
    ctx.save();
    ctx.translate(sx, cy_);
    const sc = thumbActive ? 1.18 : 1.0;
    ctx.scale(sc, sc);
    ctx.translate(-sx, -cy_);
    const halo = ctx.createRadialGradient(sx, cy_, R * 0.7, sx, cy_, R * 1.3);
    halo.addColorStop(0, thumbActive ? 'rgba(255,175,133,0.42)' : 'rgba(255,175,133,0.28)');
    halo.addColorStop(1, 'rgba(255,175,133,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(sx, cy_, R * 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 1.5;
    ctx.beginPath(); ctx.arc(sx, cy_, R, 0, Math.PI * 2);
    const body = ctx.createRadialGradient(sx, cy_ - R * 0.35, R * 0.1, sx, cy_ + R * 0.4, R * 1.1);
    body.addColorStop(0, 'rgba(255,255,253,1)');
    body.addColorStop(0.55, 'rgba(255,242,235,0.96)');
    body.addColorStop(1, 'rgba(232,210,196,0.92)');
    ctx.fillStyle = body; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.arc(sx, cy_, R, 0, Math.PI * 2); ctx.clip();
    const hl = ctx.createLinearGradient(sx, cy_ - R, sx, cy_);
    hl.addColorStop(0, 'rgba(255,255,255,0.55)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.fillRect(sx - R, cy_ - R, R * 2, R);
    ctx.restore();
    ctx.beginPath(); ctx.arc(sx, cy_, R - 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(42,26,12,0.20)';
    ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }
}
