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
let _listObserver = null; // IntersectionObserver for infinite scroll
let _aImpressionTimer = null; // debounce for impression analytics

/**
 * Weather ramp color from cloud/precip values.
 * Matches the design system spec: sun → few clouds → partly → mostly → overcast → rain.
 */
function wxTimelineColor(cloud, precip) {
  if (precip > 0.3) return '#3B6499';       // rain
  if (cloud >= 0.85) return '#94AABB';       // overcast
  if (cloud >= 0.65) return '#C6C8CA';       // mostly cloudy
  if (cloud >= 0.40) return '#DECCC0';       // partly cloudy
  if (cloud >= 0.15) return '#FFCFAA';       // few clouds
  return '#FFAF85';                           // clear = accent
}

/** Mini sun-timeline: 8px tall, 06:00–22:00, weather-ramp colors, shadow gap caps. */
function buildMiniSunTimeline(v, dateStr, fromHour) {
  const { windows } = computeSunWindows(v, dateStr);
  const START_H = 6, END_H = 22, RANGE = END_H - START_H;
  const pct = h => Math.max(0, Math.min(100, ((h - START_H) / RANGE) * 100));

  // "Now" position based on wall-clock time
  const now = new Date();
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const nowPos = pct(nowHour);

  // Build weather-colored segments per hour within each sun window
  // Each hour-block gets its own weather color; consecutive same-color blocks merge
  const runs = []; // { start, end, color, winIdx }
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    const wS = Math.max(w.start, START_H);
    const wE = Math.min(w.end, END_H);
    if (wE <= wS) continue;
    const hFloor = Math.floor(wS);
    const hCeil  = Math.ceil(wE);
    for (let h = hFloor; h < hCeil; h++) {
      const segS = Math.max(wS, h);
      const segE = Math.min(wE, h + 1);
      if (segE <= segS + 0.001) continue;
      const wx = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, h) : null;
      const color = wxTimelineColor(wx?.cloud ?? 0, wx?.precip ?? 0);
      if (runs.length && runs[runs.length - 1].color === color && runs[runs.length - 1].winIdx === wi) {
        runs[runs.length - 1].end = segE;
      } else {
        runs.push({ start: segS, end: segE, color, winIdx: wi });
      }
    }
  }

  // Determine shadow gaps: gaps between consecutive windows
  const gaps = [];
  for (let i = 0; i < windows.length - 1; i++) {
    const gapStart = windows[i].end;
    const gapEnd   = windows[i + 1].start;
    if (gapEnd > gapStart + 0.01) gaps.push({ start: gapStart, end: gapEnd, afterWinIdx: i });
  }

  // Build segment HTML with cap classes
  let segments = '';
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const left = pct(r.start);
    const width = pct(r.end) - left;
    if (width < 0.1) continue;

    // Determine caps: first/last of entire bar, or at shadow gap boundary
    const isFirst = i === 0;
    const isLast  = i === runs.length - 1;
    // Check if this run's end touches a shadow gap
    const touchesGapRight = gaps.some(g => Math.abs(g.start - r.end) < 0.05);
    // Check if this run's start touches a shadow gap
    const touchesGapLeft  = gaps.some(g => Math.abs(g.end - r.start) < 0.05);

    let cls = 'wx';
    if (isFirst || touchesGapLeft)  cls += ' cap-l';
    if (isLast  || touchesGapRight) cls += ' cap-r';

    segments += `<div class="${cls}" style="left:${left}%;width:${width}%;background:${r.color}"></div>`;
  }

  return `<div class="card-timeline">
    <div class="timeline-track">
      ${segments}
      <div class="tl-now" style="left:${nowPos}%"></div>
    </div>
  </div>`;
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

  const html = _listFiltered
    .slice(from, to)
    .map(v => renderCard(v, dateStr, fromHour, toHour, isPoint))
    .join('');

  if (reset) {
    list.innerHTML = html;
  } else {
    // Suppress entry animation for scroll-paginated cards
    list.setAttribute('data-no-anim', '');
    document.getElementById('list-sentinel')?.remove();
    list.insertAdjacentHTML('beforeend', html);
    // Re-enable animation after current frame so future resets still animate
    requestAnimationFrame(() => list.removeAttribute('data-no-anim'));
  }

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

  // ── Filter + sort (runs on full VENUES, O(n)) ─────────────────────────────
  const wxNow = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;

  let venues = VENUES.map(v => {
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

  if (searchQ) {
    venues = venues.filter(v =>
      v.name.toLowerCase().includes(searchQ) ||
      (v.area ?? '').toLowerCase().includes(searchQ) ||
      v.address.toLowerCase().includes(searchQ)
    );
  }
  if (activeArea) venues = venues.filter(v => v.area === activeArea);
  if (typeof filterFavoritesOnly !== 'undefined' && filterFavoritesOnly && typeof isFavorite === 'function') {
    venues = venues.filter(v => isFavorite(v.id));
  }

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

  if (filterMapViewActive) {
    // While a venue is selected, keep the list frozen at the pre-zoom viewport
    const bounds = (selectedId != null && _frozenBounds) ? _frozenBounds : map.getBounds();
    venues = venues.filter(v => bounds.contains([v.lng, v.lat]));
  }

  // Closed venues always sink below open ones regardless of sort mode
  function closedPenalty(v) { return (!v.isOpen && !v.isOpeningSoon) ? 1 : 0; }

  if (sortBy === 'score') {
    // Pre-compute sun remaining + state once per venue (not inside comparator)
    for (const v of venues) {
      const { windows } = computeSunWindows(v, dateStr);
      let rem = 0;
      for (const w of windows) {
        if (w.end > fromHour) rem += w.end - Math.max(w.start, fromHour);
      }
      // Favorites get a sort boost: +0.5h of virtual sun remaining
      v._sunRem = rem + (typeof isFavorite === 'function' && isFavorite(v.id) ? 0.5 : 0);
      if (!windows.length) { v._sunOrd = 2; }
      else if (windows.some(w => fromHour >= w.start && fromHour < w.end)) { v._sunOrd = 0; }
      else if (windows.some(w => w.start > fromHour)) { v._sunOrd = 1; }
      else { v._sunOrd = 2; }
    }
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      if (a._sunRem !== b._sunRem) return b._sunRem - a._sunRem;
      if (a.score?.distKm != null && b.score?.distKm != null) {
        const dd = a.score.distKm - b.score.distKm;
        if (dd !== 0) return dd;
      }
      return a._sunOrd - b._sunOrd;
    });
  } else if (sortBy === 'distance' && userLocation) {
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      const da = Math.hypot(a.lat - userLocation.lat, a.lng - userLocation.lng);
      const db = Math.hypot(b.lat - userLocation.lat, b.lng - userLocation.lng);
      return da - db;
    });
  } else if (sortBy === 'latest') {
    // Sort by latest sun end time (venues with sun ending latest first)
    for (const v of venues) {
      const { windows } = computeSunWindows(v, dateStr);
      v._lastSunEnd = windows.length ? Math.max(...windows.map(w => w.end)) : 0;
    }
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      return b._lastSunEnd - a._lastSunEnd;
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

  // Status + timing
  const wxTip = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, hour) : null;
  const tipRainy = (wxTip?.precip ?? 0) > 0.3;
  const tipOvercast = !tipRainy && (wxTip?.cloud ?? 0) > 0.65;
  const tipTerm = tipRainy ? 'rain' : tipOvercast ? 'light' : 'sun';
  const tipIcon = tipRainy ? '🌧' : tipOvercast ? '☁' : '☀';
  let statusHtml = '';
  const curWin = windows.find(w => hour >= w.start && hour < w.end);
  if (curWin) {
    const rem = curWin.end - hour;
    const h = Math.floor(rem), m = Math.round((rem - h) * 60);
    const t = h > 0 ? `${h}h${m > 0 ? ' '+m+'m' : ''}` : `${m}m`;
    const cls = tipRainy ? 'rainy' : tipOvercast ? 'overcast' : 'sunny';
    statusHtml = `<div class="ht-status ${cls}">${tipIcon} In ${tipTerm} · ${t} left</div>`;
  } else {
    const next = windows.find(w => w.start > hour);
    if (next) {
      const wait = next.start - hour;
      const h = Math.floor(wait), m = Math.round((wait - h) * 60);
      const t = h > 0 ? `${h}h${m > 0 ? ' '+m+'m' : ''}` : `${m}m`;
      statusHtml = `<div class="ht-status neutral">${tipIcon} ${tipTerm} in ${t} · at ${formatHour(next.start)}</div>`;
    } else if (windows.length > 0) {
      statusHtml = `<div class="ht-status shaded">No more ${tipTerm} today</div>`;
    } else {
      statusHtml = `<div class="ht-status shaded">No ${tipTerm} today</div>`;
    }
  }

  // Mini timeline
  let tlHtml = '';
  if (span > 0) {
    const pct = h => ((Math.max(open, Math.min(close, h)) - open) / span * 100).toFixed(2);
    const segs = windows.map(w => {
      const l = pct(w.start), r = pct(w.end);
      return `<div class="ht-tl-seg" style="left:${l}%;width:${(parseFloat(r)-parseFloat(l)).toFixed(2)}%"></div>`;
    }).join('');
    const needle = (hour >= open && hour <= close)
      ? `<div class="ht-tl-needle" style="left:${pct(hour)}%"></div>` : '';
    tlHtml = `
      <div class="ht-timeline">
        <div class="ht-tl-track">${segs}${needle}</div>
        <div class="ht-tl-labels"><span>${formatHour(open)}</span><span>${formatHour(close)}</span></div>
      </div>`;
  }

  return `
    <div class="ht-name">${v.name}</div>
    <div class="ht-meta"><span style="color:var(--accent)">★ ${v.rating}</span> · ${catLabel(v)}${v.beerPrice ? ` · ${v.beerPrice} kr/0.5l` : ''}</div>
    ${statusHtml}${tlHtml}`;
}
