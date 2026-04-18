/**
 * render-pins.js — Map pins (sprites, layout, animation), main draw loop,
 *                  hit testing, and canvas event handling.
 * Depends on: map, canvas, ctx, currentSun, selectedId, highlight,
 *             editingVenueId, editHoveredWallIdx, VENUES (app.js / data.js)
 *             venueSunState (solar.js)
 *             computeSunWindows, sunScore, formatHour (app.js / scoring.js)
 *             shortName, fillRoundRect (render-helpers.js)
 *             drawBuildingEditor, editDraggingDepth, editDragWallObj,
 *             _detachedDragging, hitTestDetachedPin, hitTestDepthHandle,
 *             hitTestWall (render-editor.js)
 *             drawSeatingAreas, drawShadowOverlay, shouldShowAtZoom (render-seating.js)
 *             drawSunCurve, drawSunCompass (render-arc.js)
 *             selectVenue, closeDetailPanel, panToVenueCenter,
 *             setDetachedLocation, selectWallByIdx, saveFacingCache (app.js / ui.js)
 *             tooltip, buildTooltipContent (ui.js)
 */

// ── Sprite cache ──────────────────────────────────────────────────────────────
// Pill-shaped pins keyed by (id, state, selected, time-bucket).
// buildSprite returns { canvas, anchorX, anchorY } — anchor is the bottom of
// the stem, placed at the venue's map coordinate; the pill floats above it.
const PILL_H  = 26;   // pill body height px
const PILL_R  = 13;   // pill corner radius (= height/2 → fully rounded)
const STEM_H  = 14;   // thin vertical stem below pill
const spriteCache = new Map();

function _sunRemainingHours(v, dateStr, hour) {
  try {
    const { windows, open, close } = computeSunWindows(v, dateStr);
    for (const w of windows) {
      const wStart = Math.max(w.start, open);
      const wEnd   = Math.min(w.end, close);
      if (hour >= wStart && hour < wEnd) return Math.max(0, wEnd - hour);
    }
  } catch (e) {}
  return 0;
}

function _sunFillFraction(hours) {
  if (hours >= 2.5) return 1.0;
  if (hours >= 1.5) return 0.75;
  if (hours >= 1.0) return 0.50;
  if (hours >= 0.5) return 0.25;
  return 0.0;
}

// Draws the pill shape with a concave circular notch on the right side where
// the icon sits. nCx/nCy is the icon centre; nR is the notch radius (slightly
// larger than the icon so a gap is left between notch edge and icon edge).
function _pillNotchPath(c, ox, oy, pillW, pillH, pillR, nCx, nCy, nR) {
  const rightX   = ox + pillW;
  const topAngle = Math.atan2(oy - nCy, rightX - nCx);
  const botAngle = Math.atan2((oy + pillH) - nCy, rightX - nCx);
  c.beginPath();
  c.moveTo(ox + pillR, oy);
  c.lineTo(rightX, oy);
  // Concave notch: counterclockwise arc curves left (into pill) from top corner to bottom corner
  c.arc(nCx, nCy, nR, topAngle, botAngle, true);
  c.lineTo(ox + pillR, oy + pillH);
  // Left rounded cap: clockwise arc from bottom to top around the left semicircle
  c.arc(ox + pillR, oy + pillH / 2, pillR, Math.PI / 2, -Math.PI / 2, false);
  c.closePath();
}

function _drawSunFillIcon(c, cx, cy, r, fraction) {
  // Dark background circle
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fillStyle = '#0D131E';
  c.fill();
  // Sun fill — same peach as pill so top portion merges visually with pill background
  if (fraction > 0) {
    const lineY = cy + r * (2 * fraction - 1);
    c.save();
    c.beginPath();
    c.rect(cx - r - 1, cy - r - 1, (r + 1) * 2, lineY - (cy - r) + 1);
    c.clip();
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = '#FFAF85';
    c.fill();
    c.restore();
  }
}

function buildSprite(v, state, selected, hour, dateStr) {
  const dpr = window.devicePixelRatio || 1;

  // Closed: tiny faded dot — no pill
  if (state === 'closed') {
    const oc = document.createElement('canvas');
    oc.width = oc.height = Math.ceil(10 * dpr);
    const c = oc.getContext('2d');
    c.scale(dpr, dpr);
    c.globalAlpha = 0.22;
    c.beginPath(); c.arc(5, 5, 3, 0, Math.PI * 2);
    c.fillStyle = 'rgba(156,189,231,0.6)'; c.fill();
    return { canvas: oc, anchorX: 5, anchorY: 5, cssW: 10, cssH: 10 };
  }

  // ── Label + visual style per state ─────────────────────────────────────────
  // Colors follow the Solaris Oslo design system:
  //   surface #0D131E · outline-variant #514532 · primary #FFB800
  //   on-surface-variant #d5c4ab (warm cream, never cool blue)
  let label = '', fillColor, strokeColor, textColor, stemColor, isDashed = false, alpha = 1;
  let sunFraction = null; // non-null for sunny pins: 0–1 fill level

  if (state === 'soon') {
    const { open } = v.openingHours ?? {};
    label       = open != null ? formatHour(open) : '—';
    fillColor   = 'rgba(13,19,30,0.92)';          // surface #0D131E
    strokeColor = 'rgba(81,69,50,0.50)';           // outline-variant #514532
    stemColor   = 'rgba(255,184,0,0.65)';          // primary #FFB800 — sun on its way
    textColor   = 'rgba(255,184,0,0.95)';          // primary #FFB800
    isDashed    = true;
    alpha       = 0.92;

  } else if (state === 'sunny') {
    label       = shortName(v.name);
    fillColor   = '#FFAF85';
    strokeColor = 'rgba(255,230,120,0.4)';
    stemColor   = '#FFAF85';
    textColor   = '#1a1200';
    if (hour !== undefined && dateStr) {
      sunFraction = _sunFillFraction(_sunRemainingHours(v, dateStr, hour));
    }

  } else { // shaded — only reaches here when a future sun window exists
    if (hour !== undefined && dateStr) {
      try {
        const { windows } = computeSunWindows(v, dateStr);
        const next = windows.find(w => w.start > hour);
        if (next) { label = formatHour(next.start); alpha = 0.85; }
        else       { label = '';  alpha = 0.32; }
      } catch (e) { label = ''; }
    }
    fillColor   = 'rgba(13,19,30,0.92)';           // surface #0D131E
    strokeColor = 'rgba(81,69,50,0.30)';            // outline-variant #514532
    stemColor   = 'rgba(213,196,171,0.45)';         // on-surface-variant warm cream
    textColor   = 'rgba(213,196,171,0.80)';         // on-surface-variant warm cream
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────
  const tmpCtx = document.createElement('canvas').getContext('2d');
  tmpCtx.font  = 'bold 11px "Inter", sans-serif';
  const tw     = label ? tmpCtx.measureText(label).width : 0;
  const pillW  = Math.max(36, tw + 22);

  // Sun fill icon: circle of same height as pill with concave notch cut into pill right side
  const iconR   = PILL_H / 2;   // radius 13 — matches pill height exactly
  const notchGap = 2.5;         // gap between notch edge and icon edge (px)
  const notchR  = iconR + notchGap;
  // Horizontal offset of icon centre from pill right edge, so notch arc passes
  // through the pill's top-right and bottom-right corners exactly
  const iconDx  = sunFraction !== null ? Math.sqrt(notchR * notchR - iconR * iconR) : 0;
  const iconWide = sunFraction !== null ? Math.ceil(iconDx + iconR + 2) : 0;

  const rp  = selected ? 4 : 2;                          // padding for selection ring
  const cW  = Math.ceil(pillW + rp * 2 + 2 + iconWide);  // CSS pixels
  const cH  = Math.ceil(PILL_H + STEM_H + rp + 2);
  const cxA = sunFraction !== null
    ? rp + 1 + pillW / 2   // stem under pill centre — icon extends to the right
    : cW / 2;              // anchor x = stem centre (CSS px)
  const cyA = cH - 1;      // anchor y = bottom of stem (CSS px)
  // Icon centre (CSS px) — precomputed for use in drawing sections below
  const iconX = sunFraction !== null ? rp + 1 + pillW + iconDx : 0;
  const iconY = sunFraction !== null ? rp + PILL_H / 2 : 0;

  // Build at DPR resolution for crisp rendering on retina displays.
  // Inside the sprite we draw in CSS pixel coordinates; c.scale(dpr, dpr)
  // maps them to physical pixels.
  const oc = document.createElement('canvas');
  oc.width  = Math.ceil(cW * dpr);
  oc.height = Math.ceil(cH * dpr);
  const c   = oc.getContext('2d');
  c.scale(dpr, dpr);
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
    glow.addColorStop(0, 'rgba(255,175,133,0.18)');
    glow.addColorStop(1, 'rgba(255,175,133,0)');
    c.beginPath(); c.arc(0, 0, PILL_H, 0, Math.PI * 2);
    c.fillStyle = glow; c.fill();
    c.restore();
  }

  // ── Selection ring ─────────────────────────────────────────────────────────
  if (selected) {
    if (sunFraction !== null) {
      _pillNotchPath(c, ox - 3, oy - 3, pillW + 6, PILL_H + 6, PILL_R + 3, iconX, iconY, notchR - 3);
    } else {
      c.beginPath();
      c.roundRect(ox - 3, oy - 3, pillW + 6, PILL_H + 6, PILL_R + 3);
    }
    c.strokeStyle = 'rgba(255,175,133,0.9)';
    c.lineWidth   = 2;
    c.stroke();
    // For sunny: also stroke a ring around the icon itself
    if (sunFraction !== null) {
      c.beginPath(); c.arc(iconX, iconY, iconR + 3, 0, Math.PI * 2);
      c.stroke();
    }
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
  if (sunFraction !== null) {
    _pillNotchPath(c, ox, oy, pillW, PILL_H, PILL_R, iconX, iconY, notchR);
  } else {
    c.beginPath();
    c.roundRect(ox, oy, pillW, PILL_H, PILL_R);
  }
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

  // ── Sun fill icon (sunny state only) ───────────────────────────────────────
  if (sunFraction !== null) {
    _drawSunFillIcon(c, iconX, iconY, iconR, sunFraction);
  }

  return { canvas: oc, anchorX: cxA, anchorY: cyA, cssW: cW, cssH: cH };
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
map.on('moveend',  () => { _layoutStale = true; draw(); });
map.on('zoomend',  () => { _layoutStale = true; draw(); });

// ── Pin layout: anti-overlap via variable stem, dot fallback ──────────────────
// Each pin tries increasing extra-stem values until it clears all higher-priority
// pills. If no value works it degrades to a small dot. Sorting by relevance
// (sunny > soon > shaded, then by sun score) means important venues always
// keep their preferred position.
//
// extraStem is 0-based: 0 = stem flush with sprite bottom, 14 = one step raised, etc.
// The sprite always bakes a fixed STEM_H stem; extraStem extends it further.
const MAX_EXTRA_STEM = 56;  // max extra stem before pin becomes a dot (4 × STEM_STEP)
const STEM_STEP  = 14;      // stem extension increment (px)
const DOT_R      = 4.5;     // dot radius (px)
const PILL_GAP   = 8;       // min gap between pill bounding boxes (px)
const DOT_FADE_MS = 240;    // pill↔dot morph duration
const GRID_CELL  = 64;      // AABB grid cell size (px) for O(1) overlap queries

let _lastLayout = [];             // [{v, pt, state, extraStem, isDot, spr, drawExtraStem}] per frame
let _hoverClearTimer = null;      // debounce timer for clearing map hover
const _pinWasDot    = new Map();  // id → bool — was this pin a dot last frame
const _pinDotFade   = new Map();  // id → {fromDot, start} — active morph animations
const _pinAnimStemH = new Map();  // id → animated extraStem (px, float) for smooth transitions

// ── Layout stability cache ────────────────────────────────────────────────────
// Layout (isDot / extraStem per venue) is only recomputed when the map has
// settled (moveend/zoomend) or when the time/date changes. During panning,
// screen positions update every frame but layout decisions remain frozen,
// eliminating the pill↔dot jitter caused by the greedy algorithm seeing
// slightly different pixel positions each frame.
let _layoutStale = true;          // force recompute on first draw
let _layoutHour  = null;          // hour at last layout compute
let _layoutDate  = null;          // date at last layout compute
const _venueIsDot    = new Map(); // id → stable isDot decision
const _venueExtStem  = new Map(); // id → stable extraStem decision

/**
 * Assigns each venue an extraStem (or isDot flag). Greedy by priority:
 * high-relevance venues get the preferred height, lower ones are bumped up
 * or collapsed to a dot when no stem value avoids overlap.
 *
 * Uses an AABB spatial grid so overlap queries are O(1) instead of O(n).
 */
function computePinLayout(projVenues, currentHour, dateStr) {
  const PRI = { sunny: 0, soon: 1, shaded: 2, closed: 3 };
  const sorted = [...projVenues].sort((a, b) => {
    // Raised pin processed last so it can claim the highest available position
    if (a.v.id === highlight.raisedId) return 1;
    if (b.v.id === highlight.raisedId) return -1;
    const pd = PRI[a.state] - PRI[b.state];
    if (pd !== 0) return pd;
    // Tie-break within same state: non-open venues by time until opening (sooner first);
    // open venues (sunny/shaded) by sun score (higher first)
    if (a.state === 'soon' || a.state === 'closed') {
      const openA = a.v.openingHours?.open ?? Infinity;
      const openB = b.v.openingHours?.open ?? Infinity;
      const waitA = openA > currentHour ? openA - currentHour : Infinity;
      const waitB = openB > currentHour ? openB - currentHour : Infinity;
      return waitA - waitB;
    }
    try {
      const sa = typeof sunScore === 'function' ? (sunScore(a.v, dateStr, currentHour) ?? 0) : (a.v.rating ?? 0);
      const sb = typeof sunScore === 'function' ? (sunScore(b.v, dateStr, currentHour) ?? 0) : (b.v.rating ?? 0);
      return sb - sa;
    } catch { return 0; }
  });

  // Spatial grid: cell key → array of placed rects {rx,ry,rw,rh}
  const placedGrid = new Map();

  function gridCells(rx, ry, rw, rh) {
    const x0 = Math.floor(rx / GRID_CELL), x1 = Math.floor((rx + rw) / GRID_CELL);
    const y0 = Math.floor(ry / GRID_CELL), y1 = Math.floor((ry + rh) / GRID_CELL);
    const cells = [];
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++)
        cells.push(`${gx},${gy}`);
    return cells;
  }

  function isClear(rx, ry, rw, rh) {
    for (const key of gridCells(rx, ry, rw, rh)) {
      for (const p of (placedGrid.get(key) ?? [])) {
        if (!(rx + rw + PILL_GAP <= p.rx || p.rx + p.rw + PILL_GAP <= rx ||
              ry + rh + PILL_GAP <= p.ry || p.ry + p.rh + PILL_GAP <= ry)) return false;
      }
    }
    return true;
  }

  function addPlaced(rx, ry, rw, rh) {
    const rect = { rx, ry, rw, rh };
    for (const key of gridCells(rx, ry, rw, rh)) {
      if (!placedGrid.has(key)) placedGrid.set(key, []);
      placedGrid.get(key).push(rect);
    }
  }

  const result = [];

  for (const { v, pt, state } of sorted) {
    const selected = v.id === selectedId;
    const isRaised = v.id === highlight.raisedId;
    const spr = getSprite(v, state, selected, currentHour, dateStr);

    // Venues that are always dots — skip the grid so they don't displace pills.
    // • closed: not open yet / today
    // • shaded with no future sun window: renders as a near-invisible pill with
    //   no label, causing a visible stem line attached to what looks like a dot.
    if (state === 'closed') {
      result.push({ v, pt, state, extraStem: 0, isDot: true, spr });
      continue;
    }
    if (state === 'shaded') {
      let hasFutureSun = false;
      try {
        const { windows } = computeSunWindows(v, dateStr);
        hasFutureSun = windows.some(w => w.start > currentHour);
      } catch {}
      if (!hasFutureSun) {
        result.push({ v, pt, state, extraStem: 0, isDot: true, spr });
        continue;
      }
    }

    const rw  = spr.cssW;
    const rh  = spr.cssH - STEM_H;  // pill area only (excludes baked stem)

    // Raised pin: search from tallest extraStem downward (claims highest spot).
    // All others: search from zero upward (minimal stem preferred).
    const stemDir   = isRaised ? -STEM_STEP : STEM_STEP;
    const stemStart = isRaised ? MAX_EXTRA_STEM : 0;
    const stemEnd   = isRaised ? 0 : MAX_EXTRA_STEM;

    let resolved = false;
    for (let ex = stemStart; isRaised ? ex >= stemEnd : ex <= stemEnd; ex += stemDir) {
      const rx = pt.x - spr.anchorX;
      const ry = pt.y - spr.anchorY - ex;
      if (isClear(rx, ry, rw, rh)) {
        addPlaced(rx, ry, rw, rh);
        result.push({ v, pt, state, extraStem: ex, isDot: false, spr });
        resolved = true;
        break;
      }
    }
    // Raised pin never degrades to dot; others do if no extraStem works
    if (!resolved) result.push({ v, pt, state, extraStem: 0, isDot: !isRaised, spr });
  }

  return result;
}

function _drawExtStem(pt, extraStem, state) {
  const col = state === 'sunny' ? '#FFAF85' :
              state === 'soon'  ? 'rgba(255,175,133,0.70)' :
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
  ctx.fillStyle = isSunny ? 'rgba(255,175,133,0.22)' : isSoon ? 'rgba(255,175,133,0.16)' : 'rgba(120,150,220,0.18)';
  ctx.fill();
  // Enlarged dot
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? '#FFAF85' : isSoon ? 'rgba(255,175,133,0.9)' : 'rgba(120,150,200,0.85)';
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
  ctx.fillStyle = isSunny ? 'rgba(255,175,133,0.18)' : isSoon ? 'rgba(255,175,133,0.12)' : 'rgba(100,120,180,0.12)';
  ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? '#FFAF85' : isSoon ? 'rgba(255,175,133,0.8)' : 'rgba(100,120,170,0.65)';
  ctx.fill();
  ctx.restore();
}

// ── Map pan helper ────────────────────────────────────────────────────────────
/**
 * Pan so the venue pin appears centred in the visible area (accounting for
 * the detail sidebar on desktop).
 */
function panToVenueCenter(v) {
  if (_preSelectZoom === null) {
    _preSelectZoom   = map.getZoom();
    _preSelectCenter = map.getCenter();
    _frozenBounds    = map.getBounds();
  }

  const isMobile = window.innerWidth < 768;
  const panel    = document.getElementById('detail-panel');
  // Use layout position (unaffected by CSS transform during open animation)
  const padLeft  = (!isMobile && panel && panel.classList.contains('open'))
    ? (panel.offsetLeft + panel.offsetWidth) : 0;

  const wallBearing   = v.wallSegment?.bearing ?? v.facing;
  const targetBearing = (wallBearing + 180) % 360;
  const curBearing    = ((map.getBearing() % 360) + 360) % 360;
  let   diff          = Math.abs(targetBearing - curBearing);
  if (diff > 180) diff = 360 - diff;

  const targetZoom = 17.70;
  const opts = {
    center:   [v.lng, v.lat],
    zoom:     targetZoom,
    pitch:    45,
    padding:  { left: padLeft, right: 0, top: 60, bottom: 0 },
    duration: 480,
  };
  if (diff > 60) opts.bearing = targetBearing;
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
      ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY, spr.cssW, spr.cssH);
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

  // Recompute anti-overlap layout only when the map has settled or time/date
  // changed. During panning, screen positions update every frame but the
  // pill/dot assignments stay frozen, preventing per-frame layout jitter.
  if (_layoutStale || currentHour !== _layoutHour || dateStr !== _layoutDate) {
    _layoutStale = false;
    _layoutHour  = currentHour;
    _layoutDate  = dateStr;
    const fresh = computePinLayout(projVenues, currentHour, dateStr);
    const seen  = new Set();
    for (const e of fresh) {
      _venueIsDot.set(e.v.id, e.isDot);
      _venueExtStem.set(e.v.id, e.extraStem);
      seen.add(e.v.id);
    }
    // Evict decisions for venues no longer in view
    for (const id of [..._venueIsDot.keys()]) {
      if (!seen.has(id)) { _venueIsDot.delete(id); _venueExtStem.delete(id); }
    }
  }

  // Build _lastLayout from stable decisions + current screen positions.
  // New venues entering the viewport during a pan default to dot until moveend.
  _lastLayout = projVenues.map(({ v, pt, state }) => {
    const sel = v.id === selectedId;
    const spr = getSprite(v, state, sel, currentHour, dateStr);
    return {
      v, pt, state, spr,
      isDot:     _venueIsDot.get(v.id)   ?? true,
      extraStem: _venueExtStem.get(v.id) ?? 0,
    };
  });

  // Smooth stem transitions — lerp each pin toward its target extraStem
  let stemAnimDirty = false;
  for (const entry of _lastLayout) {
    if (entry.isDot) { _pinAnimStemH.delete(entry.v.id); entry.drawExtraStem = 0; continue; }
    const target  = entry.extraStem;
    const current = _pinAnimStemH.get(entry.v.id) ?? target;
    if (Math.abs(current - target) < 0.5) {
      _pinAnimStemH.set(entry.v.id, target);
      entry.drawExtraStem = target;
    } else {
      const next = current + (target - current) * 0.14;
      _pinAnimStemH.set(entry.v.id, next);
      entry.drawExtraStem = next;
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
    const extraStem = entry.drawExtraStem ?? entry.extraStem;
    if (extraStem > 0) _drawExtStem(pt, extraStem, state);
  }

  // Pass 2 — morph animations, dots, pills (on top of all stems)
  for (const entry of _lastLayout) {
    const { v, pt, state, extraStem: targetExtraStem, isDot, spr } = entry;
    const extraStem = entry.drawExtraStem ?? targetExtraStem;

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
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem, spr.cssW, spr.cssH);
        } else {
          ctx.globalAlpha = 1 - t;
          if (extraStem > 0) _drawExtStem(pt, extraStem, state);
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem, spr.cssW, spr.cssH);
          ctx.globalAlpha = t; _drawDot(pt, state);
        }
        ctx.restore();
        continue;
      }
    }

    if (isDot) {
      if (state !== 'closed') {
        if (v.id === highlight.id) _drawDotHover(pt, state);
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

    const isHovered = v.id === highlight.id || v.id === highlight.raisedId;
    const rp = (v.id === selectedId ? 4 : 2) + 1;
    const sprLeft = pt.x - spr.anchorX;
    const sprTop  = pt.y - spr.anchorY - extraStem;

    ctx.save();
    if (pinAlpha < 1) ctx.globalAlpha = pinAlpha;

    // Hover/raised: glowing outline ring around the pill
    if (isHovered) {
      const pillW = spr.cssW - rp * 2 - 2;
      const glowCol = state === 'sunny' ? 'rgba(255,175,133,0.9)' :
                      state === 'soon'  ? 'rgba(255,184,0,0.85)' :
                                          'rgba(210,200,185,0.75)';
      ctx.save();
      ctx.shadowBlur = 9;
      ctx.shadowColor = glowCol;
      ctx.beginPath();
      ctx.roundRect(sprLeft + rp - 3.5, sprTop + rp - 3.5, pillW + 7, PILL_H + 7, PILL_R + 3.5);
      ctx.strokeStyle = glowCol;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }

    ctx.drawImage(spr.canvas, sprLeft, sprTop, spr.cssW, spr.cssH);
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
    const { v, pt, isDot, spr } = entry;
    if (isDot) continue;
    const extraStem = entry.drawExtraStem ?? entry.extraStem;
    const rx = pt.x - spr.anchorX - 4;
    const ry = pt.y - spr.anchorY - extraStem - 4;
    const rw = spr.cssW + 8;
    const rh = spr.cssH - STEM_H + 8;
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

function hitTestDetachedPin(cx, cy) {
  if (!editingVenueId) return false;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v || v.terraceType !== 'detached') return false;
  const loc = v.terraceDetachedLocation ?? { lat: v.lat, lng: v.lng };
  const pt  = map.project([loc.lng, loc.lat]);
  return Math.hypot(cx - pt.x, cy - pt.y) <= 18;
}

function hitTestDepthHandle(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v || (v.terraceType && v.terraceType !== 'street')) return null;
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
// On touch devices, keep canvas pointer-events:none so Mapbox receives native
// touch events directly (enabling pan + pinch-zoom). Tap detection is handled
// via document-level touchend below. On desktop, auto so mouse events work.
const _isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
canvas.style.pointerEvents = _isTouchDevice ? 'none' : 'auto';

// Mapbox GL v3 uses Pointer Events (pointerdown/pointerup), not mousedown/mouseup.
// When a pin is hit we must stop BOTH mousedown and pointerdown from reaching
// Mapbox's container — otherwise Mapbox starts drag-tracking and calls map.stop()
// during drag-end, which cancels our subsequent easeTo camera animation.
function _pinHitAtEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  return !editingVenueId && (hitTestVenue(cx, cy) || hitTestDot(cx, cy));
}

canvas.addEventListener('pointerdown', e => {
  if (_pinHitAtEvent(e)) e.stopPropagation();
});

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    // Detached pin drag
    if (hitTestDetachedPin(cx, cy)) {
      _detachedDragging = true;
      canvas.style.cursor = 'grabbing';
      return;
    }
    // Width trim handle drag
    const wh = hitTestWidthHandle(cx, cy);
    if (wh) {
      editDraggingWidth = wh.side;
      editWidthWall     = wh.wall;
      canvas.style.cursor = 'ew-resize';
      return;
    }
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
  if (hit) {
    e.stopPropagation();
  } else {
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
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v?.terraceType === 'detached' && !_detachedDragging) {
      const ll = map.unproject([cx, cy]);
      setDetachedLocation(ll.lat, ll.lng);
      return;
    }
    const wallIdx = hitTestWall(cx, cy);
    if (wallIdx !== null && (!v?.terraceType || v.terraceType === 'street')) selectWallByIdx(wallIdx);
    return;
  }
  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    // Stop the click from bubbling to Mapbox's container.  Mapbox calls map.stop()
    // during its click/drag-end processing which would cancel our easeTo animation.
    e.stopPropagation();
    selectVenue(hit.id, true);
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

    // Detached pin drag in progress
    if (_detachedDragging) {
      const ll = map.unproject([cx, cy]);
      setDetachedLocation(ll.lat, ll.lng);
      canvas.style.cursor = 'grabbing';
      return;
    }

    // Width trim drag in progress
    if (editDraggingWidth && editWidthWall) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const wall = editWidthWall;
        const pa   = map.project([wall.aLng, wall.aLat]);
        const pb   = map.project([wall.bLng, wall.bLat]);
        // Project cursor onto wall axis (0 = a-end, 1 = b-end)
        const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
        const lenSq = wdx * wdx + wdy * wdy || 1;
        const t = ((cx - pa.x) * wdx + (cy - pa.y) * wdy) / lenSq;
        const pxPerM = pxPerMetre(v);
        const lenM   = Math.sqrt(lenSq) / pxPerM;
        if (editDraggingWidth === 'start') {
          v.terraceWallTrimStart = Math.max(0, Math.min(lenM * 0.48, t * lenM));
        } else {
          v.terraceWallTrimEnd = Math.max(0, Math.min(lenM * 0.48, (1 - t) * lenM));
        }
        draw();
        canvas.style.cursor = 'ew-resize';
      }
      return;
    }

    // Depth drag in progress
    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
        _updateEditDepthDisplay();
      }
      return;
    }

    const vEdit = VENUES.find(x => x.id === editingVenueId);
    if (vEdit?.terraceType === 'detached') {
      canvas.style.cursor = hitTestDetachedPin(cx, cy) ? 'grab' : 'crosshair';
      return;
    }
    if (vEdit?.terraceType && vEdit.terraceType !== 'street') {
      canvas.style.cursor = 'default';
      return;
    }

    const wHandle = hitTestWidthHandle(cx, cy);
    if (wHandle) { canvas.style.cursor = 'ew-resize'; return; }

    const handle = hitTestDepthHandle(cx, cy);
    if (handle) { canvas.style.cursor = 'row-resize'; return; }

    const wallIdx = hitTestWall(cx, cy);
    canvas.style.cursor = wallIdx !== null ? 'pointer' : 'default';
    if (wallIdx !== editHoveredWallIdx) {
      editHoveredWallIdx = wallIdx;
      draw();
    }
    return;
  }

  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    // Cancel any pending clear — we're over a venue
    if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
    canvas.style.cursor = 'pointer';
    // Override list highlight with map hover (different id, or switching from list source)
    if (highlight.id !== hit.id || highlight.source === 'list') {
      highlight.id = hit.id;
      highlight.source = 'map';
      draw();
    }
    tooltip.innerHTML = buildTooltipContent(hit);
    const margin = 14;
    let tx = e.clientX + margin, ty = e.clientY - tooltip.offsetHeight - margin;
    if (tx + tooltip.offsetWidth > window.innerWidth - 20) tx = e.clientX - tooltip.offsetWidth - margin;
    if (ty < 8) ty = e.clientY + margin;
    tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    tooltip.classList.add('visible');
  } else {
    // Debounce clearing so adjacent pins don't jitter when cursor moves between them
    if (highlight.id !== null && !_hoverClearTimer) {
      _hoverClearTimer = setTimeout(() => {
        _hoverClearTimer = null;
        highlight.id = null;
        highlight.source = null;
        draw();
        canvas.style.cursor = 'default';
        tooltip.classList.remove('visible');
      }, 80);
    } else if (highlight.id === null) {
      canvas.style.cursor = 'default';
      tooltip.classList.remove('visible');
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
  // Clear map hover; highlight.raisedId (from sidebar) stays raised
  if (highlight.id !== null && highlight.source === 'map') {
    highlight.id = null;
    highlight.source = null;
    draw();
  }
  tooltip.classList.remove('visible');
  if (!editDraggingDepth && !editDraggingWidth) canvas.style.cursor = 'default';
});

window.addEventListener('mouseup', () => {
  if (_detachedDragging) {
    _detachedDragging = false;
    canvas.style.cursor = 'default';
    draw();
  }
  if (editDraggingDepth) {
    editDraggingDepth = false;
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
      null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd);
    editDragWallObj = null;
    canvas.style.cursor = 'default';
    _updateEditDepthDisplay();
    _setEditChanged();
  }
  if (editDraggingWidth) {
    editDraggingWidth = false;
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
      null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd);
    editWidthWall = null;
    canvas.style.cursor = 'default';
    _setEditChanged();
  }
});

// wheel: pass through to map (desktop only — touch devices use native events)
canvas.addEventListener('wheel', e => {
  canvas.style.pointerEvents = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  canvas.style.pointerEvents = 'auto';
  if (el) el.dispatchEvent(new WheelEvent('wheel', e));
}, { passive: true });

// Touch pin-tap detection (touch devices only).
// Canvas is pointer-events:none so Mapbox gets all native touch events for
// pan/pinch-zoom. We listen at document level to detect taps on pins.
if (_isTouchDevice) {
  let _touchStartX = 0, _touchStartY = 0;
  let _editTouchId = null; // tracking identifier for edit-mode drag

  document.addEventListener('touchstart', e => {
    const t = e.touches?.[0];
    if (!t) return;
    _touchStartX = t.clientX; _touchStartY = t.clientY;

    if (!editingVenueId) return;
    // In edit mode: capture canvas-relative position and check for drag handles
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;

    // Detached pin drag
    if (hitTestDetachedPin(cx, cy)) {
      _detachedDragging = true;
      _editTouchId = t.identifier;
      e.preventDefault();
      return;
    }
    // Width trim handle
    const wh = hitTestWidthHandle(cx, cy);
    if (wh) {
      editDraggingWidth = wh.side;
      editWidthWall     = wh.wall;
      _editTouchId = t.identifier;
      e.preventDefault();
      return;
    }
    // Depth handle
    const dh = hitTestDepthHandle(cx, cy);
    if (dh) {
      editDraggingDepth = true;
      editDragWallObj   = dh;
      _editTouchId = t.identifier;
      e.preventDefault();
      return;
    }
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!editingVenueId) return;
    const t = Array.from(e.touches).find(tt => tt.identifier === _editTouchId) ?? e.touches[0];
    if (!t) return;
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;

    if (_detachedDragging) {
      const ll = map.unproject([cx, cy]);
      setDetachedLocation(ll.lat, ll.lng);
      e.preventDefault(); return;
    }
    if (editDraggingWidth && editWidthWall) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const wall = editWidthWall;
        const pa   = map.project([wall.aLng, wall.aLat]);
        const pb   = map.project([wall.bLng, wall.bLat]);
        const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
        const lenSq = wdx * wdx + wdy * wdy || 1;
        const t2 = ((cx - pa.x) * wdx + (cy - pa.y) * wdy) / lenSq;
        const lenM = Math.sqrt(lenSq) / pxPerMetre(v);
        if (editDraggingWidth === 'start') {
          v.terraceWallTrimStart = Math.max(0, Math.min(lenM * 0.48, t2 * lenM));
        } else {
          v.terraceWallTrimEnd = Math.max(0, Math.min(lenM * 0.48, (1 - t2) * lenM));
        }
        draw();
      }
      e.preventDefault(); return;
    }
    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
        _updateEditDepthDisplay();
      }
      e.preventDefault(); return;
    }
  }, { passive: false });

  document.addEventListener('touchend', e => {
    // Save state after any edit drag
    if (editingVenueId && (_detachedDragging || editDraggingDepth || editDraggingWidth)) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
        null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd);
      _detachedDragging = false;
      editDraggingDepth = false; editDragWallObj = null;
      editDraggingWidth = false; editWidthWall   = null;
      _editTouchId = null;
      _updateEditDepthDisplay();
      _setEditChanged();
      draw();
      return;
    }

    if (editingVenueId) {
      // Wall tap in edit mode
      const t = e.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - _touchStartX, dy = t.clientY - _touchStartY;
      if (dx * dx + dy * dy >= 100) return; // not a tap
      const rect = canvas.getBoundingClientRect();
      const cx = t.clientX - rect.left, cy = t.clientY - rect.top;
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v?.terraceType === 'detached') {
        const ll = map.unproject([cx, cy]);
        setDetachedLocation(ll.lat, ll.lng);
      } else {
        const wallIdx = hitTestWall(cx, cy);
        if (wallIdx !== null && (!v?.terraceType || v.terraceType === 'street')) selectWallByIdx(wallIdx);
      }
      return;
    }

    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - _touchStartX, dy = t.clientY - _touchStartY;
    if (dx * dx + dy * dy >= 100) return; // not a tap
    // Ignore taps on UI overlays — only hit-test when the touch is on the map itself
    if (e.target && e.target.closest('#qc-wrap, #panel, #search-wrap, #floating-date, #detail-panel, .mapboxgl-ctrl, .mapboxgl-popup')) return;
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;
    const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
    if (hit) {
      selectVenue(hit.id, true);
    }
  }, { passive: true });
}
