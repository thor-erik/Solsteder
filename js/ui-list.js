/* Content-hash bump 2026-05-26: Cloudflare Pages served a persistent HTTP 500
   for this file's prior content hash — a corrupt blob in their content-addressed
   asset store (the SAME hash 500'd across production + branch + preview deploys
   while every other /js file returned 200). Altering the bytes mints a fresh
   hash, sidestepping the bad blob. Safe to leave in place. */
/**
 * ui-list.js — Venue list, venue cards, hover tooltip, and infinite scroll.
 * Depends on: computeSunWindows, formatHour, selectedId, nowMode, activeSortBy,
 *             activeArea, filterMapViewActive, _navMode, userLocation, datePicker,
 *             timeFromEl, VENUES, currentSun, currentSunTable, todayStr,
 *             findSunCrossingFromTable, advanceDay (app.js)
 *             catLabel (data.js)
 *             computeVenueScore (scoring.js)
 *             getWeatherAt, skyIcon (weather.js)
 *             venueHasSunInRange, wxArcPaths (ui-shared.js)
 *             selectVenue, setHoveredVenue (app.js / ui.js)
 */

// ── Skeleton cards ────────────────────────────────────────────────────────────
// Shared helper used by both the after-sunset empty state and the slider-scrub
// signal (see _injectScrubSkeletons in app.js). Markup mirrors a real
// .venue-card (row1 name + duration, meta line, mini-timeline) so the swap
// doesn't reshape the list height.
function renderSkeletonCards(container, n = 7) {
  // Mirror the real 3-row card (row1 name+duration / row2 sub / row3 meta) +
  // the lifted fill bar, so the skeleton footprint matches and the swap never
  // reshapes the list. card-3row makes it inherit the same min-height + bar.
  const nameW = [60, 75, 48, 68, 52, 82, 44, 64, 58];
  const subW  = [40, 30, 52, 36, 44, 28, 48, 34, 42];
  const metaW = [62, 70, 54, 66, 58, 72, 50, 64, 60];
  for (let i = 0; i < n; i++) {
    const card = document.createElement('div');
    card.className = 'venue-card card-3row skeleton';
    card.innerHTML =
      '<div class="card-row1">' +
        `<div class="skel skel-name" style="width:${nameW[i % nameW.length]}%"></div>` +
        '<div class="skel skel-duration"></div>' +
      '</div>' +
      '<div class="card-row2">' +
        `<div class="skel skel-sub" style="width:${subW[i % subW.length]}%"></div>` +
      '</div>' +
      '<div class="card-row3">' +
        `<div class="skel skel-meta" style="width:${metaW[i % metaW.length]}%"></div>` +
      '</div>' +
      '<div class="card-fillbar"></div>';
    container.appendChild(card);
  }
}

// ── Venue list ────────────────────────────────────────────────────────────────

const LIST_PAGE = 30; // cards rendered per batch
let _listFiltered = []; // current sorted+filtered result
let _listBuckets = { now: [], later: [] }; // venues split by qualifying-window timing
let _listObserver = null; // IntersectionObserver for infinite scroll
let _aImpressionTimer = null; // debounce for impression analytics

// Hysteresis: venues surfaced in the last renderList pass. Once a venue's
// qualifying window crosses 45 min it sticks around until the window drops
// 5 min below the floor — so a single forecast tick doesn't drop it. Reset on
// date change. The reset is auto-detected inside renderList() via
// _surfacedDateStr, so callers that clear sunWindowCache don't need to do
// anything extra.
const _surfacedSet = new Set();
let _surfacedDateStr = null;
// One-shot escape hatch: when the user clicks "Vis alle steder" on the
// empty-all state, the next renderList pass bypasses the qualifying filter.
let _showAllOnce = false;

// Last rendered venue set — kept so the map auto-fit helper can compute
// bounds from exactly what the user is looking at after an expansion step.
let _lastRenderedVenues = [];
// True when the in-viewport list is too short to scroll-paginate naturally
// (fewer than MIN_VIEWPORT_LIST venues) AND there are outside-viewport
// venues queued behind the pull-tab gesture. In long-list mode this stays
// false — outside venues are already in _listFiltered and load silently as
// the IntersectionObserver fires.
let _hasOutsideMore = false;

// Haversine distance in km between two {lat, lng} points. Used by Beste
// treff to apply a real-km penalty to the sun duration (1 km ≈ 20 min).
function _haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * Math.PI / 180)
          * Math.cos(b.lat * Math.PI / 180)
          * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Mini sun-timeline: a canvas drawn by the shared drawTimeline() renderer
 * (ui-shared.js). The actual paint is deferred to drawAllCardTimelines(),
 * which runs after the cards are inserted into the DOM. We just emit the
 * canvas placeholder + a data-vid attribute for the painter to look up the
 * venue. Domain (minH/maxH), now-tick, shadow gaps and opening-hours dim are
 * all set per-card in drawAllCardTimelines.
 */
function buildMiniSunTimeline(v, dateStr, fromHour) {
  // Hidden scrubber — mirrors the accept-panel markup (.dprcv-timeline-scrubber
  // with an FTS-popup bubble + a pill). Hidden (aria-hidden, opacity 0) until
  // the user taps the bar; _wireTimelineScrubber then tracks it to the scrubbed
  // hour. Only the detail panel actually wires it (see _populateDpCardSlot); on
  // list/hover cards the markup is inert (no canvas drag handler attached).
  return `<div class="card-timeline">
    <div class="dprcv-timeline-scrubber" aria-hidden="true">
      <div class="dprcv-timeline-scrubber-label fts-popup">
        <div class="fts-popup-row fts-popup-primary">
          <span class="fts-popup-time"></span>
          <span class="fts-popup-wx-icon" aria-hidden="true"></span>
        </div>
        <div class="fts-popup-row fts-popup-secondary">
          <span class="fts-popup-temp"></span>
          <span class="fts-dot">·</span>
          <span class="fts-popup-wind"></span>
        </div>
      </div>
      <div class="dprcv-timeline-scrubber-pill"></div>
    </div>
    <canvas class="card-timeline-canvas timeline-track" data-vid="${v.id}"></canvas>
    <div class="card-timeline-wx" aria-hidden="true"></div>
  </div>`;
}

/**
 * Build the labels row that sits under the timeline canvas. Slots:
 * the current time at the bar's start, the boundaries of the earliest
 * qualifying window (which the anchor row references), and the time
 * referenced by every pill. Positions are emitted as percentages of
 * the [MIN_H_ARC, MAX_H_ARC] domain so they line up exactly with the
 * canvas painting. Collision priority is window-end > pill1 > pill2 >
 * window-start > current — handled in _resolveTimelineLabelCollisions.
 */
function buildTimelineLabels(pills, fromHour, minH, maxH, qual) {
  if (minH == null || maxH == null || maxH <= minH) return '';
  const fmt = (h) => (typeof formatHour === 'function') ? formatHour(h) : `${Math.floor(h)}:00`;
  const pct = (h) => Math.max(0, Math.min(100, (h - minH) / (maxH - minH) * 100));
  const slots = [];
  // The current/slider time is the user's reference point — give it a
  // mid-high priority so it survives most collisions. Below the window
  // start/end markers (95/100) but above far-away pill labels.
  slots.push({ time: fromHour, label: fmt(fromHour), prio: 70, kind: 'current' });
  // The earliest qualifying window's boundaries match the anchor row's
  // "fra HH:MM · til HH:MM". Surface them so the timeline always tells the
  // same story as the anchor — high priority so they survive collisions.
  const earliest = qual?.earliest;
  if (earliest) {
    if (earliest.start > fromHour + 0.001 && earliest.start < maxH - 0.001) {
      slots.push({ time: earliest.start, label: fmt(earliest.start), prio: 95, kind: 'sol' });
    }
    if (earliest.end > fromHour + 0.001 && earliest.end < maxH - 0.001) {
      slots.push({ time: earliest.end, label: fmt(earliest.end), prio: 100, kind: 'sol' });
    }
  }
  // Every disruption pill with a time gets a label. Priority decays by index
  // and is boosted by closeness to fromHour (relevance to the user's now).
  pills.forEach((p, i) => {
    if (!p || p.time == null) return;
    const dist  = Math.abs(p.time - fromHour);
    const close = Math.max(0, 6 - dist);            // 0..6 closer = higher
    const order = Math.max(0, 10 - i);              // 10,9,8,... earlier pill = higher
    slots.push({ time: p.time, label: fmt(p.time), prio: order * 10 + close, kind: p.kind });
  });
  // De-dup labels at the same time bucket; keep highest prio.
  const byTime = new Map();
  for (const s of slots) {
    const key = Math.round(s.time * 12); // 5-min bucket
    const prev = byTime.get(key);
    if (!prev || s.prio > prev.prio) byTime.set(key, s);
  }
  const html = [...byTime.values()].map(s =>
    `<span class="tl-label tl-label-${s.kind}" data-prio="${s.prio}" style="left:${pct(s.time).toFixed(2)}%">${s.label}</span>`
  ).join('');
  return `<div class="card-timeline-labels">${html}</div>`;
}

/**
 * After labels are in the DOM, hide any that collide with a higher-priority
 * sibling. Runs after drawAllCardTimelines so layout is settled.
 */
function _resolveTimelineLabelCollisions(root) {
  const containers = (root || document).querySelectorAll('.card-timeline-labels');
  for (const c of containers) {
    const labels = Array.from(c.querySelectorAll('.tl-label'));
    if (labels.length < 2) continue;
    for (const l of labels) l.style.visibility = '';
    const byPrio = labels.slice().sort((a, b) =>
      Number(b.dataset.prio) - Number(a.dataset.prio)
    );
    const kept = [];
    for (const l of byPrio) {
      const r = l.getBoundingClientRect();
      const collides = kept.some(rr =>
        !(r.right < rr.left - 2 || r.left > rr.right + 2)
      );
      if (collides) l.style.visibility = 'hidden';
      else kept.push(r);
    }
  }
}

/**
 * Walk every .card-timeline-canvas in the list (or any container) and draw it
 * via the shared drawTimeline. Called after every renderListPage reset, on
 * window resize, and on morph (when the source card's canvas resizes).
 */
function drawAllCardTimelines(root) {
  const scope = root || document;
  const nodes = scope.querySelectorAll('.card-timeline-canvas');
  if (!nodes.length || typeof currentSunTable === 'undefined' || !currentSunTable) return;
  const dateStr = datePicker.value;
  const isToday_ = dateStr === todayStr();
  const nowH_    = new Date().getHours() + new Date().getMinutes() / 60;
  const dpr      = window.devicePixelRatio || 1;
  // Card timelines anchor on selectedTime → sundown. We deliberately drop
  // the 6% MAX_H_ARC buffer that the FTS uses for label breathing room: on
  // a card, sundown should sit at the bar's right cap apex so the
  // "Sol til solnedgang" label aligns with the cap (not 6% short of it).
  const fromHour = parseFloat(timeFromEl.value);
  const sundownHCard = (typeof findSunCrossingFromTable === 'function')
    ? findSunCrossingFromTable(currentSunTable, false) : null;
  // Browse-mode + accept-panel default domain: now → sundown.
  const tlMinDefault = fromHour;
  const tlMaxDefault = sundownHCard ?? ((typeof MAX_H_ARC !== 'undefined') ? MAX_H_ARC : 22);
  for (const cv of nodes) {
    if (!cv.clientWidth || !cv.clientHeight) continue; // not laid out yet
    const vid = parseInt(cv.dataset.vid, 10);
    const v = VENUES.find(x => x.id === vid);
    if (!v) continue;
    const cssW = cv.clientWidth, cssH = cv.clientHeight;
    const pw   = Math.round(cssW * dpr);
    const ph   = Math.round(cssH * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, pw, ph);
    ctx.save();
    ctx.scale(dpr, dpr);
    const sunWindowsForShadow = (typeof computeSunWindows === 'function') ? computeSunWindows(v, dateStr) : null;
    const dayHours = (typeof getVenueHoursForDay === 'function') ? getVenueHoursForDay(v, dateStr) : null;
    // Plan-preview timelines (.dprcv-timeline-canvas) suppress the
    // opening-hours dim. The venue + meet time are already chosen — a
    // dark "closed" band before the meet hour (e.g. an invite for 04:40
    // when the venue opens 07:00) reads as a confusing artifact rather
    // than useful "browse to find what's open" context. Browse-mode
    // cards still get the dim via the same drawTimeline call.
    const isPlanPreviewCanvas = cv.classList.contains('dprcv-timeline-canvas');
    // Detail-panel card timeline (NOT the accept-panel canvas): use a FIXED
    // domain (MIN_H_ARC → MAX_H_ARC) instead of now→sundown. The detail panel
    // repaints this canvas on every scrub frame; a from-hour domain would
    // re-anchor the bar each frame and the hidden-scrubber marker could never
    // travel across it. A fixed domain keeps the bar still so only the marker
    // moves (matching how the accept bar behaves under a suspended update
    // cycle). The accept canvas keeps its narrow now→sundown slice.
    const isDetailCanvas = !isPlanPreviewCanvas
      && typeof cv.closest === 'function' && cv.closest('#detail-panel');
    const tlMin = isDetailCanvas
      ? ((typeof MIN_H_ARC === 'number') ? MIN_H_ARC : tlMinDefault)
      : tlMinDefault;
    const tlMax = isDetailCanvas
      ? ((typeof MAX_H_ARC === 'number') ? MAX_H_ARC : tlMaxDefault)
      : tlMaxDefault;
    drawTimeline(ctx, {
      cssW, cssH,
      bleed: 0,
      minH: tlMin, maxH: tlMax,
      dateStr,
      sunTable: currentSunTable,
      nowH: nowH_, isToday: isToday_,
      openHour:  isPlanPreviewCanvas ? null : (dayHours?.open  ?? null),
      closeHour: isPlanPreviewCanvas ? null : (dayHours?.close ?? null),
      sunWindows: sunWindowsForShadow,
      drawSheen: false,
      // Recessed-channel "inset" look — same as the FTS track, applied to both
      // the detail card timeline and the accept-panel timeline (thick enough
      // now that TRACK_H >= 16). drawTimeline gates it on height.
      drawIndent: true,
      drawThumb: false,
    });
    ctx.restore();
    // Weather glyph overlay (detail-panel timeline only). Reuses the
    // accept-panel renderer so the dp-card bar reads the same set of
    // icons as the FTS / accept timelines, without duplicating logic.
    if (isDetailCanvas && typeof _populateTimelineWeather === 'function') {
      const wxHost = cv.parentElement && cv.parentElement.querySelector('.card-timeline-wx');
      if (wxHost) {
        try { _populateTimelineWeather(wxHost, v, dateStr, tlMin, tlMax); }
        catch (e) { /* ignore */ }
      }
    }
  }
  // Labels are positioned by left-percentages already; just resolve overlaps.
  _resolveTimelineLabelCollisions(scope);
}

// Inline beer mug SVG for venue cards (12px)
const beerSvgMini = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/></svg>`;

// Sun glyph used in the row-1 duration label.
const SUN_GLYPH = '<svg class="sun-glyph" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

// Walking-person glyph for the walk-time meta. Filled current-color so
// it inherits the meta's --muted text color and stays visually neutral
// next to the distance.
const WALK_GLYPH = '<svg class="walk-glyph" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>';

// Audit-mode action-row icons (Lucide). Compact icon buttons replace the
// text actions so more cards fit while walking the catalog. Each <button>
// carries its own title + aria-label, so the glyphs need no inline text.
const _AI_SVG = (paths) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const AUDIT_ICONS = {
  good:    _AI_SVG('<path d="M20 6 9 17l-5-5"/>'),
  archive: _AI_SVG('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
  edit:    _AI_SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  undo:    _AI_SVG('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>'),
  restore: _AI_SVG('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>'),
};


function _formatDurationFromMin(minutes) {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  // Hour suffix is locale-aware ('t' for no/sv/da, 'h' for en); minute
  // suffix is the language-neutral 'm' so both units stay consistently
  // short — never "1t 30 min" mixing styles.
  const hu = (typeof t === 'function') ? t('unit_h_short') : 't';
  if (h > 0 && m > 0) return `${h}${hu} ${m}m`;
  if (h > 0)          return `${h}${hu}`;
  if (m > 0)          return `${m}m`;
  return `5m`;
}

// Row-3 right: shade-only disruption summary from the qualifying window's
// gaps. 1 shade gap → "HH:MM–HH:MM"; ≥2 → "N skygger". Cloud/rain gaps are
// filtered (the city-wide outlook line above the list carries weather).
// Returns '' when there are no shade gaps.
function _shadeSummary(qual) {
  const w = qual && qual.earliest;
  if (!w || !Array.isArray(w.gaps) || !w.gaps.length) return '';
  const shade = w.gaps.filter(g => g.kind !== 'skyer' && g.kind !== 'regn');
  if (!shade.length) return '';
  const fmt = (typeof formatHour === 'function') ? formatHour : (h) => `${Math.floor(h)}:00`;
  if (shade.length === 1) {
    return t('card_shade_range', { start: fmt(shade[0].start), end: fmt(shade[0].end) });
  }
  return t('card_shade_count', { n: shade.length });
}

// Round a sun-window duration UP to the nearest half-hour: "2.5h" / "2h".
function _approxHours(minutes) {
  const h = Math.ceil((minutes || 0) / 30) / 2;
  return (h % 1 === 0 ? `${h}` : h.toFixed(1)) + 'h';
}

// Row-3 right (when there's no shade gap): a SUN OPPORTUNITY — an extra
// qualifying sun window later in the day. 1 extra → "2.5h fra 17:00"; ≥2 →
// "3h senere" (total extra sun). No glyph, no "sun" word; honey colour marks
// it as "more sun". Not weather. Returns '' when none.
function _sunOpportunity(qual) {
  const extra = ((qual && qual.windows) || []).slice(1);
  if (!extra.length) return '';
  const fmt = (typeof formatHour === 'function') ? formatHour : (h) => `${Math.floor(h)}:00`;
  if (extra.length === 1) {
    return t('card_opp_one', { dur: _approxHours(extra[0].durationMin), time: fmt(extra[0].start) });
  }
  const total = extra.reduce((a, w) => a + (w.durationMin || 0), 0);
  return t('card_opp_many', { dur: _approxHours(total) });
}

// Walk minutes from the card's distance (mirrors _dprcvWalkInfo: ~80 m/min,
// 1-min floor). Returns null when the venue has no distance (no user location).
function _cardWalkMin(s) {
  if (!s || s.distKm == null) return null;
  return Math.max(1, Math.round((s.distKm * 1000) / 80));
}

/**
 * Render a single venue card.
 *
 * Two variants: compact (default — used by the list, venue-peek, plan
 * preview) and rich (`opts.rich = true` — used by the detail panel header).
 * Compact omits the timeline-bar block but inserts horizontal padding into
 * the pills row so the inset rhythm matches what the timeline used to set.
 * Rich adds the timeline canvas + the time-labels row underneath.
 */
function renderCard(v, dateStr, fromHour, toHour, isPoint, opts) {
  const rich = !!(opts && opts.rich);
  // dpVariant = compact card structure (v2 pills, anchor meta) PLUS the rich
  // timeline bar, MINUS the bottom fill bar. Used by the detail-panel card.
  const dpVariant = !!(opts && opts.dpVariant);
  const dayHours = getVenueHoursForDay(v, dateStr);

  // renderList pre-computes these on its mapped venues; the detail-panel
  // rebuild path (updateDetailPanel + openDetailPanel desktop fallback) calls
  // renderCard with the raw venue from VENUES — fall back to deriving them.
  const isOpen        = v.isOpen        ?? (fromHour >= dayHours.open && fromHour <= dayHours.close);
  const isOpeningSoon = v.isOpeningSoon ?? (!isOpen && (dayHours.open - fromHour) > 0 && (dayHours.open - fromHour) <= 0.75);

  // Qualifying window: precomputed on the listed venue, else derived. The
  // detail-panel-rebuild path passes a raw VENUES entry without _qual, so we
  // reconstruct it here so the right column still has a duration to show.
  let qual = v._qual;
  if (!qual && typeof computeSunWindows === 'function' && typeof currentSunTable !== 'undefined' && currentSunTable) {
    const sundownH = (typeof findSunCrossingFromTable === 'function')
      ? findSunCrossingFromTable(currentSunTable, false) : null;
    const wxLookup = (h) => {
      const b = (typeof wxBucket === 'function') ? wxBucket(dateStr, h) : null;
      return { rainy: b === 'regn', overcast: b === 'skyer' };
    };
    const { windows } = computeSunWindows(v, dateStr);
    qual = (typeof qualifyingWindows === 'function')
      ? qualifyingWindows(windows, wxLookup, {
          selectedHour: fromHour, sundownHour: sundownH ?? 23,
          openHour: dayHours.open, closeHour: dayHours.close,
        })
      : { windows: [], earliest: null, surfaced: false };
  }

  // Closed-all-day with no upcoming qualifying window: keep the legacy
  // collapsed one-row card. Closed-but-opens-later venues with a qualifying
  // window get the full layout below (see openLater handling).
  // Audit mode skips this collapse so the action row (Mark good / Edit /
  // Archive) is reachable on every venue regardless of opening hours.
  const _auditHere = typeof auditModeActive !== 'undefined' && auditModeActive;
  if (!dpVariant && !_auditHere && !isOpen && !isOpeningSoon && !(qual && qual.surfaced)) {
    return `
      <div class="venue-card closed-card ${v.id === selectedId ? 'selected' : ''}"
           data-vid="${v.id}" onclick="selectVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`}, true)"
           onmouseenter="setHoveredVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`})" onmouseleave="setHoveredVenue(null)">
        <div class="closed-row">
          <span class="closed-name">${v.name}</span>
          <span class="card-badge shaded">${t('opens_at', { time: formatHour(dayHours.open) })}</span>
        </div>
      </div>`;
  }

  const s = v.score;
  const distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : null;

  // Right-column duration: always the qualifying window's length.
  const durationStr = qual && qual.earliest
    ? _formatDurationFromMin(qual.earliest.durationMin)
    : '';

  // Pills row. The detail-panel (rich) keeps the legacy chronological-pill
  // narrative so its mini-timeline still reads correctly. The list (compact)
  // uses the v2 model: in-window disruption pills + binding hours pills +
  // overflow / opportunity pill, capped at 3.
  const sundownH = (typeof currentSunTable !== 'undefined' && currentSunTable && typeof findSunCrossingFromTable === 'function')
    ? findSunCrossingFromTable(currentSunTable, false) : null;
  // Raw (unclamped) windows — feed the v2 pills AND the binding-close check.
  // When the geometric sun would have continued past the venue's closing time
  // (binding-Stenger), the 3-row list card folds that into the row-2 anchor.
  // Listed venues memoize on v._rawWindows; detail rebuild recomputes.
  const rawWindows = (qual && qual.surfaced)
    ? (v._rawWindows ?? (typeof computeSunWindows === 'function' ? computeSunWindows(v, dateStr).windows : []))
    : [];
  const geometricEndAfterClose = rawWindows.some(w => w.end > dayHours.close + 0.001);
  let pills = [];
  if (qual && qual.surfaced) {
    if (rich && !dpVariant && typeof buildCardPills === 'function') {
      pills = buildCardPills(v, qual, fromHour, sundownH, dateStr);
    } else if (typeof buildCardPillsV2 === 'function') {
      const earliestRaw = rawWindows.find(w => w.end > qual.earliest.start - 0.001);
      const rawWindowStart = earliestRaw ? earliestRaw.start : qual.earliest.start;
      pills = buildCardPillsV2(v, qual, {
        sundownH, dayHours, rawWindowStart, geometricEndAfterClose,
      });
    }
  }
  const pillsHtml = pills.map(p =>
    `<span class="card-pill pill-${p.kind}">${p.label}</span>`
  ).join('');

  // Meta line: area · type · distance. Walk-time was redundant with
  // distance (one is a proxy for the other); dropping the walk-icon keeps
  // the meta row scan-fast. Walk-time still surfaces in the detail panel
  // for users who want a concrete travel-time number.
  const metaParts = [v.area, catLabel(v), distStr].filter(Boolean);
  const metaInner = metaParts.map((p, i) =>
    (i > 0 ? '<span class="card-meta-dot">·</span>' : '') + `<span>${p}</span>`
  ).join('');

  // v2 list cards split the meta row into a left (text) column and a right
  // anchor column ("til 21:00" / "fra 14:00 · til 21:00"). Rich/detail cards
  // keep the meta as a single inline run so their layout doesn't shift.
  const bucket = (qual && qual.earliest && qual.earliest.start <= fromHour + 0.001) ? 'now' : 'later';
  // dpVariant uses compact's left+anchor meta layout (same as the list card).
  const useCompactMeta = !rich || dpVariant;
  const anchorText = (useCompactMeta && qual && qual.surfaced && typeof formatAnchor === 'function')
    ? formatAnchor(qual, bucket, sundownH, dateStr) : '';
  const metaHtml = useCompactMeta
    ? `<span class="card-meta-left">${metaInner}</span>${anchorText ? `<span class="card-anchor">${anchorText}</span>` : ''}`
    : metaInner;

  // Rich + dpVariant emit the detailed timeline. Labels render ABOVE the
  // timeline (one per disruption event); _resolveTimelineLabelCollisions
  // hides the lower-priority ones when they overlap.
  let timelineBlock = '';
  if (rich || dpVariant) {
    const miniTimeline = buildMiniSunTimeline(v, dateStr, fromHour);
    // dpVariant (detail panel) uses a FIXED domain (MIN_H_ARC → MAX_H_ARC) so
    // the bar doesn't re-anchor on scrub and the hidden marker can travel; the
    // labels MUST use the same domain to stay aligned with the canvas (see
    // drawAllCardTimelines's isDetailCanvas branch). Rich (browse/hover) cards
    // keep the now→sundown domain.
    const tlMin = dpVariant
      ? ((typeof MIN_H_ARC !== 'undefined') ? MIN_H_ARC : fromHour)
      : fromHour;
    const tlMax = dpVariant
      ? ((typeof MAX_H_ARC !== 'undefined') ? MAX_H_ARC : (sundownH ?? null))
      : (sundownH ?? ((typeof MAX_H_ARC !== 'undefined') ? MAX_H_ARC : null));
    // dpVariant (detail sun card) drops the axis labels — the event pills above
    // already carry the exact times, so the labels just repeated them. The bar
    // stays fully interactive (the scrubber), just slim + label-free.
    const tlLabels = dpVariant ? '' : buildTimelineLabels(pills, fromHour, tlMin, tlMax, qual);
    timelineBlock = `<div class="card-timeline-block">${tlLabels}${miniTimeline}</div>`;
  }

  // Fill bar: only in compact (list) cards. Suppressed in rich and dpVariant.
  let fillBarHtml = '';
  if (!rich && !dpVariant && qual && qual.surfaced && typeof fillBarFraction === 'function') {
    const frac = fillBarFraction(qual, fromHour, sundownH);
    if (frac > 0) {
      fillBarHtml = `<div class="card-fillbar"><span class="card-fillbar-fill" style="width:${(frac * 100).toFixed(2)}%"></span></div>`;
    } else {
      fillBarHtml = `<div class="card-fillbar"></div>`;
    }
  }

  const favActive = typeof isFavorite === 'function' && isFavorite(v.id);
  const favHeart = favActive
    ? `<svg class="card-fav-heart" width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>`
    : '';

  const friendCheckins = typeof getFriendCheckinsForVenue === 'function' ? getFriendCheckinsForVenue(v.id) : [];
  const friendBadge = friendCheckins.length
    ? `<div class="card-friend-badge" title="${friendCheckins.map(c => c.user.name || c.user.email).join(', ')}">
        ${friendCheckins.slice(0, 3).map(c => c.user.avatar_url
          ? `<img class="card-friend-dot" src="${c.user.avatar_url}" alt="">`
          : `<div class="card-friend-dot card-friend-dot-init">${(c.user.name || c.user.email)[0].toUpperCase()}</div>`
        ).join('')}${friendCheckins.length > 3 ? `<div class="card-friend-dot card-friend-dot-init">+${friendCheckins.length - 3}</div>` : ''}
      </div>`
    : '';

  const going = typeof getGoingFriendsForVenue === 'function' ? getGoingFriendsForVenue(v.id, dateStr) : [];
  const goingBadge = going.length
    ? `<div class="card-going-badge" title="${going.map(g => g.user.name || g.user.email).join(', ')}">
        ${going.slice(0, 3).map(g => g.user.avatar_url
          ? `<img class="card-going-dot" src="${g.user.avatar_url}" alt="">`
          : `<div class="card-going-dot card-going-dot-init">${(g.user.name || g.user.email)[0].toUpperCase()}</div>`
        ).join('')}${going.length > 3 ? `<div class="card-going-dot card-going-dot-init">+${going.length - 3}</div>` : ''}
      </div>`
    : '';

  // Determine state class so other CSS rules (selection ring, etc.) keep
  // working. Source of truth shifts from venueState.mainText to qual.
  const stateClass = (qual && qual.earliest && qual.earliest.start <= fromHour + 0.001)
    ? 'state-sun' : 'state-shadow';

  // Review-flag chips + AI-training chip share one row above the action
  // bar. Flag chips signal "polygon may be off"; training chip signals
  // "this venue's correction data has (or hasn't) been fed to the model."
  let reviewChips = '';
  const _auditActive = typeof auditModeActive !== 'undefined' && auditModeActive;
  const flags = (_auditActive && typeof venueReviewFlags === 'function')
    ? venueReviewFlags(v) : null;
  // AI proposal awaiting human review → honey "AI · NN%" badge (confidence).
  const _aiStatus = (_auditActive && typeof venueAiReviewStatus === 'function')
    ? venueAiReviewStatus(v) : 'none';
  if (flags || _aiStatus === 'ai-unreviewed') {
    const flagHtml = flags
      ? flags.map(c => `<span class="review-chip" data-flag="${c}">${
          typeof reviewFlagLabel === 'function' ? reviewFlagLabel(c) : c
        }</span>`).join('')
      : '';
    let aiHtml = '';
    if (_aiStatus === 'ai-unreviewed') {
      const conf = (typeof venueAiConfidence === 'function') ? venueAiConfidence(v) : null;
      const pct  = conf != null ? ` · ${Math.round(conf * 100)}%` : '';
      aiHtml = `<span class="audit-ai-chip" title="AI-proposed polygon, not yet human-reviewed. Approve to ship it, or Edit to correct.">AI${pct}</span>`;
    }
    reviewChips = `<div class="review-chips">${aiHtml}${flagHtml}</div>`;
  }

  // Admin audit-mode row: per-card status badge + Mark good / Edit / Archive.
  let auditActionsHtml = '', auditCardCls = '';
  if (typeof auditModeActive !== 'undefined' && auditModeActive) {
    const idArg     = typeof v.id === 'number' ? v.id : `'${v.id}'`;
    const archived  = !!v.auditArchived;
    const audited   = !archived && (typeof isVenueAudited === 'function') && isVenueAudited(v);
    const entry     = audited && typeof venueAuditEntry === 'function' ? venueAuditEntry(v) : null;
    const viaLabel  = entry?.via === 'edited' ? 'Edited ✓'
      : entry?.via === 'unsure' ? 'Usikker ⚠'
      : 'Looks good ✓';
    if (audited)  auditCardCls = ' audit-reviewed';
    if (archived) auditCardCls = ' audit-archived';
    // Compact icon-button action row. Each control carries title + aria-label
    // so the icon stays self-explanatory. Primary action (Mark good) is the
    // honey CTA; destructive (Archive) and Edit are neutral surface controls.
    const ICN = (typeof AUDIT_ICONS !== 'undefined') ? AUDIT_ICONS : {};
    if (archived) {
      const archReasonLabel = (typeof AUDIT_ARCHIVE_REASONS !== 'undefined'
        && v.auditArchiveReason && AUDIT_ARCHIVE_REASONS[v.auditArchiveReason])
        || 'Archived';
      const noteHint = v.auditArchiveNote ? ` · ${v.auditArchiveNote}` : '';
      auditActionsHtml = `<div class="audit-actions" onclick="event.stopPropagation()">
        <span class="audit-state-badge" title="${noteHint ? v.auditArchiveNote : ''}">Archived · ${archReasonLabel}</span>
        <button class="audit-icon-btn" onclick="unarchiveVenue(${idArg})" title="Restore" aria-label="Restore">${ICN.restore || 'Restore'}</button>
        <button class="audit-icon-btn" onclick="enterEditMode(${idArg})" title="Edit polygon" aria-label="Edit polygon">${ICN.edit || 'Edit'}</button>
      </div>`;
    } else if (audited) {
      auditActionsHtml = `<div class="audit-actions" onclick="event.stopPropagation()">
        <span class="audit-state-badge">${viaLabel}</span>
        <button class="audit-icon-btn" onclick="unmarkVenueAudited(${idArg})" title="Undo" aria-label="Undo">${ICN.undo || 'Undo'}</button>
        <button class="audit-icon-btn audit-archive" onclick="beginArchiveVenue(${idArg})" title="Archive (hide from users)" aria-label="Archive">${ICN.archive || 'Archive'}</button>
        <button class="audit-icon-btn" onclick="enterEditMode(${idArg})" title="Edit polygon" aria-label="Edit polygon">${ICN.edit || 'Edit'}</button>
      </div>`;
    } else {
      auditActionsHtml = `<div class="audit-actions" onclick="event.stopPropagation()">
        <button class="audit-icon-btn audit-good" onclick="markVenueAudited(${idArg},'good')" title="Mark good" aria-label="Mark good">${ICN.good || 'Mark good'}</button>
        <button class="audit-icon-btn audit-archive" onclick="beginArchiveVenue(${idArg})" title="Archive (hide from users)" aria-label="Archive">${ICN.archive || 'Archive'}</button>
        <button class="audit-icon-btn" onclick="enterEditMode(${idArg})" title="Edit polygon" aria-label="Edit polygon">${ICN.edit || 'Edit'}</button>
      </div>`;
    }
  }

  // dpVariant uses card-compact layout (3-row stack with anchor meta) but
  // also gets the dp-card class added by _populateDpCardSlot for sizing.
  const variantCls = (rich && !dpVariant) ? ' card-rich' : ' card-compact';

  // Conditional pill row — variable card heights. Cards without pills
  // collapse to row1 + meta + fill bar; cards with pills grow.
  const pillsRowHtml = pillsHtml ? `<div class="card-pills">${pillsHtml}</div>` : '';

  // dpVariant: detail-panel "sun summary" card. Title + meta have moved up
  // into the photo overlay, so this card focuses only on the sun-status
  // story: headline (e.g. "Sol til 14:30") + sub ("2t 15m igjen") + pills
  // + timeline. State class still applied so existing CSS keeps working.
  if (dpVariant) {
    const dpState = (typeof venueState === 'function') ? venueState(v, fromHour) : null;
    // Single source of truth for every value on this card, so the big "left"
    // number and the event pills always agree (the previous mismatch).
    const fmtH = (h) => (typeof formatHour === 'function') ? formatHour(h) : `${Math.floor(h)}:00`;
    const _hu = (typeof t === 'function') ? t('unit_h_short') : 't';
    const fmtDur = (hrs) => { const h = Math.floor(hrs), m = Math.round((hrs - h) * 60); return h > 0 ? (m > 0 ? `${h}${_hu} ${m}m` : `${h}${_hu}`) : `${Math.max(1, m)}m`; };
    const _t = (k, p, fb) => (typeof t === 'function') ? t(k, p) : fb;
    const _leftWord = _t('word_left', null, 'igjen');
    const _sunTitle = _t('sun_conditions', null, 'Solforhold');
    let wins = [];
    try { wins = (computeSunWindows(v, dateStr).windows) || []; } catch (e) { /* no sun data */ }
    const nowH = fromHour;
    const sundownH = (typeof currentSunTable !== 'undefined' && currentSunTable && typeof findSunCrossingFromTable === 'function')
      ? findSunCrossingFromTable(currentSunTable, false) : null;
    // Venue closing hour for the day — drives the "closing vs sundown" end pill.
    let closeH = null;
    try { const _dh = getVenueHoursForDay(v, dateStr); if (_dh && _dh.close != null) closeH = _dh.close; } catch (e) { /* no hours */ }
    const cur = wins.find(w => nowH >= w.start && nowH < w.end);
    const nextWin = wins.find(w => w.start > nowH);

    const sunG   = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
    const sunSm  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
    const shadeG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>`;
    const moonG  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>`;
    const clockG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

    // Bigger moon glyph for the closed hero — matches sunG's 20×20 footprint
    // so the icon+verdict pair reads at the same scale as the open card.
    const moonGBig = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>`;

    // LEFT: section title (top) + the big "X left" verdict (bottom, so it sits
    // level with the lowest event pill). Shadow/done states show the verdict.
    // Closed venues mirror the open structure (icon + short word) so both
    // states read at the same scale; the "opens at" time moves into a pill.
    let leftBody;
    if (cur) {
      leftBody = `<div class="dp-sun-now-main">${sunG}<span class="dp-sun-now-val">${fmtDur(Math.max(5/60, cur.end - nowH))}</span> <span class="dp-sun-now-word">${_leftWord}</span></div>`;
    } else if (dpState?.state === 'closed') {
      leftBody = `<div class="dp-sun-now-main dp-sun-now-main-closed">${moonGBig}<span class="dp-sun-now-val">${_t('state_closed', null, 'Closed')}</span></div>`;
    } else {
      leftBody = `<div class="dp-sun-now-verdict">${dpState?.mainText || '—'}</div>${dpState?.subText ? `<div class="dp-sun-now-label">${dpState.subText}</div>` : ''}`;
    }
    const leftHtml = `<div class="dp-sun-now"><div class="dp-sun-title">${_sunTitle}</div>${leftBody}</div>`;

    // RIGHT (pills): chronologically-sorted event list, locked to 2 visible
    // pills (PR D v5 design fix per user). When more than 2 events exist the
    // second slot becomes a "+N hendelser" overflow pill that opens an
    // expanded popover on tap. Fixed pill count keeps the card height
    // stable across FTS scrubs so the playhead never jumps under the user's
    // finger.
    let openHForPill = null;
    try { const _dh2 = getVenueHoursForDay(v, dateStr); if (_dh2 && _dh2.open != null) openHForPill = _dh2.open; } catch (e) { /* no hours */ }
    // Collect events as { hour, html } so we can sort + cap deterministically.
    const eventDescriptors = [];
    if (dpState?.state === 'closed' && openHForPill != null && nowH < openHForPill) {
      eventDescriptors.push({
        hour: openHForPill,
        html: `<span class="dp-evt dp-evt-clock">${clockG}${_t('dp_evt_opens_at', { time: fmtH(openHForPill) }, fmtH(openHForPill))}</span>`,
      });
    }
    if (cur && (sundownH == null || cur.end < sundownH - 0.01)) {
      eventDescriptors.push({
        hour: cur.end,
        html: `<span class="dp-evt dp-evt-shade">${shadeG}${_t('dp_evt_shade', { time: fmtH(cur.end) }, fmtH(cur.end))}</span>`,
      });
    } else if (!cur && nextWin) {
      eventDescriptors.push({
        hour: nextWin.start,
        html: `<span class="dp-evt dp-evt-bonus">${sunSm}${_t('state_sun_from', { time: fmtH(nextWin.start) }, fmtH(nextWin.start))}</span>`,
      });
    }
    wins.filter(w => w.start > ((cur ? cur.end : (nextWin ? nextWin.start : nowH)) + 0.01)).slice(0, 2).forEach(w => {
      const oppTxt = (typeof t === 'function')
        ? t('card_opp_one', { dur: fmtDur(w.end - w.start), time: fmtH(w.start) })
        : `+${fmtDur(w.end - w.start)} fra ${fmtH(w.start)}`;
      eventDescriptors.push({
        hour: w.start,
        html: `<span class="dp-evt dp-evt-bonus">${oppTxt}</span>`,
      });
    });
    if (closeH != null && (sundownH == null || closeH < sundownH - 0.01)) {
      eventDescriptors.push({
        hour: closeH,
        html: `<span class="dp-evt dp-evt-moon">${clockG}${_t('dp_evt_closing', { time: fmtH(closeH) }, fmtH(closeH))}</span>`,
      });
    } else if (sundownH != null) {
      eventDescriptors.push({
        hour: sundownH,
        html: `<span class="dp-evt dp-evt-moon">${moonG}${_t('dp_evt_sundown', { time: fmtH(sundownH) }, fmtH(sundownH))}</span>`,
      });
    }
    // Sort chronologically and cap to 2 slots. If more exist, the 2nd slot
    // becomes the overflow pill; full list lives in data-dp-events for the
    // expand popover.
    eventDescriptors.sort((a, b) => a.hour - b.hour);
    let evs = [];
    if (eventDescriptors.length <= 2) {
      evs = eventDescriptors.map(e => e.html);
    } else {
      const moreCount = eventDescriptors.length - 1;
      const moreLabel = _t('dp_evt_more', { count: moreCount }, `+${moreCount} mer`);
      evs = [
        eventDescriptors[0].html,
        `<button type="button" class="dp-evt dp-evt-more" data-vid="${v.id}"><span>${moreLabel}</span></button>`,
      ];
    }
    // Serialize the full list onto the wrapper for the click-to-expand
    // popover handler to pick up — keeps the DOM small and stable while
    // making the data available without recomputation on tap.
    const eventsPayload = (typeof JSON !== 'undefined')
      ? JSON.stringify(eventDescriptors.map(e => e.html))
      : '';

    // Encode the payload for the data attribute (escape quotes + brackets).
    const _esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <div class="venue-card card-compact ${stateClass}${flags ? ' review-flagged' : ''}${auditCardCls}"
           data-vid="${v.id}" data-dp-events="${_esc(eventsPayload)}">
        <div class="dp-sun-row">
          ${leftHtml}
          ${evs.length ? `<div class="dp-sun-events">${evs.join('')}</div>` : ''}
        </div>
        ${timelineBlock}
        ${reviewChips}
        ${auditActionsHtml}
      </div>`;
  }

  // ── Compact AUDIT card — purpose-built for the catalog walk-through ──────
  // Just what the reviewer needs: name + icon actions on one row, location +
  // category on the next, then the flags. No sun story, no fill bar, no left
  // accent bar. Clicking it focuses the venue on satellite (auditFocusVenue),
  // it does NOT open the detail panel.
  if (_auditHere && !rich && !dpVariant) {
    const idArg = (typeof v.id === 'number') ? v.id : `'${v.id}'`;
    const esc = (typeof _esc === 'function') ? _esc : ((x) => x);
    const nm = (typeof splitVenueName === 'function') ? splitVenueName(v) : { name: v.name, fine: '', coarse: v.area || '' };
    const loc = [nm.fine || nm.coarse, catLabel(v)].filter(Boolean).join(' · ');
    const focused = (typeof window !== 'undefined' && window._auditFocusId === v.id) ? ' audit-focus' : '';
    // Live collaboration: another admin currently editing this venue.
    const editingBy = (typeof auditEditingBy === 'function') ? auditEditingBy(v.id) : null;
    const lockHtml = editingBy
      ? `<div class="ac-lock" title="${esc(editingBy)} is editing this venue">${esc(editingBy)} redigerer…</div>` : '';
    // Last reviewed/edited by whom (from shared audit state).
    const _entry = (typeof venueAuditEntry === 'function') ? venueAuditEntry(v) : null;
    const by = _entry?.by || (v.auditArchived && typeof venueArchiveEntry === 'function' ? venueArchiveEntry(v)?.by : null);
    const byHtml = by ? `<div class="ac-by">Sist: ${esc(by)}</div>` : '';
    return `
    <div class="venue-card audit-card${auditCardCls}${focused}${editingBy ? ' audit-locked' : ''}"
         data-vid="${v.id}" onclick="auditFocusVenue(${idArg})">
      <div class="ac-top">
        <div class="ac-name">${esc(nm.name)}</div>
        ${auditActionsHtml}
      </div>
      ${loc ? `<div class="ac-meta">${esc(loc)}</div>` : ''}
      ${lockHtml}
      ${reviewChips}
      ${byHtml}
    </div>`;
  }

  // ── Compact LIST card — deterministic 3-row layout ──────────────────────
  // row1: split name | sun + duration; row2: dept/street/area(muted) | anchor
  // (close-aware); row3: cat · walk · distance(muted) | shade event; lifted
  // fill bar. Fixed shape so the skeleton matches and the height never jumps.
  if (!rich && !dpVariant) {
    const idArg = (typeof v.id === 'number') ? v.id : `'${v.id}'`;
    const esc = (typeof _esc === 'function') ? _esc : ((x) => x);
    const nm = (typeof splitVenueName === 'function') ? splitVenueName(v) : { name: v.name, fine: '', coarse: v.area || '' };
    const walkMin = _cardWalkMin(s);
    const shadeStr = _shadeSummary(qual);
    // Sun footnote: shade gap takes the slot; otherwise a sun opportunity.
    const oppStr = shadeStr ? '' : _sunOpportunity(qual);
    const anchor = (qual && qual.surfaced && typeof formatAnchor === 'function')
      ? formatAnchor(qual, bucket, sundownH, dateStr) : '';
    const closesBinding = !!(geometricEndAfterClose && qual && qual.earliest
      && qual.earliest.end <= dayHours.close + 0.001);
    return `
    <div class="venue-card ${stateClass} card-compact card-3row ${v.id === selectedId ? 'selected' : ''}${flags ? ' review-flagged' : ''}${auditCardCls}"
         data-vid="${v.id}" onclick="selectVenue(${idArg}, true)"
         onmouseenter="setHoveredVenue(${idArg})" onmouseleave="setHoveredVenue(null)">
      <div class="card-row1">
        <div class="card-name">${esc(nm.name)}${favHeart}${friendBadge}${goingBadge}</div>
        ${durationStr ? `<div class="card-duration">${SUN_GLYPH}${durationStr}</div>` : ''}
      </div>
      <div class="card-row2">
        <span class="card-sub">${nm.fine
          ? `<span class="card-sub-fine">${esc(nm.fine)}</span><span class="card-sub-sep">·</span><span class="card-sub-coarse">${esc(nm.coarse)}</span>`
          : `<span class="card-sub-fine">${esc(nm.coarse)}</span>`}</span>
        ${anchor ? `<span class="card-anchor${closesBinding ? ' card-anchor-closes' : ''}">${anchor}</span>` : ''}
      </div>
      <div class="card-row3">
        <span class="card-meta-left">
          <span class="card-cat">${esc(catLabel(v))}</span>
          ${walkMin != null ? `<span class="card-meta-dot">·</span><span class="card-walk">${WALK_GLYPH}${walkMin} min</span>` : ''}
          ${distStr ? `<span class="card-meta-dot">·</span><span class="card-dist">${esc(distStr)}</span>` : ''}
        </span>
        ${shadeStr
          ? `<span class="card-disrupt card-disrupt-shade">${shadeGlyph()}${shadeStr}</span>`
          : (oppStr ? `<span class="card-disrupt card-disrupt-sun">${oppStr}</span>` : '')}
      </div>
      ${reviewChips}
      ${auditActionsHtml}
      ${fillBarHtml}
    </div>`;
  }

  return `
    <div class="venue-card ${stateClass}${variantCls} ${v.id === selectedId ? 'selected' : ''}${flags ? ' review-flagged' : ''}${auditCardCls}"
         data-vid="${v.id}" onclick="selectVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`}, true)"
         onmouseenter="setHoveredVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`})" onmouseleave="setHoveredVenue(null)">
      <div class="card-row1">
        <div class="card-name">${v.name}${favHeart}${friendBadge}${goingBadge}</div>
        ${durationStr ? `<div class="card-duration">${SUN_GLYPH}${durationStr}</div>` : ''}
      </div>
      <div class="card-meta">${metaHtml}</div>
      ${pillsRowHtml}
      ${timelineBlock}
      ${reviewChips}
      ${auditActionsHtml}
      ${fillBarHtml}
    </div>`;
}

/**
 * Compact venue card for surfaces that need the same name/area/sun-state visual
 * language as the list card without the timeline strip, fav heart, friend dots,
 * or click/hover behavior. Used by the invite sheet so its venue header stays
 * pinned to the same design system as the list — any future styling change to
 * .venue-card / .card-new-* automatically flows through.
 *
 * Reuses .venue-card + .card-top + .card-left/.card-right + .card-new-name /
 * -meta / -hero-main / -hero-sub, plus venueState() for hero text.
 */
function renderVenueCardCompact(v, dateStr, fromHour) {
  if (!v) return '';
  const dayHours = (typeof getVenueHoursForDay === 'function')
    ? getVenueHoursForDay(v, dateStr)
    : { open: 0, close: 24 };
  const isOpen        = (fromHour >= dayHours.open && fromHour <= dayHours.close);
  const isOpeningSoon = (!isOpen && (dayHours.open - fromHour) > 0 && (dayHours.open - fromHour) <= 0.75);

  if (!isOpen && !isOpeningSoon) {
    return `<div class="venue-card compact-card closed-card" data-vid="${v.id}">
      <div class="closed-row">
        <span class="closed-name">${v.name}</span>
        <span class="card-badge shaded">${t('opens_at', { time: formatHour(dayHours.open) })}</span>
      </div>
    </div>`;
  }

  const state = (typeof venueState === 'function')
    ? venueState(v, fromHour)
    : { state: 'sun', mainText: '', subText: '', className: 'state-sun' };
  const metaParts = [v.area, (typeof catLabel === 'function' ? catLabel(v) : null)].filter(Boolean);
  const metaHtml = metaParts.map((p, i) =>
    (i > 0 ? '<span class="card-meta-dot">·</span>' : '') + `<span>${p}</span>`
  ).join('');

  return `<div class="venue-card compact-card ${state.className}" data-vid="${v.id}">
      <div class="card-top">
        <div class="card-left">
          <div class="card-new-name">${v.name}</div>
          <div class="card-new-meta">${metaHtml}</div>
        </div>
        <div class="card-right">
          <div class="card-new-hero-main">${state.mainText}</div>
          <div class="card-new-hero-sub">${state.subText}</div>
        </div>
      </div>
    </div>`;
}

/**
 * Append the next page of cards to #venue-list.
 *
 * Soft Zebra layout: emits a future-time chip (when off-now), then both
 * section headers ("Sol nå · n" / "Sol senere · m"), each followed by their
 * cards or an inline empty-state. Empty section headers never collapse.
 *
 * Pagination spans both buckets: `_listFiltered` is `now` followed by `later`,
 * and `_listBuckets.now.length` marks the boundary.
 */
function renderListPage(list, dateStr, fromHour, toHour, isPoint, reset) {
  if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }

  const from = reset ? 0 : list.querySelectorAll('.venue-card').length;
  const to   = Math.min(from + LIST_PAGE, _listFiltered.length);

  const nowCount   = _listBuckets.now.length;
  const laterCount = _listBuckets.later.length;
  // Surface a "now" section header when this page touches the now bucket
  // AND a "later" section header when it touches the later bucket. Only
  // emit each one ONCE per render — if a later page picks up later
  // venues, no header is needed (the boundary was already drawn).
  const showNowHeader   = from === 0          && nowCount   > 0;
  const showLaterHeader = from < nowCount + laterCount
                       && to   > nowCount     && laterCount > 0;
  // Future-mode? Same phrasing logic as the day-header.
  const isFutureMode = (typeof nowMode !== 'undefined' && !nowMode &&
                        dateStr === todayStr() &&
                        Math.abs(fromHour - currentHour()) > 5/60)
                    || dateStr > todayStr();
  const _auditList = typeof auditModeActive !== 'undefined' && auditModeActive;
  // When the "Venner" filter has split the buckets into friends / everyone-else
  // (and friends actually exist), relabel the two section headers accordingly.
  const _friendsList = !_auditList && nowCount > 0
    && !!(window._activeFilters && window._activeFilters.friends)
    && _listBuckets.now.every(v => v._hasFriends);
  const nowHeaderTxt   = _auditList ? `Til vurdering · ${nowCount}`
                                    : _friendsList ? t('section_friends')
                                    : (isFutureMode ? t('section_sun_at',    { time: formatHour(fromHour) }) : t('section_sun_now'));
  const laterHeaderTxt = _auditList ? `Vurdert · ${laterCount}`
                                    : _friendsList ? t('section_friends_other')
                                    : (isFutureMode ? t('section_sun_after', { time: formatHour(fromHour) }) : t('section_sun_later'));

  let html = '';

  // Cards in render order: indices 0..nowCount-1 are "now", rest are "later".
  // Section headers are emitted at the boundary so the user always knows
  // which bucket they're scrolling through.
  for (let i = from; i < to; i++) {
    if (i === 0 && showNowHeader) {
      html += `<div class="venue-section-header">${nowHeaderTxt}</div>`;
    }
    if (i === nowCount && showLaterHeader) {
      html += `<div class="venue-section-header">${laterHeaderTxt}</div>`;
    }
    html += renderCard(_listFiltered[i], dateStr, fromHour, toHour, isPoint);
  }

  if (reset) {
    // Stash + restore scrollTop so periodic re-renders (slider tick, nowMode
    // 30s tick) don't snap the list back to top under the user.
    const savedScroll = list.scrollTop;
    // Detect whether the card SET changed — slider scrubs typically render
    // the same venues at a new time (same set; same hash). Date changes,
    // sort changes, filter changes, and panel-open-from-hidden change the
    // set. Re-fire the cardIn animation only on actual set changes so the
    // list doesn't strobe on every slider tick.
    const _hashOf = (items, n) => {
      const k = Math.min(items.length, n);
      let s = items.length + '|';
      for (let i = 0; i < k; i++) s += items[i].id + ',';
      return s;
    };
    const newHash = _hashOf(_listFiltered, 6);
    const contentChanged = list.dataset.contentHash !== newHash;
    list.innerHTML = html;
    if (savedScroll) list.scrollTop = savedScroll;
    if (!list.dataset.mounted) {
      // First-ever mount: schedule the data-mounted flag for the next
      // frame so the initial cardIn cascade fires across the new cards.
      requestAnimationFrame(() => { list.dataset.mounted = '1'; });
    } else if (contentChanged && !window._renderListSilent) {
      // Set actually changed (date / sort / filter / hidden→expanded
      // panel open). Re-fire the cardIn cascade by toggling
      // data-mounted off → on across two frames so CSS picks up the
      // animation restart on the new cards.
      // _renderListSilent suppresses the re-fire for renders that correct
      // values in place (e.g. the boot sun-worker result) — the cards are
      // already on screen, so re-animating them reads as a flash.
      delete list.dataset.mounted;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { list.dataset.mounted = '1'; });
      });
    }
    list.dataset.contentHash = newHash;
  } else {
    // Suppress entry animation for scroll-paginated cards
    list.setAttribute('data-no-anim', '');
    document.getElementById('list-sentinel')?.remove();
    list.insertAdjacentHTML('beforeend', html);
    // Re-enable animation after current frame so future resets still animate
    requestAnimationFrame(() => list.removeAttribute('data-no-anim'));
    // Avstand zoom-out is driven by the scroll handler (_avstandTrackScroll)
    // for smooth continuous tracking, not per-batch jumps.
  }
  // Paint the canvas-based mini-timelines now that the cards are in the DOM.
  // Use rAF so layout has settled and clientWidth/Height are non-zero.
  requestAnimationFrame(() => drawAllCardTimelines(list));

  // Closed-cards toggle: hidden by default via CSS. If the current page
  // surfaced any closed-day venues and the user hasn't already toggled
  // them on, drop a small bottom-of-list toggle that reveals them.
  // Re-mount on every reset so the count stays accurate after slider /
  // date / area changes.
  if (reset && !document.body.classList.contains('show-closed')) {
    document.getElementById('closed-toggle')?.remove();
    const closedCount = list.querySelectorAll('.venue-card.closed-card').length;
    if (closedCount > 0) {
      const label = (typeof t === 'function')
        ? t('show_closed_venues', { count: closedCount })
        : `Vis ${closedCount} lukkede steder`;
      list.insertAdjacentHTML('beforeend', `
        <button id="closed-toggle" type="button" onclick="document.body.classList.add('show-closed'); this.remove();">
          ${label}
        </button>`);
    }
  }

  // Attach sentinel + observer if more cards remain
  if (to < _listFiltered.length) {
    list.insertAdjacentHTML('beforeend', '<div id="list-sentinel" style="height:1px"></div>');
    _listObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) renderListPage(list, dateStr, fromHour, toHour, isPoint, false);
    }, { root: list.closest('#panel'), rootMargin: '200px' });
    _listObserver.observe(document.getElementById('list-sentinel'));
  } else if (_hasOutsideMore) {
    // Short-list mode only: the in-viewport set is too small to scroll-
    // paginate naturally, so we render a small chevron-style indicator at
    // the bottom. Tap loads the next nearest batch and nudges the map
    // outward by just enough to show it. (Drag-up gesture removed — it
    // conflicted with the bottom-sheet panel drag on mobile.) In long-list
    // mode outside venues are already in the list and load silently as
    // the user scrolls — _hasOutsideMore stays false.
    list.insertAdjacentHTML('beforeend', `
      <button id="list-expand-tab" type="button" onclick="_expandList()">
        <svg class="list-expand-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6"/>
        </svg>
        <span class="list-expand-label">${t('list_expand_more')}</span>
      </button>
    `);
  }
}

/**
 * Empty-state CTA: the user clicks "Vis alle steder" when no venues are
 * currently surfaced (rain everywhere, after sunset bypass). Force the
 * list into fully-expanded mode so every venue appears regardless of
 * viewport, and bypass the qualifying-window filter once so we genuinely
 * show all venues. The map auto-fits to the assembled list afterward.
 */
function showAllVenuesOnce() {
  _showAllOnce = true;
  _expansionPages = 999; // effectively unlimited; sliced against actual outside set length
  if (typeof scheduleRenderList === 'function') scheduleRenderList();
  else if (typeof renderList === 'function') renderList();
  if (typeof _autoFitMap === 'function') _autoFitMap(_lastRenderedVenues);
}

/**
 * Pull-tab handler: widen the search by one page (~LIST_PAGE venues) outside
 * the current viewport, then nudge the map outward just enough to include the
 * newly-added batch. Diff-based: we capture the set before re-rendering and
 * fit bounds to (current viewport + freshly-added venues), so successive
 * clicks grow the map incrementally instead of leaping to all-of-city.
 *
 * The drag-up gesture was removed because it conflicted with the panel's
 * own bottom-sheet drag — a touch sequence at the end of the list could
 * fire both. Click is the only entry point now.
 */
function _expandList() {
  const prevIds = new Set(_lastRenderedVenues.map(v => v.id));
  _expansionPages++;
  if (typeof renderList === 'function') renderList();
  const newlyAdded = _lastRenderedVenues.filter(v => !prevIds.has(v.id));
  if (newlyAdded.length && typeof _autoFitToBatch === 'function') {
    _autoFitToBatch(newlyAdded);
  }
}

/**
 * Primary CTA on the consolidated empty state ("Se i morgen"): jump to
 * tomorrow at 09:00 and let the recompute decide whether the next day is
 * populated. 09:00 is early enough that any morning sun lands inside the
 * remaining-day window; the spec also accepts "first sun, whichever is
 * later", but resolving "first sun" requires a full sun-table build that
 * advanceDay() will trigger anyway via the date-change event.
 */
function seeTomorrow() {
  if (typeof advanceDay === 'function') advanceDay(1, 9);
}

function renderList() {
  const list = document.getElementById('venue-list');
  if (!currentSun) return;
  // Boot-reveal skeleton hold: keep the skeletons until the choreography swaps
  // them for real cards (window._revealSkeletonHold is cleared there).
  if (window._revealSkeletonHold) return;

  const dateStr  = datePicker.value;
  const fromHour = parseFloat(timeFromEl.value);
  const toHour   = fromHour; // single slider — always point mode
  const isPoint  = true;

  const searchQ = (document.getElementById('venue-search')?.value ?? '').trim().toLowerCase();
  const sortBy  = activeSortBy;

  // ── Cheap filters first, expensive solar/score work after ─────────────────
  // Filtering on raw VENUES before mapping avoids running computeVenueScore
  // and venueHasSunInRange on venues that the search/area/viewport will drop.
  let venues = VENUES;

  // Admin "Review" mode — keep only venues with review flags. Dominates
  // every other filter while active.
  if (typeof reviewModeActive !== 'undefined' && reviewModeActive &&
      typeof venueReviewFlags === 'function') {
    venues = venues.filter(v => venueReviewFlags(v));
  }

  // Admin "Audit" mode — show *every* venue alphabetically by area + name
  // so the admin can walk the catalog and tick off each polygon. Bypasses
  // search/area/viewport/surfacing entirely.
  const auditActive = typeof auditModeActive !== 'undefined' && auditModeActive;

  // Outside audit mode, archived venues are hidden from the list.
  if (!auditActive) venues = venues.filter(v => !v.auditArchived);

  if (searchQ && !auditActive) {
    const alias = typeof _resolveAlias === 'function' ? _resolveAlias(searchQ) : null;
    // Diacritics-stripped comparison only matters for ≥3-char queries; for
    // 1-2 chars plain .includes() already covers everything (mirrors
    // _matchScore's early-out in the dropdown).
    const useDia = searchQ.length >= 3 && typeof _stripDiacritics === 'function';
    const qNorm  = useDia ? _stripDiacritics(searchQ) : null;
    venues = venues.filter(v => {
      if (v.name.toLowerCase().includes(searchQ)) return true;
      if ((v.area ?? '').toLowerCase().includes(searchQ)) return true;
      if (v.address.toLowerCase().includes(searchQ)) return true;
      if (alias && (v.area ?? '').toLowerCase() === alias) return true;
      if (useDia) {
        if (_stripDiacritics(v.name.toLowerCase()).includes(qNorm)) return true;
        if (_stripDiacritics((v.area ?? '').toLowerCase()).includes(qNorm)) return true;
      }
      return false;
    });
  }
  if (activeArea && !auditActive) venues = venues.filter(v => v.area === activeArea);
  // Panel action-row filter pills (Stage 2c)
  if (!auditActive && typeof window._passesActiveFilters === 'function') {
    venues = venues.filter(window._passesActiveFilters);
  }
  // Favorites filtering is handled by sortBy === 'favorites' below

  // Compute the viewport bounds (with 20% pad) once. Used both to filter
  // in viewport mode and to partition the surfaced set in long-list mode
  // (so outside venues can be appended sorted by distance from viewport
  // center). filterMapViewActive is normally true; the gate is kept as an
  // escape valve in case it's ever toggled off programmatically.
  let _viewportBounds = null;
  if (filterMapViewActive && !auditActive) {
    // While a venue is selected, keep the list frozen at the pre-zoom viewport
    const bounds = (selectedId != null && _frozenBounds) ? _frozenBounds : map.getBounds();
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const dlat = (ne.lat - sw.lat) * 0.2, dlng = (ne.lng - sw.lng) * 0.2;
    _viewportBounds = new mapboxgl.LngLatBounds(
      [sw.lng - dlng, sw.lat - dlat],
      [ne.lng + dlng, ne.lat + dlat]
    );
  }

  // ── Now compute sun windows + score on the narrowed set ───────────────────
  const wxNow = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  // Hysteresis: clear the surfaced set on date change so yesterday's sticky
  // entries don't bleed into today.
  if (_surfacedDateStr !== dateStr) {
    _surfacedSet.clear();
    _surfacedDateStr = dateStr;
  }
  // Sundown anchor for window clamping. Falls back to a sane default when
  // the table isn't built yet (first paint).
  const sundownH = (typeof currentSunTable !== 'undefined' && currentSunTable && typeof findSunCrossingFromTable === 'function')
    ? (findSunCrossingFromTable(currentSunTable, false) ?? 22) : 22;
  // Weather lookup memoized per renderList pass — qualifyingWindows() probes
  // it at hour granularity, so reusing per integer hour avoids redundant
  // getWeatherAt calls across 300 venues.
  const _wxCache = new Map();
  const wxLookup = (h) => {
    const hb = Math.floor(h);
    if (!_wxCache.has(hb)) {
      const b = (typeof wxBucket === 'function') ? wxBucket(dateStr, hb + 0.5) : null;
      _wxCache.set(hb, { rainy: b === 'regn', overcast: b === 'skyer' });
    }
    return _wxCache.get(hb);
  };
  // Distance reference for the "Beste treff" relevance score: real GPS when
  // available, else fall back to the venue cluster center so ordering still
  // means something city-wide.
  const _matchRef = userLocation
    || ((typeof VENUE_CLUSTER !== 'undefined' && VENUE_CLUSTER.center) || null);
  venues = venues.map(v => {
    const sunInWin = venueHasSunInRange(v, dateStr, fromHour, toHour);
    const { open, close } = getVenueHoursForDay(v, dateStr);
    const isOpen        = fromHour >= open && fromHour <= close;
    const isOpeningSoon = !isOpen && (open - fromHour) > 0 && (open - fromHour) <= 0.75;
    const isClosingSoon = isOpen  && (close - fromHour) > 0 && (close - fromHour) <= 0.5;
    const score = typeof computeVenueScore === 'function'
      ? computeVenueScore(v, dateStr, fromHour, wxNow, userLocation)
      : null;
    // Qualifying windows: weather-gated, 45-min floor, gaps absorbed/split,
    // hysteresis applied. This is what drives surfacing and bucketing.
    const { windows: rawWins } = (typeof computeSunWindows === 'function')
      ? computeSunWindows(v, dateStr) : { windows: [] };
    const qual = (typeof qualifyingWindows === 'function')
      ? qualifyingWindows(rawWins, wxLookup, {
          selectedHour: fromHour, sundownHour: sundownH,
          openHour: open, closeHour: close,
          prevSurfaced: _surfacedSet.has(v.id),
        })
      : { windows: [], earliest: null, surfaced: false };
    // Beste treff blends sun and walk distance: each km costs 20 minutes of
    // sun. Effective sun is capped at 180 min (~3h) — that's a long café
    // session; beyond it, more sun has no practical value, and without the
    // cap distant high-sun venues outrank closer venues with "enough" sun.
    // With the cap, once you've got 3h of sun, distance becomes decisive.
    const _MAX_REL_SUN_MIN = 180;
    const _qualDurMin = qual.earliest?.durationMin ?? 0;
    const _effSunMin  = Math.min(_qualDurMin, _MAX_REL_SUN_MIN);
    const _distKm = (score && score.distKm != null)
      ? score.distKm
      : (_matchRef ? _haversineKm(_matchRef, v) : 0);
    const _relevanceMin = _effSunMin - _distKm * 20;
    // Friend presence (checked-in friends or a live plan) — drives the
    // "Venner" filter's friends-on-top prioritisation.
    const _hasFriends = (typeof window.venueHasFriends === 'function')
      ? window.venueHasFriends(v) : false;
    // Pass raw windows through to renderCard so the v2 pill builder can
    // detect Åpner/Stenger binding-hours pills without recomputing.
    return { ...v, sunInWin, isOpen, isOpeningSoon, isClosingSoon, score, _qual: qual, _rawWindows: rawWins, _relevanceMin, _hasFriends };
  });

  // Surfacing filter — qualifying windows + own-suggestion bypass + the
  // search bypass (any venue matched by the active query stays visible) +
  // the user's "vis alle" escape hatch + admin review mode.
  const reviewActive = typeof reviewModeActive !== 'undefined' && reviewModeActive;
  const showAllPass = _showAllOnce; _showAllOnce = false;
  // Audit "Alle" sub-mode shows the full catalog (ignore sun); "Skygger"
  // applies the normal sun-surfacing filter so the list mirrors the shadow
  // simulation. Outside audit, the filter always applies.
  const _auditAll = auditActive
    && (typeof auditSubMode === 'undefined' || auditSubMode === 'all');
  if (!showAllPass && !reviewActive && !_auditAll) {
    venues = venues.filter(v => {
      if (v._ownSuggestion) return true;
      if (searchQ) return true; // search results bypass the filter
      return v._qual && v._qual.surfaced;
    });
  }

  // Update the surfacing memory for next pass (hysteresis).
  for (const v of venues) {
    if (!v._qual) continue;
    const dur = v._qual.earliest?.durationMin ?? 0;
    if (v._qual.surfaced && dur >= 45) _surfacedSet.add(v.id);
    else if (!v._qual.surfaced || dur < 40) _surfacedSet.delete(v.id);
  }

  // Two-mode pipeline.
  //
  // Beste treff (sortBy === 'match') uses a *promote* model: viewport filter
  // is OFF, so the list always carries every surfaced venue ranked globally
  // by relevance. Panning the map (or hitting locate-me) tags in-viewport
  // venues so they bubble to the top of each bucket; below them the list
  // continues with the global Beste treff order. No pull-tab, no auto-zoom
  // — Beste treff is "find me the best place anywhere," and the user can
  // scroll past the local picks into the broader city without an interrupt.
  //
  // Other sorts (Avstand, Mest sol, Ølpris, Favoritter) use a *filter* model:
  //   Long-list mode (in-viewport ≥ MIN_VIEWPORT_LIST): include outside venues
  //   sorted by distance from viewport center, so scroll pagination auto-loads
  //   the next nearest ring once the in-viewport set runs out.
  //   Short-list mode (in-viewport < MIN_VIEWPORT_LIST): pull-tab gates the
  //   next batch, and the map nudges outward by just enough to include it.
  const MIN_VIEWPORT_LIST = 5;
  _hasOutsideMore = false;
  if (_viewportBounds) {
    if (sortBy === 'match') {
      // Promote model: tag and let the comparator do the work.
      venues = venues.map(v => ({
        ...v,
        _inViewport: _viewportBounds.contains([v.lng, v.lat]),
      }));
    } else {
      const _inV  = venues.filter(v =>  _viewportBounds.contains([v.lng, v.lat]));
      const _outV = venues.filter(v => !_viewportBounds.contains([v.lng, v.lat]));
      // Sort outside venues by distance from viewport center so the next batch
      // is always the next nearest ring — keeps map auto-fit zooming gradually
      // outward instead of leaping to scattered far venues with high sun.
      if (_outV.length) {
        const c = _viewportBounds.getCenter();
        const cRef = { lat: c.lat, lng: c.lng };
        _outV.sort((a, b) => _haversineKm(cRef, a) - _haversineKm(cRef, b));
      }
      if (_inV.length >= MIN_VIEWPORT_LIST) {
        // Long-list: scroll pagination crosses the viewport boundary silently.
        venues = [..._inV, ..._outV];
      } else if (_expansionPages === 0) {
        // Short-list, not yet expanded — pull-tab gates the next batch.
        venues = _inV;
        _hasOutsideMore = _outV.length > 0;
      } else {
        // Short-list, mid-expansion — show the slices already pulled in plus
        // the gate for the next one (if any remain).
        const take = _expansionPages * LIST_PAGE;
        venues = [..._inV, ..._outV.slice(0, take)];
        _hasOutsideMore = _outV.length > take;
      }
    }
  }

  // Closed venues always sink below open ones regardless of sort mode
  function closedPenalty(v) { return (!v.isOpen && !v.isOpeningSoon) ? 1 : 0; }

  // Reference point for distance-based sorting. When the user is near the
  // venue cluster, "distance" means "from you." When the user is far away
  // (or GPS is unknown), it means "from the cluster center" — derived from
  // venue data so the subsystem stays city-agnostic.
  const farFromCluster = typeof _isFarFromCluster === 'function' && _isFarFromCluster();
  const distRef = (userLocation && !farFromCluster)
    ? userLocation
    : (typeof VENUE_CLUSTER !== 'undefined' && VENUE_CLUSTER.radiusKm
        ? VENUE_CLUSTER.center
        : userLocation);

  // Favorites is filter-first, then sorted within buckets like any other view.
  if (sortBy === 'favorites' && typeof isFavorite === 'function') {
    venues = venues.filter(v => isFavorite(v.id));
  }

  // Bucket: Sol nå = qualifying window already started; Sol senere = starts
  // after selectedHour. Sort each bucket independently so the in-bucket sort
  // semantics can differ for the default ("score") path.
  const bucketNow = [];
  const bucketLater = [];
  for (const v of venues) {
    if (!v._qual || !v._qual.earliest) {
      // Search bypass / show-all / review mode can yield venues without a
      // qualifying window. Stash them in "later" so they still appear.
      bucketLater.push(v);
      continue;
    }
    if (v._qual.earliest.start <= fromHour + 0.001) bucketNow.push(v);
    else bucketLater.push(v);
  }

  const distOf  = (v) => distRef ? Math.hypot(v.lat - distRef.lat, v.lng - distRef.lng) : 0;
  const qualDur = (v) => v._qual?.earliest?.durationMin ?? 0;
  const comparator = (a, b) => {
    const cp = closedPenalty(a) - closedPenalty(b);
    if (cp !== 0) return cp;
    if (sortBy === 'distance' && distRef) {
      const da = distOf(a), db = distOf(b);
      if (da !== db) return da - db;
      return qualDur(b) - qualDur(a);
    }
    if (sortBy === 'beer') {
      if (a.beerPrice && !b.beerPrice) return -1;
      if (!a.beerPrice && b.beerPrice) return 1;
      if (!a.beerPrice && !b.beerPrice) return b.rating - a.rating;
      return a.beerPrice - b.beerPrice;
    }
    if (sortBy === 'favorites') {
      if (distRef) {
        const da = distOf(a), db = distOf(b);
        if (da !== db) return da - db;
      }
      return qualDur(b) - qualDur(a);
    }
    // Default ("Mest sol" / "Most sun") — most qualifying-window sun first,
    // distance as tiebreaker. Same comparator across buckets — the bucket
    // headers carry the temporal split so the ranker doesn't need to.
    if (qualDur(a) !== qualDur(b)) return qualDur(b) - qualDur(a);
    if (distRef) {
      const da = distOf(a), db = distOf(b);
      if (da !== db) return da - db;
    }
    return 0;
  };
  // Per-bucket sort for both default paths.
  //   "Mest sol" (score): pure sun duration — longest qualifying window
  //     wins, distance is a tiebreaker only. Sol senere sorts by window
  //     start so the next-to-arrive sun is at the top.
  //   "Beste treff" (match): blends sun duration with a 20-min/km distance
  //     penalty. In Sol senere, start-time is still primary (the next sun
  //     to arrive is the dominant question for that bucket); relevance
  //     breaks the tie within equal start times.
  // Other sort modes (distance/favorites/beer) keep the global comparator.
  if (sortBy === 'score' || sortBy === 'match') {
    const startOf = (v) => v._qual?.earliest?.start ?? 24;
    const rel     = (v) => v._relevanceMin ?? 0;
    // Beste treff: in-viewport venues bubble to the top of each bucket.
    // The flag is set in the pipeline above; out-of-viewport venues fall
    // through to the global Beste treff order.
    const inViewportRank = (v) => v._inViewport === false ? 1 : 0;
    const compareNow = (a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      if (sortBy === 'match') {
        const va = inViewportRank(a), vb = inViewportRank(b);
        if (va !== vb) return va - vb;
        if (rel(a) !== rel(b)) return rel(b) - rel(a);
        return qualDur(b) - qualDur(a);
      }
      if (qualDur(a) !== qualDur(b)) return qualDur(b) - qualDur(a);
      if (distRef) {
        const da = distOf(a), db = distOf(b);
        if (da !== db) return da - db;
      }
      return 0;
    };
    const compareLater = (a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      if (sortBy === 'match') {
        const va = inViewportRank(a), vb = inViewportRank(b);
        if (va !== vb) return va - vb;
      }
      const sa = startOf(a), sb = startOf(b);
      if (sa !== sb) return sa - sb;
      if (sortBy === 'match') {
        if (rel(a) !== rel(b)) return rel(b) - rel(a);
        return qualDur(b) - qualDur(a);
      }
      if (qualDur(a) !== qualDur(b)) return qualDur(b) - qualDur(a);
      if (distRef) {
        const da = distOf(a), db = distOf(b);
        if (da !== db) return da - db;
      }
      return 0;
    };
    bucketNow.sort(compareNow);
    bucketLater.sort(compareLater);
  } else {
    bucketNow.sort(comparator);
    bucketLater.sort(comparator);
  }
  venues = [...bucketNow, ...bucketLater];

  // ── "Venner" filter — friends on top, then best match ─────────────────────
  // Repurpose the two-bucket section machinery (same trick as audit mode):
  // friend venues become the top section, everyone else the section below a
  // divider. Preserves the within-section sun/match order computed above.
  // Skipped when no friends are out (the list just stays in normal order so
  // the filter doesn't render an orphaned "Andre steder" header).
  const _friendsFilterActive = !auditActive && !!(window._activeFilters && window._activeFilters.friends);
  if (_friendsFilterActive) {
    const _withF = venues.filter(v => v._hasFriends);
    if (_withF.length) {
      const _without = venues.filter(v => !v._hasFriends);
      venues = [..._withF, ..._without];
      bucketNow.length = 0;   bucketLater.length = 0;
      bucketNow.push(..._withF);  bucketLater.push(..._without);
    }
  }

  // Audit mode override — admin walks the catalog systematically.
  // Two visual buckets: "To review" (top) and "Reviewed + Archived" (bottom).
  // The bucketNow/bucketLater split is reused so renderListPage's existing
  // section-header machinery works for free — we just relabel the headers.
  if (auditActive) {
    if (typeof auditMatchesFilter === 'function') {
      venues = venues.filter(v => auditMatchesFilter(v));
    }
    const _audited = (v) => (typeof isVenueAudited === 'function' && isVenueAudited(v));
    const _cmp = (a, b) => {
      const ar = (a.area || 'ÅÅÅ'), br = (b.area || 'ÅÅÅ');
      if (ar !== br) return ar.localeCompare(br, 'nb');
      return (a.name || '').localeCompare(b.name || '', 'nb');
    };
    const _todo = [], _done = [], _arch = [];
    for (const v of venues) {
      if (v.auditArchived) _arch.push(v);
      else if (_audited(v)) _done.push(v);
      else _todo.push(v);
    }
    _todo.sort(_cmp); _done.sort(_cmp); _arch.sort(_cmp);
    // Archived land below reviewed — they're a closed state, not a triage queue.
    venues = [..._todo, ..._done, ..._arch];
    bucketNow.length = 0;                       bucketLater.length = 0;
    bucketNow.push(..._todo);                   bucketLater.push(..._done, ..._arch);
  }

  // ── After-sunset state: real clock vs actual sunset, today only ───────────
  const isToday     = dateStr === todayStr();
  const sunsetH     = currentSunTable ? findSunCrossingFromTable(currentSunTable, false) : null;
  const realNow     = new Date().getHours() + new Date().getMinutes() / 60;
  const isAfterSunset = isToday && sunsetH != null && realNow > sunsetH;

  // Freeze / unfreeze arc interaction
  document.getElementById('floating-bottom')?.classList.toggle('arc-frozen', isAfterSunset);

  if (isAfterSunset && !auditActive) {
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }
    list.innerHTML = '';
    // Banner
    const banner = document.createElement('div');
    banner.id = 'no-sun-banner';
    banner.innerHTML = `<span>${t('sun_set_today')}</span><button onclick="advanceDay(1, 12)">${t('tomorrow_arrow')}</button>`;
    list.appendChild(banner);
    renderSkeletonCards(list, 7);
    // Count label
    const countEl = document.getElementById('venue-count');
    if (countEl) { countEl.textContent = '—'; countEl.className = ''; }
    return;
  }

  if (venues.length === 0) {
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }
    if (searchQ) {
      list.innerHTML = emptyState({
        glyph: 'search',
        title: `${t('no_results_for')} "<strong>${esc(searchQ)}</strong>"`,
        ctaHtml: `<button class="s-pill" onclick="suggestVenueFlow(${JSON.stringify(searchQ)})">${t('suggest_this_venue')}</button>`,
      });
    } else if (document.body.classList.contains('day-no-sun')) {
      // Header is showing the "no sun today" message + Tomorrow CTA.
      // Skip the duplicate .empty-all block — render skeleton cards
      // so the list area reads as a content placeholder rather than
      // empty void, while the header carries the action.
      list.innerHTML = '';
      if (typeof renderSkeletonCards === 'function') renderSkeletonCards(list, 5);
      _listFiltered = [];
      _listBuckets = { now: [], later: [] };
      const countEl1 = document.getElementById('venue-count');
      if (countEl1) { countEl1.textContent = t('no_places_in_sun'); countEl1.className = ''; }
      return;
    } else {
      // Empty-all consolidated state (Cases A & B from the redesign spec):
      // one centered message + one primary CTA opening the calendar
      // (tomorrow may be raining — the user picks a date that suits them)
      // + a tertiary "Vis alle steder" text link as an escape hatch. No
      // section headers; they would imply structure that doesn't exist
      // on an empty list.
      // Case A — sundown has passed for this date.
      // Case B — rain dominant: no Case A trigger, but the current hour is
      //          already raining (so dry slices haven't materialized).
      const sundownH2 = (typeof currentSunTable !== 'undefined' && currentSunTable && typeof findSunCrossingFromTable === 'function')
        ? findSunCrossingFromTable(currentSunTable, false) : null;
      const isCaseA = sundownH2 != null && fromHour >= sundownH2 - 0.001;
      const wxHere  = (typeof wxBucket === 'function') ? wxBucket(dateStr, fromHour) : null;
      const isCaseB = !isCaseA && wxHere === 'regn';
      // Date-aware headline: "i dag" only when the picked date is today,
      // otherwise switch to a neutral phrasing so we don't claim "today"
      // on a future-dated empty state.
      const isToday = dateStr === todayStr();
      const headline = isCaseB
        ? (isToday ? t('empty_rain_today') : t('empty_rain_day'))
        : (isToday ? t('empty_no_sun_left') : t('empty_no_sun_day'));
      list.innerHTML = emptyState({
        glyph: isCaseB ? 'cloud-rain' : 'moon',
        title: headline,
        ctaHtml: `<button class="p-pill" id="empty-state-pick-day" type="button">${t('cta_pick_another_day')}</button>`,
      });
      // Attach click handler programmatically — inline onclick="toggleQcPanel('date')"
      // was reported as not firing in some cases; this is more robust.
      const _pickBtn = document.getElementById('empty-state-pick-day');
      if (_pickBtn) {
        _pickBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (typeof toggleQcPanel === 'function') toggleQcPanel('date');
        });
      }
    }
    _listFiltered = [];
    _listBuckets = { now: [], later: [] };
    // Header count — must reflect what's rendered: zero. Spec demands the
    // count never lie about the visible list.
    const countEl0 = document.getElementById('venue-count');
    if (countEl0) {
      countEl0.textContent = t('no_places_in_sun');
      countEl0.className = '';
    }
    // Hide the sun-section-bar — both its label and its padding — so an
    // empty state reads as a single quiet headline + CTA, not a section
    // header followed by an emptiness. updateSunSectionBar applies the
    // ssb-empty class which has display:none.
    if (typeof updateSunSectionBar === 'function') updateSunSectionBar();
    return;
  }

  // ── Track venue impressions (debounced — only after slider settles) ──────
  clearTimeout(_aImpressionTimer);
  _aImpressionTimer = setTimeout(() => {
    _aTrack('venue_impression', {
      venue_ids: venues.slice(0, 20).map(v => v.id),
      count: venues.length,
      area: activeArea || null,
      sort: activeSortBy,
    });
  }, 2000);

  // Periodic now-tick: animate the change with the scrub skeleton crossfade,
  // but ONLY when the venue order actually changed (not on every silent 30 s
  // tick). _nowTickRender is set by _nowModeTick; the sig compares the new
  // order to what's on screen.
  const _listSig = venues.map(v => v.id).join('|');
  if (window._nowTickRender) {
    window._nowTickRender = false;
    if (window._lastListSig !== undefined && _listSig !== window._lastListSig
        && !document.body.classList.contains('list-scrubbing')
        && list.querySelector('.venue-card:not(.skeleton)')) {
      window._lastListSig = _listSig;
      document.body.classList.add('list-scrubbing');
      if (typeof _injectScrubSkeletons === 'function') _injectScrubSkeletons();
      // Hold the skeletons briefly, then re-render the real cards (cardIn).
      if (typeof _runListRenderAndUnmark === 'function') setTimeout(_runListRenderAndUnmark, 540);
      return;   // skip this paint; _runListRenderAndUnmark paints the real cards
    }
  }
  window._lastListSig = _listSig;

  // ── Render first page, observer handles the rest ──────────────────────────
  _listFiltered = venues;
  _lastRenderedVenues = venues;   // used by _autoFitMap on the next expansion
  _listBuckets = { now: bucketNow, later: bucketLater };
  renderListPage(list, dateStr, fromHour, toHour, isPoint, true);

  // Sun headline: refresh the outlook sentence on every render.
  if (typeof updateSunSectionBar === 'function') {
    requestAnimationFrame(updateSunSectionBar);
  }
  if (typeof wireAvstandTracker === 'function') wireAvstandTracker();

  // Update venue-peek with first ranked venue (mobile collapsed state)
  if (typeof updateVenuePeek === 'function') updateVenuePeek(venues);

  // Update count label (desktop only — mobile uses readout Tier 2). Per the
  // redesign spec, the header count must match the rendered list exactly:
  // venues across both surfaced buckets, not "anywhere today" sun. This is
  // the same number the user sees scrolling.
  const openCount = venues.filter(v => v.isOpen || v.isOpeningSoon).length;
  const sunCount  = bucketNow.length + bucketLater.length;
  const countEl   = document.getElementById('venue-count');
  if (countEl) {
    if (sunCount > 0) {
      countEl.textContent = t('places_in_sun', { count: sunCount });
      countEl.className = 'count-sunny';
    } else {
      countEl.textContent = t('count_open', { count: openCount });
      countEl.className = '';
    }
  }
}

// ── Hover tooltip ─────────────────────────────────────────────────────────────

function buildTooltipContent(v) {
  const dateStr = datePicker.value;
  const hour = parseFloat(timeFromEl.value);
  const { windows, open, close } = computeSunWindows(v, dateStr);
  const span = close - open;

  // Use the same venueState helper as the venue cards
  const state = typeof venueState === 'function'
    ? venueState(v, hour) : { state: 'sun', mainText: '—', subText: '', className: '' };
  const stateClass = state.className || '';
  const statusHtml = `<div class="ht-status ${stateClass}">
    <span class="ht-status-main">${state.mainText}</span>
    <span class="ht-status-sub">${state.subText}</span>
  </div>`;

  // Weather-colored timeline (same as venue card timelines)
  const tlHtml = buildMiniSunTimeline(v, dateStr, hour);

  return `
    <div class="ht-name">${v.name}</div>
    <div class="ht-meta"><span style="color:var(--accent)">★ ${v.rating}</span> · ${catLabel(v)}</div>
    ${statusHtml}${tlHtml}`;
}
