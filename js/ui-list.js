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
  const nameW = [60, 75, 48, 68, 52, 82, 44, 64, 58];
  const metaW = [38, 52, 32, 46, 56, 28, 62, 44, 50];
  for (let i = 0; i < n; i++) {
    const card = document.createElement('div');
    card.className = 'venue-card skeleton';
    card.innerHTML =
      '<div class="card-row1">' +
        `<div class="skel skel-name" style="width:${nameW[i % nameW.length]}%"></div>` +
        '<div class="skel skel-duration"></div>' +
      '</div>' +
      '<div class="card-meta">' +
        `<div class="skel skel-meta" style="width:${metaW[i % metaW.length]}%"></div>` +
      '</div>' +
      '<div class="skel skel-timeline"></div>';
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
  return `<div class="card-timeline">
    <canvas class="card-timeline-canvas timeline-track" data-vid="${v.id}"></canvas>
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
  const tlMin = fromHour;
  const sundownHCard = (typeof findSunCrossingFromTable === 'function')
    ? findSunCrossingFromTable(currentSunTable, false) : null;
  const tlMax = sundownHCard ?? ((typeof MAX_H_ARC !== 'undefined') ? MAX_H_ARC : 22);
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
    drawTimeline(ctx, {
      cssW, cssH,
      bleed: 0,
      minH: tlMin, maxH: tlMax,
      dateStr,
      sunTable: currentSunTable,
      nowH: nowH_, isToday: isToday_,
      openHour:  dayHours?.open  ?? null,
      closeHour: dayHours?.close ?? null,
      sunWindows: sunWindowsForShadow,
      drawSheen: false,
      drawThumb: false,
    });
    ctx.restore();
  }
  // Labels are positioned by left-percentages already; just resolve overlaps.
  _resolveTimelineLabelCollisions(scope);
}

// Inline beer mug SVG for venue cards (12px)
const beerSvgMini = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M 7 4 L 7 18 Q 7 20 9 20 L 15 20 Q 17 20 17 18 L 17 4 Z"/><path d="M 17 7 L 19 7 Q 21 7 21 9 L 21 13 Q 21 15 19 15 L 17 15"/><path d="M 7 10 L 17 10"/></svg>`;

// Sun glyph used in the row-1 duration label.
const SUN_GLYPH = '<svg class="sun-glyph" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

// Walking-person glyph for the walk-time meta. Filled current-color so
// it inherits the meta's --muted text color and stays visually neutral
// next to the distance.
const WALK_GLYPH = '<svg class="walk-glyph" viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M9.5 22l1.5-7-2-2v-5.5c0-.55.45-1 1-1h3.83c.43 0 .81.27.95.67L16 11l3 1.5-.45.9-3-1.4-1.5-3v3l2 2.5L15 22h-1.5l-1-6.5L11 13.5V22H9.5z"/></svg>';

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
  if (!_auditHere && !isOpen && !isOpeningSoon && !(qual && qual.surfaced)) {
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
  let pills = [];
  if (qual && qual.surfaced) {
    if (rich && !dpVariant && typeof buildCardPills === 'function') {
      pills = buildCardPills(v, qual, fromHour, sundownH, dateStr);
    } else if (typeof buildCardPillsV2 === 'function') {
      // Detect whether the geometric sun would have continued past the venue's
      // closing time (binding-Stenger condition) by re-asking computeSunWindows
      // with no upper hour clamp. We already have the raw windows from the
      // qualifying recompute above when v._qual is missing; the listed-venue
      // path memoizes them on v._rawWindows for reuse.
      const rawWindows = v._rawWindows ?? (typeof computeSunWindows === 'function' ? computeSunWindows(v, dateStr).windows : []);
      const geometricEndAfterClose = rawWindows.some(w => w.end > dayHours.close + 0.001);
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
    const tlMin = fromHour;
    const tlMax = sundownH ?? ((typeof MAX_H_ARC !== 'undefined') ? MAX_H_ARC : null);
    const tlLabels = buildTimelineLabels(pills, fromHour, tlMin, tlMax, qual);
    // Labels first, then timeline — labels-row sits above the bar visually.
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

  // ── Admin review-mode extras: flag chips + action row at the card's bottom.
  // Audit mode reuses the chips (so admins see flagged polygons inline while
  // walking the catalog) but skips the Mark OK / Hide actions — audit has
  // its own action row below.
  let reviewChips = '', reviewActions = '';
  const _reviewActive = typeof reviewModeActive !== 'undefined' && reviewModeActive;
  const _auditActive  = typeof auditModeActive  !== 'undefined' && auditModeActive;
  const flags = ((_reviewActive || _auditActive) && typeof venueReviewFlags === 'function')
    ? venueReviewFlags(v) : null;
  if (flags) {
    reviewChips = `<div class="review-chips">${
      flags.map(c => `<span class="review-chip" data-flag="${c}">${
        typeof reviewFlagLabel === 'function' ? reviewFlagLabel(c) : c
      }</span>`).join('')
    }</div>`;
    if (_reviewActive) {
      const idArg = typeof v.id === 'number' ? v.id : `'${v.id}'`;
      reviewActions = `<div class="review-actions" onclick="event.stopPropagation()">
        <button class="review-action-btn" onclick="enterEditMode(${idArg})">Edit</button>
        <button class="review-action-btn" onclick="dismissReviewFlag(${idArg})">Mark OK</button>
        <button class="review-action-btn review-action-danger" onclick="hideVenueFromMap(${idArg})">Hide</button>
      </div>`;
    }
  }

  // Admin audit-mode row: per-card status badge + Mark good / Edit / Archive.
  let auditActionsHtml = '', auditCardCls = '';
  if (typeof auditModeActive !== 'undefined' && auditModeActive) {
    const idArg     = typeof v.id === 'number' ? v.id : `'${v.id}'`;
    const archived  = !!v.auditArchived;
    const audited   = !archived && (typeof isVenueAudited === 'function') && isVenueAudited(v);
    const entry     = audited && typeof venueAuditEntry === 'function' ? venueAuditEntry(v) : null;
    const viaLabel  = entry?.via === 'edited' ? 'Edited ✓' : 'Looks good ✓';
    if (audited)  auditCardCls = ' audit-reviewed';
    if (archived) auditCardCls = ' audit-archived';
    if (archived) {
      auditActionsHtml = `<div class="audit-actions" onclick="event.stopPropagation()">
        <span class="audit-state-badge">Archived</span>
        <button class="audit-action-btn audit-undo" onclick="unarchiveVenue(${idArg})">Un-archive</button>
      </div>`;
    } else if (audited) {
      auditActionsHtml = `<div class="audit-actions" onclick="event.stopPropagation()">
        <span class="audit-state-badge">${viaLabel}</span>
        <button class="audit-action-btn audit-undo" onclick="unmarkVenueAudited(${idArg})">Undo</button>
        <button class="audit-action-btn" onclick="enterEditMode(${idArg})">Edit polygon</button>
        <button class="audit-action-btn audit-archive" onclick="archiveVenue(${idArg})" title="Hide from users">Archive</button>
      </div>`;
    } else {
      auditActionsHtml = `<div class="audit-actions" onclick="event.stopPropagation()">
        <button class="audit-action-btn" onclick="markVenueAudited(${idArg},'good')">Mark good</button>
        <button class="audit-action-btn audit-undo" onclick="enterEditMode(${idArg})">Edit polygon</button>
        <button class="audit-action-btn audit-archive" onclick="archiveVenue(${idArg})" title="Hide from users">Archive</button>
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
    const headlineMain = dpState?.mainText || '—';
    const headlineSub  = dpState?.subText  || '';
    return `
      <div class="venue-card card-compact ${stateClass}${flags ? ' review-flagged' : ''}${auditCardCls}"
           data-vid="${v.id}">
        <div class="dp-sun-headline">${headlineMain}</div>
        ${headlineSub ? `<div class="dp-sun-sub">${headlineSub}</div>` : ''}
        ${pillsRowHtml}
        ${timelineBlock}
        ${reviewChips}
        ${reviewActions}
        ${auditActionsHtml}
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
      ${reviewActions}
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
  const nowHeaderTxt   = _auditList ? `Til vurdering · ${nowCount}`
                                    : (isFutureMode ? t('section_sun_at',    { time: formatHour(fromHour) }) : t('section_sun_now'));
  const laterHeaderTxt = _auditList ? `Vurdert · ${laterCount}`
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
    list.innerHTML = html;
    if (savedScroll) list.scrollTop = savedScroll;
    // Set data-mounted in the next frame so the FIRST reset's layout pass
    // sees the attribute absent (cardIn fires once across the new cards),
    // and SUBSEQUENT resets see it present (cardIn gated off → no flash).
    if (!list.dataset.mounted) {
      requestAnimationFrame(() => { list.dataset.mounted = '1'; });
    }
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
        <svg class="list-expand-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 10L8 5.5L12.5 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
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
    // Pass raw windows through to renderCard so the v2 pill builder can
    // detect Åpner/Stenger binding-hours pills without recomputing.
    return { ...v, sunInWin, isOpen, isOpeningSoon, isClosingSoon, score, _qual: qual, _rawWindows: rawWins, _relevanceMin };
  });

  // Surfacing filter — qualifying windows + own-suggestion bypass + the
  // search bypass (any venue matched by the active query stays visible) +
  // the user's "vis alle" escape hatch + admin review mode.
  const reviewActive = typeof reviewModeActive !== 'undefined' && reviewModeActive;
  const showAllPass = _showAllOnce; _showAllOnce = false;
  if (!showAllPass && !reviewActive && !auditActive) {
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
      list.innerHTML = `
        <div class="suggest-empty">
          <span>${t('no_results_for')} "<strong>${searchQ}</strong>"</span>
          <button class="suggest-btn" onclick="suggestVenueFlow(${JSON.stringify(searchQ)})">
            ${t('suggest_this_venue')}
          </button>
        </div>`;
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
      list.innerHTML = `
        <div class="empty-all">
          <div class="empty-all-headline">${headline}</div>
          <button class="p-pill btn-see-tomorrow" id="empty-state-pick-day" type="button">${t('cta_pick_another_day')}</button>
        </div>`;
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
