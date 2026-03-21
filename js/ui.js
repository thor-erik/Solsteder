/**
 * ui.js — Venue list, timeline, and tooltip rendering.
 * Depends on: solar.js (computeSunWindows, formatHour), data.js (VENUES, catIcon, catLabel),
 *             app.js (computeSunWindows, currentSun, nowMode, selectedId, filterFullSunActive,
 *                     userLocation, datePicker, timeFromEl, timeToEl).
 */

// ── Venue list helpers ────────────────────────────────────────────────────────

function venueHasSunInRange(v, dateStr, fromHour, toHour) {
  const { windows, open, close } = computeSunWindows(v, dateStr);
  if (toHour < open || fromHour > close) return false;
  return windows.some(w => w.end > fromHour && w.start < toHour);
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
    <div class="ht-name">${catIcon(v)} ${v.name}</div>
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
          <span class="closed-name">${catIcon(v)} ${v.name}</span>
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

  const scoreExpandHtml = s ? `<div class="card-score-row">
    <span class="score-badge ${tier}">⭐ ${s.total}</span>
    <span class="score-detail-inline">☀ ${s.sun} · 🌡 ${s.comfort} · ⊙ ${s.distance}</span>
  </div>` : '';

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

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`;

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
      <div class="card-expanded">
        ${scoreExpandHtml}
        <div class="card-address">${v.address}</div>
        <div class="card-actions">
          <a class="card-action-btn" href="${directionsUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ Directions</a>
          <button class="card-action-btn" onclick="event.stopPropagation();shareVenue(${v.id})">⎘ Share</button>
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

  const tempStr = s?.feelsLikeTemp != null ? ` · ${s.feelsLikeTemp}°` : '';
  const distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : null;

  const dial = renderSunDial(v, dateStr, fromHour, 120);
  const timeline = renderTimeline(v, dateStr, fromHour, fromHour);

  const scoreHtml = s ? `
    <div class="dp-score-row">
      <div class="dp-score-num ${tier}">${s.total}<span>score</span></div>
      <div class="dp-score-breakdown">
        <span>☀ Sun ${s.sun}</span>
        <span>🌡 Comfort ${s.comfort}</span>
        <span>⊙ Distance ${s.distance}</span>
      </div>
    </div>` : '';

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`;

  return `
    <div id="dp-scroll">
      <div class="dp-header-row">
        <div class="dp-venue-name">${catIcon(v)} ${v.name}</div>
        <button id="dp-close-btn" onclick="closeDetailPanel()">✕</button>
      </div>
      <div class="dp-meta">${v.area ? v.area + ' · ' : ''}${catLabel(v)}${tempStr}${distStr ? ' · ' + distStr : ''}</div>
      <div class="dp-status-badge">${statusBadge}</div>
      <div class="dp-dial-wrap">${dial.svg}</div>
      ${scoreHtml}
      <div class="dp-divider"></div>
      <div class="dp-section-label">Sun windows</div>
      ${timeline}
      <div class="dp-divider"></div>
      <div class="dp-address">${v.address}</div>
      <div class="dp-actions">
        <a class="dp-action-btn directions" href="${directionsUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ Directions</a>
        <button class="dp-action-btn" onclick="shareVenue(${v.id})">⎘ Share</button>
        <button class="dp-action-btn" onclick="enterEditMode(${v.id})">✎ Edit</button>
      </div>
    </div>`;
}
