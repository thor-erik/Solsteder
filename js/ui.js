/**
 * ui.js — Venue list, timeline, and tooltip rendering.
 * Depends on: solar.js (computeSunWindows, formatHour), data.js (VENUES, catLabel),
 *             app.js (computeSunWindows, currentSun, nowMode, selectedId, filterFullSunActive,
 *                     userLocation, datePicker, timeFromEl, timeToEl).
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

// ── Sun dial (watch face) ─────────────────────────────────────────────────────

function renderSunDial(v, dateStr, fromHour, size = 72) {
  const { windows } = computeSunWindows(v, dateStr);
  const SIZE = 72, CX = 36, CY = 36;
  const R_OUT = 30;  // outer donut edge
  const R_IN  = 14;  // inner hole (clear center for label)

  function h12a(h) { return ((h % 12) / 12) * 2 * Math.PI - Math.PI / 2; }

  // Donut segment path between two clock hours
  function donutPath(h1, h2) {
    const a1 = h12a(h1), a2 = h12a(h2);
    const large = (h2 - h1) % 12 > 6 ? 1 : 0;
    const ox1 = (CX + R_OUT * Math.cos(a1)).toFixed(2), oy1 = (CY + R_OUT * Math.sin(a1)).toFixed(2);
    const ox2 = (CX + R_OUT * Math.cos(a2)).toFixed(2), oy2 = (CY + R_OUT * Math.sin(a2)).toFixed(2);
    const ix1 = (CX + R_IN  * Math.cos(a1)).toFixed(2), iy1 = (CY + R_IN  * Math.sin(a1)).toFixed(2);
    const ix2 = (CX + R_IN  * Math.cos(a2)).toFixed(2), iy2 = (CY + R_IN  * Math.sin(a2)).toFixed(2);
    return `M${ix1},${iy1} L${ox1},${oy1} A${R_OUT},${R_OUT} 0 ${large},1 ${ox2},${oy2} L${ix2},${iy2} A${R_IN},${R_IN} 0 ${large},0 ${ix1},${iy1} Z`;
  }

  // Tick marks on the outer rim — longer at 12/3/6/9
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a    = (i / 12) * 2 * Math.PI - Math.PI / 2;
    const main = i % 3 === 0;
    const r1   = R_OUT + 1, r2 = R_OUT + (main ? 5 : 3);
    const x1 = (CX + r1 * Math.cos(a)).toFixed(1), y1 = (CY + r1 * Math.sin(a)).toFixed(1);
    const x2 = (CX + r2 * Math.cos(a)).toFixed(1), y2 = (CY + r2 * Math.sin(a)).toFixed(1);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
      stroke="rgba(255,255,255,${main ? 0.35 : 0.15})"
      stroke-width="${main ? 1.2 : 0.8}" stroke-linecap="round"/>`;
  }).join('');

  // Sun donut segments — past dim, future bright amber
  const sunSegments = windows.map(w => {
    const parts = [];
    if (w.start < fromHour) {
      const pastEnd = Math.min(w.end, fromHour);
      if (pastEnd - w.start > 0.05)
        parts.push(`<path d="${donutPath(w.start, pastEnd)}" fill="rgba(255,184,0,0.18)"/>`);
    }
    if (w.end > fromHour) {
      const futStart = Math.max(w.start, fromHour);
      if (w.end - futStart > 0.05)
        parts.push(`<path d="${donutPath(futStart, w.end)}" fill="rgba(255,184,0,0.82)"/>`);
    }
    return parts.join('');
  }).join('');

  // Current time: white radial line through the donut ring only
  const ca  = h12a(fromHour);
  const cx1 = (CX + R_IN  * Math.cos(ca)).toFixed(1), cy1 = (CY + R_IN  * Math.sin(ca)).toFixed(1);
  const cx2 = (CX + R_OUT * Math.cos(ca)).toFixed(1), cy2 = (CY + R_OUT * Math.sin(ca)).toFixed(1);
  const timeLine = `<line x1="${cx1}" y1="${cy1}" x2="${cx2}" y2="${cy2}" stroke="white" stroke-width="2" stroke-linecap="round" opacity="0.9"/>`;

  // Center: end-time label
  const lastFuture = [...windows].reverse().find(w => w.end > fromHour);
  let centerLabel = '';
  if (lastFuture) {
    centerLabel = `
    <text x="${CX}" y="${CY - 2}" text-anchor="middle" dominant-baseline="middle"
      font-size="7" font-family="system-ui,sans-serif" font-weight="700"
      fill="rgba(255,184,0,1)">${formatHour(lastFuture.end)}</text>
    <text x="${CX}" y="${CY + 5.5}" text-anchor="middle" dominant-baseline="middle"
      font-size="4.5" font-family="system-ui,sans-serif"
      fill="rgba(255,255,255,0.38)">last sun</text>`;
  }

  const svg = `<svg class="sun-dial" width="${size}" height="${size}" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true">
    <circle cx="${CX}" cy="${CY}" r="${R_OUT}" fill="rgba(0,0,0,0.28)"/>
    ${sunSegments}
    ${ticks}
    ${timeLine}
    <circle cx="${CX}" cy="${CY}" r="${R_IN}" fill="rgba(20,25,40,0.9)"/>
    ${centerLabel}
  </svg>`;

  return { svg, label: '' };
}

// ── Timeline strip ────────────────────────────────────────────────────────────

function renderTimeline(v, dateStr, fromHour, toHour) {
  const { windows, open, close } = computeSunWindows(v, dateStr);
  const span = close - open;
  if (span <= 0) return '';

  const isPoint = Math.abs(fromHour - toHour) < 0.01;

  // Closed during the selected window
  const isClosed = toHour < open || fromHour > close;
  if (isClosed) {
    return `
    <div class="card-timeline">
      <div class="tl-row">
        <div class="tl-track" style="opacity:0.35"></div>
        <span class="tl-closed-badge">Closed</span>
      </div>
      <div class="tl-labels">
        <span>Opens ${formatHour(open)}</span>
        <span>Closes ${formatHour(close)}</span>
      </div>
    </div>`;
  }

  function pct(h) { return (Math.max(open, Math.min(close, h)) - open) / span * 100; }

  // Sun segments
  const sunSegs = windows.map(w => {
    const l = pct(w.start), r = pct(w.end);
    return `<div class="tl-sun-seg" style="left:${l.toFixed(2)}%;width:${(r-l).toFixed(2)}%"></div>`;
  }).join('');

  // Shade segments
  let shadeSegs = '', prev = open;
  for (const w of windows) {
    if (w.start > prev + 0.01) {
      const l = pct(prev), r = pct(w.start);
      shadeSegs += `<div class="tl-shade-seg" style="left:${l.toFixed(2)}%;width:${(r-l).toFixed(2)}%"></div>`;
    }
    prev = w.end;
  }
  if (prev < close - 0.01) {
    const l = pct(prev), r = pct(close);
    shadeSegs += `<div class="tl-shade-seg" style="left:${l.toFixed(2)}%;width:${(r-l).toFixed(2)}%"></div>`;
  }

  // Needle (single point) or range band
  let needle = '';
  if (fromHour >= open && fromHour <= close) {
    if (isPoint) {
      needle = `<div class="tl-needle" style="left:${pct(fromHour).toFixed(2)}%"></div>`;
    } else {
      const rl = pct(fromHour), rr = pct(Math.min(close, toHour));
      needle = `<div class="tl-range-seg" style="left:${rl.toFixed(2)}%;width:${(rr-rl).toFixed(2)}%"></div>`;
    }
  }

  // End-of-sun tick — always marks the END of the last sun window for the day
  const lastWin = windows.length > 0 ? windows[windows.length - 1] : null;
  const endOfSunTick = (lastWin && lastWin.end > fromHour)
    ? `<div class="tl-end-sun" style="left:${pct(lastWin.end).toFixed(2)}%"><span class="tl-end-sun-label">${formatHour(lastWin.end)}</span></div>`
    : '';

  // Badge: point/now mode vs range mode
  const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
  let badge = '';
  if (isPoint || nowMode) {
    if (curWin) {
      const rem = curWin.end - fromHour;
      const h = Math.floor(rem), m = Math.round((rem - h) * 60);
      badge = `<span class="tl-badge sunny">☀ ${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''} left</span>`;
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) {
        const wait = next.start - fromHour;
        const h = Math.floor(wait), m = Math.round((wait - h) * 60);
        badge = `<span class="tl-badge neutral">☀ in ${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''}</span>`;
      } else {
        badge = `<span class="tl-badge muted">${windows.length ? 'Sun passed' : 'No sun'}</span>`;
      }
    }
  } else {
    let totalSun = 0;
    for (const w of windows) {
      const overlap = Math.min(w.end, toHour) - Math.max(w.start, fromHour);
      if (overlap > 0) totalSun += overlap;
    }
    if (totalSun > 0) {
      const h = Math.floor(totalSun), m = Math.round((totalSun - h) * 60);
      badge = `<span class="tl-badge sunny">☀ ${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''} sun</span>`;
    } else {
      badge = `<span class="tl-badge muted">No sun</span>`;
    }
  }

  return `
    <div class="card-timeline">
      <div class="tl-row">
        <div class="tl-track">${shadeSegs}${sunSegs}${needle}${endOfSunTick}</div>
      </div>
      <div class="tl-labels">
        <span>Opens ${formatHour(open)}</span>
        <span>Closes ${formatHour(close)}</span>
      </div>
    </div>`;
}

// ── Hover tooltip ─────────────────────────────────────────────────────────────

function buildTooltipContent(v) {
  const dateStr = datePicker.value;
  const hour = parseFloat(timeFromEl.value);
  const { windows, open, close } = computeSunWindows(v, dateStr);
  const span = close - open;

  // Status + timing
  let statusHtml = '';
  const curWin = windows.find(w => hour >= w.start && hour < w.end);
  if (curWin) {
    const rem = curWin.end - hour;
    const h = Math.floor(rem), m = Math.round((rem - h) * 60);
    const t = h > 0 ? `${h}h${m > 0 ? ' '+m+'m' : ''}` : `${m}m`;
    statusHtml = `<div class="ht-status sunny">☀ In sun · ${t} left</div>`;
  } else {
    const next = windows.find(w => w.start > hour);
    if (next) {
      const wait = next.start - hour;
      const h = Math.floor(wait), m = Math.round((wait - h) * 60);
      const t = h > 0 ? `${h}h${m > 0 ? ' '+m+'m' : ''}` : `${m}m`;
      statusHtml = `<div class="ht-status neutral">☀ Sun in ${t} · at ${formatHour(next.start)}</div>`;
    } else if (windows.length > 0) {
      statusHtml = `<div class="ht-status shaded">No more sun today</div>`;
    } else {
      statusHtml = `<div class="ht-status shaded">No sun today</div>`;
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

// ── Venue list ────────────────────────────────────────────────────────────────

const LIST_PAGE = 30; // cards rendered per batch
let _listFiltered = []; // current sorted+filtered result
let _listObserver = null; // IntersectionObserver for infinite scroll

/** Render a single venue card. Called per-item to keep the map() inline small. */
function renderCard(v, dateStr, fromHour, toHour, isPoint) {
  // Collapsed single-line card for closed venues
  if (!v.isOpen && !v.isOpeningSoon) {
    return `
      <div class="venue-card closed-card ${v.id === selectedId ? 'selected' : ''}"
           data-vid="${v.id}" onclick="selectVenue(${v.id}, true)"
           onmouseenter="setHoveredVenue(${v.id})" onmouseleave="setHoveredVenue(null)">
        <div class="closed-row">
          <span class="closed-name">${v.name}</span>
          <span class="card-badge shaded">Opens ${formatHour(v.openingHours.open)}</span>
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


  let cardBadgeText, cardBadgeCls;
  if (isPoint || nowMode) {
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    if (curWin) {
      const rem = curWin.end - fromHour;
      const bh = Math.floor(rem), bm = Math.round((rem - bh) * 60);
      const dur = (bh > 0 ? bh + 'h ' : '') + (bm > 0 ? bm + 'm' : '');
      cardBadgeText = `☀ ${dur.trim()} · until ${formatHour(curWin.end)}`;
      cardBadgeCls = 'sunny';
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) {
        const wait = next.start - fromHour;
        const bh = Math.floor(wait), bm = Math.round((wait - bh) * 60);
        cardBadgeText = `☀ at ${formatHour(next.start)}`;
        cardBadgeCls = 'neutral';
      } else {
        cardBadgeText = windows.length ? 'Sun passed' : 'No sun';
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
      cardBadgeText = `☀ ${bh > 0 ? bh+'h ' : ''}${bm > 0 ? bm+'m' : ''} sun`;
      cardBadgeCls = 'sunny';
    } else {
      cardBadgeText = 'No sun';
      cardBadgeCls = 'shaded';
    }
  }

  // Override badge for opening/closing-soon states
  if (v.isOpeningSoon) {
    const { open } = v.openingHours;
    const wait = open - fromHour;
    const bm = Math.round(wait * 60);
    cardBadgeText = `Opens in ${bm}m`;
    cardBadgeCls  = 'opening-soon';
  } else if (v.isClosingSoon) {
    const { close } = v.openingHours;
    cardBadgeText = `Closes ${formatHour(close)}`;
    cardBadgeCls  = 'closing-soon';
  } else if (!v.isOpen) {
    const { open } = v.openingHours;
    cardBadgeText = `Opens ${formatHour(open)}`;
    cardBadgeCls  = 'shaded';
  }

  return `
    <div class="venue-card ${v.sunInWin ? 'sunny' : ''} ${v.id === selectedId ? 'selected' : ''} ${dimmedCls}"
         data-vid="${v.id}" onclick="selectVenue(${v.id}, true)"
         onmouseenter="setHoveredVenue(${v.id})" onmouseleave="setHoveredVenue(null)">
      <div class="card-body">
        <div class="card-content">
          <div class="card-top-row">
            <div class="card-name">${v.name}</div>
            ${s ? `<div class="card-score-num ${tier}">${s.total}<span>score</span></div>` : ''}
          </div>
          <span class="card-badge ${cardBadgeCls}">${cardBadgeText}</span>
          <div class="card-meta">${v.area ?? ''}${v.area ? ' · ' : ''}${catLabel(v)}${tempStr}${distStr ? ' · ' + distStr : ''}</div>
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
    const { open, close } = v.openingHours;
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

  if (filterMapViewActive) {
    const bounds = map.getBounds();
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
    banner.innerHTML = `<span>Sun has set for today</span><button onclick="advanceDay(1, 12)">Tomorrow →</button>`;
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
    list.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:30px 10px;">No venues match your filters</div>`;
    return;
  }

  // ── Render first page, observer handles the rest ──────────────────────────
  _listFiltered = venues;
  renderListPage(list, dateStr, fromHour, toHour, isPoint, true);

  // Update count label
  const openCount = venues.filter(v => v.isOpen || v.isOpeningSoon).length;
  const sunCount  = venues.filter(v => v.sunInWin && v.isOpen).length;
  const countEl   = document.getElementById('venue-count');
  if (countEl) {
    if (sunCount > 0) {
      countEl.textContent = `${sunCount} places in the sun`;
      countEl.className = 'count-sunny';
    } else {
      countEl.textContent = `${openCount} open`;
      countEl.className = '';
    }
  }
}

// ── Isometric wind-shelter diagram ────────────────────────────────────────────

/**
 * Draw a static isometric diagram showing the venue building, nearby buildings,
 * terrace zone, and current wind direction + shelter status.
 *
 * Coordinate conventions:
 *   - world: x = east (m), y = north (m), z = up (m)
 *   - The scene is rotated so v.facing maps to bearing 45° (NE) in the diagram,
 *     which makes the terrace face the bottom of the canvas (toward the viewer).
 *   - Isometric: sx = CX + (x-y)*scale,  sy = CY + (x+y)*scale*0.5 − z*scale
 *   - Wall visibility (CCW polygon): front face if (dy > dx) for edge A→B
 */
function drawShelterDiagram(v, wx, canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // ── Coordinate helpers ──────────────────────────────────────────────────────
  const cosLat = Math.cos(v.lat * Math.PI / 180);

  // Rotate so v.facing → bearing 45° (NE = iso "front-bottom")
  const θ    = (v.facing - 45) * Math.PI / 180;
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ);

  function toLocal(lat, lng) {
    const ex = (lng - v.lng) * cosLat * 111320;
    const ny = (lat - v.lat) * 111320;
    return { x: ex * cosθ - ny * sinθ, y: ex * sinθ + ny * cosθ };
  }

  let ISO_SCALE = 4;
  const CX = W * 0.5, CY = H * 0.52; // extra headroom above roof

  function toIso(x, y, z) {
    return { sx: CX + (x - y) * ISO_SCALE, sy: CY + (x + y) * ISO_SCALE * 0.5 - z * ISO_SCALE };
  }

  // ── Collect geometry ────────────────────────────────────────────────────────
  const VENUE_H     = 12;
  const terrDepth   = v.autoTerraceDepth ?? 6;

  let venueNodes = (v.buildingGeometry || []).map(n => toLocal(n.lat, n.lon));
  if (venueNodes.length < 3) {
    // Synthetic placeholder if OSM geometry is missing
    venueNodes = [
      { x: -7, y: -5 }, { x: 7, y: -5 }, { x: 7, y: 5 }, { x: -7, y: 5 }, { x: -7, y: -5 },
    ];
  }

  const nearbyBlds = (v.nearbyBuildings || [])
    .map(b => ({
      nodes:  (b.geometry || []).map(n => toLocal(n.lat, n.lon)),
      height: b.height ?? 12,
    }))
    .filter(b => {
      if (b.nodes.length < 3) return false;
      const cx = b.nodes.reduce((s, n) => s + n.x, 0) / b.nodes.length;
      const cy = b.nodes.reduce((s, n) => s + n.y, 0) / b.nodes.length;
      return Math.hypot(cx, cy) < 55;
    });

  // ── Auto-scale: fit building footprint + height + terrace into canvas ───────
  const allNodes = [...venueNodes, ...nearbyBlds.flatMap(b => b.nodes)];
  if (allNodes.length >= 2) {
    // Horizontal extent in iso: max |x - y| across all nodes
    const maxHoriz = Math.max(1, ...allNodes.map(n => Math.abs(n.x - n.y)));
    // Vertical extent in iso: (x+y)*0.5*scale for ground + VENUE_H*scale for height
    //   + terrace extends another terrDepth * √2 * 0.5 * scale downward
    const maxGndY  = Math.max(1, ...allNodes.map(n => Math.abs(n.x + n.y)));
    const vertSpan = maxGndY * 0.5 + VENUE_H + terrDepth * 0.707;

    ISO_SCALE = Math.min(
      (W * 0.38) / maxHoriz,
      (H * 0.58) / vertSpan,
      5.5                    // hard cap so large buildings don't dominate
    );
  }

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.fillStyle = '#090f1c';
  ctx.fillRect(0, 0, W, H);
  const bgG = ctx.createLinearGradient(0, 0, 0, H);
  bgG.addColorStop(0, 'rgba(5,15,40,0.5)');
  bgG.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bgG;
  ctx.fillRect(0, 0, W, H);

  // ── Ground grid ─────────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = 'rgba(81,69,50,0.07)';
  ctx.lineWidth = 0.5;
  for (let i = -80; i <= 80; i += 10) {
    const a = toIso(i, -80, 0), b = toIso(i, 80, 0);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    const c = toIso(-80, i, 0), d = toIso(80, i, 0);
    ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.stroke();
  }
  ctx.restore();

  // ── Wind + shelter setup ────────────────────────────────────────────────────
  // In our rotated frame, facing = bearing 45°; sheltered when wind from ~225°
  const shelter     = wx ? venueWindShelter(v.facing, wx.wdir) : null;
  const rotWindDir  = (wx?.wdir != null)
    ? ((wx.wdir - v.facing + 45) + 360) % 360
    : null;

  // ── Wind wake cone ──────────────────────────────────────────────────────────
  if (rotWindDir != null && wx.wspd > 0.3) {
    const wakeRad = ((rotWindDir + 180) % 360) * Math.PI / 180;
    const wL = 55;
    const wEx = Math.sin(wakeRad) * wL, wNy = Math.cos(wakeRad) * wL;
    const s1  = toIso(wEx - Math.cos(wakeRad) * 22, wNy + Math.sin(wakeRad) * 22, 0.2);
    const tip = toIso(wEx, wNy, 0.2);
    const s2  = toIso(wEx + Math.cos(wakeRad) * 22, wNy - Math.sin(wakeRad) * 22, 0.2);
    const org = toIso(0, 0, 0.2);
    const len = Math.max(1, Math.hypot(tip.sx - org.sx, tip.sy - org.sy));

    const [r, g, b_] = shelter > 0.6 ? [100, 255, 180] : shelter > 0.3 ? [240, 180, 106] : [255, 110, 80];
    const wGrad = ctx.createRadialGradient(org.sx, org.sy, 0, org.sx, org.sy, len);
    wGrad.addColorStop(0, `rgba(${r},${g},${b_},0.22)`);
    wGrad.addColorStop(1, `rgba(${r},${g},${b_},0)`);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(org.sx, org.sy);
    ctx.lineTo(s1.sx, s1.sy);
    ctx.lineTo(tip.sx, tip.sy);
    ctx.lineTo(s2.sx, s2.sy);
    ctx.closePath();
    ctx.fillStyle = wGrad;
    ctx.fill();
    ctx.restore();
  }

  // ── Isometric block drawing ─────────────────────────────────────────────────
  function polySignedArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    return a / 2;
  }

  function drawIsoBlock(nodes, height, colors) {
    if (nodes.length < 3) return;
    const ccw = polySignedArea(nodes) > 0;

    // Two passes: back walls first, then front walls (painter's algo within block)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i], b = nodes[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        // Front-face rule: CCW → visible if dy > dx; CW → visible if dy < dx
        const front = ccw ? (dy > dx) : (dy < dx);
        if ((pass === 0) === front) continue;

        const p0 = toIso(a.x, a.y, 0),      p1 = toIso(b.x, b.y, 0);
        const p2 = toIso(b.x, b.y, height), p3 = toIso(a.x, a.y, height);
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy);
        ctx.lineTo(p2.sx, p2.sy); ctx.lineTo(p3.sx, p3.sy);
        ctx.closePath();
        ctx.fillStyle = front ? colors.wallFront : colors.wallBack;
        ctx.fill();
        ctx.strokeStyle = colors.edge; ctx.lineWidth = 0.5; ctx.stroke();
      }
    }

    // Roof polygon
    ctx.beginPath();
    const r0 = toIso(nodes[0].x, nodes[0].y, height);
    ctx.moveTo(r0.sx, r0.sy);
    for (let i = 1; i < nodes.length - 1; i++) {
      const p = toIso(nodes[i].x, nodes[i].y, height);
      ctx.lineTo(p.sx, p.sy);
    }
    ctx.closePath();
    ctx.fillStyle = colors.roof;
    ctx.fill();
    ctx.strokeStyle = colors.edge; ctx.lineWidth = 0.7; ctx.stroke();
  }

  // ── Sort + draw all buildings ───────────────────────────────────────────────
  // Painter's order: smaller centroid (x+y) = further NW in iso = draw first
  const allBlds = [
    ...nearbyBlds.map(b => ({ ...b, isVenue: false })),
    { nodes: venueNodes, height: VENUE_H, isVenue: true },
  ].filter(b => b.nodes.length >= 3);

  allBlds.sort((a, b_) => {
    const ca = a.nodes.reduce((s, n) => s + n.x + n.y, 0) / a.nodes.length;
    const cb = b_.nodes.reduce((s, n) => s + n.x + n.y, 0) / b_.nodes.length;
    return ca - cb;
  });

  for (const bld of allBlds) {
    drawIsoBlock(bld.nodes, bld.height, bld.isVenue ? {
      wallBack:  'rgba(36,46,76,0.95)',
      wallFront: 'rgba(48,60,98,0.95)',
      roof:      'rgba(54,68,110,0.95)',
      edge:      'rgba(255,184,0,0.30)',
    } : {
      wallBack:  'rgba(16,22,38,0.88)',
      wallFront: 'rgba(22,29,50,0.88)',
      roof:      'rgba(25,33,56,0.88)',
      edge:      'rgba(81,69,50,0.16)',
    });
  }

  // ── Terrace zone ────────────────────────────────────────────────────────────
  // Terrace extends from the wall in the facing direction (NE = +0.707, +0.707 in rotated frame)
  if (v.wallSegment) {
    const ws = v.wallSegment;
    const a  = toLocal(ws.aLat, ws.aLng);
    const b  = toLocal(ws.bLat, ws.bLng);
    const td = terrDepth * 0.7071; // sin/cos 45°
    const pA0 = toIso(a.x,      a.y,      0.1);
    const pB0 = toIso(b.x,      b.y,      0.1);
    const pB1 = toIso(b.x + td, b.y + td, 0.1);
    const pA1 = toIso(a.x + td, a.y + td, 0.1);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pA0.sx, pA0.sy); ctx.lineTo(pB0.sx, pB0.sy);
    ctx.lineTo(pB1.sx, pB1.sy); ctx.lineTo(pA1.sx, pA1.sy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,184,0,0.11)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,184,0,0.42)';
    ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Wind arrows ─────────────────────────────────────────────────────────────
  if (rotWindDir != null && wx.wspd > 0.3) {
    const fromRad = rotWindDir * Math.PI / 180;
    for (const off of [-11, 11]) {
      const perpX = -Math.cos(fromRad) * off;
      const perpY =  Math.sin(fromRad) * off;
      const start = toIso(Math.sin(fromRad) * 42 + perpX, Math.cos(fromRad) * 42 + perpY, 1.5);
      const end   = toIso(Math.sin(fromRad) * 14 + perpX, Math.cos(fromRad) * 14 + perpY, 1.5);

      ctx.save();
      ctx.beginPath(); ctx.moveTo(start.sx, start.sy); ctx.lineTo(end.sx, end.sy);
      ctx.strokeStyle = 'rgba(120,180,255,0.50)';
      ctx.lineWidth = 1.2; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);

      const ang = Math.atan2(end.sy - start.sy, end.sx - start.sx);
      ctx.beginPath();
      ctx.moveTo(end.sx, end.sy);
      ctx.lineTo(end.sx - 7 * Math.cos(ang - 0.45), end.sy - 7 * Math.sin(ang - 0.45));
      ctx.lineTo(end.sx - 7 * Math.cos(ang + 0.45), end.sy - 7 * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fillStyle = 'rgba(120,180,255,0.60)';
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Labels ──────────────────────────────────────────────────────────────────
  // Venue name above roof
  ctx.save();
  ctx.font = '600 9px Inter,sans-serif';
  ctx.fillStyle = 'rgba(255,184,0,0.78)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const label = v.name.length > 20 ? v.name.slice(0, 18) + '…' : v.name;
  const namePt = toIso(0, 0, VENUE_H + 2.5);
  ctx.fillText(label, namePt.sx, namePt.sy);
  ctx.restore();

  // "terrace" label on the terrace zone
  if (v.wallSegment) {
    const ws = v.wallSegment;
    const a  = toLocal(ws.aLat, ws.aLng);
    const b  = toLocal(ws.bLat, ws.bLng);
    const td = terrDepth * 0.7071;
    const mx = (a.x + b.x) / 2 + td * 0.5;
    const my = (a.y + b.y) / 2 + td * 0.5;
    const tPt = toIso(mx, my, 0.5);
    ctx.save();
    ctx.font = '500 8px Inter,sans-serif';
    ctx.fillStyle = 'rgba(255,184,0,0.40)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('terrace', tPt.sx, tPt.sy);
    ctx.restore();
  }

  // North indicator (where north is in the rotated diagram)
  {
    const northBearing = ((45 - v.facing) + 360) % 360;
    const nRad = northBearing * Math.PI / 180;
    const nDist = Math.min(32, 28 / Math.max(ISO_SCALE, 1));
    const nPt = toIso(Math.sin(nRad) * nDist, Math.cos(nRad) * nDist, 0.5);
    ctx.save();
    ctx.font = '700 8px Inter,sans-serif';
    ctx.fillStyle = 'rgba(213,196,171,0.28)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nPt.sx, nPt.sy);
    ctx.restore();
  }

  // Bottom bar: shelter status + wind reading
  if (wx && shelter != null) {
    ctx.save();
    ctx.textBaseline = 'bottom';
    const sLabel = shelter > 0.6 ? '🛡 Sheltered' : shelter > 0.3 ? '◑ Partial' : '💨 Exposed';
    const sColor = shelter > 0.6 ? '#64ffb4' : shelter > 0.3 ? '#f0b46a' : '#ff8a8a';
    ctx.font = '700 10px Inter,sans-serif';
    ctx.fillStyle = sColor;
    ctx.textAlign = 'left';
    ctx.fillText(sLabel, 8, H - 8);
    ctx.fillStyle = 'rgba(120,180,255,0.60)';
    ctx.textAlign = 'right';
    ctx.fillText(`${windCardinal(wx.wdir)} ${wx.wspd.toFixed(1)} m/s`, W - 8, H - 8);
    ctx.restore();
  } else if (!wx) {
    ctx.save();
    ctx.font = '500 9px Inter,sans-serif';
    ctx.fillStyle = 'rgba(213,196,171,0.25)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('No wind data', W / 2, H - 8);
    ctx.restore();
  }
}

// ── Busyness bar chart ────────────────────────────────────────────────────────

function renderBusynessChart(v, dateStr, fromHour) {
  const profile = getBusynessForDay(v, dateStr);
  const { open, close } = v.openingHours;
  const span = Math.ceil(close) - Math.floor(open);
  if (span <= 0) return '';

  const BAR_W = 6, GAP = 2, H = 36;
  const hours = Array.from({ length: span }, (_, i) => Math.floor(open) + i);
  const totalW = hours.length * (BAR_W + GAP) - GAP;

  const nowValue = getBusynessAt(v, dateStr, fromHour);
  const nowLabel = busynessLabel(nowValue);

  const bars = hours.map(h => {
    const val  = profile[h] ?? 0;
    const barH = Math.max(2, Math.round(val / 100 * H));
    const y    = H - barH;
    const isCurrent = Math.floor(fromHour) === h;
    const fill = isCurrent
      ? 'rgba(255,184,0,0.95)'
      : val > 0
        ? `rgba(255,184,0,${(0.18 + val / 100 * 0.45).toFixed(2)})`
        : 'rgba(81,69,50,0.12)';
    const x = hours.indexOf(h) * (BAR_W + GAP);
    return `<rect x="${x}" y="${y}" width="${BAR_W}" height="${barH}" rx="1.5" fill="${fill}"/>`;
  }).join('');

  // Hour labels: just first + last
  const labelFirst = formatHour(open);
  const labelLast  = formatHour(close);

  return `
    <div class="dp-busy-row">
      <span class="dp-busy-now">${nowLabel}</span>
      <span class="dp-busy-est">est.</span>
    </div>
    <div class="dp-busy-chart">
      <svg width="${totalW}" height="${H}" viewBox="0 0 ${totalW} ${H}" style="display:block;overflow:visible">
        ${bars}
      </svg>
      <div class="dp-busy-labels">
        <span>${labelFirst}</span>
        <span>${labelLast}</span>
      </div>
    </div>`;
}

// ── Detail panel content ──────────────────────────────────────────────────────

function renderDetailPanelContent(v, dateStr, fromHour) {
  const wxNow = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const s = typeof computeVenueScore === 'function'
    ? computeVenueScore(v, dateStr, fromHour, wxNow, userLocation)
    : null;
  const tier = s ? (s.total >= 75 ? 'tier-high' : s.total >= 55 ? 'tier-mid' : s.total >= 35 ? 'tier-low' : 'tier-poor') : '';

  const { windows } = computeSunWindows(v, dateStr);

  // Sun status badge
  const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
  let statusBadge;
  if (curWin) {
    const rem = curWin.end - fromHour;
    const bh = Math.floor(rem), bm = Math.round((rem - bh) * 60);
    const dur = (bh > 0 ? bh + 'h ' : '') + (bm > 0 ? bm + 'm' : '');
    statusBadge = `<span class="score-badge tier-high">☀ ${dur.trim()} · until ${formatHour(curWin.end)}</span>`;
  } else {
    const next = windows.find(w => w.start > fromHour);
    if (next) {
      statusBadge = `<span class="score-badge tier-mid">☀ Sun at ${formatHour(next.start)}</span>`;
    } else {
      statusBadge = `<span class="score-badge tier-poor">${windows.length ? 'Sun passed' : 'No sun today'}</span>`;
    }
  }

  const distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : null;

  const timeline = renderTimeline(v, dateStr, fromHour, fromHour);

  // Noise chip — prefer official Geonorge zone, fall back to OSM estimate
  const noiseChip = v.noiseZone != null
    ? v.noiseZone === 'red'    ? { label: 'High traffic noise',     cls: 'noise-high', icon: '🔊' }
    : v.noiseZone === 'yellow' ? { label: 'Moderate noise',         cls: 'noise-mid',  icon: '🔉' }
    :                            { label: 'Low noise level',         cls: 'noise-low',  icon: '🔈' }
    : v.noiseScore != null
    ? v.noiseScore > 0.65 ? { label: 'Noisy (est.)',           cls: 'noise-high', icon: '🔊' }
    : v.noiseScore > 0.35 ? { label: 'Some traffic (est.)',    cls: 'noise-mid',  icon: '🔉' }
    :                        { label: 'Quiet (est.)',           cls: 'noise-low',  icon: '🔈' }
    : null;

  // Wind shelter chip
  const shelterChip = s?.shelter != null
    ? s.shelter > 0.6 ? { label: 'Well sheltered',   cls: 'env-sheltered', icon: '🛡' }
    : s.shelter > 0.3 ? { label: 'Some shelter',      cls: 'env-partial',   icon: '🛡' }
    :                   { label: 'Exposed to wind',   cls: 'env-exposed',   icon: '💨' }
    : null;

  const envSection = (noiseChip || shelterChip) ? `
    <div class="dp-divider"></div>
    <div class="dp-section-label">Environment</div>
    <div class="dp-env-row">
      ${noiseChip   ? `<div class="dp-env-chip ${noiseChip.cls}">${noiseChip.icon} ${noiseChip.label}</div>` : ''}
      ${shelterChip ? `<div class="dp-env-chip ${shelterChip.cls}">${shelterChip.icon} ${shelterChip.label}</div>` : ''}
    </div>` : '';

  const scoreHtml = s ? `
    <div class="dp-divider"></div>
    <div class="dp-score-row">
      <div class="dp-score-num ${tier}">${s.total}<span>score</span></div>
      <div class="dp-score-breakdown">
        <span>☀ Sun ${s.sun}</span>
        <span>🌡 Comfort ${s.comfort}</span>
        <span>⊙ Distance ${s.distance}</span>
        ${s.noise != null ? `<span>🔊 Noise ${s.noise}</span>` : ''}
      </div>
    </div>` : '';

  const { svg: dialSvg } = renderSunDial(v, dateStr, fromHour, 120);

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`;
  const websiteUrl    = `https://www.google.com/search?q=${encodeURIComponent(v.name + ' ' + (v.area ?? '') + ' Oslo')}`;

  const ICON_DIR   = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;
  const ICON_WEB   = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
  const ICON_SHARE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
  const ICON_EDIT  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

  const photosHtml = v.photoUrls?.length
    ? `<div class="dp-photos">${
        v.photoUrls.map(url => `<img class="dp-photo" src="${url}" loading="lazy" alt="">`).join('')
      }</div>`
    : '';

  return `
    <div id="dp-scroll">
      ${photosHtml}
      <div class="dp-header-row">
        <div class="dp-venue-name">${v.name}</div>
        <button id="dp-close-btn" onclick="closeDetailPanel()">✕</button>
      </div>
      <div class="dp-meta">
        <span style="color:var(--accent)">★ ${v.rating}</span>
        &nbsp;·&nbsp;${catLabel(v)}&nbsp;·&nbsp;${v.area ?? ''}${distStr ? '&nbsp;·&nbsp;' + distStr : ''}
      </div>
      <div class="dp-status-badge">${statusBadge}</div>

      <div class="dp-dial-wrap">${dialSvg}</div>

      <div class="dp-gm-actions">
        <a class="dp-gm-chip" href="${directionsUrl}" target="_blank" rel="noopener">${ICON_DIR}<span>Directions</span></a>
        <a class="dp-gm-chip" href="${websiteUrl}" target="_blank" rel="noopener">${ICON_WEB}<span>Website</span></a>
        <button class="dp-gm-chip" onclick="shareVenue(${v.id})">${ICON_SHARE}<span>Share</span></button>
        <button class="dp-gm-chip" onclick="enterEditMode(${v.id})">${ICON_EDIT}<span>Edit</span></button>
      </div>

      <div class="dp-divider"></div>
      <div class="dp-section-label">Sun today</div>
      ${timeline}
      ${scoreHtml}
      ${envSection}
      <div class="dp-divider"></div>
      <div class="dp-section-label">Wind shelter</div>
      <canvas id="dp-shelter-canvas" width="268" height="180" style="display:block;width:100%;border-radius:10px;border:1px solid rgba(81,69,50,0.18);"></canvas>
      <div class="dp-divider"></div>
      <div class="dp-section-label">Busyness</div>
      ${renderBusynessChart(v, dateStr, fromHour)}
      <div class="dp-divider"></div>
      <div class="dp-address">${v.address}</div>
    </div>`;
}
