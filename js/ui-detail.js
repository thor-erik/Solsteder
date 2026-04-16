/**
 * ui-detail.js — Detail panel: sun dial, timeline, busyness chart, and full panel HTML.
 * Depends on: computeSunWindows, formatHour, userLocation, datePicker (app.js)
 *             getWeatherAt (weather.js)
 *             getBusynessForDay, getBusynessAt, busynessLabel (busyness.js)
 *             computeVenueScore (scoring.js)
 *             catLabel (data.js)
 *             nowMode (app.js)
 *             wxColor, wxArcPaths (ui-shared.js)
 *             drawShelterDiagram (ui-shelter.js)
 */

// ── Sun dial (large clock-face style for detail panel) ────────────────────────

function renderSunDial(v, dateStr, fromHour) {
  const { windows } = computeSunWindows(v, dateStr);
  // Circle sits left; label area fills the right portion of the viewBox
  const W = 320, H = 220, CX = 70, CY = 110, R = 62, SW = 5;

  const wxNow = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const cloud = wxNow?.cloud ?? 0;
  const precip = wxNow?.precip ?? 0;
  const isRainy    = precip > 0.3;
  const isOvercast = !isRainy && cloud > 0.65;
  const dotColor   = '#FFAF85'; // Current time dot always uses sun accent color

  const hAngle = h => ((h % 12) / 12) * 2 * Math.PI - Math.PI / 2;
  const pt = h => { const a = hAngle(h); return [CX + R * Math.cos(a), CY + R * Math.sin(a)]; };
  function arcPath(h1, h2) {
    const dur = h2 - h1;
    if (dur < 0.01) return '';
    if (dur >= 12) {
      const [x1,y1]=pt(h1),[xm,ym]=pt(h1+6);
      return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 1 1 ${xm.toFixed(2)} ${ym.toFixed(2)} A ${R} ${R} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
    const [x1,y1]=pt(h1),[x2,y2]=pt(h2);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${dur>6?1:0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  // Tick marks
  let ticks = '';
  for (let h = 0; h < 12; h++) {
    const a = (h/12)*2*Math.PI - Math.PI/2, maj = h%3===0;
    const r1 = maj ? R-8 : R-5;
    ticks += `<line x1="${(CX+r1*Math.cos(a)).toFixed(1)}" y1="${(CY+r1*Math.sin(a)).toFixed(1)}"
      x2="${(CX+(R-1)*Math.cos(a)).toFixed(1)}" y2="${(CY+(R-1)*Math.sin(a)).toFixed(1)}"
      stroke="rgba(156,189,231,${maj?0.2:0.1})" stroke-width="${maj?1.2:0.7}" stroke-linecap="round"/>`;
  }

  // Hour labels (12, 3, 6, 9)
  const NR = R - 14;
  let hourNums = '';
  for (const [h, lbl] of [[0,'12'],[3,'3'],[6,'6'],[9,'9']]) {
    const a = (h/12)*2*Math.PI - Math.PI/2;
    hourNums += `<text x="${(CX+NR*Math.cos(a)).toFixed(1)}" y="${(CY+NR*Math.sin(a)).toFixed(1)}"
      text-anchor="middle" dominant-baseline="middle" font-family="Inter,sans-serif"
      font-size="8.5" font-weight="600" fill="rgba(156,189,231,0.4)">${lbl}</text>`;
  }

  // Arc segments — per-hour weather coloring
  let arcs = '';
  for (const w of windows) {
    arcs += wxArcPaths(dateStr, w.start, w.end, fromHour, arcPath, SW).join('');
  }

  const [tx, ty] = pt(fromHour);
  const callouts  = buildDialCallouts(windows, fromHour, dateStr, CX, CY, R, H);

  const svg = `<svg class="dp-dial-svg" width="100%" viewBox="0 0 ${W} ${H}" style="display:block" aria-hidden="true">
    <defs>
      <filter id="dg" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(156,189,231,0.12)" stroke-width="${SW}"/>
    ${ticks}${hourNums}${arcs}
    <circle cx="${tx.toFixed(2)}" cy="${ty.toFixed(2)}" r="5" fill="${dotColor}" filter="url(#dg)"/>
    ${callouts}
  </svg>`;

  // Status pill
  const curWin  = windows.find(w => fromHour >= w.start && fromHour < w.end);
  const nextWin = windows.find(w => w.start > fromHour);
  const wxIcon = isRainy ? '🌧' : isOvercast ? '☁' : '☀';
  let pill;
  if (curWin) {
    const lastWinDp = windows[windows.length - 1];
    // Total remaining light and gap time between now and last window end
    let remLight = 0;
    for (const w of windows) {
      if (w.end > fromHour) remLight += w.end - Math.max(w.start, fromHour);
    }
    const totalSpan = lastWinDp.end - fromHour;
    const gapTotal  = Math.max(0, totalSpan - remLight);
    const fmtHM = h => { const fh = Math.floor(h), fm = Math.round((h - fh) * 60); return (fh > 0 ? fh+'h ' : '') + (fm > 0 ? fm+'m' : (fh > 0 ? '' : '0m')); };
    const pillCls = isRainy ? 'rainy' : isOvercast ? 'overcast' : 'sunny';
    const gapPart = gapTotal > 1/12 ? ` · ${fmtHM(gapTotal)} gap` : '';
    pill = `<div class="dp-sun-pill ${pillCls}">${wxIcon} until ${formatHour(lastWinDp.end)}${gapPart} · ${fmtHM(remLight)} left</div>`;
  } else if (nextWin) {
    const wait = nextWin.start - fromHour;
    const ph = Math.floor(wait), pm = Math.round((wait - ph) * 60);
    pill = `<div class="dp-sun-pill neutral">${wxIcon} in ${(ph>0?ph+'h ':'')}${pm>0?pm+'m':''} · at ${formatHour(nextWin.start)}</div>`;
  } else {
    pill = `<div class="dp-sun-pill muted">${windows.length ? 'No more today' : 'No sun today'}</div>`;
  }

  return { svg, pill };
}

/**
 * Build SVG callout annotations for dial segments.
 *
 * Rules:
 *  - Past segments (end <= fromHour) get no callout.
 *  - Current sun window: "Sun until HH:MM" or "X min left" if < 1h; weather-aware.
 *  - Current shadow gap: "Sun/Light/Rain in X min" if < 1h, else "Xh Ym shadow left".
 *  - Future shadow gaps: always show duration ("X min shadow" / "Xh shadow").
 *  - Future sun windows: "Next sun HH:MM", "Sun HH:MM–HH:MM", "Last sun HH:MM–HH:MM"; weather-aware.
 */
function buildDialCallouts(windows, fromHour, dateStr, CX, CY, R, H) {
  if (!windows.length) return '';

  const hAngle = h => ((h % 12) / 12) * 2 * Math.PI - Math.PI / 2;
  const fh     = h => formatHour(h);
  const n      = windows.length;

  // Weather helpers
  const wxAt    = h => typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, h) : null;
  const cloudAt = h => wxAt(h)?.cloud ?? 0;
  const precipAt = h => wxAt(h)?.precip ?? 0;
  const wxterm  = h => {
    if (precipAt(h) > 0.3) return 'rain';
    const c = cloudAt(h);
    return c > 0.65 ? 'light' : c > 0.38 ? 'sun' : 'sun';
  };
  const wxtag   = h => {
    if (precipAt(h) > 0.3) return 'rainy';
    const c = cloudAt(h);
    return c > 0.65 ? 'overcast' : c > 0.38 ? 'cloudy' : '';
  };

  const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
  const segs   = [];

  // Find midpoint of the first clear run in a window starting from refH.
  // Used to anchor window callouts to the gold arc, not grey/beige sections.
  const clearAnchor = (w, refH) => {
    let clearS = null, clearE = null;
    for (let h = Math.floor(refH); h < Math.ceil(w.end); h++) {
      const rS = Math.max(refH, h), rE = Math.min(w.end, h + 1);
      if (rE <= rS + 0.001) continue;
      if (precipAt(h) <= 0.3 && cloudAt(h) <= 0.65) {
        if (clearS === null) clearS = rS;
        clearE = rE;
      } else if (clearS !== null) break; // first clear run ends
    }
    return clearS !== null ? (clearS + clearE) / 2 : (refH + w.end) / 2;
  };

  windows.forEach((w, i) => {
    // ── Sun window ──────────────────────────────────────────────────────────
    if (w.end > fromHour) {
      const isCur = curWin === w;
      const refH  = isCur ? fromHour : w.start;
      const callH = clearAnchor(w, refH);

      // Derive icon from the weather at the actual callout position — so the
      // symbol always matches the arc color the line is pointing to.
      const wxC    = wxAt(Math.round(callH));
      const cPrec  = wxC?.precip ?? 0;
      const cCloud = wxC?.cloud  ?? 0;
      const cRainy    = cPrec > 0.3;
      const cOvercast = !cRainy && cCloud > 0.65;
      const cCloudy   = !cRainy && !cOvercast && cCloud > 0.38;
      const icon     = cRainy ? '🌧' : cOvercast ? '☁' : cCloudy ? '🌤' : '☀';
      const iconType = cRainy ? 'rainy' : cOvercast ? 'overcast' : cCloudy ? 'cloudy' : 'sun';

      let label;
      if (isCur) {
        const rem = w.end - fromHour;
        if (rem < 1) {
          label = `${icon} ${Math.round(rem * 60)} min left`;
        } else {
          label = `${icon} until ${fh(w.end)}`;
        }
      } else {
        const dur = w.end - w.start;
        label = dur <= 1
          ? `${icon} ${Math.round(dur * 60)} min`
          : `${icon} ${fh(w.start)} – ${fh(w.end)}`;
      }
      segs.push({ callH, label, type: iconType });
    }

    // ── Shadow gap after this window ─────────────────────────────────────────
    if (i < n - 1) {
      const gS = w.end, gE = windows[i+1].start, gH = gE - gS;
      if (gE > fromHour) {
        const inGap = fromHour >= gS && fromHour < gE;
        const callH = inGap ? (fromHour + gE) / 2 : (gS + gE) / 2;
        let label;
        if (inGap) {
          const rem = gE - fromHour;
          const nextTerm = wxterm(gE);
          if (rem < 1) {
            label = `${nextTerm[0].toUpperCase() + nextTerm.slice(1)} in ${Math.round(rem * 60)} min`;
          } else {
            const gh = Math.floor(rem), gm = Math.round((rem - gh) * 60);
            label = gm > 0 ? `${gh}h ${gm}m shadow left` : `${gh}h shadow left`;
          }
        } else {
          label = gH <= 1
            ? `${Math.round(gH * 60)} min shadow`
            : `${fh(gS)} – ${fh(gE)} shadow`;
        }
        segs.push({ callH, label, type: 'shadow' });
      }
    }
  });

  // ── Weather-transition callouts within future sun windows ────────────────
  // For each future window, scan hourly weather and annotate overcast/rain runs.
  for (const w of windows) {
    if (w.end <= fromHour) continue;
    const scanStart = Math.max(w.start, fromHour);
    // Build weather condition runs inside the future portion of this window
    const wxRuns = [];
    for (let h = Math.floor(scanStart); h < Math.ceil(w.end); h++) {
      const rS = Math.max(scanStart, h);
      const rE = Math.min(w.end, h + 1);
      if (rE <= rS + 0.001) continue;
      const prec = precipAt(h);
      const cld  = cloudAt(h);
      const cond = prec > 0.3 ? 'rainy' : cld > 0.65 ? 'overcast' : cld > 0.38 ? 'cloudy' : 'clear';
      if (wxRuns.length && wxRuns[wxRuns.length - 1].cond === cond) {
        wxRuns[wxRuns.length - 1].end = rE;
      } else {
        wxRuns.push({ start: rS, end: rE, cond });
      }
    }
    // Annotate overcast, rainy, and partly cloudy runs — skip clear
    for (const run of wxRuns) {
      if (run.cond === 'clear') continue;
      // Skip if the whole future portion of the window is this one condition
      if (run.start <= scanStart + 0.001 && run.end >= w.end - 0.001) continue;
      const callH = (run.start + run.end) / 2;
      // Short label: emoji + time range only (fits the narrow label area)
      const label = run.cond === 'rainy'   ? `🌧 ${fh(run.start)}–${fh(run.end)}`
                  : run.cond === 'overcast' ? `☁ ${fh(run.start)}–${fh(run.end)}`
                  :                           `🌤 ${fh(run.start)}–${fh(run.end)}`;
      segs.push({ callH, label, type: run.cond });
    }
  }

  if (!segs.length) return '';

  // ── Geometry ──────────────────────────────────────────────────────────────
  const OUTSET     = 5;
  const DIAG       = 10;
  const TICK_W     = 14;
  const TICK_END_X = CX + R + OUTSET + DIAG + TICK_W;
  const LABEL_X    = TICK_END_X + 4;
  const MIN_Y = 10, MAX_Y = H - 10;
  const MIN_GAP = 19, FONT = 13;

  segs.forEach(s => {
    const a  = hAngle(s.callH);
    const ca = Math.cos(a), sa = Math.sin(a);
    s.dotX = CX + (R + OUTSET) * ca;
    s.dotY = CY + (R + OUTSET) * sa;
    s.elbX = ca >= -0.1 ? s.dotX + ca * DIAG : s.dotX + 0.82 * DIAG;
    s.elbY = ca >= -0.1 ? s.dotY + sa * DIAG : s.dotY + (sa >= 0 ? 0.57 : -0.57) * DIAG;
    s.labelY = Math.max(MIN_Y, Math.min(MAX_Y, s.elbY));
  });

  // Y-collision avoidance
  segs.sort((a, b) => a.labelY - b.labelY);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].labelY - segs[i-1].labelY < MIN_GAP) {
        const mid = (segs[i].labelY + segs[i-1].labelY) / 2;
        segs[i-1].labelY = Math.max(MIN_Y, mid - MIN_GAP / 2);
        segs[i].labelY   = Math.min(MAX_Y, mid + MIN_GAP / 2);
      }
    }
    for (let i = segs.length - 2; i >= 0; i--) {
      if (segs[i+1].labelY - segs[i].labelY < MIN_GAP) {
        const mid = (segs[i+1].labelY + segs[i].labelY) / 2;
        segs[i].labelY   = Math.max(MIN_Y, mid - MIN_GAP / 2);
        segs[i+1].labelY = Math.min(MAX_Y, mid + MIN_GAP / 2);
      }
    }
  }

  let out = '';
  for (const s of segs) {
    const sun      = s.type === 'sun';
    const rain     = s.type === 'rainy';
    const overcast = s.type === 'overcast' || s.type === 'cloudy';
    const lc = rain ? 'rgba(156,189,231,0.48)' : overcast ? 'rgba(165,170,178,0.48)' : sun ? 'rgba(255,175,133,0.48)' : 'rgba(160,170,185,0.38)';
    const tc = rain ? 'rgba(156,189,231,0.88)' : overcast ? 'rgba(165,170,178,0.88)' : sun ? 'rgba(255,175,133,0.88)' : 'rgba(160,170,185,0.78)';
    out += `<circle cx="${s.dotX.toFixed(1)}" cy="${s.dotY.toFixed(1)}" r="2.5" fill="${lc}"/>`;
    out += `<polyline points="${s.dotX.toFixed(1)},${s.dotY.toFixed(1)} ${s.elbX.toFixed(1)},${s.labelY.toFixed(1)} ${TICK_END_X},${s.labelY.toFixed(1)}"
      fill="none" stroke="${lc}" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"/>`;
    out += `<text x="${LABEL_X}" y="${s.labelY.toFixed(1)}" dominant-baseline="middle"
      font-family="Inter,sans-serif" font-size="${FONT}" font-weight="500" fill="${tc}">${s.label}</text>`;
  }
  return out;
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
  const wxTl = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const tlRainy = (wxTl?.precip ?? 0) > 0.3;
  const tlOvercast = !tlRainy && (wxTl?.cloud ?? 0) > 0.65;
  const tlTerm = tlRainy ? 'rain' : tlOvercast ? 'light' : 'sun';
  const tlIcon = tlRainy ? '🌧' : tlOvercast ? '☁' : '☀';
  const tlCls  = tlRainy ? 'neutral' : 'sunny';

  const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
  let badge = '';
  if (isPoint || nowMode) {
    if (curWin) {
      const rem = curWin.end - fromHour;
      const h = Math.floor(rem), m = Math.round((rem - h) * 60);
      badge = `<span class="tl-badge ${tlCls}">${tlIcon} ${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''} ${tlTerm} left</span>`;
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) {
        const wait = next.start - fromHour;
        const h = Math.floor(wait), m = Math.round((wait - h) * 60);
        badge = `<span class="tl-badge neutral">${tlIcon} ${tlTerm} in ${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''}</span>`;
      } else {
        badge = `<span class="tl-badge muted">${windows.length ? `${tlTerm} passed` : `No ${tlTerm}`}</span>`;
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
      badge = `<span class="tl-badge ${tlCls}">${tlIcon} ${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''} ${tlTerm}</span>`;
    } else {
      badge = `<span class="tl-badge muted">No ${tlTerm}</span>`;
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
      ? '#FFAF85'
      : val > 0
        ? `rgba(255,175,133,${(0.20 + val / 100 * 0.60).toFixed(2)})`
        : 'rgba(255,175,133,0.2)';
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

  const envSection = noiseChip ? `
    <div class="dp-divider"></div>
    <div class="dp-section-label">Environment</div>
    <div class="dp-env-row">
      ${noiseChip ? `<div class="dp-env-chip ${noiseChip.cls}">${noiseChip.icon} ${noiseChip.label}</div>` : ''}
    </div>` : '';

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
        <button id="dp-close-btn" onclick="closeDetailPanel()"><span class="dp-close-x">✕</span><span class="dp-close-back">Venues</span></button>
      </div>
      <div class="dp-meta">${catLabel(v)}${v.area ? ' · ' + v.area : ''}${distStr ? ' · ' + distStr : ''}</div>

      <div class="dp-dial-wrap">
        ${sunPill}
        ${dialSvg}
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
    </div>`;
}
