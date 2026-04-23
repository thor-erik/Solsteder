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
  const wxIcon = isRainy ? '🌧' : isOvercast ? '☁' : '☀️';
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
    const gapPart = gapTotal > 1/12 ? ` · ${fmtHM(gapTotal)} ${t('word_gap')}` : '';
    pill = `<div class="dp-sun-pill ${pillCls}">${wxIcon} ${t('word_until')} ${formatHour(lastWinDp.end)}${gapPart} · ${fmtHM(remLight)} ${t('word_left')}</div>`;
  } else if (nextWin) {
    const wait = nextWin.start - fromHour;
    const ph = Math.floor(wait), pm = Math.round((wait - ph) * 60);
    pill = `<div class="dp-sun-pill neutral">${wxIcon} ${t('word_in_time')} ${(ph>0?ph+'h ':'')}${pm>0?pm+'m':''} · ${t('word_at')} ${formatHour(nextWin.start)}</div>`;
  } else {
    pill = `<div class="dp-sun-pill muted">${windows.length ? t('no_more_today') : t('no_sun_today')}</div>`;
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
          label = `${icon} ${t('sun_min_left', { min: Math.round(rem * 60) })}`;
        } else {
          label = `${icon} ${t('sun_until_dial', { time: fh(w.end) })}`;
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
          const nextTermKey = wxterm(gE);
          if (rem < 1) {
            const termCap = t('term_' + nextTermKey);
            label = t('next_term_in', { term: termCap.charAt(0).toUpperCase() + termCap.slice(1), min: Math.round(rem * 60) });
          } else {
            const gh = Math.floor(rem), gm = Math.round((rem - gh) * 60);
            label = gm > 0 ? t('shadow_left_hm', { h: gh, m: gm }) : t('shadow_left_h', { h: gh });
          }
        } else {
          label = gH <= 1
            ? t('min_shadow', { min: Math.round(gH * 60) })
            : t('shadow_range', { start: fh(gS), end: fh(gE) });
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
        <span class="tl-closed-badge">${t('tl_closed')}</span>
      </div>
      <div class="tl-labels">
        <span>${t('opens_at', { time: formatHour(open) })}</span>
        <span>${t('closes_at', { time: formatHour(close) })}</span>
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
  const tlTermKey = tlRainy ? 'term_rain' : tlOvercast ? 'term_light' : 'term_sun';
  const tlTerm = t(tlTermKey);
  const tlIcon = tlRainy ? '🌧' : tlOvercast ? '☁' : '☀';
  const tlCls  = tlRainy ? 'neutral' : 'sunny';

  const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
  let badge = '';
  if (isPoint || nowMode) {
    if (curWin) {
      const rem = curWin.end - fromHour;
      const h = Math.floor(rem), m = Math.round((rem - h) * 60);
      const dur = `${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''}`;
      badge = `<span class="tl-badge ${tlCls}">${tlIcon} ${dur} ${t('tl_left', { term: tlTerm })}</span>`;
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) {
        const wait = next.start - fromHour;
        const h = Math.floor(wait), m = Math.round((wait - h) * 60);
        const waitStr = `${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''}`;
        badge = `<span class="tl-badge neutral">${tlIcon} ${t('tl_in', { term: tlTerm, wait: waitStr })}</span>`;
      } else {
        badge = `<span class="tl-badge muted">${windows.length ? t('tl_passed', { term: tlTerm }) : t('tl_no', { term: tlTerm })}</span>`;
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
      badge = `<span class="tl-badge muted">${t('tl_no', { term: tlTerm })}</span>`;
    }
  }

  return `
    <div class="card-timeline">
      <div class="tl-row">
        <div class="tl-track">${shadeSegs}${sunSegs}${needle}${endOfSunTick}</div>
      </div>
      <div class="tl-labels">
        <span>${t('opens_at', { time: formatHour(open) })}</span>
        <span>${t('closes_at', { time: formatHour(close) })}</span>
      </div>
    </div>`;
}

// ── Busyness bar chart ────────────────────────────────────────────────────────

function renderBusynessChart(v, dateStr, fromHour) {
  const profile = getBusynessForDay(v, dateStr);
  const { open, close } = getVenueHoursForDay(v, dateStr);
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

// ── Detail panel content (Task 5-8) ────────────────────────────────────────────

function renderDetailPanelContent(v, dateStr, fromHour) {
  const s = typeof computeVenueScore === 'function'
    ? computeVenueScore(v, dateStr, fromHour, typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null, userLocation)
    : null;

  const { windows } = computeSunWindows(v, dateStr);
  const distMeters = s?.distKm != null ? s.distKm * 1000 : null;
  const distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : null;

  // Task 5: Header + primary action row
  const walkTime = typeof calcWalkTime === 'function' ? calcWalkTime(distMeters) : null;

  const phoneIcon = typeof getMapsIcon === 'function' ? getMapsIcon('phone') : '📞';
  const globeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('globe') : '🌐';
  const shareIcon = typeof getMapsIcon === 'function' ? getMapsIcon('share') : '↗';
  const dirIcon = typeof getMapsIcon === 'function' ? getMapsIcon('directions') : '↗';

  const haPhone = v.phone ? `<a href="tel:${encodeURIComponent(v.phone)}" class="btn-icon-sec" title="Ring">${phoneIcon}</a>` : '';
  const hasWebsite = v.website ? `<a href="${v.website}" target="_blank" rel="noopener" class="btn-icon-sec" title="Nettside">${globeIcon}</a>` : '';

  // Task 6: Sun section headline based on state
  const state = typeof venueState === 'function' ? venueState(v, fromHour) :
    { state: 'sun', mainText: '—', subText: '', className: 'state-sun' };

  let sunHeadline = '';
  if (state.state === 'sun') {
    const lastWin = windows[windows.length - 1];
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    const remaining = curWin ? Math.floor(curWin.end - fromHour) : 0;
    const remH = Math.floor(remaining), remM = Math.round((remaining - remH) * 60);
    const remStr = remH > 0 ? `${remH}t ${remM}m` : `${remM} min`;
    sunHeadline = `Sol til ${formatHour(lastWin.end)} · <span class="hi">${remStr} igjen</span>`;
  } else if (state.state === 'shadow') {
    const lastWin = windows[windows.length - 1];
    const nextWin = windows.find(w => w.start > fromHour);
    const waitH = Math.floor(nextWin.start - fromHour), waitM = Math.round((nextWin.start - fromHour - waitH) * 60);
    const waitStr = waitH > 0 ? `${waitH}t ${waitM}m` : `${waitM} min`;
    sunHeadline = `Sol fra ${formatHour(nextWin.start)} · <span class="hi">om ${waitStr}</span>`;
  } else {
    const lastWin = windows[windows.length - 1];
    sunHeadline = `Sol ferdig i dag`;
  }

  // Find intra-day sun window breaks for "next pause" text
  let nextPauseText = '';
  if (windows.length > 1) {
    for (let i = 0; i < windows.length - 1; i++) {
      if (windows[i].end > fromHour) {
        nextPauseText = `Neste pause ${formatHour(windows[i].end)}`;
        break;
      }
    }
  }

  // Task 7: Sol-retning section (direction)
  const sunPos = typeof getSun === 'function' ? getSun(dateStr, fromHour) : { az: 0 };
  const azimuth = sunPos.az;
  const azbuckets = ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV'];
  const bucketIdx = Math.round((azimuth + 360) / 45) % 8;
  const bucketName = azbuckets[bucketIdx];
  const directionMap = {
    'N': { text: 'nord', seat: 'nordsiden' },
    'NØ': { text: 'nordøst', seat: 'nordøstsiden' },
    'Ø': { text: 'øst', seat: 'østsiden' },
    'SØ': { text: 'sørost', seat: 'sørostsiden' },
    'S': { text: 'sør', seat: 'sørsiden' },
    'SV': { text: 'sørvest', seat: 'sørvestsiden' },
    'V': { text: 'vest', seat: 'vestsiden' },
    'NV': { text: 'nordvest', seat: 'nordvestsiden' }
  };
  const dir = directionMap[bucketName];
  const solRetningMain = `Solen står ${dir.text}`;
  const solRetningSub = `Sett deg på ${dir.seat} av terrassen`;

  // Task 8: Info list
  const infoRows = [];

  // Busyness row
  const busynessNow = typeof getBusynessAt === 'function' ? getBusynessAt(v, dateStr, fromHour) : null;
  if (busynessNow != null) {
    const peopleIcon = typeof getMapsIcon === 'function' ? getMapsIcon('people') : '👥';
    infoRows.push(`
      <div class="info-row">
        <div class="info-icon">${peopleIcon}</div>
        <div class="info-label">
          <div class="info-label-strong">Travelt nå</div>
          <div class="info-label-sub">~${Math.round(busynessNow)}%</div>
        </div>
      </div>`);
  }

  // Noise row (from scoring.js noiseScore calculation)
  const noiseScore = s?.noise != null ? s.noise : (v.noiseScore != null ? v.noiseScore * 100 : null);
  if (noiseScore != null) {
    const noiseBucket = typeof noiseScoreToBucket === 'function' ? noiseScoreToBucket(noiseScore) : null;
    if (noiseBucket) {
      const volumeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('volume') : '🔊';
      infoRows.push(`
        <div class="info-row">
          <div class="info-icon">${volumeIcon}</div>
          <div class="info-label">
            <div class="info-label-strong">${noiseBucket.label}</div>
          </div>
        </div>`);
    }
  }

  // Beer price row
  if (v.beerPrice) {
    const beerIcon = typeof getMapsIcon === 'function' ? getMapsIcon('beer') : '🍺';
    infoRows.push(`
      <div class="info-row">
        <div class="info-icon">${beerIcon}</div>
        <div class="info-label">
          <div class="info-label-strong">${v.beerPrice} kr / 0,5 l</div>
          <div class="info-label-sub">Kilde: <a href="https://pilsguiden.no" target="_blank" rel="noopener" style="color:var(--accent)">Pilsguiden</a></div>
        </div>
      </div>`);
  }

  // Hours row
  const hours = getVenueHoursForDay(v, dateStr);
  const closingStr = hours.close != null ? formatHour(hours.close) : 'Åpent';
  let hoursSubtext = '';
  if (v.kitchenCloseHour != null) {
    hoursSubtext = `Kjøkken til ${formatHour(v.kitchenCloseHour)}`;
  }
  const clockIcon = typeof getMapsIcon === 'function' ? getMapsIcon('clock') : '🕐';
  infoRows.push(`
    <div class="info-row">
      <div class="info-icon">${clockIcon}</div>
      <div class="info-label">
        <div class="info-label-strong">Åpent til ${closingStr}</div>
        ${hoursSubtext ? `<div class="info-label-sub">${hoursSubtext}</div>` : ''}
      </div>
      <div class="info-value">Åpent</div>
    </div>`);

  const infoListHtml = infoRows.length > 0 ? `
    <div class="info-list">
      ${infoRows.join('')}
    </div>` : '';

  // Footer with edit/report
  const footerHtml = `
    <div class="secondary-row">
      <button class="secondary-link" onclick="enterEditMode(${v.id})">Rediger informasjon</button>
      <button class="secondary-link" onclick="alert('Rapportfunksjon kommer snart')">Rapporter feil</button>
    </div>`;

  const photosHtml = v.photoUrls?.length
    ? `<div class="detail-new-photos">${
        v.photoUrls.map(url => `<img src="${url}" loading="lazy" alt="">`).join('')
      }</div>`
    : '<div class="detail-new-photos">[Bilde]</div>';

  return `
    <div id="dp-scroll">
      ${photosHtml}

      <div class="detail-new-header">
        <div>
          <div class="detail-new-title">${v.name}</div>
          <div class="detail-new-sub">${catLabel(v)}${v.beerPrice ? ' · ' + v.beerPrice + ' kr/0,5 l' : ''}${v.area ? ' · ' + v.area : ''}${distStr ? ' · ' + distStr : ''}</div>
        </div>
        <button class="detail-new-back" onclick="closeDetailPanel()">‹ Steder</button>
      </div>

      <div class="primary-action">
        <button class="btn-primary">${dirIcon} Veibeskrivelse · ${walkTime || '—'}</button>
        ${haPhone}
        ${hasWebsite}
        <button class="btn-icon-sec" title="Del" onclick="shareVenue(${v.id})">${shareIcon}</button>
      </div>

      <div class="sun-section">
        <div class="sun-section-header">
          <div class="sun-section-main">${sunHeadline}</div>
          ${nextPauseText ? `<div class="sun-section-sub">${nextPauseText}</div>` : ''}
        </div>
        <div class="big-timeline">
          <div class="big-timeline-track">
            ${renderSunTimelineSegments(windows, fromHour)}
            <div class="big-timeline-now" style="left:${((fromHour - 6) / 16) * 100}%"></div>
          </div>
        </div>
        <div class="big-timeline-scale">
          <span>6</span><span>9</span><span>12</span><span>15</span><span>18</span><span>21</span>
        </div>
      </div>

      <div class="spatial-section">
        <div class="spatial-label">Sol-retning akkurat nå</div>
        <div class="spatial-body">
          <canvas id="detail-compass" class="detail-compass-canvas" width="80" height="80" style="flex-shrink:0"></canvas>
          <div class="spatial-text">
            <span class="strong">${solRetningMain}</span>
            <span class="muted">${solRetningSub}</span>
          </div>
        </div>
      </div>

      ${infoListHtml}

      ${footerHtml}
    </div>`;
}

/** Helper: render sun/cloud timeline segments for detail panel (10px track). */
function renderSunTimelineSegments(windows, fromHour) {
  const START_H = 6, END_H = 22, RANGE = END_H - START_H;
  let segments = '';

  for (const w of windows) {
    const sPos = Math.max(0, Math.min(100, ((Math.max(w.start, START_H) - START_H) / RANGE) * 100));
    const ePos = Math.max(0, Math.min(100, ((Math.min(w.end, END_H) - START_H) / RANGE) * 100));
    if (ePos > sPos) {
      segments += `<div class="big-timeline-sun" style="left:${sPos}%;width:${ePos-sPos}%"></div>`;
    }
  }

  return segments;
}

/** Draw compass arc for detail panel sol-retning section. */
function drawDetailCompass(dateStr, fromHour) {
  const canvas = document.getElementById('detail-compass');
  if (!canvas) return;

  const c = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2;
  const outerR = Math.min(w, h) / 2 - 2;

  // Clear and draw circle
  c.clearRect(0, 0, w, h);
  c.beginPath();
  c.arc(cx, cy, outerR, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.04)';
  c.fill();
  c.strokeStyle = 'rgba(156,189,231,0.18)';
  c.lineWidth = 1;
  c.stroke();

  // Draw cardinal ticks (N, S only)
  c.strokeStyle = 'rgba(156,189,231,0.3)';
  c.lineWidth = 1;
  // N
  c.beginPath();
  c.moveTo(cx, cy - outerR + 2);
  c.lineTo(cx, cy - outerR + 6);
  c.stroke();
  // S
  c.beginPath();
  c.moveTo(cx, cy + outerR - 2);
  c.lineTo(cx, cy + outerR - 6);
  c.stroke();

  // Draw N label
  c.font = '9px "Inter", sans-serif';
  c.fillStyle = 'rgba(156,189,231,0.6)';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('N', cx, cy - outerR + 10);

  // Get sun position and draw arc/dot
  const sunPos = typeof getSun === 'function' ? getSun(dateStr, fromHour) : { az: 0, alt: -10 };
  const RAD = Math.PI / 180;

  if (sunPos.alt > 0) {
    const sunAngle = (sunPos.az - 90) * RAD;
    const sr = outerR - 4;
    const sx = cx + sr * Math.cos(sunAngle);
    const sy = cy + sr * Math.sin(sunAngle);

    // Draw arc from center to sun position
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(sx, sy);
    c.strokeStyle = 'rgba(255,175,133,0.35)';
    c.lineWidth = 1.5;
    c.stroke();

    // Draw sun dot with glow
    const glow = c.createRadialGradient(sx, sy, 0, sx, sy, 7);
    glow.addColorStop(0, 'rgba(255,175,133,0.5)');
    glow.addColorStop(1, 'rgba(255,175,133,0)');
    c.beginPath();
    c.arc(sx, sy, 7, 0, Math.PI * 2);
    c.fillStyle = glow;
    c.fill();

    c.beginPath();
    c.arc(sx, sy, 2.5, 0, Math.PI * 2);
    c.fillStyle = '#FFAF85';
    c.fill();
  }
}
