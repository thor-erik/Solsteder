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

// ── Detail panel content ──────────────────────────────────────────────────────

function renderDetailPanelContent(v, dateStr, fromHour) {
  const s = typeof computeVenueScore === 'function'
    ? computeVenueScore(v, dateStr, fromHour, typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null, userLocation)
    : null;

  const { windows } = computeSunWindows(v, dateStr);
  const distMeters = s?.distKm != null ? s.distKm * 1000 : null;
  const distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : null;

  const walkTime = typeof calcWalkTime === 'function' ? calcWalkTime(distMeters) : null;

  const phoneIcon = typeof getMapsIcon === 'function' ? getMapsIcon('phone') : '📞';
  const globeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('globe') : '🌐';
  const shareIcon = typeof getMapsIcon === 'function' ? getMapsIcon('share') : '↗';
  const dirIcon = typeof getMapsIcon === 'function' ? getMapsIcon('directions') : '↗';

  // Sun section headline
  const state = typeof venueState === 'function' ? venueState(v, fromHour) :
    { state: 'sun', mainText: '—', subText: '', className: 'state-sun' };

  let sunHeadline = '';
  if (state.state === 'sun') {
    const lastWin = windows[windows.length - 1];
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    const remaining = curWin ? curWin.end - fromHour : 0;
    const remH = Math.floor(remaining), remM = Math.round((remaining - remH) * 60);
    const remStr = remH > 0 ? `${remH}t ${remM}m` : `${remM} min`;
    sunHeadline = `Sol til ${formatHour(lastWin.end)} · <span class="hi">${remStr} igjen</span>`;
  } else if (state.state === 'shadow') {
    const nextWin = windows.find(w => w.start > fromHour);
    const wait = nextWin.start - fromHour;
    const waitH = Math.floor(wait), waitM = Math.round((wait - waitH) * 60);
    const waitStr = waitH > 0 ? `${waitH}t ${waitM}m` : `${waitM} min`;
    sunHeadline = `Sol fra ${formatHour(nextWin.start)} · <span class="hi">om ${waitStr}</span>`;
  } else {
    sunHeadline = `Sol ferdig i dag`;
  }

  // Info list
  const infoRows = [];

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

  const footerHtml = `
    <div class="secondary-row">
      <button class="secondary-link" onclick="enterEditMode(${v.id})">Rediger informasjon</button>
      <button class="secondary-link" onclick="alert('Rapportfunksjon kommer snart')">Rapporter feil</button>
    </div>`;

  const photosHtml = v.photoUrls?.length
    ? `<div class="detail-new-photos">${
        v.photoUrls.map(url => `<img src="${url}" loading="lazy" alt="" onerror="this.remove()">`).join('')
      }</div>`
    : '<div class="detail-new-photos">[Bilde]</div>';

  // Heart + bell icon SVGs
  const _favActive = typeof isFavorite === 'function' && isFavorite(v.id);
  const _alertActive = typeof hasSunAlert === 'function' && hasSunAlert(v.id);
  const heartBtn = `<button class="dp-header-icon${_favActive ? ' active' : ''}" onclick="toggleFavorite(${v.id}, event)" title="${typeof t === 'function' ? t('favorites') : 'Favoritt'}">
    ${_favActive
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>`}
  </button>`;
  const bellBtn = `<button class="dp-header-icon${_alertActive ? ' active' : ''}" onclick="toggleSunAlert(${v.id}, event)" title="${typeof t === 'function' ? t('sun_alert_label') : 'Sol-varsel'}">
    ${_alertActive
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`}
  </button>`;

  // Directions CTA label
  const dirLabel = walkTime ? `${dirIcon} ${walkTime}` : `${dirIcon}`;

  // Build timeline using same style as venue cards
  const { open, close } = hours;
  const tlSpan = close - open;
  const tlPct = h => ((Math.max(open, Math.min(close, h)) - open) / tlSpan * 100).toFixed(2);
  let tlSegs = '';
  if (tlSpan > 0) {
    for (const w of windows) {
      const l = tlPct(w.start), r = tlPct(w.end);
      tlSegs += `<div class="tl-sun-seg" style="left:${l}%;width:${(parseFloat(r)-parseFloat(l)).toFixed(2)}%"></div>`;
    }
  }
  const tlNeedle = (fromHour >= open && fromHour <= close)
    ? `<div class="tl-needle" style="left:${tlPct(fromHour)}%"></div>` : '';

  return `
    <div id="dp-scroll">
      ${photosHtml}

      <div class="detail-header-row">
        <button class="detail-new-back" onclick="closeDetailPanel()">‹</button>
        <div class="detail-header-info">
          <div class="detail-new-title">${v.name}</div>
          <div class="detail-new-sub">${catLabel(v)}${v.area ? ' · ' + v.area : ''}${distStr ? ' · ' + distStr : ''}</div>
        </div>
        <div class="detail-header-actions">
          ${heartBtn}
          ${bellBtn}
        </div>
      </div>

      <div class="sun-section">
        <div class="sun-section-main">${sunHeadline}</div>
        <div class="dp-timeline">
          <div class="tl-track">${tlSegs}${tlNeedle}</div>
        </div>
        <div class="dp-timeline-labels">
          <span>${formatHour(open)}</span>
          <span>${formatHour(close)}</span>
        </div>
      </div>

      ${_renderSocialSection(v)}

      <div class="dp-action-row">
        <a class="dp-action-cta" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.lat + ',' + v.lng)}&travelmode=walking" target="_blank" rel="noopener">${dirLabel}</a>
        ${v.phone ? `<a href="tel:${encodeURIComponent(v.phone)}" class="dp-action-icon" title="Ring">${phoneIcon}</a>` : ''}
        ${v.website ? `<a href="${v.website}" target="_blank" rel="noopener" class="dp-action-icon" title="Nettside">${globeIcon}</a>` : ''}
        <button class="dp-action-icon" title="Del" onclick="shareVenue(${v.id})">${shareIcon}</button>
      </div>

      ${infoListHtml}

      ${footerHtml}
    </div>`;
}

/** Render the social section: "Jeg drar hit", "Jeg er her", friends, plans. */
function _renderSocialSection(v) {
  const myCheckin = typeof getMyCheckin === 'function' ? getMyCheckin() : null;
  const isCheckedInHere = myCheckin && String(myCheckin.venue_id) === String(v.id);
  const friendCheckins = typeof getFriendCheckinsForVenue === 'function' ? getFriendCheckinsForVenue(v.id) : [];
  const plans = typeof getPlansForVenue === 'function' ? getPlansForVenue(v.id) : [];

  // Friends checked in
  let friendsHtml = '';
  if (friendCheckins.length) {
    const dots = friendCheckins.map(c => {
      const u = c.user;
      const until = new Date(c.checkin.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return u.avatar_url
        ? `<img class="social-avatar" src="${u.avatar_url}" alt="${u.name || u.email}" title="${u.name || u.email} — ${t('checked_in_until', { time: until })}">`
        : `<div class="social-avatar social-avatar-init" title="${u.name || u.email} — ${t('checked_in_until', { time: until })}">${(u.name || u.email)[0].toUpperCase()}</div>`;
    }).join('');
    friendsHtml = `<div class="social-friends"><span class="social-friends-label">${friendCheckins.length} her nå</span><div class="social-friends-avatars">${dots}</div></div>`;
  }

  // Plans for this venue
  let plansHtml = '';
  if (plans.length) {
    plansHtml = plans.map(p => {
      const when = new Date(p.planned_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const creator = p.creator?.name || p.creator?.email || '';
      const invite = p._invite;
      let actions = '';
      if (invite && invite.status === 'pending') {
        actions = `<div class="plan-actions">
          <button class="btn-accept" onclick="respondToPlanInvite('${invite.id}','accepted')">${t('plan_accept')}</button>
          <button class="btn-decline" onclick="respondToPlanInvite('${invite.id}','declined')">${t('plan_decline')}</button>
        </div>`;
      } else if (invite) {
        actions = `<span class="plan-status">${t('plan_invite_' + invite.status)}</span>`;
      }
      return `<div class="detail-plan-item">
        <div class="plan-info"><span class="plan-when">${when}</span><span class="plan-creator">${creator}</span>${p.message ? `<span class="plan-msg">${p.message}</span>` : ''}</div>
        ${actions}
      </div>`;
    }).join('');
  }

  const goingSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
  const hereSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;

  return `
    <div class="social-card">
      ${friendsHtml}
      <div class="social-btns">
        <button class="social-btn social-btn-going" onclick="_openGoingForm(${v.id})">
          ${goingSvg}
          <span>${t('going_there')}</span>
        </button>
        ${isCheckedInHere
          ? `<button class="social-btn social-btn-here social-btn-active" onclick="_openHereMenu(${v.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span>${t('im_here')}</span>
            </button>`
          : `<button class="social-btn social-btn-here" onclick="_openHereMenu(${v.id})">
              ${hereSvg}
              <span>${t('im_here')}</span>
            </button>`}
      </div>
      ${plansHtml}
      <div id="going-form-${v.id}" class="social-form-overlay" style="display:none"></div>
      <div id="here-menu-${v.id}" class="social-form-overlay" style="display:none"></div>
    </div>`;
}

/** "Jeg drar hit" form — pre-filled with current time slider value. */
function _openGoingForm(venueId) {
  if (typeof authCurrentUser === 'function' && !authCurrentUser()) {
    if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
    return;
  }
  const form = document.getElementById('going-form-' + venueId);
  if (!form) return;
  // Close "here" menu if open
  const hereMenu = document.getElementById('here-menu-' + venueId);
  if (hereMenu) hereMenu.style.display = 'none';
  if (form.style.display !== 'none') { form.style.display = 'none'; return; }

  const friends = typeof _friends !== 'undefined' ? _friends : [];
  const friendList = friends.map(f => {
    const avatar = f.avatar_url
      ? `<img class="friend-avatar-sm" src="${f.avatar_url}" alt="">`
      : `<div class="friend-avatar-sm friend-avatar-sm-init">${(f.name || f.email)[0].toUpperCase()}</div>`;
    return `<label class="plan-friend-check"><input type="checkbox" value="${f.id}"> ${avatar} ${f.name || f.email}</label>`;
  }).join('');

  form.innerHTML = `
    <div class="social-form-inner">
      <label class="social-form-label">${t('plan_time_label')}</label>
      <input type="datetime-local" id="plan-time-input" class="social-form-input" />
      <div class="social-form-actions">
        <button class="social-form-btn" onclick="_showGoingFriendPicker(${venueId})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          ${t('invite_friends')}
        </button>
        <button class="social-form-btn social-form-btn-accent" onclick="_broadcastGoing(${venueId})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          ${t('broadcast')}
        </button>
      </div>
      <div id="going-friend-picker-${venueId}" class="going-friend-picker" style="display:none">
        ${friends.length ? friendList : `<div class="friends-empty">${t('no_friends_yet')}</div>`}
        <button class="social-form-btn" onclick="_shareGoingLink(${venueId})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          ${t('share_link')}
        </button>
        <button class="social-form-btn social-form-btn-accent" onclick="_submitGoing(${venueId})">${t('going_there')}</button>
      </div>
    </div>`;
  form.style.display = 'block';

  // Pre-fill time from slider/picker
  const dateStr = typeof datePicker !== 'undefined' ? datePicker.value : new Date().toISOString().slice(0, 10);
  const hour = typeof timeFromEl !== 'undefined' ? parseFloat(timeFromEl.value) : new Date().getHours();
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const input = document.getElementById('plan-time-input');
  if (input) input.value = `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function _showGoingFriendPicker(venueId) {
  const picker = document.getElementById('going-friend-picker-' + venueId);
  if (picker) picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
}

/** Broadcast to all friends — create plan visible to everyone. */
async function _broadcastGoing(venueId) {
  const timeInput = document.getElementById('plan-time-input');
  if (!timeInput || !timeInput.value) return;
  const friends = typeof _friends !== 'undefined' ? _friends : [];
  const allFriendIds = friends.map(f => f.id);
  await createPlan(venueId, new Date(timeInput.value).toISOString(), '', allFriendIds);
  const form = document.getElementById('going-form-' + venueId);
  if (form) form.style.display = 'none';
}

/** Share invite link for the plan. */
function _shareGoingLink(venueId) {
  const timeInput = document.getElementById('plan-time-input');
  const timeVal = timeInput?.value || '';
  const user = typeof authCurrentUser === 'function' ? authCurrentUser() : null;
  if (!user) return;
  const data = btoa(JSON.stringify({ u: user.id, v: venueId, t: timeVal }));
  const url = `${location.origin}${location.pathname}#invite/${data}`;
  if (navigator.share) {
    const v = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === venueId) : null;
    navigator.share({ title: v ? `${v.name} — ${t('going_there')}` : t('going_there'), url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url);
    if (typeof _showToast === 'function') _showToast(t('invite_link_copied'));
  }
}

/** Submit "jeg drar hit" with selected friends. */
async function _submitGoing(venueId) {
  const timeInput = document.getElementById('plan-time-input');
  if (!timeInput || !timeInput.value) return;
  const friendIds = [];
  document.querySelectorAll(`#going-friend-picker-${venueId} input:checked`).forEach(cb => friendIds.push(cb.value));
  await createPlan(venueId, new Date(timeInput.value).toISOString(), '', friendIds);
  const form = document.getElementById('going-form-' + venueId);
  if (form) form.style.display = 'none';
}

/** "Jeg er her" menu — check in + optionally notify/share. */
function _openHereMenu(venueId) {
  if (typeof authCurrentUser === 'function' && !authCurrentUser()) {
    if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
    return;
  }
  const menu = document.getElementById('here-menu-' + venueId);
  if (!menu) return;
  // Close "going" form if open
  const goingForm = document.getElementById('going-form-' + venueId);
  if (goingForm) goingForm.style.display = 'none';
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }

  const myCheckin = typeof getMyCheckin === 'function' ? getMyCheckin() : null;
  const isCheckedInHere = myCheckin && String(myCheckin.venue_id) === String(venueId);

  if (isCheckedInHere) {
    menu.innerHTML = `<div class="social-form-inner">
      <button class="social-form-btn" onclick="checkOut()">${t('check_out_success')}</button>
    </div>`;
  } else {
    menu.innerHTML = `<div class="social-form-inner">
      <div class="social-form-actions">
        <button class="social-form-btn" onclick="_checkInAndNotify(${venueId})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          ${t('send_to_friends')}
        </button>
        <button class="social-form-btn" onclick="_shareHereLink(${venueId})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          ${t('share_link')}
        </button>
      </div>
    </div>`;
  }
  menu.style.display = 'block';
}

async function _checkInAndNotify(venueId) {
  await checkIn(venueId, '');
  const menu = document.getElementById('here-menu-' + venueId);
  if (menu) menu.style.display = 'none';
}

function _shareHereLink(venueId) {
  // Check in first, then share link
  checkIn(venueId, '');
  const user = typeof authCurrentUser === 'function' ? authCurrentUser() : null;
  if (!user) return;
  const data = btoa(JSON.stringify({ u: user.id, v: venueId, type: 'here' }));
  const url = `${location.origin}${location.pathname}#invite/${data}`;
  if (navigator.share) {
    const v = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === venueId) : null;
    navigator.share({ title: v ? `${v.name} — ${t('im_here')}` : t('im_here'), url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url);
    if (typeof _showToast === 'function') _showToast(t('invite_link_copied'));
  }
  const menu = document.getElementById('here-menu-' + venueId);
  if (menu) menu.style.display = 'none';
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

