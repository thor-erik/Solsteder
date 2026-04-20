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

/** Small 56×56 clock-face dial for venue cards — no text, just arc + dot. */
function buildCardDial(v, dateStr, fromHour, isSunny) {
  const { windows } = computeSunWindows(v, dateStr);
  const W = 76, H = 76, CX = 38, CY = 38, R = 29, SW = 4;

  const wxNow = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const cloud = wxNow?.cloud ?? 0;
  const precip = wxNow?.precip ?? 0;
  const isRainy = precip > 0.3;
  const isOvercast = !isRainy && cloud > 0.65;
  const dotColor = isRainy ? '#6491D2' : isOvercast ? '#A5AABB' : isSunny ? '#FFAF85' : 'rgba(156,189,231,0.55)';

  const hAngle = h => ((h % 12) / 12) * 2 * Math.PI - Math.PI / 2;
  const pt     = h => { const a = hAngle(h); return [CX + R * Math.cos(a), CY + R * Math.sin(a)]; };
  function arcPath(h1, h2) {
    const dur = h2 - h1;
    if (dur < 0.01) return '';
    if (dur >= 12) {
      const [x1,y1]=pt(h1),[xm,ym]=pt(h1+6);
      return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 1 1 ${xm.toFixed(2)} ${ym.toFixed(2)} A${R} ${R} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
    const [x1,y1]=pt(h1),[x2,y2]=pt(h2);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${dur>6?1:0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  // Per-hour weather coloring
  let arcs = '';
  for (const w of windows) {
    arcs += wxArcPaths(dateStr, w.start, w.end, fromHour, arcPath, SW).join('');
  }
  const wxIcon = typeof skyIcon === 'function' ? skyIcon(cloud) : '☀';
  return `<svg class="card-dial" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="${SW}"/>
    ${arcs}
    <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="middle" font-size="15" style="user-select:none">${wxIcon}</text>
  </svg>`;
}

/** Render a single venue card. Called per-item to keep the map() inline small. */
function renderCard(v, dateStr, fromHour, toHour, isPoint) {
  const dayHours = getVenueHoursForDay(v, dateStr);
  // Collapsed single-line card for closed venues
  if (!v.isOpen && !v.isOpeningSoon) {
    return `
      <div class="venue-card closed-card ${v.id === selectedId ? 'selected' : ''}"
           data-vid="${v.id}" onclick="selectVenue(${v.id}, true)"
           onmouseenter="setHoveredVenue(${v.id})" onmouseleave="setHoveredVenue(null)">
        <div class="closed-row">
          <span class="closed-name">${v.name}</span>
          <span class="card-badge shaded">${t('opens_at', { time: formatHour(dayHours.open) })}</span>
        </div>
      </div>`;
  }

  const dimmedCls = !v.sunInWin ? 'dimmed' : '';
  const { windows } = computeSunWindows(v, dateStr);

  const tempStr = v.score?.feelsLikeTemp != null ? ` · ${v.score.feelsLikeTemp}°` : '';
  const s = v.score;

  const tier = s ? (s.total >= 75 ? 'tier-high' : s.total >= 55 ? 'tier-mid' : s.total >= 35 ? 'tier-low' : 'tier-poor') : '';
  const distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : null;

  // Weather-aware terminology and color class
  const wxCard    = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const cloudCard = wxCard?.cloud ?? 0;
  const precipCard = wxCard?.precip ?? 0;
  const cardRainy = precipCard > 0.3;
  const cardOvercast = !cardRainy && cloudCard > 0.65;
  const cardTermKey = cardRainy ? 'term_rain' : cardOvercast ? 'term_light' : 'term_sun';
  const cardTerm  = t(cardTermKey).toUpperCase();
  const cardTermLc = t(cardTermKey);
  const cardIcon  = cardRainy ? '🌧' : cardOvercast ? '☁' : '☀';
  const durCls    = cardRainy ? 'dur-rainy' : cardOvercast ? 'dur-overcast' : cloudCard > 0.38 ? 'dur-cloudy' : 'dur-sunny';

  let cardBadgeText, cardBadgeCls;
  if (isPoint || nowMode) {
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    if (curWin) {
      const rem = curWin.end - fromHour;
      const bh = Math.floor(rem), bm = Math.round((rem - bh) * 60);
      const dur = (bh > 0 ? bh + 'h ' : '') + (bm > 0 ? bm + 'm' : '');
      cardBadgeText = `${cardIcon} ${dur.trim()} · ${t('word_until')} ${formatHour(curWin.end)}`;
      cardBadgeCls = cardRainy ? 'neutral' : 'sunny';
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) {
        cardBadgeText = `${cardIcon} ${t('word_at')} ${formatHour(next.start)}`;
        cardBadgeCls = 'neutral';
      } else {
        cardBadgeText = windows.length ? t('tl_passed', { term: cardTermLc }) : t('tl_no', { term: cardTermLc });
        cardBadgeCls = 'shaded';
      }
    }
  } else {
    let totalSun = 0;
    for (const w of windows) {
      const ov = Math.min(w.end, toHour) - Math.max(w.start, fromHour);
      if (ov > 0) totalSun += ov;
    }
    if (totalSun > 0) {
      const bh = Math.floor(totalSun), bm = Math.round((totalSun - bh) * 60);
      cardBadgeText = `${cardIcon} ${bh > 0 ? bh+'h ' : ''}${bm > 0 ? bm+'m' : ''} ${cardTermLc}`;
      cardBadgeCls = cardRainy ? 'neutral' : 'sunny';
    } else {
      cardBadgeText = t('tl_no', { term: cardTermLc });
      cardBadgeCls = 'shaded';
    }
  }

  // Override badge for opening/closing-soon states
  if (v.isOpeningSoon) {
    const wait = dayHours.open - fromHour;
    const bm = Math.round(wait * 60);
    cardBadgeText = t('opens_in', { min: bm });
    cardBadgeCls  = 'opening-soon';
  } else if (v.isClosingSoon) {
    cardBadgeText = t('closes_at', { time: formatHour(dayHours.close) });
    cardBadgeCls  = 'closing-soon';
  } else if (!v.isOpen) {
    cardBadgeText = t('opens_at', { time: formatHour(dayHours.open) });
    cardBadgeCls  = 'shaded';
  }

  // Sun status line (not rendered in this layout but sunLineCls drives card-sun-info colour)
  let sunLineCls;
  {
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    if (curWin) {
      sunLineCls = cardRainy ? 'rainy' : cardOvercast ? 'overcast' : 'sunny';
    } else {
      const next = windows.find(w => w.start > fromHour);
      sunLineCls = next ? 'neutral' : 'muted';
    }
    if (v.isOpeningSoon)  sunLineCls = 'opening-soon';
    else if (v.isClosingSoon) sunLineCls = 'closing-soon';
  }

  const metaParts = [v.area, catLabel(v), distStr].filter(Boolean);
  if (s) metaParts.push(`<span class="card-meta-score">${s.total}</span>`);
  const meta = metaParts.map((p, i) =>
    (i > 0 ? '<span class="card-meta-dot">·</span>' : '') + `<span class="card-meta-item">${p}</span>`
  ).join('');

  // Sun info for right side of card sun row
  let sunLabel, sunTime = '', sunDurH = '', sunDurM = '';
  if (isPoint || nowMode) {
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    if (curWin) {
      const rem = curWin.end - fromHour;
      const bh = Math.floor(rem), bm = Math.round((rem - bh) * 60);
      const lastWin = windows[windows.length - 1];
      sunLabel = t('label_until', { term: cardTerm }); sunTime = formatHour(lastWin.end);
      sunDurH = bh > 0 ? `${bh}H` : ''; sunDurM = bm > 0 ? `${bm}M` : '';
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) { sunLabel = t('label_at', { term: cardTerm }); sunTime = formatHour(next.start); }
      else { sunLabel = windows.length ? t('label_passed', { term: cardTerm }) : t('label_no', { term: cardTerm }); }
    }
  } else {
    let totalSun = 0;
    for (const w of windows) { const ov = Math.min(w.end, toHour) - Math.max(w.start, fromHour); if (ov > 0) totalSun += ov; }
    if (totalSun > 0) {
      const bh = Math.floor(totalSun), bm = Math.round((totalSun - bh) * 60);
      sunLabel = t('label_today', { term: cardTerm }); sunTime = bh > 0 ? `${bh}H` : '';
      sunDurM = bm > 0 ? `${bm}M` : '';
      if (!sunTime) { sunTime = sunDurM; sunDurM = ''; }
    } else { sunLabel = t('label_no', { term: cardTerm }); }
  }
  if (v.isOpeningSoon) { sunLabel = t('label_opens_in', { min: Math.round((dayHours.open - fromHour) * 60) }); sunTime = ''; }
  else if (v.isClosingSoon) { sunLabel = t('label_closes', { time: formatHour(dayHours.close) }); }

  const durHtml = (sunDurH || sunDurM)
    ? `<div class="card-sun-dur ${durCls}">${[sunDurH, sunDurM].filter(Boolean).join(' ')}</div>`
    : '';

  const dialSvg = buildCardDial(v, dateStr, fromHour, !!v.sunInWin);

  return `
    <div class="venue-card ${v.sunInWin ? 'sunny' : ''} ${v.id === selectedId ? 'selected' : ''} ${dimmedCls}"
         data-vid="${v.id}" onclick="selectVenue(${v.id}, true)"
         onmouseenter="setHoveredVenue(${v.id})" onmouseleave="setHoveredVenue(null)">
      ${s ? `<div class="card-bloom ${tier}"></div>` : ''}
      <div class="card-name">${v.name}</div>
      <div class="card-meta">${meta}</div>
      <div class="card-sun-row">
        <div class="card-sun-left">
          <div class="card-dial-col">${dialSvg}</div>
          ${durHtml}
        </div>
        <div class="card-sun-info ${sunLineCls}">
          <div class="card-sun-label">${sunLabel}</div>
          ${sunTime ? `<span class="card-sun-time">${sunTime}</span>` : ''}
        </div>
      </div>
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
    document.getElementById('list-sentinel')?.remove();
    list.insertAdjacentHTML('beforeend', html);
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

  // Remove venues with no sun windows, or (today only) all sun already past
  const isTodayFilter = dateStr === todayStr();
  venues = venues.filter(v => {
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
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      return (b.score?.total ?? 0) - (a.score?.total ?? 0);
    });
  } else if (sortBy === 'distance' && userLocation) {
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      const da = Math.hypot(a.lat - userLocation.lat, a.lng - userLocation.lng);
      const db = Math.hypot(b.lat - userLocation.lat, b.lng - userLocation.lng);
      return da - db;
    });
  } else if (sortBy === 'rating') {
    venues.sort((a, b) => {
      const cp = closedPenalty(a) - closedPenalty(b);
      if (cp !== 0) return cp;
      return b.rating - a.rating;
    });
  } else {
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
    <div class="ht-meta"><span style="color:var(--accent)">★ ${v.rating}</span> · ${catLabel(v)}</div>
    ${statusHtml}${tlHtml}`;
}
