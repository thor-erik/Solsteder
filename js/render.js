/**
 * render.js — Canvas drawing: sprites, markers, building editor, map sync.
 * Depends on: map, canvas, ctx, currentSun, selectedId, editingVenueId (app.js)
 *             VENUES, catIcon (data.js) · venueSunState (solar.js)
 */

// ── Short venue name helper ───────────────────────────────────────────────────
// Strip trailing category/location words but preserve numbers (e.g. "Skur 33").
const _STRIP_CATEGORY = new Set([
  'restaurant', 'bistrobar', 'bistro', 'gastropub', 'pub', 'bar',
  'café', 'cafe', 'brasserie', 'grill', 'kitchen', 'mat', 'spiseri', 'kro',
]);
const _STRIP_AREA = new Set([
  'oslo', 'frogner', 'tjuvholmen', 'sentrum', 'bislett',
  'grünerløkka', 'majorstuen', 'grønland', 'tøyen', 'løkka',
  'aker brygge', 'st. hanshaugen',
]);

function shortName(name) {
  const words = name.trim().split(/\s+/);
  let end = words.length;
  while (end > 1) {
    const last  = words[end - 1].toLowerCase();
    if (/^\d/.test(last)) break;                               // never strip numbers
    if (_STRIP_CATEGORY.has(last)) { end--; continue; }
    if (_STRIP_AREA.has(last))     { end--; continue; }
    if (end > 1) {                                             // two-word area phrase
      const two = (words[end - 2] + ' ' + last).toLowerCase();
      if (_STRIP_AREA.has(two)) { end -= 2; continue; }
    }
    break;
  }
  const result = words.slice(0, end).join(' ');
  return result.length > 14 ? result.slice(0, 13) + '…' : result;
}

// ── Terrace wall helpers ──────────────────────────────────────────────────────
/**
 * Returns the array of wall objects that form the terrace for a venue.
 * - If terraceWallIndices is populated, use those indices into wallNormals.
 * - Otherwise fall back to the single best-match wall (wallSegment / closest bearing).
 */
function getTerraceWalls(v) {
  if (!v.wallNormals?.length) return v.wallSegment ? [v.wallSegment] : [];

  // Priority 1: manual selection from editor
  if (v.terraceWallIndices?.length) {
    return v.terraceWallIndices.map(i => v.wallNormals[i]).filter(Boolean);
  }
  // Priority 2: auto-computed (entrance location + scoring + corner adjacency)
  if (v.autoTerraceWallIndices?.length) {
    return v.autoTerraceWallIndices.map(i => v.wallNormals[i]).filter(Boolean);
  }
  // Fallback: single wall closest to v.facing
  const best = v.wallNormals.reduce((b, w) =>
    Math.abs(w.bearing - v.facing) < Math.abs(b.bearing - v.facing) ? w : b);
  return [best];
}

/**
 * Pixel-space outward unit normal for a wall, pointing away from building centroid.
 * Returns { normX, normY, mx, my } in canvas pixel coords.
 */
function wallOutwardNormal(v, wall) {
  const pa = map.project([wall.aLng, wall.aLat]);
  const pb = map.project([wall.bLng, wall.bLat]);
  const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
  const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
  const wl  = Math.hypot(wdx, wdy) || 1;
  let normX = -wdy / wl, normY = wdx / wl;
  if (v.buildingGeometry) {
    const cen   = computeCentroid(v.buildingGeometry);
    const cenPx = map.project([cen.lon, cen.lat]);
    if (normX * (cenPx.x - mx) + normY * (cenPx.y - my) > 0) { normX = -normX; normY = -normY; }
  }
  return { normX, normY, mx, my };
}

/**
 * Effective terrace depth for a venue in metres.
 * Priority: manual drag value → auto-detected highway distance → fallback constant.
 */
function getEffectiveDepth(v) {
  return v.terraceDepth ?? v.autoTerraceDepth ?? TERRACE_DEPTH_M;
}

/** Pixels per metre at the venue's latitude (lat-direction approximation). */
function pxPerMetre(v) {
  const base = map.project([v.lng, v.lat]);
  const ref  = map.project([v.lng, v.lat + 1 / 111320]);
  return Math.abs(ref.y - base.y);
}

// ── Depth-drag state ──────────────────────────────────────────────────────────
let editDraggingDepth = false;
let editDragWallObj   = null;

// ── Sprite cache ──────────────────────────────────────────────────────────────
// Pill-shaped pins keyed by (id, state, selected, time-bucket).
// buildSprite returns { canvas, anchorX, anchorY } — anchor is the bottom of
// the stem, placed at the venue's map coordinate; the pill floats above it.
const PILL_H  = 26;   // pill body height px
const PILL_R  = 13;   // pill corner radius (= height/2 → fully rounded)
const STEM_H  = 14;   // thin vertical stem below pill
const spriteCache = new Map();

function buildSprite(v, state, selected, hour, dateStr) {
  // Closed: tiny faded dot — no pill
  if (state === 'closed') {
    const oc = document.createElement('canvas');
    oc.width = oc.height = 10;
    const c = oc.getContext('2d');
    c.globalAlpha = 0.22;
    c.beginPath(); c.arc(5, 5, 3, 0, Math.PI * 2);
    c.fillStyle = 'rgba(81,69,50,0.6)'; c.fill();
    return { canvas: oc, anchorX: 5, anchorY: 5 };
  }

  // ── Label + visual style per state ─────────────────────────────────────────
  let label = '', fillColor, strokeColor, textColor, stemColor, isDashed = false, alpha = 1;

  if (state === 'soon') {
    const { open } = v.openingHours ?? {};
    label       = open != null ? formatHour(open) : '—';
    fillColor   = 'rgba(8,14,25,0.88)';
    strokeColor = 'rgba(255,184,0,0.55)';
    stemColor   = 'rgba(255,184,0,0.70)';
    textColor   = 'rgba(255,200,80,0.95)';
    isDashed    = true;
    alpha       = 0.9;

  } else if (state === 'sunny') {
    const ss = (hour !== undefined && dateStr && typeof sunScore === 'function')
      ? Math.round(sunScore(v, dateStr, hour))
      : null;
    label       = ss != null ? `${shortName(v.name)} · ${ss}` : shortName(v.name);
    fillColor   = '#FFB800';
    strokeColor = 'rgba(255,230,120,0.4)';
    stemColor   = '#FFB800';
    textColor   = '#1a1200';

  } else { // shaded
    if (hour !== undefined && dateStr) {
      try {
        const { windows } = computeSunWindows(v, dateStr);
        const next = windows.find(w => w.start > hour);
        if (next) { label = formatHour(next.start); alpha = 0.85; }
        else       { label = '';  alpha = 0.32; }
      } catch (e) { label = ''; }
    }
    fillColor   = 'rgba(22,28,39,0.92)';
    strokeColor = 'rgba(81,69,50,0.28)';
    stemColor   = 'rgba(150,132,110,0.78)';
    textColor   = 'rgba(213,196,171,0.75)';
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────
  const tmpCtx = document.createElement('canvas').getContext('2d');
  tmpCtx.font  = 'bold 11px "Inter", sans-serif';
  const tw     = label ? tmpCtx.measureText(label).width : 0;
  const pillW  = Math.max(36, tw + 22);

  const rp  = selected ? 4 : 2;              // padding for selection ring
  const cW  = Math.ceil(pillW + rp * 2 + 2);
  const cH  = Math.ceil(PILL_H + STEM_H + rp + 2);
  const cxA = cW / 2;                        // anchor x = stem center
  const cyA = cH - 1;                        // anchor y = bottom of stem

  const oc = document.createElement('canvas');
  oc.width = cW; oc.height = cH;
  const c  = oc.getContext('2d');
  c.globalAlpha = alpha;

  const ox = rp + 1;   // pill left edge
  const oy = rp;       // pill top edge

  // ── Glow (sunny only) — pill-shaped halo behind the label ─────────────────
  if (state === 'sunny') {
    const gCx = cxA, gCy = oy + PILL_H / 2;
    // Use scale trick so the radial gradient follows the pill's aspect ratio
    const scaleX = (pillW * 0.72) / PILL_H;
    c.save();
    c.translate(gCx, gCy);
    c.scale(scaleX, 1);
    const glow = c.createRadialGradient(0, 0, 0, 0, 0, PILL_H);
    glow.addColorStop(0, 'rgba(255,184,0,0.18)');
    glow.addColorStop(1, 'rgba(255,184,0,0)');
    c.beginPath(); c.arc(0, 0, PILL_H, 0, Math.PI * 2);
    c.fillStyle = glow; c.fill();
    c.restore();
  }

  // ── Selection ring ─────────────────────────────────────────────────────────
  if (selected) {
    c.beginPath();
    c.roundRect(ox - 3, oy - 3, pillW + 6, PILL_H + 6, PILL_R + 3);
    c.strokeStyle = 'rgba(255,184,0,0.9)';
    c.lineWidth   = 2;
    c.stroke();
  }

  // ── Stem ───────────────────────────────────────────────────────────────────
  const stemX  = cxA;
  const stemY0 = oy + PILL_H;
  const stemY1 = cyA;
  c.beginPath();
  c.moveTo(stemX, stemY0);
  c.lineTo(stemX, stemY1);
  if (isDashed) c.setLineDash([3, 3]);
  c.strokeStyle = stemColor;
  c.lineWidth   = 2;
  c.stroke();
  c.setLineDash([]);
  // Anchor dot at stem tip (map point)
  c.beginPath(); c.arc(stemX, stemY1, 2, 0, Math.PI * 2);
  c.fillStyle = stemColor; c.fill();

  // ── Pill fill ──────────────────────────────────────────────────────────────
  c.beginPath();
  c.roundRect(ox, oy, pillW, PILL_H, PILL_R);
  c.fillStyle = fillColor;
  c.fill();

  // ── Pill stroke ────────────────────────────────────────────────────────────
  if (isDashed) c.setLineDash([4, 3]);
  c.strokeStyle = strokeColor;
  c.lineWidth   = 1;
  c.stroke();
  c.setLineDash([]);

  // ── Label ──────────────────────────────────────────────────────────────────
  if (label) {
    c.font         = 'bold 11px "Inter", sans-serif';
    c.fillStyle    = textColor;
    c.textAlign    = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, cxA, oy + PILL_H / 2);
  }

  return { canvas: oc, anchorX: cxA, anchorY: cyA };
}

function getSprite(v, state, selected, hour, dateStr) {
  if (spriteCache.size > 600) spriteCache.clear(); // prevent unbounded growth
  const tk  = (hour !== undefined) ? Math.round(hour * 4) : 0; // 15-min buckets
  const key = `${v.id}-${state}-${selected ? 1 : 0}-${tk}`;
  if (!spriteCache.has(key)) spriteCache.set(key, buildSprite(v, state, selected, hour, dateStr));
  return spriteCache.get(key);
}

function clearSpriteCache() { spriteCache.clear(); }

// ── Pin state transition animations ───────────────────────────────────────────
const _pinPrevState = new Map();   // id → last rendered state string
const _pinFadeStart = new Map();   // id → performance.now() when fade began
const PIN_FADE_MS   = 280;
let   _animRafId    = null;

function _scheduleAnimFrame() {
  if (_animRafId) return;
  _animRafId = requestAnimationFrame(() => { _animRafId = null; draw(); });
}

// ── Canvas utilities ──────────────────────────────────────────────────────────
function fillRoundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);      c.arcTo(x + w, y,     x + w, y + r,     r);
  c.lineTo(x + w, y + h - r);  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);      c.arcTo(x,     y + h, x,     y + h - r, r);
  c.lineTo(x, y + r);          c.arcTo(x,     y,     x + r, y,         r);
  c.closePath(); c.fill();
}

function bearingToCardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW','N'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45)];
}

// ── Canvas resize + map sync ──────────────────────────────────────────────────
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const c = document.getElementById('map-container');
  canvas.width  = Math.round(c.offsetWidth  * dpr);
  canvas.height = Math.round(c.offsetHeight * dpr);
  canvas.style.width  = c.offsetWidth  + 'px';
  canvas.style.height = c.offsetHeight + 'px';
}

resizeCanvas();
window.addEventListener('resize', () => {
  resizeCanvas();
  draw();
  drawSunCurve(document.getElementById('sun-curve'));
  drawSunCompass();
});

map.on('move', draw);
map.on('zoomend', draw);

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

// ── Building editor overlay ───────────────────────────────────────────────────
function drawBuildingEditor() {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;

  const _dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = 'rgba(10,14,28,0.58)';
  ctx.fillRect(0, 0, canvas.width / _dpr, canvas.height / _dpr);

  if (!v.buildingGeometry || !v.wallNormals) {
    const pt = map.project([v.lng, v.lat]);
    ctx.strokeStyle = 'rgba(255,184,0,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.moveTo(pt.x - 20, pt.y); ctx.lineTo(pt.x + 20, pt.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pt.x, pt.y - 20); ctx.lineTo(pt.x, pt.y + 20); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const nodes = v.buildingGeometry, walls = v.wallNormals;

  // Building polygon
  ctx.beginPath();
  nodes.forEach((n, i) => {
    const pt = map.project([n.lon, n.lat]);
    i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(24,88,180,0.45)'; ctx.fill();

  const currentWalls = getTerraceWalls(v);

  walls.forEach((wall, idx) => {
    const pa = map.project([wall.aLng, wall.aLat]);
    const pb = map.project([wall.bLng, wall.bLat]);
    const isHovered = idx === editHoveredWallIdx;
    const isCurrent = currentWalls.includes(wall);
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;

    // Pixel-space outward perpendicular
    const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
    const wl  = Math.hypot(wdx, wdy) || 1;
    let normX = -wdy / wl, normY = wdx / wl;
    if (v.buildingGeometry) {
      const cen   = computeCentroid(v.buildingGeometry);
      const cenPx = map.project([cen.lon, cen.lat]);
      if (normX * (cenPx.x - mx) + normY * (cenPx.y - my) > 0) { normX = -normX; normY = -normY; }
    }

    // Wall line
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    ctx.strokeStyle = isHovered ? '#FFB800' : isCurrent ? '#FFD060' : 'rgba(120,180,255,0.75)';
    ctx.lineWidth   = isHovered ? 6 : isCurrent ? 4 : 2.5;
    ctx.stroke();

    if (isHovered || isCurrent) {
      [pa, pb].forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, isHovered ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isHovered ? '#FFB800' : '#FFD060'; ctx.fill();
        ctx.strokeStyle = 'rgba(10,14,28,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
      });
    }

    if (isHovered) {
      const arrowLen = 55, ex = mx + normX * arrowLen, ey = my + normY * arrowLen;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
      ctx.strokeStyle = '#FFB800'; ctx.lineWidth = 2.5; ctx.setLineDash([]); ctx.stroke();
      const hl = 11, pA = Math.atan2(normY, normX);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - hl * Math.cos(pA - 0.4), ey - hl * Math.sin(pA - 0.4));
      ctx.lineTo(ex - hl * Math.cos(pA + 0.4), ey - hl * Math.sin(pA + 0.4));
      ctx.closePath(); ctx.fillStyle = '#FFB800'; ctx.fill();

      const labelText = `${Math.round(wall.bearing)}°  ${bearingToCardinal(wall.bearing)}`;
      ctx.font = 'bold 12px "Inter", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(labelText).width;
      const lx = ex + normX * 18, ly = ey + normY * 18;
      ctx.fillStyle = 'rgba(10,14,28,0.88)';
      fillRoundRect(ctx, lx - tw / 2 - 8, ly - 12, tw + 16, 24, 6);
      ctx.fillStyle = '#FFB800'; ctx.fillText(labelText, lx, ly);
    }

    if (isCurrent && !isHovered) {
      const arrowLen = 32, ex = mx + normX * arrowLen, ey = my + normY * arrowLen;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
      ctx.strokeStyle = '#FFD060'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // ── Terrace preview + depth handles ────────────────────────────────────────
  if (currentWalls.length > 0) {
    const depth  = getEffectiveDepth(v);
    const pxPerM = pxPerMetre(v);
    const depthPx = depth * pxPerM;

    // Mitered terrace preview (one clean polygon per connected chain)
    const polys = terracePolygons(v, currentWalls, depthPx);
    polys.forEach(poly => {
      ctx.beginPath();
      poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(100,255,180,0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(100,255,180,0.55)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    });

    // Depth handle per wall (each shows depth, drag adjusts shared depth)
    currentWalls.forEach(wall => {
      const { normX, normY, mx, my } = wallOutwardNormal(v, wall);
      const hx = mx + normX * depthPx;
      const hy = my + normY * depthPx;

      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(hx, hy);
      ctx.strokeStyle = 'rgba(100,255,180,0.6)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);

      const draggingThis = editDraggingDepth && editDragWallObj === wall;
      ctx.beginPath(); ctx.arc(hx, hy, draggingThis ? 10 : 8, 0, Math.PI * 2);
      ctx.fillStyle   = draggingThis ? '#64ffb4' : 'rgba(100,255,180,0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,14,28,0.9)'; ctx.lineWidth = 2; ctx.stroke();

      // Depth label
      ctx.font = 'bold 10px "Inter", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lx = hx + normX * 20, ly = hy + normY * 20;
      ctx.fillStyle = 'rgba(10,14,28,0.88)';
      fillRoundRect(ctx, lx - 15, ly - 10, 30, 20, 5);
      ctx.fillStyle = '#64ffb4';
      ctx.fillText(`${Math.round(depth)}m`, lx, ly);
    });
  }
}

// ── Convex hull (Andrew's monotone chain) ─────────────────────────────────────
function convexHull(pts) {
  pts = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// ── Seating area shapes ────────────────────────────────────────────────────────
const TERRACE_DEPTH_M = 5;  // metres outward from the terrace wall

/** 2-D line intersection (pixel space). Point p + t*dir. Returns {x,y} or null if parallel. */
function lineIntersectPx(p1x, p1y, d1x, d1y, p2x, p2y, d2x, d2y) {
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((p2x - p1x) * d2y - (p2y - p1y) * d2x) / denom;
  return { x: p1x + t * d1x, y: p1y + t * d1y };
}

/**
 * Build mitered terrace polygon(s) for a set of walls.
 *
 * Groups walls into connected chains (endpoints within 10 px after projection).
 * For each chain:
 * - Single wall → rectangle
 * - Connected chain → mitered polygon with convex corners; bevel join for
 *   concave corners (where the miter would go inside the building) and for
 *   extreme angles (miter > 4× depth away from the junction vertex).
 *
 * Returns an array of pixel-space polygon vertex arrays (one per chain).
 */
function terracePolygons(v, walls, depthPx) {
  if (!walls.length) return [];

  const enriched = walls.map(wall => {
    const pa = map.project([wall.aLng, wall.aLat]);
    const pb = map.project([wall.bLng, wall.bLat]);
    const { normX, normY } = wallOutwardNormal(v, wall);
    return { wall, pa, pb, normX, normY };
  });

  // Group into connected chains — 10 px threshold handles projection rounding
  const THRESH = 10;
  const used   = new Array(enriched.length).fill(false);
  const chains = [];

  for (let start = 0; start < enriched.length; start++) {
    if (used[start]) continue;
    const chain = [enriched[start]];
    used[start] = true;

    for (let pass = 0; pass < 2; pass++) {  // 0 = extend tail, 1 = extend head
      let grew = true;
      while (grew) {
        grew = false;
        const anchor   = pass === 0 ? chain[chain.length - 1] : chain[0];
        const anchorPt = pass === 0 ? anchor.pb : anchor.pa;
        for (let i = 0; i < enriched.length; i++) {
          if (used[i]) continue;
          const d = enriched[i];
          let item = null;
          if (Math.hypot(d.pa.x - anchorPt.x, d.pa.y - anchorPt.y) < THRESH) {
            item = d;
          } else if (Math.hypot(d.pb.x - anchorPt.x, d.pb.y - anchorPt.y) < THRESH) {
            item = { ...d, pa: d.pb, pb: d.pa };  // reversed orientation
          }
          if (item) {
            pass === 0 ? chain.push(item) : chain.unshift(item);
            used[i] = true; grew = true; break;
          }
        }
      }
    }
    chains.push(chain);
  }

  // Build polygon for each chain
  return chains.map(chain => {
    const inner = [];
    const outer = [];

    chain.forEach((item, i) => {
      const { pa, pb, normX, normY } = item;
      const oA = { x: pa.x + normX * depthPx, y: pa.y + normY * depthPx };
      const oB = { x: pb.x + normX * depthPx, y: pb.y + normY * depthPx };

      if (i === 0) inner.push(pa);
      inner.push(pb);
      if (i === 0) outer.push(oA);

      if (i < chain.length - 1) {
        const nx  = chain[i + 1];
        const noA = { x: nx.pa.x + nx.normX * depthPx, y: nx.pa.y + nx.normY * depthPx };
        const miter = lineIntersectPx(
          oB.x, oB.y, pb.x - pa.x, pb.y - pa.y,
          noA.x, noA.y, nx.pb.x - nx.pa.x, nx.pb.y - nx.pa.y,
        );

        let useMiter = false;
        if (miter) {
          // Only use the miter if it's on the outward side of the junction vertex
          // (both normals agree) — this rejects concave corners where the miter
          // would fall inside the building.
          const dx = miter.x - pb.x, dy = miter.y - pb.y;
          const outward1 = dx * normX        + dy * normY;
          const outward2 = dx * nx.normX     + dy * nx.normY;
          const dist     = Math.hypot(dx, dy);
          useMiter = outward1 >= 0 && outward2 >= 0 && dist <= depthPx * 4;
        }

        if (useMiter) {
          outer.push(miter);
        } else {
          // Bevel join: emit both outer endpoints at the corner
          outer.push(oB);
          outer.push(noA);
        }
      } else {
        outer.push(oB);
      }
    });

    return [...inner, ...outer.reverse()];
  });
}

/**
 * Given a bearing (compass degrees) and distance in metres, return the lat/lng
 * delta to add to a reference point.
 */
function meterOffsetDeg(lat, bearingDeg, meters) {
  const br = bearingDeg * RAD;
  return {
    dLat: Math.cos(br) * meters / 111320,
    dLng: Math.sin(br) * meters / (111320 * Math.cos(lat * RAD)),
  };
}

/**
 * Draw terrace footprints for all visible venues at zoom >= 14.
 * - Venues with wallSegment: a rectangle (wall edge + TERRACE_DEPTH_M outward).
 * - Venues without: a fan sector centred on the facing direction.
 * Warm tint = in sun, cool tint = in shade.
 */
function drawSeatingAreas() {
  if (!currentSun) return;
  const zoom = map.getZoom();
  if (zoom < 14) return;
  const bounds = map.getBounds();
  const { az, alt } = currentSun;

  ctx.save();

  VENUES.forEach(v => {
    if (!bounds.contains([v.lng, v.lat])) return;
    if (!shouldShowAtZoom(v, zoom)) return;

    const sunny = venueSunState(v, az, alt);
    const fillSunny   = 'rgba(255,184,0,0.20)';
    const strokeSunny = 'rgba(255,184,0,0.65)';
    const fillShade   = 'rgba(40,80,180,0.13)';
    const strokeShade = 'rgba(80,130,220,0.35)';

    const depth = getEffectiveDepth(v);
    const walls = getTerraceWalls(v);

    if (walls.length > 0 && walls[0].aLat != null) {
      // Mitered polygon(s) — handles single walls, L-shapes, and multi-wall chains
      const polys = terracePolygons(v, walls, depth * pxPerMetre(v));
      polys.forEach(poly => {
        ctx.beginPath();
        poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle   = sunny ? fillSunny   : fillShade;
        ctx.fill();
        ctx.strokeStyle = sunny ? strokeSunny : strokeShade;
        ctx.lineWidth   = 1.5; ctx.setLineDash([]); ctx.stroke();
      });
    } else {
      // Fan fallback: sector in the facing direction
      const pt  = map.project([v.lng, v.lat]);
      const ref = map.project([v.lng, v.lat + depth / 111320]);
      const pxR = Math.max(12, Math.abs(pt.y - ref.y));
      const dir = (v.facing - 90) * RAD;
      const hw  = 40 * RAD;

      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.arc(pt.x, pt.y, pxR, dir - hw, dir + hw);
      ctx.closePath();
      ctx.fillStyle   = sunny ? fillSunny   : fillShade;
      ctx.fill();
      ctx.strokeStyle = sunny ? strokeSunny : strokeShade;
      ctx.lineWidth   = 1;
      ctx.stroke();
    }
  });

  ctx.restore();
}

// ── Shadow overlay ────────────────────────────────────────────────────────────
/**
 * For the selected venue: draw nearby building footprints, their cast shadows,
 * and a probe dot 2 m in front of the terrace wall (yellow = sun, blue = shade).
 */
function drawShadowOverlay(venue) {
  if (!venue.nearbyBuildings?.length || !currentSun) return;
  const { az, alt } = currentSun;
  if (alt < 2) return;

  const tanAlt = Math.tan(alt * RAD);
  if (tanAlt <= 0) return;

  // Probe point (same as venueSunState)
  let testLat = venue.lat, testLng = venue.lng;
  if (venue.wallSegment) {
    const br = venue.wallSegment.bearing * RAD;
    const wy = venue.wallSegment.my;
    testLat = wy + Math.cos(br) * 2 / 111320;
    testLng = venue.wallSegment.mx + Math.sin(br) * 2 / (111320 * Math.cos(wy * RAD));
  }

  // Only visualise buildings within 80 m — beyond that shadows rarely matter visually
  const vizThresh = 80 / 111320;

  ctx.save();

  for (const b of venue.nearbyBuildings) {
    const { geometry: nodes, height } = b;
    if (!nodes || nodes.length < 3 || height <= 0) continue;

    const avgLat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
    const avgLon = nodes.reduce((s, n) => s + n.lon, 0) / nodes.length;
    if (Math.hypot(avgLat - venue.lat, avgLon - venue.lng) > vizThresh) continue;

    const dLat = -Math.cos(az * RAD) / (tanAlt * 111320);
    const dLon = -Math.sin(az * RAD) / (tanAlt * 111320 * Math.cos(avgLat * RAD));

    const casting = pointInBuildingShadow(testLat, testLng, b, az, alt);

    // Convert footprint + shadow nodes to pixel space
    const footPx   = nodes.map(n => { const p = map.project([n.lon, n.lat]); return { x: p.x, y: p.y }; });
    const shadowPx = nodes.map(n => {
      const p = map.project([n.lon + height * dLon, n.lat + height * dLat]);
      return { x: p.x, y: p.y };
    });

    // Unified shadow shape = convex hull of footprint + shadow vertices
    const hull = convexHull([...footPx, ...shadowPx]);

    if (casting) {
      // Full unified shadow
      ctx.beginPath();
      hull.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(10,14,40,0.40)';
      ctx.fill();

      // Building footprint filled on top — distinct from shadow lobe
      ctx.beginPath();
      footPx.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(50,60,120,0.58)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,150,255,0.65)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // Non-casting building — subtle outline only
      ctx.beginPath();
      footPx.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(100,120,180,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Probe dot — 2 m in front of the terrace wall
  if (venue.wallSegment) {
    const br = venue.wallSegment.bearing * RAD;
    const wy = venue.wallSegment.my;
    const tLat = wy + Math.cos(br) * 2 / 111320;
    const tLng = venue.wallSegment.mx + Math.sin(br) * 2 / (111320 * Math.cos(wy * RAD));
    const pt = map.project([tLng, tLat]);
    const sunny = venueSunState(venue, az, alt);

    const glow = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, 13);
    glow.addColorStop(0, sunny ? 'rgba(255,184,0,0.5)' : 'rgba(100,130,210,0.45)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = glow; ctx.fill();

    ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = sunny ? '#FFB800' : '#6080C8'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.restore();
}

// ── Zoom-based pin density ────────────────────────────────────────────────────
// At low zoom levels only high-rated venues are shown to prevent an unreadable
// mass of overlapping pins. Thresholds are calibrated for Oslo city scale.
// zoom >= 13 (neighbourhood): show all
// zoom 11–12 (district):      rating >= 4.3
// zoom < 11  (city-wide):     rating >= 4.5
function shouldShowAtZoom(v, zoom) {
  if (zoom >= 13) return true;
  if (zoom >= 11) return v.rating >= 4.3;
  return v.rating >= 4.5;
}

// ── Pin layout: anti-overlap via variable stem, dot fallback ──────────────────
// Each pin tries increasing stem heights until it clears all higher-priority
// pills. If no stem works it degrades to a small dot. Sorting by relevance
// (sunny > soon > shaded, then by sun score) means important venues always
// keep their preferred position.
const MAX_STEM_H = 80;    // max extended stem before pin becomes a dot
const STEM_STEP  = 14;    // stem extension increment (px)
const DOT_R      = 4.5;   // dot radius (px)
const PILL_GAP   = 8;     // min gap between pill bounding boxes (px)
const DOT_FADE_MS = 240;  // pill↔dot morph duration

let _lastLayout = [];             // [{v, pt, state, stemH, isDot, spr, drawStemH}] per frame
let _hoverClearTimer = null;     // debounce timer for clearing hover state
const _pinWasDot    = new Map();  // id → bool — was this pin a dot last frame
const _pinDotFade   = new Map();  // id → {fromDot, start} — active morph animations
const _pinAnimStemH = new Map();  // id → animated stem height (px, float) for smooth transitions

/**
 * Assigns each venue a stem height (or isDot flag). Greedy by priority:
 * high-relevance venues get the preferred height, lower ones get bumped up
 * or collapsed to a dot when no stem height avoids overlap.
 */
function computePinLayout(projVenues, currentHour, dateStr) {
  const PRI = { sunny: 0, soon: 1, shaded: 2, closed: 3 };
  const sorted = [...projVenues].sort((a, b) => {
    // Hovered venue is processed last so it can claim the highest available position
    if (a.v.id === hoveredId) return 1;
    if (b.v.id === hoveredId) return -1;
    const pd = PRI[a.state] - PRI[b.state];
    if (pd !== 0) return pd;
    // Tie-break within same state: non-open venues by time until opening (sooner = higher priority);
    // open venues (sunny/shaded) by sun score (higher = higher priority)
    if (a.state === 'soon' || a.state === 'closed') {
      const openA = a.v.openingHours?.open ?? Infinity;
      const openB = b.v.openingHours?.open ?? Infinity;
      const waitA = openA > currentHour ? openA - currentHour : Infinity;
      const waitB = openB > currentHour ? openB - currentHour : Infinity;
      return waitA - waitB;  // less wait = lower value = sorts first
    }
    try {
      const sa = typeof sunScore === 'function' ? (sunScore(a.v, dateStr, currentHour) ?? 0) : (a.v.rating ?? 0);
      const sb = typeof sunScore === 'function' ? (sunScore(b.v, dateStr, currentHour) ?? 0) : (b.v.rating ?? 0);
      return sb - sa;
    } catch { return 0; }
  });

  const placed = [];   // committed pill rects {rx,ry,rw,rh}
  const result = [];

  for (const { v, pt, state } of sorted) {
    const selected = v.id === selectedId;
    const isHover  = v.id === hoveredId;
    const spr = getSprite(v, state, selected, currentHour, dateStr);
    const rw  = spr.canvas.width;
    const rh  = spr.canvas.height - STEM_H;  // pill area (excludes baked stem)

    let resolved = false;
    // Hovered venue: search from tallest stem downward so it sits highest among neighbours.
    // All other venues: search from shortest stem upward (normal greedy placement).
    const stemMin  = STEM_H;
    const stemMax  = MAX_STEM_H;
    const stemDir  = isHover ? -STEM_STEP : STEM_STEP;
    const stemStart = isHover ? stemMax : stemMin;
    for (let stemH = stemStart; isHover ? stemH >= stemMin : stemH <= stemMax; stemH += stemDir) {
      const extraStem = stemH - STEM_H;
      const rx = pt.x - spr.anchorX;
      const ry = pt.y - spr.anchorY - extraStem;
      const clear = placed.every(p =>
        rx + rw + PILL_GAP <= p.rx || p.rx + p.rw + PILL_GAP <= rx ||
        ry + rh + PILL_GAP <= p.ry || p.ry + p.rh + PILL_GAP <= ry
      );
      if (clear) {
        placed.push({ rx, ry, rw, rh });
        result.push({ v, pt, state, stemH, isDot: false, spr });
        resolved = true;
        break;
      }
    }
    // Hovered venue never degrades to dot; others do if no stem height works
    if (!resolved) result.push({ v, pt, state, stemH: isHover ? stemMin : STEM_H, isDot: !isHover, spr });
  }

  return result;
}

function _drawExtStem(pt, extraStem, state) {
  const col = state === 'sunny' ? '#FFB800' :
              state === 'soon'  ? 'rgba(255,184,0,0.70)' :
                                  'rgba(150,132,110,0.78)';
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - extraStem);
  ctx.lineTo(pt.x, pt.y);
  if (state === 'soon') ctx.setLineDash([3, 3]);
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  // Anchor dot at map point
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill();
}

function _drawDotHover(pt, state) {
  const isSunny = state === 'sunny', isSoon = state === 'soon';
  ctx.save();
  // Outer glow ring
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 6, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? 'rgba(255,184,0,0.22)' : isSoon ? 'rgba(255,184,0,0.16)' : 'rgba(120,150,220,0.18)';
  ctx.fill();
  // Enlarged dot
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? '#FFB800' : isSoon ? 'rgba(255,184,0,0.9)' : 'rgba(120,150,200,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function _drawDot(pt, state) {
  const isSunny = state === 'sunny', isSoon = state === 'soon';
  ctx.save();
  ctx.globalAlpha = isSunny ? 0.9 : isSoon ? 0.7 : 0.4;
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? 'rgba(255,184,0,0.18)' : isSoon ? 'rgba(255,184,0,0.12)' : 'rgba(100,120,180,0.12)';
  ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? '#FFB800' : isSoon ? 'rgba(255,184,0,0.8)' : 'rgba(100,120,170,0.65)';
  ctx.fill();
  ctx.restore();
}

// ── Map pan helper ────────────────────────────────────────────────────────────
/**
 * Pan so the venue pin appears centred in the visible area (accounting for
 * the detail sidebar on desktop).
 */
function panToVenueCenter(v) {
  const isMobile = window.innerWidth < 768;
  const panel    = document.getElementById('detail-panel');
  // Use layout position (unaffected by CSS transform during open animation)
  const padLeft  = (!isMobile && panel && panel.classList.contains('open'))
    ? (panel.offsetLeft + panel.offsetWidth) : 0;

  const targetBearing = (v.facing + 180) % 360;
  const curBearing    = ((map.getBearing() % 360) + 360) % 360;
  let   diff          = Math.abs(targetBearing - curBearing);
  if (diff > 180) diff = 360 - diff;

  const opts = {
    center:   [v.lng, v.lat],
    zoom:     Math.max(map.getZoom(), 15),
    pitch:    45,
    padding:  { left: padLeft, right: 0, top: 60, bottom: 0 },
    duration: 480,
  };
  if (diff > 90) opts.bearing = targetBearing;
  map.easeTo(opts);
}

// ── Main draw ─────────────────────────────────────────────────────────────────

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  if (!currentSun) { ctx.restore(); return; }
  const now            = performance.now();
  let   needsAnimFrame = false;

  if (editingVenueId) {
    const editHour    = parseFloat(timeFromEl.value);
    const editDateStr = datePicker.value;
    ctx.globalAlpha = 0.18;
    VENUES.forEach(v => {
      const { open, close } = v.openingHours;
      const isOpen = editHour >= open && editHour <= close;
      const state  = isOpen
        ? (venueSunState(v, currentSun.az, currentSun.alt) ? 'sunny' : 'shaded')
        : 'closed';
      const pt  = map.project([v.lng, v.lat]);
      const spr = getSprite(v, state, false, editHour, editDateStr);
      ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY);
    });
    ctx.globalAlpha = 1;
    drawBuildingEditor();
    ctx.restore();
    return;
  }

  const bounds = map.getBounds();
  const zoom   = map.getZoom();
  let hiddenCount = 0;

  drawSeatingAreas();
  if (selectedId) {
    const sel = VENUES.find(v => v.id === selectedId);
    if (sel) drawShadowOverlay(sel);
  }

  const currentHour = parseFloat(timeFromEl.value);
  const dateStr     = datePicker.value;

  // Project + compute draw-state for all visible venues
  const projVenues = [];
  VENUES.forEach(v => {
    if (!bounds.contains([v.lng, v.lat])) return;
    if (!shouldShowAtZoom(v, zoom)) { hiddenCount++; return; }
    const { open, close } = v.openingHours;
    const isOpen        = currentHour >= open && currentHour <= close;
    const isOpeningSoon = !isOpen && (open - currentHour) > 0 && (open - currentHour) <= 0.75;
    let state;
    if (isOpen)             state = venueSunState(v, currentSun.az, currentSun.alt) ? 'sunny' : 'shaded';
    else if (isOpeningSoon) state = 'soon';
    else                    state = 'closed';
    projVenues.push({ v, state, pt: map.project([v.lng, v.lat]) });
  });

  // Compute anti-overlap layout before drawing (hover glow needs stemH too)
  _lastLayout = computePinLayout(projVenues, currentHour, dateStr);

  // Smooth stem height transitions — lerp each pin toward its target stemH
  let stemAnimDirty = false;
  for (const entry of _lastLayout) {
    if (entry.isDot) { _pinAnimStemH.delete(entry.v.id); entry.drawStemH = STEM_H; continue; }
    const target  = entry.stemH;
    const current = _pinAnimStemH.get(entry.v.id) ?? target;
    if (Math.abs(current - target) < 0.5) {
      _pinAnimStemH.set(entry.v.id, target);
      entry.drawStemH = target;
    } else {
      const next = current + (target - current) * 0.14;
      _pinAnimStemH.set(entry.v.id, next);
      entry.drawStemH = next;
      stemAnimDirty = true;
    }
  }
  if (stemAnimDirty) needsAnimFrame = true;

  // Draw pins from layout — two passes so pills always sit above all stems
  const visibleVenues = [];

  // Pre-scan: register dot↔pill transitions before any drawing
  for (const { v, isDot } of _lastLayout) {
    const wasDot = _pinWasDot.get(v.id);
    if (wasDot !== undefined && wasDot !== isDot) _pinDotFade.set(v.id, { fromDot: wasDot, start: now });
    _pinWasDot.set(v.id, isDot);
  }

  // Pass 1 — extended stems only (all stems drawn before any pill)
  for (const entry of _lastLayout) {
    const { v, pt, state, isDot } = entry;
    if (isDot || _pinDotFade.has(v.id)) continue;
    const extraStem = (entry.drawStemH ?? entry.stemH) - STEM_H;
    if (extraStem > 0) _drawExtStem(pt, extraStem, state);
  }

  // Pass 2 — morph animations, dots, pills (on top of all stems)
  for (const entry of _lastLayout) {
    const { v, pt, state, stemH, isDot, spr } = entry;
    const extraStem = (entry.drawStemH ?? stemH) - STEM_H;

    // Morph animation (handles its own ext stem so z-order is preserved within it)
    const morphFade = _pinDotFade.get(v.id);
    if (morphFade) {
      const t = Math.min(1, (now - morphFade.start) / DOT_FADE_MS);
      if (t >= 1) { _pinDotFade.delete(v.id); }
      else {
        needsAnimFrame = true;
        ctx.save();
        if (morphFade.fromDot) {
          ctx.globalAlpha = 1 - t; _drawDot(pt, state);
          ctx.globalAlpha = t;
          if (extraStem > 0) _drawExtStem(pt, extraStem, state);
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem);
        } else {
          ctx.globalAlpha = 1 - t;
          if (extraStem > 0) _drawExtStem(pt, extraStem, state);
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem);
          ctx.globalAlpha = t; _drawDot(pt, state);
        }
        ctx.restore();
        continue;
      }
    }

    if (isDot) {
      if (state !== 'closed') {
        if (v.id === hoveredId) _drawDotHover(pt, state);
        else _drawDot(pt, state);
      }
      continue;
    }

    // State-change fade
    const prevState = _pinPrevState.get(v.id);
    if (prevState !== undefined && prevState !== state) _pinFadeStart.set(v.id, now);
    _pinPrevState.set(v.id, state);
    let pinAlpha = 1;
    const fs = _pinFadeStart.get(v.id);
    if (fs !== undefined) {
      const t = Math.min(1, (now - fs) / PIN_FADE_MS);
      pinAlpha = t;
      if (t >= 1) _pinFadeStart.delete(v.id);
      else needsAnimFrame = true;
    }

    const isHovered = v.id === hoveredId;
    const rp = (v.id === selectedId ? 4 : 2) + 1;
    const sprLeft = pt.x - spr.anchorX;
    const sprTop  = pt.y - spr.anchorY - extraStem;

    ctx.save();
    if (pinAlpha < 1) ctx.globalAlpha = pinAlpha;

    // Hover: bright outline ring peeking outside the pill edges
    if (isHovered) {
      const pillW = spr.canvas.width - rp * 2 - 2;
      ctx.beginPath();
      ctx.roundRect(sprLeft + rp - 3.5, sprTop + rp - 3.5, pillW + 7, PILL_H + 7, PILL_R + 3.5);
      ctx.strokeStyle = state === 'sunny' ? 'rgba(255,220,100,0.7)' :
                        state === 'soon'  ? 'rgba(255,200,80,0.6)'  :
                                            'rgba(200,190,175,0.45)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.drawImage(spr.canvas, sprLeft, sprTop);
    ctx.restore();
    if (state !== 'closed') visibleVenues.push(entry);
  }

  // Hint when venues are hidden due to zoom density
  if (hiddenCount > 0) {
    const text = `Zoom in to see ${hiddenCount} more venue${hiddenCount > 1 ? 's' : ''}`;
    ctx.font = '11px "Inter", sans-serif';
    const tw = ctx.measureText(text).width;
    const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
    const pw = tw + 16, ph = 22, px = (cssW - pw) / 2, py = cssH - 36;
    ctx.fillStyle = 'rgba(16,22,38,0.82)';
    fillRoundRect(ctx, px, py, pw, ph, 11);
    ctx.fillStyle = 'rgba(240,230,211,0.7)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cssW / 2, py + ph / 2);
  }

  if (needsAnimFrame) _scheduleAnimFrame();
  ctx.restore();
}


// ── Hit testing ───────────────────────────────────────────────────────────────
function hitTestVenue(cx, cy) {
  // Use layout for accurate pill bounds (variable stem heights)
  for (const entry of _lastLayout) {
    const { v, pt, isDot, spr, stemH } = entry;
    if (isDot) continue;
    const extraStem = (entry.drawStemH ?? stemH) - STEM_H;
    const rx = pt.x - spr.anchorX - 4;
    const ry = pt.y - spr.anchorY - extraStem - 4;
    const rw = spr.canvas.width + 8;
    const rh = spr.canvas.height - STEM_H + 8;
    if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) return v;
  }
  return null;
}

function hitTestDot(cx, cy) {
  for (const { v, pt, isDot, state } of _lastLayout) {
    if (!isDot || state === 'closed') continue;
    if (Math.hypot(cx - pt.x, cy - pt.y) <= DOT_R + 8) return v;
  }
  return null;
}

function hitTestDepthHandle(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return null;
  const walls  = getTerraceWalls(v);
  const depth  = getEffectiveDepth(v);
  const pxPerM = pxPerMetre(v);
  for (const wall of walls) {
    const { normX, normY, mx, my } = wallOutwardNormal(v, wall);
    const hx = mx + normX * depth * pxPerM;
    const hy = my + normY * depth * pxPerM;
    if (Math.hypot(cx - hx, cy - hy) <= 14) return wall;
  }
  return null;
}

function hitTestWall(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v?.wallNormals) return null;
  let bestIdx = null, bestDistSq = 100;
  v.wallNormals.forEach((wall, idx) => {
    const pa = map.project([wall.aLng, wall.aLat]);
    const pb = map.project([wall.bLng, wall.bLat]);
    const dSq = distPointToSegmentSq(cx, cy, pa.x, pa.y, pb.x, pb.y);
    if (dSq < bestDistSq) { bestDistSq = dSq; bestIdx = idx; }
  });
  return bestIdx;
}

// ── Canvas event handling ─────────────────────────────────────────────────────
canvas.style.pointerEvents = 'auto';

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    // Depth handle drag takes priority — don't forward to map
    const handle = hitTestDepthHandle(cx, cy);
    if (handle) {
      editDraggingDepth = true;
      editDragWallObj   = handle;
      canvas.style.cursor = 'row-resize';
      return;
    }
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) {
      const editOverlay = document.getElementById('edit-overlay');
      if (editOverlay && editOverlay.contains(el)) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        el.dispatchEvent(new MouseEvent('mousedown', e));
      }
    }
    return;
  }
  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (!hit) {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new MouseEvent('mousedown', e));
  }
});

canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    const wallIdx = hitTestWall(cx, cy);
    if (wallIdx !== null) selectWallByIdx(wallIdx);
    return;
  }
  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    selectVenue(hit.id, false);
    panToVenueCenter(hit);
    return;
  }
  // Clicked empty map — close detail panel / deselect
  if (selectedId !== null) {
    closeDetailPanel();
  }
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;

  if (editingVenueId) {
    tooltip.classList.remove('visible');

    // Depth drag in progress
    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
        const walls = getTerraceWalls(v);
        const wallsLabel = walls.length > 1 ? ` · ${walls.length} walls` : '';
        document.getElementById('edit-facing-display').innerHTML =
          `${v.facing}° ${bearingToCardinal(v.facing)}${wallsLabel} · <span style="color:#64ffb4">${Math.round(getEffectiveDepth(v))}m depth</span>`;
      }
      return;
    }

    const handle = hitTestDepthHandle(cx, cy);
    if (handle) { canvas.style.cursor = 'row-resize'; return; }

    const wallIdx = hitTestWall(cx, cy);
    canvas.style.cursor = wallIdx !== null ? 'pointer' : 'default';
    if (wallIdx !== editHoveredWallIdx) {
      editHoveredWallIdx = wallIdx;
      draw();
      const v  = VENUES.find(x => x.id === editingVenueId);
      const el = document.getElementById('edit-facing-display');
      if (wallIdx !== null && v?.wallNormals) {
        const wall = v.wallNormals[wallIdx];
        const sel  = v.terraceWallIndices?.includes(wallIdx) ? ' ✓' : '';
        el.innerHTML = `<span class="preview">${Math.round(wall.bearing)}° ${bearingToCardinal(wall.bearing)}${sel}</span>`;
      } else if (v) {
        const walls = getTerraceWalls(v);
        const wallsLabel = walls.length > 1 ? ` · ${walls.length} walls` : '';
        el.innerHTML = `${v.facing}° ${bearingToCardinal(v.facing)}${wallsLabel}`;
      }
    }
    return;
  }

  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    // Cancel any pending clear — we're over a venue
    if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
    canvas.style.cursor = 'pointer';
    if (hoveredId !== hit.id) { hoveredId = hit.id; draw(); }
    tooltip.innerHTML = buildTooltipContent(hit);
    const margin = 14;
    let tx = e.clientX + margin, ty = e.clientY - tooltip.offsetHeight - margin;
    if (tx + tooltip.offsetWidth > window.innerWidth - 20) tx = e.clientX - tooltip.offsetWidth - margin;
    if (ty < 8) ty = e.clientY + margin;
    tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    tooltip.classList.add('visible');
  } else {
    // Debounce clearing so adjacent pins don't jitter when cursor moves between them
    if (hoveredId !== null && !_hoverClearTimer) {
      _hoverClearTimer = setTimeout(() => {
        _hoverClearTimer = null;
        hoveredId = null;
        draw();
        canvas.style.cursor = 'default';
        tooltip.classList.remove('visible');
      }, 80);
    } else if (hoveredId === null) {
      canvas.style.cursor = 'default';
      tooltip.classList.remove('visible');
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
  if (hoveredId !== null) { hoveredId = null; draw(); }
  tooltip.classList.remove('visible');
  if (!editDraggingDepth) canvas.style.cursor = 'default';
});

window.addEventListener('mouseup', () => {
  if (editDraggingDepth) {
    editDraggingDepth = false;
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth);
    editDragWallObj = null;
    canvas.style.cursor = 'default';
  }
});

['wheel', 'touchstart', 'touchmove', 'touchend'].forEach(type => {
  canvas.addEventListener(type, e => {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX || e.touches?.[0]?.clientX, e.clientY || e.touches?.[0]?.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new (e.constructor)(type, e));
  }, { passive: true });
});
