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

  // End-of-sun tick (when currently inside a sun window)
  const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
  const endOfSunTick = curWin
    ? `<div class="tl-end-sun" style="left:${pct(curWin.end).toFixed(2)}%"><span class="tl-end-sun-label">${formatHour(curWin.end)}</span></div>`
    : '';

  // Badge: point/now mode vs range mode
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
  const closedCls = !v.isOpen ? 'closed-now' : '';
  const dimmedCls = !v.sunInWin ? 'dimmed' : '';
  const { windows } = computeSunWindows(v, dateStr);

  let cardBadgeText, cardBadgeCls;
  if (isPoint || nowMode) {
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    if (curWin) {
      const rem = curWin.end - fromHour;
      const bh = Math.floor(rem), bm = Math.round((rem - bh) * 60);
      cardBadgeText = `☀ ${bh > 0 ? bh+'h ' : ''}${bm > 0 ? bm+'m' : ''} left`;
      cardBadgeCls = 'sunny';
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) {
        const wait = next.start - fromHour;
        const bh = Math.floor(wait), bm = Math.round((wait - bh) * 60);
        cardBadgeText = `☀ in ${bh > 0 ? bh+'h ' : ''}${bm > 0 ? bm+'m' : ''}`;
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

  return `
    <div class="venue-card ${v.sunInWin ? 'sunny' : ''} ${v.id === selectedId ? 'selected' : ''} ${dimmedCls} ${closedCls}"
         data-vid="${v.id}" onclick="selectVenue(${v.id}, true)">
      <div class="card-top">
        <div class="card-name">${catIcon(v)} ${v.name}</div>
        <span class="card-badge ${cardBadgeCls}">${cardBadgeText}</span>
      </div>
      <div class="card-meta">
        <span class="card-rating">★ ${v.rating}</span>
        <span>·</span>
        <span>${catLabel(v)}</span>
        <span>·</span>
        <span style="color:var(--muted)">${v.area ?? ''}</span>
      </div>
      <div class="card-address">${v.address}</div>
      ${renderTimeline(v, dateStr, fromHour, toHour)}
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
  const toHour   = parseFloat(timeToEl.value);
  const isPoint  = Math.abs(fromHour - toHour) < 0.01;

  const searchQ    = (document.getElementById('venue-search')?.value ?? '').trim().toLowerCase();
  const filterType = document.getElementById('filter-type')?.value ?? '';
  const filterArea = document.getElementById('filter-area')?.value ?? '';
  const sortBy     = document.getElementById('sort-by')?.value ?? 'sun';
  const minRating  = parseFloat(document.getElementById('filter-rating')?.value ?? '0') || 0;

  // Dim "full slot in sun" toggle when not applicable (point/now mode)
  const fullSunBtn = document.getElementById('full-sun-btn');
  if (fullSunBtn) fullSunBtn.style.opacity = isPoint ? '0.35' : '1';

  // ── Filter + sort (runs on full VENUES, O(n)) ─────────────────────────────
  let venues = VENUES.map(v => {
    const sunInWin = venueHasSunInRange(v, dateStr, fromHour, toHour);
    const { open, close } = v.openingHours;
    const isOpen = fromHour >= open && fromHour <= close;
    return { ...v, sunInWin, isOpen };
  });

  if (searchQ) {
    venues = venues.filter(v =>
      v.name.toLowerCase().includes(searchQ) ||
      (v.area ?? '').toLowerCase().includes(searchQ) ||
      v.address.toLowerCase().includes(searchQ)
    );
  }
  if (filterType) venues = venues.filter(v => v.category === filterType);
  if (filterArea) venues = venues.filter(v => v.area === filterArea);
  if (minRating > 0) venues = venues.filter(v => v.rating >= minRating);
  if (filterFullSunActive && !isPoint) {
    venues = venues.filter(v => {
      const { windows } = computeSunWindows(v, dateStr);
      return windows.some(w => w.start <= fromHour && w.end >= toHour);
    });
  }

  if (filterMapViewActive) {
    const bounds = map.getBounds();
    venues = venues.filter(v => bounds.contains([v.lat, v.lng]));
  }

  if (sortBy === 'distance' && userLocation) {
    venues.sort((a, b) => {
      const da = Math.hypot(a.lat - userLocation.lat, a.lng - userLocation.lng);
      const db = Math.hypot(b.lat - userLocation.lat, b.lng - userLocation.lng);
      return da - db;
    });
  } else if (sortBy === 'rating') {
    venues.sort((a, b) => b.rating - a.rating);
  } else {
    venues.sort((a, b) => {
      if (a.sunInWin !== b.sunInWin) return a.sunInWin ? -1 : 1;
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      return b.rating - a.rating;
    });
  }

  if (venues.length === 0) {
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }
    list.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:30px 10px;">No venues match your filters</div>`;
    return;
  }

  // ── Render first page, observer handles the rest ──────────────────────────
  _listFiltered = venues;
  renderListPage(list, dateStr, fromHour, toHour, isPoint, true);
}
