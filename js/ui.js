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

// ── Sun dial (large clock-face style for detail panel) ────────────────────────

// Hover helpers — called by SVG arc onmouseenter/onmouseleave
let _dialHoverTimer = null;
let _dialLocked = false;

function _dialSetText(t1, t2) {
  const e1 = document.getElementById('dp-dt1'), e2 = document.getElementById('dp-dt2');
  if (!e1 || !e2) return;
  clearTimeout(_dialHoverTimer);
  e1.style.opacity = '0'; e2.style.opacity = '0';
  _dialHoverTimer = setTimeout(() => {
    e1.textContent = t1;
    e2.textContent = t2;
    e1.style.opacity = ''; e2.style.opacity = '';
  }, 100);
}

function _dialArcHover(t1, t2) {
  if (_dialLocked) return;
  _dialSetText(t1, 'UNTIL ' + t2);
}
function _dialArcOut() {
  if (_dialLocked) return;
  const e1 = document.getElementById('dp-dt1'), e2 = document.getElementById('dp-dt2');
  if (e1 && e2) _dialSetText(e1.dataset.d, e2.dataset.d);
}
function _dialToggleLock(t1, t2) {
  _dialLocked = !_dialLocked;
  const svg = document.querySelector('.dp-dial-svg');
  if (svg) svg.classList.toggle('dp-dial-locked', _dialLocked);
  if (_dialLocked) {
    _dialSetText(t1, 'UNTIL ' + t2);
  } else {
    const e1 = document.getElementById('dp-dt1'), e2 = document.getElementById('dp-dt2');
    if (e1 && e2) _dialSetText(e1.dataset.d, e2.dataset.d);
  }
}

function renderSunDial(v, dateStr, fromHour) {
  const { windows } = computeSunWindows(v, dateStr);
  const W = 220, H = 220, CX = 110, CY = 110, R = 88, SW = 7;

  // Cloud-aware arc colors
  const wxNow    = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const cloud    = wxNow?.cloud ?? 0;
  const isOvercast    = cloud > 0.65;
  const isPartlyCloudy = cloud > 0.38 && !isOvercast;
  const arcBright = isOvercast ? 'rgba(120,158,210,0.75)' : isPartlyCloudy ? 'rgba(210,185,110,0.75)' : 'rgba(255,184,0,0.78)';
  const arcDim    = isOvercast ? 'rgba(120,158,210,0.20)' : isPartlyCloudy ? 'rgba(210,185,110,0.20)' : 'rgba(255,184,0,0.18)';
  const dotColor  = isOvercast ? '#78A0D8' : '#FFB800';

  function hAngle(h) { return ((h % 12) / 12) * 2 * Math.PI - Math.PI / 2; }
  function pt(h) { const a = hAngle(h); return [CX + R * Math.cos(a), CY + R * Math.sin(a)]; }
  function arcPath(h1, h2) {
    const dur = h2 - h1;
    if (dur < 0.01) return '';
    if (dur >= 12) {
      // Full circle — split into two half-arcs (SVG can't arc from a point to itself)
      const [x1, y1] = pt(h1), [xm, ym] = pt(h1 + 6);
      return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 1 1 ${xm.toFixed(2)} ${ym.toFixed(2)} A ${R} ${R} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
    const [x1, y1] = pt(h1), [x2, y2] = pt(h2);
    const large = dur > 6 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  // Hour tick marks — 12 positions, major at 12/3/6/9
  let ticks = '';
  for (let h = 0; h < 12; h++) {
    const angle  = (h / 12) * 2 * Math.PI - Math.PI / 2;
    const isMaj  = h % 3 === 0;
    const r1     = isMaj ? R - 10 : R - 6;
    const x1t    = (CX + r1       * Math.cos(angle)).toFixed(1);
    const y1t    = (CY + r1       * Math.sin(angle)).toFixed(1);
    const x2t    = (CX + (R - 1)  * Math.cos(angle)).toFixed(1);
    const y2t    = (CY + (R - 1)  * Math.sin(angle)).toFixed(1);
    ticks += `<line x1="${x1t}" y1="${y1t}" x2="${x2t}" y2="${y2t}"
      stroke="rgba(213,196,171,${isMaj ? 0.22 : 0.11})" stroke-width="${isMaj ? 1.4 : 0.8}" stroke-linecap="round"/>`;
  }

  // Hour numbers at 12, 3, 6, 9
  const NR = R - 20;
  let hourNums = '';
  for (const [h, lbl] of [[0,'12'],[3,'3'],[6,'6'],[9,'9']]) {
    const angle = (h / 12) * 2 * Math.PI - Math.PI / 2;
    const nx = (CX + NR * Math.cos(angle)).toFixed(1);
    const ny = (CY + NR * Math.sin(angle)).toFixed(1);
    hourNums += `<text x="${nx}" y="${ny}" text-anchor="middle" dominant-baseline="middle"
      font-family="Inter,sans-serif" font-size="7" font-weight="500"
      fill="rgba(213,196,171,0.2)" letter-spacing="0">${lbl}</text>`;
  }

  // Draw arcs — each window segment gets hover handlers showing its from/to
  // Hit paths are wide+transparent; visual paths have pointer-events:none
  let arcs = '';
  function arcSegment(d, color) {
    if (!d) return '';
    return `<path d="${d}" fill="none" stroke="transparent" stroke-width="22" stroke-linecap="round" style="cursor:pointer" pointer-events="stroke"/>`
         + `<path d="${d}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="round" pointer-events="none"/>`;
  }
  for (const w of windows) {
    const hoverArgs = `'${formatHour(w.start)}','${formatHour(w.end)}'`;
    const hoverAttrs = `onmouseenter="_dialArcHover(${hoverArgs})" onmouseleave="_dialArcOut()" onclick="_dialToggleLock(${hoverArgs})" style="cursor:pointer"`;
    // Wrap each window's paths in a group so hover fires for the whole window
    arcs += `<g ${hoverAttrs}>`;
    if (w.end <= fromHour) {
      arcs += arcSegment(arcPath(w.start, w.end), arcDim);
    } else if (w.start >= fromHour) {
      arcs += arcSegment(arcPath(w.start, w.end), arcBright);
    } else {
      arcs += arcSegment(arcPath(w.start, fromHour), arcDim);
      arcs += arcSegment(arcPath(fromHour, w.end), arcBright);
    }
    arcs += '</g>';
  }

  // Current time dot
  const [tx, ty] = pt(fromHour);

  // Smart center: "last sun" time is the most important info
  const lastWin = windows.length ? windows[windows.length - 1] : null;
  const curWin  = windows.find(w => fromHour >= w.start && fromHour < w.end);
  const nextWin = windows.find(w => w.start > fromHour);

  let centerTime, centerLabel;
  const cloudyTag = isOvercast ? 'CLOUDY · ' : '';
  if (!lastWin) {
    centerTime  = '—';
    centerLabel = isOvercast ? 'OVERCAST TODAY' : 'NO SUN TODAY';
  } else if (lastWin.end <= fromHour) {
    centerTime  = formatHour(lastWin.end);
    centerLabel = 'SUN ENDED AT';
  } else if (curWin) {
    const hasBreak = nextWin && nextWin !== curWin;
    centerTime  = formatHour(curWin.end);
    centerLabel = cloudyTag + (hasBreak ? 'BREAK AT' : 'SUN UNTIL');
  } else if (nextWin) {
    centerTime  = formatHour(nextWin.start);
    centerLabel = cloudyTag + 'SUN FROM';
  } else {
    centerTime  = formatHour(lastWin.end);
    centerLabel = 'SUN ENDED AT';
  }

  const svg = `<svg class="dp-dial-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <defs>
      <filter id="dg" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="${SW}"/>
    ${ticks}
    ${hourNums}
    ${arcs}
    <circle cx="${tx.toFixed(2)}" cy="${ty.toFixed(2)}" r="5.5" fill="${dotColor}" filter="url(#dg)"/>
    <text id="dp-dt1" data-d="${centerTime}" x="${CX}" y="${CY - 10}" text-anchor="middle" dominant-baseline="middle"
      font-family="Newsreader,serif" font-style="italic" font-size="46" font-weight="600"
      fill="rgba(255,255,255,0.95)" style="transition:opacity 0.1s">${centerTime}</text>
    <text id="dp-dt2" data-d="${centerLabel}" x="${CX}" y="${CY + 18}" text-anchor="middle" dominant-baseline="middle"
      font-family="Inter,sans-serif" font-size="9" font-weight="700"
      fill="rgba(213,196,171,0.62)" letter-spacing="2" style="transition:opacity 0.1s">${centerLabel}</text>
  </svg>`;

  // Status pill
  let pill;
  if (curWin) {
    const rem = curWin.end - fromHour;
    const ph = Math.floor(rem), pm = Math.round((rem - ph) * 60);
    const dur = (ph > 0 ? ph + 'h ' : '') + (pm > 0 ? pm + 'm' : '');
    pill = `<div class="dp-sun-pill sunny">☀ IN SUN · ${dur.trim().toUpperCase()} LEFT</div>`;
  } else if (nextWin) {
    const wait = nextWin.start - fromHour;
    const ph = Math.floor(wait), pm = Math.round((wait - ph) * 60);
    const dur = (ph > 0 ? ph + 'h ' : '') + (pm > 0 ? pm + 'm' : '');
    pill = `<div class="dp-sun-pill neutral">☀ SUN IN ${dur.trim().toUpperCase()}</div>`;
  } else {
    pill = `<div class="dp-sun-pill muted">${windows.length ? 'SUN PASSED' : 'NO SUN TODAY'}</div>`;
  }

  return { svg, pill };
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

/** Small 56×56 clock-face dial for venue cards — no text, just arc + dot. */
function buildCardDial(v, dateStr, fromHour) {
  const { windows } = computeSunWindows(v, dateStr);
  const W = 56, H = 56, CX = 28, CY = 28, R = 21, SW = 3.5;

  const wxNow = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const cloud = wxNow?.cloud ?? 0;
  const isOvercast = cloud > 0.65, isPartly = cloud > 0.38 && !isOvercast;
  const arcBright = isOvercast ? 'rgba(120,158,210,0.78)' : isPartly ? 'rgba(210,185,110,0.78)' : 'rgba(255,184,0,0.82)';
  const arcDim    = isOvercast ? 'rgba(120,158,210,0.18)' : isPartly ? 'rgba(210,185,110,0.18)' : 'rgba(255,184,0,0.18)';
  const dotColor  = isOvercast ? '#78A0D8' : '#FFB800';

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

  let arcs = '';
  for (const w of windows) {
    if (w.start < fromHour && w.end > fromHour) {
      const dp = arcPath(w.start, fromHour), df = arcPath(fromHour, w.end);
      if (dp) arcs += `<path d="${dp}" fill="none" stroke="${arcDim}" stroke-width="${SW}" stroke-linecap="round"/>`;
      if (df) arcs += `<path d="${df}" fill="none" stroke="${arcBright}" stroke-width="${SW}" stroke-linecap="round"/>`;
    } else {
      const d = arcPath(w.start, w.end);
      if (d) arcs += `<path d="${d}" fill="none" stroke="${w.end<=fromHour?arcDim:arcBright}" stroke-width="${SW}" stroke-linecap="round"/>`;
    }
  }
  const [tx,ty] = pt(fromHour);
  return `<svg class="card-dial" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="${SW}"/>
    ${arcs}
    <circle cx="${tx.toFixed(2)}" cy="${ty.toFixed(2)}" r="3.5" fill="${dotColor}"/>
  </svg>`;
}

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

  // Sun status line text (uppercase, matches screenshot style)
  let sunLineText, sunLineCls;
  if (isPoint || nowMode) {
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    if (curWin) {
      const rem = curWin.end - fromHour;
      const bh = Math.floor(rem), bm = Math.round((rem - bh) * 60);
      const dur = (bh > 0 ? bh + 'H ' : '') + (bm > 0 ? bm + 'M' : '');
      sunLineText = `UNTIL ${formatHour(curWin.end)} · ${dur.trim()}`;
      sunLineCls = 'sunny';
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) { sunLineText = `SUN AT ${formatHour(next.start)}`; sunLineCls = 'neutral'; }
      else { sunLineText = windows.length ? 'SUN PASSED' : 'NO SUN'; sunLineCls = 'muted'; }
    }
  } else {
    let totalSun = 0;
    for (const w of windows) { const ov = Math.min(w.end, toHour) - Math.max(w.start, fromHour); if (ov > 0) totalSun += ov; }
    if (totalSun > 0) {
      const bh = Math.floor(totalSun), bm = Math.round((totalSun - bh) * 60);
      sunLineText = `${bh > 0 ? bh+'H ' : ''}${bm > 0 ? bm+'M' : ''} SUN`.trim();
      sunLineCls = 'sunny';
    } else { sunLineText = 'NO SUN'; sunLineCls = 'muted'; }
  }
  if (v.isOpeningSoon) {
    sunLineText = `OPENS IN ${Math.round((v.openingHours.open - fromHour) * 60)}M`;
    sunLineCls = 'opening-soon';
  } else if (v.isClosingSoon) {
    sunLineText = `CLOSES ${formatHour(v.openingHours.close)}`;
    sunLineCls = 'closing-soon';
  }

  const scoreStr = s ? `${s.total} Score` : null;
  const meta = [v.area, catLabel(v), distStr, scoreStr].filter(Boolean).join(' · ');

  // Sun info for right side of card sun row
  let sunLabel, sunTime = '', sunDurH = '', sunDurM = '';
  if (isPoint || nowMode) {
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    if (curWin) {
      const rem = curWin.end - fromHour;
      const bh = Math.floor(rem), bm = Math.round((rem - bh) * 60);
      sunLabel = 'SUN UNTIL'; sunTime = formatHour(curWin.end);
      sunDurH = bh > 0 ? `${bh}H` : ''; sunDurM = bm > 0 ? `${bm}M` : '';
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) { sunLabel = 'SUN AT'; sunTime = formatHour(next.start); }
      else { sunLabel = windows.length ? 'SUN PASSED' : 'NO SUN'; }
    }
  } else {
    let totalSun = 0;
    for (const w of windows) { const ov = Math.min(w.end, toHour) - Math.max(w.start, fromHour); if (ov > 0) totalSun += ov; }
    if (totalSun > 0) {
      const bh = Math.floor(totalSun), bm = Math.round((totalSun - bh) * 60);
      sunLabel = 'SUN TODAY'; sunTime = bh > 0 ? `${bh}H` : '';
      sunDurM = bm > 0 ? `${bm}M` : '';
      if (!sunTime) { sunTime = sunDurM; sunDurM = ''; }
    } else { sunLabel = 'NO SUN'; }
  }
  if (v.isOpeningSoon) { sunLabel = `OPENS IN ${Math.round((v.openingHours.open - fromHour) * 60)}M`; sunTime = ''; }
  else if (v.isClosingSoon) { sunLabel = `CLOSES ${formatHour(v.openingHours.close)}`; }

  const durHtml = (sunDurH || sunDurM)
    ? `<span class="card-sun-dur">${[sunDurH, sunDurM].filter(Boolean).join('<br>')}</span>`
    : '';

  const dialSvg = buildCardDial(v, dateStr, fromHour);

  return `
    <div class="venue-card ${v.sunInWin ? 'sunny' : ''} ${v.id === selectedId ? 'selected' : ''} ${dimmedCls}"
         data-vid="${v.id}" onclick="selectVenue(${v.id}, true)"
         onmouseenter="setHoveredVenue(${v.id})" onmouseleave="setHoveredVenue(null)">
      ${s ? `<div class="card-bloom ${tier}"></div>` : ''}
      <div class="card-name">${v.name}</div>
      <div class="card-meta">${meta}</div>
      <div class="card-sun-row">
        ${dialSvg}
        <div class="card-sun-info ${sunLineCls}">
          <div class="card-sun-label">${sunLabel}</div>
          ${sunTime ? `<div class="card-sun-bottom">
            <span class="card-sun-time">${sunTime}</span>${durHtml}
          </div>` : ''}
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

  // Rotate so v.facing → bearing 0° (N = local y-axis = left face in iso), terrace wall diagonal
  const θ    = v.facing * Math.PI / 180;
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ);

  function toLocal(lat, lng) {
    const ex = (lng - v.lng) * cosLat * 111320;
    const ny = (lat - v.lat) * 111320;
    return { x: ex * cosθ - ny * sinθ, y: ex * sinθ + ny * cosθ };
  }

  let ISO_SCALE = 4;
  let CY = H * 0.52;
  const CX = W * 0.56; // shifted right: terrace extends left (local +y = iso left)

  function toIso(x, y, z) {
    return { sx: CX + (x - y) * ISO_SCALE, sy: CY + (x + y) * ISO_SCALE * 0.5 - z * ISO_SCALE };
  }

  // ── Collect geometry ────────────────────────────────────────────────────────
  const VENUE_H   = 22;   // exaggerated for visible 3D effect, helps shallow buildings
  const terrDepth = v.autoTerraceDepth ?? 6;

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

  // ── Auto-scale: derived from venue building only ────────────────────────────
  // Nearby buildings use the same scale but never shrink it — they may
  // overflow the canvas edges, which looks fine and keeps the main building legible.
  const allNodes   = [...venueNodes, ...nearbyBlds.flatMap(b => b.nodes)];
  const venueHoriz = Math.max(1, ...venueNodes.map(n => Math.abs(n.x - n.y)));
  const venueGndY  = Math.max(1, ...venueNodes.map(n => n.x + n.y));
  // vertSpan = ground depth + building height + terrace (extends in +y → 0.5 factor in iso)
  const vertSpan   = Math.max(venueGndY + terrDepth, 1) * 0.5 + VENUE_H;

  ISO_SCALE = Math.min(
    (W * 0.42) / venueHoriz,
    (H * 0.60) / vertSpan,
    6.0
  );
  ISO_SCALE = Math.max(ISO_SCALE, 1.5);

  // CY: place so the roof sits ~18px from the top with room for the terrace below
  CY = Math.min(VENUE_H * ISO_SCALE + 18, H * 0.56);

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
  const shelter     = wx ? venueWindShelter(v.facing, wx.wdir) : null;
  const rotWindDir  = (wx?.wdir != null)
    ? ((wx.wdir - v.facing) + 360) % 360
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

  // Warm ground glow under venue building
  if (venueNodes.length >= 3) {
    ctx.save();
    ctx.beginPath();
    const sn = venueNodes.slice(0, -1);
    const s0 = toIso(sn[0].x, sn[0].y, 0);
    ctx.moveTo(s0.sx, s0.sy);
    for (let i = 1; i < sn.length; i++) { const p = toIso(sn[i].x, sn[i].y, 0); ctx.lineTo(p.sx, p.sy); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,184,0,0.07)';
    ctx.fill();
    ctx.restore();
  }

  for (const bld of allBlds) {
    drawIsoBlock(bld.nodes, bld.height, bld.isVenue ? {
      wallBack:  'rgba(30,45,95,0.97)',    // deep blue shadow side
      wallFront: 'rgba(68,88,165,0.97)',   // brighter lit side
      roof:      'rgba(78,100,180,0.97)',  // brightest = roof
      edge:      'rgba(255,184,0,0.55)',   // strong amber outline
    } : {
      wallBack:  'rgba(20,28,52,0.92)',
      wallFront: 'rgba(32,42,72,0.92)',
      roof:      'rgba(38,50,82,0.92)',
      edge:      'rgba(81,69,50,0.25)',
    });
  }

  // ── Terrace zone ────────────────────────────────────────────────────────────
  // Facing direction → NE (0.707, 0.707) in local frame; terrace extends toward viewer
  if (v.wallSegment) {
    const ws = v.wallSegment;
    const a  = toLocal(ws.aLat, ws.aLng);
    const b  = toLocal(ws.bLat, ws.bLng);
    const pA0 = toIso(a.x, a.y,              0.1);
    const pB0 = toIso(b.x, b.y,              0.1);
    const pB1 = toIso(b.x, b.y + terrDepth, 0.1);
    const pA1 = toIso(a.x, a.y + terrDepth, 0.1);

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
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + terrDepth * 0.5;
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
    const northBearing = (360 - v.facing) % 360;
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
      <svg width="100%" height="${H}" viewBox="0 0 ${totalW} ${H}" preserveAspectRatio="none" style="display:block">
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

  const shelterPct = s?.shelter != null ? Math.round(s.shelter * 100) : null;
  const sunScoreSection = s ? `
    <div class="dp-divider"></div>
    <div class="dp-section-label">Sun Score</div>
    <div class="dp-exp-row"><span><span class="dp-exp-label">Sun Exposure</span><div class="dp-exp-hint">Hours of direct sun vs. opening hours</div></span><span class="dp-exp-val">${s.sun}%</span></div>
    <div class="dp-exp-bar-wrap"><div class="dp-exp-bar-fill" style="width:${s.sun}%"></div></div>
    <div class="dp-exp-row"><span><span class="dp-exp-label">Comfort Level</span><div class="dp-exp-hint">Feels-like temperature &amp; wind speed</div></span><span class="dp-exp-val">${s.comfort}%</span></div>
    <div class="dp-exp-bar-wrap"><div class="dp-exp-bar-fill" style="width:${s.comfort}%"></div></div>
    ${s.noise != null ? `
    <div class="dp-exp-row"><span><span class="dp-exp-label">Noise</span><div class="dp-exp-hint">Estimated traffic noise at this location</div></span><span class="dp-exp-val">${s.noise}%</span></div>
    <div class="dp-exp-bar-wrap"><div class="dp-exp-bar-fill" style="width:${s.noise}%"></div></div>` : ''}
    ${shelterPct != null ? `
    <div class="dp-exp-row"><span><span class="dp-exp-label">Wind Shelter</span><div class="dp-exp-hint">How sheltered the terrace is from wind</div></span><span class="dp-exp-val">${shelterPct}%</span></div>
    <div class="dp-exp-bar-wrap"><div class="dp-exp-bar-fill" style="width:${shelterPct}%"></div></div>` : ''}
    ${distStr ? `<div class="dp-exp-row" style="margin-top:8px"><span class="dp-exp-label">Proximity</span><span class="dp-exp-val" style="font-style:normal;font-size:13px">${distStr}</span></div>` : ''}
  ` : '';

  const { svg: dialSvg, pill: sunPill } = renderSunDial(v, dateStr, fromHour);

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
      <div class="dp-meta">${catLabel(v)}${v.area ? ' · ' + v.area : ''}${distStr ? ' · ' + distStr : ''}</div>

      <div class="dp-dial-wrap">
        ${dialSvg}
        ${sunPill}
      </div>

      <div class="dp-gm-actions">
        <a class="dp-gm-chip" href="${directionsUrl}" target="_blank" rel="noopener">${ICON_DIR}<span>Directions</span></a>
        <a class="dp-gm-chip" href="${websiteUrl}" target="_blank" rel="noopener">${ICON_WEB}<span>Website</span></a>
        <button class="dp-gm-chip" onclick="shareVenue(${v.id})">${ICON_SHARE}<span>Share</span></button>
        <button class="dp-gm-chip" onclick="enterEditMode(${v.id})">${ICON_EDIT}<span>Edit</span></button>
      </div>

      ${sunScoreSection}
      <div class="dp-divider"></div>
      <div class="dp-section-label">Busyness</div>
      ${renderBusynessChart(v, dateStr, fromHour)}
      <div class="dp-divider"></div>
      <div class="dp-section-label">Wind shelter</div>
      <canvas id="dp-shelter-canvas" width="268" height="180" style="display:block;width:100%;border-radius:10px;border:1px solid rgba(81,69,50,0.18);"></canvas>
    </div>`;
}
