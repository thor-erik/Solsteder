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
    stemColor   = 'rgba(255,184,0,0.45)';
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
    stemColor   = 'rgba(81,69,50,0.5)';
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
  c.lineWidth   = 1.5;
  c.stroke();
  c.setLineDash([]);

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
  const PAD_X = 20, PAD_T = 20, PAD_B = 12;
  const cw = cssW, ch = cssH;
  const dateStr = datePicker.value;

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

  // Horizon line
  c.beginPath();
  c.moveTo(PAD_X, horizY); c.lineTo(cw - PAD_X, horizY);
  c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 1; c.stroke();

  // Build above-horizon segment
  const above = samples.filter(s => s.alt > 0);
  if (above.length > 1) {
    // 1 — Golden arc fill
    const grad = c.createLinearGradient(0, PAD_T, 0, horizY);
    grad.addColorStop(0, 'rgba(255,184,0,0.28)');
    grad.addColorStop(1, 'rgba(255,184,0,0.04)');
    c.beginPath();
    c.moveTo(timeToX(above[0].t), horizY);
    above.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
    c.lineTo(timeToX(above[above.length - 1].t), horizY);
    c.closePath();
    c.fillStyle = grad; c.fill();

    // 2 — Cloud cover overlay clipped to the arc shape
    //     Grey bands proportional to cloud fraction, only where sun is above horizon.
    //     Draw order: fill first, clouds on top, then the arc stroke over everything.
    if (typeof getWeatherAt === 'function') {
      c.save();
      // Clip to the arc polygon so cloud rects don't spill outside the arc
      c.beginPath();
      c.moveTo(timeToX(above[0].t), horizY);
      above.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
      c.lineTo(timeToX(above[above.length - 1].t), horizY);
      c.closePath();
      c.clip();

      for (let t = MIN_H; t < MAX_H; t++) {
        const wx = getWeatherAt(dateStr, t);
        if (!wx || wx.cloud < 0.15) continue;
        const x1 = timeToX(t), x2 = timeToX(t + 1);
        // Alpha scales with cloud fraction: 0.15 cloud → barely visible; 1.0 → opaque grey
        const alpha = Math.min(0.85, wx.cloud * 0.72);
        c.fillStyle = `rgba(105,120,148,${alpha.toFixed(2)})`;
        c.fillRect(x1, PAD_T, x2 - x1, horizY - PAD_T);
      }
      c.restore();
    }

    // 3 — Arc stroke drawn on top of cloud overlay so the golden outline stays crisp
    c.beginPath();
    c.moveTo(timeToX(above[0].t), altToY(above[0].alt));
    above.forEach(s => c.lineTo(timeToX(s.t), altToY(s.alt)));
    c.strokeStyle = 'rgba(255,184,0,0.9)'; c.lineWidth = 2; c.stroke();
  }

  // Sunrise + sunset ticks only — hover tooltip shows exact time for everything else
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

  // Current time marker — thumb sits on the horizon, drop line + label above
  const fromH = parseFloat(timeFromEl.value);

  // Past-time dim — on today, fade the arc area behind the current time
  if (dateStr === todayStr() && fromH > MIN_H) {
    const pastX = timeToX(Math.max(MIN_H, Math.min(fromH, MAX_H)));
    const rectW = pastX - PAD_X;
    if (rectW > 2) {
      const fadeGrad = c.createLinearGradient(PAD_X, 0, pastX, 0);
      fadeGrad.addColorStop(0,   'rgba(8,14,25,0.55)');
      fadeGrad.addColorStop(0.75,'rgba(8,14,25,0.3)');
      fadeGrad.addColorStop(1,   'rgba(8,14,25,0)');
      c.save();
      c.fillStyle = fadeGrad;
      c.fillRect(PAD_X, 0, rectW, horizY); // only up to the horizon, not the labels
      c.restore();
    }
  }
  if (fromH >= MIN_H && fromH <= MAX_H) {
    const curSun = getSunFromTable(currentSunTable, fromH);
    const mx    = timeToX(fromH);
    const arcY  = altToY(Math.max(0, curSun.alt)); // position on the arc
    const thumbY = horizY;                          // thumb always at baseline
    const isSun = curSun.alt > 0;

    // Dashed drop line from arc down to horizon
    c.beginPath(); c.moveTo(mx, arcY + 4); c.lineTo(mx, thumbY - 8);
    c.strokeStyle = 'rgba(255,255,255,0.15)'; c.lineWidth = 1;
    c.setLineDash([2, 4]); c.stroke(); c.setLineDash([]);

    // Outer glow at thumb (horizon)
    const glow = c.createRadialGradient(mx, thumbY, 0, mx, thumbY, 16);
    glow.addColorStop(0, isSun ? 'rgba(255,184,0,0.4)' : 'rgba(100,130,200,0.28)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    c.beginPath(); c.arc(mx, thumbY, 16, 0, Math.PI * 2);
    c.fillStyle = glow; c.fill();

    // Thumb circle at horizon
    c.beginPath(); c.arc(mx, thumbY, 6, 0, Math.PI * 2);
    c.fillStyle = isSun ? '#FFB800' : '#6080C8'; c.fill();
    c.beginPath(); c.arc(mx, thumbY, 6, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 1.5; c.stroke();
    c.beginPath(); c.arc(mx, thumbY, 2, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,0.9)'; c.fill();

    // Time label pill — above the arc position
    const thumbText = formatHour(fromH);
    const _tmp = document.createElement('canvas').getContext('2d');
    _tmp.font = 'bold 12px "Inter", sans-serif';
    const tlw = _tmp.measureText(thumbText).width + 14, tlh = 18;
    const tlx = Math.max(tlw / 2 + 4, Math.min(cw - tlw / 2 - 4, mx));
    const tly = Math.max(2, arcY - 10 - tlh);
    c.beginPath(); c.roundRect(tlx - tlw / 2, tly, tlw, tlh, 6);
    c.fillStyle = 'rgba(8,14,25,0.92)'; c.fill();
    c.strokeStyle = 'rgba(255,184,0,0.6)'; c.lineWidth = 1; c.stroke();
    c.font = 'bold 12px "Inter", sans-serif';
    c.fillStyle = '#FFB800'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(thumbText, tlx, tly + tlh / 2);
  }

  // Hover scrub indicator
  if (typeof arcHoverH === 'number') {
    const hx = timeToX(arcHoverH);
    // Vertical dashed line
    c.beginPath(); c.moveTo(hx, PAD_T); c.lineTo(hx, horizY + 2);
    c.strokeStyle = 'rgba(213,196,171,0.35)'; c.lineWidth = 1;
    c.setLineDash([2, 3]); c.stroke(); c.setLineDash([]);
    // Small circle on arc
    const hoverSun = getSunFromTable(currentSunTable, arcHoverH);
    const hy = altToY(Math.max(0, hoverSun.alt));
    c.beginPath(); c.arc(hx, hy, 3, 0, Math.PI * 2);
    c.fillStyle = 'rgba(213,196,171,0.7)'; c.fill();

    // Hover label pill — time + temp + wind at top of canvas
    const wx = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, arcHoverH) : null;
    let hoverText = formatHour(arcHoverH);
    let windArrow = '';
    if (wx) {
      // Arrow points direction wind travels toward (opposite of "from")
      const _arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
      windArrow = _arrows[Math.round(((wx.wdir + 180) % 360) / 45) % 8];
      hoverText += `   ${wx.temp}°   ${windArrow} ${Math.round(wx.wspd)} m/s`;
    }
    const _tmp2 = document.createElement('canvas').getContext('2d');
    _tmp2.font = '600 12px "Inter", sans-serif';
    const hlw = _tmp2.measureText(hoverText).width + 16, hlh = 20;
    const hlx = Math.max(hlw / 2 + 4, Math.min(cw - hlw / 2 - 4, hx));
    c.beginPath(); c.roundRect(hlx - hlw / 2, 1, hlw, hlh, 6);
    c.fillStyle = 'rgba(8,14,25,0.94)'; c.fill();
    c.strokeStyle = 'rgba(213,196,171,0.2)'; c.lineWidth = 1; c.stroke();
    c.font = '600 12px "Inter", sans-serif';
    c.fillStyle = 'rgba(213,196,171,0.95)'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(hoverText, hlx, 1 + hlh / 2);
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

// ── Pin clustering ────────────────────────────────────────────────────────────
// Below CLUSTER_ZOOM, nearby pins are grouped into bubble clusters to avoid
// an unreadable mass of overlapping pills. Clusters are clickable — they zoom
// in to the bounding box of the member venues.
const CLUSTER_ZOOM = 13.0;
const CLUSTER_PX   = 52;   // screen-space radius threshold (pixels)
let _lastClusters  = [];   // [{cx, cy, r, venues}] — populated each draw

function computeClusters(projVenues) {
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < projVenues.length; i++) {
    if (used.has(i)) continue;
    const seed    = projVenues[i];
    const members = [seed];
    used.add(i);
    for (let j = i + 1; j < projVenues.length; j++) {
      if (used.has(j)) continue;
      if (Math.hypot(projVenues[j].pt.x - seed.pt.x, projVenues[j].pt.y - seed.pt.y) < CLUSTER_PX) {
        members.push(projVenues[j]);
        used.add(j);
      }
    }
    clusters.push(members);
  }
  return clusters;
}

function drawClusterBubble(cx, cy, count, sunnyCount) {
  const r      = count >= 8 ? 20 : count >= 4 ? 17 : 14;
  const isSun  = sunnyCount > 0;

  // Pulse ring
  ctx.beginPath(); ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = isSun ? 'rgba(255,184,0,0.08)' : 'rgba(60,100,200,0.08)'; ctx.fill();

  // Main filled circle
  const grad = ctx.createRadialGradient(cx, cy - r * 0.25, 0, cx, cy, r);
  if (isSun) { grad.addColorStop(0, '#ffd840'); grad.addColorStop(1, '#e09000'); }
  else       { grad.addColorStop(0, '#3868d8'); grad.addColorStop(1, '#1a3880'); }
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = isSun ? 'rgba(255,230,100,0.8)' : 'rgba(110,155,255,0.6)';
  ctx.lineWidth = 1.5; ctx.stroke();

  // Count label
  ctx.font = `bold ${count >= 10 ? 9 : 11}px "Inter", sans-serif`;
  ctx.fillStyle = isSun ? '#1a1a2e' : '#c8d8ff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(count), cx, cy);

  return r + 6;   // total hit radius
}

function hitTestCluster(cx, cy) {
  for (const cl of _lastClusters) {
    if (Math.hypot(cx - cl.cx, cy - cl.cy) <= cl.r) return cl;
  }
  return null;
}

function zoomToCluster(cluster) {
  const lats = cluster.venues.map(v => v.lat);
  const lngs = cluster.venues.map(v => v.lng);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 80, maxZoom: 15, duration: 500 }
  );
}

// ── Main draw ─────────────────────────────────────────────────────────────────

/**
 * Draw a single venue pin with fade animation. Returns true if still animating
 * (caller should schedule another rAF). Pushes to visibleVenues if not closed.
 */
function _drawPin(v, pt, state, currentHour, dateStr, now, visibleVenues) {
  const selected = v.id === selectedId;
  const spr      = getSprite(v, state, selected, currentHour, dateStr);

  const prevState = _pinPrevState.get(v.id);
  if (prevState !== undefined && prevState !== state) _pinFadeStart.set(v.id, now);
  _pinPrevState.set(v.id, state);

  let pinAlpha = 1, animating = false;
  const fs = _pinFadeStart.get(v.id);
  if (fs !== undefined) {
    const t = Math.min(1, (now - fs) / PIN_FADE_MS);
    pinAlpha = t;
    if (t >= 1) _pinFadeStart.delete(v.id);
    else        animating = true;
  }

  ctx.save();
  if (pinAlpha < 1) ctx.globalAlpha = pinAlpha;
  ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY);
  ctx.restore();

  if (state !== 'closed') visibleVenues.push({ v, pt, state, spr });
  return animating;
}

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

  // Hover glow — pill-shaped halo drawn behind pins
  if (hoveredId !== null) {
    const hEntry = projVenues.find(({ v }) => v.id === hoveredId);
    if (hEntry) {
      const { pt, state } = hEntry;
      const pillCx = pt.x;
      const pillCy = pt.y - STEM_H - PILL_H / 2;
      const [r, g, b] = state === 'sunny' ? [255, 190, 0] : state === 'soon' ? [255, 184, 0] : [120, 170, 255];
      // Derive pill width from sprite canvas so glow matches the actual label
      const _hovSpr = getSprite(hEntry.v, state, hEntry.v.id === selectedId, currentHour, dateStr);
      const pillW = _hovSpr ? (_hovSpr.canvas.width - 4) : 60;
      const glowH = PILL_H + 10;  // slightly larger than pill height
      const glowScaleX = (pillW * 0.85) / glowH;
      ctx.save();
      ctx.translate(pillCx, pillCy);
      ctx.scale(glowScaleX, 1);
      const glowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, glowH);
      glowGrad.addColorStop(0,   `rgba(${r},${g},${b},0.42)`);
      glowGrad.addColorStop(0.55,`rgba(${r},${g},${b},0.14)`);
      glowGrad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
      ctx.beginPath();
      ctx.arc(0, 0, glowH, 0, Math.PI * 2);
      ctx.fillStyle = glowGrad;
      ctx.fill();
      ctx.restore();
    }
  }

  // Draw: cluster bubbles at low zoom, individual pins at neighbourhood zoom
  const visibleVenues = [];
  if (zoom < CLUSTER_ZOOM) {
    _lastClusters = [];
    computeClusters(projVenues).forEach(members => {
      if (members.length === 1) {
        const { v, pt, state } = members[0];
        if (_drawPin(v, pt, state, currentHour, dateStr, now, visibleVenues)) needsAnimFrame = true;
      } else {
        const cx = members.reduce((s, m) => s + m.pt.x, 0) / members.length;
        const cy = members.reduce((s, m) => s + m.pt.y, 0) / members.length;
        const sunnyCount = members.filter(m => m.state === 'sunny').length;
        const r = drawClusterBubble(cx, cy, members.length, sunnyCount);
        _lastClusters.push({ cx, cy, r, venues: members.map(m => m.v) });
      }
    });
  } else {
    _lastClusters = [];
    projVenues.forEach(({ v, pt, state }) => {
      if (_drawPin(v, pt, state, currentHour, dateStr, now, visibleVenues)) needsAnimFrame = true;
    });
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
  // Pills sit above the map point. Pill body centre is ~(PILL_TIP + PILL_H/2) above pt.
  // Hit box: ±44 px horizontal, -44..+4 px vertical relative to anchor (stem bottom).
  let hit = null;
  VENUES.forEach(v => {
    const pt = map.project([v.lng, v.lat]);
    if (Math.abs(cx - pt.x) <= 44 && cy >= pt.y - 44 && cy <= pt.y + 4) hit = v;
  });
  return hit;
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
  const hit = hitTestVenue(cx, cy);
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
  const hit = hitTestVenue(cx, cy);
  if (hit) {
    selectVenue(hit.id, true);
    return;
  }
  // Cluster click — zoom to bounding box
  const cluster = hitTestCluster(cx, cy);
  if (cluster) { zoomToCluster(cluster); return; }
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

  // Cluster hover cursor (no tooltip for clusters — user just clicks to zoom in)
  if (hitTestCluster(cx, cy)) {
    canvas.style.cursor = 'zoom-in';
    if (hoveredId !== null) { hoveredId = null; draw(); }
    tooltip.classList.remove('visible');
    return;
  }

  const hit = hitTestVenue(cx, cy);
  if (hit) {
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
    if (hoveredId !== null) { hoveredId = null; draw(); }
    canvas.style.cursor = 'default';
    tooltip.classList.remove('visible');
  }
});

canvas.addEventListener('mouseleave', () => {
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
