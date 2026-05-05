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
      minH: MIN_H_ARC, maxH: MAX_H_ARC,
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
}

// Inline beer mug SVG for venue cards (12px)
const beerSvgMini = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M 7 4 L 7 18 Q 7 20 9 20 L 15 20 Q 17 20 17 18 L 17 4 Z"/><path d="M 17 7 L 19 7 Q 21 7 21 9 L 21 13 Q 21 15 19 15 L 17 15"/><path d="M 7 10 L 17 10"/></svg>`;

// Sun glyph used in the row-1 duration label.
const SUN_GLYPH = '<svg class="sun-glyph" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

function _formatDurationFromMin(minutes) {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  if (h > 0 && m > 0) return `${h}t ${m}m`;
  if (h > 0) return `${h}t`;
  if (m > 0) return `${m} min`;
  return '5 min';
}

/** Render a single venue card — Soft Zebra 3-row layout. */
function renderCard(v, dateStr, fromHour, toHour, isPoint) {
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
  if (!isOpen && !isOpeningSoon && !(qual && qual.surfaced)) {
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

  // Pills row: built by the shared helper. State color matches subject.
  const sundownH = (typeof currentSunTable !== 'undefined' && currentSunTable && typeof findSunCrossingFromTable === 'function')
    ? findSunCrossingFromTable(currentSunTable, false) : null;
  const pills = (qual && qual.surfaced && typeof buildCardPills === 'function')
    ? buildCardPills(v, qual, fromHour, sundownH, dateStr)
    : [];
  const pillsHtml = pills.map(p =>
    `<span class="card-pill pill-${p.kind}">${p.label}</span>`
  ).join('');

  // Quiet treatment: dim Sol-senere cards where wait > payoff, so the eye
  // gravitates toward better-value cards without filtering anything out.
  let quietCls = '';
  if (qual && qual.earliest && qual.earliest.start > fromHour + 0.001) {
    const wait   = qual.earliest.start - fromHour;
    const payoff = qual.earliest.end   - qual.earliest.start;
    if (wait > payoff) quietCls = ' card-quiet';
  }

  // Closed-but-opens-later venues: prefix the meta line with the opening time
  // so users see when this card becomes live without having to hunt.
  const opensLaterPrefix = (!isOpen && qual && qual.surfaced)
    ? `<span class="card-meta-opens">${t('meta_opens_at_prefix', { time: formatHour(dayHours.open) })}</span><span class="card-meta-dot">·</span>`
    : '';

  const metaParts = [v.area, catLabel(v), distStr].filter(Boolean);
  const metaHtml = opensLaterPrefix + metaParts.map((p, i) =>
    (i > 0 ? '<span class="card-meta-dot">·</span>' : '') + `<span>${p}</span>`
  ).join('');

  const miniTimeline = buildMiniSunTimeline(v, dateStr, fromHour);

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
  let reviewChips = '', reviewActions = '';
  const flags = (typeof reviewModeActive !== 'undefined' && reviewModeActive &&
                 typeof venueReviewFlags === 'function') ? venueReviewFlags(v) : null;
  if (flags) {
    reviewChips = `<div class="review-chips">${
      flags.map(c => `<span class="review-chip" data-flag="${c}">${
        typeof reviewFlagLabel === 'function' ? reviewFlagLabel(c) : c
      }</span>`).join('')
    }</div>`;
    const idArg = typeof v.id === 'number' ? v.id : `'${v.id}'`;
    reviewActions = `<div class="review-actions" onclick="event.stopPropagation()">
      <button class="review-action-btn" onclick="enterEditMode(${idArg})">Edit</button>
      <button class="review-action-btn" onclick="dismissReviewFlag(${idArg})">Mark OK</button>
      <button class="review-action-btn review-action-danger" onclick="hideVenueFromMap(${idArg})">Hide</button>
    </div>`;
  }

  return `
    <div class="venue-card ${stateClass}${quietCls} ${v.id === selectedId ? 'selected' : ''}${flags ? ' review-flagged' : ''}"
         data-vid="${v.id}" onclick="selectVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`}, true)"
         onmouseenter="setHoveredVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`})" onmouseleave="setHoveredVenue(null)">
      <div class="card-row1">
        <div class="card-name">${v.name}${favHeart}${friendBadge}${goingBadge}</div>
        ${durationStr ? `<div class="card-duration">${SUN_GLYPH}${durationStr}</div>` : ''}
      </div>
      <div class="card-meta">${metaHtml}</div>
      ${pillsHtml ? `<div class="card-pills">${pillsHtml}</div>` : ''}
      ${miniTimeline}
      ${reviewChips}
      ${reviewActions}
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
  const isFuture   = (typeof nowMode !== 'undefined' && !nowMode &&
                      typeof todayStr === 'function' && dateStr === todayStr() &&
                      Math.abs(fromHour - (new Date().getHours() + new Date().getMinutes() / 60)) > 5/60)
                  || (typeof todayStr === 'function' && dateStr > todayStr());

  // Build section markup. Reset paths emit the headers + empties; paginated
  // appends just emit cards (no headers — they're already in the DOM). The
  // future-time signal lives in the section header copy ("Sol kl HH:MM" /
  // "Sol etter HH:MM"); no separate chip is injected.
  let html = '';
  if (reset) {
    // Sol nå header
    const nowLabel = isFuture
      ? t('section_sun_at', { time: formatHour(fromHour) })
      : t('section_sun_now');
    html += `<div class="venue-section-header">${nowLabel}<span class="section-count">· ${nowCount}</span></div>`;
    if (nowCount === 0) {
      html += `<div class="empty-section">${t('empty_no_sun_now')}</div>`;
    }
  }

  // Now-bucket cards
  for (let i = from; i < Math.min(to, nowCount); i++) {
    html += renderCard(_listFiltered[i], dateStr, fromHour, toHour, isPoint);
  }

  // Later header inserted at the boundary, even mid-page.
  if (reset) {
    const laterLabel = isFuture
      ? t('section_sun_after', { time: formatHour(fromHour) })
      : t('section_sun_later');
    html += `<div class="venue-section-header">${laterLabel}<span class="section-count">· ${laterCount}</span></div>`;
    if (laterCount === 0) {
      html += `<div class="empty-section">${t('empty_no_sun_later')}</div>`;
    }
  } else if (from < nowCount && to > nowCount) {
    // Mid-page boundary on a paginated append: still mark the section break.
    const laterLabel = isFuture
      ? t('section_sun_after', { time: formatHour(fromHour) })
      : t('section_sun_later');
    html += `<div class="venue-section-header">${laterLabel}<span class="section-count">· ${laterCount}</span></div>`;
  }

  // Later-bucket cards
  for (let i = Math.max(from, nowCount); i < to; i++) {
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
  }
  // Paint the canvas-based mini-timelines now that the cards are in the DOM.
  // Use rAF so layout has settled and clientWidth/Height are non-zero.
  requestAnimationFrame(() => drawAllCardTimelines(list));

  // Attach sentinel + observer if more cards remain
  if (to < _listFiltered.length) {
    list.insertAdjacentHTML('beforeend', '<div id="list-sentinel" style="height:1px"></div>');
    _listObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) renderListPage(list, dateStr, fromHour, toHour, isPoint, false);
    }, { root: list.closest('#panel'), rootMargin: '200px' });
    _listObserver.observe(document.getElementById('list-sentinel'));
  }
}

/**
 * One-shot escape hatch from the empty-all state. Bypasses the qualifying
 * filter for the next render so the user can see every open venue, then
 * re-enables filtering on the following pass.
 */
function showAllVenuesOnce() {
  _showAllOnce = true;
  if (typeof scheduleRenderList === 'function') scheduleRenderList();
  else if (typeof renderList === 'function') renderList();
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

  if (searchQ) {
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
  if (activeArea) venues = venues.filter(v => v.area === activeArea);
  // Favorites filtering is handled by sortBy === 'favorites' below

  if (filterMapViewActive) {
    // While a venue is selected, keep the list frozen at the pre-zoom viewport
    const bounds = (selectedId != null && _frozenBounds) ? _frozenBounds : map.getBounds();
    // Pad bounds by 20% so venues just outside the viewport are included
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const dlat = (ne.lat - sw.lat) * 0.2, dlng = (ne.lng - sw.lng) * 0.2;
    const padded = new mapboxgl.LngLatBounds(
      [sw.lng - dlng, sw.lat - dlat],
      [ne.lng + dlng, ne.lat + dlat]
    );
    venues = venues.filter(v => padded.contains([v.lng, v.lat]));
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
    return { ...v, sunInWin, isOpen, isOpeningSoon, isClosingSoon, score, _qual: qual };
  });

  // Surfacing filter — qualifying windows + own-suggestion bypass + the
  // search bypass (any venue matched by the active query stays visible) +
  // the user's "vis alle" escape hatch + admin review mode.
  const reviewActive = typeof reviewModeActive !== 'undefined' && reviewModeActive;
  const showAllPass = _showAllOnce; _showAllOnce = false;
  if (!showAllPass && !reviewActive) {
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
  const sunStart = (v) => v._qual?.earliest?.start ?? Infinity;
  const makeComparator = (bucketName) => (a, b) => {
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
    // Default ("Mest sol" / "Most sun") — bucket-aware:
    //   Sol nå:    distance asc, tiebreak duration desc
    //   Sol senere: sun-start asc, tiebreak duration desc
    if (bucketName === 'now') {
      if (distRef) {
        const da = distOf(a), db = distOf(b);
        if (da !== db) return da - db;
      }
      return qualDur(b) - qualDur(a);
    }
    if (sunStart(a) !== sunStart(b)) return sunStart(a) - sunStart(b);
    return qualDur(b) - qualDur(a);
  };
  bucketNow.sort(makeComparator('now'));
  bucketLater.sort(makeComparator('later'));
  venues = [...bucketNow, ...bucketLater];

  // ── After-sunset state: real clock vs actual sunset, today only ───────────
  const isToday     = dateStr === todayStr();
  const sunsetH     = currentSunTable ? findSunCrossingFromTable(currentSunTable, false) : null;
  const realNow     = new Date().getHours() + new Date().getMinutes() / 60;
  const isAfterSunset = isToday && sunsetH != null && realNow > sunsetH;

  // Freeze / unfreeze arc interaction
  document.getElementById('floating-bottom')?.classList.toggle('arc-frozen', isAfterSunset);

  if (isAfterSunset) {
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }
    list.innerHTML = '';
    // Banner
    const banner = document.createElement('div');
    banner.id = 'no-sun-banner';
    banner.innerHTML = `<span>${t('sun_set_today')}</span><button onclick="advanceDay(1, 12)">${t('tomorrow_arrow')}</button>`;
    list.appendChild(banner);
    // Skeleton cards
    const nameW = [60, 75, 48, 68, 52, 82, 44];
    const metaW = [38, 52, 32, 46, 56, 28, 62];
    for (let i = 0; i < 7; i++) {
      const card = document.createElement('div');
      card.className = 'venue-card skeleton';
      card.innerHTML = `
        <div class="card-body">
          <div class="skel skel-watch"></div>
          <div class="card-content">
            <div class="card-top-row">
              <div style="flex:1;display:flex;flex-direction:column;gap:6px">
                <div class="skel skel-line" style="width:${nameW[i]}%"></div>
                <div class="skel skel-line" style="width:${metaW[i]}%;height:7px"></div>
              </div>
              <div class="skel skel-score-block"></div>
            </div>
          </div>
        </div>`;
      list.appendChild(card);
    }
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
      // Empty-all soft-zebra state: both buckets are zero. Keep the section
      // headers visible so the bucket model stays legible, and surface a
      // "Vis alle steder" escape that bypasses the qualifying filter on the
      // next pass (the normal sun-later content reappears as soon as the
      // user scrubs to a sunny hour).
      list.innerHTML = `
        <div class="venue-section-header">${t('section_sun_now')}<span class="section-count">· 0</span></div>
        <div class="empty-section">${t('empty_no_sun_now')}</div>
        <div class="venue-section-header">${t('section_sun_later')}<span class="section-count">· 0</span></div>
        <div class="empty-section">${t('empty_no_sun_later')}</div>
        <div class="empty-all">
          <div>${t('empty_no_sun_today')}</div>
          <button class="s-pill btn-show-all" onclick="showAllVenuesOnce()">${t('btn_show_all_venues')}</button>
        </div>`;
    }
    _listFiltered = [];
    _listBuckets = { now: [], later: [] };
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
  _listBuckets = { now: bucketNow, later: bucketLater };
  renderListPage(list, dateStr, fromHour, toHour, isPoint, true);

  // Update venue-peek with first ranked venue (mobile collapsed state)
  if (typeof updateVenuePeek === 'function') updateVenuePeek(venues);

  // Update count label (desktop only — mobile uses readout Tier 2)
  const openCount = venues.filter(v => v.isOpen || v.isOpeningSoon).length;
  const sunCount  = venues.filter(v => v.sunInWin && v.isOpen).length;
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
