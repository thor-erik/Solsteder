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
let _listDividerIdx = -1; // index of the first "sun later" venue, or -1 to suppress
let _listObserver = null; // IntersectionObserver for infinite scroll
let _aImpressionTimer = null; // debounce for impression analytics

/**
 * Mini sun-timeline: a canvas drawn by the shared drawTimeline() renderer
 * (ui-shared.js). The actual paint is deferred to drawAllCardTimelines(),
 * which runs after the cards are inserted into the DOM. We just emit the
 * canvas placeholder + a data-vid attribute for the painter to look up the
 * venue. Domain (minH/maxH), now-tick, shadow gaps and opening-hours dim are
 * all set per-card in drawAllCardTimelines.
 */
function buildMiniSunTimeline(v, dateStr, fromHour) {
  // Canvas carries .timeline-track too so existing CSS rules — list height,
  // dp-card height/border-radius, the source-morphing transition, the
  // .fts-hosted fade-out — all still apply without duplication.
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
  const fromH    = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : null;
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
    // When the card is morphing into the dp-card slot, it's effectively the
    // FTS pill — match the FTS renderer's sheen + thumb so the hand-off is
    // invisible. Detect via the source-morphing class on the venue-card
    // ancestor (set by openDetailPanel during the open morph). Regular list
    // cards (8px tall, no scrub) keep sheen/thumb off.
    const isMorphTarget = !!cv.closest('.venue-card.source-morphing');
    drawTimeline(ctx, {
      cssW, cssH,
      bleed: 0,                         // no thumb-glow overflow on cards
      minH: MIN_H_ARC, maxH: MAX_H_ARC,
      dateStr,
      sunTable: currentSunTable,
      nowH: nowH_, isToday: isToday_,
      openHour:  dayHours?.open  ?? null,
      closeHour: dayHours?.close ?? null,
      sunWindows: sunWindowsForShadow,
      drawSheen: isMorphTarget,         // 8px is too small for sheen; morph target is 38px
      drawThumb: isMorphTarget,         // morph target IS the FTS visually — show thumb
      thumbHour: isMorphTarget ? fromH : null,
    });
    ctx.restore();
  }
}

// Inline beer mug SVG for venue cards (12px)
const beerSvgMini = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M 7 4 L 7 18 Q 7 20 9 20 L 15 20 Q 17 20 17 18 L 17 4 Z"/><path d="M 17 7 L 19 7 Q 21 7 21 9 L 21 13 Q 21 15 19 15 L 17 15"/><path d="M 7 10 L 17 10"/></svg>`;

/** Render a single venue card — new two-column redesign. */
function renderCard(v, dateStr, fromHour, toHour, isPoint) {
  const dayHours = getVenueHoursForDay(v, dateStr);

  // Collapsed single-line card for closed venues
  if (!v.isOpen && !v.isOpeningSoon) {
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

  // Get venue state (sun/shadow/done) from the state model
  const state = typeof venueState === 'function' ? venueState(v, fromHour) :
    { state: 'sun', mainText: 'Sol til —', subText: '', className: 'state-sun' };

  // Build meta row: area · type · distance
  const metaParts = [v.area, catLabel(v), distStr].filter(Boolean);
  const metaHtml = metaParts.map((p, i) =>
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

  return `
    <div class="venue-card ${state.className} ${v.id === selectedId ? 'selected' : ''}"
         data-vid="${v.id}" onclick="selectVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`}, true)"
         onmouseenter="setHoveredVenue(${typeof v.id === 'number' ? v.id : `'${v.id}'`})" onmouseleave="setHoveredVenue(null)">
      <div class="card-top">
        <div class="card-left">
          <div class="card-new-name">${v.name}${favHeart}${friendBadge}</div>
          <div class="card-new-meta">${metaHtml}</div>
        </div>
        <div class="card-right">
          <div class="card-new-hero-main">${state.mainText}</div>
          <div class="card-new-hero-sub">${state.subText}</div>
        </div>
      </div>
      ${miniTimeline}
    </div>`;
}

/**
 * Append the next page of cards to #venue-list.
 * Called on init (reset=true) and by the IntersectionObserver on scroll.
 */
function renderListPage(list, dateStr, fromHour, toHour, isPoint, reset) {
  if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }

  const from = reset ? 0 : list.querySelectorAll('.venue-card').length;
  const to   = Math.min(from + LIST_PAGE, _listFiltered.length);

  // Inject the "sun later" divider when the page straddles the boundary —
  // before the first card with _sunOrd > 0. Only fires when score sort active
  // and both groups non-empty (see _listDividerIdx in renderList).
  const dividerIdx = _listDividerIdx;
  let html = '';
  for (let i = from; i < to; i++) {
    if (i === dividerIdx) {
      const laterCount = _listFiltered.length - dividerIdx;
      html += `<div class="venue-list-divider">${t('sun_later_count', { count: laterCount })}</div>`;
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
  venues = venues.map(v => {
    const sunInWin = venueHasSunInRange(v, dateStr, fromHour, toHour);
    const { open, close } = getVenueHoursForDay(v, dateStr);
    const isOpen        = fromHour >= open && fromHour <= close;
    const isOpeningSoon = !isOpen && (open - fromHour) > 0 && (open - fromHour) <= 0.75;
    const isClosingSoon = isOpen  && (close - fromHour) > 0 && (close - fromHour) <= 0.5;
    const score = typeof computeVenueScore === 'function'
      ? computeVenueScore(v, dateStr, fromHour, wxNow, userLocation)
      : null;
    return { ...v, sunInWin, isOpen, isOpeningSoon, isClosingSoon, score };
  });

  // Remove venues with no sun windows, or (today only) all sun already past
  // User's own suggestions bypass this filter (they lack geometry data)
  const isTodayFilter = dateStr === todayStr();
  venues = venues.filter(v => {
    if (v._ownSuggestion) return true;
    const { windows } = computeSunWindows(v, dateStr);
    if (!windows.length) return false;
    if (isTodayFilter) return windows.some(w => w.end > fromHour);
    return true;
  });

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

  // Pre-compute sun-window stats for any venue we might need to rank by
  // remaining sun. Used by score / distance / favorites — compute once
  // up-front rather than scattering computeSunWindows calls in comparators.
  function _ensureSunStats(list) {
    for (const v of list) {
      const { windows } = computeSunWindows(v, dateStr);
      let rem = 0, total = 0;
      for (const w of windows) {
        total += w.end - w.start;
        if (w.end > fromHour) rem += w.end - Math.max(w.start, fromHour);
      }
      v._sunRem = rem;
      v._sunTotalToday = total;
      if (!windows.length) { v._sunOrd = 2; }
      else if (windows.some(w => fromHour >= w.start && fromHour < w.end)) { v._sunOrd = 0; }
      else if (windows.some(w => w.start > fromHour)) { v._sunOrd = 1; }
      else { v._sunOrd = 2; }
    }
  }

  if (sortBy === 'score') {
    _ensureSunStats(venues);
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      // _sunOrd: 0 = in sun at the slider time, 1 = sun starts after slider time, 2 = none.
      // Group by state first so the "in-sun" venues form a contiguous block at the
      // top of the list — matches the header count exactly and lets us draw a divider.
      if (a._sunOrd !== b._sunOrd) return a._sunOrd - b._sunOrd;
      if (a._sunRem !== b._sunRem) return b._sunRem - a._sunRem;
      // Tiebreaker: venues with more total sun today rank higher.
      if (a._sunTotalToday !== b._sunTotalToday) return b._sunTotalToday - a._sunTotalToday;
      if (distRef) {
        const da = Math.hypot(a.lat - distRef.lat, a.lng - distRef.lng);
        const db = Math.hypot(b.lat - distRef.lat, b.lng - distRef.lng);
        if (da !== db) return da - db;
      }
      return 0;
    });
  } else if (sortBy === 'distance' && distRef) {
    _ensureSunStats(venues);
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      const da = Math.hypot(a.lat - distRef.lat, a.lng - distRef.lng);
      const db = Math.hypot(b.lat - distRef.lat, b.lng - distRef.lng);
      if (da !== db) return da - db;
      return b._sunRem - a._sunRem;
    });
  } else if (sortBy === 'beer') {
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      // Venues without beer price go last
      if (a.beerPrice && !b.beerPrice) return -1;
      if (!a.beerPrice && b.beerPrice) return 1;
      if (!a.beerPrice && !b.beerPrice) return b.rating - a.rating;
      return a.beerPrice - b.beerPrice;
    });
  } else if (sortBy === 'favorites') {
    // Show only favorites, sorted by distance with sun-remaining tiebreaker.
    // Closed-not-opening-soon favorites still sink to the bottom.
    if (typeof isFavorite === 'function') {
      venues = venues.filter(v => isFavorite(v.id));
    }
    _ensureSunStats(venues);
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      if (distRef) {
        const da = Math.hypot(a.lat - distRef.lat, a.lng - distRef.lng);
        const db = Math.hypot(b.lat - distRef.lat, b.lng - distRef.lng);
        if (da !== db) return da - db;
      }
      return b._sunRem - a._sunRem;
    });
  } else {
    // Default case (if sortBy is something else or undefined)
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      if (a.sunInWin !== b.sunInWin) return a.sunInWin ? -1 : 1;
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      return b.rating - a.rating;
    });
  }

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
      list.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:30px 10px;">${t('no_venues_filters')}</div>`;
    }
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
  // Divider index: only meaningful for score sort with both groups non-empty.
  // Other sorts have no clean state boundary.
  if (sortBy === 'score') {
    const firstLater = venues.findIndex(v => v._sunOrd > 0);
    _listDividerIdx = (firstLater > 0 && firstLater < venues.length) ? firstLater : -1;
  } else {
    _listDividerIdx = -1;
  }
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
