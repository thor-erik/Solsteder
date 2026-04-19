/**
 * render-arc.js — Sun compass and day arc canvas drawing.
 * Depends on: map, currentSun, currentSunTable (app.js)
 *             getSunFromTable, findSunCrossingFromTable (solar.js)
 *             getWeatherAt (weather.js)
 *             todayStr, formatHour (app.js)
 *             datePicker, timeFromEl, arcHoverH (app.js / ui.js)
 */

// ── Sun compass ───────────────────────────────────────────────────────────────
function drawSunCompass() {
  const cc = document.getElementById('sun-compass');
  if (!cc) return;
  const c = cc.getContext('2d');
  const w = cc.width, h = cc.height, cx = w / 2, cy = h / 2;
  const outerR = w / 2 - 2, innerR = outerR - 5;

  c.clearRect(0, 0, w, h);
  c.beginPath(); c.arc(cx, cy, outerR, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.04)'; c.fill();
  c.strokeStyle = 'rgba(255,175,133,0.18)'; c.lineWidth = 1; c.stroke();

  for (let i = 0; i < 8; i++) {
    const angle = (i * 45 - 90) * RAD;
    const len   = i % 2 === 0 ? 5 : 3;
    c.beginPath();
    c.moveTo(cx + (outerR - len) * Math.cos(angle), cy + (outerR - len) * Math.sin(angle));
    c.lineTo(cx + outerR * Math.cos(angle),          cy + outerR * Math.sin(angle));
    c.strokeStyle = i === 0 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.2)';
    c.lineWidth = i % 2 === 0 ? 1.5 : 1; c.stroke();
  }
  c.font = 'bold 7px "Inter", sans-serif';
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('N', cx, cy - innerR + 6);

  if (!currentSun) return;

  if (currentSun.alt > 0) {
    const sunAngle = (currentSun.az - 90) * RAD;
    const sr = outerR - 3;
    const sx = cx + sr * Math.cos(sunAngle), sy = cy + sr * Math.sin(sunAngle);
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(sx, sy);
    c.strokeStyle = 'rgba(255,175,133,0.25)'; c.lineWidth = 1; c.stroke();
    const glow = c.createRadialGradient(sx, sy, 0, sx, sy, 9);
    glow.addColorStop(0, 'rgba(255,175,133,0.55)'); glow.addColorStop(1, 'rgba(255,175,133,0)');
    c.beginPath(); c.arc(sx, sy, 9, 0, Math.PI * 2); c.fillStyle = glow; c.fill();
    c.beginPath(); c.arc(sx, sy, 3.5, 0, Math.PI * 2); c.fillStyle = '#FFAF85'; c.fill();
  } else {
    c.font = '13px serif';
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('☽', cx, cy + 1);
  }
}

// ── Sun curve / temperature curve (day arc) ───────────────────────────────────
/**
 * Draws the time-picker chart for the given canvas element.
 *
 * When hourly weather data is available: renders a temperature curve with
 * cloud-cover bands and precipitation bars. The band width equals the actual
 * data interval (1 h for near-term, 6 h for days 3+), making data resolution
 * visible at a glance.
 *
 * Falls back to a solar altitude arc when no weather data is available.
 */
function drawSunCurve(canvasEl) {
  if (!canvasEl || !currentSunTable) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvasEl.clientWidth  || 400;
  const cssH = canvasEl.clientHeight || 64;
  const pw   = Math.round(cssW * dpr);
  const ph   = Math.round(cssH * dpr);
  if (canvasEl.width !== pw || canvasEl.height !== ph) { canvasEl.width = pw; canvasEl.height = ph; }

  const c = canvasEl.getContext('2d');
  c.clearRect(0, 0, pw, ph);
  c.save();
  c.scale(dpr, dpr);

  const MIN_H = (typeof MIN_H_ARC !== 'undefined') ? MIN_H_ARC : 4;
  const MAX_H = (typeof MAX_H_ARC !== 'undefined') ? MAX_H_ARC : 23;
  // PAD_X intentionally matches PAD_X_ARC in app.js so click-to-time mapping is exact
  const PAD_X = (typeof PAD_X_ARC !== 'undefined') ? PAD_X_ARC : 20;
  const cw = cssW, ch = cssH;
  const dateStr = datePicker.value;
  const fromH   = parseFloat(timeFromEl.value);
  const isToday = dateStr === todayStr();

  const timeToX = t => PAD_X + (t - MIN_H) / (MAX_H - MIN_H) * (cw - PAD_X * 2);

  // Determine whether weather data exists for this date
  const wxHours = (typeof getWeatherHoursForDate === 'function') ? getWeatherHoursForDate(dateStr) : [];
  const hasWx   = wxHours.length > 0 && typeof getWeatherAt === 'function';

  if (!hasWx) {
    _drawSunArc(c, cw, ch, dateStr, fromH, isToday, MIN_H, MAX_H, PAD_X, timeToX);
    c.restore();
    return;
  }

  // ── Temperature + weather mode ──────────────────────────────────────────────
  const PAD_T    = 8;
  const PRECIP_H = 10;   // precipitation bars area
  const PAD_B    = 18;   // hour labels at bottom
  const CHART_H  = ch - PAD_T - PRECIP_H - PAD_B;
  const baseY    = PAD_T + CHART_H;   // baseline between chart and precip area
  const bottomY  = baseY + PRECIP_H;  // top of label area

  // Collect temperature samples (0.25h steps for smooth curve)
  let minTemp = Infinity, maxTemp = -Infinity;
  const tempSamples = [];
  for (let t = MIN_H; t <= MAX_H + 0.01; t += 0.25) {
    const wx = getWeatherAt(dateStr, Math.min(t, MAX_H));
    if (wx) {
      if (wx.temp < minTemp) minTemp = wx.temp;
      if (wx.temp > maxTemp) maxTemp = wx.temp;
    }
    tempSamples.push({ t: Math.min(t, MAX_H), wx });
  }

  // Ensure a visible range even if temperature is flat
  const tempRange = Math.max(4, maxTemp - minTemp);
  const tempPad   = tempRange * 0.20;
  const tMin = minTemp - tempPad;
  const tMax = maxTemp + tempPad * 1.6; // extra headroom for labels
  const tempToY = temp => PAD_T + (1 - (temp - tMin) / (tMax - tMin)) * CHART_H;

  // ── 1. Cloud-cover bands — width = data interval, conveying resolution ──────
  for (let i = 0; i < wxHours.length; i++) {
    const h    = wxHours[i];
    if (h > MAX_H) continue;
    const nextH = i + 1 < wxHours.length ? Math.min(wxHours[i + 1], MAX_H) : MAX_H;
    const wx   = getWeatherAt(dateStr, h);
    if (!wx) continue;

    const x1 = timeToX(Math.max(h, MIN_H));
    const x2 = timeToX(nextH);
    if (x2 <= x1) continue;

    // Color: warm-tinted for clear, cool/grey for clouds — alpha conveys severity
    let r, g, b, alpha;
    if (wx.cloud < 0.15)      { r=255; g=220; b=150; alpha=0.00; } // clear: no fill
    else if (wx.cloud < 0.40) { r=200; g=200; b=220; alpha=0.08; }
    else if (wx.cloud < 0.65) { r=110; g=130; b=175; alpha=0.18; }
    else if (wx.cloud < 0.85) { r= 80; g=105; b=155; alpha=0.28; }
    else                      { r= 60; g= 85; b=135; alpha=0.40; }

    if (alpha > 0) {
      c.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      c.fillRect(x1, PAD_T, x2 - x1, CHART_H);
    }

    // Subtle left-edge tick marks each data slot boundary so users can see resolution
    if (h >= MIN_H) {
      c.beginPath();
      c.moveTo(x1, PAD_T); c.lineTo(x1, PAD_T + 5);
      c.strokeStyle = 'rgba(156,189,231,0.22)'; c.lineWidth = 1; c.stroke();
    }
  }

  // ── 2. Precipitation bars ───────────────────────────────────────────────────
  const MAX_PRECIP_MM = 4; // cap for bar height scaling
  for (let i = 0; i < wxHours.length; i++) {
    const h  = wxHours[i];
    if (h > MAX_H || h < MIN_H) continue;
    const wx = getWeatherAt(dateStr, h);
    if (!wx || wx.precip <= 0) continue;
    const nextH = i + 1 < wxHours.length ? Math.min(wxHours[i + 1], MAX_H) : MAX_H;
    const barH  = Math.min(1, wx.precip / MAX_PRECIP_MM) * PRECIP_H;
    const x1    = timeToX(h);
    const x2    = timeToX(nextH);
    const alpha = Math.min(0.85, 0.35 + wx.precip * 0.12);
    c.fillStyle = `rgba(100,165,255,${alpha.toFixed(2)})`;
    c.fillRect(x1 + 0.5, baseY + (PRECIP_H - barH), Math.max(1, x2 - x1 - 1), barH);
  }

  // ── 3. Temperature curve ────────────────────────────────────────────────────
  const splitH    = isToday ? fromH : null;
  const validPts  = tempSamples.filter(s => s.wx != null);
  const pastPts   = splitH ? validPts.filter(s => s.t <= splitH) : [];
  const futurePts = splitH ? validPts.filter(s => s.t >= splitH) : validPts;

  // Fill under curve
  const _fillCurve = (pts, fillStyle) => {
    if (pts.length < 2) return;
    c.beginPath();
    c.moveTo(timeToX(pts[0].t), baseY);
    pts.forEach(s => c.lineTo(timeToX(s.t), tempToY(s.wx.temp)));
    c.lineTo(timeToX(pts[pts.length - 1].t), baseY);
    c.closePath();
    c.fillStyle = fillStyle; c.fill();
  };

  if (pastPts.length > 1) {
    _fillCurve(pastPts, 'rgba(255,175,133,0.04)');
  }
  if (futurePts.length > 1) {
    const fg = c.createLinearGradient(0, PAD_T, 0, baseY);
    fg.addColorStop(0, 'rgba(255,175,133,0.18)');
    fg.addColorStop(1, 'rgba(255,175,133,0.02)');
    _fillCurve(futurePts, fg);
  }

  // Curve stroke
  const _strokeCurve = (pts, strokeStyle, lineWidth) => {
    if (pts.length < 2) return;
    c.beginPath();
    pts.forEach((s, i) => {
      const x = timeToX(s.t), y = tempToY(s.wx.temp);
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    });
    c.strokeStyle = strokeStyle; c.lineWidth = lineWidth; c.stroke();
  };

  if (pastPts.length > 1)   _strokeCurve(pastPts,   'rgba(255,175,133,0.22)', 1.5);
  if (futurePts.length > 1) _strokeCurve(futurePts, 'rgba(255,175,133,0.90)', 2);

  // ── 4. Sunrise / sunset ticks ───────────────────────────────────────────────
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);
  c.font = '9px "Inter", sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'top';
  [{ t: sunrise }, { t: sunset }].forEach(({ t }) => {
    if (t == null) return;
    const tx = timeToX(t);
    c.beginPath(); c.moveTo(tx, PAD_T); c.lineTo(tx, bottomY);
    c.strokeStyle = 'rgba(255,175,133,0.20)'; c.lineWidth = 1;
    c.setLineDash([2, 3]); c.stroke(); c.setLineDash([]);
    c.fillStyle = 'rgba(255,175,133,0.50)';
    c.fillText(formatHour(t), tx, bottomY + 2);
  });

  // ── 5. Hour labels ──────────────────────────────────────────────────────────
  for (let h = Math.ceil(MIN_H); h <= MAX_H; h++) {
    if (h % 2 !== 0) continue;
    if (sunrise != null && Math.abs(h - sunrise) < 0.8) continue;
    if (sunset  != null && Math.abs(h - sunset)  < 0.8) continue;
    c.font = '11px "Inter", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.fillStyle = 'rgba(156,189,231,0.45)';
    c.fillText(`${h}`, timeToX(h), ch - 2);
  }

  // ── 6. Scrub indicator — half-height glass pill thumb ───────────────────────
  const scrubH     = (typeof arcHoverH === 'number') ? arcHoverH : fromH;
  const isHovering = typeof arcHoverH === 'number';

  if (scrubH >= MIN_H && scrubH <= MAX_H) {
    const sx = timeToX(scrubH);

    // Half-height pill thumb centered in the chart+precip area
    const barH   = CHART_H + PRECIP_H;   // total colored band height
    const tW     = 11;
    const tH     = Math.round(barH * 0.54);
    const tX     = sx - tW / 2;
    const tY     = PAD_T + (barH - tH) / 2;
    const tR     = tW / 2;                // capsule: radius = half width

    // Drop shadow
    c.save();
    c.shadowColor   = 'rgba(0,0,0,0.40)';
    c.shadowBlur    = 6;
    c.shadowOffsetY = 1;

    // Fill
    c.beginPath();
    c.moveTo(tX + tR, tY);
    c.lineTo(tX + tW - tR, tY);
    c.arcTo(tX + tW, tY,       tX + tW, tY + tR,       tR);
    c.lineTo(tX + tW, tY + tH - tR);
    c.arcTo(tX + tW, tY + tH,  tX + tW - tR, tY + tH,  tR);
    c.lineTo(tX + tR, tY + tH);
    c.arcTo(tX,       tY + tH,  tX, tY + tH - tR,       tR);
    c.lineTo(tX,      tY + tR);
    c.arcTo(tX,       tY,       tX + tR, tY,             tR);
    c.closePath();
    c.fillStyle = isHovering ? 'rgba(200,225,255,0.95)' : 'rgba(255,252,248,0.92)';
    c.fill();
    c.restore();
  }

  c.restore();
}

// ── Sun arc fallback (no weather data available) ──────────────────────────────
function _drawSunArc(c, cw, ch, dateStr, fromH, isToday, MIN_H, MAX_H, PAD_X, timeToX) {
  const PAD_T = 10, PAD_B = 18;

  // Sample sun altitudes every 15 min
  const samples = [];
  let maxAlt = 5;
  for (let t = MIN_H; t <= MAX_H + 0.01; t += 0.25) {
    const sun = getSunFromTable(currentSunTable, Math.min(t, MAX_H));
    if (sun.alt > maxAlt) maxAlt = sun.alt;
    samples.push({ t: Math.min(t, MAX_H), alt: sun.alt });
  }

  const altToY = a => PAD_T + (1 - Math.max(0, a) / (maxAlt * 1.15)) * (ch - PAD_T - PAD_B);
  const horizY = altToY(0);

  // Horizon track
  c.beginPath();
  c.moveTo(PAD_X, horizY); c.lineTo(cw - PAD_X, horizY);
  c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 3;
  c.lineCap = 'round'; c.stroke(); c.lineCap = 'butt';

  // Hour grid
  for (let h = Math.ceil(MIN_H); h <= MAX_H; h++) {
    if (h % 2 !== 0) continue;
    c.beginPath(); c.moveTo(timeToX(h), PAD_T); c.lineTo(timeToX(h), horizY);
    c.strokeStyle = 'rgba(255,255,255,0.055)'; c.lineWidth = 1; c.stroke();
  }

  // Arc fill + stroke (past dim, future bright)
  const above = samples.filter(s => s.alt > 0);
  if (above.length > 1) {
    const splitH    = isToday ? fromH : null;
    const pastSamp   = splitH ? above.filter(s => s.t <= splitH) : [];
    const futureSamp = splitH ? above.filter(s => s.t >= splitH) : above;

    if (pastSamp.length > 1) {
      const pg = c.createLinearGradient(0, PAD_T, 0, horizY);
      pg.addColorStop(0, 'rgba(255,175,133,0.07)');
      pg.addColorStop(1, 'rgba(255,175,133,0.01)');
      c.beginPath();
      c.moveTo(timeToX(pastSamp[0].t), horizY);
      pastSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.lineTo(timeToX(pastSamp[pastSamp.length-1].t), horizY);
      c.closePath(); c.fillStyle = pg; c.fill();
      c.beginPath();
      c.moveTo(timeToX(pastSamp[0].t), altToY(pastSamp[0].alt));
      pastSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.strokeStyle = 'rgba(255,175,133,0.2)'; c.lineWidth = 1.5; c.stroke();
    }
    if (futureSamp.length > 1) {
      const grad = c.createLinearGradient(0, PAD_T, 0, horizY);
      grad.addColorStop(0, 'rgba(255,175,133,0.28)');
      grad.addColorStop(1, 'rgba(255,175,133,0.04)');
      c.beginPath();
      c.moveTo(timeToX(futureSamp[0].t), horizY);
      futureSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.lineTo(timeToX(futureSamp[futureSamp.length-1].t), horizY);
      c.closePath(); c.fillStyle = grad; c.fill();
      c.beginPath();
      c.moveTo(timeToX(futureSamp[0].t), altToY(futureSamp[0].alt));
      futureSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.strokeStyle = 'rgba(255,175,133,0.9)'; c.lineWidth = 2; c.stroke();
    }
  }

  // Sunrise / sunset ticks
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);
  c.font = '9px "Inter", sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'top';
  [{ t: sunrise }, { t: sunset }].forEach(({ t }) => {
    if (t == null) return;
    const tx = timeToX(t);
    c.beginPath(); c.moveTo(tx, horizY - 2); c.lineTo(tx, horizY + 4);
    c.strokeStyle = 'rgba(255,175,133,0.45)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = 'rgba(255,175,133,0.65)';
    c.fillText(formatHour(t), tx, horizY + 5);
  });

  // Hour labels
  for (let h = Math.ceil(MIN_H); h <= MAX_H; h++) {
    if (h % 2 !== 0) continue;
    if (sunrise != null && Math.abs(h - sunrise) < 0.8) continue;
    if (sunset  != null && Math.abs(h - sunset)  < 0.8) continue;
    c.font = '11px "Inter", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.fillStyle = 'rgba(156,189,231,0.45)';
    c.fillText(`${h}`, timeToX(h), ch - 2);
  }

  // Scrub indicator — half-height glass pill thumb (arc/no-weather mode)
  const scrubH     = (typeof arcHoverH === 'number') ? arcHoverH : fromH;
  const isHovering = typeof arcHoverH === 'number';
  if (scrubH >= MIN_H && scrubH <= MAX_H) {
    const sx   = timeToX(scrubH);
    const barH = horizY - PAD_T;          // height of arc area above horizon
    const tW   = 11;
    const tH   = Math.round(barH * 0.54);
    const tX   = sx - tW / 2;
    const tY   = PAD_T + (barH - tH) / 2;
    const tR   = tW / 2;

    c.save();
    c.shadowColor   = 'rgba(0,0,0,0.40)';
    c.shadowBlur    = 6;
    c.shadowOffsetY = 1;
    c.beginPath();
    c.moveTo(tX + tR, tY);
    c.lineTo(tX + tW - tR, tY);
    c.arcTo(tX + tW, tY,       tX + tW, tY + tR,       tR);
    c.lineTo(tX + tW, tY + tH - tR);
    c.arcTo(tX + tW, tY + tH,  tX + tW - tR, tY + tH,  tR);
    c.lineTo(tX + tR, tY + tH);
    c.arcTo(tX,       tY + tH,  tX, tY + tH - tR,       tR);
    c.lineTo(tX,      tY + tR);
    c.arcTo(tX,       tY,       tX + tR, tY,             tR);
    c.closePath();
    c.fillStyle = isHovering ? 'rgba(200,225,255,0.95)' : 'rgba(255,252,248,0.92)';
    c.fill();
    c.restore();
  }
}
