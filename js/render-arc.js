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
  c.strokeStyle = 'rgba(255,184,0,0.18)'; c.lineWidth = 1; c.stroke();

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
    c.strokeStyle = 'rgba(255,184,0,0.25)'; c.lineWidth = 1; c.stroke();
    const glow = c.createRadialGradient(sx, sy, 0, sx, sy, 9);
    glow.addColorStop(0, 'rgba(255,184,0,0.55)'); glow.addColorStop(1, 'rgba(255,184,0,0)');
    c.beginPath(); c.arc(sx, sy, 9, 0, Math.PI * 2); c.fillStyle = glow; c.fill();
    c.beginPath(); c.arc(sx, sy, 3.5, 0, Math.PI * 2); c.fillStyle = '#FFB800'; c.fill();
  } else {
    c.font = '13px serif';
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('☽', cx, cy + 1);
  }
}

// ── Sun curve (day arc) ───────────────────────────────────────────────────────
/**
 * Draws a sun altitude arc for the full day onto a canvas element.
 * Shows: filled arc (golden above horizon), sunrise/sunset tick labels,
 * current time marker (glowing dot).
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
  const PAD_X = 10, PAD_T = 10, PAD_B = 18;
  const cw = cssW, ch = cssH;
  const dateStr = datePicker.value;
  const fromH = parseFloat(timeFromEl.value);

  // Sample altitudes every 15 min
  const samples = [];
  let maxAlt = 5;
  for (let t = MIN_H; t <= MAX_H + 0.01; t += 0.25) {
    const sun = getSunFromTable(currentSunTable, Math.min(t, MAX_H));
    if (sun.alt > maxAlt) maxAlt = sun.alt;
    samples.push({ t: Math.min(t, MAX_H), alt: sun.alt });
  }

  const timeToX = t => PAD_X + (t - MIN_H) / (MAX_H - MIN_H) * (cw - PAD_X * 2);
  const altToY  = a => PAD_T + (1 - Math.max(0, a) / (maxAlt * 1.15)) * (ch - PAD_T - PAD_B);
  const horizY  = altToY(0);

  // Horizon line — thicker to read as a scrubbable track
  c.beginPath();
  c.moveTo(PAD_X, horizY); c.lineTo(cw - PAD_X, horizY);
  c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 3;
  c.lineCap = 'round'; c.stroke(); c.lineCap = 'butt';

  // Hour grid lines — draw before arc fill
  for (let h = Math.ceil(MIN_H); h <= MAX_H; h++) {
    if (h % 2 !== 0) continue;
    c.beginPath(); c.moveTo(timeToX(h), PAD_T); c.lineTo(timeToX(h), horizY);
    c.strokeStyle = 'rgba(255,255,255,0.055)'; c.lineWidth = 1; c.stroke();
  }

  // Build above-horizon segment — split at fromH for today (past=faded, future=bright)
  const above = samples.filter(s => s.alt > 0);
  if (above.length > 1) {
    const isToday = dateStr === todayStr();
    const splitH  = (isToday && fromH > MIN_H) ? fromH : null;
    const pastSamp = splitH ? above.filter(s => s.t <= splitH) : [];
    const futureSamp = splitH ? above.filter(s => s.t >= splitH) : above;

    // 1a — Past arc fill (very faint)
    if (pastSamp.length > 1) {
      const pg = c.createLinearGradient(0, PAD_T, 0, horizY);
      pg.addColorStop(0, 'rgba(255,184,0,0.07)');
      pg.addColorStop(1, 'rgba(255,184,0,0.01)');
      c.beginPath();
      c.moveTo(timeToX(pastSamp[0].t), horizY);
      pastSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.lineTo(timeToX(pastSamp[pastSamp.length-1].t), horizY);
      c.closePath();
      c.fillStyle = pg; c.fill();
    }

    // 1b — Future arc fill
    if (futureSamp.length > 1) {
      const grad = c.createLinearGradient(0, PAD_T, 0, horizY);
      grad.addColorStop(0, 'rgba(255,184,0,0.28)');
      grad.addColorStop(1, 'rgba(255,184,0,0.04)');
      c.beginPath();
      c.moveTo(timeToX(futureSamp[0].t), horizY);
      futureSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.lineTo(timeToX(futureSamp[futureSamp.length-1].t), horizY);
      c.closePath();
      c.fillStyle = grad; c.fill();
    }

    // 2 — Cloud cover overlay clipped to future arc only
    if (typeof getWeatherAt === 'function' && futureSamp.length > 1) {
      c.save();
      c.beginPath();
      c.moveTo(timeToX(futureSamp[0].t), horizY);
      futureSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.lineTo(timeToX(futureSamp[futureSamp.length-1].t), horizY);
      c.closePath();
      c.clip();
      const cloudFrom = splitH ?? MIN_H;
      for (let t = cloudFrom; t < MAX_H; t++) {
        const wx = getWeatherAt(dateStr, t);
        if (!wx || wx.cloud < 0.15) continue;
        const x1 = timeToX(t), x2 = timeToX(t + 1);
        const alpha = Math.min(0.85, wx.cloud * 0.72);
        c.fillStyle = `rgba(105,120,148,${alpha.toFixed(2)})`;
        c.fillRect(x1, PAD_T, x2 - x1, horizY - PAD_T);
      }
      c.restore();
    }

    // 3 — Arc stroke: past=dim, future=bright
    if (pastSamp.length > 1) {
      c.beginPath();
      c.moveTo(timeToX(pastSamp[0].t), altToY(pastSamp[0].alt));
      pastSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.strokeStyle = 'rgba(255,184,0,0.2)'; c.lineWidth = 1.5; c.stroke();
    }
    if (futureSamp.length > 1) {
      c.beginPath();
      c.moveTo(timeToX(futureSamp[0].t), altToY(futureSamp[0].alt));
      futureSamp.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.strokeStyle = 'rgba(255,184,0,0.9)'; c.lineWidth = 2; c.stroke();
    }
  }

  // Sunrise + sunset ticks only
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);
  c.font = '9px "Inter", sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'top';
  [{ t: sunrise, label: formatHour(sunrise) }, { t: sunset, label: formatHour(sunset) }].forEach(({ t, label }) => {
    if (t == null) return;
    const tx = timeToX(t);
    c.beginPath(); c.moveTo(tx, horizY - 2); c.lineTo(tx, horizY + 4);
    c.strokeStyle = 'rgba(255,184,0,0.45)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = 'rgba(255,184,0,0.65)';
    c.fillText(label, tx, horizY + 5);
  });

  // Hour labels
  for (let h = Math.ceil(MIN_H); h <= MAX_H; h++) {
    if (h % 2 !== 0) continue;
    if (sunrise != null && Math.abs(h - sunrise) < 0.8) continue;
    if (sunset  != null && Math.abs(h - sunset)  < 0.8) continue;
    c.font = '11px "Inter", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.fillStyle = 'rgba(213,196,171,0.45)';
    c.fillText(`${h}`, timeToX(h), ch - 2);
  }

  // Scrub indicator — permanent at selected time, moves to hover position
  const scrubH = (typeof arcHoverH === 'number') ? arcHoverH : fromH;
  const isHovering = typeof arcHoverH === 'number';
  if (scrubH >= MIN_H && scrubH <= MAX_H) {
    const sx = timeToX(scrubH);
    const scrubSun = getSunFromTable(currentSunTable, scrubH);
    const sy = altToY(Math.max(0, scrubSun.alt));

    // Vertical dashed line
    c.beginPath(); c.moveTo(sx, PAD_T); c.lineTo(sx, horizY - 1);
    c.strokeStyle = 'rgba(213,196,171,0.38)'; c.lineWidth = 1;
    c.setLineDash([2, 3]); c.stroke(); c.setLineDash([]);

    // Dot on arc
    c.beginPath(); c.arc(sx, sy, 4, 0, Math.PI * 2);
    c.fillStyle = isHovering ? 'rgba(213,196,171,0.88)' : 'rgba(255,184,0,0.92)';
    c.fill();

    // Ghost thumb at horizon
    c.beginPath(); c.arc(sx, horizY, isHovering ? 7 : 6, 0, Math.PI * 2);
    c.fillStyle = isHovering ? 'rgba(213,196,171,0.18)' : 'rgba(255,184,0,0.14)'; c.fill();
    c.strokeStyle = isHovering ? 'rgba(213,196,171,0.58)' : 'rgba(255,184,0,0.72)';
    c.lineWidth = 1.5; c.stroke();
  }

  c.restore();
}
